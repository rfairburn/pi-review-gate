/**
 * #682: the native MCP lane delegate that maps a host-proved lane context onto
 * the canonical shared managed tools (`src/session-host/native-managed-tool-delegate.ts`).
 *
 * EVIDENCE SCOPE: the real no-Pi `ExecutionToolManager` (built with
 * `hostExposure`), its real handler and `BackgroundExecutionController`, and —
 * in the last case — the real `InstanceManager` lane fencing with synthetic
 * PTYs, a fake launch provider, a fake broker-shaped registrar, and a synthetic
 * observer. The two census cases read the real per-owner host activity census
 * (`ExecutionToolManager.activityCensus()`) of their own manager around a
 * cancelled Start and Add; every other case keeps that census off. The lane
 * contexts in the other cases are hand-built fixtures whose
 * `isCurrent`/`signal` the test drives. Queued tasks never dispatch
 * (`maxWorkers = 0`); executions are started through the lane or directly
 * through the shared boundary. Native Start settings come from a synthetic
 * in-memory reader standing in for the host's persisted snapshot; no settings
 * file or owner construction is exercised. No MCP stdio transport, provider binary, persistence,
 * SessionHosts/Spawn, callback delivery, or main.ts activation is covered.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { effectiveReviewEvidenceSettings, normalizeConfig } from "../src/config";
import { captureWorkerReviewEvidencePolicy } from "../src/execution/review-evidence-policy";
import {
  EFFECT_GUARDED_ACTIONS,
  ExecutionToolManager,
  SHARED_MANAGED_TOOL_ACTIONS,
  EXECUTION_TOOL_NAMES,
  type ManagedStartSettings,
  type ManagedToolAdmission,
  type SharedManagedToolAction,
} from "../src/execution/tool";
import {
  NATIVE_LANE_FENCED_ACTIONS,
  createNativeManagedToolDelegate,
  unavailableNativeManagedToolScope,
  type NativeManagedToolScope,
  type NativeManagedToolScopeResolver,
} from "../src/session-host/native-managed-tool-delegate";
import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type NativeMcpLaneContext,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
} from "../src/session-host/instances";
import type { NativeMcpRegistration } from "../src/session-host/broker";
import type { NativeMcpArtifactCleanup, NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpToolEndpoint } from "../src/session-host/native-mcp-stdio";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import {
  EFFECT_GUARD_ADD_REVOKED,
  EFFECT_GUARD_CONTINUE_REVOKED,
  EFFECT_GUARD_FORCE_MERGE_REVOKED,
  EFFECT_GUARD_INSPECT_REVOKED,
  EFFECT_GUARD_MARK_CLEAN_REVOKED,
  EFFECT_GUARD_START_REVOKED,
  type HostActivityCensus,
  type HostActivityCensusRead,
} from "../src/execution/background-controller";
import { readGroup } from "../src/execution/background-group-store";
import { createState } from "../src/state";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import { EMPTY_ASSOCIATIONS, FixtureAdmission, SUBTASK_TOOL_NAMES, managedToolFixture, queuedTask } from "./managed-tool-fixtures";

const UUID_B = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
const UUID_C = "8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0";
const STALE = /no current proved lane context/;
const INVALID_SCOPE = /owner scope is invalid for this lane/;
const ALL_ACTIONS = [...SHARED_MANAGED_TOOL_ACTIONS];
const EXECUTION_ID = /exec-[0-9a-f]{8}-/;

const startArgs = (title: string) => ({ tasks: [queuedTask(title)] });
/** Masks live ids and numbers so two runs of the same request compare equal. */
const masked = (value: unknown) => JSON.stringify(value).replace(/\b(exec|task)-[0-9a-f-]+/g, "$1-<id>").replace(/\d+/g, "#");

function fixtureConfig() {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  });
  // Admission only: queued tasks never dispatch.
  config.execution!.maxWorkers = 0;
  return config;
}

type Binding = {
  toolCallId: string;
  ownerScopedInputsOnly: boolean;
  host?: unknown;
  effectGuard?: { isCurrent(): boolean; signal?: AbortSignal };
  admittedFingerprint?: () => unknown;
  startSettings?: { config: ReturnType<typeof fixtureConfig>; authorizedTools: readonly string[] };
  addSettings?: { config: ReturnType<typeof fixtureConfig>; authorizedTools: readonly string[] };
};
type Handler = (action: string, toolName: string, params: unknown, binding: Binding) => Promise<Record<string, unknown>>;

interface HostManager {
  manager: ExecutionToolManager;
  config: ReturnType<typeof fixtureConfig>;
  handlerCalls: Array<{ action: string; params: unknown; binding: Binding; result?: Record<string, unknown> }>;
  /** Admissions bound through the real manager, in order. */
  admissions: ManagedToolAdmission[];
  hooks: { allow?: (name: string) => boolean; onPolicy?: () => void; beforeHandler?: () => void | Promise<void>; onCwd?: () => void };
  /** Starts one queued group directly through the shared boundary (not the lane). */
  startDirect(title: string): Promise<string>;
  armedWatches(): string[];
  groupCount(): number;
  dispose(): Promise<void>;
}

const tempRoots: string[] = [];
test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

/** A trusted owner's existing manager: no Pi, explicit hostExposure, restored, synced. */
/**
 * `workspace` names an existing canonical owner workspace whose cleanup belongs to the caller.
 * `hostActivityCensus` opts this owner's manager into its own real host activity census
 * (the exact per-owner view a native host reads for its row); every other case keeps the
 * census off, exactly as before.
 */
async function hostManager(
  actions: SharedManagedToolAction[] = ["start", "watch"],
  workspace?: string,
  hostActivityCensus?: true,
): Promise<HostManager> {
  const sourceRoot = workspace ?? await mkdtemp(join(tmpdir(), "prg-native-managed-delegate-"));
  if (workspace === undefined) tempRoots.push(sourceRoot);
  const hooks: HostManager["hooks"] = {};
  const config = fixtureConfig();
  const manager = new ExecutionToolManager({
    pi: undefined,
    config,
    state: createState(),
    // Captured workspace; `onCwd` exists only to show why the scope contract requires that.
    cwd: () => {
      hooks.onCwd?.();
      return sourceRoot;
    },
    authorizedTools: () => ["read", "bash"],
    liveToolCallAllowed: (name) => {
      hooks.onPolicy?.();
      return (hooks.allow ?? ((candidate: string) => SUBTASK_TOOL_NAMES.includes(candidate)))(name);
    },
    hostExposure: { actions },
    ...(hostActivityCensus === undefined ? {} : { hostActivityCensus }),
  });
  const handlerCalls: HostManager["handlerCalls"] = [];
  const instance = manager as unknown as { executeAction: Handler };
  const original = instance.executeAction.bind(manager);
  instance.executeAction = async (action, toolName, params, binding) => {
    const entry: HostManager["handlerCalls"][number] = { action, params, binding };
    handlerCalls.push(entry);
    // Await only an async hook, so a synchronous path (Watch) stays synchronous after admission.
    const gate = hooks.beforeHandler?.();
    if (gate !== undefined) await gate;
    entry.result = await original(action, toolName, params, binding);
    return entry.result;
  };
  const admissions: ManagedToolAdmission[] = [];
  const bindShared = manager.sharedManagedTool.bind(manager);
  manager.sharedManagedTool = (action, admission) => {
    admissions.push(admission);
    return bindShared(action, admission);
  };
  await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
  manager.sync();
  const ownedRoots = new Set<string>();
  const collectRoots = () => {
    for (const root of manager.associations().groupRoots ?? []) ownedRoots.add(root);
  };
  let directCalls = 0;
  return {
    manager,
    config,
    handlerCalls,
    admissions,
    hooks,
    startDirect: async (title) => {
      const admission = new FixtureAdmission();
      const id = `direct-start-${++directCalls}`;
      admission.admit(id, "SubtasksStart", startArgs(title));
      // Recorded while the manager still owns them, so teardown removes them even after a detach.
      const result = await bindShared("start", admission).invoke({ toolCallId: id }).finally(collectRoots);
      assert.equal(result.isError, false, JSON.stringify(result.content));
      const executionId = (result.details as Record<string, unknown>).executionId;
      assert.equal(typeof executionId, "string");
      return executionId as string;
    },
    armedWatches: () => [...(manager as unknown as { controller: { wakes: { watches: Map<string, unknown> } } }).controller.wakes.watches.keys()],
    groupCount: () => {
      collectRoots();
      return manager.associations().groupRoots?.length ?? 0;
    },
    dispose: async () => {
      collectRoots();
      await manager.shutdown();
      await manager.detach();
      for (const root of ownedRoots) await rm(root, { recursive: true, force: true });
    },
  };
}

interface LaneFixture {
  context: NativeMcpLaneContext;
  revoke(): void;
  abort(): void;
}

function laneContext(identity: { rowId?: string; backend?: NativeCliBackend; workspace?: string; conversationId?: string } = {}): LaneFixture {
  const controller = new AbortController();
  let current = true;
  const context: NativeMcpLaneContext = Object.freeze({
    rowId: identity.rowId ?? "row-a",
    backend: identity.backend ?? "claude",
    workspace: identity.workspace ?? "/synthetic/workspace",
    conversationId: identity.conversationId ?? UUID_B,
    signal: controller.signal,
    isCurrent: () => current,
  });
  return { context, revoke: () => { current = false; }, abort: () => controller.abort() };
}

function ownerOf(context: NativeMcpLaneContext) {
  return { rowId: context.rowId, backend: context.backend, workspace: context.workspace, conversationId: context.conversationId };
}

/**
 * A fresh in-memory Start settings snapshot from the host fixture's
 * configuration. The fixture's test-only `maxWorkers = 0` is not a valid saved
 * setting, so the snapshot omits it; global concurrency stays live, and the
 * live configuration keeps queued tasks from dispatching.
 */
function snapshotOf(host: HostManager, authorizedTools: readonly string[] = ["read", "bash"]): ManagedStartSettings {
  const config = structuredClone(host.config);
  delete config.execution!.maxWorkers;
  return { config, authorizedTools: [...authorizedTools] };
}

/** A resolver for exactly one lane identity; any other context gets no scope. */
function exactResolver(
  lane: LaneFixture,
  host: HostManager,
  actions: SharedManagedToolAction[] = ["watch"],
  readStartSettings: () => ManagedStartSettings | undefined = () => snapshotOf(host),
) {
  const calls: NativeMcpLaneContext[] = [];
  const resolver: NativeManagedToolScopeResolver = (context) => {
    calls.push(context);
    if (context.rowId !== lane.context.rowId || context.conversationId !== lane.context.conversationId) return undefined;
    return { owner: ownerOf(context), manager: host.manager, actions, readStartSettings };
  };
  return { resolver, calls };
}

type ControllerInternals = {
  groups: Map<string, { tasks: Array<{ taskId: string; definition: { executorToolCatalog?: { allowedToolCatalog: string[] } } }> }>;
  groupSettings: WeakMap<object, unknown>;
  readonly startAdmissions: number;
  readonly saveTails: ReadonlyMap<string, Promise<void>>;
};
const controllerOf = (host: HostManager) => (host.manager as unknown as { controller: ControllerInternals }).controller;

/** The manager's own real host activity census, for a census-enabled fixture. */
function censusOf(host: HostManager): HostActivityCensus {
  const census = host.manager.activityCensus();
  assert.ok(census, "a host manager with its own census exposes it");
  return census;
}

test("the default delegate exposes nothing and reaches no manager", async () => {
  assert.equal(unavailableNativeManagedToolScope(laneContext().context), undefined);
  const delegate = createNativeManagedToolDelegate();
  const lane = laneContext();
  assert.deepEqual(await delegate.listTools(lane.context), []);
  assert.equal(await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: {} }), undefined);

  // An explicit resolver that has no scope for this lane is the same.
  const host = await hostManager();
  try {
    const { resolver } = exactResolver(laneContext({ rowId: "row-other" }), host);
    const scoped = createNativeManagedToolDelegate({ resolveScope: resolver });
    assert.deepEqual(await scoped.listTools(lane.context), []);
    assert.equal(await scoped.callTool(lane.context, { name: "SubtasksWatch", arguments: {} }), undefined);
    assert.equal(host.handlerCalls.length, 0);
  } finally {
    await host.dispose();
  }
  assert.throws(() => createNativeManagedToolDelegate({ resolveScope: "nope" as never }), /scope resolver function/);
});

test("guarded Start, Add, Inspect, Continue, Interrupt, ForceMerge, and MarkClean and lane-fenced Watch and Steer are offered; an action outside the scope stays unavailable", async () => {
  assert.deepEqual(NATIVE_LANE_FENCED_ACTIONS, ["start", "add", "inspect", "watch", "continue", "steer", "interrupt", "force_merge", "mark_clean"]);
  assert.ok(Object.isFrozen(NATIVE_LANE_FENCED_ACTIONS));
  // Every fenced action is either lane-guarded in the controller or commits synchronously (Watch, Steer).
  assert.deepEqual(NATIVE_LANE_FENCED_ACTIONS.filter((action) => !EFFECT_GUARDED_ACTIONS.includes(action)), ["watch", "steer"]);
  assert.deepEqual(ALL_ACTIONS.filter((candidate) => !NATIVE_LANE_FENCED_ACTIONS.includes(candidate)), []);
  const host = await hostManager(ALL_ACTIONS);
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ALL_ACTIONS).resolver });
    // The owner exposes and admits everything; the lane lists the fenced actions in canonical order.
    assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);

    // A scope that does not carry the recovery actions never offers them, even though the manager exposes them.
    const narrow = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ["start", "inspect"]).resolver });
    assert.deepEqual((await narrow.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
    const executionId = await host.startDirect("active");
    const ownTask = () => (host.manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string; state: string }> }> } })
      .controller.groups.get(executionId)!.tasks[0]!;
    const taskId = ownTask().taskId;
    const before = host.handlerCalls.length;
    for (const [action, args] of [
      ["interrupt", { executionId, taskId, interruptMode: "interrupt_as_failure" }],
      ["force_merge", { executionId, taskId }],
      ["mark_clean", {}],
    ] as const) {
      const outcome = await narrow.callTool(lane.context, { name: EXECUTION_TOOL_NAMES[action], arguments: args });
      assert.equal(outcome, undefined, `${action} is unavailable outside the scope`);
    }
    assert.equal(host.handlerCalls.length, before, "no unavailable action reached the handler");
    assert.equal(ownTask().state, "queued", "nothing was interrupted");
    assert.equal(host.groupCount(), 1, "the lane created no group");
  } finally {
    await host.dispose();
  }
});

