/**
 * Issue #653: the session host's LOCAL review-settings composition service.
 *
 * openLocalReviewSettings performs a FRESH disk load on every open through the
 * real loadConfig resolution (explicit absolute override, Pi-native default,
 * sole compatibility fallback), opens the shared disk-only settings
 * transaction (runPersistedReviewSettings) with the metadata catalog's shared
 * choices, and never touches a live session config, onSaved, pending delta, or
 * scheduler runtime. First use publishes the canonical file only on explicit
 * Save through the existing guarded native initializer.
 *
 * Every HOME, agent dir, and config here is synthetic and lives in a fresh
 * temporary directory; the catalog is injected (one test drives the real
 * catalog builder over a fake public SDK). No real config, session, network,
 * or provider is used.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Module from "node:module";
import { effectiveReviewSettings, loadConfig, normalizeConfig, type ReviewGateConfig } from "../src/config";
import type { UiContext } from "../src/settings/ui";
import type { PersistedReviewSettingsInput } from "../src/settings/command";
import type { ReviewSettingsCatalog, ReviewSettingsCatalogInput } from "../src/session-host/review-settings-catalog";

const calls = {
  runInputs: [] as PersistedReviewSettingsInput[],
  replaceConfig: 0,
  pendingDelta: 0,
};

const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request, ...args) {
  const real = originalLoad.call(this, request, ...args) as Record<string, unknown>;
  if (request === "../settings/command") {
    const command = real as typeof import("../src/settings/command");
    return {
      ...command,
      runPersistedReviewSettings: (input: PersistedReviewSettingsInput) => {
        calls.runInputs.push(input);
        return command.runPersistedReviewSettings(input);
      },
    };
  }
  if (request === "./persistence") {
    const persistence = real as typeof import("../src/settings/persistence");
    return {
      ...persistence,
      replaceConfig: (...rest: Parameters<typeof persistence.replaceConfig>) => {
        calls.replaceConfig += 1;
        return persistence.replaceConfig(...rest);
      },
    };
  }
  if (request === "./session-delta") {
    const delta = real as typeof import("../src/settings/session-delta");
    return {
      ...delta,
      getPendingSessionDelta: (config: ReviewGateConfig) => { calls.pendingDelta += 1; return delta.getPendingSessionDelta(config); },
      recordPendingSessionDelta: (...rest: Parameters<typeof delta.recordPendingSessionDelta>) => { calls.pendingDelta += 1; return delta.recordPendingSessionDelta(...rest); },
      clearPendingSessionDelta: (config: ReviewGateConfig) => { calls.pendingDelta += 1; return delta.clearPendingSessionDelta(config); },
    };
  }
  return real;
};
const { openLocalReviewSettings } = require("../src/session-host/review-settings") as typeof import("../src/session-host/review-settings");
const { registerReviewSettings } = require("../src/settings/command") as typeof import("../src/settings/command");
const { loadReviewSettingsChoices } = require("../src/session-host/review-settings-catalog") as typeof import("../src/session-host/review-settings-catalog");
const { DEFAULT_REVIEW_GATE_CONFIG_JSON } = require("../src/session-host/profiles") as typeof import("../src/session-host/profiles");

const PI_EXECUTABLE = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

/** A scripted selection: exact option or prefix, Escape (undefined), or a side effect before one. */
type Step = string | undefined | { before: () => void; then: string | undefined };

interface Scripted {
  ui: UiContext;
  notices: Array<{ message: string; kind: string }>;
  shown: Array<{ title: string; options: string[] }>;
  remaining(): number;
}

function scriptedUi(steps: Step[]): Scripted {
  const notices: Scripted["notices"] = [];
  const shown: Scripted["shown"] = [];
  let index = 0;
  const ui: UiContext = {
    select: async (title, options) => {
      shown.push({ title, options });
      assert.ok(index < steps.length, `unexpected extra selection: ${title}: ${options.join(" | ")}`);
      let step = steps[index++];
      if (typeof step === "object") {
        step.before();
        step = step.then;
      }
      if (step === undefined) return undefined;
      const match = options.find((option) => option === step) ?? options.find((option) => option.startsWith(step as string));
      assert.ok(match !== undefined, `missing selection ${step}: ${options.join(" | ")}`);
      return match;
    },
    editText: async () => { throw new Error("no text field expected"); },
    confirm: async () => false,
    notify: (message, kind) => { notices.push({ message, kind: kind ?? "info" }); },
  };
  return { ui, notices, shown, remaining: () => steps.length - index };
}

const TOOLS = Object.freeze([{ name: "bash", description: "Execute a command." }, { name: "read" }, { name: "tool_search" }]);

