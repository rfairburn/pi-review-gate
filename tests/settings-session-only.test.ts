/**
 * Issue #294: session-only settings transactions.
 *
 * Root Escape validates and applies every staged review-gate setting to the
 * live config WITHOUT writing the persistent config; explicit Cancel preserves
 * the prior session state exactly (no apply, no copies); a later Save persists
 * all active edited choices, including earlier session-only choices made before
 * the menu reopened. The pending delta is baseline metadata keyed by live
 * config identity — never a mirror of the live config.
 *
 * Coverage here: the executor A → Escape B → Cancel C contract, the
 * external-agent deletion cascade and schedule deletion surviving
 * Escape → reopen → Save, explicitly edited alreadyRun surviving to Save,
 * pending-delta retention on failed Save and clearing on success, plus unit
 * tests for the new assembleStagedSelectionConfig and session-delta seams.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Module from "node:module";
import { externalAgentCatalog, normalizeConfig, type ExternalAgentConfig, type ReviewGateConfig } from "../src/config";
import * as realExternalAgents from "../src/settings/external-agents";
import { clearPendingSessionDelta, getPendingSessionDelta, recordPendingSessionDelta } from "../src/settings/session-delta";

// Test seams installed before the command module loads (issue #294 review
// pass 1): a controllable external-agent creation form, and an in-flight
// injection point between a Save's disk write and its live install. The real
// persistence module is loaded lazily INSIDE the hook: importing it at the
// top level would pull in external-agent-catalog (and with it the real
// external-agents module) before the hook could intercept.
let creations: Array<ExternalAgentConfig | undefined> = [];
let inFlightInjection: (() => Promise<void> | void) | undefined;
let realPersistenceModule: typeof import("../src/settings/persistence") | undefined;
const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request, ...args) {
  if (request === "./external-agents") return {
    ...realExternalAgents,
    async selectExternalAgentCreation(ui: import("../src/settings/ui").UiContext, draft: ReviewGateConfig) {
      const created = creations.shift();
      if (!created) return undefined;
      assert.equal(Object.hasOwn(draft.externalAgents ?? {}, created.id), false);
      const { id, ...definition } = created;
      return externalAgentCatalog(normalizeConfig({ externalAgents: { [id]: definition } }))[0];
    },
  };
  if (request === "./persistence") {
    const real = realPersistenceModule ??= originalLoad.call(this, request, ...args) as typeof import("../src/settings/persistence");
    return {
      ...real,
      persistReviewSettings: async (...persistArgs: Parameters<typeof real.persistReviewSettings>) => {
        const result = await real.persistReviewSettings(...persistArgs);
        await inFlightInjection?.();
        return result;
      },
    };
  }
  return originalLoad.call(this, request, ...args);
};
const { registerReviewSettings } = require("../src/settings/command") as typeof import("../src/settings/command");
const { assembleStagedSelectionConfig } = realPersistenceModule!;

const ROOT_SETTING_LABELS = [
  "Operating mode",
  "Mode cycle hotkey",
  "Worker resources",
  "External workers",
  "Execution priority",
  "Research priority",
  "Reviewers",
  "Timeouts",
  "Review policy",
  "Bundle retention",
  "Global concurrency",
  "Retry policy",
  "Subtask notifications",
  "Deferred Pi tools",
  "Subtasks view",
  "Scheduled tasks",
  "Web",
] as const;

const SCHEDULED_EDITOR_LABELS = [
  "Name",
  "Schedule (cron)",
  "Kind",
  "Destination",
  "Instructions",
  "Workspace",
  "Worker",
  "Review",
  "Enabled",
  "One shot",
  "Already run",
] as const;

function alignedTestRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function rootSettingsRow(label: typeof ROOT_SETTING_LABELS[number], value: string): string {
  return alignedTestRow(label, value, ROOT_SETTING_LABELS);
}

function scheduledEditorRow(label: string, value: string): string {
  return alignedTestRow(label, value, SCHEDULED_EDITOR_LABELS);
}

function executorEntryRow(label: string, value: string): string {
  const width = Math.max("Model".length, "Maximum concurrency".length);
  return `${label.padEnd(width)}  ${value}`;
}

interface Harness {
  config: ReviewGateConfig;
  configPath: string;
  original: string;
  /** Run one menu invocation. `onFirstSelect` fires once, after the menu opened and seeded its staged state but before the first selection resolves — a deterministic seam for changes landing while the menu is open. */
  run: (values: Array<string | undefined>, onFirstSelect?: () => Promise<void> | void) => Promise<void>;
  notices: Array<{ message: string; kind: string }>;
  /** Values queued for text fields (e.g. a rename's Identifier). */
  inputs: string[];
}

