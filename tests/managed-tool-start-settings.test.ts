/**
 * #682: one trusted native Start settings snapshot carried through the
 * canonical queue and dispatch.
 *
 * Verified in process against the real manager, shared binding, controller,
 * pump, executor-pool leases, and launch accounting. Only the per-kind
 * lifecycle runner is replaced (the controller's `lifecycleRunner` seam), so
 * no worktree, process, or provider is touched; each launched task records
 * what the controller resolves for it at launch: route, group configuration,
 * and the continuation digest it stamped.
 *
 * - A shared admission may supply `startSettings` (configuration plus parent
 *   tool ceiling) for Start only. It is copied once: later edits to the
 *   owner's object change nothing.
 * - That Start's tool catalog (ceiling, executor deny list, deferred initial
 *   set) and evidence policy come from the snapshot, and its group's route,
 *   worker/reviewer configuration, and digest stay on the snapshot while it
 *   waits in a paused queue across live settings changes.
 * - A later Start with newer settings uses the newer settings; a plain Pi
 *   Start keeps reading live settings; global `maxWorkers` stays live.
 * - Nothing from the snapshot reaches durable group state, associations, or
 *   results.
 * - A malformed snapshot, or one on any action but Start, refuses before
 *   the handler.
 * - A native Add snapshot (`addSettings`) sets only the added task's catalog
 *   and evidence policy; the added task still launches on its group's admitted
 *   settings, and a plain Pi Add into the same group keeps reading live ones.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { effectiveReviewEvidenceSettings, normalizeConfig, type ExecutorPoolEntry, type ReviewGateConfig } from "../src/config";
import type {
  BackgroundExecutionController,
  BackgroundExecutionGroup,
  BackgroundTaskRecord,
} from "../src/execution/background-controller";
import type { ExecutorPoolAssignment, ExecutorPoolLease, ExecutorPoolScheduler } from "../src/execution/executor-pool";
import { runWaveTaskContinuation, runWaveTaskFresh, type WaveLifecycleDeps } from "../src/execution/wave-task-lifecycle";
import { captureWorkerReviewEvidencePolicy } from "../src/execution/review-evidence-policy";
import { transitionTaskState } from "../src/execution/task-state";
import {
  ExecutionToolManager,
  type ManagedStartSettings,
  type ManagedToolAdmission,
  type ManagedToolAdmittedCall,
} from "../src/execution/tool";
import { configDigest } from "../src/session-state";
import { createState, type ReviewGateState } from "../src/state";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import { waitFor } from "./helpers/background-controller-fixtures";
import { EMPTY_ASSOCIATIONS, SUBTASK_TOOL_NAMES, queuedTask } from "./managed-tool-fixtures";

const SENTINEL = "SNAPSHOT-SENTINEL-7f3c1e9a";

interface SettingsShape {
  resource: string;
  maxCorrectionCycles: number;
  subtaskEnabled: boolean;
  executorDeny: string[];
  worktreeToolOnly: boolean;
  maxWorkers: number;
  /** Shared per-resource cap; defaults to 4. */
  maxConcurrent?: number;
}

function settings(shape: SettingsShape): ReviewGateConfig {
  const config = normalizeConfig({
    enabled: true,
    maxCorrectionCycles: shape.maxCorrectionCycles,
    review: { activeReviewers: [], subtaskEnabled: shape.subtaskEnabled, evidence: { worktreeToolOnly: shape.worktreeToolOnly } },
    externalAgents: {
      [`agent-${shape.resource}`]: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
      },
    },
    execution: {
      deferredPiTools: false,
      workerResources: { [shape.resource]: { selection: { source: "external", id: `agent-${shape.resource}` }, maxConcurrent: shape.maxConcurrent ?? 4 } },
      routes: { execute: [{ resourceId: shape.resource }], research: [] },
    },
    tools: { executorDeny: shape.executorDeny },
  });
  // Set after normalization: 0 (a paused queue) is a test-only value.
  config.execution!.maxWorkers = shape.maxWorkers;
  return config;
}

