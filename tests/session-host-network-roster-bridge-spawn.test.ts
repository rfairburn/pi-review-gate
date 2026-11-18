import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import type { OwningHostInventorySnapshot } from "../src/session-host/owning-host-service";
import type { OwnerCreateFacts, OwnerSessionSpawnRequest } from "../src/session-host/network/peer-create";
import { attachRosterBridgeViewer } from "../src/session-host/network/roster-bridge-client";
import { createRosterBridgeHost, type RosterBridgeHostOptions } from "../src/session-host/network/roster-bridge-host";
import {
  decodeRosterBridgeFrame, encodeRosterBridgeFrame,
  ROSTER_BRIDGE_SESSION_SPAWN_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_NATIVE_CAPABILITY, SESSION_SPAWN_FRAGMENT_BYTES,
  type RosterBridgeFrame, type RosterBridgeSessionSpawnFrame,
} from "../src/session-host/network/roster-bridge-protocol";

const RUN = "owner-run";
const input = (kind: OwnerSessionSpawnRequest["kind"] = "pi"): OwnerSessionSpawnRequest => ({
  hostRunId: RUN, kind, workspace: " /only/on/destination/宇宙 ", title: "exact title 宇宙",
  prompt: "/command\n@file\n--flag\n Unicode 😀 é\r\n\tend\n",
});