test("Start through the lane runs the canonical handler with the raw snapshot identity and the lane as its effect guard", async () => {
  const host = await hostManager(["start", "inspect", "watch"]);
  const direct = await hostManager(["start", "inspect", "watch"]);
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ["start", "inspect", "watch"]).resolver });
    const canonical = direct.manager.sharedManagedTool("start", new FixtureAdmission());
    const listed = await delegate.listTools(lane.context);
    assert.deepEqual(listed[0], { name: canonical.name, description: canonical.description, inputSchema: canonical.parameters });
    assert.equal(host.handlerCalls.length, 0, "discovery reaches no handler");

    const args = startArgs("via lane");
    const fingerprint = toolCallFingerprint("SubtasksStart", args)!;
    const viaLane = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: args });
    const directAdmission = new FixtureAdmission();
    directAdmission.admit("direct-start", "SubtasksStart", args);
    const viaShared = await direct.manager.sharedManagedTool("start", directAdmission).invoke({ toolCallId: "direct-start" });
    assert.ok(viaLane);
    assert.deepEqual(Object.keys(viaLane).sort(), ["content", "isError"]);
    assert.equal(viaLane.isError, false, JSON.stringify(viaLane.content));
    assert.equal(masked(viaLane.content), masked(viaShared.content), "same canonical content");
    assert.equal(viaShared.isError, false);
    assert.equal(host.groupCount(), 1);

    const started = host.handlerCalls.at(-1)!;
    assert.equal(started.action, "start");
    assert.match(started.binding.toolCallId, /^native-mcp-call-[0-9a-f-]{36}$/);
    assert.equal(started.binding.ownerScopedInputsOnly, true);
    assert.equal(started.binding.host, undefined, "no synthetic Pi host context");
    assert.deepEqual(started.params, args);
    assert.notEqual(started.params, args, "the handler runs the owner's snapshot, not the caller's object");
    assert.equal(started.binding.admittedFingerprint?.(), fingerprint, "identity is the raw snapshot fingerprint");
    assert.equal(started.binding.effectGuard?.isCurrent(), true);
    // The controller recorded that identity on the group it attached.
    const liveness = host.manager.startLiveness(fingerprint);
    assert.equal(liveness.state, "active");
    const executionId = (liveness as { identity: string }).identity;
    assert.match(String(viaLane.content[0]!.text), new RegExp(executionId));
    // One use: replaying the same id now admits nothing.
    assert.equal(host.admissions.at(-1)!.resolveCall(started.binding.toolCallId, "SubtasksStart"), undefined);

    // The guard is the lane itself: revocation or abort turns it off for good.
    lane.revoke();
    assert.equal(started.binding.effectGuard?.isCurrent(), false);
    const aborted = laneContext();
    const abortedDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(aborted, host, ["start"]).resolver });
    await abortedDelegate.callTool(aborted.context, { name: "SubtasksStart", arguments: startArgs("aborted later") });
    const guard = host.handlerCalls.at(-1)!.binding.effectGuard!;
    assert.equal(guard.isCurrent(), true);
    aborted.abort();
    assert.equal(guard.isCurrent(), false);

    // Canonical validation failures keep the canonical shape and text.
    const fresh = laneContext();
    const freshDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(fresh, host, ["start"]).resolver });
    const invalid = await freshDelegate.callTool(fresh.context, { name: "SubtasksStart", arguments: { tasks: [] } });
    const invalidAdmission = new FixtureAdmission();
    invalidAdmission.admit("direct-invalid", "SubtasksStart", { tasks: [] });
    const invalidShared = await direct.manager.sharedManagedTool("start", invalidAdmission).invoke({ toolCallId: "direct-invalid" });
    assert.equal(invalid?.isError, true);
    assert.equal(masked(invalid?.content), masked(invalidShared.content));
  } finally {
    await host.dispose();
    await direct.dispose();
  }
});

test("a lane revoked after Start's admission, before the controller attaches, creates nothing", async () => {
  // Without a guard, a direct shared Start whose admission re-proved a lane
  // still commits after that lane is revoked mid-handler.
  const host = await hostManager(["start"]);
  try {
    const lane = laneContext();
    let admitted = false;
    const admission: ManagedToolAdmission = {
      resolveCall: (id, name) => {
        if (id !== "fence-1" || name !== "SubtasksStart" || !lane.context.isCurrent()) return undefined;
        admitted = true;
        return { params: startArgs("revoked mid-start"), startCallFingerprint: "a".repeat(64) };
      },
    };
    host.hooks.beforeHandler = () => lane.revoke();
    const result = await host.manager.sharedManagedTool("start", admission).invoke({ toolCallId: "fence-1" });
    assert.equal(admitted, true);
    assert.equal(result.isError, false, "the unguarded controller committed after the lane was revoked");
    assert.equal(host.groupCount(), 1);

    // Through the delegate the lane is the effect guard: the same revocation stops the controller.
    for (const revoke of ["revoke", "abort"] as const) {
      const fresh = laneContext();
      const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(fresh, host, ["start"]).resolver });
      host.hooks.beforeHandler = () => fresh[revoke]();
      await assert.rejects(delegate.callTool(fresh.context, { name: "SubtasksStart", arguments: startArgs(`via lane ${revoke}`) }), STALE);
      const refused = host.handlerCalls.at(-1)!;
      assert.equal(refused.action, "start");
      assert.equal(refused.result?.isError, true);
      assert.ok(JSON.stringify(refused.result?.content).includes(EFFECT_GUARD_START_REVOKED));
      assert.equal(host.groupCount(), 1, `${revoke}: no group was attached`);
    }
    host.hooks.beforeHandler = undefined;
  } finally {
    await host.dispose();
  }
});

test("an identical Start in flight or still active for the same owner is refused without a replay", async () => {
  const host = await hostManager(["start", "inspect", "watch"]);
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ["start", "inspect", "watch"]).resolver });
    const args = startArgs("once");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    host.hooks.beforeHandler = () => { entered(); return gate; };
    const first = delegate.callTool(lane.context, { name: "SubtasksStart", arguments: args });
    await reached;
    host.hooks.beforeHandler = undefined;

    // The first is admitted and in flight; no group exists yet for liveness to see.
    assert.equal(host.manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!).state, "inactive");
    const handled = host.handlerCalls.length;
    const inFlight = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: structuredClone(args) });
    assert.deepEqual(inFlight, {
      content: [{ type: "text", text: "SubtasksStart failed closed: an identical SubtasksStart request from this session is still in flight; wait for its result instead of starting it again; nothing was started or read." }],
      isError: true,
    });
    assert.equal(host.handlerCalls.length, handled, "the duplicate never entered the handler");
    // Key order is not identity; any different value is a different request.
    const reordered = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: { tasks: [Object.fromEntries(Object.entries(args.tasks[0]!).reverse())] } });
    assert.deepEqual(reordered, inFlight);
    const distinct = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("other") });
    assert.equal(distinct?.isError, false, JSON.stringify(distinct?.content));

    release();
    const settled = await first;
    assert.equal(settled?.isError, false, JSON.stringify(settled?.content));
    assert.equal(host.groupCount(), 2);

    // Settled and attached: the same request is now refused by the manager's liveness, naming its execution.
    const executionId = (host.manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { identity: string }).identity;
    const active = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: args });
    assert.deepEqual(active, {
      content: [{ type: "text", text: `SubtasksStart failed closed: an identical SubtasksStart request is already active as ${executionId}; nothing was started or read.` }],
      isError: true,
    });

    // A liveness lookup that cannot answer fails closed.
    const liveness = host.manager.startLiveness.bind(host.manager);
    host.manager.startLiveness = () => { throw new Error("liveness offline"); };
    const unknown = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("unverifiable") });
    host.manager.startLiveness = liveness;
    assert.match(String(unknown?.content[0]!.text), /could not be verified; nothing was started or read\.$/);
    assert.equal(host.groupCount(), 2, "no duplicate group was created");

    // A canonical refusal before admission is not masked by duplicate wording,
    // and a denied Start reads no liveness at all.
    host.hooks.allow = (name) => name !== "SubtasksStart";
    let reads = 0;
    host.manager.startLiveness = (fingerprint) => { reads += 1; return liveness(fingerprint); };
    const denied = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: args });
    host.manager.startLiveness = liveness;
    host.hooks.allow = undefined;
    assert.match(String(denied?.content[0]!.text), /not allowed by this owner's live call policy/);
    assert.doesNotMatch(JSON.stringify(denied), EXECUTION_ID);
    assert.equal(reads, 0);
  } finally {
    await host.dispose();
  }
});

test("every admitted native Start reads one fresh settings snapshot and the canonical manager runs on it", async () => {
  const host = await hostManager(["start", "inspect", "watch"]);
  try {
    const lane = laneContext();
    // Two host snapshots that differ in configuration and parent ceiling.
    const snapshots = [snapshotOf(host, ["read", "bash"]), snapshotOf(host, ["read", "grep"])];
    snapshots[0]!.config.maxCorrectionCycles = 3;
    snapshots[1]!.config.maxCorrectionCycles = 7;
    const served: ManagedStartSettings[] = [];
    const reader = () => {
      const next = snapshots[served.length];
      if (next !== undefined) served.push(next);
      return next;
    };
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ["start", "inspect", "watch"], reader).resolver });

    // Discovery proves exposure without reading settings.
    assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect", "SubtasksWatch"]);
    assert.equal(served.length, 0, "discovery never reads Start settings");

    const first = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("first snapshot") });
    assert.equal(first?.isError, false, JSON.stringify(first?.content));
    assert.equal(served.length, 1, "one read for one admitted Start");
    // The host edits its returned object after admission: the admitted Start is unaffected.
    snapshots[0]!.config.maxCorrectionCycles = 99;
    (snapshots[0]!.authorizedTools as string[]).push("write");
    const second = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("second snapshot") });
    assert.equal(second?.isError, false, JSON.stringify(second?.content));
    assert.equal(served.length, 2);

    const controller = controllerOf(host);
    const expectations = [
      { title: "first snapshot", cycles: 3, ceiling: ["read", "bash"] },
      { title: "second snapshot", cycles: 7, ceiling: ["read", "grep"] },
    ];
    const starts = host.handlerCalls.filter((call) => call.action === "start");
    assert.equal(starts.length, 2);
    for (const [index, expected] of expectations.entries()) {
      const binding = starts[index]!.binding;
      // The canonical boundary's own validated copy of exactly that read.
      assert.equal(binding.startSettings?.config.maxCorrectionCycles, expected.cycles);
      assert.deepEqual(binding.startSettings?.authorizedTools, expected.ceiling);
      assert.notEqual(binding.startSettings?.config, served[index]!.config, "copied by the boundary, not shared with the host");
      const fingerprint = toolCallFingerprint("SubtasksStart", startArgs(expected.title))!;
      assert.equal(binding.admittedFingerprint?.(), fingerprint);
      const executionId = (host.manager.startLiveness(fingerprint) as { identity: string }).identity;
      const group = controller.groups.get(executionId)!;
      assert.equal((controller.groupSettings.get(group) as { maxCorrectionCycles: number }).maxCorrectionCycles, expected.cycles, "the group runs on its admitted snapshot");
      assert.deepEqual(group.tasks[0]!.definition.executorToolCatalog?.allowedToolCatalog, expected.ceiling, "the task ceiling is the snapshot's");
    }

    // Refusals before admission read nothing: a duplicate, a denied Start, and Inspect/Watch.
    const duplicate = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("first snapshot") });
    assert.match(String(duplicate?.content[0]!.text), /already active/);
    host.hooks.allow = (name) => name !== "SubtasksStart";
    const denied = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("denied") });
    host.hooks.allow = undefined;
    assert.match(String(denied?.content[0]!.text), /not allowed by this owner's live call policy/);
    const executionId = (host.manager.startLiveness(toolCallFingerprint("SubtasksStart", startArgs("first snapshot"))!) as { identity: string }).identity;
    const watched = await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId, after: "1h" } });
    assert.equal(watched?.isError, false, JSON.stringify(watched?.content));
    assert.equal(host.handlerCalls.at(-1)!.binding.startSettings, undefined, "Watch carries no Start settings");
    assert.equal(served.length, 2, "no refused Start and no other action read settings");
    assert.equal(host.groupCount(), 2);
  } finally {
    await host.dispose();
  }
});

test("a Start whose settings are unavailable, invalid, throwing, or revoked during the read creates no group", async () => {
  const host = await hostManager(["start"]);
  try {
    const handled = () => host.handlerCalls.filter((call) => call.action === "start").length;
    const refusal = (diagnostic: string) => ({
      content: [{ type: "text", text: `SubtasksStart failed closed: ${diagnostic}; nothing was started or read.` }],
      isError: true,
    });
    const unreadable = refusal("the owner Start settings for this request could not be read");
    const invalid = refusal("the owner Start settings snapshot is invalid");
    const cases: Array<{ label: string; read: () => unknown; expected: unknown }> = [
      { label: "unavailable", read: () => undefined, expected: unreadable },
      { label: "throwing", read: () => { throw new Error("settings store offline"); }, expected: unreadable },
      // Synchronous policy only; the rejection is consumed, never left unhandled.
      { label: "rejecting async reader", read: async () => { throw new Error("settings store offline"); }, expected: invalid },
      { label: "resolving async reader", read: async () => snapshotOf(host), expected: invalid },
      { label: "not a record", read: () => "settings", expected: invalid },
      { label: "null", read: () => null, expected: invalid },
      { label: "no config", read: () => ({ authorizedTools: ["read"] }), expected: invalid },
      { label: "no ceiling", read: () => ({ config: snapshotOf(host).config }), expected: invalid },
      { label: "throwing accessor", read: () => ({ get config() { throw new Error("torn"); }, authorizedTools: ["read"] }), expected: invalid },
    ];
    for (const { label, read, expected } of cases) {
      const lane = laneContext();
      let reads = 0;
      const delegate = createNativeManagedToolDelegate({
        resolveScope: exactResolver(lane, host, ["start"], () => { reads += 1; return read() as ManagedStartSettings; }).resolver,
      });
      const args = startArgs(`settings ${label}`);
      assert.deepEqual(await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: args }), expected, label);
      assert.equal(reads, 1, `${label}: read once`);
      assert.equal(host.manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!).state, "inactive", label);
    }

    // A well-shaped answer the canonical boundary cannot honor is refused there, before the handler.
    const lane = laneContext();
    const malformed = createNativeManagedToolDelegate({
      resolveScope: exactResolver(lane, host, ["start"], () => ({ config: snapshotOf(host).config, authorizedTools: [42 as unknown as string] })).resolver,
    });
    const refused = await malformed.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("boundary refusal") });
    assert.match(String(refused?.content[0]!.text), /owner Start settings snapshot is invalid or cannot be honored/);

    // Revoked or aborted while the owner read settings: refused, and the call rejects as stale.
    for (const revoke of ["revoke", "abort"] as const) {
      const racing = laneContext();
      let reads = 0;
      const delegate = createNativeManagedToolDelegate({
        resolveScope: exactResolver(racing, host, ["start"], () => {
          reads += 1;
          racing[revoke]();
          return snapshotOf(host);
        }).resolver,
      });
      await assert.rejects(delegate.callTool(racing.context, { name: "SubtasksStart", arguments: startArgs(`read ${revoke}`) }), STALE, revoke);
      assert.equal(reads, 1, revoke);
    }
    assert.equal(handled(), 0, "no settings refusal reached the handler");
    assert.equal(host.groupCount(), 0, "no group was created");

    // A refused Start reserves nothing: the same request starts once settings are available.
    const retryLane = laneContext();
    let available = false;
    const retry = createNativeManagedToolDelegate({
      resolveScope: exactResolver(retryLane, host, ["start"], () => available ? snapshotOf(host) : undefined).resolver,
    });
    const args = startArgs("retry after settings");
    assert.deepEqual(await retry.callTool(retryLane.context, { name: "SubtasksStart", arguments: args }), unreadable);
    available = true;
    const started = await retry.callTool(retryLane.context, { name: "SubtasksStart", arguments: args });
    assert.equal(started?.isError, false, JSON.stringify(started?.content));
    assert.equal(host.groupCount(), 1);
  } finally {
    await host.dispose();
  }
});