/** A settings snapshot carrying a credential-like sentinel that must never be persisted or returned. */
function snapshotWithSentinel(shape: SettingsShape): ReviewGateConfig {
  const config = settings(shape);
  (config.externalAgents![`agent-${shape.resource}`] as unknown as Record<string, unknown>).env = { API_TOKEN: SENTINEL };
  return config;
}

interface LaunchRecord {
  taskId: string;
  title: string;
  route: string[];
  routeCaps: number[];
  leaseEntry: string;
  config: ReviewGateConfig;
  digest: string | undefined;
}

class SettingsAdmission implements ManagedToolAdmission {
  private readonly records = new Map<string, { toolName: string; params: unknown; startCallFingerprint?: string; startSettings?: unknown; addSettings?: unknown }>();

  admit(toolCallId: string, toolName: string, params: unknown, startSettings?: unknown, addSettings?: unknown): void {
    const fingerprint = toolCallFingerprint(toolName, params);
    this.records.set(toolCallId, {
      toolName,
      params: structuredClone(params),
      ...(fingerprint ? { startCallFingerprint: fingerprint } : {}),
      ...(startSettings !== undefined ? { startSettings } : {}),
      ...(addSettings !== undefined ? { addSettings } : {}),
    });
  }

  resolveCall(toolCallId: string, toolName: string): ManagedToolAdmittedCall | undefined {
    const record = this.records.get(toolCallId);
    if (!record || record.toolName !== toolName) return undefined;
    return {
      params: structuredClone(record.params),
      startCallFingerprint: record.startCallFingerprint,
      // Deliberately the owner's own object (not a copy): the boundary must copy it.
      ...(record.startSettings !== undefined ? { startSettings: record.startSettings as ManagedStartSettings } : {}),
      ...(record.addSettings !== undefined ? { addSettings: record.addSettings as ManagedStartSettings } : {}),
    };
  }
}

interface Harness {
  live: ReviewGateConfig;
  manager: ExecutionToolManager;
  controller: BackgroundExecutionController;
  admission: SettingsAdmission;
  launches: LaunchRecord[];
  settle(taskId: string): void;
  piStart(id: string, params: unknown): Promise<Record<string, any>>;
  sharedStart(id: string, params: unknown, startSettings?: unknown): Promise<Record<string, any>>;
  piAdd(id: string, params: unknown): Promise<Record<string, any>>;
  sharedAdd(id: string, params: unknown, addSettings?: unknown): Promise<Record<string, any>>;
  notifications: string[];
  dispose(): Promise<void>;
}

const LIVE_TOOLS = ["read", "bash", "grep", ...SUBTASK_TOOL_NAMES];

