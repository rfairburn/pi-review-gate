/**
 * Owned-endpoint native Codex RPC transport acceptance.
 *
 * Every case here runs the real client against the real fake backend
 * (`tests/session-host-native-codex-rpc-fixture.ts`): a genuine RFC6455
 * WebSocket over a Unix socket or a loopback port, with the provider's own
 * `GET /rpc` handshake and JSON-RPC envelope. The focus is the control-plane
 * isolation contract — what the client is structurally able to put on the wire,
 * and what it must never put there — plus correlation, bounds, and teardown.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_CODEX_RPC_CLIENT_NAME,
  NATIVE_CODEX_RPC_MAX_SOCKET_PATH_CHARS,
  NativeCodexRpcError,
  NativeCodexRpcTransport,
  decodeNativeCodexNotification,
  decodeNativeCodexLoadedPage,
  decodeNativeCodexTerminalPage,
  decodeNativeCodexThreadPage,
  decodeNativeCodexThreadRow,
  readNativeCodexRpcEndpoint,
  type NativeCodexRpcFailureCode,
} from "../src/session-host/native-codex-rpc";
import {
  FAKE_MARKER,
  FakeCodexAppServer,
  type FakeCodexServerOptions,
} from "./session-host-native-codex-rpc-fixture";

const ROOT = "11111111-1111-4111-8111-111111111111";

async function withUnixTransport(
  serverOptions: FakeCodexServerOptions,
  run: (server: FakeCodexAppServer, socketPath: string) => Promise<void>,
): Promise<void> {
  const server = new FakeCodexAppServer(serverOptions);
  const socketPath = await server.listenUnix();
  try {
    await run(server, socketPath);
  } finally {
    await server.stop();
  }
}

async function withLoopbackTransport(
  serverOptions: FakeCodexServerOptions,
  run: (server: FakeCodexAppServer, port: number) => Promise<void>,
): Promise<void> {
  const server = new FakeCodexAppServer(serverOptions);
  const port = await server.listenLoopback();
  try {
    await run(server, port);
  } finally {
    await server.stop();
  }
}

function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(promise: Promise<T>, message: string, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function endpointCode(value: unknown): string {
  const read = readNativeCodexRpcEndpoint(value);
  return read.status === "invalid" ? read.code : "valid";
}

function publicApi(instance: object): string[] {
  const names = new Set<string>();
  let current: object | null = Object.getPrototypeOf(instance);
  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) names.add(key);
    current = Object.getPrototypeOf(current);
  }
  for (const key of Object.getOwnPropertyNames(instance)) names.add(key);
  names.delete("constructor");
  return [...names].sort();
}

/* ---------------------------------------------------------------- handshake */

