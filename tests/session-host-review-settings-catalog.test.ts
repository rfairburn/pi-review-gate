import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  loadReviewSettingsChoices,
  nativeBuiltinToolEntries,
  ReviewSettingsCatalogUnavailableError,
  shippedReviewGateToolNames,
} from "../src/session-host/review-settings-catalog";
import { scopedModelChoices } from "../src/settings/models";
import { readToolChoices } from "../src/settings/tools";
import { CODEMODE_TOOL_NAME, DEFERRED_TOOL_SEARCH_NAME } from "../src/tool-inventory";
import { ExecutionToolManager, EXECUTION_TOOL_NAMES } from "../src/execution/tool";
import { WebToolManager } from "../src/web/tools";
import registerBackgroundShell from "../src/background-shell";
import { registerApplyPatchTool } from "../src/apply-patch/tool";
import { registerGitReadTool } from "../src/git-read/tool";
import { registerSessionSpawnTool } from "../src/session-host/spawn-tool";
import { registerSessionHostsTool } from "../src/session-host/hosts-tool";
import { UserQuestionController } from "../src/user-question/controller";
import { createUserQuestionTool } from "../src/user-question/tool";
import { createYouShouldKnowTool } from "../src/user-question/notice-tool";
import { CODEMODE_TOOL_NAME as DEFERRED_CODEMODE_TOOL_NAME } from "../src/deferred-tools";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

const PI_EXECUTABLE = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

function scratchDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rs-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface FakeModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

const MODELS: FakeModel[] = [
  { provider: "acme", id: "deep", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xh" } },
  { provider: "acme", id: "flat" },
];

/** The exact first-launch guidance text, asserted once and reused by other tests. */
const NO_SCOPED_MODELS_GUIDANCE =
  "no Pi models are scoped yet, so the Pi model pickers offer no choices; configure Pi's own base settings and scoped models in a real Pi session first (a sidebar New session works with review and subtasks left unset), then reopen: this editor is not Pi's settings editor";

interface FakeSdkLog {
  createOptions?: Record<string, any>;
  settingsOptions?: Record<string, any>;
  storage?: { withLock(scope: string, fn: (current: string | undefined) => string | undefined): void };
  resolvedPatterns?: string[];
  parsedArgs?: string[];
  realGetAvailableCalls: number;
  sessionCreations: number;
}

/**
 * A structural fake of the public SDK surface. Its resolver mirrors the real
 * one's contract (it only reads `runtime.getAvailable`) with a tiny exact-id
 * grammar; the real grammar is exercised by the installed-SDK test below.
 */
function fakeSdk(log: FakeSdkLog, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ModelRuntime: {
      async create(options: Record<string, any>) {
        log.createOptions = options;
        return {
          getModels: () => MODELS,
          getAvailable: async () => { log.realGetAvailableCalls += 1; throw new Error("real getAvailable must never be called"); },
          getError: () => undefined,
        };
      },
    },
    SettingsManager: {
      fromStorage(storage: FakeSdkLog["storage"], options: Record<string, any>) {
        log.storage = storage;
        log.settingsOptions = options;
        let content: string | undefined;
        storage!.withLock("global", (current) => { content = current; return undefined; });
        const settings = content ? JSON.parse(content) : {};
        return { drainErrors: () => [], getEnabledModels: () => settings.enabledModels };
      },
    },
    parseArgs(args: string[]) {
      log.parsedArgs = args;
      const index = args.indexOf("--models");
      return index >= 0 ? { models: args[index + 1]!.split(",") } : {};
    },
    async resolveModelScopeWithDiagnostics(patterns: string[], runtime: { getAvailable(): Promise<FakeModel[]> }) {
      log.resolvedPatterns = patterns;
      const available = await runtime.getAvailable();
      const scopedModels: Array<{ model: FakeModel; thinkingLevel?: string }> = [];
      const diagnostics: Array<{ type: string; code: string; message: string; pattern: string }> = [];
      for (const pattern of patterns) {
        const [ref, thinking] = pattern.split(":");
        const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === ref);
        if (model) scopedModels.push(thinking ? { model, thinkingLevel: thinking } : { model });
        else diagnostics.push({ type: "warning", code: "no-match", message: `No models match pattern "${pattern}"`, pattern });
      }
      return { scopedModels, diagnostics };
    },
    createReadToolDefinition: (cwd: string) => ({ name: "read", description: `Read files. cwd=${cwd}`, execute: () => { throw new Error("never executed"); } }),
    createBashToolDefinition: () => ({ name: "bash", description: "Execute a command.", execute: () => { throw new Error("never executed"); } }),
    ...overrides,
  };
}

