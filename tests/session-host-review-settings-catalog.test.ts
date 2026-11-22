import assert from "node:assert/strict";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  enumerateOfflineToolCandidates,
  loadNativeWorkerToolCandidates,
  loadReviewSettingsChoices,
  MAX_SAVED_PROVIDER_CATALOG_BYTES,
  nativeBuiltinToolEntries,
  NativeWorkerToolCandidatesUnavailableError,
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
  // A corrupt saved catalog is irrelevant without a scope and is never read.
  writeFileSync(join(agentDir, "models-store.json"), "{ invalid JSON");
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

test("a long native scope diagnostic is passed on whole, never cut to a character limit", async (t) => {
  const agentDir = scratchDir(t);
  const pattern = `acme/${"ghost-".repeat(120)}unique-pattern-tail-7d2a`;
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: [pattern] }));
  const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => fakeSdk(newLog()) });
  assert.ok(pattern.length > 400, "longer than the former diagnostic cap");
  assert.deepEqual(catalog.warnings, [`No models match pattern "${pattern}"`]);
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

interface SavedCatalogProviderLog {
  contexts: Array<Record<string, any>>;
  persistRefused: boolean[];
}

/** A complete synthetic saved record in Pi's native model shape. */
function savedModel(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    provider: "acme",
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  };
}

/**
 * A structural fake of a registered dynamic provider following pi-ai's public
 * `refreshModels` contract: restore `context.stored` through `publish`, and
 * (to probe the boundary) also request persistence of a rewritten entry.
 */
function dynamicProvider(id: string, log: SavedCatalogProviderLog, options: { refreshThrows?: boolean; composeThrowsOn?: string } = {}) {
  let dynamic: FakeModel[] = [];
  return {
    id,
    baseUrl: "https://example.invalid",
    getModels: () => {
      if (options.composeThrowsOn && dynamic.some((model) => model.id === options.composeThrowsOn)) {
        throw new Error("composition failed on \"SENTINEL-SECRET-BYTES\"");
      }
      return [...MODELS.filter((model) => model.provider === id), ...dynamic];
    },
    async refreshModels(context: Record<string, any>) {
      log.contexts.push(context);
      if (options.refreshThrows) throw new Error(`restore failed "SENTINEL-SECRET-BYTES"`);
      const restored = (context.stored?.models ?? []).filter((model: FakeModel) => model.provider === id);
      if (!(await context.publish({ update: () => { dynamic = restored; } }))) return;
      // Persisting is never this catalog's job: the coupled update must not apply.
      const applied = await context.publish({ persist: { models: [] }, update: () => { dynamic = []; } });
      log.persistRefused.push(applied === false);
    },
  };
}

function fakeSdkWithProviders(log: FakeSdkLog, providers: unknown[]): Record<string, unknown> {
  return fakeSdk(log, {
    ModelRuntime: {
      async create(options: Record<string, any>) {
        log.createOptions = options;
        return {
          getProviders: () => providers,
          // Like pi-ai's collection accessor: per provider, a throwing provider yields nothing.
          getModels: (providerId?: string) => providers
            .filter((provider) => providerId === undefined || (provider as { id: string }).id === providerId)
            .flatMap((provider) => {
              try {
                return (provider as { getModels(): FakeModel[] }).getModels();
              } catch {
                return [];
              }
            }),
          getAvailable: async () => { log.realGetAvailableCalls += 1; throw new Error("real getAvailable must never be called"); },
          refresh: async () => { throw new Error("ModelRuntime.refresh must never be called"); },
          checkAuth: async () => { throw new Error("checkAuth must never be called"); },
          getError: () => undefined,
        };
      },
    },
  });
}