function assertNoErrors(h: Harness): void {
  for (const notice of h.notices) assert.notEqual(notice.kind, "error", notice.message);
}

async function sessionWorkspace(body: Record<string, unknown>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body);
  await writeFile(configPath, original, "utf8");
  const config = normalizeConfig(JSON.parse(original));
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        if (name === "review-settings") handler = options.handler as never;
      },
    },
    config,
    configPath,
  });
  assert.ok(handler);
  const notices: Array<{ message: string; kind: string }> = [];
  const inputs: string[] = [];
  return {
    config,
    configPath,
    original,
    notices,
    inputs,
    run: async (values, onFirstSelect) => {
      let index = 0;
      await handler!("", {
        scopedModels: [],
        ui: {
          select: async (_title: string, options: string[]) => {
            if (index === 0) await onFirstSelect?.();
            const value = values[index++];
            if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
            return value;
          },
          input: async () => {
            assert.ok(inputs.length, "unexpected text field");
            return inputs.shift();
          },
          confirm: async () => false,
          notify: (message: string, kind: string) => { notices.push({ message, kind }); },
        },
      });
    },
  };
}

test("root Escape applies the staged executor switch session-only; Cancel after a further edit keeps it", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: {
      alpha: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      beta: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      workerResources: { r: { selection: { source: "external", id: "alpha" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  });

  // Saved executor alpha → switch to beta → root Escape: live becomes beta,
  // the file keeps alpha.
  await h.run([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. alpha [run-as-binary] · shared max 1",
    executorEntryRow("Model", "alpha [run-as-binary]"),
    "beta [run-as-binary]",
    "Back",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.deepEqual(h.config.execution!.workerResources!.r.selection, { source: "external", id: "beta" });
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");

  // Reopen → switch back to alpha → explicit Cancel: the prior session-only
  // choice (beta) stays active; the file still keeps alpha.
  await h.run([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. beta [run-as-binary] · shared max 1",
    executorEntryRow("Model", "beta [run-as-binary]"),
    "alpha [run-as-binary]",
    "Back",
    "Back",
    "Cancel",
  ]);
  assertNoErrors(h);
  assert.deepEqual(h.config.execution!.workerResources!.r.selection, { source: "external", id: "beta" });
  assert.equal(await readFile(h.configPath, "utf8"), h.original);
});

test("Escape-applied external-agent deletion cascade persists on a later Save", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [{ source: "external", id: "X" }], subtaskReviewers: [] },
    externalAgents: {
      X: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      untouched: { adapter: "codex-cli", command: process.execPath, execution: {}, model: "keep-custom" },
    },
    execution: {
      workerResources: { arbitrary: { selection: { source: "external", id: "X" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "arbitrary" }], research: [] },
    },
  });

  // Run 1: stage the deletion cascade and exit with root Escape.
  await h.run([
    rootSettingsRow("External workers", "2 defined"),
    "X [run-as-binary]",
    "Delete",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.X, undefined, "the live cascade removed the definition");
  assert.deepEqual(h.config.execution!.workerResources, {});
  assert.deepEqual(h.config.review!.primaryReviewers, []);
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");

  // Run 2: reopen and Save from the root — the cascade persists.
  await h.run(["Save changes"]);
  assertNoErrors(h);
  const saved = normalizeConfig(JSON.parse(await readFile(h.configPath, "utf8")));
  assert.deepEqual(Object.keys(saved.externalAgents!).sort(), ["untouched"]);
  assert.deepEqual(saved.execution!.workerResources, {});
  assert.deepEqual(saved.review!.primaryReviewers, []);
  // The pending delta is durable now.
  assert.equal(getPendingSessionDelta(h.config), undefined);
});

test("Escape-applied schedule deletion persists on a later Save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-sched-"));
  const h = await sessionWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Nightly",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Work",
        workspace: dir,
      },
    },
  });

  // Run 1: remove the entry and exit with root Escape.
  await h.run([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Nightly — 0 9 * * * — execute — enabled",
    "Remove",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.deepEqual(h.config.scheduledTasks, {}, "the live catalog lost the entry");
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");

  // Run 2: reopen and Save from the root — the deletion persists.
  await h.run(["Save changes"]);
  assertNoErrors(h);
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.deepEqual(saved.scheduledTasks, {});
  assert.equal(getPendingSessionDelta(h.config), undefined);
});