test("handshakes as a non-originating client over a real Unix socket", async () => {
  await withUnixTransport({ threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (server, socketPath) => {
      const transport = new NativeCodexRpcTransport({ endpoint: { kind: "unix", socketPath } });
      await transport.connect();
      await settle();

      assert.equal(transport.state, "ready");
      assert.equal(server.handshakeInfo?.url, "/rpc");
      assert.equal(server.handshakeInfo?.host, "localhost");
      assert.ok(server.initializedSeen, "the initialized notification must be sent");

      const params = server.initializeParams;
      assert.ok(params !== null);
      const clientInfo = params.clientInfo as Record<string, unknown>;
      assert.equal(clientInfo.name, NATIVE_CODEX_RPC_CLIENT_NAME);
      assert.equal(clientInfo.name, "codex-backend");
      const capabilities = params.capabilities as Record<string, unknown>;
      assert.equal(capabilities.experimentalApi, true, "the census needs the experimental gate");
      assert.equal(capabilities.requiredHumanApproval, false);
      assert.ok(Array.isArray(capabilities.optOutNotificationMethods));
      assert.ok((capabilities.optOutNotificationMethods as string[]).includes("item/agentMessage/delta"));

      // Only the handshake went out: initialize, then the initialized notification.
      assert.deepEqual(server.requests.map((request) => request.method), ["initialize"]);
      const frames = server.rawInboundFrames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
      assert.equal(frames.length, 2);
      assert.equal(frames[1].method, "initialized");
      assert.equal(frames[1].params, undefined);
      transport.close();
    });
});

test("corroborates the owned CODEX_HOME and never retains it", async () => {
  await withUnixTransport({ codexHome: "/owned/codex-home" }, async (server, socketPath) => {
    const connected: { userAgentPresent: boolean }[] = [];
    const failures: NativeCodexRpcFailureCode[] = [];
    const transport = new NativeCodexRpcTransport({
      endpoint: { kind: "unix", socketPath },
      expectedCodexHome: "/owned/codex-home",
      onConnected: (info) => connected.push(info),
      onFailure: (code) => failures.push(code),
    });
    await transport.connect();
    await settle();
    assert.deepEqual(connected, [{ userAgentPresent: true, platformFamily: "unix" }]);
    assert.deepEqual(failures, []);
    transport.close();

    // A backend that is not the one the caller launched is refused before any
    // census request, and the mismatch is reported as a closed code only.
    const mismatched: NativeCodexRpcFailureCode[] = [];
    const other = new NativeCodexRpcTransport({
      endpoint: { kind: "unix", socketPath },
      expectedCodexHome: "/some/other/home",
      onFailure: (code) => mismatched.push(code),
    });
    await assert.rejects(other.connect(), (error: unknown) => (error as NativeCodexRpcError).code === "binding");
    await settle();
    assert.deepEqual(mismatched, ["binding"]);
    assert.equal(other.state, "closed");
    assert.deepEqual(server.requests.map((request) => request.method), ["initialize", "initialize"],
      "the refused backend never received a census request, only the handshake it answered");
    other.close();
  });
});

test("the authenticated loopback variant sends the bearer credential and refuses an unauthenticated upgrade", async () => {
  await withLoopbackTransport({ requireAuthorization: "tok-1" }, async (server, port) => {
    // A caller that cannot present the lease's credential is refused structurally
    // (type) and at runtime, and never falls back to an unauthenticated dial.
    const unauthenticated = { kind: "loopback-ws", host: "127.0.0.1", port } as never;
    assert.equal(readNativeCodexRpcEndpoint(unauthenticated).status, "invalid");

    const wrongToken = new NativeCodexRpcTransport({
      endpoint: { kind: "loopback-ws", host: "127.0.0.1", port, authorization: { scheme: "bearer", token: () => "nope" } },
    });
    await assert.rejects(wrongToken.connect(), (error: unknown) => (error as NativeCodexRpcError).code === "handshake");
    wrongToken.close();
    assert.equal(server.rejectedUpgradeCount, 1);

    let tokenReads = 0;
    const authed = new NativeCodexRpcTransport({
      endpoint: {
        kind: "loopback-ws",
        host: "127.0.0.1",
        port,
        authorization: {
          scheme: "bearer",
          token: () => {
            tokenReads += 1;
            return "tok-1";
          },
        },
      },
    });
    await authed.connect();
    assert.equal(authed.state, "ready");
    assert.equal(server.handshakeInfo?.headers.authorization, "Bearer tok-1");
    // The credential is read only when the handshake header is written, and the
    // endpoint object holds no printable copy of it.
    assert.equal(tokenReads, 1);
    assert.ok(!JSON.stringify(authed).includes("tok-1"));
    authed.close();
  });
});

/* --------------------------------------------------------------- endpoint */

test("refuses an endpoint that cannot be private, before dialing", () => {
  assert.equal(endpointCode({ kind: "unix", socketPath: "" }), "socket-path");
  assert.equal(
    endpointCode({ kind: "unix", socketPath: "/a".repeat(NATIVE_CODEX_RPC_MAX_SOCKET_PATH_CHARS + 1) }),
    "socket-path-too-long",
  );
  assert.equal(endpointCode({ kind: "unix", socketPath: "/tmp/a\u0000b.sock" }), "socket-path");
  assert.equal(endpointCode({ kind: "loopback-ws", host: "10.0.0.5", port: 4321 }), "host");
  assert.equal(endpointCode({ kind: "loopback-ws", host: "localhost", port: 4321 }), "host");
  assert.equal(endpointCode({ kind: "loopback-ws", host: "::1", port: 4321 }), "host");
  assert.equal(endpointCode({ kind: "loopback-ws", host: "127.0.0.1", port: 0 }), "port");
  assert.equal(endpointCode({ kind: "loopback-ws", host: "127.0.0.1", port: 70_000 }), "port");
  assert.equal(endpointCode({ kind: "loopback-ws", host: "127.0.0.1", port: 4321 }), "authorization",
    "there is no unauthenticated loopback fallback");
  assert.equal(
    endpointCode({ kind: "loopback-ws", host: "127.0.0.1", port: 4321, authorization: { scheme: "basic", token: () => "x" } }),
    "authorization",
  );
  assert.equal(
    endpointCode({ kind: "loopback-ws", host: "127.0.0.1", port: 4321, authorization: { scheme: "bearer", token: () => "" } }),
    "authorization",
  );
  assert.equal(
    endpointCode({ kind: "loopback-ws", host: "127.0.0.1", port: 4321, authorization: { scheme: "bearer", token: () => "tok-1" } }),
    "valid",
  );
  assert.equal(endpointCode({ kind: "telepathy" }), "kind");
  assert.equal(endpointCode({ kind: "unix", socketPath: "/tmp/owned.sock" }), "valid");

  assert.throws(
    () => new NativeCodexRpcTransport({ endpoint: { kind: "loopback-ws", host: "192.168.1.9", port: 4321 } as never }),
    (error: unknown) => (error as NativeCodexRpcError).code === "endpoint-invalid",
  );
});

/* ------------------------------------------------------------ correlation */

test("correlates responses, and drops late or unknown ids without adopting them", async () => {
  await withUnixTransport({ threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (server, socketPath) => {
      const notifications: unknown[] = [];
      const failures: NativeCodexRpcFailureCode[] = [];
      const transport = new NativeCodexRpcTransport({
        endpoint: { kind: "unix", socketPath },
        onNotification: (notification) => notifications.push(notification),
        onFailure: (code) => failures.push(code),
      });
      await transport.connect();

      // Unsolicited frames the client must not choke on, and must not answer.
      server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
      server.broadcast("account/updated", { reason: `${FAKE_MARKER} unlisted` });
      server.broadcast("thread/started", { thread: { id: "child-late", parentThreadId: ROOT, status: { type: "idle" } } });
      await settle();

      assert.deepEqual(notifications, [
        { method: "thread/status/changed", threadId: ROOT, status: { kind: "active", activeFlags: [] } },
        { method: "thread/started", row: { threadId: "child-late", parentThreadId: ROOT, status: { kind: "idle", activeFlags: [] } } },
      ], "only allowlisted notifications are decoded, and only their allowlisted fields");
      assert.deepEqual(failures, []);

      const row = await transport.readThread(ROOT);
      assert.deepEqual(row, { threadId: ROOT, parentThreadId: null, status: { kind: "idle", activeFlags: [] } });
      assert.equal(transport.pendingRequestCount, 0);
      transport.close();
    });
});

test("builds only the allowlisted read-only census requests", async () => {
  await withUnixTransport({
    threads: [
      { id: ROOT, parentThreadId: null, status: { type: "idle" }, sourceKind: "cli" },
      { id: "child-1", parentThreadId: ROOT, status: { type: "active", activeFlags: [] }, sourceKind: "subAgentThreadSpawn" },
    ],
    backgroundTerminals: { [ROOT]: [{ processId: "proc-1", command: "sleep 1000", cwd: "/tmp/owned" }] },
  }, async (server, socketPath) => {
    const transport = new NativeCodexRpcTransport({ endpoint: { kind: "unix", socketPath } });
    await transport.connect();

    await transport.readThread(ROOT);
    await transport.listLoadedThreadIds();
    await transport.listDescendantThreads(ROOT);
    await transport.listBackgroundTerminals(ROOT, "p1");

    const census = server.requests.slice(1);
    assert.deepEqual(census.map((request) => request.method), [
      "thread/read",
      "thread/loaded/list",
      "thread/list",
      "thread/backgroundTerminals/list",
    ]);
    assert.deepEqual(census[0].params, { threadId: ROOT, includeTurns: false });
    assert.deepEqual(census[2].params, {
      limit: 200,
      ancestorThreadId: ROOT,
      sourceKinds: ["subAgent", "subAgentThreadSpawn", "subAgentReview", "subAgentCompact", "subAgentOther"],
      useStateDbOnly: true,
      sortKey: "updated_at",
      sortDirection: "desc",
    }, "the ancestor filter is the ownership fence; there is deliberately no cwd filter");
    assert.deepEqual(census[3].params, { limit: 200, cursor: "p1", threadId: ROOT });

    // Nothing outside the allowlist is expressible.
    const typed = transport as unknown as Record<string, unknown>;
    for (const forbidden of ["send", "sendReply", "reply", "respond", "notify", "write", "request", "callMethod"]) {
      assert.equal(typed[forbidden], undefined, `${forbidden} must not exist on the transport`);
    }
    assert.deepEqual(publicApi(transport), [
      "close",
      "connect",
      "listBackgroundTerminals",
      "listDescendantThreads",
      "listLoadedThreadIds",
      "pendingRequestCount",
      "readThread",
      "socketClosed",
      "state",
    ]);
    transport.close();
  });
});

/* ------------------------------------------------- control-plane isolation */

test("never answers a server request: zero reply bytes for approvals and questions", async () => {
  await withUnixTransport({ threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (server, socketPath) => {
      const seen: { method: string; threadScoped: boolean; requestId: string }[] = [];
      const transport = new NativeCodexRpcTransport({
        endpoint: { kind: "unix", socketPath },
        onServerRequest: (signal) => seen.push(signal),
      });
      await transport.connect();
      await settle();
      const baseline = server.rawInboundFrames.length;

      const ids = [
        server.sendServerRequest("item/commandExecution/requestApproval", { kind: "command", command: `${FAKE_MARKER} rm -rf` }),
        server.sendServerRequest("item/fileChange/requestApproval", { fileChanges: `${FAKE_MARKER} diff` }),
        server.sendServerRequest("item/permissions/requestApproval", { permissions: `${FAKE_MARKER}` }),
        server.sendServerRequest("item/tool/requestUserInput", { questions: [{ prompt: `${FAKE_MARKER}` }] }),
        server.sendServerRequest("mcpServer/elicitation/request", { message: `${FAKE_MARKER}` }),
        server.sendServerRequest("account/chatgptAuthTokens/refresh", { reason: `${FAKE_MARKER}` }),
        server.sendServerRequest("attestation/generate", { payload: `${FAKE_MARKER}` }),
        server.sendServerRequest("currentTime/read", {}),
      ];
      await settle();

      assert.deepEqual(seen.map((signal) => signal.method), [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
        "account/chatgptAuthTokens/refresh",
        "attestation/generate",
        "currentTime/read",
      ]);
      assert.ok(seen.every((signal) => signal.threadScoped), "params.threadId presence is all that is kept");
      assert.deepEqual(seen.map((signal) => signal.requestId), ids);
      // The payload itself never reaches the callback.
      const serialized = JSON.stringify(seen);
      assert.ok(!serialized.includes(FAKE_MARKER));

      // And nothing at all went back: not a result, not an error, not a rejection.
      const outbound = server.inboundFramesSince(baseline);
      assert.deepEqual(outbound, [], "the observer must send zero bytes in reply to a server request");
      assert.equal(server.repliedTo(ids), false);
      transport.close();
    });
});

test("a server request cannot be laundered into the pending request map", async () => {
  await withUnixTransport({ threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (server, socketPath) => {
      const transport = new NativeCodexRpcTransport({ endpoint: { kind: "unix", socketPath } });
      await transport.connect();
      const serverRequestId = server.sendServerRequest("item/tool/requestUserInput", {});
      await settle();
      assert.equal(transport.pendingRequestCount, 0, "inbound ids never enter the pending map");

      // A response frame that reuses the server's id is therefore unknown, and is
      // dropped rather than resolving anything.
      server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
      const row = await transport.readThread(ROOT);
      assert.equal(row?.status.kind, "idle");
      assert.ok(!server.repliedTo([serverRequestId]));
      transport.close();
    });
});

/* ------------------------------------------------------------------ bounds */

test("reassembles a large fragmented response across TCP segments", async () => {
  const rows = Array.from({ length: 1_200 }, (_unused, index) => ({
    id: `child-${index}`,
    parentThreadId: ROOT,
    status: { type: "idle" } as const,
    sourceKind: "subAgentThreadSpawn",
    // Each row is ~250 bytes of marker-free filler, so the whole page is well
    // over the 64 KB socket write boundary and arrives in many TCP segments.
    preview: `preview-${index}-${"x".repeat(200)}`,
  }));
  await withUnixTransport({ threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }, ...rows] },
    async (server, socketPath) => {
      const transport = new NativeCodexRpcTransport({ endpoint: { kind: "unix", socketPath } });
      await transport.connect();
      await settle();

      // Follow every page: a single page is never the whole census.
      const seenIds: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await transport.listDescendantThreads(ROOT, cursor);
        for (const row of page.rows) seenIds.push(row.threadId);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      assert.equal(seenIds.length, 1_200);
      assert.equal(seenIds[0], "child-0");
      assert.equal(seenIds[1_199], "child-1199");
      assert.equal(new Set(seenIds).size, 1_200, "no row is duplicated across pages");
      assert.ok(!JSON.stringify(seenIds).includes("preview"));
      transport.close();
    });
});

test("caps an oversize message with a closed code and no retained content", async () => {
  const rows = Array.from({ length: 400 }, (_unused, index) => ({
    id: `child-${index}`,
    parentThreadId: ROOT,
    status: { type: "idle" } as const,
    sourceKind: "subAgentThreadSpawn",
    preview: `p-${"y".repeat(400)}`,
  }));
  await withUnixTransport({ threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }, ...rows] },
    async (server, socketPath) => {
      const failures: NativeCodexRpcFailureCode[] = [];
      const transport = new NativeCodexRpcTransport({
        endpoint: { kind: "unix", socketPath },
        maxMessageBytes: 8 * 1024,
        onFailure: (code) => failures.push(code),
      });
      await transport.connect();
      await assert.rejects(transport.listDescendantThreads(ROOT),
        (error: unknown) => (error as NativeCodexRpcError).code === "closed");
      await settle();
      assert.ok(failures.includes("oversize"), `expected oversize, saw ${failures.join(",")}`);
      assert.equal(transport.pendingRequestCount, 0);
      assert.equal(transport.state, "closed");
      transport.close();
    });
});