test("saved provider catalog: offline restore through the public provider hook, read-only, scoped-only", async (t) => {
  const agentDir = scratchDir(t);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/cached:low", "acme/flat"] }));
  const storeBytes = `﻿${JSON.stringify({
    acme: {
      models: [
        savedModel("cached", { reasoning: true }),
        savedModel("unscoped"),
        savedModel("future-kind", { type: "hologram" }),
        savedModel("foreign", { provider: "elsewhere" }),
      ],
      lastModified: 1,
      checkedAt: 2,
    },
    unregistered: { models: [{ provider: "unregistered", id: "x" }] },
  })}`;
  writeFileSync(join(agentDir, "models-store.json"), storeBytes);
  const providerLog: SavedCatalogProviderLog = { contexts: [], persistRefused: [] };
  const log = newLog();
  const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, {
    loadSdk: () => fakeSdkWithProviders(log, [dynamicProvider("acme", providerLog), { id: "static-only", getModels: () => [] }]),
  });

  assert.equal(log.createOptions!.refreshOnCreate, false, "the runtime itself is never refreshed");
  assert.equal(await log.createOptions!.modelsStore.read("acme"), undefined, "the runtime's own store stays empty");
  assert.equal(log.realGetAvailableCalls, 0);
  assert.equal(providerLog.contexts.length, 1, "only the registered provider with a saved entry is restored");
  const context = providerLog.contexts[0]!;
  assert.equal(context.allowNetwork, false);
  assert.equal(context.credential, undefined, "no credential is read or handed over");
  assert.equal(context.force, undefined);
  assert.equal(context.baseUrl, "https://example.invalid");
  assert.ok(context.signal instanceof AbortSignal);
  assert.ok(Object.isFrozen(context.stored) && Object.isFrozen(context.stored.models), "the stored snapshot is immutable");
  assert.deepEqual(context.stored.models.map((model: FakeModel) => model.id), ["cached", "unscoped", "foreign"],
    "unknown model types are dropped as pi-ai drops them before restore");
  assert.equal(context.stored.lastModified, 1, "freshness metadata reaches the provider unchanged");
  assert.deepEqual(providerLog.persistRefused, [true], "a persisting publication is refused and its update not applied");

  assert.deepEqual(catalog.scoped.map((choice) => [choice.model, choice.pinnedThinkingLevel]), [["acme/cached", "low"], ["acme/flat", undefined]]);
  assert.ok(!catalog.scoped.some((choice) => choice.model === "acme/unscoped"), "unscoped saved models are never offered");
  assert.deepEqual(catalog.warnings, []);
  assert.equal(readFileSync(join(agentDir, "models-store.json"), "utf8"), storeBytes, "the saved catalog is unchanged");
  assert.deepEqual(readdirSync(agentDir).sort(), ["models-store.json", "settings.json"], "no lock or other file is created");

  // Each open re-reads the file: removing a saved model removes the choice.
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ acme: { models: [] } }));
  const reopened = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, {
    loadSdk: () => fakeSdkWithProviders(newLog(), [dynamicProvider("acme", { contexts: [], persistRefused: [] })]),
  });
  assert.deepEqual(reopened.scoped.map((choice) => choice.model), ["acme/flat"]);
  assert.deepEqual(reopened.warnings, ['No models match pattern "acme/cached:low"']);
});

test("saved provider catalog: absent, unusable, or failing entries never block the static catalog", async (t) => {
  const agentDir = scratchDir(t);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/flat", "acme/cached"] }));
  const open = async (providerOptions: { refreshThrows?: boolean } = {}) => {
    const providerLog: SavedCatalogProviderLog = { contexts: [], persistRefused: [] };
    const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, {
      loadSdk: () => fakeSdkWithProviders(newLog(), [dynamicProvider("acme", providerLog, providerOptions)]),
    });
    assert.deepEqual(catalog.scoped.map((choice) => choice.model), ["acme/flat"], "static choices stay offered");
    assert.ok(!JSON.stringify(catalog).includes("SENTINEL-SECRET-BYTES"), "no file or error bytes are quoted");
    return { catalog, providerLog };
  };
  const noMatch = 'No models match pattern "acme/cached"';

  const absent = await open();
  assert.deepEqual(absent.catalog.warnings, [noMatch], "an absent saved catalog is silent");
  assert.equal(absent.providerLog.contexts.length, 0);

  writeFileSync(join(agentDir, "models-store.json"), `{"acme": SENTINEL-SECRET-BYTES`);
  const corrupt = await open();
  assert.equal(corrupt.providerLog.contexts.length, 0);
  assert.deepEqual(corrupt.catalog.warnings.filter((warning) => warning !== noMatch).length, 1);
  assert.ok(corrupt.catalog.warnings.some((warning) => /saved provider catalog could not be read/.test(warning)));

  for (const bytes of ["[]", "\"SENTINEL-SECRET-BYTES\""]) {
    writeFileSync(join(agentDir, "models-store.json"), bytes);
    const malformed = await open();
    assert.ok(malformed.catalog.warnings.some((warning) => /saved provider catalog is malformed/.test(warning)));
  }

  for (const entry of [{ models: "SENTINEL-SECRET-BYTES" }, { models: [], lastModified: "soon" }, ["SENTINEL-SECRET-BYTES"]]) {
    writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ acme: entry }));
    const badEntry = await open();
    assert.equal(badEntry.providerLog.contexts.length, 0, "a malformed entry is never handed to the provider");
    assert.ok(badEntry.catalog.warnings.some((warning) => /entries in Pi's saved provider catalog are malformed/.test(warning)));
  }

  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ acme: { models: [savedModel("cached")] } }));
  const failing = await open({ refreshThrows: true });
  assert.ok(failing.catalog.warnings.some((warning) => /could not restore some saved provider catalogs/.test(warning)));

  rmSync(join(agentDir, "models-store.json"));
  mkdirSync(join(agentDir, "models-store.json"));
  const directory = await open();
  assert.ok(directory.catalog.warnings.some((warning) => /not a regular file/.test(warning)));
});