test("a scope without a usable Start settings reader offers no Start, and its Inspect and Watch are unaffected", async () => {
  const host = await hostManager(["start", "inspect", "watch"]);
  try {
    const executionId = await host.startDirect("owner work");
    const taskId = controllerOf(host).groups.get(executionId)!.tasks[0]!.taskId;
    const handled = host.handlerCalls.length;
    const lane = laneContext();
    const cases: Array<[string, () => unknown]> = [
      ["absent", () => undefined],
      ["a value, not a reader", () => snapshotOf(host)],
      ["throwing reader property", () => { throw new Error("settings unavailable"); }],
    ];
    for (const [label, getReader] of cases) {
      let lookups = 0;
      const delegate = createNativeManagedToolDelegate({
        resolveScope: (context) => ({
          owner: ownerOf(context),
          manager: host.manager,
          actions: ["start", "inspect", "watch"],
          get readStartSettings() { lookups += 1; return getReader(); },
        } as unknown as NativeManagedToolScope),
      });
      assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksInspect", "SubtasksWatch"], label);
      assert.equal(await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs(`no reader ${label}`) }), undefined, `${label}: Start is not exposed`);
      assert.equal(lookups, 2, `${label}: discovery and the Start call each looked it up once`);
      const inspected = await delegate.callTool(lane.context, { name: "SubtasksInspect", arguments: { executionId, taskId } });
      assert.equal(inspected?.isError, false, JSON.stringify(inspected?.content));
      const watched = await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId, after: "1h" } });
      assert.equal(watched?.isError, false, JSON.stringify(watched?.content));
      assert.equal(lookups, 2, `${label}: Inspect and Watch never read the reader property`);
    }
    assert.deepEqual(host.handlerCalls.slice(handled).map((call) => call.action), cases.flatMap(() => ["inspect", "watch"]));
    assert.equal(host.groupCount(), 1, "no Start ran through the lane");

    // A reader that would fail is never invoked by the other actions either.
    let reads = 0;
    const failing = createNativeManagedToolDelegate({
      resolveScope: exactResolver(lane, host, ["start", "inspect", "watch"], () => { reads += 1; throw new Error("settings offline"); }).resolver,
    });
    assert.deepEqual((await failing.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect", "SubtasksWatch"]);
    assert.equal((await failing.callTool(lane.context, { name: "SubtasksInspect", arguments: { executionId, taskId } }))?.isError, false);
    assert.equal((await failing.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId, after: "1h" } }))?.isError, false);
    assert.equal(reads, 0);
  } finally {
    await host.dispose();
  }
});

test("a settings snapshot that fails the strict settings schema is refused before any group exists", async () => {
  const host = await hostManager(["start"]);
  try {
    const lane = laneContext();
    const malformed = (mutate: (config: Record<string, any>) => void) => () => {
      const snapshot = snapshotOf(host, ["read", "bash"]);
      mutate(snapshot.config as unknown as Record<string, any>);
      return snapshot;
    };
    const invalid = {
      content: [{ type: "text", text: "SubtasksStart failed closed: the owner Start settings snapshot is invalid; nothing was started or read." }],
      isError: true,
    };
    const cases: Array<[string, () => ManagedStartSettings]> = [
      // Cloneable and digestible, but a string deny list would become a set of characters.
      ["string executor deny list", malformed((config) => { config.tools = { ...config.tools, executorDeny: "bash" }; })],
      ["test-only maxWorkers", malformed((config) => { config.execution.maxWorkers = 0; })],
      ["non-boolean enabled", malformed((config) => { config.enabled = "yes"; })],
      // The parser would default it; an incomplete snapshot is refused, not repaired.
      ["missing correction budget", malformed((config) => { delete config.maxCorrectionCycles; })],
      ["undefined retention", malformed((config) => { config.retainBundles = undefined; })],
      // A clone keeps a Map, which the parser would read as an empty tools section.
      ["Map executor deny section", malformed((config) => { config.tools = new Map([["executorDeny", ["bash"]]]); })],
    ];
    for (const [label, read] of cases) {
      const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ["start"], read).resolver });
      assert.deepEqual(await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs(label) }), invalid, label);
    }
    assert.equal(host.handlerCalls.length, 0, "no malformed snapshot reached the handler");
    assert.equal(host.groupCount(), 0, "no group was created");

    // The same snapshot with a well-formed deny list is admitted and enforced;
    // an omitted optional setting needs no materializing.
    const valid = createNativeManagedToolDelegate({
      resolveScope: exactResolver(lane, host, ["start"], malformed((config) => {
        config.tools = { ...config.tools, executorDeny: ["bash"] };
        delete config.youShouldKnow;
      })).resolver,
    });
    const started = await valid.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("valid deny list") });
    assert.equal(started?.isError, false, JSON.stringify(started?.content));
    const executionId = (host.manager.startLiveness(toolCallFingerprint("SubtasksStart", startArgs("valid deny list"))!) as { identity: string }).identity;
    const group = controllerOf(host).groups.get(executionId)!;
    assert.deepEqual(group.tasks[0]!.definition.executorToolCatalog?.allowedToolCatalog, ["read"], "the snapshot's deny list removed bash");
  } finally {
    await host.dispose();
  }
});

test("an identical Start re-entering admission during the settings read is refused as in flight", async () => {
  const host = await hostManager(["start"]);
  try {
    const lane = laneContext();
    const args = startArgs("reentrant");
    let reads = 0;
    let nested: Promise<unknown> | undefined;
    let delegate!: ReturnType<typeof createNativeManagedToolDelegate>;
    const reader = () => {
      reads += 1;
      // Owner code re-enters the same delegate for the same manager and request.
      nested ??= delegate.callTool(lane.context, { name: "SubtasksStart", arguments: structuredClone(args) });
      return snapshotOf(host);
    };
    delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ["start"], reader).resolver });
    const outer = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: args });
    assert.equal(outer?.isError, false, JSON.stringify(outer?.content));
    assert.ok(nested);
    assert.deepEqual(await nested, {
      content: [{ type: "text", text: "SubtasksStart failed closed: an identical SubtasksStart request from this session is still in flight; wait for its result instead of starting it again; nothing was started or read." }],
      isError: true,
    });
    assert.equal(reads, 1, "the nested duplicate never read settings");
    assert.equal(host.handlerCalls.filter((call) => call.action === "start").length, 1, "only one Start reached the handler");
    assert.equal(host.groupCount(), 1);

  } finally {
    await host.dispose();
  }
});

test("Inspect through the lane is canonical, guarded by the lane, and confined to its own owner's manager", async () => {
  const hostA = await hostManager(["start", "inspect", "watch"]);
  const hostB = await hostManager(["start", "inspect", "watch"]);
  try {
    const laneA = laneContext({ conversationId: UUID_B });
    const laneB = laneContext({ conversationId: UUID_C });
    const resolveScope: NativeManagedToolScopeResolver = (context) => {
      const host = context.conversationId === UUID_B ? hostA : context.conversationId === UUID_C ? hostB : undefined;
      return host && { owner: ownerOf(context), manager: host.manager, actions: ["start", "inspect", "watch"], readStartSettings: () => snapshotOf(host) };
    };
    const delegate = createNativeManagedToolDelegate({ resolveScope });
    const args = startArgs("shared request");
    const startedA = await delegate.callTool(laneA.context, { name: "SubtasksStart", arguments: args });
    assert.equal(startedA?.isError, false);
    const executionA = (hostA.manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { identity: string }).identity;
    const taskA = /\btask-[0-9a-f-]+/.exec(String(startedA?.content[0]!.text))?.[0];
    assert.ok(taskA, "the lane result carries the stable task handle");
    const inspectA = { executionId: executionA, taskId: taskA };

    // Inspect on its own lane: the canonical handler, guarded by that lane.
    const inspected = await delegate.callTool(laneA.context, { name: "SubtasksInspect", arguments: inspectA });
    assert.equal(inspected?.isError, false, JSON.stringify(inspected?.content));
    assert.match(String(inspected?.content[0]!.text), new RegExp(executionA));
    const call = hostA.handlerCalls.at(-1)!;
    assert.equal(call.action, "inspect");
    assert.equal(call.binding.ownerScopedInputsOnly, true);
    assert.equal(call.binding.effectGuard?.isCurrent(), true);
    assert.equal(call.binding.admittedFingerprint?.(), undefined, "Inspect admits no Start identity");
    assert.equal(call.binding.startSettings, undefined, "Inspect carries no Start settings");

    // The other conversation reaches only its own manager: A's execution is unknown there,
    // and the duplicate exclusion is per owner, so B may start the same request itself.
    const handledA = hostA.handlerCalls.length;
    const foreign = await delegate.callTool(laneB.context, { name: "SubtasksInspect", arguments: inspectA });
    assert.equal(foreign?.isError, true);
    assert.equal(hostA.handlerCalls.length, handledA, "the other lane never reached A's manager");
    const startedB = await delegate.callTool(laneB.context, { name: "SubtasksStart", arguments: args });
    assert.equal(startedB?.isError, false, JSON.stringify(startedB?.content));
    assert.equal(hostA.groupCount(), 1);
    assert.equal(hostB.groupCount(), 1);
    // An unscoped conversation gets nothing.
    const stranger = laneContext({ conversationId: randomUUID() });
    assert.equal(await delegate.callTool(stranger.context, { name: "SubtasksInspect", arguments: inspectA }), undefined);

    // Revoked after admission, before the controller reads: refused by the guard, result withheld.
    hostA.hooks.beforeHandler = () => laneA.revoke();
    await assert.rejects(delegate.callTool(laneA.context, { name: "SubtasksInspect", arguments: inspectA }), STALE);
    hostA.hooks.beforeHandler = undefined;
    const refused = hostA.handlerCalls.at(-1)!;
    assert.equal(refused.action, "inspect");
    assert.equal(refused.result?.isError, true);
    assert.ok(JSON.stringify(refused.result?.content).includes(EFFECT_GUARD_INSPECT_REVOKED));
  } finally {
    await hostA.dispose();
    await hostB.dispose();
  }
});

test("Watch maps to the canonical definition and handler with host-assigned one-use admission", async () => {
  const host = await hostManager();
  const direct = await hostManager();
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host).resolver });

    const canonical = direct.manager.sharedManagedTool("watch", new FixtureAdmission());
    assert.deepEqual(await delegate.listTools(lane.context), [
      { name: canonical.name, description: canonical.description, inputSchema: canonical.parameters },
    ]);
    assert.equal(host.handlerCalls.length, 0, "discovery reaches no handler");

    const executionId = await host.startDirect("watched");
    const directExecutionId = await direct.startDirect("watched");
    const args = { executionId, after: "1h" };
    const viaLane = await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: args });
    const directAdmission = new FixtureAdmission();
    directAdmission.admit("direct-watch", "SubtasksWatch", { executionId: directExecutionId, after: "1h" });
    const viaShared = await direct.manager.sharedManagedTool("watch", directAdmission).invoke({ toolCallId: "direct-watch" });
    assert.ok(viaLane);
    assert.deepEqual(Object.keys(viaLane).sort(), ["content", "isError"], "no details, structuredContent, or debug fields");
    assert.equal(viaLane.isError, false);
    assert.equal(masked(viaLane.content), masked(viaShared.content), "same canonical content");
    assert.match(String(viaLane.content[0]!.text), /^SubtasksWatch armed for exec-/);
    assert.deepEqual(host.armedWatches(), [executionId]);

    const watched = host.handlerCalls.at(-1)!;
    assert.equal(watched.action, "watch");
    assert.match(watched.binding.toolCallId, /^native-mcp-call-[0-9a-f-]{36}$/);
    assert.equal(watched.binding.ownerScopedInputsOnly, true);
    assert.equal(watched.binding.host, undefined, "no synthetic Pi host context");
    assert.deepEqual(watched.params, args);
    assert.notEqual(watched.params, args, "the handler runs the owner's snapshot, not the caller's object");
    // One use: replaying the same id now admits nothing.
    assert.equal(host.admissions.at(-1)!.resolveCall(watched.binding.toolCallId, "SubtasksWatch"), undefined);

    // Canonical validation failures keep the canonical shape and text.
    const invalid = await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId, after: "1ms" } });
    const invalidAdmission = new FixtureAdmission();
    invalidAdmission.admit("direct-invalid", "SubtasksWatch", { executionId: directExecutionId, after: "1ms" });
    const invalidShared = await direct.manager.sharedManagedTool("watch", invalidAdmission).invoke({ toolCallId: "direct-invalid" });
    assert.equal(invalid?.isError, true);
    assert.match(String(invalid?.content[0]!.text), /^Invalid SubtasksWatch request: /);
    assert.equal(masked(invalid?.content), masked(invalidShared.content));
  } finally {
    await host.dispose();
    await direct.dispose();
  }
});