async function harness(live: ReviewGateConfig): Promise<Harness> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-review-start-settings-"));
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
    getActiveTools: () => [...LIVE_TOOLS],
  };
  const launches: LaunchRecord[] = [];
  const pending = new Map<string, () => void>();
  let controller: BackgroundExecutionController | undefined;
  const caps = () => (controller as unknown as {
    caps: {
      config: { forGroup(group: BackgroundExecutionGroup): ReviewGateConfig };
      executor: { routeOf(group: BackgroundExecutionGroup): ExecutorPoolEntry[] };
    };
  }).caps;
  const notifications: string[] = [];
  // Pi managers hand their exact input object to the controller, so the
  // controller's deterministic lifecycle seam can ride on it.
  const input = {
    pi,
    config: live,
    state: createState(),
    cwd: () => sourceRoot,
    notify: (message: string) => { notifications.push(message); },
    liveToolCallAllowed: (name: string) => LIVE_TOOLS.includes(name),
    lifecycleRunner: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, _abort: AbortController, lease: ExecutorPoolLease) => {
      // Read exactly what the real per-kind runners read at launch.
      launches.push({
        taskId: task.taskId,
        title: task.definition.title,
        route: caps().executor.routeOf(group).map((entry) => entry.entryId),
        routeCaps: caps().executor.routeOf(group).map((entry) => entry.maxConcurrent),
        leaseEntry: lease.entry.entryId,
        config: caps().config.forGroup(group),
        digest: task.lastRuntimeConfigDigest,
      });
      return new Promise<void>((resolve) => { pending.set(task.taskId, resolve); }).then(() => {
        transitionTaskState(task, "landed");
        task.summary = "synthetic settlement";
      });
    },
  };
  const manager = new ExecutionToolManager(input as ConstructorParameters<typeof ExecutionToolManager>[0]);
  controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
  manager.sync();
  const admission = new SettingsAdmission();
  const roots = new Set<string>();
  const collect = () => { for (const root of manager.associations().groupRoots ?? []) roots.add(root); };
  return {
    live,
    manager,
    controller,
    admission,
    launches,
    notifications,
    settle: (taskId) => {
      const resolve = pending.get(taskId);
      assert.ok(resolve, `${taskId} is not running`);
      pending.delete(taskId);
      resolve();
    },
    piStart: async (id, params) => {
      const tool = tools.find((candidate) => candidate.name === "SubtasksStart");
      assert.ok(tool);
      const result = await tool.execute(id, params);
      collect();
      return result;
    },
    sharedStart: async (id, params, startSettings) => {
      admission.admit(id, "SubtasksStart", params, startSettings);
      const result = await manager.sharedManagedTool("start", admission).invoke({ toolCallId: id }) as Record<string, any>;
      collect();
      return result;
    },
    piAdd: async (id, params) => {
      const tool = tools.find((candidate) => candidate.name === "SubtasksAdd");
      assert.ok(tool);
      return await tool.execute(id, params);
    },
    sharedAdd: async (id, params, addSettings) => {
      admission.admit(id, "SubtasksAdd", params, undefined, addSettings);
      return await manager.sharedManagedTool("add", admission).invoke({ toolCallId: id }) as Record<string, any>;
    },
    dispose: async () => {
      collect();
      for (const resolve of pending.values()) resolve();
      pending.clear();
      await manager.shutdown();
      await manager.detach();
      for (const root of roots) await rm(root, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    },
  };
}

async function readTree(root: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    text += await readFile(join(entry.parentPath, entry.name), "utf8");
  }
  return text;
}

function taskByTitle(controller: BackgroundExecutionController, executionId: string, title: string) {
  const task = controller.inspect(executionId).tasks.find((candidate) => candidate.definition.title === title);
  assert.ok(task, `${title} not found`);
  return task;
}

const R1: SettingsShape = { resource: "r1", maxCorrectionCycles: 2, subtaskEnabled: false, executorDeny: ["bash"], worktreeToolOnly: true, maxWorkers: 8 };
const R2: SettingsShape = { resource: "r2", maxCorrectionCycles: 5, subtaskEnabled: true, executorDeny: ["grep"], worktreeToolOnly: false, maxWorkers: 8 };
const LIVE: SettingsShape = { resource: "live", maxCorrectionCycles: 3, subtaskEnabled: true, executorDeny: [], worktreeToolOnly: false, maxWorkers: 0 };
const CHANGED: SettingsShape = { resource: "changed", maxCorrectionCycles: 7, subtaskEnabled: false, executorDeny: ["read"], worktreeToolOnly: false, maxWorkers: 1 };