test("saved provider catalog: symlinked or oversized files are refused before any read; static choices stay", async (t) => {
  const agentDir = scratchDir(t);
  const external = scratchDir(t);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/flat", "acme/cached"] }));
  const externalCatalog = join(external, "synthetic-catalog.json");
  writeFileSync(externalCatalog, JSON.stringify({ acme: { models: [savedModel("cached")] } }));
  symlinkSync(externalCatalog, join(agentDir, "models-store.json"));
  const open = async () => {
    const providerLog: SavedCatalogProviderLog = { contexts: [], persistRefused: [] };
    const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, {
      loadSdk: () => fakeSdkWithProviders(newLog(), [dynamicProvider("acme", providerLog)]),
    });
    assert.equal(providerLog.contexts.length, 0, "nothing reaches the provider");
    assert.deepEqual(catalog.scoped.map((choice) => choice.model), ["acme/flat"]);
    return catalog;
  };
  const linked = await open();
  assert.ok(linked.warnings.some((warning) => /saved provider catalog is not a regular file/.test(warning)), "a symlink is never followed");

  rmSync(join(agentDir, "models-store.json"));
  // A sparse file past the bound: refused from its size, never read.
  const fd = openSync(join(agentDir, "models-store.json"), "w");
  try {
    ftruncateSync(fd, MAX_SAVED_PROVIDER_CATALOG_BYTES + 1);
  } finally {
    closeSync(fd);
  }
  const oversized = await open();
  assert.ok(oversized.warnings.some((warning) => /exceeds the catalog read bound/.test(warning)));
});