test("why Watch requires a side-effect-free owner cwd: the controller reads it after admission, before arming", async () => {
  const host = await hostManager();
  try {
    const executionId = await host.startDirect("active");
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host).resolver });
    // A manager whose cwd() re-enters lifecycle code breaks the contract: revoking
    // the lane there is past every lane check, so the watch arms and only the
    // result is withheld. A resolver must not offer Watch for such a manager.
    host.hooks.onCwd = () => lane.revoke();
    await assert.rejects(delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId, after: "1h" } }), STALE);
    host.hooks.onCwd = undefined;
    assert.deepEqual(host.armedWatches(), [executionId], "withholding is not cancellation");
  } finally {
    await host.dispose();
  }
});

test("discovery advertises only actions the canonical binding actually exposes and allows", async () => {
  // The manager exposes only Inspect; the resolver claims Watch and Inspect.
  const inspectOnly = await hostManager(["inspect"]);
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, inspectOnly, ["watch", "inspect"]).resolver });
    assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksInspect"], "binding success is not exposure");
    const refused = await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId: "exec-x", after: "1h" } });
    assert.deepEqual(refused, {
      content: [{ type: "text", text: "SubtasksWatch failed closed: SubtasksWatch is not currently exposed by this owner; nothing was started or read." }],
      isError: true,
    });
    assert.equal(await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("unclaimed") }), undefined, "start is not claimed by the resolver");
    assert.equal(inspectOnly.handlerCalls.length, 0);
  } finally {
    await inspectOnly.dispose();
  }

  const host = await hostManager();
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host).resolver });
    const executionId = await host.startDirect("active");
    const handled = host.handlerCalls.length;

    // Live policy denies Watch: not listed, and a call gets the canonical refusal with no execution id.
    host.hooks.allow = (name) => name !== "SubtasksWatch";
    assert.deepEqual(await delegate.listTools(lane.context), []);
    const denied = await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId, after: "1h" } });
    assert.deepEqual(denied, {
      content: [{ type: "text", text: "SubtasksWatch failed closed: SubtasksWatch is not allowed by this owner's live call policy; nothing was started or read." }],
      isError: true,
    });
    assert.doesNotMatch(JSON.stringify(denied), EXECUTION_ID);
    host.hooks.allow = undefined;

    // An unresolvable pool is the same.
    const resources = host.config.execution!.workerResources;
    host.config.execution!.workerResources = {};
    host.manager.sync();
    assert.deepEqual(await delegate.listTools(lane.context), []);
    host.config.execution!.workerResources = resources;
    host.manager.sync();
    assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksWatch"]);
    assert.equal(host.handlerCalls.length, handled, "discovery and refusals never entered the handler");
    assert.deepEqual(host.armedWatches(), []);

    // The owner scope closes during the probe's policy read while the lane stays
    // current: the binding reached the probe, then refused on its owner-scope check.
    let detaching: Promise<void> | undefined;
    host.hooks.onPolicy = () => { detaching ??= host.manager.detach(); };
    const listed = await delegate.listTools(lane.context);
    await detaching;
    host.hooks.onPolicy = undefined;
    assert.equal(lane.context.isCurrent(), true);
    assert.deepEqual(listed, [], "a binding whose scope closed during the probe is not advertised");
  } finally {
    await host.dispose();
  }
});

test("a stale, aborted, or revoked-before-admission lane context never reaches the handler", async () => {
  const host = await hostManager();
  try {
    const executionId = await host.startDirect("active");
    const handled = host.handlerCalls.length;
    const watch = { name: "SubtasksWatch", arguments: { executionId, after: "1h" } };

    const stale = laneContext();
    const { resolver, calls } = exactResolver(stale, host);
    const delegate = createNativeManagedToolDelegate({ resolveScope: resolver });
    stale.revoke();
    await assert.rejects(delegate.listTools(stale.context), STALE);
    await assert.rejects(delegate.callTool(stale.context, watch), STALE);
    assert.equal(calls.length, 0, "refused before the resolver is consulted");

    const aborted = laneContext();
    const abortedDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(aborted, host).resolver });
    aborted.abort();
    await assert.rejects(abortedDelegate.callTool(aborted.context, watch), STALE);

    // Revoked while the resolver answered: refused before the manager is queried.
    // Each case uses a fresh lane, so the refusal comes after the resolver ran.
    let policyReads = 0;
    host.hooks.onPolicy = () => { policyReads += 1; };
    for (const operation of ["call", "list"] as const) {
      const racing = laneContext();
      let resolved = 0;
      const racingDelegate = createNativeManagedToolDelegate({
        resolveScope: (context) => {
          resolved += 1;
          racing.revoke();
          return { owner: ownerOf(context), manager: host.manager, actions: ["watch"] };
        },
      });
      await assert.rejects(
        operation === "call" ? racingDelegate.callTool(racing.context, watch) : racingDelegate.listTools(racing.context),
        STALE,
        operation,
      );
      assert.equal(resolved, 1, `${operation}: the resolver ran before the refusal`);
    }
    host.hooks.onPolicy = undefined;
    assert.equal(policyReads, 0, "neither call nor discovery queries the manager after resolver-time revocation");

    // Revoked at the manager's live policy read, the last step before it resolves
    // admission: the admission refuses, nothing is armed, and the call rejects.
    const late = laneContext();
    const lateDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(late, host).resolver });
    host.hooks.onPolicy = () => late.revoke();
    await assert.rejects(lateDelegate.callTool(late.context, watch), STALE);
    host.hooks.onPolicy = undefined;

    // Revoked during discovery's policy read: the list is refused, not returned.
    const listing = laneContext();
    const listingDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(listing, host).resolver });
    host.hooks.onPolicy = () => listing.revoke();
    await assert.rejects(listingDelegate.listTools(listing.context), STALE);
    host.hooks.onPolicy = undefined;

    assert.equal(host.handlerCalls.length, handled);
    assert.deepEqual(host.armedWatches(), []);
  } finally {
    await host.dispose();
  }
});

test("a scope for a different identity, a malformed scope, or a failing resolver refuses the call", async () => {
  const host = await hostManager();
  try {
    const lane = laneContext();
    const watch = { name: "SubtasksWatch", arguments: { executionId: "exec-x", after: "1h" } };
    const expect = async (scope: unknown, pattern: RegExp, label: string) => {
      const delegate = createNativeManagedToolDelegate({ resolveScope: () => scope as NativeManagedToolScope });
      await assert.rejects(delegate.callTool(lane.context, watch), pattern, label);
      await assert.rejects(delegate.listTools(lane.context), pattern, `${label} (list)`);
    };
    const base = { owner: ownerOf(lane.context), manager: host.manager, actions: ["watch"] };
    await expect({ ...base, owner: { ...base.owner, conversationId: UUID_C } }, INVALID_SCOPE, "other conversation");
    await expect({ ...base, owner: { ...base.owner, rowId: "row-b" } }, INVALID_SCOPE, "other row");
    await expect({ ...base, owner: { ...base.owner, backend: "codex" } }, INVALID_SCOPE, "other backend");
    await expect({ ...base, owner: { ...base.owner, workspace: "/elsewhere" } }, INVALID_SCOPE, "other workspace");
    await expect({ manager: host.manager, actions: ["watch"] }, INVALID_SCOPE, "no owner echo");
    await expect({ ...base, manager: {} }, INVALID_SCOPE, "not a manager");
    await expect({ ...base, manager: { sharedManagedTool: host.manager.sharedManagedTool }, actions: ["start", "watch"], readStartSettings: () => snapshotOf(host) }, INVALID_SCOPE, "Start without startLiveness");
    await expect({ ...base, actions: [] }, INVALID_SCOPE, "no actions");
    await expect({ ...base, actions: ["watch", "watch"] }, INVALID_SCOPE, "duplicate action");
    await expect({ ...base, actions: ["watch", "deploy"] }, INVALID_SCOPE, "unknown action");
    await expect({ ...base, actions: [, "watch"] }, INVALID_SCOPE, "holey actions");
    await expect("scope", INVALID_SCOPE, "not a record");

    const throwing = createNativeManagedToolDelegate({ resolveScope: () => { throw new Error("owner store offline"); } });
    await assert.rejects(throwing.callTool(lane.context, watch), /could not be resolved/);
    await assert.rejects(throwing.listTools(lane.context), /could not be resolved/);

    assert.equal(host.handlerCalls.length, 0);
  } finally {
    await host.dispose();
  }
});

test("an expired owner scope refuses to bind for discovery and calls", async () => {
  const host = await hostManager();
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host).resolver });
    const executionId = await host.startDirect("active");
    await host.manager.detach();
    const handled = host.handlerCalls.length;
    await assert.rejects(delegate.listTools(lane.context), /owner session is not live/);
    await assert.rejects(delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId, after: "1h" } }), /owner session is not live/);
    assert.equal(host.handlerCalls.length, handled);
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// Real InstanceManager lane: the delegate as `NativeMcpLaneOwner.delegate`.
// ---------------------------------------------------------------------------

