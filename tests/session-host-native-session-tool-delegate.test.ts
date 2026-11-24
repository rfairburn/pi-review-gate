/**
 * #682: the native MCP lane delegate that binds the canonical SessionHosts and
 * SessionSpawn definitions to a host-supplied exact-lane capability
 * (`src/session-host/native-session-tool-delegate.ts`).
 *
 * EVIDENCE SCOPE: the real canonical definitions and handlers. Lane contexts
 * are hand-built fixtures whose `isCurrent`/`signal`/`run` the test drives,
 * and capabilities are synthetic in-memory objects. No real reporter
 * capability, `InstanceManager`, MCP stdio transport, broker, provider binary,
 * or startup activation is exercised.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionHostsResult, sessionHostsToolDefinition, SESSION_HOSTS_TOOL_NAME } from "../src/session-host/hosts-tool";
import { sessionSpawnResult, sessionSpawnToolDefinition, SESSION_SPAWN_TOOL_NAME } from "../src/session-host/spawn-tool";
import type { SessionHostSpawnCapability } from "../src/session-host/spawn-capability";
import type { NativeMcpLaneContext, NativeMcpLaneRunScope } from "../src/session-host/instances";
import type { SessionHostsInspection, SessionHostsSnapshot, SessionSpawnInput, SessionSpawnOutcome } from "../src/session-host/protocol";
import {
  createNativeSessionToolDelegate,
  unavailableNativeSessionToolHost,
  type NativeSessionToolHostResolver,
} from "../src/session-host/native-session-tool-delegate";

const STALE = /no current proved lane context/;
const INVALID_SCOPE = /host capability is invalid for this lane/;
const UNAVAILABLE = /host capability could not be resolved/;
const SNAPSHOT: SessionHostsSnapshot = {
  ownKinds: ["pi", "claude"],
  hosts: [{ id: "peer-a", label: "Laptop", kinds: ["pi"] }],
};
const SPAWN_ARGS = { workspace: "/existing", title: "Child", prompt: "Do the thing" };

interface Lane {
  readonly context: NativeMcpLaneContext;
  readonly run: NativeMcpLaneRunScope;
  /** Revokes this call: aborts its signal and fails every re-proof. */
  revoke(): void;
  /** Fails re-proof without aborting the signal. */
  fall(): void;
}

function lane(run?: NativeMcpLaneRunScope): Lane {
  const controller = new AbortController();
  let current = true;
  const scope = run ?? Object.freeze({ signal: controller.signal, isCurrent: () => current });
  const context: NativeMcpLaneContext = Object.freeze({
    rowId: "row-1",
    backend: "claude",
    workspace: "/workspace",
    conversationId: "conversation-1",
    signal: controller.signal,
    isCurrent: () => current && !controller.signal.aborted,
    run: scope,
  });
  return {
    context,
    run: scope,
    revoke: () => { current = false; controller.abort(); },
    fall: () => { current = false; },
  };
}

interface RecordingCapability extends SessionHostSpawnCapability {
  readonly spawns: Array<{ input: SessionSpawnInput; signal?: AbortSignal }>;
  readonly inspections: Array<AbortSignal | undefined>;
}

function capability(options: {
  routing?: boolean;
  discovery?: boolean;
  spawn?: (input: SessionSpawnInput, signal?: AbortSignal) => Promise<SessionSpawnOutcome>;
  inspect?: (signal?: AbortSignal) => Promise<SessionHostsInspection>;
} = {}): RecordingCapability {
  const spawns: RecordingCapability["spawns"] = [];
  const inspections: RecordingCapability["inspections"] = [];
  return {
    titleColumns: 30,
    ...(options.routing === true ? { routing: true } : {}),
    spawns,
    inspections,
    async spawn(input, signal) {
      spawns.push({ input, ...(signal ? { signal } : {}) });
      return options.spawn ? options.spawn(input, signal) : "started";
    },
    ...(options.discovery === true ? {
      async inspectHosts(signal?: AbortSignal): Promise<SessionHostsInspection> {
        inspections.push(signal);
        return options.inspect ? options.inspect(signal) : { outcome: "complete", snapshot: SNAPSHOT };
      },
    } : {}),
  };
}

/** A resolver answering one exact capability for one exact lane, recording each context it saw. */
function exactResolver(target: Lane, cap: SessionHostSpawnCapability, seen: NativeMcpLaneContext[] = []): NativeSessionToolHostResolver {
  return (context) => {
    seen.push(context);
    if (context !== target.context) return undefined;
    const { rowId, backend, workspace, conversationId } = context;
    return { owner: { rowId, backend, workspace, conversationId, run: context.run! }, capability: cap };
  };
}

async function canonicalError(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("expected the canonical handler to reject");
}

