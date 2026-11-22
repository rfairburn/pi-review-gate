/**
 * Trusted Codex callback write transport (#682), synthetic sockets only.
 *
 * An in-process RFC6455 server on an ephemeral 127.0.0.1 port (bearer-checked
 * upgrade, scripted JSON-RPC answers) stands in for the owned app-server, and a
 * fake lease stands in for the host's owned backend lease. No live provider,
 * child process, setting, or filesystem scratch is used; every server and
 * socket is closed before each test ends.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import test, { type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createNativeCodexCallbackComposer,
  type NativeCodexCallbackQueueWriteEdge,
  type NativeCodexCallbackRootFacts,
} from "../src/session-host/native-codex-callback-composition";
import type { NativeCodexCallbackSteerParams } from "../src/session-host/native-codex-callback-delivery";
import {
  openNativeCodexCallbackTransport,
  type NativeCodexCallbackTransport,
  type NativeCodexCallbackTransportOptions,
} from "../src/session-host/native-codex-callback-transport";

const TOKEN = "synthetic-bearer-682-0123456789abcdef";
const THREAD = "019a0000-0000-7000-8000-00000000c682";
const OTHER_THREAD = "019a0000-0000-7000-8000-0000000other";
const RUN = "run-generation-1";
const TURN_OLD = "turn-old-0";
const TURN_BUSY = "turn-busy-1";
const ROW = "queued-row-1";
const TEXT = "CALLBACK-TEXT-SENTINEL: worker finished";
const CODEX_HOME = "/synthetic/codex-home";
const BUSY_MESSAGE = "thread already has an active or pending turn";

/* ----------------------------------------------------------- fake server */

type Frame = Record<string, unknown>;
/** Returns the answer to send (without `jsonrpc`/`id`), or null to stay silent. */
type Responder = (frame: Frame, socket: WebSocket) => Frame | null;

interface FakeServer {
  readonly port: number;
  readonly frames: Frame[];
  upgrades: number;
  respond: Responder;
  readonly sockets: Set<WebSocket>;
  methods(): string[];
  close(): Promise<void>;
}

const defaultResponder: Responder = (frame) => {
  switch (frame.method) {
    case "initialize":
      return { result: { codexHome: CODEX_HOME, userAgent: "synthetic", platformFamily: "unix" } };
    case "thread/queue/add":
      return {
        result: {
          queuedSubmission: {
            id: ROW,
            input: (frame.params as Frame).input,
            clientUserMessageId: (frame.params as Frame).clientUserMessageId,
          },
        },
      };
    case "thread/queue/start":
      return { result: { turn: { id: "turn-new-9", status: "inProgress" } } };
    case "turn/steer":
      return { result: { turnId: (frame.params as Frame).expectedTurnId } };
    default:
      return { error: { code: -32601, message: "method not found" } };
  }
};

async function startServer(t: TestContext): Promise<FakeServer> {
  const http_ = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const server: FakeServer = {
    port: 0,
    frames: [],
    upgrades: 0,
    respond: defaultResponder,
    sockets,
    methods: () => server.frames.map((frame) => String(frame.method ?? "<response>")),
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http_.close(() => resolve()));
    },
  };
  http_.on("upgrade", (req, socket, head) => {
    server.upgrades += 1;
    if (req.url !== "/rpc" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket as net.Socket, head, (client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Frame;
        server.frames.push(frame);
        if (frame.id === undefined) return; // `initialized` notification
        const answer = server.respond(frame, client);
        if (answer !== null) client.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...answer }));
      });
    });
  });
  await new Promise<void>((resolve) => http_.listen(0, "127.0.0.1", () => resolve()));
  const address = http_.address();
  assert.ok(address !== null && typeof address === "object");
  (server as { port: number }).port = address.port;
  t.after(() => server.close());
  return server;
}

/* ------------------------------------------------------------ fake lease */

interface LeaseStatus {
  identity: { leaseId: string; generation: number };
  phase: string;
  ready: boolean;
  stopRequested: boolean;
  exitObserved: boolean;
  settled: boolean;
}

