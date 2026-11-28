import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import ts from "typescript";

// Windows CI coverage drift contract (issue 776).
//
// Every top-level test file that is Windows-named, compares a platform value
// with the Windows platform id, or reaches such a comparison through an
// imported tests/ support module must be classified in
// .github/windows-test-coverage.json:
//   (a) needs a real Windows runner,
//   (b) fully covered on Linux (pure logic or a mocked Windows layer),
//   (c) POSIX-only (its Windows branches skip by design).
// Every (a) file must keep a declared Windows invocation, and the declared
// invocations are compared with the commands that actually run on the
// enforced triggers: files, name filters (no skip/only filters), opt-in
// environment values, and required earlier steps. Required native cases are
// bound to the exact titles of real node:test call expressions (read through
// the TypeScript parser, so commented-out declarations do not count), and
// declared prerequisite steps can be pinned by their exact run commands.
// Only unconditional jobs and steps count as coverage, except the one pinned
// launcher acceptance gate.
//
// Workflows are parsed structurally, like ci-workflow.test.ts: no YAML parser.

const projectRoot = join(dirname(__dirname), "..");
const MANIFEST_PATH = join(projectRoot, ".github", "windows-test-coverage.json");
const CI_PATH = join(projectRoot, ".github", "workflows", "ci.yml");
const ALPHA_PATH = join(projectRoot, ".github", "workflows", "session-host-alpha.yml");
const ALPHA_USES = "./.github/workflows/session-host-alpha.yml";

// Built from parts so this file never matches its own selection rule.
const WIN_ID = "win" + "32";
const PLATFORM_COMPARISON = new RegExp(`[!=]==?\\s*["']${WIN_ID}["']|["']${WIN_ID}["']\\s*[!=]==?`);
// The one existing step condition that keeps a step on every enforced trigger:
// the launcher acceptance gate, pinned by tests/session-host-windows-workflow.test.ts.
const LAUNCHER_ACCEPTANCE_GATE = "${{ !cancelled() && steps.export_pins.outcome == 'success' }}";

type Triage = "a" | "b" | "c";
/** An earlier step required by id; with `run`, its exact run command is pinned too. */
type Prerequisite = string | { id: string; run: string };
type Invocation = { job: string; filter: "full" | string[]; env?: Record<string, string>; after?: Prerequisite[] };
type Entry = { triage: Triage; reason: string; invocations?: Invocation[]; nativeCases?: string[]; via?: string };
type Manifest = { schema: number; files: Record<string, Entry> };

type Command = { files: string[]; namePatterns: string[]; skipPatterns: number; only: boolean };
type Step = { name: string; id?: string; condition?: string; env: Record<string, string>; commands: Command[]; run: string };
type Job = { key: string; env: Record<string, string>; steps: Step[] };

type CoverageInput = {
  ci: string;
  alpha: string;
  manifest: Manifest;
  /** Top-level test sources keyed by basename without `.test.ts`. */
  tests: Map<string, string>;
  /** Reads a repository-relative support module, or undefined when absent. */
  readSupport: (relativePath: string) => string | undefined;
};

const lf = (text: string): string => text.replace(/\r\n/g, "\n");
const indentOf = (line: string): number => line.length - line.trimStart().length;
const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Top-level `jobs:` children as `key -> block lines`. */
function jobBlocks(source: string): Map<string, string[]> {
  const lines = lf(source).split("\n");
  const start = lines.indexOf("jobs:");
  assert.ok(start !== -1, "expected a top-level jobs: block");
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) === 0) break;
    const key = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) { current = []; jobs.set(key[1], current); continue; }
    current?.push(line);
  }
  return jobs;
}

/** `KEY: value` entries of a mapping block whose entries sit at `indent`. */
function mappingAt(lines: string[], indent: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (indentOf(line) !== indent) continue;
    const match = /^\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (match) out[match[1]] = unquote(match[2]);
  }
  return out;
}

/** Lines of the nested block opened by `<indent>key:` within `lines`. */
function nestedBlock(lines: string[], key: string, indent: number): string[] {
  const at = lines.findIndex((line) => indentOf(line) === indent && line.trim() === `${key}:`);
  if (at === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && indentOf(line) <= indent) break;
    body.push(line);
  }
  return body;
}

