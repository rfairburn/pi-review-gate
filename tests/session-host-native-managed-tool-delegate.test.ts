/**
 * #682: the native MCP lane delegate that maps a host-proved lane context onto
 * the canonical shared managed tools (`src/session-host/native-managed-tool-delegate.ts`).
 *
 * EVIDENCE SCOPE: the real no-Pi `ExecutionToolManager` (built with
 * `hostExposure`), its real handler and `BackgroundExecutionController`, and —
 * in the last case — the real `InstanceManager` lane fencing with synthetic
 * PTYs, a fake launch provider, a fake broker-shaped registrar, and a synthetic
 * observer. The lane contexts in the other cases are hand-built fixtures whose
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
import { normalizeConfig } from "../src/config";
import {
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
import { EFFECT_GUARD_INSPECT_REVOKED, EFFECT_GUARD_START_REVOKED } from "../src/execution/background-controller";
import { createState } from "../src/state";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import { EMPTY_ASSOCIATIONS, FixtureAdmission, SUBTASK_TOOL_NAMES, queuedTask } from "./managed-tool-fixtures";

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
  effectGuard?: { isCurrent(): boolean };
  admittedFingerprint?: () => unknown;
  startSettings?: { config: ReturnType<typeof fixtureConfig>; authorizedTools: readonly string[] };
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
/** `workspace` names an existing canonical owner workspace whose cleanup belongs to the caller. */
async function hostManager(actions: SharedManagedToolAction[] = ["start", "watch"], workspace?: string): Promise<HostManager> {
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
};
const controllerOf = (host: HostManager) => (host.manager as unknown as { controller: ControllerInternals }).controller;

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

test("only guarded Start and Inspect and lane-fenced Watch are offered; every other action stays unavailable", async () => {
  assert.deepEqual(NATIVE_LANE_FENCED_ACTIONS, ["start", "inspect", "watch"]);
  assert.ok(Object.isFrozen(NATIVE_LANE_FENCED_ACTIONS));
  const host = await hostManager(ALL_ACTIONS);
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ALL_ACTIONS).resolver });
    // The owner exposes and admits everything; the lane lists only the fenced actions.
    assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect", "SubtasksWatch"]);

    const executionId = await host.startDirect("active");
    const before = host.handlerCalls.length;
    for (const action of ALL_ACTIONS.filter((candidate) => !NATIVE_LANE_FENCED_ACTIONS.includes(candidate))) {
      const outcome = await delegate.callTool(lane.context, { name: EXECUTION_TOOL_NAMES[action], arguments: { executionId } });
      assert.equal(outcome, undefined, `${action} is unavailable on the lane`);
    }
    assert.equal(host.handlerCalls.length, before, "no unavailable action reached the handler");
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