test("saved provider catalog: malformed records skip the entry; non-chat models never become choices; resolver failures fall back", async (t) => {
  const agentDir = scratchDir(t);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/flat", "acme/cached", "acme/picture"] }));
  const open = async (resolverOverride?: Record<string, unknown>) => {
    const providerLog: SavedCatalogProviderLog = { contexts: [], persistRefused: [] };
    let creations = 0;
    const base = fakeSdkWithProviders(newLog(), [dynamicProvider("acme", providerLog)]);
    const sdk = {
      ...base,
      ModelRuntime: {
        async create(options: Record<string, any>) {
          creations += 1;
          // A fallback runtime gets fresh, unrestored providers.
          if (creations > 1) {
            const fresh = [dynamicProvider("acme", { contexts: [], persistRefused: [] })];
            return { getProviders: () => fresh, getModels: () => fresh.flatMap((provider) => provider.getModels()), getError: () => undefined };
          }
          return (base.ModelRuntime as { create(options: unknown): Promise<unknown> }).create(options);
        },
      },
      ...resolverOverride,
    };
    const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, { loadSdk: () => sdk });
    assert.ok(!JSON.stringify(catalog).includes("SENTINEL-SECRET-BYTES"));
    return { catalog, providerLog, creations };
  };

  const incomplete = [{ name: undefined }, { api: undefined }, { baseUrl: undefined }, { reasoning: undefined }, { cost: undefined },
    { cost: { input: 0 } }, { input: undefined }, { contextWindow: undefined }, { maxTokens: undefined }];
  for (const bad of [{ name: 7 }, { reasoning: "yes" }, { thinkingLevelMap: { high: 3 } }, { cost: "free" }, { input: "text" }, { id: "" }, ...incomplete]) {
    writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
      acme: { models: [savedModel("cached"), savedModel("other", { ...bad, note: "SENTINEL-SECRET-BYTES" })] },
    }));
    const { catalog, providerLog } = await open();
    assert.equal(providerLog.contexts.length, 0, `a malformed record (${Object.keys(bad)[0]}) is never published`);
    assert.deepEqual(catalog.scoped.map((choice) => choice.model), ["acme/flat"]);
    assert.ok(catalog.warnings.some((warning) => /entries in Pi's saved provider catalog are malformed/.test(warning)));
  }

  // A provider whose restored list is not chat-only: only chat entries reach Pi's resolver.
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    // Image records natively carry no reasoning/contextWindow/maxTokens and stay well-formed.
    acme: { models: [
      savedModel("cached", { type: "chat" }),
      savedModel("picture", { type: "image", reasoning: undefined, contextWindow: undefined, maxTokens: undefined }),
    ] },
  }));
  const chatOnly = await open();
  assert.deepEqual(chatOnly.catalog.scoped.map((choice) => choice.model), ["acme/flat", "acme/cached"]);
  assert.ok(chatOnly.catalog.warnings.includes('No models match pattern "acme/picture"'));

  // A restored catalog the native resolver still rejects: resolve again without it.
  const rejecting = await open({
    async resolveModelScopeWithDiagnostics(patterns: string[], runtime: { getAvailable(): Promise<FakeModel[]> }) {
      const available = await runtime.getAvailable();
      if (available.some((model) => model.id === "cached")) throw new Error("matcher failed on \"SENTINEL-SECRET-BYTES\"");
      return { scopedModels: available.filter((model) => patterns.includes(`${model.provider}/${model.id}`)).map((model) => ({ model })), diagnostics: [] };
    },
  });
  assert.equal(rejecting.creations, 2, "a fresh unrestored runtime is built for the fallback");
  assert.deepEqual(rejecting.catalog.scoped.map((choice) => choice.model), ["acme/flat"]);
  assert.ok(rejecting.catalog.warnings.some((warning) => /could not use its saved provider catalogs/.test(warning)));
});

test("saved provider catalog: a restore that breaks one provider's composition keeps its pre-restore list only", async (t) => {
  const agentDir = scratchDir(t);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["acme/flat", "acme/cached", "beta/fresh"] }));
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    acme: { models: [savedModel("cached")] },
    beta: { models: [savedModel("fresh", { provider: "beta" })] },
  }));
  const catalog = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir }, {
    loadSdk: () => fakeSdkWithProviders(newLog(), [
      dynamicProvider("acme", { contexts: [], persistRefused: [] }, { composeThrowsOn: "cached" }),
      dynamicProvider("beta", { contexts: [], persistRefused: [] }),
    ]),
  });
  assert.deepEqual(catalog.scoped.map((choice) => choice.model), ["acme/flat", "beta/fresh"],
    "the broken provider keeps its static choices; the other provider keeps its restore");
  assert.ok(catalog.warnings.some((warning) => /could not restore some saved provider catalogs/.test(warning)));
  assert.ok(catalog.warnings.includes('No models match pattern "acme/cached"'));
  assert.ok(!JSON.stringify(catalog).includes("SENTINEL-SECRET-BYTES"));
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

/** The sidebar's public tool entries reduced from an admission result (provenance dropped). */
function sidebarView(candidates: readonly { name: string; description?: string }[]): Array<{ name: string; description?: string }> {
  return candidates.map(({ name, description }) => (description === undefined ? { name } : { name, description }));
}