function fakeLease(port: number, readiness?: Promise<unknown>) {
  const identity = Object.freeze({ leaseId: "lease-682", generation: 3 });
  let status: LeaseStatus = {
    identity: { ...identity },
    phase: "ready",
    ready: true,
    stopRequested: false,
    exitObserved: false,
    settled: false,
  };
  let runCurrent = true;
  return {
    lease: {
      identity,
      readiness: (readiness ?? Promise.resolve({
        endpoint: `ws://127.0.0.1:${port}`,
        readObserverBearer: () => TOKEN,
        createTuiConnection: () => {
          throw new Error("not used");
        },
      })) as NativeCodexCallbackTransportOptions["lease"]["readiness"],
      status: () => ({ ...status }) as unknown as ReturnType<NativeCodexCallbackTransportOptions["lease"]["status"]>,
    },
    patch(next: Partial<LeaseStatus>) {
      status = { ...status, ...next };
    },
    setRunCurrent(value: boolean) {
      runCurrent = value;
    },
    isOwnedRunCurrent: () => runCurrent,
  };
}

function baseOptions(lease: ReturnType<typeof fakeLease>, extra: Partial<NativeCodexCallbackTransportOptions> = {}) {
  return {
    lease: lease.lease,
    owned: { threadId: THREAD, runId: RUN },
    isOwnedRunCurrent: lease.isOwnedRunCurrent,
    attestation: { expectedTurnSteer: true as const },
    expectedCodexHome: CODEX_HOME,
    handshakeTimeoutMs: 2_000,
    ...extra,
  } satisfies NativeCodexCallbackTransportOptions;
}

async function openReady(t: TestContext, options: NativeCodexCallbackTransportOptions): Promise<NativeCodexCallbackTransport> {
  const opened = await openNativeCodexCallbackTransport(options);
  assert.equal(opened.status, "ready", opened.status === "unavailable" ? opened.code : "");
  assert.ok(opened.status === "ready");
  const transport = opened.transport;
  t.after(async () => {
    transport.close();
    await transport.socketClosed;
  });
  return transport;
}

/* ------------------------------------------------------------- helpers */

const busy = (turnId = TURN_BUSY): NativeCodexCallbackRootFacts => ({
  threadId: THREAD,
  runId: RUN,
  activity: { state: "busy", turnId },
  userStop: "none",
});

const idle = (lastTurnId: string | null = TURN_OLD): NativeCodexCallbackRootFacts => ({
  threadId: THREAD,
  runId: RUN,
  activity: { state: "idle", lastTurnId },
  userStop: "none",
});

function steerParams(threadId = THREAD): NativeCodexCallbackSteerParams {
  return {
    threadId,
    expectedTurnId: TURN_BUSY,
    clientUserMessageId: "callback-0001",
    input: [{ type: "text", text: TEXT }],
  };
}

function edgeSpy(answer: boolean) {
  let calls = 0;
  return {
    calls: () => calls,
    queue: { mayWrite: () => ((calls += 1), answer) } satisfies NativeCodexCallbackQueueWriteEdge,
    steer: { isTargetStillCurrent: () => ((calls += 1), answer) },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lets any frame a bug might have written reach the server before asserting. */
async function settleNetwork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

/* --------------------------------------------------------------- tests */

test("idle route: authenticated handshake, then exactly add and start of our row on the owned thread", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));
  await settleNetwork();

  const [init, initialized] = server.frames;
  assert.equal(init?.method, "initialize");
  const initParams = init?.params as Frame;
  assert.deepEqual((initParams.clientInfo as Frame).name, "codex-backend");
  assert.equal((initParams.capabilities as Frame).experimentalApi, true);
  assert.deepEqual(initialized, { jsonrpc: "2.0", method: "initialized" });

  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => idle(),
    steerLane: transport.steerLane,
    queueLane: transport.queueLane,
  });
  const outcome = await composer.deliver({ clientUserMessageId: "callback-0001", text: TEXT });
  assert.equal(outcome.route, "idle-queue");
  assert.equal(outcome.delivery, "turn-started");

  assert.deepEqual(server.methods(), ["initialize", "initialized", "thread/queue/add", "thread/queue/start"]);
  assert.deepEqual(server.frames[2]?.params, {
    threadId: THREAD,
    input: [{ type: "text", text: TEXT, text_elements: [] }],
    clientUserMessageId: "callback-0001",
  });
  assert.deepEqual(server.frames[3]?.params, { threadId: THREAD, queuedSubmissionId: ROW });
  assert.equal(transport.pendingRequestCount, 0);
});