test("times out a request that never answers and leaks nothing", async () => {
  await withUnixTransport({
    threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }],
    delayMs: { "thread/list": 5_000 },
  }, async (server, socketPath) => {
    const failures: NativeCodexRpcFailureCode[] = [];
    const transport = new NativeCodexRpcTransport({
      endpoint: { kind: "unix", socketPath },
      requestTimeoutMs: 30,
      onFailure: (code) => failures.push(code),
    });
    await transport.connect();
    await assert.rejects(transport.listDescendantThreads(ROOT),
      (error: unknown) => (error as NativeCodexRpcError).code === "timeout");
    assert.deepEqual(failures, ["timeout"]);
    assert.equal(transport.pendingRequestCount, 0);

    // The late answer arrives after the deadline and must be ignored.
    await settle(120);
    assert.equal(transport.pendingRequestCount, 0);
    assert.equal(transport.state, "ready");
    transport.close();
  });
});

test("an upgraded peer that never answers initialize is bounded and leaves no socket", async () => {
  await withUnixTransport({
    threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }],
    ignoreMethods: ["initialize"],
  }, async (server, socketPath) => {
    const failures: NativeCodexRpcFailureCode[] = [];
    let connected = 0;
    const transport = new NativeCodexRpcTransport({
      endpoint: { kind: "unix", socketPath },
      requestTimeoutMs: 40,
      onConnected: () => { connected += 1; },
      onFailure: (code) => failures.push(code),
    });
    // The socket upgrade succeeds; only the RPC handshake deadline ends this.
    const deadline = Date.now() + 5_000;
    await assert.rejects(transport.connect(), (error: unknown) => {
      assert.equal((error as NativeCodexRpcError).code, "timeout");
      return true;
    });
    assert.ok(Date.now() < deadline, "connect() is bounded, not left open forever");
    assert.equal(connected, 0, "a handshake that never completed is never reported as connected");
    assert.deepEqual(failures, ["timeout"]);
    assert.equal(transport.pendingRequestCount, 0, "no pending entry survives the bounded handshake");
    assert.equal(transport.state, "closed");
    await settle(80);
    assert.equal(server.connectionCount, 0, "the unanswered peer is closed, not left upgraded");
  });
});