test("worker admission source (#682): exact sidebar coverage from the one shared enumerator", async (t) => {
  const workspace = scratchDir(t);
  const sidebar = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir: workspace }, { loadSdk: () => fakeSdk(newLog()) });
  const admission = loadNativeWorkerToolCandidates({ piExecutable: PI_EXECUTABLE, cwd: workspace }, { loadSdk: () => fakeSdk(newLog()) });
  assert.deepEqual(sidebarView(admission), sidebar.tools, "identical names, order, and descriptions");
  assert.deepEqual(sidebarView(enumerateOfflineToolCandidates(fakeSdk(newLog()), workspace).candidates), sidebar.tools);

  // Provenance distinguishes SDK-evidenced builtins from canonical and shipped names.
  const sourcesOf = (name: string) => admission.find((candidate) => candidate.name === name)?.sources;
  assert.deepEqual(sourcesOf("read"), ["native-builtin"]);
  assert.deepEqual(sourcesOf("bash"), ["native-builtin"]);
  assert.deepEqual(sourcesOf(CODEMODE_TOOL_NAME), ["native-codemode"]);
  assert.deepEqual(sourcesOf(DEFERRED_TOOL_SEARCH_NAME), ["reserved-discovery-loader"]);
  for (const name of shippedReviewGateToolNames().filter((shipped) => shipped !== DEFERRED_TOOL_SEARCH_NAME)) {
    assert.deepEqual(sourcesOf(name), ["review-gate-registration"], `${name} is a shipped registration, not a native builtin`);
  }

  // Nothing beyond the canonical sources: no saved, retained, dynamic, or guessed names.
  const allowed = new Set(["read", "bash", CODEMODE_TOOL_NAME, ...shippedReviewGateToolNames()]);
  assert.deepEqual(admission.filter((candidate) => !allowed.has(candidate.name)), []);
  for (const candidate of admission) {
    assert.deepEqual(Object.keys(candidate).filter((key) => !["name", "description", "sources"].includes(key)), [],
      "no availability, activation, or authorization claims");
  }
  assert.ok(Object.isFrozen(admission) && admission.every((candidate) => Object.isFrozen(candidate) && Object.isFrozen(candidate.sources)));
});

test("worker admission source (#682): a native name colliding with a shipped name keeps both origins", async (t) => {
  const workspace = scratchDir(t);
  const overrides = {
    createToolSearchToolDefinition: () => ({ name: DEFERRED_TOOL_SEARCH_NAME, description: "Native loader." }),
    createCodemodeToolDefinition: () => ({ name: CODEMODE_TOOL_NAME, description: "Native codemode." }),
  };
  const admission = loadNativeWorkerToolCandidates({ piExecutable: PI_EXECUTABLE, cwd: workspace }, { loadSdk: () => fakeSdk(newLog(), overrides) });
  const loader = admission.find((candidate) => candidate.name === DEFERRED_TOOL_SEARCH_NAME)!;
  assert.deepEqual(loader.sources, ["native-builtin", "reserved-discovery-loader"], "the reserved loader is never mistaken for a plain builtin");
  assert.equal(loader.description, "Native loader.");
  assert.deepEqual(admission.find((candidate) => candidate.name === CODEMODE_TOOL_NAME)!.sources, ["native-builtin", "native-codemode"]);
  const sidebar = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir: workspace }, { loadSdk: () => fakeSdk(newLog(), overrides) });
  assert.deepEqual(sidebarView(admission), sidebar.tools, "the sidebar keeps first-native descriptions exactly as before");
});

test("worker admission source (#682): tool-only — no model catalog, settings, args, or definition execution", () => {
  const touched: string[] = [];
  const forbidden = () => { throw new Error("tool-only admission must not reach this SDK surface"); };
  const base = fakeSdk(newLog(), {
    ModelRuntime: { create: forbidden },
    SettingsManager: { fromStorage: forbidden },
    parseArgs: forbidden,
    resolveModelScopeWithDiagnostics: forbidden,
    createReadToolDefinition: (cwd: string) => ({ name: "read", description: `Read files. cwd=${cwd}`, execute: forbidden }),
  });
  const sdk = new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === "string") touched.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  let loadedWith: unknown[] = [];
  const admission = loadNativeWorkerToolCandidates(
    { piExecutable: PI_EXECUTABLE, cwd: "/work/tree", expectedPiVersion: "1.6.0" },
    { loadSdk: (...args: unknown[]) => { loadedWith = args; return sdk; } },
  );
  assert.deepEqual(loadedWith, [PI_EXECUTABLE, "1.6.0"], "the owner's admitted Pi version binds the SDK resolution");
  assert.deepEqual([...new Set(touched)].sort(), ["createBashToolDefinition", "createReadToolDefinition"],
    "only native tool definition factories are read");
  assert.equal(admission.find((candidate) => candidate.name === "read")!.description, "Read files. cwd=/work/tree");
});