test("busy route: one expected-turn steer, accepted is sent-unconfirmed", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => busy(),
    steerLane: transport.steerLane,
    queueLane: transport.queueLane,
  });
  const outcome = await composer.deliver({ clientUserMessageId: "callback-0002", text: TEXT });
  assert.equal(outcome.route, "busy-steer");
  assert.equal(outcome.delivery, "sent-unconfirmed");
  assert.deepEqual(server.methods(), ["initialize", "initialized", "turn/steer"]);
  assert.deepEqual(server.frames[2]?.params, {
    threadId: THREAD,
    expectedTurnId: TURN_BUSY,
    clientUserMessageId: "callback-0002",
    input: [{ type: "text", text: TEXT }],
  });
});

test("stale lease or run at the socket send writes nothing on either lane", async (t) => {
  const mutations: Array<[string, (lease: ReturnType<typeof fakeLease>) => void]> = [
    ["stop requested", (lease) => lease.patch({ stopRequested: true, phase: "stopping" })],
    ["exited", (lease) => lease.patch({ exitObserved: true, phase: "exited" })],
    ["other generation", (lease) => lease.patch({ identity: { leaseId: "lease-682", generation: 4 } })],
    ["other lease", (lease) => lease.patch({ identity: { leaseId: "lease-other", generation: 3 } })],
    ["not ready", (lease) => lease.patch({ ready: false })],
    ["run revoked", (lease) => lease.setRunCurrent(false)],
  ];
  for (const [label, mutate] of mutations) {
    const server = await startServer(t);
    const lease = fakeLease(server.port);
    const transport = await openReady(t, baseOptions(lease));
    mutate(lease);
    const edge = edgeSpy(true);
    assert.deepEqual(await transport.steerLane.steer(steerParams(), edge.steer), { kind: "not-sent" }, label);
    assert.deepEqual(
      await transport.queueLane.request("thread/queue/start", { threadId: THREAD, queuedSubmissionId: ROW }, 1_000, edge.queue),
      { kind: "not-sent" },
      label,
    );
    // The lease fence refuses before the composer's guard is even consulted.
    assert.equal(edge.calls(), 0, label);

    // Through the composer: a positively not-delivered decline, nothing written.
    const composer = createNativeCodexCallbackComposer({
      owned: { threadId: THREAD, runId: RUN },
      readFacts: () => busy(),
      steerLane: transport.steerLane,
      queueLane: transport.queueLane,
    });
    const outcome = await composer.deliver({ clientUserMessageId: "callback-0003", text: TEXT });
    assert.equal(outcome.route, "busy-steer", label);
    assert.equal(outcome.delivery, "not-delivered", label);
    assert.ok(outcome.route === "busy-steer" && outcome.steer.status === "refused" && outcome.steer.code === "lane-not-sent");
    await settleNetwork();
    assert.deepEqual(server.methods(), ["initialize", "initialized"], label);
  }
});

test("the composer write-edge guard is consulted immediately before the send and a false guard writes nothing", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));

  const refusing = edgeSpy(false);
  assert.deepEqual(await transport.steerLane.steer(steerParams(), refusing.steer), { kind: "not-sent" });
  assert.deepEqual(
    await transport.queueLane.request(
      "thread/queue/add",
      { threadId: THREAD, input: [{ type: "text", text: TEXT, text_elements: [] }], clientUserMessageId: "callback-0004" },
      1_000,
      refusing.queue,
    ),
    { kind: "not-sent" },
  );
  assert.equal(refusing.calls(), 2);

  // A guard that throws is a refusal, not a write.
  const throwing = { mayWrite: (): boolean => { throw new Error("facts unreadable"); } };
  assert.deepEqual(
    await transport.queueLane.request("thread/queue/delete", { threadId: THREAD, queuedSubmissionId: ROW }, 1_000, throwing),
    { kind: "not-sent" },
  );

  // Composer: facts go stale between the composer's entry check and the
  // lane's send (the composer's own guard re-reads them at the write edge).
  let reads = 0;
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => {
      reads += 1;
      return reads <= 2 ? idle() : { ...idle(), runId: "run-generation-2" };
    },
    steerLane: transport.steerLane,
    queueLane: transport.queueLane,
  });
  const outcome = await composer.deliver({ clientUserMessageId: "callback-0005", text: TEXT });
  assert.deepEqual(outcome, { route: "declined", reason: "queue-add-not-sent", delivery: "not-delivered" });
  assert.ok(reads >= 3, "the lane consulted the composer guard at the socket send");

  await settleNetwork();
  assert.deepEqual(server.methods(), ["initialize", "initialized"]);
});