test("an explicitly edited alreadyRun from a session-only apply persists on a later Save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-alreadyrun-"));
  const h = await sessionWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace: dir,
        oneShot: true,
      },
    },
  });

  // Run 1: manual disarm (Already run No → Yes) and root Escape.
  await h.run([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Once — 0 9 * * * — execute — enabled",
    scheduledEditorRow("Already run", "No"),
    "Back",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, true);
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");

  // Run 2: reopen (no further edits) and Save from the root — the explicit
  // toggle persists instead of the #306 disk-wins rule resurrecting it.
  await h.run(["Save changes"]);
  assertNoErrors(h);
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].alreadyRun, true);
  assert.equal(getPendingSessionDelta(h.config), undefined);
});

test("a failed Save retains the pending delta; a successful Save clears it", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: {
      X: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      workerResources: { r: { selection: { source: "external", id: "X" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  });

  // Run 1: stage the deletion and exit with root Escape (records the op).
  await h.run([
    rootSettingsRow("External workers", "1 defined"),
    "X [run-as-binary]",
    "Delete",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.X, undefined);
  const pending = getPendingSessionDelta(h.config);
  assert.ok(pending, "the Escape apply records the pending delta");
  assert.deepEqual(pending!.agentOperations.map((operation) => [operation.id, operation.nextId]), [["X", undefined]]);

  // Concurrent on-disk edit to the deleted definition breaks the optimistic
  // guard: Save fails and retains the pending delta.
  const latest = JSON.parse(await readFile(h.configPath, "utf8"));
  latest.externalAgents.X.model = "concurrent-change";
  await writeFile(h.configPath, JSON.stringify(latest), "utf8");
  await h.run(["Save changes", "Cancel"]);
  assert.ok(h.notices.some((notice) => notice.kind === "error" && /Cannot save external worker changes/.test(notice.message)));
  assert.equal(await readFile(h.configPath, "utf8"), JSON.stringify(latest), "the failed Save wrote nothing");
  const retained = getPendingSessionDelta(h.config);
  assert.ok(retained, "a failed Save retains the pending delta");
  assert.deepEqual(retained!.agentOperations.map((operation) => [operation.id, operation.nextId]), [["X", undefined]]);

  // Undo the concurrent edit: the same staged transaction now saves and
  // clears the delta.
  await writeFile(h.configPath, h.original, "utf8");
  h.notices.length = 0;
  await h.run(["Save changes"]);
  assertNoErrors(h);
  const saved = normalizeConfig(JSON.parse(await readFile(h.configPath, "utf8")));
  assert.equal(saved.externalAgents!.X, undefined);
  assert.deepEqual(saved.execution!.workerResources, {});
  assert.equal(getPendingSessionDelta(h.config), undefined, "a successful Save clears the pending delta");
});

test("assembleStagedSelectionConfig stages over the live base without touching the disk", () => {
  const base = normalizeConfig({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: {
      keep: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  });
  const next = assembleStagedSelectionConfig(base, {
    operatingMode: "execute",
    modeCycleShortcut: "alt+m",
    workerResources: {},
    executeRoute: [],
    researchRoute: [],
    primaryReviewers: [],
    subtaskReviewers: [],
    primaryEnabled: true,
    subtaskEnabled: false,
    reviewLandedChanges: false,
    reviewerTimeoutMs: 600000,
    executorTimeoutMs: 1800000,
    maxCorrectionCycles: 1,
    implementationGuidanceAfterCorrectionAttempts: 1,
    retainBundles: "always",
    maxWorkers: 2,
    retryPolicy: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 15000, jitter: true, maxSameIncidentRepeats: 2 },
    subtaskNotifications: "noisy",
    deferredPiTools: false,
    subtasksViewExpanded: true,
    scheduledTasks: {},
  }, {
    externalAgents: {
      replaced: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
  });
  // Staged scalars land on the result; non-staged base fields survive.
  assert.equal(next.operatingMode, "execute");
  assert.equal(next.review!.subtaskEnabled, false);
  assert.equal(next.retainBundles, "always");
  assert.equal(next.execution!.deferredPiTools, false);
  assert.deepEqual(Object.keys(next.externalAgents!), ["replaced"], "the supplied catalog replaces the base's");
  assert.equal(next.enabled, true, "non-staged base fields survive");
  // The base object is not mutated.
  assert.deepEqual(Object.keys(base.externalAgents!), ["keep"]);
});

test("the pending delta is keyed by live config identity", () => {
  const a = normalizeConfig({ enabled: false });
  const b = normalizeConfig({ enabled: false });
  recordPendingSessionDelta(a, {
    agentOperations: [],
    agentReferenceBaselines: new Map(),
    scheduleDeletions: new Set(["task-1"]),
    alreadyRunEdited: new Set(),
  });
  assert.ok(getPendingSessionDelta(a));
  assert.equal(getPendingSessionDelta(b), undefined, "a fresh config object (e.g. /reload) sees no delta");
  clearPendingSessionDelta(a);
  assert.equal(getPendingSessionDelta(a), undefined);
});

// Review pass 1 regression: a pending session-only alreadyRun edit must not
// bypass the #306 before-save live-change protection during a later Save —
// a consumption landing while the save is in flight must survive the install.
test("a pending re-arm does not hide an in-flight consumption at Save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-inflight-"));
  const h = await sessionWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace: dir,
        oneShot: true,
        alreadyRun: true,
      },
    },
  });

  // Run 1: re-arm the consumed one-shot (Already run Yes → No) and Escape.
  await h.run([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Once — 0 9 * * * — execute — enabled",
    scheduledEditorRow("Already run", "Yes"),
    "Back",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, undefined, "the re-arm is live-only");
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");

  // Run 2: reopen and Save; the scheduler consumes while the save is in
  // flight (between the disk write and the live install).
  inFlightInjection = async () => {
    h.config.scheduledTasks!["task-abcdef12"].alreadyRun = true;
    const latest = JSON.parse(await readFile(h.configPath, "utf8"));
    latest.scheduledTasks["task-abcdef12"].alreadyRun = true;
    await writeFile(h.configPath, JSON.stringify(latest), "utf8");
  };
  try {
    await h.run(["Save changes"]);
  } finally {
    inFlightInjection = undefined;
  }
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, true, "the in-flight consumption survives the install");
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].alreadyRun, true);
});

