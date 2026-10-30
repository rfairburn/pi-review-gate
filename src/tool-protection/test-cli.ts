/**
 * Inert tool-auditor tester (#544).
 *
 * This is a deliberate test harness, not a second admission path: it builds the
 * same code-owned prompt with the shared production context builder, sends one
 * proposal per selected case/level to the saved Pi auditor through the shared
 * runner, parses the reply with the shared decision parser, and compares it with
 * fixed fixture expectations. It never executes a proposal, reads a proposal
 * target, registers a tool, starts an agent loop, writes a session, or changes the
 * saved configuration or fixture data.
 *
 * The test level and scope are independent of the live gate, including when the
 * saved Protection level is Off or its scope covers a different set of tool names.
 * A reported result is an auditor-test verdict, never actual tool admission.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config";
import { effectiveToolProtectionSettings } from "./config";
import { buildProtectionContext } from "./context";
import { parseProtectionDecision } from "./decision";
import { TOOL_PROTECTION_POLICY_VERSION } from "./policy";
import {
  runProtectionAuditor,
  type ProtectionAuditorPiModelRegistry,
} from "./runner";
import {
  TOOL_PROTECTION_TEST_CASES,
  TOOL_PROTECTION_TEST_GOVERNING_PROMPT,
  TOOL_PROTECTION_TEST_LEVELS,
  TOOL_PROTECTION_TEST_NOTE,
  TOOL_PROTECTION_TEST_POLICY_VERSION,
  type ToolProtectionTestCase,
  type ToolProtectionTestLevel,
} from "./test-fixtures";

export const TOOL_PROTECTION_TEST_HELP = `Safe tool-auditor tester — proposals are DATA and NEVER EXECUTE.

  pi-review-tool-test --list
  pi-review-tool-test --case 1 --level dangerous
  pi-review-tool-test --case n08-user-prohibited-read --level all
  pi-review-tool-test --case all --level all
  pi-review-tool-test --case all --level all --json

From a source checkout after building, run the same options through
  node scripts/pi-review-tool-test.cjs

Options:
  --case ID|NUMBER|all   Existing case id, its 1-based list number, or all.
  --level LEVEL          dangerous, aligned, workspace, or all. Required to run.
  --json                 Print one JSON report, including each raw auditor reply.
  --config PATH          Saved review-gate config override (read only).
  --pi-package PATH      Installed @earendil-works/pi-coding-agent package override.
  --list                 List cases and expected Dangerous/Aligned/Workspace verdicts. No model call.
  --help                 This help. No model call.

Uses the SAVED Tool protection auditor and reasoning setting with normal Pi
models.json/provider authentication. The test level is independent of the live gate
and works while the saved level is Off. Pi-backed auditors only; an
external auditor is refused before any program is launched.

Each selected case and level runs once, sequentially. There is no retry, fallback,
cache, replay, tool execution, proposal-target read, agent loop, or auditor-session
retention. A setup or transport error is reported separately from a policy FAIL.
Requests may incur provider charges. Human output includes the raw reply; --json keeps
it in each result's raw field.
Exit: 0 all match; 1 verdict mismatch; 2 setup/transport/format error; 130 interrupted.
`;

type TestVerdict = "PASS" | "FAIL";

export interface ToolProtectionTestOptions {
  help?: boolean;
  list?: boolean;
  json?: boolean;
  case?: string;
  level?: string;
  config?: string;
  piPackage?: string;
}

interface TestResultRecord {
  case: string;
  level: ToolProtectionTestLevel;
  expected: TestVerdict;
  kind: "decision" | "context_error" | "auditor_error" | "malformed";
  actual?: TestVerdict;
  reason?: string;
  raw?: string;
  durationMs?: number;
  error?: string;
  match?: boolean;
}

interface TestReport {
  mode: "auditor-test-only";
  proposalsExecuted: false;
  policyVersion: string;
  configPath?: string;
  requestedModel: string;
  requestedReasoning: string;
  liveProtectionLevel: string;
  savedScope: string;
  timeoutMs: number;
  maxContextChars: number;
  plannedRequests: number;
  results: TestResultRecord[];
  note: string;
  summary?: {
    recorded: number;
    matches: number;
    mismatches: number;
    errors: number;
    interrupted: boolean;
  };
}

interface TestListReport {
  mode: "auditor-test-list";
  policyVersion: string;
  note: string;
  levels: readonly ToolProtectionTestLevel[];
  cases: Array<{
    number: number;
    id: string;
    title: string;
    expected: ToolProtectionTestCase["expected"];
  }>;
}

type OutputWriter = (line: string) => void;

const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_PACKAGE_ROOT_DEPTH = 16;

// tsc rewrites `await import(x)` in CommonJS output to require(x), which cannot
// load Pi's ESM entry on every supported Node version. Keep a native dynamic
// import that the transpiler leaves untouched, as the shared host loader does.
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

/** Parse the tester's small option surface without touching config, SDK, or auth. */
export function parseToolProtectionTestArgs(args: readonly string[]): ToolProtectionTestOptions {
  const options: ToolProtectionTestOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "--list" || arg === "--json") {
      const key = arg.slice(2) as "help" | "list" | "json";
      if (options[key] !== undefined) throw new Error(`Repeated option ${arg}.`);
      options[key] = true;
      continue;
    }
    if (arg === "--case" || arg === "--level" || arg === "--config" || arg === "--pi-package") {
      const key = arg === "--case" ? "case"
        : arg === "--level" ? "level"
          : arg === "--config" ? "config"
            : "piPackage";
      if (options[key] !== undefined) throw new Error(`Repeated option ${arg}.`);
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${JSON.stringify(arg)}. Use --help.`);
  }
  return options;
}

/** Resolve the installed Pi SDK package root without provisioning or scanning sessions. */
export function resolvePiPackageRoot(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = explicit ?? env.PI_REVIEW_GATE_INSTALLED_AGENT;
  if (override !== undefined) {
    const selected = packageRootFrom(override);
    if (!selected) {
      throw new Error(
        `The configured Pi SDK package was not found or is not ${PI_AGENT_PACKAGE_NAME}: ${override}. Pass --pi-package pointing at the installed package root.`,
      );
    }
    return selected;
  }

  const candidates = [
    resolvedPiEntryFromNode(),
    piPackageRootFromNodeLocations(cwd),
    managedPiPackageRoot(env),
    piPackageRootFromPath(env),
  ];
  for (const candidate of candidates) {
    if (candidate) {
      const root = packageRootFrom(candidate);
      if (root) return root;
    }
  }
  throw new Error(
    `Could not resolve an installed ${PI_AGENT_PACKAGE_NAME} package. Install Pi normally or pass --pi-package <package-root> (or set PI_REVIEW_GATE_INSTALLED_AGENT). No Pi runtime was provisioned.`,
  );
}

function resolvedPiEntryFromNode(): string | undefined {
  try {
    const requireFromPackage = createRequire(join(__dirname, "..", "..", "..", "package.json"));
    return requireFromPackage.resolve(PI_AGENT_PACKAGE_NAME);
  } catch {
    return undefined;
  }
}

/**
 * Bounded package-root fallback for Node's normal module locations. Pi 1.4.0
 * exposes only an `import` export condition, so `require.resolve()` refuses the
 * package even when its directory is a normal sibling install. `resolve.paths()`
 * still reports the same bounded node_modules search directories (including
 * NODE_PATH/global locations); checking the exact package path there needs no
 * exports condition, provisioning, PATH parsing, or session access.
 */
function piPackageRootFromNodeLocations(cwd: string): string | undefined {
  const starts = [
    join(__dirname, "..", "..", "..", "package.json"),
    join(cwd, "package.json"),
  ];
  const seen = new Set<string>();
  for (const start of starts) {
    let searchPaths: readonly string[] = [];
    try {
      searchPaths = createRequire(start).resolve.paths(PI_AGENT_PACKAGE_NAME) ?? [];
    } catch {
      searchPaths = [];
    }
    for (const directory of searchPaths) {
      if (seen.has(directory)) continue;
      seen.add(directory);
      const candidate = join(directory, ...PI_AGENT_PACKAGE_NAME.split("/"));
      if (existsSync(join(candidate, "package.json"))) {
        const root = packageRootFrom(candidate);
        if (root) return root;
      }
    }
  }
  return undefined;
}

function managedPiPackageRoot(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.PI_CODING_AGENT_DIR;
  const agentDir = configured && configured.length > 0
    ? resolve(configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured)
    : join(homedir(), ".pi", "agent");
  try {
    const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
    if (version.length === 0 || version.length > 64 || /[/\\]/.test(version)) return undefined;
    const candidate = join(agentDir, "install", "releases", version, "node_modules", ...PI_AGENT_PACKAGE_NAME.split("/"));
    return existsSync(join(candidate, "package.json")) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function piPackageRootFromPath(env: NodeJS.ProcessEnv): string | undefined {
  const searchPath = env.PATH ?? "";
  for (const directory of searchPath.split(delimiterForPlatform())) {
    if (directory.length === 0) continue;
    for (const executable of process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"]) {
      const candidate = join(directory, executable);
      if (!existsSync(candidate)) continue;
      const root = packageRootFrom(candidate);
      if (root) return root;
    }
  }
  return undefined;
}

function delimiterForPlatform(): string {
  return process.platform === "win32" ? ";" : ":";
}

/** Walk from a file or directory to the nearest package root with the Pi package name. */
function packageRootFrom(candidate: string): string | undefined {
  let current: string;
  try {
    const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
    current = statSync(absolute).isDirectory() ? absolute : dirname(realpathSync(absolute));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < MAX_PACKAGE_ROOT_DEPTH; depth += 1) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
      if (isRecord(manifest) && manifest.name === PI_AGENT_PACKAGE_NAME) return current;
    } catch {
      // Keep walking; a missing or unreadable manifest is not a package root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** Resolve and native-import Pi's public ESM SDK entry from a validated package root. */
async function importPiSdk(packageRoot: string): Promise<Record<string, unknown>> {
  const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const main = isRecord(manifest) && typeof manifest.main === "string" && manifest.main.length > 0
    ? manifest.main
    : "./dist/index.js";
  const entry = resolve(packageRoot, main);
  if (!existsSync(entry)) {
    throw new Error(`The installed Pi SDK package has no loadable entry at ${entry}. No Pi runtime was provisioned.`);
  }
  const loaded = await nativeDynamicImport(pathToFileURL(entry).href);
  if (!isRecord(loaded)) throw new Error("The installed Pi SDK did not export a module object.");
  return loaded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedTestCases(caseSelector: string): ToolProtectionTestCase[] {
  if (caseSelector === "all") return [...TOOL_PROTECTION_TEST_CASES];
  const numeric = /^[1-9][0-9]*$/.test(caseSelector) ? Number(caseSelector) : undefined;
  const selected = TOOL_PROTECTION_TEST_CASES.filter((testCase, index) =>
    testCase.id === caseSelector || (numeric !== undefined && index + 1 === numeric));
  if (selected.length === 0) throw new Error(`Unknown case ${JSON.stringify(caseSelector)}. Use --list.`);
  return [...selected];
}

function selectedLevels(levelSelector: string): ToolProtectionTestLevel[] {
  if (levelSelector === "all") return [...TOOL_PROTECTION_TEST_LEVELS];
  if ((TOOL_PROTECTION_TEST_LEVELS as readonly string[]).includes(levelSelector)) {
    return [levelSelector as ToolProtectionTestLevel];
  }
  throw new Error(`Unknown level ${JSON.stringify(levelSelector)}. Use dangerous, aligned, workspace, or all.`);
}

function listReport(): TestListReport {
  return {
    mode: "auditor-test-list",
    policyVersion: TOOL_PROTECTION_TEST_POLICY_VERSION,
    note: TOOL_PROTECTION_TEST_NOTE,
    levels: TOOL_PROTECTION_TEST_LEVELS,
    cases: TOOL_PROTECTION_TEST_CASES.map((testCase, index) => ({
      number: index + 1,
      id: testCase.id,
      title: testCase.title,
      expected: testCase.expected,
    })),
  };
}

/** Run the tester. Returns its process exit code; throws only for setup/argument failures. */
export async function runToolProtectionTestCli(
  args: readonly string[],
  write: OutputWriter = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const options = parseToolProtectionTestArgs(args);
  if (options.help) {
    if (options.json) throw new Error("--help is human-readable; use --json with --list or a run.");
    write(TOOL_PROTECTION_TEST_HELP.trimEnd());
    return 0;
  }
  if (args.length === 0) {
    write(TOOL_PROTECTION_TEST_HELP.trimEnd());
    return 0;
  }
  if (options.list) {
    const report = listReport();
    if (options.json) {
      write(JSON.stringify(report, null, 2));
      return 0;
    }
    for (const testCase of report.cases) {
      const expected = report.levels.map((level) => testCase.expected[level]).join("/");
      write(`${String(testCase.number).padStart(2)}  ${testCase.id}  [${expected}]\n    ${testCase.title}`);
    }
    write("\nExpected order: Dangerous / Aligned / Workspace. No request was sent.");
    write(report.note);
    return 0;
  }
  if (options.case === undefined || options.level === undefined) {
    throw new Error("Specify both --case ID|NUMBER|all and --level dangerous|aligned|workspace|all. Use --help.");
  }
  const testCases = selectedTestCases(options.case);
  const levels = selectedLevels(options.level);

  if (TOOL_PROTECTION_POLICY_VERSION !== TOOL_PROTECTION_TEST_POLICY_VERSION) {
    throw new Error(
      `Compiled policy ${TOOL_PROTECTION_POLICY_VERSION} differs from the shipped fixture expectations ${TOOL_PROTECTION_TEST_POLICY_VERSION}; refusing a stale comparison.`,
    );
  }

  // Saved model settings are loaded only for an explicit run. --help and --list
  // return above without resolving config, the SDK, credentials, or a model.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.config !== undefined) env.PI_REVIEW_GATE_CONFIG = resolve(options.config);
  const loaded = loadConfig(env);
  if (loaded.toolProtectionError !== undefined) {
    throw new Error(`Saved tool-protection settings are invalid and were not applied: ${loaded.toolProtectionError}`);
  }
  if (loaded.path !== undefined && (loaded.warnings ?? []).some((warning) => warning.startsWith("Configuration could not be read or parsed"))) {
    throw new Error(`Saved review-gate configuration could not be read or parsed: ${loaded.path}. It was not rewritten.`);
  }
  const settings = effectiveToolProtectionSettings(loaded.config);
  const selection = settings.auditor;
  if (selection === null) {
    throw new Error(loaded.path === undefined
      ? "No saved review-gate configuration was found, so there is no saved Tool protection auditor. Create or select one in Review settings → Tools → Tool protection."
      : "No saved Tool protection auditor. Choose one in Review settings → Tools → Tool protection and save. The live Protection level may stay Off.");
  }
  if (selection.source !== "pi") {
    throw new Error("This tester supports Pi-backed auditors only. The saved auditor is external; no external program was launched and no fallback auditor was selected.");
  }

  const packageRoot = resolvePiPackageRoot(options.piPackage, env);
  const sdk = await importPiSdk(packageRoot);
  const ModelRuntime = sdk.ModelRuntime;
  const ModelRegistry = sdk.ModelRegistry;
  if (typeof ModelRuntime !== "function" || typeof ModelRegistry !== "function") {
    throw new Error("The installed Pi SDK does not expose ModelRuntime and ModelRegistry.");
  }
  const runtime = await (ModelRuntime as unknown as {
    create(options: { refreshOnCreate: boolean; allowModelNetwork: boolean }): Promise<unknown>;
  }).create({ refreshOnCreate: false, allowModelNetwork: false });
  const registry = new (ModelRegistry as unknown as new (runtime: unknown) => ProtectionAuditorPiModelRegistry & {
    getError?: () => string | undefined;
  })(runtime);
  const registryError = registry.getError?.();
  if (registryError !== undefined) throw new Error(`Pi model registry error: ${registryError}`);

  const requestedReasoning = selection.thinkingLevel ?? "high";
  const report: TestReport = {
    mode: "auditor-test-only",
    proposalsExecuted: false,
    policyVersion: TOOL_PROTECTION_POLICY_VERSION,
    ...(loaded.path === undefined ? {} : { configPath: loaded.path }),
    requestedModel: selection.model,
    requestedReasoning,
    liveProtectionLevel: settings.level,
    savedScope: settings.scope,
    timeoutMs: settings.timeoutMs,
    maxContextChars: settings.maxContextChars,
    plannedRequests: testCases.length * levels.length,
    results: [],
    note: TOOL_PROTECTION_TEST_NOTE,
  };

  if (!options.json) {
    write("AUDITOR TEST ONLY — proposed tools NEVER execute; live gate/settings are unchanged.");
    write(`Saved model: ${JSON.stringify(report.requestedModel)}; requested reasoning: ${JSON.stringify(report.requestedReasoning)}; policy: ${report.policyVersion}`);
    write(`Test requests: ${report.plannedRequests}; deadline: ${report.timeoutMs}ms. Live level/scope (${report.liveProtectionLevel}/${report.savedScope}) do not filter these test cases.\n`);
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  try {
    for (const testCase of testCases) {
      for (const level of levels) {
        if (controller.signal.aborted) break;
        const record: TestResultRecord = {
          case: testCase.id,
          level,
          expected: testCase.expected[level],
          kind: "context_error",
        };
        const built = buildProtectionContext({
          level,
          governingSystemPrompt: TOOL_PROTECTION_TEST_GOVERNING_PROMPT,
          governingPromptOrigin: "synthetic shipped tester fixture",
          proposedCall: testCase.proposedCall,
          evidence: testCase.evidence,
          maxContextChars: settings.maxContextChars,
        });
        if (!built.ok) {
          record.error = `${built.category}: ${built.message}`;
        } else {
          const result = await runProtectionAuditor({
            selection,
            config: loaded.config,
            prompt: built.prompt,
            input: undefined,
            cwd: testCase.proposedCall.cwd,
            timeoutMs: settings.timeoutMs,
            modelRegistry: registry,
            signal: controller.signal,
          });
          record.durationMs = result.durationMs;
          if (result.error !== undefined) {
            record.kind = "auditor_error";
            record.error = result.error;
          } else {
            record.raw = result.output ?? "";
            try {
              const decision = parseProtectionDecision(record.raw);
              record.kind = "decision";
              record.actual = decision.decision;
              if (decision.reason !== undefined) record.reason = decision.reason;
              record.match = decision.decision === record.expected;
            } catch (error) {
              record.kind = "malformed";
              record.error = errorMessage(error);
            }
          }
        }
        report.results.push(record);
        if (!options.json) {
          const verdict = record.actual ?? "ERROR";
          const outcome = record.kind === "decision" ? (record.match === true ? "MATCH" : "MISMATCH") : record.kind;
          const timing = record.durationMs === undefined ? "not called" : `${record.durationMs}ms`;
          write(`${record.case} @ ${level}: ${verdict}; expected ${record.expected}; ${outcome}; ${timing}`);
          if (record.reason !== undefined) write(`  reason: ${JSON.stringify(record.reason)}`);
          if (record.error !== undefined) write(`  error: ${JSON.stringify(record.error)}`);
          if (record.raw !== undefined) write(`  raw: ${JSON.stringify(record.raw)}`);
        }
      }
      if (controller.signal.aborted) break;
    }
  } finally {
    process.removeListener("SIGINT", stop);
  }

  report.summary = {
    recorded: report.results.length,
    matches: report.results.filter((result) => result.match === true).length,
    mismatches: report.results.filter((result) => result.match === false).length,
    errors: report.results.filter((result) => result.kind !== "decision").length,
    interrupted: controller.signal.aborted,
  };
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    write(`\n${report.summary.matches} match / ${report.summary.mismatches} mismatch / ${report.summary.errors} error; ${report.summary.recorded}/${report.plannedRequests} results.${report.summary.interrupted ? " Interrupted; unsent cases were not retried." : ""}`);
  }
  return report.summary.interrupted ? 130 : report.summary.errors > 0 ? 2 : report.summary.mismatches > 0 ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  runToolProtectionTestCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`Tester error: ${errorMessage(error)}\n`);
      process.exitCode = 2;
    },
  );
}