test("an initialize rejection closes the socket instead of abandoning it", async () => {
  await withUnixTransport({
    threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }],
    failCalls: { initialize: 1 },
  }, async (server, socketPath) => {
    const failures: NativeCodexRpcFailureCode[] = [];
    const transport = new NativeCodexRpcTransport({
      endpoint: { kind: "unix", socketPath },
      onFailure: (code) => failures.push(code),
    });
    await assert.rejects(transport.connect(), (error: unknown) => {
      assert.equal((error as NativeCodexRpcError).code, "handshake");
      return true;
    });
    // One code for one failure, even though closing rejects the pending request.
    assert.deepEqual(failures, ["handshake"]);
    assert.equal(transport.pendingRequestCount, 0);
    assert.equal(transport.state, "closed");
    await settle(80);
    assert.equal(server.connectionCount, 0, "a refused handshake must not leave an open connection behind");
    assert.equal(server.requests.some((request) => request.method === "thread/read"), false,
      "a backend that refused the handshake is never queried further");
  });
});

test("an invalid page cursor is never read as end-of-pagination", () => {
  const unusable: readonly unknown[] = [7, "", false, {}, ["cursor"], "x".repeat(10_000)];
  for (const cursor of unusable) {
    assert.equal(decodeNativeCodexLoadedPage({ data: ["a"], nextCursor: cursor }), null,
      "a loaded page with an unusable cursor fails the page instead of ending it");
    assert.equal(decodeNativeCodexThreadPage({ data: [{ id: "a" }], nextCursor: cursor }), null,
      "a thread page with an unusable cursor fails the page instead of ending it");
    assert.equal(decodeNativeCodexTerminalPage({ data: [{ processId: "p" }], nextCursor: cursor }), null,
      "a terminal page with an unusable cursor fails the page instead of ending it");
  }
  // A genuinely absent cursor still means the provider has no further page.
  assert.deepEqual(decodeNativeCodexLoadedPage({ data: ["a"] }), { threadIds: ["a"], nextCursor: null });
  assert.deepEqual(decodeNativeCodexLoadedPage({ data: ["a"], nextCursor: null }),
    { threadIds: ["a"], nextCursor: null });
  assert.deepEqual(decodeNativeCodexTerminalPage({ data: [{ processId: "p" }], nextCursor: "c2" }),
    { processIds: ["p"], nextCursor: "c2" });
});