describe("native MCP SessionHosts/SessionSpawn lane delegate", () => {
  it("exposes neither tool without a resolver, a resolver answer, or an exact-run scope", async () => {
    const target = lane();
    for (const delegate of [
      createNativeSessionToolDelegate(),
      createNativeSessionToolDelegate({ resolveHost: unavailableNativeSessionToolHost }),
      createNativeSessionToolDelegate({ resolveHost: () => undefined }),
    ]) {
      assert.deepEqual(await delegate.listTools(target.context), []);
      for (const name of [SESSION_HOSTS_TOOL_NAME, SESSION_SPAWN_TOOL_NAME]) {
        assert.equal(await delegate.callTool(target.context, { name, arguments: {} }), undefined);
      }
    }

    // A context that cannot be tied to one launch never reaches the resolver.
    let resolved = 0;
    const delegate = createNativeSessionToolDelegate({ resolveHost: () => { resolved += 1; return undefined; } });
    const { run: _run, ...withoutRun } = target.context;
    assert.deepEqual(await delegate.listTools(Object.freeze(withoutRun)), []);
    assert.equal(await delegate.callTool(Object.freeze(withoutRun), { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }), undefined);
    assert.equal(resolved, 0);

    assert.throws(() => createNativeSessionToolDelegate({ resolveHost: "nope" as never }), /requires a host resolver function/);
  });

  it("lists exactly the canonical definitions the capability supports", async () => {
    const target = lane();
    const routed = capability({ routing: true, discovery: true });
    const delegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, routed) });
    const hosts = sessionHostsToolDefinition(routed)!;
    const spawn = sessionSpawnToolDefinition(routed)!;
    assert.deepEqual(await delegate.listTools(target.context), [
      {
        name: hosts.name,
        description: hosts.description,
        inputSchema: hosts.parameters,
        outputSchema: hosts.outputSchema,
        annotations: { ...hosts.annotations },
      },
      { name: spawn.name, description: spawn.description, inputSchema: spawn.parameters },
    ]);

    // Legacy capability: SessionSpawn only, with its own canonical schema.
    const legacy = capability();
    const legacyDelegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, legacy) });
    const legacyTools = await legacyDelegate.listTools(target.context);
    assert.deepEqual(legacyTools.map((tool) => tool.name), [SESSION_SPAWN_TOOL_NAME]);
    assert.deepEqual(legacyTools[0]!.inputSchema, sessionSpawnToolDefinition(legacy)!.parameters);
    assert.equal(await legacyDelegate.callTool(target.context, { name: SESSION_HOSTS_TOOL_NAME, arguments: {} }), undefined);
    assert.equal(await legacyDelegate.callTool(target.context, { name: "Other", arguments: {} }), undefined);

    // An invalid title-space snapshot: the canonical builder declines, so nothing is listed.
    const invalid = { ...legacy, titleColumns: 0 };
    assert.deepEqual(await createNativeSessionToolDelegate({ resolveHost: exactResolver(target, invalid) }).listTools(target.context), []);
  });

  it("returns canonical results and passes the call's own signal to the capability", async () => {
    const target = lane();
    const cap = capability({ routing: true, discovery: true });
    const delegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, cap) });

    const canonicalHosts = sessionHostsResult(SNAPSHOT);
    assert.deepEqual(await delegate.callTool(target.context, { name: SESSION_HOSTS_TOOL_NAME, arguments: {} }), {
      content: canonicalHosts.content,
      structuredContent: canonicalHosts.structuredContent,
      isError: false,
    });
    assert.equal(cap.inspections.length, 1);
    assert.equal(cap.inspections[0], target.context.signal);

    const args = { ...SPAWN_ARGS, host: "peer-a", kind: "codex" };
    assert.deepEqual(await delegate.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: args }), {
      content: sessionSpawnResult("started").content,
      isError: false,
    });
    assert.deepEqual(cap.spawns.map((call) => call.input), [args]);
    assert.equal(cap.spawns[0]!.signal, target.context.signal);

    for (const outcome of ["failed", "unknown"] as const) {
      const other = capability({ spawn: async () => outcome });
      const result = await createNativeSessionToolDelegate({ resolveHost: exactResolver(target, other) })
        .callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS });
      assert.deepEqual(result, { content: sessionSpawnResult(outcome).content, isError: false });
    }
  });

  it("forwards canonical validation and refusal text without invoking the capability", async () => {
    const target = lane();
    const legacy = capability();
    const delegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, legacy) });
    const canonical = sessionSpawnToolDefinition(capability())!;
    for (const args of [
      { workspace: "/existing", title: "Child" },
      { ...SPAWN_ARGS, extra: true },
      { ...SPAWN_ARGS, host: "peer-a" },
      { ...SPAWN_ARGS, createWorkspace: true },
    ]) {
      assert.deepEqual(await delegate.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: args }), {
        content: [{ type: "text", text: await canonicalError(() => canonical.execute(args)) }],
        isError: true,
      });
    }
    assert.deepEqual(legacy.spawns, []);

    const unavailable = async (): Promise<SessionHostsInspection> => ({ outcome: "unavailable", reason: "timeout" });
    const routed = capability({ routing: true, discovery: true, inspect: unavailable });
    const hostsDelegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, routed) });
    const hostsCanonical = sessionHostsToolDefinition(capability({ routing: true, discovery: true, inspect: unavailable }))!;
    assert.deepEqual(await hostsDelegate.callTool(target.context, { name: SESSION_HOSTS_TOOL_NAME, arguments: {} }), {
      content: [{ type: "text", text: await canonicalError(() => hostsCanonical.execute({})) }],
      isError: true,
    });
    const before = routed.inspections.length;
    assert.deepEqual(await hostsDelegate.callTool(target.context, { name: SESSION_HOSTS_TOOL_NAME, arguments: { x: 1 } }), {
      content: [{ type: "text", text: await canonicalError(() => hostsCanonical.execute({ x: 1 })) }],
      isError: true,
    });
    assert.equal(routed.inspections.length, before);
  });

  it("never forwards a capability failure as model text", async () => {
    const target = lane();
    const cap = capability({ spawn: async () => { throw new Error("internal reporter detail"); } });
    const delegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, cap) });
    await assert.rejects(delegate.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }), /internal reporter detail/);
    assert.equal(cap.spawns.length, 1);
  });

  it("refuses a stale lane or a capability resolved for another lane before any effect", async () => {
    const cap = capability({ routing: true, discovery: true });

    const stale = lane();
    const seen: NativeMcpLaneContext[] = [];
    const delegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(stale, cap, seen) });
    stale.fall();
    await assert.rejects(delegate.listTools(stale.context), STALE);
    await assert.rejects(delegate.callTool(stale.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }), STALE);
    assert.equal(seen.length, 0, "a stale lane never reaches the resolver");

    // The lane falls inside the resolver: its answer is never used.
    const falling = lane();
    const fallingDelegate = createNativeSessionToolDelegate({
      resolveHost: (context) => { falling.fall(); return exactResolver(falling, cap)(context); },
    });
    await assert.rejects(fallingDelegate.callTool(falling.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }), STALE);

    // The lane falls after resolution, while the arguments are snapshotted.
    const late = lane();
    const lateDelegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(late, cap) });
    const args = { ...SPAWN_ARGS, get prompt() { late.fall(); return "Do the thing"; } };
    await assert.rejects(lateDelegate.callTool(late.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: args }), STALE);

    // The echoed identity must be the exact lane: another run object, conversation, row, backend, or workspace is refused.
    const target = lane();
    const otherRun = lane().run;
    const { rowId, backend, workspace, conversationId } = target.context;
    for (const owner of [
      { rowId, backend, workspace, conversationId, run: otherRun },
      { rowId, backend, workspace, conversationId: "conversation-2", run: target.run },
      { rowId: "row-2", backend, workspace, conversationId, run: target.run },
      { rowId, backend: "codex" as const, workspace, conversationId, run: target.run },
      { rowId, backend, workspace: "/other", conversationId, run: target.run },
    ]) {
      const mismatched = createNativeSessionToolDelegate({ resolveHost: () => ({ owner, capability: cap }) });
      await assert.rejects(mismatched.listTools(target.context), INVALID_SCOPE);
      await assert.rejects(mismatched.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }), INVALID_SCOPE);
    }
    const noSpawn = createNativeSessionToolDelegate({
      resolveHost: () => ({ owner: { rowId, backend, workspace, conversationId, run: target.run }, capability: { titleColumns: 30 } as never }),
    });
    await assert.rejects(noSpawn.listTools(target.context), INVALID_SCOPE);
    const throwing = createNativeSessionToolDelegate({ resolveHost: () => { throw new Error("owner detail"); } });
    await assert.rejects(throwing.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }), UNAVAILABLE);

    assert.deepEqual(cap.spawns, []);
    assert.deepEqual(cap.inspections, []);
  });

  it("passes cancellation through but withholds a result produced after the lane fell", async () => {
    const target = lane();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let observedAbort = false;
    const cap = capability({
      spawn: (_input, signal) => new Promise((resolve) => {
        entered();
        signal!.addEventListener("abort", () => {
          observedAbort = true;
          // A launch already sent is not rolled back: the capability still reports it.
          resolve("started");
        }, { once: true });
      }),
    });
    const delegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, cap) });
    const pending = delegate.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS });
    await started;
    target.revoke();
    await assert.rejects(pending, STALE);
    assert.equal(observedAbort, true);
    assert.equal(cap.spawns.length, 1);

    // A fresh lane is resolved under its own proof; the revoked context stays refused.
    const fresh = lane();
    const freshCap = capability();
    const freshDelegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(fresh, freshCap) });
    await assert.rejects(freshDelegate.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }), STALE);
    assert.equal((await freshDelegate.callTool(fresh.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }))?.isError, false);
    assert.equal(freshCap.spawns.length, 1);
  });

  it("serializes SessionSpawn per exact lane run, and a cancelled queued call never spawns", async (t) => {
    const target = lane();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const cap = capability({
      spawn: () => new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releases.push(() => { active -= 1; resolve("started"); });
      }),
    });
    // Separate per-request contexts on the same exact run, as the instance manager builds them.
    const second = lane(target.run);
    const third = lane(target.run);
    const detachCancelled = t.mock.method(third.context.signal, "removeEventListener");
    const resolveHost: NativeSessionToolHostResolver = (context) => {
      const { rowId, backend, workspace, conversationId } = context;
      return { owner: { rowId, backend, workspace, conversationId, run: context.run! }, capability: cap };
    };
    const delegate = createNativeSessionToolDelegate({ resolveHost });
    const call = (context: NativeMcpLaneContext, title: string) =>
      delegate.callTool(context, { name: SESSION_SPAWN_TOOL_NAME, arguments: { ...SPAWN_ARGS, title } });

    const first = call(target.context, "one");
    const queued = call(second.context, "two");
    const cancelled = call(third.context, "three");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cap.spawns.length, 1, "later calls wait for the earlier one on the same run");
    third.revoke();
    await assert.rejects(cancelled, STALE);
    assert.equal(detachCancelled.mock.callCount(), 1, "cancellation cleans up before the active spawn settles");
    // Cancelling the tail must not empty the queue while "one" runs and "two" waits.
    const fourth = lane(target.run);
    const after = call(fourth.context, "four");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cap.spawns.map((entry) => entry.input.title), ["one"], "a call after a cancelled tail still waits");
    releases.shift()!();
    assert.equal((await first)?.isError, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cap.spawns.map((entry) => entry.input.title), ["one", "two"]);
    releases.shift()!();
    assert.equal((await queued)?.isError, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cap.spawns.map((entry) => entry.input.title), ["one", "two", "four"]);
    releases.shift()!();
    assert.equal((await after)?.isError, false);
    assert.equal(maxActive, 1);
    assert.equal(cap.spawns.length, 3, "the cancelled queued call never reached the capability");

    // Once drained, a new call on the run starts immediately.
    const drained = call(lane(target.run).context, "five");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cap.spawns.length, 4);
    releases.shift()!();
    assert.equal((await drained)?.isError, false);

    // SessionHosts is not sequential and does not queue behind a pending spawn.
    const routed = capability({ routing: true, discovery: true, spawn: () => new Promise(() => {}) });
    const routedDelegate = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, routed) });
    void routedDelegate.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS });
    assert.equal((await routedDelegate.callTool(target.context, { name: SESSION_HOSTS_TOOL_NAME, arguments: {} }))?.isError, false);
  });

  it("binds a queued SessionSpawn's capability when its turn arrives, never one the host withdrew", async () => {
    const target = lane();
    const second = lane(target.run);
    let provisioned = true;
    let release!: () => void;
    const cap = capability({
      spawn: (input) => input.title === "one"
        ? new Promise((resolve) => { release = () => resolve("started"); })
        : Promise.resolve("started"),
    });
    const resolveHost: NativeSessionToolHostResolver = (context) => {
      if (!provisioned) return undefined;
      const { rowId, backend, workspace, conversationId } = context;
      return { owner: { rowId, backend, workspace, conversationId, run: context.run! }, capability: cap };
    };
    const delegate = createNativeSessionToolDelegate({ resolveHost });
    const first = delegate.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: { ...SPAWN_ARGS, title: "one" } });
    const queued = delegate.callTool(second.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: { ...SPAWN_ARGS, title: "two" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cap.spawns.length, 1);

    // The host stops supplying the capability; the exact run stays current.
    provisioned = false;
    assert.deepEqual(await delegate.listTools(second.context), []);
    release();
    assert.equal((await first)?.isError, false);
    assert.equal(await queued, undefined, "the withdrawn tool is not handled here");
    assert.equal(second.context.isCurrent(), true);
    assert.deepEqual(cap.spawns.map((entry) => entry.input.title), ["one"], "the old capability was never invoked");

    // A capability the host supplies again is bound afresh for the next call.
    const replacement = capability();
    provisioned = true;
    const fresh = createNativeSessionToolDelegate({ resolveHost: exactResolver(target, replacement) });
    assert.equal((await fresh.callTool(target.context, { name: SESSION_SPAWN_TOOL_NAME, arguments: SPAWN_ARGS }))?.isError, false);
    assert.equal(replacement.spawns.length, 1);
  });
});