test("worker admission source (#682): fails closed where the sidebar degrades", async (t) => {
  const workspace = scratchDir(t);
  const unavailable = (input: Parameters<typeof loadNativeWorkerToolCandidates>[0], loadSdk: () => unknown, pattern: RegExp) =>
    assert.throws(
      () => loadNativeWorkerToolCandidates(input, { loadSdk: loadSdk as () => Record<string, unknown> }),
      (error: unknown) => error instanceof NativeWorkerToolCandidatesUnavailableError && pattern.test(error.message),
    );
  const input = { piExecutable: PI_EXECUTABLE, cwd: workspace };
  unavailable(input, () => { throw new Error("no official package"); }, /unavailable for worker tool admission: no official package/);
  unavailable(input, () => undefined, /did not load a module/);
  const noNative = () => fakeSdk(newLog(), { createReadToolDefinition: undefined, createBashToolDefinition: () => ({ name: " bad" }) });
  unavailable(input, noNative, /no native builtin tool definitions/);
  unavailable({ piExecutable: "pi", cwd: workspace }, () => fakeSdk(newLog()), /executable must be an absolute path/);
  unavailable({ piExecutable: PI_EXECUTABLE, cwd: "relative" }, () => fakeSdk(newLog()), /workspace must be an absolute path/);
  unavailable({ piExecutable: PI_EXECUTABLE, cwd: workspace, expectedPiVersion: "" }, () => fakeSdk(newLog()), /admitted Pi version/);

  // The sidebar keeps its existing degraded result and warning for the same SDK.
  const sidebar = await loadReviewSettingsChoices({ piExecutable: PI_EXECUTABLE, agentDir: workspace }, { loadSdk: noNative });
  assert.ok(sidebar.tools.some((tool) => tool.name === CODEMODE_TOOL_NAME));
  assert.ok(sidebar.warnings.some((warning) => /native builtin tool/.test(warning)));
  assert.equal(enumerateOfflineToolCandidates(noNative(), workspace).nativeBuiltinsDiscovered, false);
});

/** The installed official Pi package matching the pinned UI runtime version. */
function installedPi(t: TestContext): { packageDir: string; cli: string } | undefined {
  for (const packageDir of findInstalledAgentDirs()) {
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string; bin?: Record<string, string> };
      const bin = manifest.bin?.pi;
      if (manifest.version === "1.6.0" && typeof bin === "string" && existsSync(join(packageDir, bin))) {
        return { packageDir, cli: join(packageDir, bin) };
      }
    } catch {
      // try the next install
    }
  }
  skipOrFail(t, "no installed Pi 1.6.0 for the standalone settings catalog");
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

  // The tool-only admission source (#682) matches the sidebar over the real SDK
  // and creates nothing in the agent directory or the workspace.
  const workspace = scratchDir(t);
  const admission = loadNativeWorkerToolCandidates({ piExecutable: pi.cli, cwd: agentDir, expectedPiVersion: "1.6.0" });
  assert.deepEqual(sidebarView(admission), catalog.tools);
  for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
    assert.ok(admission.find((candidate) => candidate.name === builtin)!.sources.includes("native-builtin"));
  }
  loadNativeWorkerToolCandidates({ piExecutable: pi.cli, cwd: workspace });
  assert.deepEqual(readdirSync(workspace), []);
  assert.deepEqual(readdirSync(agentDir).sort(), ["models.json", "settings.json"]);
  assert.throws(
    () => loadNativeWorkerToolCandidates({ piExecutable: pi.cli, cwd: workspace, expectedPiVersion: "1.5.0" }),
    NativeWorkerToolCandidatesUnavailableError,
    "a version other than the owner's admitted one fails closed",
  );
});

/** A synthetic Codex chat model in Pi's native saved-catalog shape (never a real provider id). */
function syntheticCodexModel(id: string): Record<string, unknown> {
  return {
    id,
    name: `Synthetic ${id}`,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.invalid/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    type: "chat",
  };
}