test("only the bound thread and the closed method shapes can be written", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));
  const edge = edgeSpy(true);
  const request = transport.queueLane.request as (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    writeEdge: NativeCodexCallbackQueueWriteEdge,
  ) => Promise<unknown>;

  const refusals: Array<Promise<unknown>> = [
    transport.steerLane.steer(steerParams(OTHER_THREAD), edge.steer),
    transport.steerLane.steer({ ...steerParams(), extra: 1 } as unknown as NativeCodexCallbackSteerParams, edge.steer),
    transport.steerLane.steer(
      { ...steerParams(), input: [{ type: "text", text: TEXT }, { type: "text", text: TEXT }] } as unknown as NativeCodexCallbackSteerParams,
      edge.steer,
    ),
    request("turn/start", { threadId: THREAD, input: [{ type: "text", text: TEXT }] }, 1_000, edge.queue),
    request("thread/resume", { threadId: THREAD }, 1_000, edge.queue),
    request("thread/queue/start", { threadId: OTHER_THREAD, queuedSubmissionId: ROW }, 1_000, edge.queue),
    request("thread/queue/start", { threadId: THREAD }, 1_000, edge.queue),
    request("thread/queue/delete", { threadId: THREAD, queuedSubmissionId: ROW, all: true }, 1_000, edge.queue),
    request("thread/queue/start", { threadId: THREAD, queuedSubmissionId: ROW }, 0, edge.queue),
  ];
  for (const result of await Promise.all(refusals)) assert.deepEqual(result, { kind: "not-sent" });
  assert.equal(edge.calls(), 0);
  await settleNetwork();
  assert.deepEqual(server.methods(), ["initialize", "initialized"]);
});

test("a closed or peer-closed transport is not ready and never waits or writes", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));
  for (const socket of server.sockets) socket.terminate();
  await transport.socketClosed;
  assert.equal(transport.state, "closed");
  const edge = edgeSpy(true);
  assert.deepEqual(await transport.steerLane.steer(steerParams(), edge.steer), { kind: "not-sent" });
  assert.equal(edge.calls(), 0);

  const second = await startServer(t);
  const lease2 = fakeLease(second.port);
  const transport2 = await openReady(t, baseOptions(lease2));
  transport2.close();
  transport2.close();
  assert.deepEqual(
    await transport2.queueLane.request("thread/queue/start", { threadId: THREAD, queuedSubmissionId: ROW }, 1_000, edge.queue),
    { kind: "not-sent" },
  );
  await transport2.socketClosed;
  await settleNetwork();
  assert.deepEqual(second.methods(), ["initialize", "initialized"]);
});