function newLog(): FakeSdkLog {
  return { realGetAvailableCalls: 0, sessionCreations: 0 };
}

test("model catalog: metadata-only runtime, explicit agent dir, no auth/network/refresh, canonical conversion", async (t) => {
  const agentDir = scratchDir(t);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/deep:high", "acme/flat", "acme/ghost"] }));
  const log = newLog();
  const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(log) });

  const options = log.createOptions!;
  assert.equal(options.refreshOnCreate, false);
  assert.equal(options.allowModelNetwork, false);
  assert.equal(options.modelsPath, join(agentDir, "models.json"));
  assert.equal(options.authPath, undefined, "no ambient auth file path is ever handed to the runtime");
  // Empty, read-only credential and model stores: nothing to read, every write refused.
  assert.equal(await options.credentials.read("acme"), undefined);
  assert.deepEqual(await options.credentials.list(), []);
  await assert.rejects(options.credentials.modify("acme", async () => ({ type: "api_key", key: "x" })));
  await assert.rejects(options.credentials.delete("acme"));
  assert.equal(await options.modelsStore.read("acme"), undefined);
  await assert.rejects(options.modelsStore.write("acme", { models: [] }));
  assert.equal(log.realGetAvailableCalls, 0, "authenticated availability is never consulted");

  assert.deepEqual(log.resolvedPatterns, ["acme/deep:high", "acme/flat", "acme/ghost"]);
  // Exactly the canonical conversion of the native scoped entries.
  assert.deepEqual(catalog.scoped, scopedModelChoices({
    scopedModels: [{ model: MODELS[0], thinkingLevel: "high" }, { model: MODELS[1] }],
  }));
  assert.deepEqual(catalog.scoped.map((choice) => choice.model), ["acme/deep", "acme/flat"]);
  assert.equal(catalog.scoped[0]!.pinnedThinkingLevel, "high");
  assert.deepEqual(catalog.scoped[1]!.supportedThinkingLevels, ["off"]);
  assert.ok(!catalog.scoped.some((choice) => choice.model === "acme/ghost"), "unknown models are never fabricated");
  assert.deepEqual(catalog.warnings, ['No models match pattern "acme/ghost"']);
  assert.deepEqual(catalog.modelScope, { source: "enabledModels", patterns: ["acme/deep:high", "acme/flat", "acme/ghost"] });
});

test("model catalog: global settings via a read-only port; project settings and trust are never touched", async (t) => {
  const agentDir = scratchDir(t);
  const settingsPath = join(agentDir, "settings.json");
  const bytes = JSON.stringify({ enabledModels: ["acme/flat"] });
  writeFileSync(settingsPath, bytes);
  const log = newLog();
  await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(log) });
  assert.deepEqual(log.settingsOptions, { projectTrusted: false });
  const storage = log.storage!;
  let project: string | undefined = "unset";
  storage.withLock("project", (current) => { project = current; return undefined; });
  assert.equal(project, undefined, "the project scope is always empty");
  assert.throws(() => storage.withLock("global", () => "{}"), /read-only/);
  assert.equal(readFileSync(settingsPath, "utf8"), bytes, "the settings file is unchanged");
  assert.deepEqual(readdirSync(agentDir), ["settings.json"], "no lock, cache, auth, or models file is created");
});

test("model catalog: no patterns resolve no scope (Pi semantics); explicit --models wins over enabledModels", async (t) => {
  const agentDir = scratchDir(t);
  const none = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(newLog()) });
  assert.deepEqual(none.scoped, []);
  assert.deepEqual(none.modelScope, { source: "none", patterns: [] });
  assert.deepEqual(none.warnings, [NO_SCOPED_MODELS_GUIDANCE]);

  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/flat"] }));
  const log = newLog();
  const args = ["--models", "acme/deep:low", "--session-dir", "/elsewhere"];
  const explicit = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir, args }, { loadSdk: () => fakeSdk(log) });
  assert.deepEqual(log.parsedArgs, args, "Pi's own parseArgs receives the forwarded args");
  assert.deepEqual(explicit.modelScope, { source: "args", patterns: ["acme/deep:low"] });
  assert.deepEqual(explicit.scoped.map((choice) => [choice.model, choice.pinnedThinkingLevel]), [["acme/deep", "low"]]);

  // Forwarded args without --models fall back to the global enabledModels.
  const fallback = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir, args: ["--session-dir", "/x"] }, { loadSdk: () => fakeSdk(newLog()) });
  assert.deepEqual(fallback.modelScope, { source: "enabledModels", patterns: ["acme/flat"] });
});

