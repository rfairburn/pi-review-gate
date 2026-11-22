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
 * (`maxWorkers = 0`); executions the lane watches are started directly through
 * the shared boundary. No MCP stdio transport, provider binary, persistence,
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
import { createState } from "../src/state";
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

type Binding = { toolCallId: string; ownerScopedInputsOnly: boolean; host?: unknown };
type Handler = (action: string, toolName: string, params: unknown, binding: Binding) => Promise<Record<string, unknown>>;

interface HostManager {
  manager: ExecutionToolManager;
  config: ReturnType<typeof fixtureConfig>;
  handlerCalls: Array<{ action: string; params: unknown; binding: Binding }>;
  /** Admissions bound through the real manager, in order. */
  admissions: ManagedToolAdmission[];
  hooks: { allow?: (name: string) => boolean; onPolicy?: () => void; beforeHandler?: () => void; onCwd?: () => void };
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
    handlerCalls.push({ action, params, binding });
    hooks.beforeHandler?.();
    return original(action, toolName, params, binding);
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

/** A resolver for exactly one lane identity; any other context gets no scope. */
function exactResolver(lane: LaneFixture, host: HostManager, actions: SharedManagedToolAction[] = ["start", "watch"]) {
  const calls: NativeMcpLaneContext[] = [];
  const resolver: NativeManagedToolScopeResolver = (context) => {
    calls.push(context);
    if (context.rowId !== lane.context.rowId || context.conversationId !== lane.context.conversationId) return undefined;
    return { owner: ownerOf(context), manager: host.manager, actions };
  };
  return { resolver, calls };
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

test("only lane-fenced Watch is offered; Start and every action with post-await effects stay unavailable", async () => {
  assert.deepEqual(NATIVE_LANE_FENCED_ACTIONS, ["watch"]);
  assert.ok(Object.isFrozen(NATIVE_LANE_FENCED_ACTIONS));
  const host = await hostManager(ALL_ACTIONS);
  try {
    const lane = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(lane, host, ALL_ACTIONS).resolver });
    // The owner exposes and admits everything; the lane still lists only Watch.
    assert.deepEqual((await delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksWatch"]);

    // An identical Start while a matching group is active: not exposed, so no
    // liveness read, no duplicate wording, and no execution id is disclosed.
    const executionId = await host.startDirect("active");
    const before = host.handlerCalls.length;
    assert.equal(await delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("active") }), undefined);
    for (const action of ALL_ACTIONS.filter((candidate) => candidate !== "watch")) {
      const outcome = await delegate.callTool(lane.context, { name: EXECUTION_TOOL_NAMES[action], arguments: { executionId } });
      assert.equal(outcome, undefined, `${action} is unavailable on the lane`);
    }
    assert.equal(host.handlerCalls.length, before, "no unavailable action reached the handler");
    assert.equal(host.groupCount(), 1, "the lane created no group");
  } finally {
    await host.dispose();
  }
});

test("why Start stays unavailable: the canonical handler has no lane fence after admission", async () => {
  // A direct shared Start whose admission re-proves a lane exactly as the
  // delegate does. Revoking the lane after admission, while the handler runs
  // its pre-commit awaits, does not stop the controller from attaching the group.
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
    assert.equal(lane.context.isCurrent(), false);
    assert.equal(result.isError, false, "the controller committed after the lane was revoked");
    assert.equal(host.groupCount(), 1);

    // Through the delegate, the same request never reaches the manager.
    host.hooks.beforeHandler = undefined;
    const fresh = laneContext();
    const delegate = createNativeManagedToolDelegate({ resolveScope: exactResolver(fresh, host, ["start"]).resolver });
    assert.deepEqual(await delegate.listTools(fresh.context), []);
    assert.equal(await delegate.callTool(fresh.context, { name: "SubtasksStart", arguments: startArgs("via lane") }), undefined);
    assert.equal(host.handlerCalls.length, 1);
    assert.equal(host.groupCount(), 1);
  } finally {
    await host.dispose();
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
    assert.deepEqual(await delegate.listTools(lane.context), [], "binding success is not exposure");
    const refused = await delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: { executionId: "exec-x", after: "1h" } });
    assert.deepEqual(refused, {
      content: [{ type: "text", text: "SubtasksWatch failed closed: SubtasksWatch is not currently exposed by this owner; nothing was started or read." }],
      isError: true,
    });
    assert.equal(await delegate.callTool(lane.context, { name: "SubtasksInspect", arguments: {} }), undefined, "inspect is not lane-fenced");
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
      return manager && { owner: ownerOf(context), manager: manager.manager, actions: ["start", "watch"] };
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
    assert.deepEqual((await source.endpoint.listTools({ signal: signal() })).map((tool) => tool.name), ["SubtasksWatch"]);
    assert.equal(await source.endpoint.callTool({ name: "SubtasksStart", arguments: startArgs("lane"), signal: signal() }), undefined);
    const armed = await watch();
    assert.equal(armed?.isError, false);
    assert.match(String(armed?.content[0]!.text), /^SubtasksWatch armed for exec-/);
    assert.deepEqual(host.armedWatches(), [executionId]);

    // Identity change revokes the lane; a manager for the new conversation is never reached.
    owned.set(`${id}\0${UUID_C}`, host);
    assert.equal(observer.identity(UUID_C), true);
    assert.equal(source.released, 1);
    await assert.rejects(watch(), /native MCP lane/);
    assert.equal(host.handlerCalls.length, handled + 1, "only the one proved Watch reached the handler");
    assert.equal(host.groupCount(), 1, "the lane never created work");
  } finally {
    await manager.dispose();
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
