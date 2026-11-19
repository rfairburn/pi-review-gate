/**
 * Opt-in destination workspace creation (issue #493): the shared wire and
 * local contracts.
 *
 * Pinned here: the optional boolean is validated (never coerced), `false` and
 * omission keep the exact legacy shapes and bytes, `true` exists only where it
 * was explicitly negotiated or declared, and an owner that did not negotiate it
 * refuses the frame instead of ignoring the field. The filesystem behaviour
 * itself is covered by the profiles and manager suites; Main's routing by the
 * routed-spawn Main suite; the paired coordinator end to end by the native
 * create coordinator suite.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";

import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import type { OwningHostInventorySnapshot } from "../src/session-host/owning-host-service";
import {
  isOwnerSessionSpawnRequest,
  type OwnerCreateRequest,
  type OwnerNativeCreateRequest,
  type OwnerSessionSpawnRequest,
} from "../src/session-host/network/peer-create";
import { attachRosterBridgeViewer } from "../src/session-host/network/roster-bridge-client";
import { createRosterBridgeHost, type RosterBridgeHostOptions } from "../src/session-host/network/roster-bridge-host";
import {
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_WORKSPACE_CAPABILITY,
  ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_NATIVE_CAPABILITY,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  ROSTER_BRIDGE_SESSION_SPAWN_CAPABILITY,
  SESSION_SPAWN_FRAGMENT_BYTES,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  reviewRosterBridgeHelloAck,
  type RosterBridgeFrame,
} from "../src/session-host/network/roster-bridge-protocol";
import {
  parseBootstrap,
  parseSpawnRequest,
  requiresRoutedSessionSpawn,
} from "../src/session-host/protocol";
import {
  parseSessionSpawnInput,
  registerSessionSpawnTool,
  sessionSpawnToolSchema,
} from "../src/session-host/spawn-tool";

const RUN = "owner-run";
const TOKEN = "a".repeat(64);
const ID = "11111111-1111-4111-8111-111111111111";

// ------------------------------------------------------------ wire codec

test("the roster capability is known, distinct, and requires a creation lane in an acknowledgement", () => {
  assert.equal(ROSTER_BRIDGE_CREATE_WORKSPACE_CAPABILITY, "roster-create-workspace-v1");
  assert.ok(ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES.includes(ROSTER_BRIDGE_CREATE_WORKSPACE_CAPABILITY));
  const offered = {
    capabilities: [
      ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY,
      ROSTER_BRIDGE_SESSION_SPAWN_CAPABILITY, ROSTER_BRIDGE_CREATE_WORKSPACE_CAPABILITY,
    ],
  };
  const ack = (capabilities: string[]) => reviewRosterBridgeHelloAck({
    type: "hello_ack", service: ROSTER_BRIDGE_SERVICE, major: ROSTER_BRIDGE_MAJOR, minor: 0,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ...capabilities],
  }, offered);
  assert.deepEqual(ack([ROSTER_BRIDGE_CREATE_WORKSPACE_CAPABILITY]), { ok: false, code: "protocol_violation" },
    "an acknowledgement without any creation lane is a violation");
  for (const lane of [ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY, ROSTER_BRIDGE_SESSION_SPAWN_CAPABILITY]) {
    assert.equal(ack([lane, ROSTER_BRIDGE_CREATE_WORKSPACE_CAPABILITY]).ok, true, `${lane} alone is a sufficient lane`);
  }
});

test("create frames decode an explicit boolean, drop false, reject non-booleans, and encode only true", () => {
  const create = { type: "create_request", requestId: "r1", hostRunId: RUN, workspace: "/w", sequence: 1 } as const;
  const native = { ...create, type: "create_native_request", backend: "claude", targetId: "claude" } as const;
  for (const legacy of [create, native]) {
    const legacyBytes = encodeRosterBridgeFrame(legacy as RosterBridgeFrame);
    assert.equal(legacyBytes.toString("utf8").includes("createWorkspace"), false, "the legacy bytes are unchanged");
    const decodeText = (value: unknown) => decodeRosterBridgeFrame(Buffer.from(JSON.stringify({ ...legacy, createWorkspace: value })));
    assert.equal(Object.hasOwn(decodeText(false), "createWorkspace"), false, "an explicit false decodes to the legacy request");
    assert.equal((decodeText(true) as { createWorkspace?: boolean }).createWorkspace, true);
    for (const bad of ["true", 1, null, {}]) {
      assert.throws(() => decodeText(bad), (error: unknown) => (error as { code?: string }).code === "bad_frame",
        `${JSON.stringify(bad)} is not a boolean`);
    }
    const trueBytes = encodeRosterBridgeFrame({ ...legacy, createWorkspace: true } as RosterBridgeFrame);
    assert.equal(JSON.parse(trueBytes.toString("utf8")).createWorkspace, true);
    assert.throws(() => encodeRosterBridgeFrame({ ...legacy, createWorkspace: false } as unknown as RosterBridgeFrame),
      (error: unknown) => (error as { code?: string }).code === "invalid_frame", "this side never encodes false");
  }
});

test("the prompted spawn payload admits only an optional boolean createWorkspace", () => {
  const base: OwnerSessionSpawnRequest = { hostRunId: RUN, kind: "pi", workspace: "/w", title: "t", prompt: "p" };
  assert.equal(isOwnerSessionSpawnRequest(base), true);
  assert.equal(isOwnerSessionSpawnRequest({ ...base, createWorkspace: true }), true);
  assert.equal(isOwnerSessionSpawnRequest({ ...base, createWorkspace: false }), true);
  assert.equal(isOwnerSessionSpawnRequest({ ...base, createWorkspace: "true" }), false);
  assert.equal(isOwnerSessionSpawnRequest({ ...base, createWorkspace: true, extra: 1 }), false);
  assert.equal(isOwnerSessionSpawnRequest({ ...base, host: "x" }), false, "the key set otherwise stays closed");
});

// --------------------------------------------------------- local protocol

test("the local bootstrap marker exists only beside routing and only as mode 1", () => {
  const bootstrap = { version: 1, socketPath: "/tmp/socket-path", token: TOKEN, instanceId: ID, generation: ID };
  assert.equal(parseBootstrap({ ...bootstrap, spawnRouting: 1, spawnCreateWorkspace: 1 })?.spawnCreateWorkspace, 1);
  assert.equal(parseBootstrap({ ...bootstrap, spawnCreateWorkspace: 1 }), undefined, "never without routing");
  for (const bad of [true, 2, "1", 0]) {
    assert.equal(parseBootstrap({ ...bootstrap, spawnRouting: 1, spawnCreateWorkspace: bad }), undefined);
  }
  assert.equal(Object.hasOwn(parseBootstrap({ ...bootstrap, spawnRouting: 1 })!, "spawnCreateWorkspace"), false);
});

test("a local spawn frame carries createWorkspace only as true, only in the routed family", () => {
  const frame = {
    version: 1, instanceId: ID, generation: ID, token: TOKEN, requestId: ID, workspace: "/w", title: "t",
    payload: { name: `p-${"c".repeat(32)}.json`, size: 3, sha256: "b".repeat(64) },
  };
  assert.equal(parseSpawnRequest({ ...frame, type: "spawn_routed_request", createWorkspace: true })?.createWorkspace, true);
  assert.equal(parseSpawnRequest({ ...frame, type: "spawn_request", createWorkspace: true }), undefined,
    "a legacy-family frame can never smuggle creation intent");
  assert.equal(parseSpawnRequest({ ...frame, type: "spawn_routed_request", createWorkspace: "yes" }), undefined);
  const falseLegacy = parseSpawnRequest({ ...frame, type: "spawn_request", createWorkspace: false });
  assert.ok(falseLegacy);
  assert.equal(Object.hasOwn(falseLegacy, "createWorkspace"), false, "false is the legacy request");
  assert.equal(parseSpawnRequest({ ...frame, type: "spawn_routed_request", createWorkspace: false }), undefined,
    "false alone is not a routed request");
  assert.equal(requiresRoutedSessionSpawn({ createWorkspace: true }), true);
  assert.equal(requiresRoutedSessionSpawn({ createWorkspace: false }), false);
});

// ------------------------------------------------------------- model tool

test("SessionSpawn validates createWorkspace and advertises it only with the declared capability", async () => {
  const valid = { workspace: "/w", title: "t", prompt: "p" };
  assert.deepEqual(parseSessionSpawnInput({ ...valid, createWorkspace: true }), { ...valid, createWorkspace: true });
  assert.deepEqual(parseSessionSpawnInput({ ...valid, createWorkspace: false }), valid, "false is the exact legacy input");
  for (const bad of ["true", 1, null]) {
    assert.throws(() => parseSessionSpawnInput({ ...valid, createWorkspace: bad }), /createWorkspace must be a boolean/);
  }
  const legacySchema = sessionSpawnToolSchema(30, { routing: true, discovery: true });
  assert.equal(Object.hasOwn(legacySchema.properties as object, "createWorkspace"), false, "unchanged without support");
  const schema = sessionSpawnToolSchema(30, { routing: true, createWorkspace: true }) as {
    properties: Record<string, { type?: string; description: string }>;
  };
  assert.equal(schema.properties.createWorkspace?.type, "boolean");
  assert.match(schema.properties.createWorkspace!.description, /recursive mkdir/);
  assert.match(schema.properties.createWorkspace!.description, /not removed if the launch then fails/);
  assert.match(schema.properties.createWorkspace!.description, /never creates worktrees, clones, or branches/);

  const register = (capability: Record<string, unknown>) => {
    const tools: Record<string, unknown>[] = [];
    assert.equal(registerSessionSpawnTool({ registerTool: (tool: Record<string, unknown>) => tools.push(tool) }, capability as never), true);
    return tools[0] as { parameters: { properties: Record<string, unknown> }; execute: (id: string, params: unknown) => Promise<unknown> };
  };
  const calls: unknown[] = [];
  const spawn = async (input: unknown) => { calls.push(input); return "started" as const; };
  const routedOnly = register({ titleColumns: 30, routing: true, spawn });
  assert.equal(Object.hasOwn(routedOnly.parameters.properties, "createWorkspace"), false);
  await assert.rejects(routedOnly.execute("id", { ...valid, createWorkspace: true }), /createWorkspace is not available.*nothing was started/);
  assert.deepEqual(calls, [], "an unsupported creation request is never dropped and launched");
  const declared = register({ titleColumns: 30, routing: true, createWorkspace: true, spawn });
  assert.equal(Object.hasOwn(declared.parameters.properties, "createWorkspace"), true);
  await declared.execute("id", { ...valid, createWorkspace: true });
  assert.deepEqual(calls, [{ ...valid, createWorkspace: true }]);
});

// ------------------------------------------------- owner bridge (raw frames)

class Channel implements PeerByteChannel {
  readonly lane = "app";
  readonly label = "synthetic-loopback";
  readonly peerKey = { keyId: "key", fingerprint: "synthetic-key" };
  readonly bufferedAmount = 0;
  readonly frames: RosterBridgeFrame[] = [];
  peer!: Channel;
  readonly handlers = new Set<(bytes: Buffer) => void>();
  done = false;
  resolveClosed!: (value: PeerChannelClose) => void;
  readonly closed = new Promise<PeerChannelClose>(resolve => { this.resolveClosed = resolve; });
  send(bytes: Uint8Array): Promise<void> {
    if (this.done) return Promise.reject(new Error("closed"));
    this.frames.push(decodeRosterBridgeFrame(Buffer.from(bytes)));
    queueMicrotask(() => { for (const handler of this.peer.handlers) handler(Buffer.from(bytes)); });
    return Promise.resolve();
  }
  close(): Promise<void> {
    for (const side of [this, this.peer]) {
      if (!side.done) { side.done = true; side.resolveClosed({ code: 1000, reason: "test" }); }
    }
    return Promise.resolve();
  }
  onMessage(handler: (bytes: Buffer) => void): () => void {
    this.handlers.add(handler); return () => { this.handlers.delete(handler); };
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

interface Recorded {
  readonly create: OwnerCreateRequest[];
  readonly native: OwnerNativeCreateRequest[];
  readonly spawn: OwnerSessionSpawnRequest[];
}

async function bridge(t: TestContext, options: { declare?: boolean; offer?: boolean } = {}) {
  const ownerSide = new Channel();
  const viewerSide = new Channel();
  ownerSide.peer = viewerSide; viewerSide.peer = ownerSide;
  const recorded: Recorded = { create: [], native: [], spawn: [] };
  const started = (hostRunId: string) => ({ kind: "started" as const, hostRunId, rowId: "row" });
  const snapshot = (): OwningHostInventorySnapshot => ({ hostRunId: RUN, revision: 1, rows: [] });
  const hostOptions: RosterBridgeHostOptions = {
    inventory: { watchInventory() { return { snapshot: snapshot(), unsubscribe() {} }; } },
    authorizePeer: () => true,
    createOwnedSession: async (request) => { recorded.create.push(request); return started(request.hostRunId); },
    spawnOwnedSession: async (request) => { recorded.spawn.push(request); return started(request.hostRunId); },
    nativeCreateOwnedSession: async (request) => { recorded.native.push(request); return started(request.hostRunId); },
    nativeCliTargets: () => [{ id: "claude", backend: "claude", label: "Claude" }],
    ...(options.declare === true ? { createWorkspaceSupported: true } : {}),
    bounds: { createResultTimeoutMs: 150, stopAckTimeoutMs: 50 },
  };
  const host = createRosterBridgeHost(hostOptions);
  host.attach(ownerSide);
  const viewer = attachRosterBridgeViewer({
    channel: viewerSide,
    bounds: { createResultTimeoutMs: 150, stopAckTimeoutMs: 50 },
    capabilities: [ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY, ROSTER_BRIDGE_SESSION_SPAWN_CAPABILITY,
      ...(options.offer === false ? [] : [ROSTER_BRIDGE_CREATE_WORKSPACE_CAPABILITY])],
  });
  const keepAlive = setInterval(() => undefined, 1000);
  t.after(async () => {
    try { await viewer.stop(); await host.stopAll(); await viewerSide.close(); } finally { clearInterval(keepAlive); }
  });
  await viewer.hello;
  await viewer.subscribe();
  await until(() => viewer.projection.state === "current");
  return { viewer, viewerSide, ownerSide, recorded };
}

function spawnFrames(request: Record<string, unknown>, sequence: number): RosterBridgeFrame[] {
  const bytes = Buffer.from(JSON.stringify(request));
  const requestId = `spawn-${sequence}`;
  const frames: RosterBridgeFrame[] = [{ type: "spawn_begin", requestId, hostRunId: RUN, sequence, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") }];
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += SESSION_SPAWN_FRAGMENT_BYTES) {
    frames.push({ type: "spawn_chunk", requestId, index: index++,
      data: bytes.subarray(offset, offset + SESSION_SPAWN_FRAGMENT_BYTES).toString("base64") });
  }
  frames.push({ type: "spawn_end", requestId, chunks: index });
  return frames;
}

const violated = (side: Channel) => side.done || side.frames.some(frame => frame.type === "error");

test("an owner acknowledges creation only when it declared support and the peer offered it", async t => {
  const declared = await bridge(t, { declare: true });
  assert.equal(declared.viewer.supportsCreateWorkspace, true);
  const notDeclared = await bridge(t, { declare: false });
  assert.equal(notDeclared.viewer.supportsCreateWorkspace, false);
  const notOffered = await bridge(t, { declare: true, offer: false });
  assert.equal(notOffered.viewer.supportsCreateWorkspace, false);
  assert.throws(() => createRosterBridgeHost({
    inventory: { watchInventory() { return { snapshot: { hostRunId: RUN, revision: 1, rows: [] }, unsubscribe() {} }; } },
    authorizePeer: () => true,
    createWorkspaceSupported: true,
  }), /requires a creation provider/);
  assert.throws(() => createRosterBridgeHost({
    inventory: { watchInventory() { return { snapshot: { hostRunId: RUN, revision: 1, rows: [] }, unsubscribe() {} }; } },
    authorizePeer: () => true,
    createOwnedSession: async () => ({ kind: "refused" }),
    createWorkspaceSupported: "yes" as unknown as boolean,
  }), /boolean workspace-creation declaration/);
});

for (const lane of ["create_request", "create_native_request", "spawn"] as const) {
  test(`an unnegotiated ${lane} carrying createWorkspace is a violation that reaches no provider`, async t => {
    const h = await bridge(t, { declare: false });
    const frames: RosterBridgeFrame[] = lane === "spawn"
      ? spawnFrames({ hostRunId: RUN, kind: "pi", workspace: "/w", title: "t", prompt: "p", createWorkspace: true }, 1)
      : [{
        type: lane, requestId: "r1", hostRunId: RUN, workspace: "/w", sequence: 1, createWorkspace: true,
        ...(lane === "create_native_request" ? { backend: "claude", targetId: "claude" } : {}),
      } as RosterBridgeFrame];
    for (const frame of frames) await h.viewerSide.send(encodeRosterBridgeFrame(frame));
    await tick();
    await until(() => violated(h.ownerSide));
    assert.deepEqual(h.recorded, { create: [], native: [], spawn: [] }, "never ignored, never served as a plain create");
  });
}

test("a negotiated owner forwards only true and never a false or absent flag on every lane", async t => {
  const h = await bridge(t, { declare: true });
  const result = (await h.viewer.createSession({ hostRunId: RUN, workspace: "/w", createWorkspace: true })).kind;
  assert.equal(result, "owner-result");
  assert.equal((await h.viewer.createSession({ hostRunId: RUN, workspace: "/w", createWorkspace: false })).kind, "owner-result");
  assert.equal((await h.viewer.createNativeSession({ hostRunId: RUN, workspace: "/w", backend: "claude", targetId: "claude", createWorkspace: true })).kind, "owner-result");
  assert.equal((await h.viewer.spawnSession!({ hostRunId: RUN, kind: "codex", workspace: "/w", title: "t", prompt: "p", createWorkspace: true })).kind, "owner-result");
  assert.equal((await h.viewer.spawnSession!({ hostRunId: RUN, kind: "pi", workspace: "/w", title: "t", prompt: "p", createWorkspace: false })).kind, "owner-result");
  assert.deepEqual(h.recorded.create, [{ hostRunId: RUN, workspace: "/w", createWorkspace: true }, { hostRunId: RUN, workspace: "/w" }]);
  assert.deepEqual(h.recorded.native, [{ hostRunId: RUN, workspace: "/w", backend: "claude", targetId: "claude", createWorkspace: true }]);
  assert.equal(h.recorded.spawn[0]?.createWorkspace, true);
  assert.equal(Object.hasOwn(h.recorded.spawn[1]!, "createWorkspace"), false);
  // The emitted false requests keep the exact legacy shapes on the wire.
  const sentCreates = h.viewerSide.frames.filter(frame => frame.type === "create_request");
  assert.equal(Object.hasOwn(sentCreates[1]!, "createWorkspace"), false);
});

test("a viewer refuses to send creation intent the owner did not negotiate and sends nothing", async t => {
  const h = await bridge(t, { declare: false });
  const before = h.viewerSide.frames.length;
  const unsupported = { kind: "not-sent", reason: "capability-unsupported" };
  assert.deepEqual(await h.viewer.createSession({ hostRunId: RUN, workspace: "/w", createWorkspace: true }), unsupported);
  assert.deepEqual(await h.viewer.createNativeSession({ hostRunId: RUN, workspace: "/w", backend: "claude", targetId: "claude", createWorkspace: true }), unsupported);
  assert.deepEqual(await h.viewer.spawnSession!({ hostRunId: RUN, kind: "pi", workspace: "/w", title: "t", prompt: "p", createWorkspace: true }), unsupported);
  assert.equal(h.viewerSide.frames.length, before, "no frame was written");
  assert.deepEqual(h.recorded, { create: [], native: [], spawn: [] });
});