test("model catalog: recoverable problems are content-free warnings, never quoted bytes", async (t) => {
  const agentDir = scratchDir(t);
  const secret = "SENTINEL-SECRET-BYTES";
  const log = newLog();
  const sdk = fakeSdk(log, {
    ModelRuntime: {
      async create() {
        return { getModels: () => MODELS, getError: () => `Failed to parse models.json: Unexpected token near "${secret}"` };
      },
    },
    SettingsManager: {
      fromStorage() {
        return { drainErrors: () => [{ scope: "global", error: new Error(`bad json "${secret}"`) }], getEnabledModels: () => undefined };
      },
    },
  });
  const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => sdk });
  // The unset enabledModels also carries the first-launch guidance notice; the
  // two recoverable problems are reported exactly once each.
  const contentFree = catalog.warnings.filter((warning) => warning !== NO_SCOPED_MODELS_GUIDANCE);
  assert.equal(contentFree.length, 2);
  assert.ok(!JSON.stringify(catalog).includes(secret), "no configuration bytes are surfaced");
});

test("first launch: an unset or empty Pi scope is one informational notice, never a refusal, session, or write", async (t) => {
  const agentDir = scratchDir(t);
  const log = newLog();
  // Session-creation exports on the SDK surface are rigged to fail and count:
  // the catalog must never reach one. Settings writes are already refused by the
  // read-only storage port, and the agent dir must stay empty.
  const sdk = fakeSdk(log, {
    createAgentSession: () => { log.sessionCreations += 1; throw new Error("the settings catalog never creates a Pi session"); },
    createAgentSessionFromServices: () => { log.sessionCreations += 1; throw new Error("the settings catalog never creates a Pi session"); },
    createAgentSessionEnvironment: () => { log.sessionCreations += 1; throw new Error("the settings catalog never creates a Pi session"); },
  });

  // Unset: no global settings file at all.
  const unset = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => sdk });
  assert.deepEqual(unset.scoped, [], "no Pi model choices are offered");
  assert.deepEqual(unset.modelScope, { source: "none", patterns: [] });
  assert.deepEqual(unset.warnings, [NO_SCOPED_MODELS_GUIDANCE]);
  assert.equal(log.sessionCreations, 0, "no Pi session is created to explain the notice");
  assert.equal(log.resolvedPatterns, undefined, "the native resolver is never called without patterns");
  assert.equal(log.realGetAvailableCalls, 0, "availability is still never consulted");
  assert.deepEqual(readdirSync(agentDir), [], "the notice creates no config, settings, auth, or cache file");

  // The other sections stay offered: the notice restricts nothing.
  const names = unset.tools.map((tool) => tool.name);
  assert.ok(names.includes("read") && names.includes(DEFERRED_TOOL_SEARCH_NAME));

  // Empty: an explicit --models list with no entries.
  const empty = await loadReviewSettingsChoices(
    { piExecutable: PI_EXECUTABLE, agentDir, args: ["--models", ""] },
    { loadSdk: () => fakeSdk(newLog(), { parseArgs: () => ({ models: [] }) }) },
  );
  assert.deepEqual(empty.modelScope, { source: "args", patterns: [] });
  assert.deepEqual(empty.scoped, []);
  assert.deepEqual(empty.warnings, [NO_SCOPED_MODELS_GUIDANCE]);

  // The notice stays inside the consumer's bounded single-line notice sink.
  assert.equal(NO_SCOPED_MODELS_GUIDANCE.includes("\n"), false);
  assert.ok(NO_SCOPED_MODELS_GUIDANCE.length <= 360, "the sidebar notice prefix must not truncate it");
});

test("a nonempty scope still restricts: no first-launch notice, native diagnostics unchanged", async (t) => {
  const agentDir = scratchDir(t);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/ghost"] }));
  const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(newLog()) });
  assert.deepEqual(catalog.scoped, []);
  assert.deepEqual(catalog.warnings, ['No models match pattern "acme/ghost"'], "a nonempty scope keeps Pi's own diagnostics and gains no first-launch forcing");

  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/flat"] }));
  const matched = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(newLog()) });
  assert.deepEqual(matched.scoped.map((choice) => choice.model), ["acme/flat"]);
  assert.deepEqual(matched.warnings, []);
});