class SpyPty implements InstancePty {
  static #nextPid = 960_000;
  readonly pid: number;
  cols: number;
  rows: number;
  exited = false;
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
  }
  onData(): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => undefined };
  }
  on(): void { /* unused */ }
  removeListener(): void { /* unused */ }
  write(): void { /* unused */ }
  resize(): void { /* unused */ }
  pause(): void { /* unused */ }
  resume(): void { /* unused */ }
  kill(signal?: string): void {
    if (!this.exited && (signal ?? "SIGHUP") === "SIGTERM") {
      this.exited = true;
      for (const listener of [...this.#exitListeners]) listener({ exitCode: 15 });
    }
  }
}

class SpyObserver implements NativeStatusObserver {
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(): void { /* unused */ }
  acceptFailure(): void { /* unused */ }
  dispose(): void { /* unused */ }
  identity(value: string): boolean {
    const emit = this.context.emitConversationIdentity;
    assert.ok(emit);
    return emit(value);
  }
}

test("through the real InstanceManager lane, only the proved row's own manager is reached, and revocation ends it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-native-managed-lane-")));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic fixture; never executed.\n", "utf8");
  }
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  for (const dir of [home, join(root, "agent"), workspace]) mkdirSync(dir, { recursive: true });

  const sources: Array<{ instanceId: string; endpoint: NativeMcpToolEndpoint; released: number }> = [];
  const observers = new Map<string, SpyObserver>();
  // The trusted owner's host-scoped managers, keyed by the exact row and conversation.
  const owned = new Map<string, HostManager>();
  // The owner's manager is built for the lane's own canonical workspace.
  const host = await hostManager(["start", "watch"], workspace);
  const delegate = createNativeManagedToolDelegate({
    resolveScope: (context) => {
      assert.equal(context.workspace, workspace, "the lane's canonical workspace is the manager's");
      const manager = owned.get(`${context.rowId}\0${context.conversationId}`);
      return manager && { owner: ownerOf(context), manager: manager.manager, actions: ["start", "watch"], readStartSettings: () => snapshotOf(manager) };
    },
  });
  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: {
      register: (instanceId) => ({
        bootstrap: { version: 1, socketPath: `/synthetic/pi/${instanceId}.sock`, token: randomBytes(32).toString("hex"), instanceId, generation: randomUUID() },
        release: () => undefined,
      }),
    },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: join(root, "agent") },
    args: [],
    nativeCliLaunch: (backend, request) => ({
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: home },
      cwd: request.workspace,
      ...(request.nativeMcp === undefined ? {} : {
        nativeMcp: {
          mcp: "prepared",
          backend,
          route: "claude-mcp-config-file",
          placement: "claude-tui",
          serverName: request.nativeMcp.serverName,
          args: [],
          lease: { root: "/synthetic/mcp", bootstrapFile: "/synthetic/mcp/bootstrap.json", cleanup: async () => ({ removed: true }) as unknown as NativeMcpArtifactCleanup },
        } as unknown as NativeMcpLaunchOutcome,
      }),
    }),
    nativeHookRegistrar: {
      registerNativeHookSource: (instanceId, backend) => ({
        bootstrap: { version: 1, socketPath: `/synthetic/native/${instanceId}.sock`, generation: randomUUID(), instanceId, backend, token: randomBytes(32).toString("hex") },
        release: () => undefined,
      }),
    },
    nativeStatusObserverFactory: (context) => {
      const observer = new SpyObserver(context);
      observers.set(context.rowId, observer);
      return observer;
    },
    nativeMcpLane: {
      serverName: `pi_review_gate_${"a1".repeat(16)}`,
      delegate,
      registrar: {
        registerNativeMcpSource: (instanceId, backend, endpoint): NativeMcpRegistration => {
          const source = { instanceId, endpoint, released: 0 };
          sources.push(source);
          return {
            bootstrap: { version: 1, type: "native_mcp_bootstrap", socketPath: `/synthetic/native-mcp/${instanceId}.sock`, generation: randomUUID(), instanceId, backend, token: randomBytes(32).toString("hex") },
            release: () => { source.released += 1; },
          } as NativeMcpRegistration;
        },
      },
    },
    ptyFactory: (descriptor) => new SpyPty(descriptor),
  });
  try {
    const executionId = await host.startDirect("owner work");
    const handled = host.handlerCalls.length;
    const id = await manager.create({ workspace, backend: "claude" } as CreateInstanceOptions);
    const source = sources.find((candidate) => candidate.instanceId === id);
    assert.ok(source);
    const signal = () => new AbortController().signal;
    const watch = () => source.endpoint.callTool({ name: "SubtasksWatch", arguments: { executionId, after: "1h" }, signal: signal() });

    // Unproved: the lane refuses before the delegate.
    await assert.rejects(watch(), /native MCP lane/);

    const observer = observers.get(id);
    assert.ok(observer);
    assert.equal(observer.identity(UUID_B), true);
    // Proved, but the owner holds no manager for this row/conversation: nothing is exposed.
    assert.deepEqual(await source.endpoint.listTools({ signal: signal() }), []);
    assert.equal(await watch(), undefined);

    owned.set(`${id}\0${UUID_B}`, host);
    assert.deepEqual((await source.endpoint.listTools({ signal: signal() })).map((tool) => tool.name), ["SubtasksStart", "SubtasksWatch"]);
    const started = await source.endpoint.callTool({ name: "SubtasksStart", arguments: startArgs("lane"), signal: signal() });
    assert.equal(started?.isError, false, JSON.stringify(started?.content));
    assert.equal(host.groupCount(), 2, "the proved lane started work in its own manager");
    const armed = await watch();
    assert.equal(armed?.isError, false);
    assert.match(String(armed?.content[0]!.text), /^SubtasksWatch armed for exec-/);
    assert.deepEqual(host.armedWatches(), [executionId]);

    // Identity change revokes the lane; a manager for the new conversation is never reached.
    owned.set(`${id}\0${UUID_C}`, host);
    assert.equal(observer.identity(UUID_C), true);
    assert.equal(source.released, 1);
    await assert.rejects(watch(), /native MCP lane/);
    await assert.rejects(source.endpoint.callTool({ name: "SubtasksStart", arguments: startArgs("after revocation"), signal: signal() }), /native MCP lane/);
    assert.equal(host.handlerCalls.length, handled + 2, "only the proved Start and Watch reached the handler");
    assert.equal(host.groupCount(), 2, "the revoked lane created no further work");
  } finally {
    await manager.dispose();
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #682: native SubtasksAdd through the canonical admission.
// ---------------------------------------------------------------------------

const ADD_ACTIONS: SharedManagedToolAction[] = ["start", "add", "inspect", "watch"];
const addArgs = (executionId: string | undefined, title: string) => ({ ...(executionId === undefined ? {} : { executionId }), tasks: [queuedTask(title)] });
type AddedTask = { taskId: string; definition: { title: string; executorToolCatalog?: { allowedToolCatalog: string[] }; reviewEvidencePolicy?: unknown } };
const groupTasks = (host: HostManager, executionId: string) => controllerOf(host).groups.get(executionId)!.tasks as unknown as AddedTask[];
const executionOf = (host: HostManager, title: string) =>
  (host.manager.startLiveness(toolCallFingerprint("SubtasksStart", startArgs(title))!) as { identity: string }).identity;
/** A host snapshot with its own evidence choice and executor deny list. */
function policySnapshot(host: HostManager, authorizedTools: readonly string[], worktreeToolOnly: boolean, executorDeny: string[] = []): ManagedStartSettings {
  const settings = snapshotOf(host, authorizedTools);
  settings.config.review = { ...settings.config.review, evidence: { ...settings.config.review?.evidence, worktreeToolOnly } };
  settings.config.tools = { ...settings.config.tools, executorDeny };
  return settings;
}
const evidencePolicyOf = (settings: ManagedStartSettings) => captureWorkerReviewEvidencePolicy(effectiveReviewEvidenceSettings(settings.config), "execute");
const addedIdsOf = (host: HostManager) => (host.handlerCalls.at(-1)!.result?.details as { addedTaskIds?: string[] } | undefined)?.addedTaskIds;

test("native Add tops off an owned group with one fresh settings read per call; earlier tasks and the group's settings are unchanged", async () => {
  const host = await hostManager(ADD_ACTIONS);
  try {
    const lane = laneContext();
    const startSnapshot = policySnapshot(host, ["read", "bash"], false);
    startSnapshot.config.maxCorrectionCycles = 3;
    const firstAdd = policySnapshot(host, ["read", "grep", "edit"], true, ["edit"]);
    firstAdd.config.maxCorrectionCycles = 7;
    const secondAdd = policySnapshot(host, ["read"], false);
    const queue = [startSnapshot, firstAdd, secondAdd];
    const served: ManagedStartSettings[] = [];
    const reader = () => {
      const next = queue[served.length];
      if (next !== undefined) served.push(next);
      return next;
    };
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ADD_ACTIONS, reader).resolver });
    assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch"]);
    assert.equal(served.length, 0, "discovery reads no settings");

    const started = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("original") });
    assert.equal(started?.isError, false, JSON.stringify(started?.content));
    const executionId = executionOf(host, "original");
    const controller = controllerOf(host);
    const group = controller.groups.get(executionId)!;
    const pinned = controller.groupSettings.get(group) as { maxCorrectionCycles: number };
    assert.equal(pinned.maxCorrectionCycles, 3);
    const original = structuredClone(groupTasks(host, executionId)[0]!);

    const added = await delegate.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "top-off") });
    assert.equal(added?.isError, false, JSON.stringify(added?.content));
    assert.equal(served.length, 2, "one fresh read for the admitted Add");
    const addCall = host.handlerCalls.at(-1)!;
    assert.equal(addCall.action, "add");
    assert.equal(addCall.binding.ownerScopedInputsOnly, true);
    assert.equal(addCall.binding.effectGuard?.isCurrent(), true, "the lane is Add's effect guard");
    assert.equal(addCall.binding.startSettings, undefined, "Add carries no Start settings");
    assert.equal(addCall.binding.admittedFingerprint?.(), undefined, "Add admits no Start identity");
    assert.deepEqual(addCall.binding.addSettings?.authorizedTools, ["read", "grep", "edit"]);
    assert.notEqual(addCall.binding.addSettings?.config, firstAdd.config, "copied by the boundary, not shared with the host");
    const [newId] = addedIdsOf(host) ?? [];
    assert.ok(newId, "the canonical result names the new task");
    assert.notEqual(newId, original.taskId);
    assert.match(String(added?.content[0]!.text), new RegExp(newId), "the new stable task handle reaches the lane result");
    // The host edits its returned object after admission: the admitted Add is unaffected.
    firstAdd.config.maxCorrectionCycles = 99;
    (firstAdd.authorizedTools as string[]).push("write");

    const tasks = groupTasks(host, executionId);
    assert.equal(tasks.length, 2);
    const topOff = tasks.find((task) => task.taskId === newId)!;
    assert.deepEqual(topOff.definition.executorToolCatalog?.allowedToolCatalog, ["read", "grep"], "the Add snapshot's ceiling minus its executor deny list, not the live ceiling");
    assert.deepEqual(topOff.definition.reviewEvidencePolicy, evidencePolicyOf(firstAdd), "the Add snapshot's evidence choice");
    assert.notDeepEqual(evidencePolicyOf(firstAdd), evidencePolicyOf(startSnapshot));
    assert.deepEqual(tasks[0], original, "the earlier task keeps its admitted catalog and policy");
    assert.equal(controller.groupSettings.get(group), pinned, "the group keeps its own Start snapshot");
    assert.equal(pinned.maxCorrectionCycles, 3, "the Add snapshot never reconfigures the group");

    // The same request again is a new top-off with its own fresh read, never a replay.
    const again = await delegate.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "top-off") });
    assert.equal(again?.isError, false, JSON.stringify(again?.content));
    assert.equal(served.length, 3);
    const [secondId] = addedIdsOf(host) ?? [];
    assert.ok(secondId && secondId !== newId);
    const latest = groupTasks(host, executionId).find((task) => task.taskId === secondId)!;
    assert.deepEqual(latest.definition.executorToolCatalog?.allowedToolCatalog, ["read"], "a later read's revocation applies to later tasks only");
    assert.deepEqual(groupTasks(host, executionId).find((task) => task.taskId === newId), topOff, "the earlier top-off is unchanged");
    assert.equal(host.groupCount(), 1, "Add created no group");
  } finally {
    await host.dispose();
  }
});

test("native Add reaches only its exact owner's groups; a stale, revoked, or foreign call adds nothing, and admitted tasks survive request cancellation", async () => {
  const hostA = await hostManager(ADD_ACTIONS);
  const hostB = await hostManager(ADD_ACTIONS);
  try {
    const laneA = laneContext({ conversationId: UUID_B });
    const laneB = laneContext({ conversationId: UUID_C });
    let reads = 0;
    const resolveScope: NativeManagedToolScopeResolver = (context) => {
      const host = context.conversationId === UUID_B ? hostA : context.conversationId === UUID_C ? hostB : undefined;
      return host && { owner: ownerOf(context), manager: host.manager, actions: ADD_ACTIONS, readStartSettings: () => { reads += 1; return snapshotOf(host); } };
    };
    const delegate = createNativeManagedToolDelegate({ resolveScope });
    assert.equal((await delegate.callTool(laneA.context, { name: "SubtasksStart", arguments: startArgs("a-one") }))?.isError, false);
    assert.equal((await delegate.callTool(laneB.context, { name: "SubtasksStart", arguments: startArgs("b-one") }))?.isError, false);
    const executionA = executionOf(hostA, "a-one");
    const countA = () => groupTasks(hostA, executionA).length;

    // Another owner's lane cannot top off A's group: it is unknown in B's own manager.
    const handledA = hostA.handlerCalls.length;
    const foreign = await delegate.callTool(laneB.context, { name: "SubtasksAdd", arguments: addArgs(executionA, "foreign") });
    assert.equal(foreign?.isError, true);
    assert.match(String(foreign?.content[0]!.text), /Unknown execution group/);
    assert.equal(hostA.handlerCalls.length, handledA, "the other lane never reached A's manager");
    assert.equal(countA(), 1);
    // An unscoped conversation gets nothing.
    assert.equal(await delegate.callTool(laneContext({ conversationId: randomUUID() }).context, { name: "SubtasksAdd", arguments: addArgs(executionA, "stranger") }), undefined);
    // An omitted executionId resolves only inside the owner's own manager and refuses ambiguity.
    assert.equal((await delegate.callTool(laneA.context, { name: "SubtasksStart", arguments: startArgs("a-two") }))?.isError, false);
    const ambiguous = await delegate.callTool(laneA.context, { name: "SubtasksAdd", arguments: addArgs(undefined, "ambiguous") });
    assert.equal(ambiguous?.isError, true);
    assert.match(String(ambiguous?.content[0]!.text), /Specify executionId/);
    assert.equal(countA(), 1);

    // Revoked or aborted before the call: never reaches the handler.
    for (const revoke of ["revoke", "abort"] as const) {
      const stale = laneContext({ conversationId: UUID_B });
      stale[revoke]();
      const before = hostA.handlerCalls.length;
      await assert.rejects(delegate.callTool(stale.context, { name: "SubtasksAdd", arguments: addArgs(executionA, `stale ${revoke}`) }), STALE);
      assert.equal(hostA.handlerCalls.length, before);
    }

    // Revoked after admission, before the controller, or by the owner callback
    // the controller makes just before attachment: refused by the lane guard.
    for (const [label, arm] of [
      ["before the handler", (lane: LaneFixture) => { hostA.hooks.beforeHandler = () => lane.revoke(); }],
      ["by the owner cwd read", (lane: LaneFixture) => { hostA.hooks.onCwd = () => lane.abort(); }],
    ] as const) {
      const racing = laneContext({ conversationId: UUID_B });
      arm(racing);
      await assert.rejects(delegate.callTool(racing.context, { name: "SubtasksAdd", arguments: addArgs(executionA, `revoked ${label}`) }), STALE, label);
      hostA.hooks.beforeHandler = undefined;
      hostA.hooks.onCwd = undefined;
      const refused = hostA.handlerCalls.at(-1)!;
      assert.equal(refused.action, "add", label);
      assert.equal(refused.result?.isError, true, label);
      assert.ok(JSON.stringify(refused.result?.content).includes(EFFECT_GUARD_ADD_REVOKED), label);
      assert.equal(countA(), 1, `${label}: no task was attached`);
    }

    // Revoked while the owner read settings: refused before the handler.
    const readRacing = laneContext({ conversationId: UUID_B });
    const racingDelegate = createNativeManagedToolDelegate({
      resolveScope: exactResolver(readRacing, hostA, ADD_ACTIONS, () => { readRacing.revoke(); return snapshotOf(hostA); }).resolver,
    });
    const beforeRead = hostA.handlerCalls.length;
    await assert.rejects(racingDelegate.callTool(readRacing.context, { name: "SubtasksAdd", arguments: addArgs(executionA, "read revoked") }), STALE);
    assert.equal(hostA.handlerCalls.length, beforeRead);
    assert.equal(countA(), 1);

    // Cancelled after attachment (while the group saves): the lane result is
    // withheld, but the admitted task stays, is persisted, and is inspectable.
    const cancelled = laneContext({ conversationId: UUID_B });
    const controller = controllerOf(hostA) as unknown as { save(group: unknown): Promise<void> };
    const save = controller.save.bind(controller);
    controller.save = async (group: unknown) => {
      cancelled.abort();
      return save(group);
    };
    try {
      await assert.rejects(delegate.callTool(cancelled.context, { name: "SubtasksAdd", arguments: addArgs(executionA, "kept") }), STALE);
    } finally {
      delete (controller as { save?: unknown }).save;
    }
    const keptCall = hostA.handlerCalls.at(-1)!;
    assert.equal(keptCall.result?.isError, false, "the canonical Add committed");
    const [keptId] = addedIdsOf(hostA) ?? [];
    assert.ok(keptId);
    assert.equal(countA(), 2, "already-admitted work is kept on request cancellation");
    const inspected = await delegate.callTool(laneA.context, { name: "SubtasksInspect", arguments: { executionId: executionA, taskId: keptId } });
    assert.equal(inspected?.isError, false, JSON.stringify(inspected?.content));
    assert.match(String(inspected?.content[0]!.text), new RegExp(keptId));
    assert.equal(hostB.groupCount(), 1);
    assert.ok(reads > 0);
  } finally {
    await hostA.dispose();
    await hostB.dispose();
  }
});