// Review pass 1 regression (symmetric): an in-flight explicit re-arm must
// survive installing a Save result that still carries the pending arm.
test("a pending manual arm does not hide an in-flight re-arm at Save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-inflight-rearm-"));
  const h = await sessionWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace: dir,
        oneShot: true,
      },
    },
  });

  // Run 1: manual arm (Already run No → Yes) and Escape.
  await h.run([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Once — 0 9 * * * — execute — enabled",
    scheduledEditorRow("Already run", "No"),
    "Back",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, true, "the arm is live-only");

  // Run 2: reopen and Save; another session re-arms while the save is in flight.
  inFlightInjection = async () => {
    delete h.config.scheduledTasks!["task-abcdef12"].alreadyRun;
    const latest = JSON.parse(await readFile(h.configPath, "utf8"));
    delete latest.scheduledTasks["task-abcdef12"].alreadyRun;
    await writeFile(h.configPath, JSON.stringify(latest), "utf8");
  };
  try {
    await h.run(["Save changes"]);
  } finally {
    inFlightInjection = undefined;
  }
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, undefined, "the in-flight re-arm survives the install");
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].alreadyRun, undefined);
});

// Review pass 1 regression: delete → Escape → reopen → create-same-ID → Save
// is one valid transaction: the recreation composes with the pending deletion
// and keeps its original definition/reference baselines.
test("delete → Escape → reopen → recreate the same ID → Save composes one transaction", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [{ source: "external", id: "X" }], subtaskReviewers: [] },
    externalAgents: {
      X: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      untouched: { adapter: "codex-cli", command: process.execPath, execution: {}, model: "keep-custom" },
    },
    execution: {
      workerResources: { r: { selection: { source: "external", id: "X" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  });

  // Run 1: delete X (cascade) and exit with root Escape.
  await h.run([
    rootSettingsRow("External workers", "2 defined"),
    "X [run-as-binary]",
    "Delete",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.X, undefined, "the live cascade removed the definition");
  assert.deepEqual(h.config.execution!.workerResources, {});
  assert.deepEqual(h.config.review!.primaryReviewers, []);
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");

  // Run 2: recreate the same ID and Save — the pending deletion composes.
  creations = [{ id: "X", adapter: "codex-cli", command: process.execPath, execution: {}, model: "recreated" }];
  await h.run([rootSettingsRow("External workers", "1 defined"), "Create worker", "Back", "Save changes"]);
  assertNoErrors(h);
  const saved = normalizeConfig(JSON.parse(await readFile(h.configPath, "utf8")));
  assert.deepEqual(Object.keys(saved.externalAgents!).sort(), ["X", "untouched"]);
  assert.equal(saved.externalAgents!.X.model, "recreated");
  // The deletion cascade's reference removals stay applied: the recreation
  // does not re-enroll X.
  assert.deepEqual(saved.execution!.workerResources, {});
  assert.deepEqual(saved.review!.primaryReviewers, []);
  assert.equal(getPendingSessionDelta(h.config), undefined, "a successful Save clears the pending delta");
});

test("recreating a deleted ID is rejected when the original disk definition changed concurrently", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [{ source: "external", id: "X" }], subtaskReviewers: [] },
    externalAgents: {
      X: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      untouched: { adapter: "codex-cli", command: process.execPath, execution: {}, model: "keep-custom" },
    },
    execution: {
      workerResources: { r: { selection: { source: "external", id: "X" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  });

  // Run 1: delete X and exit with root Escape.
  await h.run([
    rootSettingsRow("External workers", "2 defined"),
    "X [run-as-binary]",
    "Delete",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.X, undefined);

  // Concurrent on-disk edit to the original definition.
  const latest = JSON.parse(await readFile(h.configPath, "utf8"));
  latest.externalAgents.X.model = "concurrent-change";
  await writeFile(h.configPath, JSON.stringify(latest), "utf8");

  // Run 2: recreate the same ID and Save — the composed transaction must be
  // rejected against the changed original definition.
  creations = [{ id: "X", adapter: "codex-cli", command: process.execPath, execution: {}, model: "recreated" }];
  await h.run([rootSettingsRow("External workers", "1 defined"), "Create worker", "Back", "Save changes", "Cancel"]);
  assert.ok(h.notices.some((notice) => notice.kind === "error" && /changed or disappeared on disk/.test(notice.message)));
  assert.equal(await readFile(h.configPath, "utf8"), JSON.stringify(latest), "the failed Save wrote nothing");
  // The failed Save retains the pre-failure pending deletion; a later reopen
  // re-composes the recreation with it (the draft of the failed attempt is
  // discarded with the explicit Cancel).
  const retained = getPendingSessionDelta(h.config);
  assert.deepEqual(
    retained!.agentOperations.map((operation) => [operation.id, operation.nextId]),
    [["X", undefined]],
    "the pending deletion is retained for a later retry",
  );
});

// Review pass 2 regression: a consumption landing while the reopened menu is
// open (before Save's baseline capture) must replace the stale staged flag —
// the pending edit is not a new edit in this invocation.
test("a pending re-arm yields to a consumption that lands while the menu is open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-openconsume-"));
  const h = await sessionWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace: dir,
        oneShot: true,
        alreadyRun: true,
      },
    },
  });

  // Run 1: re-arm the consumed one-shot and Escape.
  await h.run([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Once — 0 9 * * * — execute — enabled",
    scheduledEditorRow("Already run", "Yes"),
    "Back",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, undefined, "the re-arm is live-only");

  // Run 2: the scheduler consumes while the menu is open, before Save.
  await h.run(["Save changes"], async () => {
    h.config.scheduledTasks!["task-abcdef12"].alreadyRun = true;
    const latest = JSON.parse(await readFile(h.configPath, "utf8"));
    latest.scheduledTasks["task-abcdef12"].alreadyRun = true;
    await writeFile(h.configPath, JSON.stringify(latest), "utf8");
  });
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, true, "the consumption survives the install");
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].alreadyRun, true, "the durable record keeps the consumption");
});