function fakeCatalog(): ReviewSettingsCatalog {
  return {
    scoped: [{ model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] }],
    tools: [...TOOLS],
    warnings: [],
    modelScope: { source: "enabledModels", patterns: ["acme/deep"] },
  };
}

interface Host {
  home: string;
  agentDir: string;
  canonical: string;
  fallback: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
  catalogs: ReviewSettingsCatalog[];
  catalogInputs: ReviewSettingsCatalogInput[];
  open(steps: Step[], overrides?: { env?: NodeJS.ProcessEnv; loadChoices?: (input: ReviewSettingsCatalogInput) => Promise<ReviewSettingsCatalog> }): Promise<Scripted>;
}

function host(t: TestContext): Host {
  const root = mkdtempSync(join(tmpdir(), "rs-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const agentDir = realpathSync(join(home, ".pi", "agent"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  const catalogs: ReviewSettingsCatalog[] = [];
  const catalogInputs: ReviewSettingsCatalogInput[] = [];
  const h: Host = {
    home,
    agentDir,
    canonical: join(agentDir, "review-gate.json"),
    fallback: join(home, ".config", "pi-review-gate", "config.json"),
    env,
    workspace,
    catalogs,
    catalogInputs,
    async open(steps, overrides = {}) {
      const scripted = scriptedUi(steps);
      calls.runInputs.length = 0;
      await openLocalReviewSettings({
        env: overrides.env ?? env,
        agentDir,
        piExecutable: PI_EXECUTABLE,
        args: ["--offline"],
        cwd: workspace,
        ui: scripted.ui,
      }, {
        loadChoices: overrides.loadChoices ?? (async (input) => {
          catalogInputs.push(input);
          const catalog = fakeCatalog();
          catalogs.push(catalog);
          return catalog;
        }),
      });
      assert.equal(scripted.remaining(), 0, "every scripted step was consumed");
      return scripted;
    },
  };
  return h;
}

function write(path: string, body: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  writeFileSync(path, text, "utf8");
  return text;
}

function assertNoErrors(notices: Scripted["notices"]): void {
  for (const notice of notices) assert.notEqual(notice.kind, "error", notice.message);
}

function rootOptions(scripted: Scripted): string[] {
  const root = scripted.shown.find((entry) => entry.title === "Review settings");
  assert.ok(root, "the shared root menu opened");
  return root.options;
}

const DISK_A = { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true }, operatingMode: "execute", unrelatedFutureField: { keep: true } };
const LIVE_B = { enabled: true, youShouldKnow: { enabled: false, completionGuidance: false }, operatingMode: "orchestrate" };
/** Stage C/D: toggle YouShouldKnow notices, back to the root. */
const TOGGLE_NOTICES: Step[] = ["Tools", "YouShouldKnow notices", undefined];

/** A live parent session B registered with its own effects, which the service must never reach. */
function liveParent(): { live: ReviewGateConfig; snapshot: ReviewGateConfig; effects: { onSaved: number; flips: number } } {
  const live = normalizeConfig(LIVE_B);
  const effects = { onSaved: 0, flips: 0 };
  registerReviewSettings({
    pi: { registerCommand() {} },
    config: live,
    configPath: "/nonexistent/parent-b.json",
    onSaved: () => { effects.onSaved += 1; },
    schedulerRuntime: { enabled: false, setEnabled() { effects.flips += 1; } },
  });
  return { live, snapshot: structuredClone(live), effects };
}

function resetSpies(): void {
  calls.replaceConfig = 0;
  calls.pendingDelta = 0;
}

function assertNoLiveEffects(parent: ReturnType<typeof liveParent>): void {
  assert.deepEqual(parent.live, parent.snapshot, "the live parent config B is untouched");
  assert.equal(parent.effects.onSaved, 0, "never calls onSaved");
  assert.equal(parent.effects.flips, 0, "never flips a scheduler runtime");
  assert.equal(calls.replaceConfig, 0, "never installs into a live config");
  assert.equal(calls.pendingDelta, 0, "never reads or records a pending session delta");
}

test("disk A under live parent B: shows A through the shared root, labels LOCAL with the absolute path, no Scheduler runtime", async (t) => {
  const h = host(t);
  const bytesA = write(h.canonical, DISK_A);
  const parent = liveParent();
  resetSpies();
  const scripted = await h.open(["Cancel"]);
  assertNoErrors(scripted.notices);
  const root = rootOptions(scripted);
  assert.ok(root.some((option) => option.startsWith("Operating mode") && option.includes("Prefer execution")), root.join(" | "));
  // Complete persisted root inventory, without the process scheduler switch.
  for (const label of ["Operating mode", "Mode cycle hotkey", "Worker resources", "External workers", "Execution priority",
    "Research priority", "Reviewers", "Timeouts", "Review policy", "Retention", "Global concurrency", "Retry policy",
    "Subtask notifications", "Tools", "Subtasks view", "Subtask task IDs", "Scheduled tasks", "Save changes", "Cancel"]) {
    assert.ok(root.some((option) => option.startsWith(label)), `root row ${label}`);
  }
  assert.ok(!root.some((option) => option.startsWith("Scheduler runtime")));
  const label = scripted.notices.find((notice) => notice.kind === "info" && /LOCAL/.test(notice.message));
  assert.ok(label && label.message.includes(h.canonical), "the LOCAL target names the absolute config path");
  assert.equal(scripted.ui.cwd, h.workspace, "the caller workspace anchors fields");
  assert.equal(readFileSync(h.canonical, "utf8"), bytesA);
  assert.deepEqual(h.catalogInputs, [{ piExecutable: PI_EXECUTABLE, agentDir: h.agentDir, args: ["--offline"] }]);
  assertNoLiveEffects(parent);
});

for (const exit of ["Cancel", "root Escape"] as const) {
  test(`staged C then ${exit}: disk keeps A bytes and C appears nowhere`, async (t) => {
    const h = host(t);
    const bytesA = write(h.canonical, DISK_A);
    const parent = liveParent();
    resetSpies();
    const before = readdirSync(h.agentDir);
    const scripted = await h.open([...TOGGLE_NOTICES, exit === "Cancel" ? "Cancel" : undefined]);
    assertNoErrors(scripted.notices);
    assert.equal(readFileSync(h.canonical, "utf8"), bytesA);
    assert.deepEqual(readdirSync(h.agentDir), before, "no other file was written");
    assert.ok(!existsSync(h.fallback));
    assert.equal(loadConfig({ ...h.env, PI_CODING_AGENT_DIR: h.agentDir }, { homeDir: h.home }).config.youShouldKnow?.enabled, true);
    assertNoLiveEffects(parent);
  });
}

test("Save D writes the disk only; parent B unchanged; another write E is seen on the next fresh open", async (t) => {
  const h = host(t);
  write(h.canonical, DISK_A);
  const parent = liveParent();
  resetSpies();
  const saved = await h.open([...TOGGLE_NOTICES, "Save changes"]);
  assertNoErrors(saved.notices);
  const fileD = JSON.parse(readFileSync(h.canonical, "utf8"));
  assert.deepEqual(fileD.youShouldKnow, { enabled: false, completionGuidance: true });
  assert.deepEqual(fileD.unrelatedFutureField, { keep: true }, "unrelated fields survive the shared persistence");
  assert.ok(saved.notices.some((notice) => /saved to disk/.test(notice.message)));
  assertNoLiveEffects(parent);

  // Another legitimate editor writes E; the next open re-reads the disk.
  write(h.canonical, { ...DISK_A, operatingMode: "plan-research" });
  const reopened = await h.open(["Cancel"]);
  assert.ok(rootOptions(reopened).some((option) => option.startsWith("Operating mode") && option.includes("Plan/research")));
  assert.equal(h.catalogs.length, 2, "each open loads its own catalog; nothing is cached");
});

test("shared catalog choices are passed through by reference, never duplicated", async (t) => {
  const h = host(t);
  write(h.canonical, DISK_A);
  await h.open(["Cancel"]);
  assert.equal(calls.runInputs.length, 1);
  const input = calls.runInputs[0]!;
  const catalog = h.catalogs[0]!;
  assert.equal(input.scoped, catalog.scoped);
  assert.equal(input.getToolChoices?.(), catalog.tools);
  assert.equal(input.getAuditedToolChoices?.(), catalog.tools);
  assert.equal(input.configPath, h.canonical);
  assert.equal(input.beforePersist, undefined, "an existing file is never initialized");
});

test("explicit absolute override wins over the native default; a missing explicit path is an error and never created", async (t) => {
  const h = host(t);
  const canonicalBytes = write(h.canonical, DISK_A);
  const explicit = join(h.home, "elsewhere", "explicit.json");
  write(explicit, { ...DISK_A, operatingMode: "orchestrate" });
  const env: NodeJS.ProcessEnv = { ...h.env, PI_REVIEW_GATE_CONFIG: explicit };
  const scripted = await h.open([...TOGGLE_NOTICES, "Save changes"], { env });
  assertNoErrors(scripted.notices);
  assert.ok(rootOptions(scripted).some((option) => option.includes("Prefer orchestration")));
  assert.equal(JSON.parse(readFileSync(explicit, "utf8")).youShouldKnow.enabled, false);
  assert.equal(readFileSync(h.canonical, "utf8"), canonicalBytes, "the native default is untouched");
  assert.equal(env.PI_CODING_AGENT_DIR, undefined, "the caller env is never mutated");

  const missing = join(h.home, "absent", "missing.json");
  const refused = await h.open([], { env: { ...h.env, PI_REVIEW_GATE_CONFIG: missing } });
  assert.equal(refused.shown.length, 0, "the editor does not open");
  assert.ok(refused.notices.some((notice) => notice.kind === "error" && notice.message.includes(missing)));
  assert.ok(!existsSync(join(h.home, "absent")), "nothing is created for a missing explicit path");
});

test("the sole compatibility fallback is edited in place and the canonical file is never created", async (t) => {
  const h = host(t);
  write(h.fallback, { ...DISK_A, operatingMode: "plan-research" });
  const scripted = await h.open([...TOGGLE_NOTICES, "Save changes"]);
  assertNoErrors(scripted.notices);
  assert.ok(rootOptions(scripted).some((option) => option.includes("Plan/research")));
  assert.equal(calls.runInputs[0]!.beforePersist, undefined);
  assert.equal(JSON.parse(readFileSync(h.fallback, "utf8")).youShouldKnow.enabled, false);
  assert.ok(!existsSync(h.canonical));
  assert.ok(scripted.notices.some((notice) => /LOCAL/.test(notice.message) && notice.message.includes(h.fallback)));
});

test("first use: defaults shown; Cancel and root Escape create nothing", async (t) => {
  const h = host(t);
  for (const exit of [["Cancel"], [undefined]] as Step[][]) {
    const scripted = await h.open([...TOGGLE_NOTICES, ...exit]);
    assertNoErrors(scripted.notices);
    assert.ok(scripted.notices.some((notice) => /No config exists yet/.test(notice.message) && notice.message.includes(h.canonical)));
    assert.deepEqual(readdirSync(h.agentDir), [], "no config, temporary, or managed directory is created");
    assert.ok(!existsSync(join(h.home, ".config")), "the compatibility fallback is never created");
  }
});

test("first use: explicit Save publishes the canonical file via the guarded initializer with the zero-model baseline plus D", async (t) => {
  const h = host(t);
  const scripted = await h.open([...TOGGLE_NOTICES, "Save changes"]);
  assertNoErrors(scripted.notices);
  const written = JSON.parse(readFileSync(h.canonical, "utf8"));
  const baseline = JSON.parse(DEFAULT_REVIEW_GATE_CONFIG_JSON);
  // Zero-model reviewers (the shared Save writes the split layer form).
  const review = effectiveReviewSettings(normalizeConfig(written));
  assert.deepEqual([review.primaryReviewers, review.subtaskReviewers], [[], []]);
  assert.deepEqual(written.externalAgents, {});
  assert.deepEqual(written.execution.workerResources, {});
  assert.deepEqual(written.execution.routes, baseline.execution.routes);
  assert.equal(written.enabled, true);
  const baselineNotices = normalizeConfig(baseline).youShouldKnow?.enabled !== false;
  assert.equal(written.youShouldKnow.enabled, !baselineNotices, "the staged D change is persisted");
  if (process.platform !== "win32") assert.equal(statSync(h.canonical).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(h.agentDir), ["review-gate.json"], "no temporary file is left behind");
  assert.ok(!existsSync(h.fallback));
});

test("first use race: a config created by another editor before Save is preserved and merged by the existing guards", async (t) => {
  const h = host(t);
  const createdElsewhere = () => {
    write(h.canonical, { ...DISK_A, anotherEditorField: "kept" });
  };
  const scripted = await h.open(["Tools", "YouShouldKnow notices", { before: createdElsewhere, then: undefined }, "Save changes"]);
  assertNoErrors(scripted.notices);
  const written = JSON.parse(readFileSync(h.canonical, "utf8"));
  assert.deepEqual(written.unrelatedFutureField, { keep: true }, "the other editor's unknown field survives");
  assert.equal(written.anotherEditorField, "kept", "the existing file was never replaced by the default");
  // Fields the menu owns follow the existing stale-menu Save semantics.
  assert.equal(written.youShouldKnow.enabled, false);
});

test("first use race: a compatibility config appearing before Save fails closed without creating the canonical file", async (t) => {
  const h = host(t);
  let fallbackBytes = "";
  const scripted = await h.open([{ before: () => { fallbackBytes = write(h.fallback, DISK_A); }, then: "Save changes" }]);
  assert.ok(scripted.notices.some((notice) => notice.kind === "error" && /another review-gate config appeared/.test(notice.message) && /Reopen/.test(notice.message)));
  assert.equal(calls.runInputs.length, 1, "no automatic retry or second menu");
  assert.ok(!existsSync(h.canonical), "no primary is created to shadow the new fallback");
  assert.deepEqual(readdirSync(h.agentDir), [], "no temporary file is left behind");
  assert.equal(readFileSync(h.fallback, "utf8"), fallbackBytes, "the draft was never retargeted to the fallback");
  // The next open edits the fallback that now exists.
  const reopened = await h.open(["Cancel"]);
  assert.equal(calls.runInputs[0]!.configPath, h.fallback);
  assert.ok(reopened.notices.some((notice) => /LOCAL/.test(notice.message) && notice.message.includes(h.fallback)));
});

test("the review-gate kill switch keeps the editor unavailable", async (t) => {
  const h = host(t);
  write(h.canonical, DISK_A);
  const scripted = await h.open([], { env: { ...h.env, PI_REVIEW_GATE_DISABLED: "1" } });
  assert.equal(scripted.shown.length, 0);
  assert.ok(scripted.notices.some((notice) => notice.kind === "error" && /PI_REVIEW_GATE_DISABLED/.test(notice.message)));
});

test("unavailable catalog metadata is an explicit error; catalog warnings are shown", async (t) => {
  const h = host(t);
  write(h.canonical, DISK_A);
  const refused = await h.open([], { loadChoices: async () => { throw new Error("pi-review-gate: the installed Pi SDK is unavailable for the settings catalog"); } });
  assert.equal(refused.shown.length, 0);
  assert.ok(refused.notices.some((notice) => notice.kind === "error" && /SDK is unavailable/.test(notice.message)));
  const warned = await h.open(["Cancel"], { loadChoices: async () => ({ ...fakeCatalog(), warnings: ["Pi reported errors in models.json"] }) });
  assert.ok(warned.notices.some((notice) => notice.kind === "warning" && /models\.json/.test(notice.message)));
});

test("an unparseable config opens with the load warning and a Save failure never quotes its contents", async (t) => {
  const h = host(t);
  const bytes = write(h.canonical, "{ \"secretMarker-7f3a\": ");
  const scripted = await h.open([...TOGGLE_NOTICES, "Save changes"]);
  assert.ok(scripted.notices.some((notice) => notice.kind === "warning" && /could not be read or parsed/.test(notice.message)));
  assert.ok(scripted.notices.some((notice) => notice.kind === "error"));
  for (const notice of scripted.notices) assert.ok(!notice.message.includes("secretMarker"), notice.message);
  assert.equal(readFileSync(h.canonical, "utf8"), bytes);
});

test("integration: the real catalog builder over a fake public SDK feeds the shared menu", async (t) => {
  const h = host(t);
  write(h.canonical, DISK_A);
  write(join(h.agentDir, "settings.json"), { enabledModels: ["acme/deep"] });
  const sdk = {
    ModelRuntime: {
      async create() {
        return { getModels: () => [{ provider: "acme", id: "deep", reasoning: true }], getError: () => undefined };
      },
    },
    SettingsManager: {
      fromStorage(storage: { withLock(scope: string, fn: (current: string | undefined) => string | undefined): void }) {
        let content: string | undefined;
        storage.withLock("global", (current) => { content = current; return undefined; });
        const settings = content ? JSON.parse(content) : {};
        return { drainErrors: () => [], getEnabledModels: () => settings.enabledModels };
      },
    },
    parseArgs: () => ({}),
    async resolveModelScopeWithDiagnostics(patterns: string[], runtime: { getAvailable(): Promise<Array<{ provider: string; id: string }>> }) {
      const available = await runtime.getAvailable();
      return { scopedModels: available.filter((model) => patterns.includes(`${model.provider}/${model.id}`)).map((model) => ({ model })), diagnostics: [] };
    },
    createReadToolDefinition: () => ({ name: "read", description: "Read files." }),
  };
  const scripted = await h.open(["Cancel"], { loadChoices: (input) => loadReviewSettingsChoices(input, { loadSdk: () => sdk }) });
  assertNoErrors(scripted.notices);
  const input = calls.runInputs[0]!;
  assert.deepEqual(input.scoped.map((choice) => choice.model), ["acme/deep"]);
  const names = input.getToolChoices?.().map((entry) => entry.name) ?? [];
  assert.ok(names.includes("read") && names.includes("tool_search"));
});