test("an Add whose settings are unavailable or invalid adds nothing; without a reader neither Start nor Add is offered", async () => {
  const host = await hostManager(ADD_ACTIONS);
  try {
    const executionId = await host.startDirect("owner work");
    const count = () => groupTasks(host, executionId).length;
    const handled = () => host.handlerCalls.filter((call) => call.action === "add").length;
    const refusal = (diagnostic: string) => ({
      content: [{ type: "text", text: `SubtasksAdd failed closed: ${diagnostic}; nothing was started or read.` }],
      isError: true,
    });
    const unreadable = refusal("the owner Add settings for this request could not be read");
    const invalid = refusal("the owner Add settings snapshot is invalid");
    const cases: Array<{ label: string; read: () => unknown; expected: unknown }> = [
      { label: "unavailable", read: () => undefined, expected: unreadable },
      { label: "throwing", read: () => { throw new Error("settings store offline"); }, expected: unreadable },
      { label: "async reader", read: async () => snapshotOf(host), expected: invalid },
      { label: "no ceiling", read: () => ({ config: snapshotOf(host).config }), expected: invalid },
      { label: "incomplete config", read: () => ({ config: { enabled: true }, authorizedTools: ["read"] }), expected: invalid },
    ];
    for (const { label, read, expected } of cases) {
      const lane = laneContext();
      let reads = 0;
      const delegate = createNativeManagedToolDelegate({
        resolveScope: exactResolver(lane, host, ADD_ACTIONS, () => { reads += 1; return read() as ManagedStartSettings; }).resolver,
      });
      assert.deepEqual(await delegate.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs(executionId, `settings ${label}`) }), expected, label);
      assert.equal(reads, 1, `${label}: read once`);
    }
    assert.equal(handled(), 0, "no settings refusal reached the handler");
    assert.equal(count(), 1, "no task was added");

    // No usable reader: Start and Add are not exposed; Inspect is unaffected.
    const lane = laneContext();
    const noReader = createNativeManagedToolDelegate({
      resolveScope: (context) => ({ owner: ownerOf(context), manager: host.manager, actions: ADD_ACTIONS } as NativeManagedToolScope),
    });
    assert.deepEqual((await noReader.listTools(lane.context)).map((tool) => tool.name), ["SubtasksInspect", "SubtasksWatch"]);
    assert.equal(await noReader.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "no reader") }), undefined);
    const taskId = groupTasks(host, executionId)[0]!.taskId;
    assert.equal((await noReader.callTool(lane.context, { name: "SubtasksInspect", arguments: { executionId, taskId } }))?.isError, false);

    // An Add-only owner scope (no Start) still requires and uses the reader.
    let reads = 0;
    const addOnly = createNativeManagedToolDelegate({
      resolveScope: exactResolver(lane, host, ["add"], () => { reads += 1; return snapshotOf(host, ["read"]); }).resolver,
    });
    assert.deepEqual((await addOnly.listTools(lane.context)).map((tool) => tool.name), ["SubtasksAdd"]);
    const recovered = await addOnly.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "recovered") });
    assert.equal(recovered?.isError, false, JSON.stringify(recovered?.content));
    assert.equal(reads, 1);
    assert.equal(count(), 2);
  } finally {
    await host.dispose();
  }
});

test("the canonical boundary honors Add settings and the Add guard only for Add, and keeps unguarded Add semantics", async () => {
  const host = await hostManager(ADD_ACTIONS);
  try {
    const executionId = await host.startDirect("boundary");
    const count = () => groupTasks(host, executionId).length;
    const valid = snapshotOf(host, ["read"]);
    const call = async (action: SharedManagedToolAction, id: string, admitted: Record<string, unknown> | (() => Record<string, unknown>)) =>
      host.manager.sharedManagedTool(action, {
        resolveCall: (toolCallId, toolName) => toolCallId === id && toolName === EXECUTION_TOOL_NAMES[action]
          ? (typeof admitted === "function" ? admitted() : admitted) as never
          : undefined,
      }).invoke({ toolCallId: id });
    const addParams = addArgs(executionId, "via boundary");

    const onStart = await call("start", "start-with-add-settings", { params: startArgs("refused"), startCallFingerprint: "b".repeat(64), addSettings: valid });
    assert.equal(onStart.isError, true);
    assert.match(String((onStart.content as Array<{ text: string }>)[0]!.text), /Add settings snapshot is invalid or cannot be honored by this action/);
    const startOnAdd = await call("add", "add-with-start-settings", { params: addParams, startSettings: valid });
    assert.match(String((startOnAdd.content as Array<{ text: string }>)[0]!.text), /Start settings snapshot is invalid or cannot be honored by this action/);
    const malformed = await call("add", "add-malformed", { params: addParams, addSettings: { config: valid.config, authorizedTools: [7] } });
    assert.match(String((malformed.content as Array<{ text: string }>)[0]!.text), /Add settings snapshot is invalid or cannot be honored/);
    const throwing = await call("add", "add-throwing", () => Object.defineProperty({ params: addParams }, "addSettings", {
      enumerable: true,
      get: () => { throw new Error("owner accessor"); },
    }));
    assert.match(String((throwing.content as Array<{ text: string }>)[0]!.text), /Add settings snapshot is invalid or cannot be honored/);
    assert.equal(JSON.stringify(throwing).includes("owner accessor"), false);
    const guardedWatch = await call("watch", "watch-guarded", { params: { executionId, after: "1h" }, effectGuard: { isCurrent: () => true } });
    assert.match(String((guardedWatch.content as Array<{ text: string }>)[0]!.text), /lifecycle guard is invalid or cannot be honored/);
    assert.equal(count(), 1, "no refused call added a task");

    // A guarded Add is honored; an unguarded shared Add without settings keeps reading the live ceiling.
    const guarded = await call("add", "add-guarded", { params: addParams, effectGuard: { isCurrent: () => true }, addSettings: valid });
    assert.equal(guarded.isError, false, JSON.stringify(guarded.content));
    const plain = await call("add", "add-plain", { params: addArgs(executionId, "live ceiling") });
    assert.equal(plain.isError, false, JSON.stringify(plain.content));
    const tasks = groupTasks(host, executionId);
    assert.deepEqual(tasks.find((task) => task.definition.title === "via boundary")?.definition.executorToolCatalog?.allowedToolCatalog, ["read"]);
    assert.deepEqual(tasks.find((task) => task.definition.title === "live ceiling")?.definition.executorToolCatalog?.allowedToolCatalog, ["read", "bash"]);
    const revoked = await call("add", "add-revoked", { params: addArgs(executionId, "revoked"), effectGuard: { isCurrent: () => false }, addSettings: valid });
    assert.equal(revoked.isError, true);
    assert.ok(JSON.stringify(revoked.content).includes(EFFECT_GUARD_ADD_REVOKED));
    assert.equal(count(), 3);
  } finally {
    await host.dispose();
  }
});

test("fresh settings that no longer route the group's kind refuse native Add before any task; the group keeps its own route", async () => {
  const host = await hostManager(ADD_ACTIONS);
  try {
    const lane = laneContext();
    const unrouted = snapshotOf(host, ["read"]);
    unrouted.config.execution!.routes!.execute = [];
    const queue = [snapshotOf(host), unrouted, snapshotOf(host, ["read"])];
    let reads = 0;
    const delegate = createNativeManagedToolDelegate({
      resolveScope: exactResolver(lane, host, ADD_ACTIONS, () => queue[reads++]).resolver,
    });
    assert.equal((await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("routed") }))?.isError, false);
    const executionId = executionOf(host, "routed");
    const controller = controllerOf(host);
    const group = controller.groups.get(executionId)!;
    const pinned = controller.groupSettings.get(group);
    const before = structuredClone(groupTasks(host, executionId));

    const refused = await delegate.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "unrouted") });
    assert.equal(refused?.isError, true);
    assert.match(String(refused?.content[0]!.text), /No execute worker route is configured in the current settings; no tasks were added/);
    assert.equal(reads, 2, "the refusal came from this Add's own fresh read");
    assert.equal(host.handlerCalls.at(-1)!.action, "add", "refused by the canonical controller admission");
    assert.deepEqual(groupTasks(host, executionId), before, "no task was attached and earlier tasks are unchanged");
    assert.equal(controller.groupSettings.get(group), pinned, "the group keeps its pinned settings");

    // Routed again: the next Add is admitted and dispatches on the group's own route.
    const restored = await delegate.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "routed again") });
    assert.equal(restored?.isError, false, JSON.stringify(restored?.content));
    assert.equal(groupTasks(host, executionId).length, 2);
    assert.equal(controller.groupSettings.get(group), pinned);
  } finally {
    await host.dispose();
  }
});

type CommandRecord = { instructionId: string; action: string; status: string };
type OwnedTask = { taskId: string; state: string; waveRoot?: string; bundle?: unknown; commands: CommandRecord[] };
type OwnedController = {
  groups: Map<string, { root: string; tasks: OwnedTask[] }>;
  save(group: unknown): Promise<void>;
  recoverTaskAssociation(group: unknown, task: OwnedTask, explicit?: unknown, options?: { beforeUpdate?: () => void }): Promise<void>;
};
const ownedController = (host: HostManager) => (host.manager as unknown as { controller: OwnedController }).controller;
const firstTask = (host: HostManager, executionId: string) => ownedController(host).groups.get(executionId)!.tasks[0]!;
const persistedTask = async (host: HostManager, executionId: string, taskId: string) => {
  const root = ownedController(host).groups.get(executionId)!.root;
  return (await readGroup(root)).group.tasks.find((task) => task.taskId === taskId);
};
const commandsOf = (task: { commands: CommandRecord[] }, action: string) => task.commands.filter((command) => command.action === action).map((command) => command.status);

/** Runs `body` with the controller's save wrapped by `onSave`, restoring it afterwards. */
async function withSaveHook<T>(host: HostManager, onSave: () => void, body: () => Promise<T>): Promise<T> {
  const controller = ownedController(host);
  const save = controller.save.bind(controller);
  controller.save = async (group: unknown) => {
    onSave();
    return save(group);
  };
  try {
    return await body();
  } finally {
    delete (controller as { save?: unknown }).save;
  }
}

/**
 * Like {@linkcode withSaveHook}, but `onSave` runs immediately AFTER the
 * controller entered its save: the group's durable save tail is already
 * registered and its write is genuinely in flight, and the caller's own
 * `await save(...)` does not resume until `onSave` settles. This is the exact
 * window a cancelled call can fall into after its work attached.
 */
async function withSaveInFlight<T>(host: HostManager, onSave: () => unknown, body: () => Promise<T>): Promise<T> {
  const controller = ownedController(host);
  const save = controller.save.bind(controller);
  controller.save = (group: unknown) => {
    const running = save(group);
    return Promise.resolve(onSave()).then(() => running);
  };
  try {
    return await body();
  } finally {
    delete (controller as { save?: unknown }).save;
  }
}

/** Two owners' managers serving `actions`, keyed by conversation; the caller disposes them. */
async function twoOwners(actions: SharedManagedToolAction[]) {
  const hostA = await hostManager(actions);
  const hostB = await hostManager(actions);
  const resolveScope: NativeManagedToolScopeResolver = (context) => {
    const host = context.conversationId === UUID_B ? hostA : context.conversationId === UUID_C ? hostB : undefined;
    return host && { owner: ownerOf(context), manager: host.manager, actions, readStartSettings: () => snapshotOf(host) };
  };
  return { hostA, hostB, delegate: createNativeManagedToolDelegate({ resolveScope }) };
}