// Review pass 2 regression (symmetric): a re-arm landing while the menu is
// open must replace the stale staged arm.
test("a pending manual arm yields to a re-arm that lands while the menu is open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-openrearm-"));
  const h = await sessionWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace: dir,
        oneShot: true,
      },
    },
  });

  // Run 1: manual arm and Escape.
  await h.run([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Once — 0 9 * * * — execute — enabled",
    scheduledEditorRow("Already run", "No"),
    "Back",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, true, "the arm is live-only");

  // Run 2: another session re-arms while the menu is open, before Save.
  await h.run(["Save changes"], async () => {
    delete h.config.scheduledTasks!["task-abcdef12"].alreadyRun;
    const latest = JSON.parse(await readFile(h.configPath, "utf8"));
    delete latest.scheduledTasks["task-abcdef12"].alreadyRun;
    await writeFile(h.configPath, JSON.stringify(latest), "utf8");
  });
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, undefined, "the re-arm survives the install");
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].alreadyRun, undefined, "the durable record keeps the re-arm");
});

// Review pass 2 regression: after rename A→B applied session-only, a
// reopened creation of the released original ID is safe — the guarded pending
// rename releases it in the same transaction.
test("rename → Escape → reopen → create the released original ID → Save", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [{ source: "external", id: "A" }], subtaskReviewers: [] },
    externalAgents: {
      A: { adapter: "claude-cli", command: process.execPath, model: "model-a", review: {}, execution: {} },
    },
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  });

  // Run 1: rename A → B and exit with root Escape.
  h.inputs.push("B");
  await h.run([
    rootSettingsRow("External workers", "1 defined"),
    "A [claude-cli]",
    "Identifier: A",
    "Apply edit",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.A, undefined, "the live cascade renamed A → B");
  assert.equal(h.config.externalAgents!.B.model, "model-a");
  assert.deepEqual(h.config.review!.primaryReviewers, [{ source: "external", id: "B" }]);
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");
  for (const operation of getPendingSessionDelta(h.config)!.agentOperations) {
    assert.ok(!("definition" in operation), "pending metadata is baseline-only — no active-definition copies");
  }

  // Run 2: recreate the released original ID and Save.
  creations = [{ id: "A", adapter: "codex-cli", command: process.execPath, execution: {}, model: "recreated" }];
  await h.run([rootSettingsRow("External workers", "1 defined"), "Create worker", "Back", "Save changes"]);
  assertNoErrors(h);
  const saved = normalizeConfig(JSON.parse(await readFile(h.configPath, "utf8")));
  assert.deepEqual(Object.keys(saved.externalAgents!).sort(), ["A", "B"]);
  assert.equal(saved.externalAgents!.A.model, "recreated");
  assert.equal(saved.externalAgents!.B.model, "model-a");
  assert.deepEqual(saved.review!.primaryReviewers, [{ source: "external", id: "B" }]);
  assert.equal(getPendingSessionDelta(h.config), undefined, "a successful Save clears the pending delta");
});