/** Every `node --test` invocation in a run value, with its selection flags. */
function commandsOf(runLines: string[], folded: boolean): Command[] {
  const logical = folded ? [runLines.map((line) => line.trim()).join(" ")] : runLines.map((line) => line.trim());
  const commands: Command[] = [];
  for (const line of logical) {
    if (!/^node\s+--test\b/.test(line)) continue;
    const tokens = (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) => token.replace(/["']/g, ""));
    const command: Command = { files: [], namePatterns: [], skipPatterns: 0, only: false };
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const valueOf = (flag: string): string | undefined => token === flag ? tokens[++index] : token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : undefined;
      const name = valueOf("--test-name-pattern");
      if (name !== undefined) { command.namePatterns.push(name); continue; }
      if (valueOf("--test-skip-pattern") !== undefined) { command.skipPatterns += 1; continue; }
      if (token === "--test-only") { command.only = true; continue; }
      const file = /^dist-test\/tests\/([\w.-]+)\.test\.js$/.exec(token);
      if (file) command.files.push(file[1]);
    }
    commands.push(command);
  }
  return commands;
}

function parseSteps(jobLines: string[]): Step[] {
  const stepLines = nestedBlock(jobLines, "steps", 4);
  const chunks: string[][] = [];
  for (const line of stepLines) {
    if (/^      - /.test(line)) chunks.push([line.replace(/^      - /, "        ")]);
    else chunks.at(-1)?.push(line);
  }
  return chunks.map((chunk) => {
    const keys = mappingAt(chunk, 8);
    let commands: Command[] = [];
    let run = "";
    const runAt = chunk.findIndex((line) => /^        run:/.test(line));
    if (runAt !== -1) {
      const inline = chunk[runAt].replace(/^        run:\s*/, "");
      const block: string[] = [];
      for (const line of chunk.slice(runAt + 1)) {
        if (line.trim() !== "" && indentOf(line) <= 8) break;
        if (!line.trimStart().startsWith("#")) block.push(line);
      }
      const folded = inline === ">-" || inline === ">";
      const literal = inline === "|" || inline === "|-";
      commands = folded ? commandsOf(block, true) : literal ? commandsOf(block, false) : commandsOf([inline], false);
      const lines = block.map((line) => line.trim()).filter((line) => line !== "");
      run = folded ? lines.join(" ") : literal ? lines.join("\n") : inline.trim();
    }
    return {
      name: keys.name ?? "",
      id: keys.id,
      condition: keys.if,
      env: mappingAt(nestedBlock(chunk, "env", 8), 10),
      commands,
      run,
    };
  });
}

/** Windows jobs that run on the enforced triggers, keyed `workflow#job`. */
function windowsJobs(ci: string, alpha: string): Map<string, Job> {
  const jobs = new Map<string, Job>();
  const ciJobs = jobBlocks(ci);
  // Any job-level condition can drop a whole job from the enforced triggers.
  const conditional = (lines: string[]): boolean => lines.some((line) => /^    if:/.test(line));
  const collect = (workflow: string, source: Map<string, string[]>): void => {
    for (const [key, lines] of source) {
      if (!lines.some((line) => /^    runs-on:\s*windows-latest\s*$/.test(line))) continue;
      if (conditional(lines)) continue;
      jobs.set(`${workflow}#${key}`, { key, env: mappingAt(nestedBlock(lines, "env", 4), 6), steps: parseSteps(lines) });
    }
  };
  collect("ci.yml", ciJobs);
  const callsAlpha = [...ciJobs.values()].some((lines) => !conditional(lines) && lines.some((line) => line.trim() === `uses: ${ALPHA_USES}`));
  if (callsAlpha) collect("session-host-alpha.yml", jobBlocks(alpha));
  return jobs;
}

/** Only unconditional steps, and the one pinned launcher acceptance gate, count as enforced. */
const enforced = (step: Step): boolean => step.condition === undefined || step.condition === LAUNCHER_ACCEPTANCE_GATE;

/** `process.platform !== <Windows id>` (or `!=`), in either operand order. */
function isNotWindowsPlatform(node: ts.Node): boolean {
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  if (operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsToken) return false;
  const sides = [node.left, node.right];
  return sides.some((side) => ts.isPropertyAccessExpression(side) && side.getText() === "process.platform")
    && sides.some((side) => ts.isStringLiteralLike(side) && side.text === WIN_ID);
}

/**
 * Exact literal titles of real `test(...)`/`it(...)` call expressions, and the
 * ones whose options skip unless on Windows. Comments and strings are not calls.
 */
function declaredCases(source: string): { titles: Set<string>; windowsOnly: string[] } {
  const titles = new Set<string>();
  const windowsOnly: string[] = [];
  const file = ts.createSourceFile("case.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["test", "it", "nodeTest"].includes(node.expression.text)) {
      const [first, second] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) {
        titles.add(first.text);
        const skip = second !== undefined && ts.isObjectLiteralExpression(second)
          ? second.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === "skip")
          : undefined;
        if (skip !== undefined && ts.isPropertyAssignment(skip) && isNotWindowsPlatform(skip.initializer)) windowsOnly.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { titles, windowsOnly };
}

/** Repository-relative support modules a test imports, transitively, within tests/. */
function supportClosure(start: string, read: (path: string) => string | undefined): string[] {
  const seen = new Set<string>();
  const startSource = read(start);
  const pending: Array<[string, string]> = startSource === undefined ? [] : [[start, startSource]];
  while (pending.length > 0) {
    const [path, source] = pending.pop()!;
    for (const match of source.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = posix.normalize(posix.join(posix.dirname(path), match[1]));
      if (!base.startsWith("tests/")) continue;
      for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`]) {
        if (seen.has(candidate) || candidate.endsWith(".test.ts")) continue;
        const text = read(candidate);
        if (text === undefined) continue;
        seen.add(candidate);
        pending.push([candidate, text]);
        break;
      }
    }
  }
  return [...seen];
}

/** Every drift problem; an empty list means the manifest and workflows agree. */
function coverageProblems(input: CoverageInput): string[] {
  const problems: string[] = [];
  const jobs = windowsJobs(input.ci, input.alpha);
  if (jobs.size < 3) problems.push(`expected at least three enforced Windows jobs, found ${[...jobs.keys()].join(", ") || "none"}`);
  const files = input.manifest.files ?? {};
  const keyOf = (name: string): string => `tests/${name}.test.ts`;

  // Commands that reference each file, per enforced Windows job.
  const references = new Map<string, Array<{ job: string; step: Step; stepIndex: number; command: Command }>>();
  for (const [jobKey, job] of jobs) {
    job.steps.forEach((step, stepIndex) => {
      if (!enforced(step)) return;
      for (const command of step.commands) {
        for (const file of command.files) {
          const list = references.get(file) ?? [];
          list.push({ job: jobKey, step, stepIndex, command });
          references.set(file, list);
        }
      }
    });
  }

  // Selection: named, compared, or helper-delegated.
  const selected = new Map<string, string>();
  for (const [name, source] of input.tests) {
    if (/windows/i.test(name)) selected.set(name, "Windows-named");
    else if (PLATFORM_COMPARISON.test(source)) selected.set(name, "platform comparison");
    else {
      const helper = supportClosure(keyOf(name), (path) => path === keyOf(name) ? source : input.readSupport(path))
        .find((path) => PLATFORM_COMPARISON.test(input.readSupport(path) ?? ""));
      if (helper) selected.set(name, `platform comparison via ${helper}`);
    }
  }
  for (const [name, why] of selected) {
    if (!files[keyOf(name)]) problems.push(`${keyOf(name)} (${why}) has no entry in .github/windows-test-coverage.json`);
  }
  // Reverse direction: every file an enforced Windows job runs must be classified too.
  for (const [name, refs] of references) {
    if (selected.has(name) || files[keyOf(name)]) continue;
    const where = [...new Set(refs.map(({ job, step }) => `${job} step "${step.name}"`))].join(", ");
    problems.push(`${keyOf(name)} runs in ${where} but has no entry in .github/windows-test-coverage.json`);
  }

  for (const [key, entry] of Object.entries(files)) {
    const match = /^tests\/([\w.-]+)\.test\.ts$/.exec(key);
    const name = match?.[1];
    const source = name === undefined ? undefined : input.tests.get(name);
    if (name === undefined || source === undefined) { problems.push(`${key}: manifest entry names no existing top-level test file`); continue; }
    if (!["a", "b", "c"].includes(entry.triage)) problems.push(`${key}: triage must be a, b, or c`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") problems.push(`${key}: reason must be non-empty`);
    const invocations = entry.invocations ?? [];
    if (!selected.has(name) && !references.has(name)) problems.push(`${key}: stale entry; the file is neither selected nor run by a Windows job`);
    if (entry.triage === "a" && invocations.length === 0) problems.push(`${key}: class (a) needs at least one Windows invocation`);

    if (entry.via !== undefined) {
      const helperSource = input.readSupport(entry.via);
      if (helperSource === undefined || !PLATFORM_COMPARISON.test(helperSource)) problems.push(`${key}: via ${entry.via} no longer carries a Windows platform comparison`);
      else if (!supportClosure(key, (path) => path === key ? source : input.readSupport(path)).includes(entry.via)) problems.push(`${key}: via ${entry.via} is no longer imported`);
    }

    // Required native cases are bound to exact declared titles.
    const declared = declaredCases(source);
    const nativeCases = entry.nativeCases ?? [];
    if (nativeCases.length > 0 && invocations.length === 0) problems.push(`${key}: nativeCases require a Windows invocation`);
    for (const title of nativeCases) {
      if (!declared.titles.has(title)) problems.push(`${key}: required native case is not declared (absent or renamed): ${JSON.stringify(title)}`);
    }
    for (const title of declared.windowsOnly) {
      if (invocations.length === 0) problems.push(`${key}: declares Windows-only case ${JSON.stringify(title)} but has no Windows invocation`);
      else if (!nativeCases.includes(title)) problems.push(`${key}: Windows-only case ${JSON.stringify(title)} is not listed in nativeCases`);
    }

    // Each declared invocation must be satisfied by an enforced command.
    for (const invocation of invocations) {
      const job = jobs.get(invocation.job);
      if (!job) { problems.push(`${key}: invocation names unknown or unenforced Windows job ${invocation.job}`); continue; }
      const satisfied = (references.get(name) ?? []).some(({ job: jobKey, step, stepIndex, command }) => {
        if (jobKey !== invocation.job) return false;
        if (command.skipPatterns > 0 || command.only) return false;
        if (invocation.filter === "full") { if (command.namePatterns.length > 0) return false; }
        else {
          const want = [...invocation.filter].sort();
          const have = [...command.namePatterns].sort();
          if (want.length === 0 || JSON.stringify(want) !== JSON.stringify(have)) return false;
          if (!nativeCases.every((title) => want.some((pattern) => new RegExp(pattern).test(title)))) return false;
        }
        const env = { ...job.env, ...step.env };
        if (!Object.entries(invocation.env ?? {}).every(([variable, value]) => env[variable] === value)) return false;
        return (invocation.after ?? []).every((prerequisite) => {
          const id = typeof prerequisite === "string" ? prerequisite : prerequisite.id;
          const run = typeof prerequisite === "string" ? undefined : prerequisite.run;
          return job.steps.slice(0, stepIndex)
            .some((earlier) => earlier.id === id && enforced(earlier) && (run === undefined || earlier.run === run));
        });
      });
      if (!satisfied) problems.push(`${key}: no enforced ${invocation.job} command satisfies ${JSON.stringify(invocation)}`);
    }

    // Every Windows command that runs the file must match a declared invocation.
    for (const { job: jobKey, step, command } of references.get(name) ?? []) {
      const job = jobs.get(jobKey)!;
      const env = { ...job.env, ...step.env };
      const declaredHere = invocations.filter((invocation) => invocation.job === jobKey);
      const matches = declaredHere.some((invocation) => {
        if (command.skipPatterns > 0 || command.only) return false;
        const filterOk = invocation.filter === "full" ? command.namePatterns.length === 0
          : JSON.stringify([...invocation.filter].sort()) === JSON.stringify([...command.namePatterns].sort());
        return filterOk && Object.entries(invocation.env ?? {}).every(([variable, value]) => env[variable] === value);
      });
      if (!matches) problems.push(`${key}: ${jobKey} step "${step.name}" runs the file without a matching declared invocation`);
    }
  }
  return problems;
}

function readInput(): CoverageInput {
  const testsDir = join(projectRoot, "tests");
  const tests = new Map<string, string>();
  for (const file of readdirSync(testsDir)) {
    if (file.endsWith(".test.ts")) tests.set(file.slice(0, -".test.ts".length), readFileSync(join(testsDir, file), "utf8"));
  }
  return {
    ci: readFileSync(CI_PATH, "utf8"),
    alpha: readFileSync(ALPHA_PATH, "utf8"),
    manifest: JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest,
    tests,
    readSupport: (relativePath) => {
      const absolute = join(projectRoot, ...relativePath.split("/"));
      return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : undefined;
    },
  };
}

/** Replace exactly one occurrence, so a mutation can never silently miss. */
function once(text: string, from: string, to: string): string {
  const normalized = lf(text);
  assert.equal(normalized.split(from).length - 1, 1, `mutation anchor must occur exactly once: ${from}`);
  return normalized.replace(from, to);
}

const expectProblem = (input: CoverageInput, file: string, what: string): void => {
  const problems = coverageProblems(input);
  assert.ok(problems.some((problem) => problem.includes(file)), `${what} must fail the contract for ${file}; got ${JSON.stringify(problems)}`);
};

test("the Windows coverage manifest classifies every selected test file and matches the enforced Windows commands", () => {
  const input = readInput();
  assert.equal(input.manifest.schema, 1, "manifest schema version");
  assert.deepEqual(coverageProblems(input), []);
});

test("every class (a) file has a Windows invocation and every class is accounted for", () => {
  const { manifest } = readInput();
  const entries = Object.values(manifest.files);
  assert.ok(entries.some((entry) => entry.triage === "a"), "class (a) entries exist");
  assert.ok(entries.some((entry) => entry.triage === "b"), "class (b) entries exist");
  assert.ok(entries.some((entry) => entry.triage === "c"), "class (c) entries exist");
  for (const [key, entry] of Object.entries(manifest.files)) {
    if (entry.triage === "a") assert.ok((entry.invocations ?? []).length > 0, `${key} is class (a) and must run on Windows`);
  }
});

test("a filter added to a full-file invocation fails although the file stays in the workflow", () => {
  const input = readInput();
  const alpha = once(input.alpha,
    "run: node --test dist-test/tests/session-host-broker.test.js",
    "run: node --test --test-name-pattern=\"does-not-match\" dist-test/tests/session-host-broker.test.js");
  expectProblem({ ...input, alpha }, "tests/session-host-broker.test.ts", "an excluding filter on the broker step");
});

test("removing a declared opt-in fails although the file stays in the workflow", () => {
  const input = readInput();
  const alpha = once(input.alpha,
    "        env:\n          PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST: \"1\"\n        run: node --test dist-test/tests/session-host-native-windows-console-probe.test.js",
    "        run: node --test dist-test/tests/session-host-native-windows-console-probe.test.js");
  expectProblem({ ...input, alpha }, "tests/session-host-native-windows-console-probe.test.ts", "removing the console-probe opt-in");
});

test("a skip pattern beside a matching positive filter fails", () => {
  const input = readInput();
  const ci = once(input.ci,
    "      - name: Windows Git checkpoint native smoke (Node 24)\n        run: node --test --test-name-pattern=\"native Windows Git checkpoint\" dist-test/tests/git-checkpoint.test.js",
    "      - name: Windows Git checkpoint native smoke (Node 24)\n        run: node --test --test-name-pattern=\"native Windows Git checkpoint\" --test-skip-pattern=\"native Windows Git checkpoint\" dist-test/tests/git-checkpoint.test.js");
  expectProblem({ ...input, ci }, "tests/git-checkpoint.test.ts", "a skip pattern on the Git checkpoint step");
});

test("renaming a required native case in source alone fails", () => {
  const input = readInput();
  const tests = new Map(input.tests);
  const original = tests.get("session-host-payload-transport");
  assert.ok(original, "payload-transport source exists");
  tests.set("session-host-payload-transport", once(original,
    "test(\"rejects unsafe namespaces and non-regular replacements before reading\"",
    "test(\"rejects unsafe namespaces (renamed)\""));
  expectProblem({ ...input, tests }, "tests/session-host-payload-transport.test.ts", "renaming a required native case");
});

test("a new Windows-only case outside a declared filter fails", () => {
  const input = readInput();
  const tests = new Map(input.tests);
  const original = tests.get("git-checkpoint");
  assert.ok(original, "git-checkpoint source exists");
  const added = `${lf(original)}\ntest("a new native case", { skip: process.platform !== "${WIN_ID}" }, () => {});\n`;
  tests.set("git-checkpoint", added);
  expectProblem({ ...input, tests }, "tests/git-checkpoint.test.ts", "an unlisted Windows-only case");
});

test("dropping a class (a) step or moving it behind a dispatch-only condition fails", () => {
  const input = readInput();
  const removed = once(input.ci, "        run: node --test dist-test/tests/cli-launch-preparation.test.js\n", "        run: echo removed\n");
  expectProblem({ ...input, ci: removed }, "tests/cli-launch-preparation.test.ts", "removing the class (a) step");
  const gated = once(input.ci,
    "      - name: Reviewer CLI launch preparation (native cmd.exe, UNC, volume)\n",
    "      - name: Reviewer CLI launch preparation (native cmd.exe, UNC, volume)\n        if: github.event_name == 'workflow_dispatch'\n");
  expectProblem({ ...input, ci: gated }, "tests/cli-launch-preparation.test.ts", "a dispatch-only condition");
  const disabled = once(input.ci,
    "      - name: Reviewer CLI launch preparation (native cmd.exe, UNC, volume)\n",
    "      - name: Reviewer CLI launch preparation (native cmd.exe, UNC, volume)\n        if: false\n");
  expectProblem({ ...input, ci: disabled }, "tests/cli-launch-preparation.test.ts", "an explicit false step condition");
});

test("a job-level dispatch-only condition removes that job's coverage", () => {
  const input = readInput();
  const ci = once(input.ci, "    name: Windows shell (Node 24)\n", "    name: Windows shell (Node 24)\n    if: github.event_name == 'workflow_dispatch'\n");
  expectProblem({ ...input, ci }, "tests/cli-launch-preparation.test.ts", "a dispatch-only windows-shell job");
  expectProblem({ ...input, ci }, "tests/background-shell-windows.test.ts", "a dispatch-only windows-shell job");
});

test("commenting out a required native case in source alone fails although its text remains", () => {
  const input = readInput();
  const tests = new Map(input.tests);
  const original = lf(tests.get("background-shell-integration") ?? "");
  const title = "  it(\"tracks exact ShellStart call liveness until the job settles\"";
  const start = original.indexOf(title);
  assert.ok(start !== -1, "the required liveness declaration exists");
  const end = original.indexOf("\n  });\n", start);
  assert.ok(end !== -1, "the required liveness declaration closes");
  const closeAt = end + "\n  });".length;
  tests.set("background-shell-integration", `${original.slice(0, start)}/*${original.slice(start, closeAt)}*/${original.slice(closeAt)}`);
  expectProblem({ ...input, tests }, "tests/background-shell-integration.test.ts", "commenting out the required liveness case");
});

test("replacing a pinned prerequisite command with a no-op fails although its id and order remain", () => {
  const input = readInput();
  const alpha = lf(input.alpha);
  const marker = "        id: live_authority_host_support\n        timeout-minutes: 2\n        run: >-\n          ";
  const at = alpha.indexOf(marker);
  assert.ok(at !== -1, "the host-support probe step exists");
  const lineEnd = alpha.indexOf("\n", at + marker.length);
  const mutated = `${alpha.slice(0, at + marker.length)}node -e "process.exit(0)"${alpha.slice(lineEnd)}`;
  expectProblem({ ...input, alpha: mutated }, "tests/pi-native-tools-live-authority.test.ts", "a no-op host-support probe");
});

test("a Windows-job file whose manifest entry is deleted fails although the workflow is unchanged", () => {
  const input = readInput();
  const files = { ...input.manifest.files };
  assert.ok(files["tests/background-shell-jobs.test.ts"], "background-shell-jobs is classified today");
  delete files["tests/background-shell-jobs.test.ts"];
  expectProblem({ ...input, manifest: { ...input.manifest, files } }, "tests/background-shell-jobs.test.ts", "deleting a Windows-job file's entry");
});

test("an unclassified Windows-named test file fails", () => {
  const input = readInput();
  const tests = new Map(input.tests);
  tests.set("synthetic-windows-drift", "test(\"x\", () => {});\n");
  expectProblem({ ...input, tests }, "tests/synthetic-windows-drift.test.ts", "an unclassified Windows-named file");
});

test("the declaration parser binds exact literal titles and skip-unless-Windows cases", () => {
  const source = [
    "test(\"plain case\", () => {});",
    `test("native case", { skip: process.platform !== "${WIN_ID}" }, async () => {});`,
    "it('quoted \\'single\\' case', () => {});",
    "const ok = /x/.test(\"not a declaration\");",
    "// test(\"commented out\", () => {});",
    "/* test(\"block commented\", () => {}); */",
  ].join("\n");
  const { titles, windowsOnly } = declaredCases(source);
  assert.deepEqual([...titles].sort(), ["native case", "plain case", "quoted 'single' case"]);
  assert.deepEqual(windowsOnly, ["native case"]);
});