test("Steer through the lane commits synchronously after admission, reaches only its own owner, and finishes its save when the lane falls afterwards", async () => {
  const { hostA, hostB, delegate } = await twoOwners(["start", "inspect", "steer"]);
  try {
    const laneA = laneContext({ conversationId: UUID_B });
    const laneB = laneContext({ conversationId: UUID_C });
    assert.deepEqual((await delegate.listTools(laneA.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect", "SubtasksSteer"]);
    const executionId = await hostA.startDirect("steered");
    const task = firstTask(hostA, executionId);
    const args = { executionId, taskId: task.taskId, instructions: "change course" };

    // Canonical result with no lane guard (Steer has no await before its
    // commit); the command is already recorded when the first save runs.
    const atFirstSave: string[][] = [];
    const steered = await withSaveHook(hostA, () => atFirstSave.push(commandsOf(task, "steer")), () =>
      delegate.callTool(laneA.context, { name: "SubtasksSteer", arguments: args }));
    assert.equal(steered?.isError, false, JSON.stringify(steered?.content));
    assert.deepEqual(Object.keys(steered!).sort(), ["content", "isError"]);
    const call = hostA.handlerCalls.at(-1)!;
    assert.equal(call.action, "steer");
    assert.equal(call.binding.ownerScopedInputsOnly, true);
    assert.equal(call.binding.effectGuard, undefined, "Steer carries no effect guard");
    assert.match(call.binding.toolCallId, /^native-mcp-call-[0-9a-f-]{36}$/);
    assert.deepEqual(atFirstSave[0], ["queued"], "recorded before the first await");
    assert.deepEqual(commandsOf(task, "steer"), ["queued"]);

    // Another owner's lane cannot steer A's task, and stale lanes reach nothing.
    const handledA = hostA.handlerCalls.length;
    const foreign = await delegate.callTool(laneB.context, { name: "SubtasksSteer", arguments: args });
    assert.equal(foreign?.isError, true);
    for (const revoke of ["revoke", "abort"] as const) {
      const stale = laneContext({ conversationId: UUID_B });
      stale[revoke]();
      await assert.rejects(delegate.callTool(stale.context, { name: "SubtasksSteer", arguments: args }), STALE);
    }
    assert.equal(hostA.handlerCalls.length, handledA, "no foreign or stale call reached A's handler");
    assert.deepEqual(commandsOf(task, "steer"), ["queued"]);

    // Cancelled after the synchronous commit (while it saves): the lane result
    // is withheld, but the command stays and its save completes.
    const cancelled = laneContext({ conversationId: UUID_B });
    await withSaveHook(hostA, () => cancelled.abort(), () =>
      assert.rejects(delegate.callTool(cancelled.context, { name: "SubtasksSteer", arguments: { ...args, instructions: "kept" } }), STALE));
    assert.equal(hostA.handlerCalls.at(-1)!.result?.isError, false, "the canonical Steer committed");
    assert.deepEqual(commandsOf(task, "steer"), ["queued", "queued"]);
    const persisted = await persistedTask(hostA, executionId, task.taskId);
    assert.equal(persisted?.commands.filter((command) => command.action === "steer").length, 2, "and its save completed");
  } finally {
    await hostA.dispose();
    await hostB.dispose();
  }
});

test("Continue through the lane is guarded by the lane, confined to its owner, refuses explicit bundles, and keeps admitted work when the lane falls", async () => {
  const { hostA, hostB, delegate } = await twoOwners(["start", "inspect", "continue"]);
  try {
    const laneA = laneContext({ conversationId: UUID_B });
    const laneB = laneContext({ conversationId: UUID_C });
    assert.deepEqual((await delegate.listTools(laneA.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect", "SubtasksContinue"]);

    // Two stopped owned tasks; recovery is a stub honoring its contract
    // (awaits, `during`, `beforeUpdate`, then the bundle update).
    const executions = [await hostA.startDirect("first"), await hostA.startDirect("second")];
    const tasks = executions.map((executionId) => firstTask(hostA, executionId));
    for (const task of tasks) {
      task.state = "failed";
      task.waveRoot = `/synthetic/wave-${task.taskId}`;
    }
    const recoveries: Array<{ guarded: boolean }> = [];
    let during: (() => void) | undefined;
    ownedController(hostA).recoverTaskAssociation = async (_group, task, _explicit, options) => {
      recoveries.push({ guarded: typeof options?.beforeUpdate === "function" });
      await Promise.resolve();
      during?.();
      await Promise.resolve();
      options?.beforeUpdate?.();
      task.bundle = { version: 1, operationId: `op-${task.taskId}`, waveId: "wave", taskId: task.taskId, waveRoot: task.waveRoot, expectedRevision: 1 };
    };
    const args = (index: number, extra: Record<string, unknown> = {}) => ({ executionId: executions[index], taskId: tasks[index]!.taskId, instructions: "resume", ...extra });

    // Revoked across recovery's awaits: refused by the lane guard before the
    // recovery update; no command, queue transition, or bundle.
    const racing = laneContext({ conversationId: UUID_B });
    during = () => racing.revoke();
    await assert.rejects(delegate.callTool(racing.context, { name: "SubtasksContinue", arguments: args(0) }), STALE);
    during = undefined;
    const refused = hostA.handlerCalls.at(-1)!;
    assert.equal(refused.action, "continue");
    assert.equal(refused.result?.isError, true);
    assert.ok(JSON.stringify(refused.result?.content).includes(EFFECT_GUARD_CONTINUE_REVOKED));
    assert.deepEqual(recoveries, [{ guarded: true }]);
    assert.equal(tasks[0]!.state, "failed");
    assert.equal(tasks[0]!.bundle, undefined);
    assert.deepEqual(commandsOf(tasks[0]!, "continue"), []);

    // An explicit reattachment bundle stays refused at the canonical boundary, before recovery.
    const bundle = { version: 1, operationId: "op-foreign", waveId: "wave", taskId: tasks[0]!.taskId, waveRoot: "/synthetic/foreign", expectedRevision: 0 };
    const withBundle = await delegate.callTool(laneA.context, { name: "SubtasksContinue", arguments: args(0, { bundle }) });
    assert.equal(withBundle?.isError, true);
    assert.match(String(withBundle?.content[0]!.text), /^SubtasksContinue failed closed: an explicit reattachment bundle is not admitted through the shared managed boundary/);
    // Another owner's lane cannot continue A's task: it is unknown in B's own manager.
    const handledA = hostA.handlerCalls.length;
    const foreign = await delegate.callTool(laneB.context, { name: "SubtasksContinue", arguments: args(0) });
    assert.equal(foreign?.isError, true);
    assert.equal(hostA.handlerCalls.length, handledA, "the other lane never reached A's manager");
    assert.equal(recoveries.length, 1, "neither reached recovery");
    assert.deepEqual(commandsOf(tasks[0]!, "continue"), []);

    // Canonical success on a current lane, carrying the lane as its guard.
    const continued = await delegate.callTool(laneA.context, { name: "SubtasksContinue", arguments: args(0) });
    assert.equal(continued?.isError, false, JSON.stringify(continued?.content));
    assert.deepEqual(Object.keys(continued!).sort(), ["content", "isError"]);
    const admitted = hostA.handlerCalls.at(-1)!;
    assert.equal(admitted.binding.ownerScopedInputsOnly, true);
    assert.equal(admitted.binding.effectGuard?.isCurrent(), true);
    assert.equal(tasks[0]!.state, "queued");
    assert.deepEqual(commandsOf(tasks[0]!, "continue"), ["queued"]);

    // Cancelled after queueing (while it saves): the lane result is withheld,
    // but the admitted continuation is kept and its save completes.
    const cancelled = laneContext({ conversationId: UUID_B });
    await withSaveHook(hostA, () => cancelled.abort(), () =>
      assert.rejects(delegate.callTool(cancelled.context, { name: "SubtasksContinue", arguments: args(1) }), STALE));
    assert.equal(hostA.handlerCalls.at(-1)!.result?.isError, false, "the canonical Continue committed");
    assert.equal(tasks[1]!.state, "queued", "not rolled back");
    const persisted = await persistedTask(hostA, executions[1]!, tasks[1]!.taskId);
    assert.equal(persisted?.state, "queued", "and its save completed");
    assert.deepEqual(persisted?.commands.filter((command) => command.action === "continue").map((command) => command.status), ["queued"]);
  } finally {
    await hostA.dispose();
    await hostB.dispose();
  }
});

/** Installs one conflict gate directly on a host's own controller (as a materialized force-merge would). */
function installOwnGate(host: HostManager, sourceRoot: string, label: string, path: string) {
  const gate = {
    executionId: `exec-${label}`,
    taskId: `task-${label}`,
    sourceRoot,
    paths: [path],
    activatedAt: new Date(0).toISOString(),
    manifestPath: join(sourceRoot, `${label}-manifest.json`),
    reason: `${label} gate`,
  };
  (host.manager as unknown as { controller: { setConflictGate(gate: unknown): void } }).controller.setConflictGate(gate);
  return gate;
}
const ownGates = (host: HostManager) => host.manager.associations().conflictGates ?? [];

test("Interrupt, ForceMerge, and MarkClean through the lane carry the lane as their guard, stay confined to their owner, and keep admitted work when the lane falls", async () => {
  const actions: SharedManagedToolAction[] = ["start", "inspect", "interrupt", "force_merge", "mark_clean"];
  const { hostA, hostB, delegate } = await twoOwners(actions);
  try {
    const laneA = laneContext({ conversationId: UUID_B });
    const laneB = laneContext({ conversationId: UUID_C });
    assert.deepEqual((await delegate.listTools(laneA.context)).map((tool) => tool.name),
      ["SubtasksStart", "SubtasksInspect", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
    const executions = [await hostA.startDirect("first"), await hostA.startDirect("second")];
    const tasks = executions.map((executionId) => firstTask(hostA, executionId));
    const interruptArgs = (index: number) => ({ executionId: executions[index], taskId: tasks[index]!.taskId, interruptMode: "interrupt_as_failure" });

    // Another owner's lane, and stale lanes, reach none of A's work.
    const handledA = hostA.handlerCalls.length;
    for (const [name, args] of [
      ["SubtasksInterrupt", interruptArgs(0)],
      ["SubtasksForceMerge", { executionId: executions[0], taskId: tasks[0]!.taskId }],
    ] as const) {
      const foreign = await delegate.callTool(laneB.context, { name, arguments: args });
      assert.equal(foreign?.isError, true, `${name}: unknown in B's own manager`);
      for (const revoke of ["revoke", "abort"] as const) {
        const stale = laneContext({ conversationId: UUID_B });
        stale[revoke]();
        await assert.rejects(delegate.callTool(stale.context, { name, arguments: args }), STALE);
      }
    }
    assert.equal(hostA.handlerCalls.length, handledA, "no foreign or stale call reached A's handler");
    assert.deepEqual(tasks.map((task) => task.state), ["queued", "queued"]);

    // Interrupt on a current lane: the canonical stop, carrying the lane as its guard.
    const interrupted = await delegate.callTool(laneA.context, { name: "SubtasksInterrupt", arguments: interruptArgs(0) });
    assert.equal(interrupted?.isError, false, JSON.stringify(interrupted?.content));
    assert.deepEqual(Object.keys(interrupted!).sort(), ["content", "isError"]);
    const admitted = hostA.handlerCalls.at(-1)!;
    assert.equal(admitted.action, "interrupt");
    assert.equal(admitted.binding.ownerScopedInputsOnly, true);
    assert.equal(admitted.binding.effectGuard?.isCurrent(), true);
    assert.equal(admitted.binding.effectGuard?.signal, laneA.context.signal, "the canonical guard carries the exact request signal");
    assert.equal(tasks[0]!.state, "interrupted");
    assert.deepEqual(commandsOf(tasks[0]!, "interrupt"), ["acknowledged"]);

    // Cancelled after the synchronous commit (while it saves): the lane result
    // is withheld, but the interrupt stays and its save completes.
    const cancelled = laneContext({ conversationId: UUID_B });
    await withSaveHook(hostA, () => cancelled.abort(), () =>
      assert.rejects(delegate.callTool(cancelled.context, { name: "SubtasksInterrupt", arguments: interruptArgs(1) }), STALE));
    assert.equal(hostA.handlerCalls.at(-1)!.result?.isError, false, "the canonical Interrupt committed");
    assert.equal(tasks[1]!.state, "interrupted", "not rolled back");
    assert.equal((await persistedTask(hostA, executions[1]!, tasks[1]!.taskId))?.state, "interrupted", "and its save completed");

    // ForceMerge: revoked across the association backfill's awaits, the lane
    // guard refuses before the first task update; nothing is recorded.
    tasks[0]!.waveRoot = `/synthetic/wave-${tasks[0]!.taskId}`;
    let during: (() => void) | undefined;
    const backfills: boolean[] = [];
    ownedController(hostA).recoverTaskAssociation = async (_group, task, _explicit, options) => {
      backfills.push(typeof options?.beforeUpdate === "function");
      await Promise.resolve();
      during?.();
      await Promise.resolve();
      options?.beforeUpdate?.();
      task.bundle = { synthetic: true };
    };
    const racing = laneContext({ conversationId: UUID_B });
    during = () => racing.revoke();
    await assert.rejects(delegate.callTool(racing.context, { name: "SubtasksForceMerge", arguments: { executionId: executions[0], taskId: tasks[0]!.taskId } }), STALE);
    during = undefined;
    const refusedMerge = hostA.handlerCalls.at(-1)!;
    assert.equal(refusedMerge.action, "force_merge");
    assert.equal(typeof refusedMerge.binding.effectGuard?.isCurrent, "function");
    assert.equal(refusedMerge.binding.effectGuard?.signal, racing.context.signal, "ForceMerge's guard carries the exact request signal");
    assert.ok(JSON.stringify(refusedMerge.result?.content).includes(EFFECT_GUARD_FORCE_MERGE_REVOKED));
    assert.deepEqual(backfills, [true]);
    assert.equal(tasks[0]!.bundle, undefined, "no backfill update");
    assert.deepEqual(commandsOf(tasks[0]!, "force_merge"), [], "no command");
    assert.equal(tasks[0]!.state, "interrupted");

    // MarkClean: B's lane sees only B's (absent) gates; A's resolved gate stays.
    const workspace = (ownedController(hostA).groups.get(executions[0]!) as unknown as { cwd: string }).cwd;
    writeFileSync(join(workspace, "resolved.txt"), "resolved\n");
    const gate = installOwnGate(hostA, workspace, "lane-a", "resolved.txt");
    const otherClean = await delegate.callTool(laneB.context, { name: "SubtasksMarkClean", arguments: {} });
    assert.equal(otherClean?.isError, false);
    assert.equal(otherClean?.content[0]!.text, "No workspace conflict gate is active.");
    assert.deepEqual(ownGates(hostA), [gate]);

    // Revoked during validation (a stale serialized clean): refused before the
    // commit; A's gate, and its block, stay.
    const store = (hostA.manager as unknown as { controller: { conflictGates: { unresolvedReasons: (...args: unknown[]) => Promise<string[]> } } }).controller.conflictGates;
    const validate = store.unresolvedReasons.bind(store);
    const staleClean = laneContext({ conversationId: UUID_B });
    store.unresolvedReasons = async (...args: unknown[]) => {
      staleClean.revoke();
      return validate(...args);
    };
    try {
      await assert.rejects(delegate.callTool(staleClean.context, { name: "SubtasksMarkClean", arguments: {} }), STALE);
    } finally {
      delete (store as { unresolvedReasons?: unknown }).unresolvedReasons;
    }
    assert.ok(JSON.stringify(hostA.handlerCalls.at(-1)!.result?.content).includes(EFFECT_GUARD_MARK_CLEAN_REVOKED));
    assert.deepEqual(ownGates(hostA), [gate], "the validated gate was not cleared");

    // A current lane clears exactly A's validated gate.
    const cleaned = await delegate.callTool(laneA.context, { name: "SubtasksMarkClean", arguments: {} });
    assert.equal(cleaned?.isError, false, JSON.stringify(cleaned?.content));
    assert.match(String(cleaned?.content[0]!.text), /^Conflict gate cleared for 1 path\(s\)/);
    assert.equal(hostA.handlerCalls.at(-1)!.binding.effectGuard?.isCurrent(), true);
    assert.deepEqual(ownGates(hostA), []);
  } finally {
    await hostA.dispose();
    await hostB.dispose();
  }
});

test("Interrupt, ForceMerge, and MarkClean through the lane return Pi's canonical output; Pi never carries a guard", async () => {
  const actions: SharedManagedToolAction[] = ["start", "inspect", "interrupt", "force_merge", "mark_clean"];
  const host = await hostManager(actions);
  const pi = await managedToolFixture();
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, actions).resolver });
    const laneExecution = await host.startDirect("parity");
    const laneTask = firstTask(host, laneExecution).taskId;
    const piStarted = await pi.piExecute("SubtasksStart")("pi-call-0", startArgs("parity"), undefined, undefined, {});
    assert.equal(piStarted.isError, false);
    const piExecution = (piStarted.details as Record<string, string>).executionId!;
    const piTask = (pi.manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string }> }> } })
      .controller.groups.get(piExecution)!.tasks[0]!.taskId;
    const piController = (pi.manager as unknown as { controller: Record<string, (...args: unknown[]) => unknown> }).controller;
    const piArgs: Array<[string, unknown[]]> = [];
    for (const method of ["interrupt", "forceMerge", "markClean"]) {
      const original = piController[method]!;
      piController[method] = function (this: unknown, ...args: unknown[]) {
        piArgs.push([method, args]);
        return original.apply(this, args);
      };
    }
    const piWorkspace = (pi.manager as unknown as { input: { cwd: () => string } }).input.cwd();
    const laneWorkspace = (ownedController(host).groups.get(laneExecution) as unknown as { cwd: string }).cwd;
    const canonical = (value: unknown) => masked(JSON.stringify(value)
      .split(piWorkspace).join("<workspace>")
      .split(laneWorkspace).join("<workspace>")
      .replace(/native-mcp-call-[0-9a-f-]{36}|pi-call-\d+/g, "<call>")
      .replace(/pi-review-execution-[A-Za-z0-9]+/g, "<root>"));
    const steps: Array<[string, (executionId: string, taskId: string) => Record<string, unknown>]> = [
      ["SubtasksInterrupt", (executionId, taskId) => ({ executionId, taskId, interruptMode: "interrupt_as_failure" })],
      // A stopped task with no durable wave anchor: the canonical scoped refusal.
      ["SubtasksForceMerge", (executionId, taskId) => ({ executionId, taskId })],
      ["SubtasksMarkClean", () => ({})],
    ];
    let index = 0;
    for (const [name, argsFor] of steps) {
      index += 1;
      const viaLane = await delegate.callTool(lane.context, { name, arguments: argsFor(laneExecution, laneTask) });
      const viaPi = await pi.piExecute(name)(`pi-call-${index}`, argsFor(piExecution, piTask), undefined, undefined, {});
      assert.equal(viaLane?.isError, viaPi.isError === true, name);
      assert.equal(canonical(viaLane?.content), canonical(viaPi.content.map((item: { type: string; text: string }) => ({ type: item.type, text: item.text }))), name);
      assert.equal(typeof host.handlerCalls.at(-1)!.binding.effectGuard?.isCurrent, "function", `${name}: the lane call carries the guard`);
    }
    // Pi reaches the same controller methods with no guard at all.
    assert.deepEqual(piArgs.map(([method]) => method), ["interrupt", "forceMerge", "markClean"]);
    assert.equal(piArgs[0]![1][1], undefined, "Pi Interrupt: no options");
    assert.equal(piArgs[1]![1][1], undefined, "Pi ForceMerge: no options");
    assert.deepEqual(piArgs[2]![1], [{ actor: "model" }], "Pi MarkClean: its original input only");
  } finally {
    await host.dispose();
    await pi.dispose();
  }
});