test("creating a released original ID is rejected when the original disk definition changed concurrently", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [{ source: "external", id: "A" }], subtaskReviewers: [] },
    externalAgents: {
      A: { adapter: "claude-cli", command: process.execPath, model: "model-a", review: {}, execution: {} },
    },
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  });

  // Run 1: rename A → B and exit with root Escape.
  h.inputs.push("B");
  await h.run([
    rootSettingsRow("External workers", "1 defined"),
    "A [claude-cli]",
    "Identifier: A",
    "Apply edit",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);

  // Concurrent on-disk edit to the original definition.
  const latest = JSON.parse(await readFile(h.configPath, "utf8"));
  latest.externalAgents.A.model = "concurrent-change";
  await writeFile(h.configPath, JSON.stringify(latest), "utf8");

  // Run 2: recreate the released ID and Save — the guarded rename's
  // definition check must reject against the changed original.
  creations = [{ id: "A", adapter: "codex-cli", command: process.execPath, execution: {}, model: "recreated" }];
  await h.run([rootSettingsRow("External workers", "1 defined"), "Create worker", "Back", "Save changes", "Cancel"]);
  assert.ok(h.notices.some((notice) => notice.kind === "error" && /changed or disappeared on disk/.test(notice.message)));
  assert.equal(await readFile(h.configPath, "utf8"), JSON.stringify(latest), "the failed Save wrote nothing");
  const retained = getPendingSessionDelta(h.config);
  assert.deepEqual(
    retained!.agentOperations.map((operation) => [operation.id, operation.nextId]),
    [["A", "B"]],
    "the pending rename is retained for a later retry",
  );
});