test("abort: before open dials nothing; during an in-flight steer it stays unknown; afterwards nothing is written", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);

  const preAborted = new AbortController();
  preAborted.abort();
  const refused = await openNativeCodexCallbackTransport(baseOptions(lease, { signal: preAborted.signal }));
  assert.equal(refused.status, "unavailable");
  assert.ok(refused.status === "unavailable" && refused.code === "aborted");
  await refused.socketClosed;

  // Abort while the lease's readiness is still pending: never dials.
  const pendingReadiness = new Promise<unknown>(() => {});
  const waiting = new AbortController();
  const pendingOpen = openNativeCodexCallbackTransport(
    baseOptions(fakeLease(server.port, pendingReadiness), { signal: waiting.signal }),
  );
  waiting.abort();
  const pendingResult = await pendingOpen;
  assert.ok(pendingResult.status === "unavailable" && pendingResult.code === "aborted");
  assert.equal(server.upgrades, 0);

  const controller = new AbortController();
  const transport = await openReady(t, baseOptions(lease, { signal: controller.signal }));
  server.respond = (frame) => (frame.method === "turn/steer" ? null : defaultResponder(frame, undefined as never));
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => busy(),
    steerLane: transport.steerLane,
    queueLane: transport.queueLane,
  });
  const delivering = composer.deliver({ clientUserMessageId: "callback-0006", text: TEXT });
  // Wait until the steer frame actually reached the server, then abort.
  while (!server.methods().includes("turn/steer")) await tick();
  controller.abort();
  const outcome = await delivering;
  assert.equal(outcome.route, "busy-steer");
  assert.equal(outcome.delivery, "unknown");
  assert.ok(outcome.route === "busy-steer" && outcome.steer.status === "uncertain" && outcome.steer.reason === "closed-after-send");
  assert.equal(transport.state, "closed");
  await transport.socketClosed;

  // The burned id is never resent, and a fresh id cannot write after abort.
  assert.deepEqual(await composer.deliver({ clientUserMessageId: "callback-0006", text: TEXT }), {
    route: "duplicate",
    delivery: "unknown",
  });
  const after = await composer.deliver({ clientUserMessageId: "callback-0007", text: TEXT });
  assert.equal(after.delivery, "not-delivered");
  await settleNetwork();
  assert.equal(server.methods().filter((method) => method === "turn/steer").length, 1);
});

test("no answer in time is unknown, and a late answer is dropped", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease, { steerTimeoutMs: 40 }));
  let held: { socket: WebSocket; id: unknown } | null = null;
  server.respond = (frame, socket) => {
    if (frame.method === "turn/steer") {
      held = { socket, id: frame.id };
      return null;
    }
    return defaultResponder(frame, socket);
  };
  const wire = await transport.steerLane.steer(steerParams(), edgeSpy(true).steer);
  assert.deepEqual(wire, { kind: "no-response", reason: "timeout" });
  assert.equal(transport.pendingRequestCount, 0);
  const late = held as { socket: WebSocket; id: unknown } | null;
  assert.ok(late !== null);
  late.socket.send(JSON.stringify({ jsonrpc: "2.0", id: late.id, result: { turnId: TURN_BUSY } }));
  await settleNetwork();
  assert.equal(transport.state, "ready");
  assert.equal(transport.pendingRequestCount, 0);

  // Queue lane: the composer's own per-request bound, reported as an uncertain timeout.
  server.respond = (frame, socket) => (frame.method === "thread/queue/add" ? null : defaultResponder(frame, socket));
  const reply = await transport.queueLane.request(
    "thread/queue/add",
    { threadId: THREAD, input: [{ type: "text", text: TEXT, text_elements: [] }], clientUserMessageId: "callback-0008" },
    40,
    edgeSpy(true).queue,
  );
  assert.deepEqual(reply, { kind: "failed", failure: "timeout" });
});

test("a malformed queue answer stays uncertain, never a refusal", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));
  server.respond = (frame, socket) =>
    frame.method === "thread/queue/start" ? { error: { code: "busy", message: 7 } } : defaultResponder(frame, socket);
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => idle(),
    steerLane: transport.steerLane,
    queueLane: transport.queueLane,
  });
  const outcome = await composer.deliver({ clientUserMessageId: "callback-0009", text: TEXT });
  assert.equal(outcome.route, "idle-queue");
  assert.equal(outcome.delivery, "unknown");
  assert.ok(
    outcome.route === "idle-queue"
    && outcome.idle.kind === "uncertain"
    && outcome.idle.stage === "start"
    && outcome.idle.reason === "transport-error",
  );
  // No delete after an unclassified start answer, and no retry.
  assert.deepEqual(server.methods(), ["initialize", "initialized", "thread/queue/add", "thread/queue/start"]);
});

test("server requests are dropped unanswered", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));
  server.respond = (frame, socket) => {
    if (frame.method === "turn/steer") {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: { threadId: THREAD, command: "rm -rf /" },
      }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: "cb-1", method: "item/tool/requestUserInput", params: {} }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId: THREAD } }));
    }
    return defaultResponder(frame, socket);
  };
  const wire = await transport.steerLane.steer(steerParams(), edgeSpy(true).steer);
  assert.deepEqual(wire, { kind: "result", result: { turnId: TURN_BUSY } });
  await settleNetwork();
  assert.deepEqual(server.methods(), ["initialize", "initialized", "turn/steer"]);
  assert.ok(server.frames.every((frame) => frame.result === undefined && frame.error === undefined));
});