test("catalog unavailability rejects explicitly instead of returning an empty success", async (t) => {
  const agentDir = scratchDir(t);
  await assert.rejects(
    loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => { throw new Error("no official package"); } }),
    (error: unknown) => error instanceof ReviewSettingsCatalogUnavailableError && /no official package/.test(error.message),
  );
  await assert.rejects(
    loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(newLog(), { ModelRuntime: undefined }) }),
    ReviewSettingsCatalogUnavailableError,
  );
  await assert.rejects(
    loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(newLog(), { SettingsManager: {} }) }),
    ReviewSettingsCatalogUnavailableError,
  );
  await assert.rejects(
    loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir, args: ["--models", "a"] }, { loadSdk: () => fakeSdk(newLog(), { parseArgs: undefined }) }),
    ReviewSettingsCatalogUnavailableError,
  );
  await assert.rejects(
    loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir: "relative/agent" }, { loadSdk: () => fakeSdk(newLog()) }),
    ReviewSettingsCatalogUnavailableError,
  );
  await assert.rejects(
    loadReviewSettingsChoices({ piExecutable: "pi", agentDir }, { loadSdk: () => fakeSdk(newLog()) }),
    ReviewSettingsCatalogUnavailableError,
  );
});

test("the default SDK loader keeps the shared role guards (no SDK load inside a delegated role)", async (t) => {
  const agentDir = scratchDir(t);
  const previous = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previous;
  });
  await assert.rejects(
    loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }),
    (error: unknown) => error instanceof ReviewSettingsCatalogUnavailableError && /PI_REVIEW_GATE_RUNTIME_ROLE/.test(error.message),
  );
});

/** Every name the real registrars register, captured through fake hosts. */
function registeredReviewGateNames(): string[] {
  const names: string[] = [];
  const capture = { registerTool: (tool: Record<string, unknown>) => { names.push(tool.name as string); } };

  new ExecutionToolManager({
    pi: { ...capture, registerCommand() {}, setToolActive() {}, getActiveTools: () => [] },
    config: normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: { fake: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" as const } } },
      execution: {
        workerResources: { default: { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    }),
    state: createState(),
    cwd: () => process.cwd(),
    notify: () => {},
  }).sync();
  new WebToolManager(
    capture as never,
    normalizeConfig({}),
    undefined,
    undefined,
    { shutdown: async () => {}, updateConfig: () => {} } as never,
  ).register();
  registerBackgroundShell({ ...capture, on: () => {}, sendMessage: () => {} } as never);
  registerApplyPatchTool(capture);
  registerGitReadTool(capture as never, () => process.cwd());
  const capability = {
    titleColumns: 32,
    routing: true,
    spawn: async () => { throw new Error("never spawned"); },
    inspectHosts: async () => { throw new Error("never inspected"); },
  };
  registerSessionSpawnTool(capture, capability as never);
  registerSessionHostsTool(capture, capability as never);
  const controller = new UserQuestionController({ pi: { sendUserMessage: () => Promise.resolve() }, uiAvailable: () => false });
  capture.registerTool(createUserQuestionTool(controller, { shortcutLabel: "x" }) as unknown as Record<string, unknown>);
  capture.registerTool(createYouShouldKnowTool(controller) as unknown as Record<string, unknown>);
  return names;
}

test("tool candidates: shipped names are exactly the real registrars' names plus the reserved loader", () => {
  const registered = registeredReviewGateNames();
  const shipped = shippedReviewGateToolNames();
  assert.equal(new Set(shipped).size, shipped.length, "no duplicate candidate names");
  assert.deepEqual(
    [...shipped].filter((name) => name !== DEFERRED_TOOL_SEARCH_NAME).sort(),
    [...new Set(registered)].sort(),
    "every shipped candidate is a real registration name and every real registration is a candidate",
  );
  assert.ok(shipped.includes(DEFERRED_TOOL_SEARCH_NAME));
  assert.ok(Object.values(EXECUTION_TOOL_NAMES).every((name) => registered.includes(name)));
  assert.equal(DEFERRED_CODEMODE_TOOL_NAME, CODEMODE_TOOL_NAME, "the deferred manager re-exports the one canonical codemode name");
});

test("tool candidates: full inventory from an empty config, native builtins only from SDK definitions, no authority fields", async (t) => {
  const agentDir = scratchDir(t);
  const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(newLog()) });
  const names = catalog.tools.map((tool) => tool.name);
  for (const name of [...shippedReviewGateToolNames(), CODEMODE_TOOL_NAME, "read", "bash"]) {
    assert.ok(names.includes(name), `${name} is a configuration candidate without any saved value`);
  }
  assert.ok(!names.includes("powershell"), "a builtin the SDK does not define is never assumed");
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const tool of catalog.tools) {
    assert.deepEqual(Object.keys(tool).filter((key) => key !== "name" && key !== "description"), [],
      "entries carry no availability, activation, or authorization claims");
  }
  assert.equal(catalog.tools.find((tool) => tool.name === "read")!.description, `Read files. cwd=${agentDir}`);

  // The reserved loader stays canonical through the existing settings readers.
  const provider = () => catalog.tools;
  assert.ok(!readToolChoices(provider).some((tool) => tool.name === DEFERRED_TOOL_SEARCH_NAME));
  assert.ok(readToolChoices(provider, { includeReservedDiscoveryLoader: true }).some((tool) => tool.name === DEFERRED_TOOL_SEARCH_NAME));

  const noNative = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, {
    loadSdk: () => fakeSdk(newLog(), { createReadToolDefinition: undefined, createBashToolDefinition: undefined }),
  });
  assert.ok(!noNative.tools.some((tool) => tool.name === "read" || tool.name === "bash"));
  assert.ok(noNative.warnings.some((warning) => /native builtin tool/.test(warning)), "missing native metadata is reported, not hidden");
});