// Review pass 2: the retained reference baselines must still reject a GENUINE
// concurrent on-disk reference change, not only stale same-transaction ones.
test("a concurrent on-disk reference change still rejects the save", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [{ source: "external", id: "Y" }], subtaskReviewers: [] },
    externalAgents: {
      A: { adapter: "claude-cli", command: process.execPath, model: "model-a", review: {}, execution: {} },
      Y: { adapter: "codex-cli", command: process.execPath, model: "model-y", review: {}, execution: {} },
    },
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  });

  // While the menu is open, another session adds a reference to Y on disk.
  await h.run([
    rootSettingsRow("External workers", "2 defined"),
    "Y [codex-cli]",
    "Delete Y",
    "Back",
    "Save changes",
    "Cancel",
  ], async () => {
    const latest = JSON.parse(await readFile(h.configPath, "utf8"));
    latest.review.subtaskReviewers.push({ source: "external", id: "Y" });
    await writeFile(h.configPath, JSON.stringify(latest), "utf8");
  });
  assert.ok(h.notices.some((notice) => notice.kind === "error" && /references changed on disk/.test(notice.message)));
});

// Review pass 3 regression: root Escape must preserve a concurrent re-arm
// (not only live-true consumption) — the opening baseline gives the
// bidirectional protection.
test("a concurrent re-arm landing while the menu is open survives root Escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-session-only-escaperearm-"));
  const h = await sessionWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace: dir,
        oneShot: true,
        alreadyRun: true,
      },
    },
  });

  // Another session re-arms while the menu is open, then root Escape.
  await h.run([undefined], async () => {
    delete h.config.scheduledTasks!["task-abcdef12"].alreadyRun;
  });
  assertNoErrors(h);
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, undefined, "the re-arm survives Escape");
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");
});

// Review pass 3: pending metadata is baseline-only — no active-definition
// copies — and a later Save reconstructs the operation payload from the
// canonical live state.
test("a session-only agent edit persists on a later Save via live-state reconstruction", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [{ source: "external", id: "A" }], subtaskReviewers: [] },
    externalAgents: {
      A: { adapter: "claude-cli", command: process.execPath, model: "model-a", review: {}, execution: {} },
    },
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  });

  // Run 1: edit the shared model and exit with root Escape.
  await h.run([
    rootSettingsRow("External workers", "1 defined"),
    "A [claude-cli]",
    "Shared model: model-a",
    "Opus 5.5 (claude-opus-5-5)",
    "Apply edit",
    "Back",
    undefined,
  ]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.A.model, "claude-opus-5-5", "the edit is live-only");
  const retained = getPendingSessionDelta(h.config)!;
  for (const operation of retained.agentOperations) {
    assert.ok(!("definition" in operation), "pending metadata is baseline-only — no active-definition copies");
  }

  // Run 2: Save — the operation payload comes from the live state.
  await h.run(["Save changes"]);
  assertNoErrors(h);
  const saved = normalizeConfig(JSON.parse(await readFile(h.configPath, "utf8")));
  assert.equal(saved.externalAgents!.A.model, "claude-opus-5-5");
});

// Review pass 3 regression: a creation has no on-disk original, so a later
// invocation must not invent an opening baseline for it.
test("create A → Escape → rename A → B → create A → Save persists both definitions", async () => {
  const h = await sessionWorkspace({
    enabled: false,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: {},
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  });

  // Run 1: create A (never on disk) and exit with root Escape.
  creations = [{ id: "A", adapter: "codex-cli", command: process.execPath, execution: {}, model: "first" }];
  await h.run([rootSettingsRow("External workers", "0 defined"), "Create worker", "Back", undefined]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.A.model, "first");
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");

  // Run 2: rename A → B, create a fresh A, Save.
  creations = [{ id: "A", adapter: "claude-cli", command: process.execPath, execution: {}, model: "second" }];
  h.inputs.push("B");
  await h.run([
    rootSettingsRow("External workers", "1 defined"),
    "A [codex-cli]",
    "Identifier: A",
    "Apply edit",
    "Create worker",
    "Back",
    "Save changes",
  ]);
  assertNoErrors(h);
  const saved = normalizeConfig(JSON.parse(await readFile(h.configPath, "utf8")));
  assert.deepEqual(Object.keys(saved.externalAgents!).sort(), ["A", "B"]);
  assert.equal(saved.externalAgents!.A.model, "second");
  assert.equal(saved.externalAgents!.B.model, "first");
});