test("open refuses a lease that is not current, a wrong credential, a foreign CODEX_HOME, and bad options", async (t) => {
  const server = await startServer(t);

  const stale = fakeLease(server.port);
  stale.patch({ stopRequested: true });
  const staleOpen = await openNativeCodexCallbackTransport(baseOptions(stale));
  assert.ok(staleOpen.status === "unavailable" && staleOpen.code === "lease-not-current");
  const revoked = fakeLease(server.port);
  revoked.setRunCurrent(false);
  const revokedOpen = await openNativeCodexCallbackTransport(baseOptions(revoked));
  assert.ok(revokedOpen.status === "unavailable" && revokedOpen.code === "lease-not-current");
  assert.equal(server.upgrades, 0, "a stale lease is never dialed");

  const wrongToken = fakeLease(server.port, Promise.resolve({
    endpoint: `ws://127.0.0.1:${server.port}`,
    readObserverBearer: () => "wrong-token-0123456789",
  }));
  const wrongOpen = await openNativeCodexCallbackTransport(baseOptions(wrongToken));
  assert.ok(wrongOpen.status === "unavailable" && wrongOpen.code === "handshake");
  await wrongOpen.socketClosed;

  const foreign = await openNativeCodexCallbackTransport(
    baseOptions(fakeLease(server.port), { expectedCodexHome: "/another/home" }),
  );
  assert.ok(foreign.status === "unavailable" && foreign.code === "binding");
  await foreign.socketClosed;

  const nonLoopback = fakeLease(server.port, Promise.resolve({
    endpoint: `ws://localhost:${server.port}`,
    readObserverBearer: () => TOKEN,
  }));
  const nonLoopbackOpen = await openNativeCodexCallbackTransport(baseOptions(nonLoopback));
  assert.ok(nonLoopbackOpen.status === "unavailable" && nonLoopbackOpen.code === "endpoint-invalid");

  const failedReadiness = fakeLease(server.port, Promise.reject(new Error("readiness")));
  const failedOpen = await openNativeCodexCallbackTransport(baseOptions(failedReadiness));
  assert.ok(failedOpen.status === "unavailable" && failedOpen.code === "readiness-failed");

  const unattested = await openNativeCodexCallbackTransport({
    ...baseOptions(fakeLease(server.port)),
    attestation: { expectedTurnSteer: false } as unknown as { expectedTurnSteer: true },
  });
  assert.ok(unattested.status === "unavailable" && unattested.code === "options-invalid");

  // Only the wrong-credential and foreign-home attempts dialed, and only after current-lease proof.
  assert.equal(server.upgrades, 2);
  for (let i = 0; i < 200 && server.sockets.size > 0; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(server.sockets.size, 0);
});

/* ------------------------------------------------- review pass 1 fences */

test("a truthy guard that revokes ownership, aborts, or closes the transport still writes nothing", async (t) => {
  const cases: Array<[string, (lease: ReturnType<typeof fakeLease>, controller: AbortController, transport: NativeCodexCallbackTransport) => void]> = [
    ["lease retired by the guard", (lease) => lease.patch({ stopRequested: true, phase: "stopping" })],
    ["run revoked by the guard", (lease) => lease.setRunCurrent(false)],
    ["aborted by the guard", (_lease, controller) => controller.abort()],
    ["closed by the guard", (_lease, _controller, transport) => transport.close()],
  ];
  for (const [label, sideEffect] of cases) {
    for (const lane of ["steer", "queue"] as const) {
      const server = await startServer(t);
      const lease = fakeLease(server.port);
      const controller = new AbortController();
      const transport = await openReady(t, baseOptions(lease, { signal: controller.signal }));
      let calls = 0;
      const guard = (): boolean => {
        calls += 1;
        sideEffect(lease, controller, transport);
        return true;
      };
      const result = lane === "steer"
        ? await transport.steerLane.steer(steerParams(), { isTargetStillCurrent: guard })
        : await transport.queueLane.request(
          "thread/queue/start",
          { threadId: THREAD, queuedSubmissionId: ROW },
          1_000,
          { mayWrite: guard },
        );
      assert.deepEqual(result, { kind: "not-sent" }, `${label} (${lane})`);
      assert.equal(calls, 1, `${label} (${lane})`);
      await settleNetwork();
      assert.deepEqual(server.methods(), ["initialize", "initialized"], `${label} (${lane})`);
    }
  }
});

test("clock and run hooks cannot invalidate the final send fence", async (t) => {
  for (const hook of ["clock", "run", "run-retires-lease"] as const) {
    for (const lane of ["steer", "queue"] as const) {
      const server = await startServer(t);
      const lease = fakeLease(server.port);
      const controller = new AbortController();
      let armed = false;
      let passedGuard = false;
      const transport = await openReady(t, baseOptions(lease, {
        signal: controller.signal,
        isOwnedRunCurrent: () => {
          if (hook === "run" && passedGuard) controller.abort();
          if (hook === "run-retires-lease" && passedGuard) lease.patch({ stopRequested: true, phase: "stopping" });
          return true;
        },
        clock: {
          now: () => {
            if (hook === "clock" && armed) lease.patch({ stopRequested: true, phase: "stopping" });
            return performance.now();
          },
        },
      }));
      armed = true;
      const guard = (): boolean => {
        passedGuard = true;
        return true;
      };
      const reply = lane === "steer"
        ? await transport.steerLane.steer(steerParams(), { isTargetStillCurrent: guard })
        : await transport.queueLane.request(
          "thread/queue/start",
          { threadId: THREAD, queuedSubmissionId: ROW },
          1_000,
          { mayWrite: guard },
        );
      assert.deepEqual(reply, { kind: "not-sent" }, `${hook} (${lane})`);
      assert.equal(transport.pendingRequestCount, 0, `${hook} (${lane})`);
      await settleNetwork();
      assert.deepEqual(server.methods(), ["initialize", "initialized"], `${hook} (${lane})`);
    }
  }
});

test("a contradictory or foreign reply envelope is never definitive", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));

  // queue/start answered with BOTH a result and the recognizable busy error:
  // the start outcome is unknown, so no delete and no steer may follow.
  server.respond = (frame, socket) =>
    frame.method === "thread/queue/start"
      ? { result: { turn: { id: "turn-new-9", status: "inProgress" } }, error: { code: -32600, message: BUSY_MESSAGE } }
      : defaultResponder(frame, socket);
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => idle(),
    steerLane: transport.steerLane,
    queueLane: transport.queueLane,
  });
  const outcome = await composer.deliver({ clientUserMessageId: "callback-0010", text: TEXT });
  assert.equal(outcome.route, "idle-queue");
  assert.equal(outcome.delivery, "unknown");
  assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "uncertain" && outcome.idle.stage === "start");
  await settleNetwork();
  assert.deepEqual(server.methods(), ["initialize", "initialized", "thread/queue/add", "thread/queue/start"]);

  // Steer: both members, neither member, or a foreign version → uncertain, never rejected/accepted.
  const malformed: Frame[] = [
    { result: { turnId: TURN_BUSY }, error: { code: -32600, message: "no active turn" } },
    {},
    { jsonrpc: "1.0", result: { turnId: TURN_BUSY } },
  ];
  for (const answer of malformed) {
    server.respond = (frame, socket) => (frame.method === "turn/steer" ? answer : defaultResponder(frame, socket));
    const sender = createNativeCodexCallbackComposer({
      owned: { threadId: THREAD, runId: RUN },
      readFacts: () => busy(),
      steerLane: transport.steerLane,
      queueLane: transport.queueLane,
    });
    const steered = await sender.deliver({ clientUserMessageId: "callback-0011", text: TEXT });
    assert.equal(steered.delivery, "unknown", JSON.stringify(answer));
    assert.ok(steered.route === "busy-steer" && steered.steer.status === "uncertain", JSON.stringify(answer));
  }

  // Compatibility: Codex omits `jsonrpc`; a single well-formed member is still definitive.
  server.respond = (frame, socket) =>
    frame.method === "turn/steer" ? { jsonrpc: undefined, result: { turnId: TURN_BUSY } } : defaultResponder(frame, socket);
  const compatible = await transport.steerLane.steer(
    { ...steerParams(), clientUserMessageId: "callback-0012" },
    { isTargetStillCurrent: () => true },
  );
  assert.deepEqual(compatible, { kind: "result", result: { turnId: TURN_BUSY } });
});