test("a refused request surfaces only a closed code, never the server's text", async () => {
  await withUnixTransport({
    threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }],
    failCalls: { "thread/read": 1 },
  }, async (server, socketPath) => {
    const transport = new NativeCodexRpcTransport({ endpoint: { kind: "unix", socketPath } });
    await transport.connect();
    await assert.rejects(transport.readThread(ROOT), (error: unknown) => {
      const rpcError = error as NativeCodexRpcError;
      assert.equal(rpcError.code, "rejected");
      assert.ok(!rpcError.message.includes(FAKE_MARKER));
      assert.ok(!rpcError.message.includes("/path/"));
      assert.ok(!rpcError.message.includes("token"));
      return true;
    });
    transport.close();
  });
});

test("malformed frames are one protocol anomaly, not a stream of failures", async () => {
  await withUnixTransport({ threads: [] }, async (server, socketPath) => {
    const failures: NativeCodexRpcFailureCode[] = [];
    const transport = new NativeCodexRpcTransport({
      endpoint: { kind: "unix", socketPath },
      onFailure: (code) => failures.push(code),
    });
    await transport.connect();
    server.sendRaw("{not json at all\n");
    server.broadcast("thread/status/changed", { threadId: 5, status: { type: "sideways" } });
    server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: ["waitingOnMartian"] } });
    await settle();
    assert.deepEqual(failures, ["protocol"], "one anomaly per connection; unknown flags are never read as none");
    transport.close();
  });
});