test("native Start settings stay frozen per admitted group through a paused queue while Pi stays live", async () => {
  const live = settings(LIVE);
  const h = await harness(live);
  try {
    const r1 = snapshotWithSentinel(R1);
    const r1Expected = structuredClone(r1);
    const r1Tools = ["read", "bash", "edit"];
    const r2 = snapshotWithSentinel(R2);
    const r2Tools = ["read", "grep", "write"];
    const r1Settings = { config: r1, authorizedTools: r1Tools };

    // Paused queue: live maxWorkers = 0, so every admitted task waits.
    const first = await h.sharedStart("call-ab", { tasks: [queuedTask("A"), queuedTask("B")] }, r1Settings);
    assert.equal(first.isError, false, first.content[0].text);
    const second = await h.sharedStart("call-c", { tasks: [queuedTask("C")] }, { config: r2, authorizedTools: r2Tools });
    assert.equal(second.isError, false, second.content[0].text);
    const plain = await h.piStart("pi-call-p", { tasks: [queuedTask("P")] });
    assert.equal(plain.isError, false, plain.content[0].text);
    assert.equal(h.launches.length, 0, "the queue is paused");
    const groupAB = first.details.executionId as string;
    const groupC = second.details.executionId as string;
    const groupP = plain.details.executionId as string;

    // Snapshot once: later edits to the owner's objects change nothing.
    r1.maxCorrectionCycles = 99;
    r1.execution!.routes!.execute = [{ resourceId: "tampered" }];
    r1Tools.push("tampered-tool");

    // Admission-time reads came from each Start's own snapshot.
    const catalogOf = (executionId: string, title: string) => taskByTitle(h.controller, executionId, title).definition.executorToolCatalog;
    assert.deepEqual(catalogOf(groupAB, "A")?.allowedToolCatalog, ["read", "edit"], "R1 ceiling minus R1 executor deny");
    assert.deepEqual(catalogOf(groupAB, "B")?.allowedToolCatalog, ["read", "edit"]);
    assert.deepEqual(catalogOf(groupC, "C")?.allowedToolCatalog, ["read", "write"], "R2 ceiling minus R2 executor deny");
    assert.deepEqual(catalogOf(groupP, "P")?.allowedToolCatalog, ["read", "bash", "grep", ...SUBTASK_TOOL_NAMES], "Pi reads the live ceiling");
    const policy = (shape: SettingsShape) => captureWorkerReviewEvidencePolicy(effectiveReviewEvidenceSettings(settings(shape)), "execute");
    assert.deepEqual(taskByTitle(h.controller, groupAB, "B").definition.reviewEvidencePolicy, policy(R1));
    assert.deepEqual(taskByTitle(h.controller, groupC, "C").definition.reviewEvidencePolicy, policy(R2));
    assert.deepEqual(taskByTitle(h.controller, groupP, "P").definition.reviewEvidencePolicy, policy(LIVE));

    // Live settings change while everything is queued; maxWorkers = 1 also
    // releases the paused queue one slot at a time (global policy stays live).
    const changed = settings(CHANGED);
    for (const key of Object.keys(live) as Array<keyof ReviewGateConfig>) delete live[key];
    Object.assign(live, changed);
    h.controller.refreshPool();

    await waitFor(() => h.launches.length === 1);
    assert.equal(h.launches[0]!.title, "A");
    assert.deepEqual(h.launches[0]!.route, ["r1"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.launches.length, 1, "live maxWorkers = 1 still bounds snapshot groups");

    // Release A: B launches on R1 although live settings and newer Starts differ.
    h.settle(h.launches[0]!.taskId);
    await waitFor(() => h.launches.length === 2);
    const b = h.launches[1]!;
    assert.equal(b.title, "B");
    assert.deepEqual(b.route, ["r1"]);
    assert.equal(b.leaseEntry, "r1");
    assert.deepEqual(b.routeCaps, [4], "a resource absent from the live catalog keeps its admitted cap and stays dispatchable");
    assert.equal(b.config.maxCorrectionCycles, 2);
    assert.equal(b.config.review?.subtaskEnabled, false);
    assert.deepEqual(b.config.tools?.executorDeny, ["bash"]);
    assert.deepEqual(b.config, r1Expected, "worker/reviewer launch config is exactly the admitted R1 snapshot");
    assert.equal(b.digest, configDigest(r1Expected));

    h.settle(b.taskId);
    await waitFor(() => h.launches.length === 3);
    const c = h.launches[2]!;
    assert.equal(c.title, "C");
    assert.deepEqual(c.route, ["r2"]);
    assert.equal(c.config.maxCorrectionCycles, 5);
    assert.equal(c.config.review?.subtaskEnabled, true);
    assert.equal(c.digest, configDigest(r2));

    h.settle(c.taskId);
    await waitFor(() => h.launches.length === 4);
    const p = h.launches[3]!;
    assert.equal(p.title, "P");
    assert.deepEqual(p.route, ["changed"], "plain Pi reads live settings at dispatch");
    assert.equal(p.config, live, "plain Pi launches with the live configuration object itself");
    assert.equal(p.digest, configDigest(live));
    h.settle(p.taskId);
    await waitFor(() => h.controller.inspect(groupP).tasks.every((task) => task.state === "landed"));

    // No snapshot content (sentinel or snapshot-only values) leaves memory.
    const durable = await Promise.all((h.manager.associations().groupRoots ?? []).map(readTree));
    for (const text of durable) assert.equal(text.includes(SENTINEL), false, "durable group state");
    const surfaces = JSON.stringify([
      first, second, plain,
      h.manager.associations(),
      h.controller.inspect(groupAB), h.controller.inspect(groupC),
      h.notifications,
    ]);
    assert.equal(surfaces.includes(SENTINEL), false, "results, associations, inspection, notifications");
    assert.equal(surfaces.includes("API_TOKEN"), false);
  } finally {
    await h.dispose();
  }
});

test("snapshot groups keep their settings but charge the live per-resource pool cap", async () => {
  // Same resource id in the snapshot and live settings; the queue is paused.
  const live = settings({ ...LIVE, resource: "shared", maxConcurrent: 2 });
  const h = await harness(live);
  try {
    const r1 = settings({ ...R1, resource: "shared", maxConcurrent: 2 });
    const r1Expected = structuredClone(r1);
    const started = await h.sharedStart("call-capped", { tasks: [queuedTask("first"), queuedTask("second")] }, { config: r1, authorizedTools: ["read"] });
    assert.equal(started.isError, false, started.content[0].text);
    assert.equal(h.launches.length, 0, "the queue is paused");

    // Live: the shared resource drops to one slot; the global budget allows both.
    live.execution!.workerResources!.shared!.maxConcurrent = 1;
    live.execution!.maxWorkers = 4;
    h.controller.refreshPool();

    await waitFor(() => h.launches.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.launches.length, 1, "the second task waits for the live per-resource cap, not the admitted cap of 2");
    const first = h.launches[0]!;
    assert.equal(first.title, "first");
    assert.deepEqual(first.route, ["shared"]);
    assert.deepEqual(first.routeCaps, [1], "failover routes charge the live cap too");
    assert.equal(first.config.execution?.workerResources?.shared?.maxConcurrent, 1, "the wave failover config charges the live cap");
    assert.equal(first.config.maxCorrectionCycles, 2, "everything else stays on the R1 snapshot");
    assert.deepEqual(first.config.tools?.executorDeny, ["bash"]);
    assert.equal(first.digest, configDigest(r1Expected), "the digest is the unchanged snapshot's");

    h.settle(first.taskId);
    await waitFor(() => h.launches.length === 2);
    const second = h.launches[1]!;
    assert.equal(second.title, "second");
    assert.equal(second.leaseEntry, "shared");
    assert.equal(second.config.maxCorrectionCycles, 2);
    assert.equal(second.digest, configDigest(r1Expected));
    assert.deepEqual(r1, r1Expected, "the owner's snapshot object is never mutated");
    h.settle(second.taskId);
  } finally {
    await h.dispose();
  }
});

/** Adds a second, lower-priority resource to a single-resource settings fixture. */
function withFallback(config: ReviewGateConfig, fallbackCap: number): ReviewGateConfig {
  const primary = Object.keys(config.execution!.workerResources!)[0]!;
  const agent = `agent-${primary}`;
  config.execution!.workerResources!.fallback = { selection: { source: "external", id: agent }, maxConcurrent: fallbackCap };
  config.execution!.routes!.execute = [{ resourceId: primary }, { resourceId: "fallback" }];
  return config;
}

interface ControllerInternals {
  groups: Map<string, BackgroundExecutionGroup>;
  pool: ExecutorPoolScheduler;
  waveDeps: WaveLifecycleDeps;
  caps: { executor: { pinnedFailoverRoute(group: BackgroundExecutionGroup): (() => ExecutorPoolEntry[]) | undefined } };
}

const internals = (controller: BackgroundExecutionController) => controller as unknown as ControllerInternals;
const settleTurns = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a waiting snapshot-group failover charges the per-resource cap current at each attempt", async () => {
  const live = withFallback(settings({ ...LIVE, resource: "primary", maxConcurrent: 1 }), 2);
  const h = await harness(live);
  try {
    const r1 = withFallback(settings({ ...R1, resource: "primary", maxConcurrent: 1 }), 2);
    const native = await h.sharedStart("call-failover", { tasks: [queuedTask("native")] }, { config: r1, authorizedTools: ["read"] });
    assert.equal(native.isError, false, native.content[0].text);
    const plain = await h.piStart("pi-failover", { tasks: [queuedTask("plain")] });
    assert.equal(plain.isError, false, plain.content[0].text);
    const controller = internals(h.controller);
    const nativeGroup = controller.groups.get(native.details.executionId)!;
    const plainGroup = controller.groups.get(plain.details.executionId)!;

    // The exact callback the wave runner and operation continuation receive.
    assert.equal(controller.waveDeps.executor.pinnedFailoverRoute, controller.caps.executor.pinnedFailoverRoute);
    assert.equal(controller.caps.executor.pinnedFailoverRoute(plainGroup), undefined, "Pi/scheduled groups keep their launch-config failover route");
    const failoverRoute = controller.caps.executor.pinnedFailoverRoute(nativeGroup);
    assert.ok(failoverRoute);
    assert.deepEqual(failoverRoute().map((entry) => entry.entryId), ["primary", "fallback"]);

    // Two leases occupy the fallback at its admitted (and current) cap of 2.
    const pool = controller.pool;
    const fallbackOnly = () => failoverRoute().filter((entry) => entry.entryId === "fallback");
    const held = [pool.tryAcquireRoute(fallbackOnly()), pool.tryAcquireRoute(fallbackOnly())];
    assert.ok(held[0] && held[1]);

    // A failover off the primary waits; meanwhile the live fallback cap drops to 1.
    const primary: ExecutorPoolAssignment = { entry: failoverRoute()[0]!, priority: 0 };
    let granted: ExecutorPoolLease | undefined;
    let settled = false;
    const waiting = pool.acquireAfterRoute(primary, failoverRoute).then((lease) => { granted = lease; settled = true; });
    live.execution!.workerResources!.fallback!.maxConcurrent = 1;
    h.controller.refreshPool();
    await settleTurns();
    assert.equal(settled, false);

    held[0]!.release();
    await settleTurns();
    assert.equal(settled, false, "releasing one of two leases must not unblock a resource whose live cap is now 1");

    held[1]!.release();
    await waiting;
    assert.equal(granted?.entry.entryId, "fallback");
    assert.equal(granted?.entry.maxConcurrent, 1);
    assert.equal(granted?.entry.selection.source, "external");
    granted?.release();
  } finally {
    await h.dispose();
  }
});