/**
 * #775 follow-up: the exact per-owner host activity census of the managed tools
 * around cancelled `SubtasksStart` and `SubtasksAdd` calls. Same lane and manager
 * fixture as every other case here; every number is the real
 * `ExecutionToolManager.activityCensus()` a native host reads for its own row —
 * never a projection, a Pi-registry value, or a cached one. Queued tasks never
 * dispatch, so no executor process is spawned.
 */
const flushCensusSignals = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One subscriber notification: the controller's real pending state when the
 * notification started, and what this owner's census actually answered. */
type CensusObservation = { pending: boolean; read: HostActivityCensusRead };

/**
 * A host projection that only re-reads when its own controller signals it, with
 * each notification tagged by the controller's ACTUAL admission/save state at
 * that moment (read synchronously in the callback). The settlement boundary is
 * therefore independent of the census response under test: a wrong `settling`
 * answer after the window closed cannot move the boundary forward and hide the
 * failure, and a premature count before it closed cannot end the window.
 */
function observeCensus(host: HostManager, census: HostActivityCensus) {
  const controller = controllerOf(host);
  const signalled: Array<Promise<CensusObservation>> = [];
  const unsubscribe = census.subscribe(() => {
    const pending = controller.startAdmissions > 0 || controller.saveTails.size > 0;
    signalled.push(census.read().then((read) => ({ pending, read })));
  });
  return {
    unsubscribe,
    /** Hands back this window's notifications only, so each phase is judged on its own. */
    async collected(): Promise<CensusObservation[]> {
      await flushCensusSignals();
      return Promise.all(signalled.splice(0));
    },
  };
}

/**
 * The signal-driven shape of one census window, read ONLY through the owner's
 * census subscriber (the shape a native row projection takes): the pending
 * window was itself observed as `settling` — never `incomplete`, and never a
 * premature or stale count — and the FIRST notification after it settled is the
 * exact authoritative census, which every later notification keeps. No managed
 * call is issued between the two.
 */
function assertSettlingThenExact(observed: readonly CensusObservation[], expected: HostActivityCensusRead, label: string): void {
  const statuses = observed.map(({ pending, read }) => `${pending ? "pending" : "settled"}:${read.status}`);
  const firstSettled = observed.findIndex(({ pending }) => !pending);
  assert.notEqual(firstSettled, -1, `${label}: settlement signalled a follow-up read: ${JSON.stringify(statuses)}`);
  assert.ok(firstSettled > 0, `${label}: a notification was observed while pending: ${JSON.stringify(statuses)}`);
  for (const { read } of observed.slice(0, firstSettled)) {
    assert.deepEqual(read, { status: "settling" }, `${label}: a pending read is settling, not unknown or a count: ${JSON.stringify(statuses)}`);
  }
  for (const { pending, read } of observed.slice(firstSettled)) {
    assert.equal(pending, false, `${label}: the window did not reopen: ${JSON.stringify(statuses)}`);
    assert.deepEqual(read, expected, `${label}: every settled notification, including the first, gives the exact census: ${JSON.stringify(statuses)}`);
  }
}

/**
 * A cancelled call that admitted nothing changes no lifecycle fact: every
 * notification it produced (possibly none) keeps the exact unchanged census —
 * never a moved count, never an unknown row.
 */
function assertCensusNeverMoved(observed: readonly CensusObservation[], expected: HostActivityCensusRead, label: string): void {
  for (const { read } of observed) {
    assert.deepEqual(read, expected, `${label}: a refusal that admitted nothing leaves the census exactly as it was`);
  }
}

test("the managed census around a cancelled Start: settling through the window, no token for a refused Start, and the admitted worker counted through the withheld reply", async () => {
  const host = await hostManager(ADD_ACTIONS, undefined, true);
  try {
    const census = censusOf(host);
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ADD_ACTIONS).resolver });
    assert.deepEqual(await census.read(), { status: "complete", count: 0, tokens: new Set() }, "a clean restore is a known zero");
    const seed = await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("census seed") });
    assert.equal(seed?.isError, false, JSON.stringify(seed?.content));
    const seedTask = groupTasks(host, executionOf(host, "census seed"))[0]!.taskId;
    assert.deepEqual(await census.read(), { status: "complete", count: 1, tokens: new Set([seedTask]) }, "one admitted task is exactly one");

    // A projection that only re-reads on its own controller's signals, tagged
    // with the controller's real pending state at each notification.
    const { unsubscribe, collected } = observeCensus(host, census);
    const unchanged: HostActivityCensusRead = { status: "complete", count: 1, tokens: new Set([seedTask]) };
    try {
      // Cancelled while the call is in flight, before its Start reaches the
      // controller at all: nothing has been admitted or attached yet.
      const refused = laneContext();
      const refusedDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(refused, host, ADD_ACTIONS).resolver });
      let releaseAdmission!: () => void;
      const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
      let inAdmission!: () => void;
      const reachedAdmission = new Promise<void>((resolve) => { inAdmission = resolve; });
      host.hooks.beforeHandler = () => { inAdmission(); return admissionGate; };
      const refusedStart = refusedDelegate.callTool(refused.context, { name: "SubtasksStart", arguments: startArgs("revoked before attachment") });
      try {
        await reachedAdmission;
        assert.deepEqual(await census.read(), { status: "complete", count: 1, tokens: new Set([seedTask]) },
          "a Start that has not reached its controller leaves the row exactly as it was: no phantom token and no unknown count");
        refused.abort();
      } finally {
        host.hooks.beforeHandler = undefined;
        releaseAdmission();
      }
      await assert.rejects(refusedStart, STALE);
      const refusedCall = host.handlerCalls.at(-1)!;
      assert.equal(refusedCall.action, "start");
      assert.equal(refusedCall.result?.isError, true);
      assert.ok(JSON.stringify(refusedCall.result?.content).includes(EFFECT_GUARD_START_REVOKED));
      assert.equal(controllerOf(host).groups.size, 1, "the refused Start attached no group");
      assert.deepEqual(await census.read(), { status: "complete", count: 1, tokens: new Set([seedTask]) },
        "the cancelled Start's lost reply is neither idle nor new work: the count is exactly the surviving task");

      // Through the subscriber alone: the open admission was observed as
      // settling, and the first post-settlement notification is the unchanged
      // exact census — no further managed call of any kind.
      assertSettlingThenExact(await collected(), unchanged, "the refused Start");

      // Cancelled after attachment, while the group's real durable write is in
      // flight: the reply is withheld, but the worker it admitted counts.
      const cancelled = laneContext();
      const cancelledDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(cancelled, host, ADD_ACTIONS).resolver });
      let censusDuringSave: HostActivityCensusRead | undefined;
      await withSaveInFlight(host, async () => {
        // The lane falls while the group's real durable write is in flight.
        cancelled.abort();
        censusDuringSave = await census.read();
      }, async () => {
        const admittedStart = cancelledDelegate.callTool(cancelled.context, { name: "SubtasksStart", arguments: startArgs("admitted despite the lost reply") });
        await assert.rejects(admittedStart, STALE);
      });
      assert.deepEqual(censusDuringSave, { status: "settling" },
        "a Start whose durable save is in flight carries no count: never a premature zero, never unknown");
      const admittedCall = host.handlerCalls.at(-1)!;
      assert.equal(admittedCall.action, "start");
      assert.equal(admittedCall.result?.isError, false, "the canonical Start committed after the lane fell");
      const admittedTask = groupTasks(host, executionOf(host, "admitted despite the lost reply"))[0]!.taskId;
      assert.deepEqual(await census.read(), { status: "complete", count: 2, tokens: new Set([seedTask, admittedTask]) },
        "the admitted worker is counted: a withheld reply is not an idle row");
      // The same recovery on the withheld Start's own notifications: settling
      // while its durable save waited, then the exact two-token census first.
      assertSettlingThenExact(await collected(), { status: "complete", count: 2, tokens: new Set([seedTask, admittedTask]) },
        "the withheld Start");

      // The same census read through the host's own manager when it cannot
      // establish its session at all is unknown — and the first read after the
      // host can answer again restores that exact count with no new Start/Add.
      let unreadableSession = false;
      host.hooks.onCwd = () => { if (unreadableSession) throw new Error("injected host session read failure"); };
      try {
        unreadableSession = true;
        assert.deepEqual(await census.read(), { status: "incomplete" }, "a census that cannot establish the host session is unknown, never a zero");
        unreadableSession = false;
        assert.deepEqual(await census.read(), { status: "complete", count: 2, tokens: new Set([seedTask, admittedTask]) },
          "the first authoritative census restores the exact count without another Start or Add");
      } finally {
        host.hooks.onCwd = undefined;
      }

    } finally {
      unsubscribe();
    }
  } finally {
    await host.dispose();
  }
});

test("the managed census around a cancelled Add: an in-flight and a refused top-off leave the exact count, an admitted one counts through the withheld reply", async () => {
  const host = await hostManager(ADD_ACTIONS, undefined, true);
  try {
    const census = censusOf(host);
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ADD_ACTIONS).resolver });
    assert.equal((await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("owned work") }))?.isError, false);
    const executionId = executionOf(host, "owned work");
    const existing = groupTasks(host, executionId)[0]!.taskId;
    assert.deepEqual(await census.read(), { status: "complete", count: 1, tokens: new Set([existing]) }, "the existing task is a known one");
    // The whole existing task record, not just its id: cancellation must leave
    // its instructions, policy, state, and history untouched.
    const existingTask = structuredClone(groupTasks(host, executionId)[0]!);

    // A projection that only re-reads on its own controller's signals, tagged
    // with the controller's real pending state at each notification.
    const { unsubscribe, collected } = observeCensus(host, census);
    const unchanged: HostActivityCensusRead = { status: "complete", count: 1, tokens: new Set([existing]) };
    try {
      // An Add still in flight, before its tasks attach: the row keeps its exact
      // known count — the top-off is counted neither early nor at all.
      const racing = laneContext();
      const racingDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(racing, host, ADD_ACTIONS).resolver });
      let releaseAdd!: () => void;
      const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
      let inAdd!: () => void;
      const reachedAdd = new Promise<void>((resolve) => { inAdd = resolve; });
      host.hooks.beforeHandler = () => { inAdd(); return addGate; };
      const racingAdd = racingDelegate.callTool(racing.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "revoked before attachment") });
      try {
        await reachedAdd;
        assert.deepEqual(await census.read(), { status: "complete", count: 1, tokens: new Set([existing]) },
          "an in-flight Add leaves the exact known count: no phantom token and no unknown row");
        racing.abort();
      } finally {
        host.hooks.beforeHandler = undefined;
        releaseAdd();
      }
      await assert.rejects(racingAdd, STALE);
      const refusedCall = host.handlerCalls.at(-1)!;
      assert.equal(refusedCall.action, "add");
      assert.equal(refusedCall.result?.isError, true);
      assert.ok(JSON.stringify(refusedCall.result?.content).includes(EFFECT_GUARD_ADD_REVOKED));
      assert.deepEqual(groupTasks(host, executionId).map((task) => task.taskId), [existing], "the refused Add attached nothing and touched no existing task");
      assert.deepEqual(groupTasks(host, executionId).find((task) => task.taskId === existing), existingTask,
        "the refused Add left the existing task record itself unchanged, not just its id");
      assert.deepEqual(await census.read(), { status: "complete", count: 1, tokens: new Set([existing]) },
        "the cancelled Add's lost reply changes the count by nothing at all");
      // A refusal admits nothing, so it moves no census value on any notification.
      assertCensusNeverMoved(await collected(), unchanged, "the refused Add");

      // Cancelled after attachment, while the group's real durable write is in
      // flight: the reply is withheld, the top-off is durable, and the count grows.
      const cancelled = laneContext();
      const cancelledDelegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(cancelled, host, ADD_ACTIONS).resolver });
      let censusDuringSave: HostActivityCensusRead | undefined;
      await withSaveInFlight(host, async () => {
        // The lane falls while the group's real durable write is in flight.
        cancelled.abort();
        censusDuringSave = await census.read();
      }, async () => {
        const keptAdd = cancelledDelegate.callTool(cancelled.context, { name: "SubtasksAdd", arguments: addArgs(executionId, "kept top-off") });
        await assert.rejects(keptAdd, STALE);
      });
      assert.deepEqual(censusDuringSave, { status: "settling" },
        "an Add whose durable save is in flight carries no count: never a premature zero, never unknown");
      let keptId = "";
      const keptCall = host.handlerCalls.at(-1)!;
      assert.equal(keptCall.action, "add");
      assert.equal(keptCall.result?.isError, false, "the canonical Add committed after the lane fell");
      [keptId] = addedIdsOf(host) ?? [];
      assert.ok(keptId, "the withheld Add still reported its own admitted task");
      assert.deepEqual(groupTasks(host, executionId).map((task) => task.taskId), [existing, keptId],
        "the existing task is untouched and exactly one task was admitted");
      assert.deepEqual(groupTasks(host, executionId).find((task) => task.taskId === existing), existingTask,
        "the withheld Add left the pre-existing task record itself unchanged, not just its id");
      assert.deepEqual(await census.read(), { status: "complete", count: 2, tokens: new Set([existing, keptId]) },
        "the admitted top-off is counted: the lost reply does not read as an idle row");
      // The same recovery on the withheld Add's own notifications: settling while
      // its durable save waited, then the exact two-token census first, with no
      // further managed call.
      assertSettlingThenExact(await collected(), { status: "complete", count: 2, tokens: new Set([existing, keptId]) },
        "the withheld Add");
    } finally {
      unsubscribe();
    }
  } finally {
    await host.dispose();
  }
});