test("installed Pi SDK: a scoped Codex model only in Pi's saved provider catalog is offered, offline and read-only", async (t) => {
  const pi = installedPi(t);
  if (!pi) return;
  const agentDir = scratchDir(t);
  const tripwireDir = scratchDir(t);
  const tripwire = join(tripwireDir, "shell-ran");
  const secret = "SENTINEL_SECRET_KEY_BYTES";
  // Command-backed keys on a custom provider AND on a models.json overlay of
  // the Codex provider itself: any auth resolution would run the shell.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "catalog-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: `!touch ${tripwire} && echo ${secret}`,
        models: [{ id: "plain" }],
      },
      "openai-codex": {
        apiKey: `!touch ${tripwire} && echo ${secret}`,
        // models.json overrides stay the topmost layer over a restored model.
        modelOverrides: { "gpt-synthetic-cache-sol": { thinkingLevelMap: { max: null } } },
      },
    },
  }));
  const cachedId = "gpt-synthetic-cache-sol";
  const settingsBytes = JSON.stringify({ enabledModels: [`openai-codex/${cachedId}:high`, "catalog-test/plain"] });
  writeFileSync(join(agentDir, "settings.json"), settingsBytes);
  const writeStore = (lastModified: number) => {
    const bytes = JSON.stringify({
      "openai-codex": {
        models: [syntheticCodexModel(cachedId), syntheticCodexModel("gpt-synthetic-unscoped")],
        lastModified,
        checkedAt: lastModified,
        etag: "\"synthetic\"",
      },
      "never-registered": { models: [{ id: "x", provider: "never-registered" }] },
    }, null, 2);
    writeFileSync(join(agentDir, "models-store.json"), bytes);
    return bytes;
  };
  const storeBytes = writeStore(Date.now());
  const storeMtime = statSync(join(agentDir, "models-store.json")).mtimeMs;

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("the settings catalog must never fetch"); }) as typeof fetch;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const ambient = scratchDir(t);
  process.env.PI_CODING_AGENT_DIR = ambient;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const catalog = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(catalog.scoped, [
    {
      model: `openai-codex/${cachedId}`,
      label: `${cachedId} [openai-codex]`,
      pinnedThinkingLevel: "high",
      // Native reasoning metadata from the saved entry, minus the overridden `max`.
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    },
    { model: "catalog-test/plain", label: "plain [catalog-test]", pinnedThinkingLevel: undefined, supportedThinkingLevels: ["off"] },
  ]);
  assert.ok(!catalog.scoped.some((choice) => choice.model.includes("unscoped")), "unscoped saved models are never offered");
  assert.deepEqual(catalog.warnings, []);
  assert.equal(fetchCalls, 0, "no network request");
  assert.equal(existsSync(tripwire), false, "no auth command ran");
  assert.ok(!JSON.stringify(catalog).includes(secret));
  assert.equal(readFileSync(join(agentDir, "models-store.json"), "utf8"), storeBytes, "the saved catalog is unchanged");
  assert.equal(statSync(join(agentDir, "models-store.json")).mtimeMs, storeMtime);
  assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), settingsBytes);
  assert.deepEqual(readdirSync(agentDir).sort(), ["models-store.json", "models.json", "settings.json"], "no auth, lock, or new store file");
  assert.deepEqual(readdirSync(ambient), [], "the ambient agent dir is never consulted or written");

  // Pi's native freshness: an overlay not newer than the bundled data is ignored.
  writeStore(0);
  const stale = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(stale.scoped.map((choice) => choice.model), ["catalog-test/plain"]);
  assert.ok(stale.warnings.some((warning) => warning.includes(`openai-codex/${cachedId}`)), "the native no-match diagnostic stays truthful");

  // Absent and unusable saved catalogs fall back to the static catalog.
  rmSync(join(agentDir, "models-store.json"));
  const absent = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(absent.scoped.map((choice) => choice.model), ["catalog-test/plain"]);
  assert.deepEqual(readdirSync(agentDir).sort(), ["models.json", "settings.json"], "no store file is created when absent");
  writeFileSync(join(agentDir, "models-store.json"), "{ not json");
  const corrupt = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(corrupt.scoped.map((choice) => choice.model), ["catalog-test/plain"]);
  assert.ok(corrupt.warnings.some((warning) => /saved provider catalog could not be read/.test(warning)));
  assert.equal(fetchCalls, 0);
  assert.equal(existsSync(tripwire), false);
});