test("pre-task parent snapshots of fresh and continued waves use the group's admitted capture budgets", async () => {
  const live = settings(LIVE);
  live.maxFileBytes = 9_001;
  live.maxSnapshotBytes = 90_001;
  const h = await harness(live);
  const captureModule = require("../src/capture") as typeof import("../src/capture");
  const original = captureModule.createWorkspaceSnapshot;
  const calls: Array<{ cwd: string; maxFileBytes: number; maxSnapshotBytes: number }> = [];
  try {
    const r1 = settings(R1);
    r1.maxFileBytes = 111;
    r1.maxSnapshotBytes = 2_222;
    const native = await h.sharedStart("call-capture", { tasks: [queuedTask("native")] }, { config: r1, authorizedTools: ["read"] });
    assert.equal(native.isError, false, native.content[0].text);
    const plain = await h.piStart("pi-capture", { tasks: [queuedTask("plain")] });
    assert.equal(plain.isError, false, plain.content[0].text);
    const controller = internals(h.controller);
    const nativeGroup = controller.groups.get(native.details.executionId)!;
    const plainGroup = controller.groups.get(plain.details.executionId)!;

    // Settings change after admission, while both groups wait in the paused queue.
    live.maxFileBytes = 7_777;
    live.maxSnapshotBytes = 77_777;

    captureModule.createWorkspaceSnapshot = (async (cwd: string, options: { maxFileBytes: number; maxSnapshotBytes: number }) => {
      calls.push({ cwd, maxFileBytes: options.maxFileBytes, maxSnapshotBytes: options.maxSnapshotBytes });
      return { files: new Map() };
    }) as unknown as typeof original;
    const state = { reviewWindow: { id: 1, activeExchange: { baseline: { kind: "snapshot", snapshot: { files: new Map() } } } } } as unknown as ReviewGateState;
    const stop = new Error("stop after the pre-task snapshot");
    const deps: WaveLifecycleDeps = {
      ...controller.waveDeps,
      state: () => state,
      steering: { ...controller.waveDeps.steering, prestart: async () => { throw stop; } },
    };
    const lease = { entry: { entryId: "unused", selection: { source: "external", id: "unused" }, maxConcurrent: 1 }, priority: 0, release() {} } as ExecutorPoolLease;
    for (const group of [nativeGroup, plainGroup]) {
      const task = group.tasks[0]!;
      await assert.rejects(runWaveTaskFresh(group, task, new AbortController(), lease, deps), stop);
      // The task has no pending continuation, so the continuation stops right after its snapshot.
      await assert.rejects(runWaveTaskContinuation(group, task, new AbortController(), lease, deps), /Continuation was interrupted/);
      assert.equal(task.state, "queued", "nothing past the snapshot ran");
    }
    assert.deepEqual(calls.map(({ maxFileBytes, maxSnapshotBytes }) => [maxFileBytes, maxSnapshotBytes]), [
      [111, 2_222], [111, 2_222],
      [7_777, 77_777], [7_777, 77_777],
    ], "native: admitted budgets for fresh and continued waves; Pi: live budgets");
  } finally {
    captureModule.createWorkspaceSnapshot = original;
    await h.dispose();
  }
});