test("an initialize answer at the handshake deadline cannot open the write lanes", async (t) => {
  const server = await startServer(t);
  let now = 0;
  server.respond = (frame, socket) => {
    if (frame.method === "initialize") now = 30_000;
    return defaultResponder(frame, socket);
  };
  const opened = await openNativeCodexCallbackTransport(baseOptions(fakeLease(server.port), {
    handshakeTimeoutMs: 30_000,
    clock: { now: () => now },
  }));
  if (opened.status === "ready") {
    opened.transport.close();
    await opened.transport.socketClosed;
  }
  assert.ok(opened.status === "unavailable" && opened.code === "timeout");
  await opened.socketClosed;
  assert.deepEqual(server.methods(), ["initialize"]);
});

test("an upgrade completed at the handshake deadline sends nothing", async (t) => {
  const server = await startServer(t);
  const opened = await openNativeCodexCallbackTransport(baseOptions(fakeLease(server.port), {
    handshakeTimeoutMs: 30_000,
    // Time reaches the deadline once the server has accepted the upgrade.
    clock: { now: () => (server.upgrades > 0 ? 30_000 : 0) },
  }));
  if (opened.status === "ready") {
    opened.transport.close();
    await opened.transport.socketClosed;
  }
  assert.ok(opened.status === "unavailable" && opened.code === "timeout");
  await opened.socketClosed;
  await settleNetwork();
  assert.equal(server.upgrades, 1);
  assert.deepEqual(server.methods(), []);
});