class Channel implements PeerByteChannel {
  readonly lane = "app";
  readonly label = "synthetic-loopback";
  readonly peerKey = { keyId: "key", fingerprint: "synthetic-key" };
  readonly bufferedAmount = 0;
  readonly frames: RosterBridgeFrame[] = [];
  peer!: Channel;
  intercept?: (frame: RosterBridgeFrame) => "drop" | "reject" | void;
  readonly handlers = new Set<(bytes: Buffer) => void>();
  done = false;
  resolveClosed!: (value: PeerChannelClose) => void;
  readonly closed = new Promise<PeerChannelClose>(resolve => { this.resolveClosed = resolve; });
  send(bytes: Uint8Array): Promise<void> {
    if (this.done) return Promise.reject(new Error("closed"));
    const frame = decodeRosterBridgeFrame(Buffer.from(bytes));
    this.frames.push(frame);
    const disposition = this.intercept?.(frame);
    if (disposition === "reject") return Promise.reject(new Error("lost send"));
    if (disposition !== "drop") queueMicrotask(() => {
      for (const handler of this.peer.handlers) handler(Buffer.from(bytes));
    });
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

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function harness(t: TestContext, options: Partial<RosterBridgeHostOptions> = {}, offer = true) {
  const ownerSide = new Channel();
  const viewerSide = new Channel();
  ownerSide.peer = viewerSide; viewerSide.peer = ownerSide;
  let listener: ((snapshot: OwningHostInventorySnapshot | undefined) => void) | undefined;
  let revision = 1;
  const snapshot = (hostRunId = RUN): OwningHostInventorySnapshot => ({ hostRunId, revision: revision++, rows: [] });
  const host = createRosterBridgeHost({
    inventory: { watchInventory(notify) { listener = notify; return { snapshot: snapshot(), unsubscribe() {} }; } },
    authorizePeer: () => true,
    ...options,
    bounds: { createResultTimeoutMs: 120, stopAckTimeoutMs: 50, ...options.bounds },
  });
  host.attach(ownerSide);
  const viewer = attachRosterBridgeViewer({ channel: viewerSide,
    bounds: { createResultTimeoutMs: 150, stopAckTimeoutMs: 50, ...options.bounds },
    capabilities: [ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY,
      ...(offer ? [ROSTER_BRIDGE_SESSION_SPAWN_CAPABILITY] : [])],
  });
  // Production deadlines are unref'ed; keep this synthetic no-socket fixture alive.
  const keepAlive = setInterval(() => undefined, 1000);
  t.after(async () => {
    try { await viewer.stop(); await host.stopAll(); await viewerSide.close(); }
    finally { clearInterval(keepAlive); }
  });
  await viewer.hello;
  await viewer.subscribe();
  await until(() => viewer.projection.state === "current");
  assert.ok(viewer.spawnSession);
  return { viewer, viewerSide, ownerSide, replaceRun: () => listener?.(snapshot("replacement-run")) };
}

function stream(request: OwnerSessionSpawnRequest, sequence = 1, requestId = `request-${sequence}`): RosterBridgeSessionSpawnFrame[] {
  const bytes = Buffer.from(JSON.stringify(request));
  const frames: RosterBridgeSessionSpawnFrame[] = [{ type: "spawn_begin", requestId,
    hostRunId: request.hostRunId, sequence, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") }];
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += SESSION_SPAWN_FRAGMENT_BYTES) {
    frames.push({ type: "spawn_chunk", requestId, index: index++,
      data: bytes.subarray(offset, offset + SESSION_SPAWN_FRAGMENT_BYTES).toString("base64") });
  }
  frames.push({ type: "spawn_end", requestId, chunks: index });
  return frames;
}
async function raw(side: Channel, frames: readonly RosterBridgeFrame[]): Promise<void> {
  for (const frame of frames) await side.send(encodeRosterBridgeFrame(frame));
  await tick();
}

for (const kind of ["pi", "claude", "codex"] as const) {
  test(`prompted ${kind} routes once with exact text and final owner reproof`, { timeout: 3000 }, async t => {
    const calls: OwnerSessionSpawnRequest[] = [];
    const h = await harness(t, { spawnOwnedSession: async (request, guard) => {
      assert.equal(guard(), true); calls.push(request);
      return { kind: "started", hostRunId: request.hostRunId, rowId: `child-${kind}` };
    } });
    const request = input(kind);
    assert.equal(h.viewer.supportsSessionSpawn, true);
    assert.deepEqual(await h.viewer.spawnSession!(request), {
      kind: "owner-result", facts: { kind: "started", hostRunId: RUN, rowId: `child-${kind}` },
    });
    assert.deepEqual(calls, [request]); // No requester filesystem check, rewrite, or routing substitution.
    assert.equal(h.viewerSide.frames.filter(frame => frame.type === "spawn_begin").length, 1);
    assert.equal(h.viewerSide.frames.filter(frame => frame.type === "create_request" || frame.type === "create_native_request").length, 0);
  });
}

test("large multiline Unicode prompt exceeds 128 KiB but every frame stays bounded", { timeout: 3000 }, async t => {
  let received: OwnerSessionSpawnRequest | undefined;
  const h = await harness(t, { spawnOwnedSession: async request => { received = request; return { kind: "unconfirmed" }; } });
  const request = { ...input(), prompt: input().prompt.repeat(12000) + "\ud800" };
  assert.ok(Buffer.byteLength(request.prompt) > 128 * 1024);
  assert.deepEqual(await h.viewer.spawnSession!(request), { kind: "owner-result", facts: { kind: "unconfirmed" } });
  assert.deepEqual(received, request);
  assert.ok(h.viewerSide.frames.filter(frame => frame.type === "spawn_chunk").length > 8);
  for (const frame of h.viewerSide.frames) assert.ok(encodeRosterBridgeFrame(frame).length <= 64 * 1024);
});

test("fragmentation respects a smaller existing frame bound without changing payload", { timeout: 3000 }, async t => {
  let received: OwnerSessionSpawnRequest | undefined;
  const h = await harness(t, { bounds: { maxFrameBytes: 2048, maxPageBytes: 1024 },
    spawnOwnedSession: async request => { received = request; return { kind: "unconfirmed" }; } });
  const request = { ...input("codex"), prompt: input().prompt.repeat(5000) };
  assert.deepEqual(await h.viewer.spawnSession!(request), { kind: "owner-result", facts: { kind: "unconfirmed" } });
  assert.deepEqual(received, request);
  for (const frame of h.viewerSide.frames) assert.ok(encodeRosterBridgeFrame(frame).length <= 2048);
});

test("absent provider or absent offer never falls back to blank New", { timeout: 3000 }, async t => {
  let calls = 0;
  const h = await harness(t, { createOwnedSession: async () => { calls++; return { kind: "unconfirmed" }; } });
  assert.deepEqual(await h.viewer.spawnSession!(input()), { kind: "not-sent", reason: "capability-unsupported" });
  assert.deepEqual(await h.viewer.createSession({ hostRunId: RUN, workspace: "/blank" }), {
    kind: "owner-result", facts: { kind: "unconfirmed" },
  });
  assert.equal(calls, 1);
  assert.equal(h.viewerSide.frames.some(frame => frame.type === "spawn_begin"), false);
  const old = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unknown" }; } }, false);
  assert.equal(old.viewer.supportsSessionSpawn, false);
  assert.deepEqual(await old.viewer.spawnSession!(input()), { kind: "not-sent", reason: "capability-unsupported" });
  await raw(old.viewerSide, stream(input()).slice(0, 1)).catch(() => undefined);
  assert.equal(calls, 1); // Even a raw unnegotiated frame cannot reach that provider.
});

test("invalid kind/prompt/title is not submitted", { timeout: 3000 }, async t => {
  let calls = 0;
  const h = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unknown" }; } });
  for (const change of [{ kind: "other" }, { prompt: "" }, { prompt: "bad\0text" }, { title: "" }]) {
    assert.deepEqual(await h.viewer.spawnSession!({ ...input(), ...change } as OwnerSessionSpawnRequest), {
      kind: "not-sent", reason: "invalid-request",
    });
  }
  assert.equal(calls, 0);
  assert.equal(h.viewerSide.frames.some(frame => frame.type === "spawn_begin"), false);
});

for (const failure of ["missing", "hash", "index", "bytes", "invalid-json", "invalid-kind", "different-run", "changed-begin", "chunks", "payload-run", "invalid-utf8"] as const) {
  test(`incomplete/changed ${failure} stream cannot invoke provider`, { timeout: 3000 }, async t => {
    let calls = 0;
    const h = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unknown" }; } });
    let frames = stream(input());
    if (failure === "missing") frames = frames.slice(0, -1);
    if (failure === "changed-begin") frames.splice(1, 0, { ...frames[0], sha256: "f".repeat(64) } as RosterBridgeSessionSpawnFrame);
    if (failure === "chunks") frames[frames.length - 1] = { type: "spawn_end", requestId: "request-1", chunks: 99 };
    if (failure === "payload-run") {
      frames = stream({ ...input(), hostRunId: "other-run" });
      frames[0] = { ...frames[0], hostRunId: RUN } as RosterBridgeSessionSpawnFrame;
    }
    if (failure === "hash") frames[0] = { ...frames[0], sha256: "0".repeat(64) } as RosterBridgeSessionSpawnFrame;
    if (failure === "index") frames[1] = { ...frames[1], index: 1 } as RosterBridgeSessionSpawnFrame;
    if (failure === "bytes") frames[0] = { ...frames[0], bytes: 1 } as RosterBridgeSessionSpawnFrame;
    if (failure === "invalid-kind") frames = stream({ ...input(), kind: "bad" } as unknown as OwnerSessionSpawnRequest);
    if (failure === "different-run") frames[0] = { ...frames[0], hostRunId: "wrong-run" } as RosterBridgeSessionSpawnFrame;
    if (failure === "invalid-json" || failure === "invalid-utf8") {
      const bytes = failure === "invalid-utf8" ? Buffer.from([0xff, 0xfe]) : Buffer.from("not JSON");
      frames = [ { type: "spawn_begin", requestId: "request-1", hostRunId: RUN, sequence: 1,
        bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      { type: "spawn_chunk", requestId: "request-1", index: 0, data: bytes.toString("base64") },
      { type: "spawn_end", requestId: "request-1", chunks: 1 } ];
    }
    // Protocol retirement may reject later writes; no such rejection is a provider call.
    await raw(h.viewerSide, frames).catch(() => undefined);
    await tick();
    assert.equal(calls, 0);
  });
}

test("grant revoked or run replaced between fragments prevents invocation", { timeout: 3000 }, async t => {
  for (const replace of [false, true]) {
    let authorized = true;
    let calls = 0;
    const h = await harness(t, { authorizePeer: () => authorized,
      spawnOwnedSession: async () => { calls++; return { kind: "unknown" }; } });
    const frames = stream(input());
    await raw(h.viewerSide, frames.slice(0, 1));
    if (replace) h.replaceRun(); else authorized = false;
    await raw(h.viewerSide, frames.slice(1)).catch(() => undefined);
    assert.equal(calls, 0);
  }
});

test("partial-send failure and lost reply are unknown, never retried", { timeout: 3000 }, async t => {
  for (const partial of [false, true]) {
    let calls = 0;
    const h = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unconfirmed" }; } });
    if (partial) h.viewerSide.intercept = frame => frame.type === "spawn_chunk" ? "reject" : undefined;
    else h.ownerSide.intercept = frame => frame.type === "spawn_result" ? "drop" : undefined;
    assert.deepEqual(await h.viewer.spawnSession!(input()), { kind: "unknown" });
    await tick();
    assert.equal(calls, partial ? 0 : 1);
    assert.equal(h.viewerSide.frames.filter(frame => frame.type === "spawn_begin").length, 1);
  }
});

test("assembly timeout is unknown and a late end never invokes the provider", { timeout: 3000 }, async t => {
  let calls = 0;
  const h = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unconfirmed" }; } });
  h.viewerSide.intercept = frame => frame.type === "spawn_end" ? "drop" : undefined;
  assert.deepEqual(await h.viewer.spawnSession!(input()), { kind: "unknown" });
  const end = h.viewerSide.frames.find(frame => frame.type === "spawn_end");
  assert.ok(end);
  h.viewerSide.intercept = undefined;
  await raw(h.viewerSide, [end]).catch(() => undefined);
  assert.equal(calls, 0);
  assert.equal(h.viewerSide.frames.filter(frame => frame.type === "spawn_begin").length, 1);
});

test("last-instant requester proof refuses before begin, but loss after begin is unknown", { timeout: 3000 }, async t => {
  let calls = 0;
  let current = false;
  const h = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unconfirmed" }; } });
  assert.deepEqual(await h.viewer.spawnSession!(input(), { stillCurrent: () => current }),
    { kind: "not-sent", reason: "target-unavailable" });
  assert.equal(h.viewerSide.frames.some(frame => frame.type === "spawn_begin"), false);
  current = true;
  h.viewerSide.intercept = frame => { if (frame.type === "spawn_begin") current = false; };
  assert.deepEqual(await h.viewer.spawnSession!(input(), { stillCurrent: () => current }), { kind: "unknown" });
  assert.equal(calls, 0);
  assert.equal(h.viewerSide.frames.filter(frame => frame.type === "spawn_begin").length, 1);
  assert.equal(h.viewerSide.frames.some(frame => frame.type === "spawn_chunk"), false);
});

test("reentrant stop from the final spawn proof prevents end submission and provider invocation", { timeout: 3000 }, async t => {
  let calls = 0;
  let stopping: Promise<void> | undefined;
  const h = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unconfirmed" }; } });
  const request = input();
  const chunks = stream(request).filter(frame => frame.type === "spawn_chunk").length;
  const result = await h.viewer.spawnSession!(request, { stillCurrent: () => {
    if (h.viewerSide.frames.filter(frame => frame.type === "spawn_chunk").length === chunks) {
      stopping ??= h.viewer.stop();
    }
    return true;
  } });
  assert.ok(stopping, "the proof stopped this viewer immediately before spawn_end");
  await stopping;
  await tick();
  assert.deepEqual(result, { kind: "unknown" }, "already submitted fragments cannot be reported not-sent");
  assert.equal(h.viewerSide.frames.filter(frame => frame.type === "spawn_begin").length, 1);
  assert.equal(h.viewerSide.frames.filter(frame => frame.type === "spawn_chunk").length, chunks);
  assert.equal(h.viewerSide.frames.some(frame => frame.type === "spawn_end"), false);
  assert.equal(calls, 0);
});

for (const native of [false, true]) {
  test(`blank ${native ? "native" : "Pi"} also excludes prompted creates`, { timeout: 3000 }, async t => {
    let finish!: (value: OwnerCreateFacts) => void;
    let calls = 0;
    let blanks = 0;
    const blank = async (): Promise<OwnerCreateFacts> => {
      blanks++; return new Promise(resolve => { finish = resolve; });
    };
    const h = await harness(t, { spawnOwnedSession: async () => { calls++; return { kind: "unknown" }; },
      createOwnedSession: blank, nativeCreateOwnedSession: blank,
      nativeCliTargets: () => [{ id: "codex", backend: "codex", label: "Codex" }] });
    const pending = native
      ? h.viewer.createNativeSession({ hostRunId: RUN, workspace: "/blank", backend: "codex", targetId: "codex" })
      : h.viewer.createSession({ hostRunId: RUN, workspace: "/blank" });
    await until(() => blanks === 1);
    assert.deepEqual(await h.viewer.spawnSession!(input()), { kind: "not-sent", reason: "busy" });
    await raw(h.viewerSide, stream(input(), 2, "busy-prompted").slice(0, 1));
    assert.equal(calls, 0);
    finish({ kind: "unconfirmed" });
    assert.deepEqual(await pending, { kind: "owner-result", facts: { kind: "unconfirmed" } });
    await raw(h.viewerSide, stream(input(), 2, "replay-prompted").slice(0, 1));
    assert.equal(calls, 0);
  });
}

test("accepted work survives requester disappearance and reply reauthorizes", { timeout: 3000 }, async t => {
  let finish!: (value: OwnerCreateFacts) => void;
  let authorized = true;
  let calls = 0;
  const h = await harness(t, { authorizePeer: () => authorized, spawnOwnedSession: async () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } });
  const result = h.viewer.spawnSession!(input());
  await until(() => calls === 1);
  authorized = false;
  finish({ kind: "unconfirmed" });
  assert.deepEqual(await result, { kind: "unknown" });
  assert.equal(h.ownerSide.frames.some(frame => frame.type === "spawn_result"), false);

  let completed = false;
  const gone = await harness(t, { spawnOwnedSession: async () => {
    await tick(); completed = true; return { kind: "unconfirmed" };
  } });
  const pending = gone.viewer.spawnSession!(input());
  await until(() => gone.viewerSide.frames.some(frame => frame.type === "spawn_end"));
  await gone.viewerSide.close();
  assert.deepEqual(await pending, { kind: "unknown" });
  await until(() => completed);
});

test("prompted and both blank creates share busy slot and monotonic replay fence", { timeout: 3000 }, async t => {
  let finish!: (value: OwnerCreateFacts) => void;
  let calls = 0;
  let blanks = 0;
  const h = await harness(t, { spawnOwnedSession: async () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  }, createOwnedSession: async () => { blanks++; return { kind: "unconfirmed" }; },
  nativeCliTargets: () => [{ id: "codex", backend: "codex", label: "Codex" }],
  nativeCreateOwnedSession: async () => { blanks++; return { kind: "unconfirmed" }; } });
  const pending = h.viewer.spawnSession!(input());
  await until(() => calls === 1);
  assert.deepEqual(await h.viewer.createSession({ hostRunId: RUN, workspace: "/blank" }), { kind: "not-sent", reason: "busy" });
  assert.deepEqual(await h.viewer.createNativeSession({ hostRunId: RUN, workspace: "/blank", backend: "codex", targetId: "codex" }),
    { kind: "not-sent", reason: "busy" });
  assert.deepEqual(await h.viewer.spawnSession!(input()), { kind: "not-sent", reason: "busy" });
  // Malicious peer bypassing local busy still cannot invoke a second owner provider.
  await raw(h.viewerSide, stream(input(), 2, "second").slice(0, 1));
  assert.equal(calls, 1);
  const original = h.viewerSide.frames.filter(frame => ["spawn_begin", "spawn_chunk", "spawn_end"].includes(frame.type)
    && "requestId" in frame && frame.requestId !== "second");
  await raw(h.viewerSide, original.slice(0, 1)); // Active replay must not settle as refused.
  finish({ kind: "unconfirmed" });
  assert.deepEqual(await pending, { kind: "owner-result", facts: { kind: "unconfirmed" } });
  await raw(h.viewerSide, original.slice(0, 1));
  assert.equal(calls, 1);
  // The rejected busy attempt consumed #2. A blank Pi attempt with #2 cannot invoke.
  await raw(h.viewerSide, [{ type: "create_request", requestId: "replay-blank", hostRunId: RUN, workspace: "/blank", sequence: 2 }]);
  assert.equal(blanks, 0);
});