test("Start settings are refused when malformed or supplied for any action but Start", async () => {
  const live = settings(LIVE);
  const h = await harness(live);
  try {
    const params = { tasks: [queuedTask("refused")] };
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const malformed: unknown[] = [
      null,
      { config: settings(R1) },
      // Cloneable (structuredClone keeps cycles) but not digestible by the dispatch pump.
      { config: { ...settings(R1), circular }, authorizedTools: ["read"] },
      { authorizedTools: ["read"] },
      { config: "not a record", authorizedTools: ["read"] },
      { config: settings(R1), authorizedTools: ["read", 7] },
      { config: settings(R1), authorizedTools: "read" },
      { config: { fn: () => 1 }, authorizedTools: ["read"] },
      { get config(): never { throw new Error("accessor"); }, authorizedTools: ["read"] },
    ];
    let index = 0;
    for (const raw of malformed) {
      const result = await h.sharedStart(`malformed-${index++}`, params, raw);
      assert.equal(result.isError, true, `malformed ${index}`);
      assert.match(result.content[0].text, /Start settings snapshot is invalid/);
    }
    // The admitted call's own startSettings accessor throws owner data.
    const throwingAdmission: ManagedToolAdmission = {
      resolveCall: (toolCallId, toolName) => toolCallId === "getter-call" && toolName === "SubtasksStart"
        ? Object.defineProperty(
          { params: structuredClone(params), startCallFingerprint: toolCallFingerprint("SubtasksStart", params) },
          "startSettings",
          { enumerable: true, get: () => { throw new Error(`owner accessor ${SENTINEL}`); } },
        ) as ManagedToolAdmittedCall
        : undefined,
    };
    const thrown = await h.manager.sharedManagedTool("start", throwingAdmission).invoke({ toolCallId: "getter-call" }) as Record<string, any>;
    assert.equal(thrown.isError, true);
    assert.match(thrown.content[0].text, /Start settings snapshot is invalid/);
    assert.equal(JSON.stringify(thrown).includes(SENTINEL), false, "the accessor's error never leaks");
    assert.equal(h.manager.associations().groupRoots?.length ?? 0, 0, "no group was created");

    const started = await h.sharedStart("valid", params, { config: settings(R1), authorizedTools: ["read"] });
    assert.equal(started.isError, false, started.content[0].text);
    const executionId = started.details.executionId as string;
    h.admission.admit("inspect-call", "SubtasksInspect", { executionId }, { config: settings(R1), authorizedTools: ["read"] });
    const inspected = await h.manager.sharedManagedTool("inspect", h.admission).invoke({ toolCallId: "inspect-call" }) as Record<string, any>;
    assert.equal(inspected.isError, true);
    assert.match(inspected.content[0].text, /cannot be honored by this action/);
  } finally {
    await h.dispose();
  }
});