test("native builtin entries skip throwing, malformed, and non-factory exports", () => {
  const entries = nativeBuiltinToolEntries({
    createGoodToolDefinition: () => ({ name: "good" }),
    createThrowsToolDefinition: () => { throw new Error("boom"); },
    createPaddedToolDefinition: () => ({ name: " padded" }),
    createToolDefinition: () => ({ name: "generic" }),
    createOtherTool: () => ({ name: "notADefinition" }),
    createValueToolDefinition: "not a function",
  }, "/cwd");
  assert.deepEqual(entries, [{ name: "good" }]);
});

/** The installed official Pi package matching the pinned UI runtime version. */
function installedPi(t: TestContext): { packageDir: string; cli: string } | undefined {
  for (const packageDir of findInstalledAgentDirs()) {
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string; bin?: Record<string, string> };
      const bin = manifest.bin?.pi;
      if (manifest.version === "1.5.2" && typeof bin === "string" && existsSync(join(packageDir, bin))) {
        return { packageDir, cli: join(packageDir, bin) };
      }
    } catch {
      // try the next install
    }
  }
  skipOrFail(t, "no installed Pi 1.5.2 for the standalone settings catalog");
  return undefined;
}

test("installed Pi SDK: native scope grammar and reasoning metadata, no session, no auth, no writes", async (t) => {
  const pi = installedPi(t);
  if (!pi) return;
  const agentDir = scratchDir(t);
  const secret = "SENTINEL_SECRET_KEY_BYTES";
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "catalog-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: secret,
        models: [
          { id: "reasoner", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xh" } },
          { id: "plain" },
        ],
      },
    },
  }));
  const settingsBytes = JSON.stringify({ enabledModels: ["catalog-test/reasoner:high", "catalog-test/pl*", "catalog-test/absent"] });
  writeFileSync(join(agentDir, "settings.json"), settingsBytes);
  const before = statSync(join(agentDir, "settings.json")).mtimeMs;

  // An ambient agent dir with a conflicting scope must be ignored.
  const ambient = scratchDir(t);
  writeFileSync(join(ambient, "settings.json"), JSON.stringify({ enabledModels: ["catalog-test/plain"] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = ambient;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  const catalog = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(catalog.modelScope.source, "enabledModels");
  assert.deepEqual(catalog.scoped, [
    {
      model: "catalog-test/reasoner",
      label: "reasoner [catalog-test]",
      pinnedThinkingLevel: "high",
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    },
    { model: "catalog-test/plain", label: "plain [catalog-test]", pinnedThinkingLevel: undefined, supportedThinkingLevels: ["off"] },
  ]);
  assert.ok(catalog.warnings.some((warning) => warning.includes("catalog-test/absent")), "native no-match diagnostics are surfaced");
  assert.ok(!JSON.stringify(catalog).includes(secret), "no key bytes are surfaced");
  assert.deepEqual(readdirSync(agentDir).sort(), ["models.json", "settings.json"], "no auth, lock, or model-store file is created");
  assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), settingsBytes);
  assert.equal(statSync(join(agentDir, "settings.json")).mtimeMs, before);
  assert.deepEqual(readdirSync(ambient), ["settings.json"]);

  // Native builtins come from the SDK's own definitions.
  const names = catalog.tools.map((tool) => tool.name);
  for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
    assert.ok(names.includes(builtin), `native builtin ${builtin} is offered from the SDK definition`);
  }
  assert.ok(catalog.tools.find((tool) => tool.name === "bash")!.description);

  // Forwarded --models parsed by Pi's own parser win over enabledModels.
  const explicit = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir, args: ["--models", "catalog-test/plain"] });
  assert.deepEqual(explicit.scoped.map((choice) => choice.model), ["catalog-test/plain"]);
  assert.deepEqual(explicit.modelScope, { source: "args", patterns: ["catalog-test/plain"] });
});