test("installed Pi SDK: malformed saved records and non-chat saved models never break or pollute the choices", async (t) => {
  const pi = installedPi(t);
  if (!pi) return;
  const agentDir = scratchDir(t);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "catalog-test": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "literal-unused", models: [{ id: "plain" }] },
      "openai-codex": { modelOverrides: { "gpt-synthetic-no-cost": { cost: { input: 1 } } } },
    },
  }));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("the settings catalog must never fetch"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // A fresh Codex record whose `name` is not text, plus a fuzzy pattern ("pla")
  // that makes Pi's matcher read every candidate's name.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["pla", "openai-codex/gpt-synthetic-cache-sol"] }));
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    "openai-codex": {
      models: [syntheticCodexModel("gpt-synthetic-cache-sol"), { ...syntheticCodexModel("gpt-synthetic-bad"), name: 42, note: "SENTINEL_CACHE_BYTES" }],
      lastModified: Date.now(),
      checkedAt: Date.now(),
    },
  }));
  const malformed = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(malformed.scoped.map((choice) => choice.model), ["catalog-test/plain"], "the valid custom choice survives");
  assert.ok(malformed.warnings.some((warning) => /entries in Pi's saved provider catalog are malformed/.test(warning)));
  assert.ok(malformed.warnings.some((warning) => warning.includes("openai-codex/gpt-synthetic-cache-sol")), "the skipped entry's model is honestly unmatched");
  assert.ok(!JSON.stringify(malformed).includes("SENTINEL_CACHE_BYTES"), "cache contents are never quoted");

  // A fresh saved record missing `cost` while models.json overrides its cost:
  // publishing it would make Pi's composed Codex provider throw, and pi-ai
  // would silently drop every built-in Codex model with it.
  const incomplete = syntheticCodexModel("gpt-synthetic-no-cost");
  delete incomplete.cost;
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    enabledModels: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-synthetic-no-cost", "catalog-test/plain"],
  }));
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    "openai-codex": { models: [incomplete], lastModified: Date.now() },
  }));
  const missingCost = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(missingCost.scoped.map((choice) => choice.model), ["openai-codex/gpt-6.1-sol", "catalog-test/plain"],
    "the built-in Codex and unrelated custom choices survive");
  assert.ok(missingCost.warnings.some((warning) => /entries in Pi's saved provider catalog are malformed/.test(warning)));

  // Radius returns its restored list as-is: a saved image model must not become a chat choice.
  const radiusModel = (id: string, type: string) => ({
    id,
    name: id,
    api: "pi-messages",
    provider: "radius",
    baseUrl: "https://radius.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    type,
  });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["radius/synthetic-radius-chat", "radius/synthetic-radius-image"] }));
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    radius: { models: [radiusModel("synthetic-radius-chat", "chat"), radiusModel("synthetic-radius-image", "image")], checkedAt: Date.now() },
  }));
  const radius = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(radius.scoped.map((choice) => choice.model), ["radius/synthetic-radius-chat"]);
  assert.ok(radius.warnings.some((warning) => warning.includes("radius/synthetic-radius-image")), "the non-chat model is unmatched, not offered");

  // A well-typed saved record (empty baseUrl) that makes Pi's models.json
  // composition throw: Pi's collection accessor would silently drop the whole
  // Codex provider. Only that provider falls back to its pre-restore list;
  // the Radius restore is kept.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "openai-codex": { models: [{ id: "gpt-6.1-sol" }, { id: "custom-codex" }] } },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    enabledModels: ["openai-codex/gpt-6.1-sol", "openai-codex/custom-codex", "radius/synthetic-radius-chat"],
  }));
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    "openai-codex": { models: [{ ...syntheticCodexModel("gpt-6.1-sol"), baseUrl: "" }], lastModified: Date.now() },
    radius: { models: [radiusModel("synthetic-radius-chat", "chat")] },
  }));
  const brokenComposition = await loadReviewSettingsChoices({ piExecutable: pi.cli, agentDir });
  assert.deepEqual(brokenComposition.scoped.map((choice) => choice.model), [
    "openai-codex/gpt-6.1-sol",
    "openai-codex/custom-codex",
    "radius/synthetic-radius-chat",
  ]);
  assert.ok(brokenComposition.warnings.some((warning) => /could not restore some saved provider catalogs/.test(warning)));
  assert.equal(fetchCalls, 0);
  assert.deepEqual(readdirSync(agentDir).sort(), ["models-store.json", "models.json", "settings.json"]);
});