test("a native Add snapshot sets only the added task's catalog and evidence policy; the task launches on its group's settings", async () => {
  const live = settings(LIVE);
  const h = await harness(live);
  try {
    const r1 = settings(R1);
    const r1Expected = structuredClone(r1);
    const started = await h.sharedStart("start-a", { tasks: [queuedTask("A")] }, { config: r1, authorizedTools: ["read", "bash", "edit"] });
    assert.equal(started.isError, false, started.content[0].text);
    const executionId = started.details.executionId as string;

    // A native top-off with newer settings, then a plain Pi top-off, into the same group.
    const r2 = snapshotWithSentinel(R2);
    const added = await h.sharedAdd("add-n", { executionId, tasks: [queuedTask("N")] }, { config: r2, authorizedTools: ["read", "grep", "write"] });
    assert.equal(added.isError, false, added.content[0].text);
    assert.deepEqual(added.details.addedTaskIds, [taskByTitle(h.controller, executionId, "N").taskId], "the new task id is reported");
    const piAdded = await h.piAdd("pi-add-p", { executionId, tasks: [queuedTask("P")] });
    assert.equal(piAdded.isError, false, piAdded.content[0].text);
    // Later edits to the owner's objects change nothing.
    r2.maxCorrectionCycles = 99;

    const catalogOf = (title: string) => taskByTitle(h.controller, executionId, title).definition.executorToolCatalog?.allowedToolCatalog;
    assert.deepEqual(catalogOf("A"), ["read", "edit"], "Start: R1 ceiling minus R1 executor deny");
    assert.deepEqual(catalogOf("N"), ["read", "write"], "native Add: R2 ceiling minus R2 executor deny");
    assert.deepEqual(catalogOf("P"), ["read", "bash", "grep", ...SUBTASK_TOOL_NAMES], "Pi Add reads the live ceiling");
    const policy = (shape: SettingsShape) => captureWorkerReviewEvidencePolicy(effectiveReviewEvidenceSettings(settings(shape)), "execute");
    assert.deepEqual(taskByTitle(h.controller, executionId, "A").definition.reviewEvidencePolicy, policy(R1));
    assert.deepEqual(taskByTitle(h.controller, executionId, "N").definition.reviewEvidencePolicy, policy(R2));
    assert.deepEqual(taskByTitle(h.controller, executionId, "P").definition.reviewEvidencePolicy, policy(LIVE));

    // Release the paused queue one slot at a time: every task of the group,
    // including both top-offs, launches on the group's admitted R1 settings.
    const changed = settings(CHANGED);
    for (const key of Object.keys(live) as Array<keyof ReviewGateConfig>) delete live[key];
    Object.assign(live, changed);
    h.controller.refreshPool();
    for (const [index, title] of ["A", "N", "P"].entries()) {
      await waitFor(() => h.launches.length === index + 1);
      const launch = h.launches[index]!;
      assert.equal(launch.title, title);
      assert.deepEqual(launch.route, ["r1"], `${title}: the group's route`);
      assert.deepEqual(launch.config, r1Expected, `${title}: the group's worker/reviewer launch config`);
      assert.equal(launch.digest, configDigest(r1Expected), `${title}: the group's digest`);
      h.settle(launch.taskId);
    }
    await waitFor(() => h.controller.inspect(executionId).tasks.every((task) => task.state === "landed"));

    const durable = await Promise.all((h.manager.associations().groupRoots ?? []).map(readTree));
    for (const text of durable) assert.equal(text.includes(SENTINEL), false, "the Add snapshot never reaches durable state");
    assert.equal(JSON.stringify([added, h.controller.inspect(executionId), h.notifications]).includes(SENTINEL), false);
  } finally {
    await h.dispose();
  }
});