test("an answer handled at or after the monotonic deadline is a timeout even before the timer fires", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  let offset = 0;
  const clock = { now: () => performance.now() + offset };
  // A long real timer, so only the deadline comparison can classify the reply.
  const transport = await openReady(t, baseOptions(lease, { steerTimeoutMs: 30_000, clock }));
  server.respond = (frame, socket) => {
    if (frame.method === "turn/steer" || frame.method === "thread/queue/add") offset += 60_000;
    return defaultResponder(frame, socket);
  };
  const started = performance.now();
  const wire = await transport.steerLane.steer(steerParams(), { isTargetStillCurrent: () => true });
  assert.deepEqual(wire, { kind: "no-response", reason: "timeout" });
  const reply = await transport.queueLane.request(
    "thread/queue/add",
    { threadId: THREAD, input: [{ type: "text", text: TEXT, text_elements: [] }], clientUserMessageId: "callback-0013" },
    30_000,
    { mayWrite: () => true },
  );
  assert.deepEqual(reply, { kind: "failed", failure: "timeout" });
  assert.ok(performance.now() - started < 10_000, "classified at reply time, not by the timer");
  assert.equal(transport.pendingRequestCount, 0);
});

test("socketClosed waits for the socket's own close event after repeated close and abort during initialize", async (t) => {
  const server = await startServer(t);
  const lease = fakeLease(server.port);
  const transport = await openReady(t, baseOptions(lease));
  let resolved = false;
  void transport.socketClosed.then(() => {
    resolved = true;
  });
  transport.close();
  transport.close();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false, "a second close() is not a close proof");
  await transport.socketClosed;
  assert.equal(resolved, true);

  // Abort while `initialize` is unanswered: settling the pending handshake
  // re-enters close(), which must not resolve the proof early either.
  const controller = new AbortController();
  server.respond = (frame) => {
    if (frame.method === "initialize") {
      controller.abort();
      return null;
    }
    return defaultResponder(frame, undefined as never);
  };
  const opened = await openNativeCodexCallbackTransport(baseOptions(fakeLease(server.port), { signal: controller.signal }));
  assert.ok(opened.status === "unavailable" && opened.code === "aborted");
  let abortResolved = false;
  void opened.socketClosed.then(() => {
    abortResolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(abortResolved, false, "abort during initialize is not a close proof");
  await opened.socketClosed;
  assert.equal(abortResolved, true);
});