/* --------------------------------------------------------------- teardown */

test("close() rejects pending requests, stops callbacks, and is idempotent", async () => {
  await withUnixTransport({
    threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }],
    delayMs: { "thread/list": 5_000 },
  }, async (server, socketPath) => {
    let closedCalls = 0;
    let notifications = 0;
    const transport = new NativeCodexRpcTransport({
      endpoint: { kind: "unix", socketPath },
      onClosed: () => { closedCalls += 1; },
      onNotification: () => { notifications += 1; },
    });
    await transport.connect();
    const pending = transport.listDescendantThreads(ROOT);
    transport.close();
    await assert.rejects(pending, (error: unknown) => (error as NativeCodexRpcError).code === "closed");
    transport.close();
    transport.close();
    assert.equal(closedCalls, 0, "a host-initiated close is not a disconnect");
    assert.equal(transport.state, "closed");
    assert.equal(transport.pendingRequestCount, 0);

    // A late frame after disposal can neither wake a callback nor a request.
    server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await settle();
    assert.equal(notifications, 0);
    await assert.rejects(transport.readThread(ROOT), (error: unknown) => (error as NativeCodexRpcError).code === "closed");
  });
});

test("an unexpected disconnect reports one closed code", async () => {
  await withUnixTransport({ threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (server, socketPath) => {
      const codes: (NativeCodexRpcFailureCode | undefined)[] = [];
      const transport = new NativeCodexRpcTransport({
        endpoint: { kind: "unix", socketPath },
        onClosed: (code) => codes.push(code),
      });
      await transport.connect();
      server.dropClientConnections();
      await settle();
      assert.deepEqual(codes, ["socket"]);
      assert.equal(transport.state, "closed");
      transport.close();
    });
});

/* ------------------------------------------------------------ socket close */

test("socketClosed resolves on the real WebSocket close after connect and is idempotent", async () => {
  await withLoopbackTransport(
    { threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (_server, port) => {
      const transport = new NativeCodexRpcTransport({
        endpoint: {
          kind: "loopback-ws",
          host: "127.0.0.1",
          port,
          authorization: { scheme: "bearer", token: () => "socket-close-token" },
        },
      });
      try {
        assert.equal(transport.socketClosed, transport.socketClosed);
        await transport.connect();
        transport.close();
        await within(transport.socketClosed, "socket close was not observed");
        assert.equal(transport.state, "closed");
        // Repeated close is still one proof and never rejects.
        transport.close();
        await within(transport.socketClosed, "repeated close proof");
      } finally {
        transport.close();
      }
    },
  );
});

test("socketClosed is already proven for a preconnect close and a refused later connect", async () => {
  await withLoopbackTransport(
    { threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (_server, port) => {
      const transport = new NativeCodexRpcTransport({
        endpoint: {
          kind: "loopback-ws",
          host: "127.0.0.1",
          port,
          authorization: { scheme: "bearer", token: () => "socket-close-token" },
        },
      });
      // No socket was ever opened, and disposal is irreversible.
      transport.close();
      await within(transport.socketClosed, "preconnect close proof");
      await assert.rejects(
        transport.connect(),
        (error: unknown) => error instanceof NativeCodexRpcError && error.code === "closed",
      );
      await within(transport.socketClosed, "already-closed proof");
      transport.close();
    },
  );
});

test("socketClosed resolves after a refused handshake", async () => {
  await withLoopbackTransport(
    {
      threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }],
      requireAuthorization: "expected-token",
    },
    async (_server, port) => {
      const transport = new NativeCodexRpcTransport({
        endpoint: {
          kind: "loopback-ws",
          host: "127.0.0.1",
          port,
          authorization: { scheme: "bearer", token: () => "wrong-token" },
        },
      });
      try {
        await assert.rejects(
          transport.connect(),
          (error: unknown) => error instanceof NativeCodexRpcError && error.code === "handshake",
        );
        await within(transport.socketClosed, "close after a refused handshake");
      } finally {
        transport.close();
      }
    },
  );
});

test("socketClosed resolves for a close raced against connect and for an unexpected peer close", async () => {
  await withLoopbackTransport(
    { threads: [{ id: ROOT, parentThreadId: null, status: { type: "idle" } }] },
    async (server, port) => {
      const raced = new NativeCodexRpcTransport({
        endpoint: {
          kind: "loopback-ws",
          host: "127.0.0.1",
          port,
          authorization: { scheme: "bearer", token: () => "socket-close-token" },
        },
      });
      const connecting = raced.connect().catch(() => undefined);
      raced.close();
      await within(raced.socketClosed, "close during connect");
      await connecting;

      const peerClosed = new NativeCodexRpcTransport({
        endpoint: {
          kind: "loopback-ws",
          host: "127.0.0.1",
          port,
          authorization: { scheme: "bearer", token: () => "socket-close-token" },
        },
      });
      await peerClosed.connect();
      await server.stop();
      await within(peerClosed.socketClosed, "peer close proof");
      peerClosed.close();
      raced.close();
    },
  );
});

/* --------------------------------------------------------------- decoders */

test("decoders keep ids, status enums, flags, and cursors and drop the rest", () => {
  const row = decodeNativeCodexThreadRow({
    id: " thread-9 ",
    parentThreadId: "thread-1",
    status: { type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput", "waitingOnApproval"] },
    cwd: `${FAKE_MARKER}/worktree`,
    preview: `${FAKE_MARKER} first message`,
    name: `${FAKE_MARKER} title`,
    path: `${FAKE_MARKER}/rollout.jsonl`,
    model: "gpt-something",
  });
  assert.deepEqual(row, {
    threadId: "thread-9",
    parentThreadId: "thread-1",
    status: { kind: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] },
  });
  assert.equal(decodeNativeCodexThreadRow({ id: "a", status: { type: "sideways" } }), null);
  assert.equal(decodeNativeCodexThreadRow({ id: "a", status: { type: "idle" }, parentThreadId: "" }), null);
  assert.equal(decodeNativeCodexThreadRow({ status: { type: "idle" } }), null);

  const terminals = decodeNativeCodexTerminalPage({
    data: [
      { itemId: "i1", processId: "p1", command: "secret command", cwd: "/secret", osPid: 4242, cpuPercent: 1.5, rssKb: 9 },
      { itemId: "i2", processId: "p1", command: "secret command 2" },
      { itemId: "i3", command: "no process id" },
    ],
    nextCursor: null,
  });
  assert.deepEqual(terminals, { processIds: ["p1", "i3"], nextCursor: null });

  assert.deepEqual(decodeNativeCodexNotification("thread/deleted", { threadId: "t", extra: FAKE_MARKER }),
    { method: "thread/deleted", threadId: "t" });
  assert.equal(decodeNativeCodexNotification("thread/status/changed", { threadId: "t" }), null);
  assert.equal(decodeNativeCodexNotification("turn/started", { threadId: "t" }), null);
});
