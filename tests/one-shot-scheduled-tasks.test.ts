/**
 * Issue #306: one-shot scheduled-task lifecycle and settings. A one-shot
 * entry's single execution is consumed exactly once, at its ACTUAL execution
 * start — the subtask destination's transport-boundary dispatch record or the
 * orchestrator destination's in-run message_start observation — never at
 * queueing, admission, overlap skip, overdue drop, or pre-start failure.
 * alreadyRun=true suppresses future occurrences; a manual re-arm is
 * future-only; recurring entries ignore the flag entirely; and a stale or
 * unrelated settings Save can never erase a scheduler-recorded alreadyRun.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig, type ScheduledTaskCatalog, type ScheduledTaskEntryConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { createScheduledEntryDispatcher, type ScheduledEntryDispatchHost } from "../src/scheduling/dispatch";
import { ScheduledTaskRuntime } from "../src/scheduling/dispatcher";
import { consumeOneShotExecution } from "../src/scheduling/one-shot";
import { ScheduledOrchestratorTurnTracker } from "../src/scheduling/orchestrator-turn";
import { getSchedulerRuntime, resetSchedulerRuntimeForTests } from "../src/scheduling/runtime";
import { captureScheduledAlreadyRun, persistReviewSettings, replaceConfig, updateReviewGateConfig, type ReviewSettingsSelection } from "../src/settings/persistence";
import { createState } from "../src/state";
import { awaitBounded, controllerInternals, initGitRepo, waitFor } from "./helpers/background-controller-fixtures";

const MINUTE = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, timeoutMs = 2_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Config schema: optional strict booleans, absent is the false default.
// ---------------------------------------------------------------------------

function configWithScheduledTasks(scheduledTasks: unknown): Record<string, unknown> {
  return { enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] }, scheduledTasks };
}

const validOneShot = {
  name: "Once",
  cron: "0 9 * * *",
  enabled: true,
  kind: "execute" as const,
  instructions: "Run once",
  workspace: "/tmp/ws",
};

test("one-shot fields normalize with strict booleans and absent=false defaults", () => {
  const config = normalizeConfig(configWithScheduledTasks({
    "task-once": { ...validOneShot, oneShot: true },
    "task-ran": { ...validOneShot, oneShot: true, alreadyRun: true },
    "task-recurring": { ...validOneShot },
    "task-false": { ...validOneShot, oneShot: false, alreadyRun: false },
  }));
  const tasks = config.scheduledTasks!;
  assert.equal(tasks["task-once"]!.oneShot, true);
  assert.equal(tasks["task-once"]!.alreadyRun, undefined, "absent alreadyRun is the false default");
  assert.equal(tasks["task-ran"]!.oneShot, true);
  assert.equal(tasks["task-ran"]!.alreadyRun, true);
  assert.equal(tasks["task-recurring"]!.oneShot, undefined, "existing entries stay byte-identical (no key)");
  assert.equal(tasks["task-recurring"]!.alreadyRun, undefined);
  // Explicit false never materializes a key: absence is the false default.
  assert.equal(tasks["task-false"]!.oneShot, undefined);
  assert.equal(tasks["task-false"]!.alreadyRun, undefined);
});

test("one-shot fields reject non-boolean values strictly", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["oneShot", "yes", /scheduledTasks\.task-a\.oneShot must be a boolean/],
    ["oneShot", 1, /scheduledTasks\.task-a\.oneShot must be a boolean/],
    ["alreadyRun", "true", /scheduledTasks\.task-a\.alreadyRun must be a boolean/],
    ["alreadyRun", null, /scheduledTasks\.task-a\.alreadyRun must be a boolean/],
  ];
  for (const [field, value, pattern] of cases) {
    assert.throws(
      () => normalizeConfig(configWithScheduledTasks({ "task-a": { ...validOneShot, [field]: value } })),
      pattern,
      `${field}=${String(value)} should be invalid`,
    );
  }
});

// ---------------------------------------------------------------------------
// Runtime eligibility: consumed one-shots are never due again; re-arming is
// future-only; recurring entries ignore alreadyRun; a queued occurrence of a
// now-consumed entry is dropped at admission, never caught up.
// ---------------------------------------------------------------------------

const RUNTIME_BASE = 1_700_000_000 * MINUTE;

function oneShotRuntimeFixture() {
  let nowMs = RUNTIME_BASE;
  resetSchedulerRuntimeForTests();
  delete process.env.PI_REVIEW_GATE_SCHEDULER;
  const switchState = getSchedulerRuntime();
  const catalog: ScheduledTaskCatalog = {
    once: { name: "Once", cron: "* * * * *", enabled: true, kind: "execute", instructions: "do it", workspace: "/tmp/ws", oneShot: true },
    recurring: { name: "Recurring", cron: "* * * * *", enabled: true, kind: "execute", instructions: "every time", workspace: "/tmp/ws" },
  };
  let catalogRef: ScheduledTaskCatalog | undefined = catalog;
  const dispatched: string[] = [];
  const runtime = new ScheduledTaskRuntime({
    switchState,
    catalog: () => catalogRef,
    onDue: (id) => {
      dispatched.push(id);
      // Mirror production consumption at actual execution start.
      if (catalog[id]?.oneShot === true) catalog[id]!.alreadyRun = true;
    },
    now: () => nowMs,
    tickIntervalMs: 2,
  });
  return {
    runtime,
    switchState,
    dispatched,
    catalog,
    advanceMinutes: (n: number) => {
      nowMs += n * MINUTE;
    },
  };
}

test("a one-shot entry runs once at the next future occurrence and never again", async () => {
  const fx = oneShotRuntimeFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.includes("once"));
  assert.equal(fx.catalog.once.alreadyRun, true, "actual execution start records alreadyRun");
  const onceCount = () => fx.dispatched.filter((id) => id === "once").length;
  assert.equal(onceCount(), 1);
  // Three more due minutes: the recurring sibling keeps firing every minute,
  // the consumed one-shot never does.
  for (let i = 2; i <= 4; i++) {
    fx.advanceMinutes(1);
    await until(() => fx.dispatched.filter((id) => id === "recurring").length === i, 2_000);
  }
  assert.equal(onceCount(), 1, "a consumed one-shot entry is never due again");
  fx.runtime.detach();
});

test("a manual re-arm fires only at the next future occurrence, never immediately or catch-up", async () => {
  const fx = oneShotRuntimeFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.includes("once"));
  assert.equal(fx.catalog.once.alreadyRun, true);

  // Manual re-arm mid-minute (the settings toggle applied to the live config).
  delete fx.catalog.once.alreadyRun;
  const count = () => fx.dispatched.filter((id) => id === "once").length;
  await sleep(40);
  assert.equal(count(), 1, "re-arming mid-minute never replays the in-progress minute");
  fx.advanceMinutes(1);
  await until(() => count() === 2);
  assert.equal(fx.catalog.once.alreadyRun, true, "the re-armed run consumed again at its actual start");
  fx.runtime.detach();
});

test("a recurring entry ignores alreadyRun entirely and is never auto-updated", async () => {
  const fx = oneShotRuntimeFixture();
  fx.catalog.recurring.alreadyRun = true; // foreign/stale flag on a recurring entry
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);
  for (let i = 1; i <= 2; i++) {
    fx.advanceMinutes(1);
    await until(() => fx.dispatched.filter((id) => id === "recurring").length === i, 2_000);
  }
  assert.equal(fx.catalog.recurring.alreadyRun, true, "the scheduler never auto-updates a recurring entry");
  fx.runtime.detach();
});

test("a one-shot occurrence queued behind its same-entry start is dropped at admission after consumption", async () => {
  let nowMs = RUNTIME_BASE;
  resetSchedulerRuntimeForTests();
  delete process.env.PI_REVIEW_GATE_SCHEDULER;
  const switchState = getSchedulerRuntime();
  const catalog: ScheduledTaskCatalog = {
    once: { name: "Once", cron: "* * * * *", enabled: true, kind: "execute", instructions: "do it", workspace: "/tmp/ws", oneShot: true },
  };
  const calls: string[] = [];
  let release!: () => void;
  const runtime = new ScheduledTaskRuntime({
    switchState,
    catalog: () => catalog,
    onDue: (id) => {
      calls.push(id);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    now: () => nowMs,
    tickIntervalMs: 2,
  });
  switchState.setEnabled(true);
  runtime.attach();
  await until(() => runtime.running);
  nowMs += MINUTE;
  await until(() => calls.length === 1);
  // Second due minute while the first start is still in flight.
  nowMs += MINUTE;
  await sleep(40);
  assert.equal(calls.length, 1, "no same-entry double start while a previous start is pending");
  // The first start actually runs: production consumption records alreadyRun.
  catalog.once.alreadyRun = true;
  release();
  await sleep(40);
  assert.equal(calls.length, 1, "the queued occurrence is dropped at admission: the entry already ran");
  runtime.detach();
});

// ---------------------------------------------------------------------------
// consumeOneShotExecution: immediate live eligibility plus a targeted durable
// record; idempotent; no-op for recurring/already-run/missing entries; honest
// failure reporting.
// ---------------------------------------------------------------------------

async function configFileFixture(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-oneshot-config-"));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    futureRoot: "keep-me",
    scheduledTasks: {
      "task-once": { ...validOneShot, oneShot: true },
      "task-other": { name: "Other", cron: "0 10 * * *", kind: "execute", instructions: "other", workspace: "/tmp/ws" },
    },
  }), "utf8");
  return { dir, configPath };
}

test("consumeOneShotExecution records alreadyRun in memory and durably, targeting only that field", async () => {
  const { dir, configPath } = await configFileFixture();
  try {
    const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    consumeOneShotExecution("task-once", { config, configPath });
    assert.equal(config.scheduledTasks!["task-once"].alreadyRun, true, "live eligibility is immediate");
    // The durable write is serialized behind the config-write boundary.
    const deadline = Date.now() + 2_000;
    for (;;) {
      const landed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
      if (landed.scheduledTasks["task-once"].alreadyRun === true) break;
      assert.ok(Date.now() < deadline, "the durable record landed");
      await sleep(10);
    }
    const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(saved.futureRoot, "keep-me", "unrelated fields survive verbatim");
    assert.deepEqual(saved.scheduledTasks["task-other"], { name: "Other", cron: "0 10 * * *", kind: "execute", instructions: "other", workspace: "/tmp/ws" }, "foreign entries survive verbatim");
    assert.equal(saved.scheduledTasks["task-once"].oneShot, true);
    assert.equal(saved.scheduledTasks["task-once"].alreadyRun, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consumeOneShotExecution is idempotent and a no-op for recurring, already-run, or missing entries", async () => {
  const { dir, configPath } = await configFileFixture();
  try {
    const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    // Recurring entry: never touched.
    consumeOneShotExecution("task-other", { config, configPath });
    assert.equal(config.scheduledTasks!["task-other"].alreadyRun, undefined);
    // Missing entry: nothing to record.
    consumeOneShotExecution("task-gone", { config, configPath });
    // First consumption.
    consumeOneShotExecution("task-once", { config, configPath });
    assert.equal(config.scheduledTasks!["task-once"].alreadyRun, true);
    // Second consumption (retry/failover turn delivery of the same execution).
    consumeOneShotExecution("task-once", { config, configPath });
    assert.equal(config.scheduledTasks!["task-once"].alreadyRun, true);
    const deadline = Date.now() + 2_000;
    for (;;) {
      const landed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
      if (landed.scheduledTasks["task-once"].alreadyRun === true) break;
      assert.ok(Date.now() < deadline, "the durable record landed");
      await sleep(10);
    }
    const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(saved.scheduledTasks["task-other"].alreadyRun, undefined, "the recurring entry was never recorded");
    assert.equal(saved.scheduledTasks["task-once"].alreadyRun, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persistence failure is reported honestly and the in-memory record stands", async () => {
  const { dir, configPath } = await configFileFixture();
  try {
    // Point the write at a directory: readFile fails (EISDIR), so the durable
    // record cannot land.
    const badPath = join(dir, "scheduledTasks");
    await writeFile(join(badPath, "not-a-file"), "{}", "utf8").catch(() => undefined);
    const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    const errors: string[] = [];
    consumeOneShotExecution("task-once", { config, configPath: badPath, reportError: (message) => errors.push(message) });
    assert.equal(config.scheduledTasks!["task-once"].alreadyRun, true, "the in-memory record stands even when the file write fails");
    await until(() => errors.length === 1, 2_000, "the persistence failure report");
    assert.match(errors[0]!, /recording alreadyRun in the config file failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without a loaded config file the consumption is reported, never claimed as recorded", async () => {
  const config = normalizeConfig(configWithScheduledTasks({ "task-once": { ...validOneShot, oneShot: true } }));
  const errors: string[] = [];
  consumeOneShotExecution("task-once", { config, reportError: (message) => errors.push(message) });
  assert.equal(config.scheduledTasks!["task-once"].alreadyRun, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /no persistent config file is loaded/);
});

// ---------------------------------------------------------------------------
// Controller observer: the existing dispatch-record seam consumes the one-shot
// entry at ACTUAL transport delivery (the fake run-as-binary executor's stdin
// boundary fires the real onPromptDelivery), never for non-scheduled groups or
// pre-start failures.
// ---------------------------------------------------------------------------

async function observerFixture(): Promise<{ root: string; controller: BackgroundExecutionController; config: ReviewGateConfig; observed: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-oneshot-controller-"));
  const executor = join(root, "executor.cjs");
  await initGitRepo(root);
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      maxWorkers: 2,
      workerResources: { default: { selection: { source: "external", id: "fake" }, maxConcurrent: 2 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
    scheduledTasks: {
      "t-once": { name: "Once", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "run once", workspace: root, oneShot: true },
      "t-again": { name: "Again", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "run again", workspace: root },
    },
  });
  const observed: string[] = [];
  const controller = new BackgroundExecutionController({
    pi: { sendMessage: () => undefined },
    config,
    state: createState(),
    cwd: () => root,
    onScheduledDispatchRecorded: (id) => {
      observed.push(id);
      consumeOneShotExecution(id, { config });
    },
  });
  return { root, controller, config, observed };
}

const observerDefinition = {
  title: "Scheduled execute task t-once: Once",
  instructions: "build the thing",
  acceptanceCriteria: ["The task instructions are completed as written."],
};

test("a scheduled group's actual dispatch record consumes its one-shot entry; recurring entries never do", async () => {
  const fx = await observerFixture();
  try {
    await awaitBounded(
      fx.controller.start([observerDefinition], "execute", fx.root, { scheduledTaskId: "t-once", reviewOverride: { mode: "off" } }),
      30_000,
      "scheduled start",
    );
    // The observer fires at the transport boundary (the executor's stdin
    // accepted the prompt write) — not at admission or a phase label.
    await until(() => fx.observed.length === 1, 30_000, "the dispatch-record observer");
    assert.deepEqual(fx.observed, ["t-once"]);
    assert.equal(fx.config.scheduledTasks!["t-once"].alreadyRun, true, "consumed at actual execution start");

    // A recurring scheduled group is recorded but never consumed.
    await awaitBounded(
      fx.controller.start([{ ...observerDefinition, title: "Scheduled execute task t-again: Again" }], "execute", fx.root, { scheduledTaskId: "t-again", reviewOverride: { mode: "off" } }),
      30_000,
      "recurring scheduled start",
    );
    await until(() => fx.observed.length === 2, 30_000, "the recurring dispatch-record observer");
    assert.deepEqual(fx.observed, ["t-once", "t-again"]);
    assert.equal(fx.config.scheduledTasks!["t-again"].alreadyRun, undefined, "recurring entries are never auto-updated");
  } finally {
    fx.controller.shutdown().catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a pre-start failure never consumes the one-shot entry", async () => {
  const fx = await observerFixture();
  try {
    // Unknown worker pin: start fails closed at creation, before any delivery.
    await assert.rejects(
      awaitBounded(
        fx.controller.start([observerDefinition], "execute", fx.root, { scheduledTaskId: "t-once", workerResourceId: "nope" }),
        30_000,
        "unknown pin",
      ),
      /no longer exists in \/review-settings/,
    );
    await sleep(50);
    assert.deepEqual(fx.observed, [], "no dispatch record, no consumption");
    assert.equal(fx.config.scheduledTasks!["t-once"].alreadyRun, undefined);
  } finally {
    fx.controller.shutdown().catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

// Review pass 1 regression: a correction/continuation of an execution that
// ALREADY STARTED must not re-consume an entry the user manually re-armed
// while it is active or recoverable. Only the first actual delivery consumes.
async function continuationFixture(): Promise<{ root: string; controller: BackgroundExecutionController; config: ReviewGateConfig; observed: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-oneshot-continuation-"));
  const executor = join(root, "executor.cjs");
  await initGitRepo(root);
  // The executor fails every turn (non-zero exit): the first turn's delivery
  // is real, then the task settles recoverable and a continuation delivers a
  // second prompt to the SAME task record.
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "process.stdin.resume();process.stdin.on('end',()=>{process.exit(1);});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      maxWorkers: 2,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
      workerResources: { default: { selection: { source: "external", id: "fake" }, maxConcurrent: 2 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
    scheduledTasks: {
      "t-once": { name: "Once", cron: "0 9 * * *", enabled: true, kind: "inplace", instructions: "run once", workspace: root, oneShot: true },
    },
  });
  const observed: string[] = [];
  const controller = new BackgroundExecutionController({
    pi: { sendMessage: () => undefined },
    config,
    state: createState(),
    cwd: () => root,
    onScheduledDispatchRecorded: (id) => {
      observed.push(id);
      consumeOneShotExecution(id, { config });
    },
  });
  return { root, controller, config, observed };
}

test("a continuation of an already-started scheduled execution never re-consumes a manually re-armed entry", async () => {
  const fx = await continuationFixture();
  try {
    const started = await awaitBounded(
      fx.controller.start([{ ...observerDefinition, title: "Scheduled in-place task t-once: Once" }], "inplace", fx.root, { scheduledTaskId: "t-once", reviewOverride: { mode: "off" } }),
      30_000,
      "scheduled in-place start",
    );
    const taskId = started.tasks[0]!.taskId;
    const internals = controllerInternals(fx.controller);
    const runtimes = (fx.controller as unknown as { runtimes: Map<string, unknown> }).runtimes;
    const task = () => internals.groups.get(started.executionId)!.tasks.find((candidate) => candidate.taskId === taskId)!;

    // The first actual delivery consumes the one-shot entry.
    await until(() => fx.observed.length === 1, 30_000, "the first dispatch-record observer");
    assert.deepEqual(fx.observed, ["t-once"]);
    assert.equal(fx.config.scheduledTasks!["t-once"].alreadyRun, true, "consumed at the first actual start");

    // The failed turn settles recoverable (not archivable): a continuation is
    // admissible. Manually re-arm the entry while the execution is recoverable.
    await waitFor(() => task().state === "paused_recoverable" && !runtimes.has(taskId), 30_000);
    fx.config.scheduledTasks!["t-once"].alreadyRun = false;

    // Deliver a continuation prompt for the SAME execution (same task record,
    // whose initialDispatch survives). It must NOT re-consume the re-arm.
    await awaitBounded(
      fx.controller.continueTask({ executionId: started.executionId, taskId, instructions: "keep going", instructionId: "cont-1", actor: "user" }),
      30_000,
      "continuation admission",
    );
    await until(() => (task().dispatch?.executorTurn ?? 0) >= 2, 30_000, "the continuation's second transport delivery");
    assert.equal(fx.config.scheduledTasks!["t-once"].alreadyRun, false, "the re-arm survives the continuation delivery");
    assert.deepEqual(fx.observed, ["t-once"], "only the first actual delivery notifies consumption");

    // Review pass 3 regression: adding a task to the already-started
    // scheduled execution delivers a NEW task's first prompt — the group's
    // delivery provenance must suppress that start signal too, so the manual
    // re-arm survives and the next scheduled occurrence stays armed.
    const added = await awaitBounded(
      fx.controller.add(started.executionId, [observerDefinition]),
      30_000,
      "add to the already-started scheduled execution",
    );
    const addedTaskId = added.addedTaskIds![0]!;
    await until(
      () => internals.groups.get(started.executionId)!.tasks
        .find((candidate) => candidate.taskId === addedTaskId)?.initialDispatch !== undefined,
      30_000,
      "the added task's actual transport delivery",
    );
    assert.equal(fx.config.scheduledTasks!["t-once"].alreadyRun, false,
      "adding work to the old execution must not consume the next scheduled occurrence");
    assert.deepEqual(fx.observed, ["t-once"]);
  } finally {
    fx.controller.shutdown().catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tracker seam: onObserved fires exactly once at the in-run message_start
// observation; hasPendingOccurrence drives the dispatcher guard and is
// released by the existing delivery lifecycle.
// ---------------------------------------------------------------------------

function trackerFixture(onObserved?: (occurrence: { entryId: string }) => void) {
  const tracker = new ScheduledOrchestratorTurnTracker(onObserved !== undefined ? { onObserved } : undefined);
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  return tracker;
}

test("onObserved fires exactly once for an observed in-flight occurrence and never otherwise", () => {
  const seen: string[] = [];
  const tracker = trackerFixture((occurrence) => seen.push(occurrence.entryId));

  // No run in flight: the observation is not attributable.
  const sending = tracker.beginOccurrence({ entryId: "t1", entryName: "Once", cron: "* * * * *", dueAt: new Date() });
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), false);
  assert.deepEqual(seen, [], "an unattributable observation never consumes");

  // In-flight run with matching identity: attributed and consumed once.
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true);
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true, "a repeat observation is still attributable");
  assert.deepEqual(seen, ["t1"], "the callback fires exactly once per occurrence");

  // A second scheduled occurrence observed in the same run is attributed and
  // consumes its own entry — each occurrence exactly once.
  const other = tracker.beginOccurrence({ entryId: "t2", entryName: "Other", cron: "* * * * *", dueAt: new Date() });
  assert.equal(tracker.noteMessageObserved(other.occurrenceId), true);
  assert.deepEqual(seen, ["t1", "t2"], "each observed occurrence consumes exactly once");
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled().length, 2);
});

test("hasPendingOccurrence tracks the delivery lifecycle: pending, discarded, settled, reset", () => {
  const tracker = trackerFixture();
  const sending = tracker.beginOccurrence({ entryId: "t1", entryName: "Once", cron: "* * * * *", dueAt: new Date() });
  assert.equal(tracker.hasPendingOccurrence("t1"), true, "a delivered occurrence is pending");
  assert.equal(tracker.hasPendingOccurrence("t2"), false);

  // Definite non-delivery discards the unobserved sending.
  tracker.discardOccurrence(sending.occurrenceId);
  assert.equal(tracker.hasPendingOccurrence("t1"), false, "a discarded sending releases the guard");

  // Observed + run end + settlement removes it.
  const second = tracker.beginOccurrence({ entryId: "t1", entryName: "Once", cron: "* * * * *", dueAt: new Date() });
  assert.equal(tracker.hasPendingOccurrence("t1"), true);
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(second.occurrenceId), true);
  assert.equal(tracker.hasPendingOccurrence("t1"), true, "an observed occurrence stays pending until settlement");
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled().length, 1);
  assert.equal(tracker.hasPendingOccurrence("t1"), false, "settlement releases the guard");

  // A session reset clears everything.
  const third = tracker.beginOccurrence({ entryId: "t1", entryName: "Once", cron: "* * * * *", dueAt: new Date() });
  assert.equal(tracker.hasPendingOccurrence("t1"), true);
  tracker.resetSession();
  assert.equal(tracker.hasPendingOccurrence("t1"), false, "a session reset clears pending occurrences");
});

// ---------------------------------------------------------------------------
// Dispatcher guard: a busy-queued one-shot orchestrator entry never accumulates
// several queued executions across due minutes; the single execution is
// consumed only at its own in-run observation; definite rejection releases the
// guard; recurring entries keep independent occurrences.
// ---------------------------------------------------------------------------

function turnHarness(options: { piMessage?: boolean; onObserved?: (occurrence: { entryId: string }) => void } = {}) {
  const piMessages: Array<{ details: Record<string, unknown> }> = [];
  const ownerEvents: string[] = [];
  const consoleWarnings: string[] = [];
  const orchestratorTurns = new ScheduledOrchestratorTurnTracker(options.onObserved !== undefined ? { onObserved: options.onObserved } : undefined);
  orchestratorTurns.setTurnEndTracking("host-lifecycle-hooks");
  const toolsAndHost = { piMessages, ownerEvents, consoleWarnings, orchestratorTurns };
  const host: ScheduledEntryDispatchHost & typeof toolsAndHost = {
    ...toolsAndHost,
    pi: options.piMessage === false ? {} : {
      sendMessage: (message: { details: Record<string, unknown> }) => {
        piMessages.push({ details: message.details });
      },
    },
    executionTools: {
      startScheduled: async () => {
        throw new Error("the orchestrator destination never starts subtasks");
      },
      scheduledRuns: () => [],
    },
    reportOwnerEvent: async (content) => {
      ownerEvents.push(content);
    },
    orchestratorTurnUnsafeReason: () => undefined,
    uiNotice: async () => undefined,
    consoleWarn: (message) => {
      consoleWarnings.push(message);
    },
    deliverLaunchNotice: async () => "delivered" as const,
    checkScheduledImages: async () => undefined,
  };
  const dispatch = createScheduledEntryDispatcher(host);
  return { dispatch, host, piMessages, ownerEvents, consoleWarnings, orchestratorTurns };
}

function oneShotTurnEntry(overrides: Partial<ScheduledTaskEntryConfig> = {}): ScheduledTaskEntryConfig {
  return {
    name: "Daily summary",
    cron: "* * * * *",
    enabled: true,
    kind: "execute",
    destination: "orchestrator-turn",
    instructions: "Produce the daily summary",
    workspace: "/tmp/prg-oneshot",
    oneShot: true,
    ...overrides,
  };
}

test("a busy-queued one-shot across due minutes yields exactly one execution, consumed at observation", async () => {
  const seen: string[] = [];
  const fx = turnHarness({ onObserved: (occurrence) => seen.push(occurrence.entryId) });
  const entry = oneShotTurnEntry();
  const base = new Date(2024, 5, 1, 9, 30);

  // Minute 1: delivered; the agent is busy, so the occurrence stays pending.
  await fx.dispatch("t-turn", entry, new Date(base), false);
  assert.equal(fx.piMessages.length, 1, "the first due minute delivers exactly one turn");
  const occurrenceId = String(fx.piMessages[0]!.details.occurrenceId);
  assert.deepEqual(seen, [], "delivery alone never consumes: no run has started");
  assert.equal(fx.orchestratorTurns.hasPendingOccurrence("t-turn"), true);

  // Minutes 2 and 3 while the agent is still busy: the guard skips; no second
  // or third turn is ever queued.
  await fx.dispatch("t-turn", entry, new Date(base.getTime() + MINUTE), false);
  await fx.dispatch("t-turn", entry, new Date(base.getTime() + 2 * MINUTE), false);
  assert.equal(fx.piMessages.length, 1, "no second or third queued execution behind a busy agent");
  assert.equal(fx.ownerEvents.length, 2, "each skipped due minute is reported");
  for (const report of fx.ownerEvents) {
    assert.match(report, /one-shot entry whose previous orchestrator-turn delivery is still pending/);
    assert.match(report, /SKIPPED/);
  }

  // The agent's run starts and observes this exact message: the single
  // execution is consumed now — refusal or failure later cannot un-consume it.
  fx.orchestratorTurns.agentRunStarted();
  assert.equal(fx.orchestratorTurns.noteMessageObserved(occurrenceId), true);
  assert.deepEqual(seen, ["t-turn"], "consumed exactly once, at the in-run observation");

  // The run ends and settles: the pending occurrence is released.
  fx.orchestratorTurns.agentRunEnded();
  assert.equal(fx.orchestratorTurns.agentRunSettled().length, 1);
  assert.equal(fx.orchestratorTurns.hasPendingOccurrence("t-turn"), false);
});

test("a definite delivery rejection releases the one-shot guard without consuming", async () => {
  const seen: string[] = [];
  const fx = turnHarness({ piMessage: false, onObserved: (occurrence) => seen.push(occurrence.entryId) });
  const entry = oneShotTurnEntry();
  const base = new Date(2024, 5, 1, 9, 30);

  // No model channel: the send is definitively unavailable and discarded.
  await fx.dispatch("t-turn", entry, new Date(base), false);
  assert.equal(fx.piMessages.length, 0);
  assert.equal(fx.orchestratorTurns.hasPendingOccurrence("t-turn"), false, "the rejected sending was discarded");
  assert.match(fx.ownerEvents[0]!, /could not be delivered/);

  // The next due minute is evaluated independently — no stale guard skip.
  await fx.dispatch("t-turn", entry, new Date(base.getTime() + MINUTE), false);
  assert.equal(fx.ownerEvents.length, 2);
  assert.ok(!fx.ownerEvents[1]!.includes("still pending"), "the second attempt is not a guard skip");
  assert.deepEqual(seen, [], "nothing was observed, so nothing was consumed");
});

test("a recurring orchestrator entry keeps independent occurrences across due minutes", async () => {
  const fx = turnHarness();
  const entry = oneShotTurnEntry({ oneShot: undefined });
  const base = new Date(2024, 5, 1, 9, 30);

  // Two due minutes while the agent is busy: recurring entries are independent.
  await fx.dispatch("t-turn", entry, new Date(base), false);
  await fx.dispatch("t-turn", entry, new Date(base.getTime() + MINUTE), false);
  assert.equal(fx.piMessages.length, 2, "recurring occurrences are never gated by the one-shot guard");
  assert.deepEqual(fx.ownerEvents, [], "no skips for a recurring entry");
});

// Review pass 1 regression: the one-shot pending admission/observation identity
// is independent of the bounded recurring-occurrence history. Tracker-capacity
// eviction must not release the guard or lose the consumption identity.
test("a one-shot pending occurrence survives tracker-capacity eviction by recurring traffic", async () => {
  const seen: string[] = [];
  const tracker = new ScheduledOrchestratorTurnTracker({ onObserved: (occurrence) => seen.push(occurrence.entryId) });
  tracker.setTurnEndTracking("host-lifecycle-hooks");

  // One queued one-shot, then more than the 32-occurrence pending cap of
  // recurring deliveries behind a busy agent.
  const oneShot = tracker.beginOccurrence({ entryId: "t-once", entryName: "Once", cron: "* * * * *", dueAt: new Date() }, { oneShot: true });
  const firstRecurring = tracker.beginOccurrence({ entryId: "t-rec-0", entryName: "R0", cron: "* * * * *", dueAt: new Date() });
  for (let i = 1; i <= 40; i++) {
    tracker.beginOccurrence({ entryId: `t-rec-${i}`, entryName: `R${i}`, cron: "* * * * *", dueAt: new Date() });
  }

  // The one-shot guard identity survived the eviction pressure.
  assert.equal(tracker.hasPendingOccurrence("t-once"), true, "the one-shot pending identity is exempt from capacity eviction");
  // Recurring bounding still works: the oldest recurring occurrence was evicted.
  assert.equal(await firstRecurring.observed, "abandoned", "recurring occurrences are still bounded by capacity");

  // The surviving identity is still attributable: the in-run observation
  // consumes the one-shot entry exactly once.
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(oneShot.occurrenceId), true, "the one-shot identity survived for attribution");
  assert.deepEqual(seen, ["t-once"], "consumed at its own observation");
});

// Review pass 2 regression: one-shot admissions must not consume recurring
// tracker capacity. With 32 pending one-shots, all 32 recurring identities
// are retained; the 33rd recurring occurrence evicts only the oldest
// recurring identity, and every one-shot identity survives.
test("one-shot admissions do not consume recurring tracker capacity", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const oneShots = Array.from({ length: 32 }, (_, i) =>
    tracker.beginOccurrence({ entryId: `t-os-${i}`, entryName: `OS${i}`, cron: "* * * * *", dueAt: new Date() }, { oneShot: true }));
  const recurring = Array.from({ length: 32 }, (_, i) =>
    tracker.beginOccurrence({ entryId: `t-rec-${i}`, entryName: `R${i}`, cron: "* * * * *", dueAt: new Date() }));

  // One-shots never count toward the recurring limit: all 64 stay pending.
  assert.equal(tracker.pendingOccurrences().length, 64, "one-shot presence does not reduce recurring capacity");

  // The 33rd recurring occurrence evicts only the oldest recurring identity.
  tracker.beginOccurrence({ entryId: "t-rec-32", entryName: "R32", cron: "* * * * *", dueAt: new Date() });
  assert.equal(await recurring[0]!.observed, "abandoned", "the oldest recurring identity was evicted");

  // Every one-shot and every remaining recurring identity is still
  // attributable in an in-flight run.
  tracker.agentRunStarted();
  for (const sending of [...oneShots, ...recurring.slice(1)]) {
    assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true, `${sending.occurrenceId} remains attributable`);
  }
});

test("a busy-queued one-shot survives 32+ intervening recurring deliveries and still consumes at observation", async () => {
  const seen: string[] = [];
  const fx = turnHarness({ onObserved: (occurrence) => seen.push(occurrence.entryId) });
  const entry = oneShotTurnEntry();
  const base = new Date(2024, 5, 1, 9, 30);

  // Minute 1: the one-shot is delivered; the agent is busy, so it stays pending.
  await fx.dispatch("t-turn", entry, new Date(base), false);
  assert.equal(fx.piMessages.length, 1);
  const occurrenceId = String(fx.piMessages[0]!.details.occurrenceId);

  // 40 recurring deliveries from other entries fill the pending map past its
  // cap while the one-shot is still queued behind the busy agent.
  for (let i = 0; i < 40; i++) {
    await fx.dispatch(`t-rec-${i}`, oneShotTurnEntry({ name: `Recurring ${i}`, oneShot: undefined }), new Date(base.getTime() + MINUTE), false);
  }
  assert.equal(fx.piMessages.length, 41, "recurring entries keep independent occurrences");

  // The one-shot's next due minute is still guarded — no second queued turn.
  await fx.dispatch("t-turn", entry, new Date(base.getTime() + MINUTE), false);
  assert.equal(fx.piMessages.length, 41, "the eviction pressure did not release the one-shot guard");
  assert.match(fx.ownerEvents[0]!, /still pending/);

  // The single queued message keeps its identity: the in-run observation
  // attributes and consumes it.
  fx.orchestratorTurns.agentRunStarted();
  assert.equal(fx.orchestratorTurns.noteMessageObserved(occurrenceId), true, "the one-shot identity survived for attribution");
  assert.deepEqual(seen, ["t-turn"], "consumed exactly once, at its own observation");
});

// ---------------------------------------------------------------------------
// Persistence: a stale or unrelated settings Save preserves the
// scheduler-recorded alreadyRun; an explicit user toggle always wins.
// ---------------------------------------------------------------------------

const baseSelection: ReviewSettingsSelection = {
  operatingMode: "orchestrate",
  modeCycleShortcut: "alt+m",
  workerResources: {},
  primaryReviewers: [],
  subtaskReviewers: [],
  primaryEnabled: true,
  subtaskEnabled: true,
  reviewLandedChanges: false,
  reviewerTimeoutMs: 600_000,
  executorTimeoutMs: 1_800_000,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  retainBundles: "on-failure",
  maxWorkers: 2,
  retryPolicy: {
    maxRetries: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
    jitter: true,
    maxSameIncidentRepeats: 2,
  },
  subtaskNotifications: "quiet",
  deferredPiTools: true,
  subtasksViewExpanded: false,
};

const stagedOneShotEntry = { ...validOneShot, oneShot: true };

test("a stale unrelated Save preserves a scheduler-recorded alreadyRun; an explicit re-arm wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-oneshot-save-"));
  const configPath = join(dir, "config.json");
  try {
    // Disk: the scheduler recorded alreadyRun after the menu opened.
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      futureRoot: "keep-me",
      scheduledTasks: { "task-once": { ...stagedOneShotEntry, alreadyRun: true } },
    }), "utf8");

    // Stale staged snapshot (no alreadyRun) saved without an explicit toggle.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry } },
      scheduledTasksStagedFrom: ["task-once"],
    });
    let saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks["task-once"].alreadyRun, true, "the stale Save preserved the scheduler record");
    assert.equal(saved.futureRoot, "keep-me", "unrelated fields survive verbatim");

    // Explicit manual re-arm: the id is in the edited set and the staged entry
    // has no alreadyRun — it wins.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry } },
      scheduledTasksStagedFrom: ["task-once"],
      scheduledTasksAlreadyRunEdited: ["task-once"],
    });
    saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks["task-once"].alreadyRun, undefined, "the explicit re-arm persisted");

    // Explicit manual disarm on a re-run entry: the edited set carries true.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry, alreadyRun: true } },
      scheduledTasksStagedFrom: ["task-once"],
      scheduledTasksAlreadyRunEdited: ["task-once"],
    });
    saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks["task-once"].alreadyRun, true, "the explicit disarm persisted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review pass 1 regression: the latest on-disk state wins in BOTH directions
// for an unedited entry — a stale snapshot carrying alreadyRun=true must not
// resurrect a flag another save explicitly cleared (a silent re-disarm).
test("a stale Save with a carried alreadyRun cannot undo a later explicit re-arm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-oneshot-save-reverse-"));
  const configPath = join(dir, "config.json");
  try {
    // Disk: the entry is consumed (alreadyRun true) when the stale menu opens.
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: { "task-once": { ...stagedOneShotEntry, alreadyRun: true } },
    }), "utf8");

    // A later save explicitly re-arms the entry (edited set, flag cleared).
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry } },
      scheduledTasksStagedFrom: ["task-once"],
      scheduledTasksAlreadyRunEdited: ["task-once"],
    });
    let saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks["task-once"].alreadyRun, undefined, "the re-arm landed on disk");

    // The stale snapshot (still carrying alreadyRun true, no explicit edit in
    // ITS session) now does an unrelated Save: the latest disk state (armed)
    // must win — the flag is not resurrected.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry, alreadyRun: true } },
      scheduledTasksStagedFrom: ["task-once"],
    });
    saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks["task-once"].alreadyRun, undefined, "the stale Save kept the entry armed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installing a latest Save re-arm does not restore an unchanged stale live true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-oneshot-install-latest-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: { "task-once": { ...stagedOneShotEntry, alreadyRun: true } },
    }), "utf8");
    const live = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    const baseline = captureScheduledAlreadyRun(live);
    // Another settings session re-arms before this stale session saves.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry } },
      scheduledTasksStagedFrom: ["task-once"],
      scheduledTasksAlreadyRunEdited: ["task-once"],
    });
    const latestSave = await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry, alreadyRun: true } },
      scheduledTasksStagedFrom: ["task-once"],
    });
    assert.equal(latestSave.scheduledTasks!["task-once"].alreadyRun, undefined);
    replaceConfig(live, latestSave, { scheduledTasksAlreadyRunBeforeSave: baseline });
    assert.equal(live.scheduledTasks!["task-once"].alreadyRun, undefined,
      "an unchanged old live flag must not override the latest persisted re-arm");
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).scheduledTasks["task-once"].alreadyRun, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review pass 1 regression: an async config result captured BEFORE a live
// consumption (a settings Save or view-preference save still in flight) must
// not reset the live flag when it is installed — and the durable record must
// still land. An explicit Already-run edit from the installing session wins.
test("a stale async config result cannot undo a live one-shot consumption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-oneshot-install-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: { "task-once": { ...stagedOneShotEntry } },
    }), "utf8");
    const live = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));

    // Production captures a baseline before the asynchronous save. Consumption
    // changes the same entry object in place, so the flag comparison (not only
    // an object replacement) must preserve the newer live true on install.
    const baseline = captureScheduledAlreadyRun(live);
    // The save captures its snapshot; the execution starts (live consumption)
    // while the save's write is still in flight, queued behind it through the
    // same serialized config-write boundary.
    const saved = await updateReviewGateConfig(configPath, () => {
      consumeOneShotExecution("task-once", { config: live, configPath });
    });
    assert.equal(live.scheduledTasks!["task-once"].alreadyRun, true, "live eligibility is immediate");
    assert.equal(saved.scheduledTasks?.["task-once"]?.alreadyRun, undefined, "the save's result predates the consumption");

    // Installing that stale result must keep the live flag consumed.
    replaceConfig(live, saved, { scheduledTasksAlreadyRunBeforeSave: baseline });
    assert.equal(live.scheduledTasks!["task-once"].alreadyRun, true, "the live consumption survives the stale install");

    // The consumption's durable write lands behind the save's write.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const landed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
      if (landed.scheduledTasks["task-once"].alreadyRun === true) break;
      assert.ok(Date.now() < deadline, "the durable alreadyRun record landed");
      await sleep(10);
    }
    assert.equal(live.scheduledTasks!["task-once"].alreadyRun, true, "disk and live eligibility agree: consumed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit Already-run edit wins over the live-consumption protection on install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-oneshot-install-edit-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: { "task-once": { ...stagedOneShotEntry } },
    }), "utf8");
    const live = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    live.scheduledTasks!["task-once"].alreadyRun = true;

    // A stale result without the flag, installed with an explicit re-arm for
    // this entry: the user's edit wins in both directions.
    const saved = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    replaceConfig(live, saved, { scheduledTasksAlreadyRunEdited: ["task-once"] });
    assert.equal(live.scheduledTasks!["task-once"].alreadyRun, undefined, "the explicit re-arm cleared the live flag");

    // Without the edit, the same install preserves the live consumption.
    const live2 = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    live2.scheduledTasks!["task-once"].alreadyRun = true;
    replaceConfig(live2, saved);
    assert.equal(live2.scheduledTasks!["task-once"].alreadyRun, true, "an unedited install preserves the live flag");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review pass 2 regression: an unrelated save that captured alreadyRun=true
// and paused before replacement must not reinstall true after an explicit
// re-arm installed false — the pre-save baseline preserves the newer live
// re-arm in either direction.
test("a stale result carrying true cannot undo an explicit re-arm made while the save was in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-oneshot-install-rearm-"));
  const configPath = join(dir, "config.json");
  try {
    // Disk and live: the entry is consumed.
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: { "task-once": { ...stagedOneShotEntry, alreadyRun: true } },
    }), "utf8");
    const live = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));

    // An unrelated save starts: it captures its baseline and its normalized
    // result (carrying true), then pauses before replacement.
    const baseline = captureScheduledAlreadyRun(live);
    const staleResult = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));

    // While the save is in flight, an explicit re-arm installs false — live
    // and disk both become armed again.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: { "task-once": { ...stagedOneShotEntry } },
      scheduledTasksStagedFrom: ["task-once"],
      scheduledTasksAlreadyRunEdited: ["task-once"],
    });
    const rearmResult = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    replaceConfig(live, rearmResult, { scheduledTasksAlreadyRunEdited: ["task-once"] });
    assert.equal(live.scheduledTasks!["task-once"].alreadyRun, undefined, "the explicit re-arm installed live");

    // The older save resumes and installs its stale result with its captured
    // baseline: the newer live re-arm must win.
    replaceConfig(live, staleResult, { scheduledTasksAlreadyRunBeforeSave: baseline });
    assert.equal(live.scheduledTasks!["task-once"].alreadyRun, undefined, "live eligibility remains armed");

    const landed = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(landed.scheduledTasks["task-once"].alreadyRun, undefined, "disk and live agree: armed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
