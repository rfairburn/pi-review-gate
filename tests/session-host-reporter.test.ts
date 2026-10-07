/**
 * Session-host status companion tests (issue #323).
 *
 * Exercises the REAL production extension entry point (src/session-host/
 * reporter.ts) and protocol (src/session-host/protocol.ts) against a bounded
 * local net server on a unix domain socket and a synthetic Pi event emitter /
 * UI object. No state algorithm is duplicated here: frames are observed on
 * the wire and asserted as received.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NODE_OPTIONS_RESTORE_ENV, restoreNodeOptions } from "../src/session-host/bootstrap-preload";
import activate, { __test as reporterTest, primeReporterBootstrap, SESSION_HOST_STICKY_STATE_KEY } from "../src/session-host/reporter";
import {
  HOST_BOOTSTRAP_ENV,
  MAX_NATIVE_SESSION_NAME_LENGTH,
  MAX_RENAME_NAME_BYTES,
  decodeFrame,
  encodeFrame,
  parseBootstrap,
  parseRenameAck,
  parseRenameRequest,
  parseStatus,
  sanitizeActivityLine,
  stripTerminalControls,
  type SessionHostMessage,
  type SessionHostStatus,
} from "../src/session-host/protocol";

// ----------------------------------------------------------------------
// Synthetic Pi host + UI fixtures
// ----------------------------------------------------------------------

interface TestPi {
  pi: unknown;
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  trigger(name: string, ...args: unknown[]): Promise<void>;
}

function createPi(): TestPi {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
  };
  const trigger = async (name: string, ...args: unknown[]): Promise<void> => {
    for (const handler of hooks.get(name) ?? []) {
      await handler(...args);
    }
  };
  return { pi, hooks, trigger };
}

interface TestUi {
  ui: Record<string, unknown>;
  original: (...args: unknown[]) => unknown;
  calls: Array<{ key: unknown; value: unknown; thisArg: unknown; options: unknown }>;
}

function makeUi(options: { frozen?: boolean; fail?: boolean; returnValue?: unknown } = {}): TestUi {
  const calls: TestUi["calls"] = [];
  const original = (...args: unknown[]): unknown => {
    if (options.fail) throw new Error("ui setWidget failure");
    calls.push({ key: args[0], value: args[1], thisArg: ui, options: args[2] });
    return options.returnValue ?? "widget-result";
  };
  const ui: Record<string, unknown> = { setWidget: original };
  if (options.frozen) Object.freeze(ui);
  return { ui, original, calls };
}

interface TestCtx {
  mode: string;
  ui: Record<string, unknown>;
  isIdle: () => boolean;
  sessionManager: {
    getSessionId: () => string;
    getSessionName?: () => string | undefined;
    getEntries?: () => unknown[];
  };
}

function makeCtx(ui: Record<string, unknown>, mode: string, isIdle: () => boolean): TestCtx {
  return {
    mode,
    ui,
    isIdle,
    sessionManager: { getSessionId: () => randomUUID() },
  };
}

/** Calls the (possibly wrapped) setWidget on a test context. */
function setWidget(ctx: TestCtx, key: string, value: string[] | undefined, options?: unknown): unknown {
  return (ctx.ui.setWidget as (...args: unknown[]) => unknown)(key, value, options);
}

// ----------------------------------------------------------------------
// Bounded local net server (unix domain socket)
// ----------------------------------------------------------------------

interface Frame {
  raw: string;
  message: Record<string, unknown>;
}

interface TestServer {
  socketPath: string;
  frames: Frame[];
  connections: number;
  waitForFrame(predicate: (frame: Frame) => boolean, timeoutMs?: number, afterIndex?: number): Promise<Frame>;
  sendToClients(data: string): void;
  destroyClients(): void;
  close(): Promise<void>;
}

let serverCounter = 0;

async function startServer(): Promise<TestServer> {
  // Keep the path well under the unix socket sun_path limit (~104 chars on
  // macOS, where tmpdir() is already long).
  serverCounter += 1;
  const socketPath = join(tmpdir(), `sh-${process.pid}-${serverCounter}.sock`);
  const frames: Frame[] = [];
  let connections = 0;
  const clients: net.Socket[] = [];
  const server = net.createServer((client) => {
    connections += 1;
    clients.push(client);
    client.on("error", () => undefined);
    client.on("close", () => {
      const index = clients.indexOf(client);
      if (index >= 0) clients.splice(index, 1);
    });
    let buffer = "";
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index + 1);
        buffer = buffer.slice(index + 1);
        const message = decodeFrame(line);
        if (message) frames.push({ raw: line, message: message as unknown as Record<string, unknown> });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  // afterIndex bounds the search to frames received after a given index so
  // a predicate that also matches an earlier frame (e.g. inputSurface false)
  // cannot resolve against stale history.
  const waitForFrame = async (predicate: (frame: Frame) => boolean, timeoutMs = 3_000, afterIndex = -1): Promise<Frame> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = frames.find((f, i) => i > afterIndex && predicate(f));
      if (found) return found;
      await sleep(5);
    }
    throw new Error(`timed out waiting for frame; got: ${JSON.stringify(frames.map((f) => f.message))}`);
  };

  return {
    socketPath,
    frames,
    get connections() {
      return connections;
    },
    waitForFrame,
    sendToClients(data: string) {
      for (const client of clients) if (!client.destroyed) client.write(data);
    },
    destroyClients() {
      for (const client of clients.splice(0)) client.destroy();
    },
    close: async () => {
      for (const client of clients.splice(0)) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    },
  };
}

function createMemoryReporterSocket(): {
  socket: net.Socket;
  frames: SessionHostMessage[];
  setWritePolicy(policy: (message: SessionHostMessage) => boolean): void;
} {
  const socket = new net.Socket();
  const frames: SessionHostMessage[] = [];
  let writePolicy = (_message: SessionHostMessage): boolean => true;
  socket.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      const frame = decodeFrame(line);
      if (!frame) continue;
      frames.push(frame);
      if (!writePolicy(frame)) return false;
    }
    return true;
  }) as typeof socket.write;
  return {
    socket,
    frames,
    setWritePolicy(policy) { writePolicy = policy; },
  };
}

function makeBootstrap(socketPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    socketPath,
    token: randomBytes(32).toString("hex"),
    instanceId: randomUUID(),
    generation: randomUUID(),
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const statusFrames = (server: TestServer): Frame[] => server.frames.filter((f) => f.message.type === "status");
const lastStatusSequence = (server: TestServer): number => {
  const statuses = statusFrames(server);
  return statuses.length > 0 ? (statuses.at(-1)!.message.sequence as number) : 0;
};

// ----------------------------------------------------------------------
// Environment + sticky-state hygiene
// ----------------------------------------------------------------------

let previousBootstrapEnv: string | undefined;
let previousRuntimeRole: string | undefined;
const servers: TestServer[] = [];

beforeEach(() => {
  previousBootstrapEnv = process.env[HOST_BOOTSTRAP_ENV];
  delete process.env[HOST_BOOTSTRAP_ENV];
  // Hermetic top-level surface: an inherited executor role (orchestrated
  // workers set it) would divert activate() to its no-op guard.
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY];
});

afterEach(async () => {
  if (previousBootstrapEnv === undefined) delete process.env[HOST_BOOTSTRAP_ENV];
  else process.env[HOST_BOOTSTRAP_ENV] = previousBootstrapEnv;
  if (previousRuntimeRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRuntimeRole;
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY];
  for (const server of servers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

async function startTestServer(): Promise<TestServer> {
  const server = await startServer();
  servers.push(server);
  return server;
}

// ----------------------------------------------------------------------
// Protocol unit behavior (validators, encoding, sanitization)
// ----------------------------------------------------------------------

describe("session-host protocol", () => {
  it("parses a valid bootstrap and rejects malformed fields", () => {
    const bootstrap = makeBootstrap("/tmp/socket.sock");
    assert.ok(parseBootstrap(bootstrap));

    assert.equal(parseBootstrap(undefined), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, version: 2 }), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, socketPath: "relative.sock" }), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, socketPath: `/x${"y".repeat(2048)}.sock` }), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, token: "abc123" }), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, token: "G" + "0".repeat(63) }), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, instanceId: "not-a-uuid-like id" }), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, instanceId: `x${"y".repeat(128)}` }), undefined);
    assert.equal(parseBootstrap({ ...bootstrap, generation: "" }), undefined);
  });

  it("parses status frames with strictly bounded fields", () => {
    const base = {
      version: 1,
      type: "status",
      instanceId: randomUUID(),
      generation: randomUUID(),
      sequence: 1,
      busy: false,
      pendingInput: null,
      inputSurface: false,
      activity: ["Ready"],
    };
    assert.ok(parseStatus(base));

    assert.equal(parseStatus({ ...base, sequence: 0 }), undefined);
    assert.equal(parseStatus({ ...base, sequence: 1.5 }), undefined);
    assert.equal(parseStatus({ ...base, busy: "maybe" }), undefined);
    assert.equal(parseStatus({ ...base, pendingInput: "yes" }), undefined);
    assert.equal(parseStatus({ ...base, inputSurface: "no" }), undefined);
    assert.ok(parseStatus({ ...base, activity: [] }), "zero activity lines are valid");
    assert.equal(parseStatus({ ...base, activity: ["a", "b", "c"] }), undefined);
    assert.equal(parseStatus({ ...base, activity: ["x".repeat(121)] }), undefined);
    assert.equal(parseStatus({ ...base, activity: ["bad\x1b[31mcontrol"] }), undefined);
    assert.equal(parseStatus({ ...base, type: "hello" }), undefined);
  });

  it("validates optional canonical native-session identity/name metadata", () => {
    const base = {
      version: 1,
      type: "status",
      instanceId: randomUUID(),
      generation: randomUUID(),
      sequence: 1,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
    };
    const nativeSession = { sessionId: "native-session-id", epoch: 3, name: "first user prompt" };
    assert.deepEqual(parseStatus({ ...base, nativeSession })?.nativeSession, nativeSession);
    assert.equal(parseStatus({ ...base, nativeSession: null })?.nativeSession, null, "unavailable APIs stay explicitly unknown");
    assert.equal(parseStatus(base)?.nativeSession, undefined, "older reporters may omit the optional metadata");
    assert.equal(parseStatus({ ...base, nativeSession: { ...nativeSession, epoch: 0 } }), undefined);
    assert.equal(parseStatus({ ...base, nativeSession: { ...nativeSession, sessionId: "bad\x1bid" } }), undefined);
    assert.equal(parseStatus({ ...base, nativeSession: { ...nativeSession, sessionId: "/private/session.jsonl" } }), undefined);
    assert.equal(parseStatus({ ...base, nativeSession: { ...nativeSession, name: "bad\u009btitle" } }), undefined);
    assert.equal(parseStatus({ ...base, nativeSession: { ...nativeSession, name: " padded title " } }), undefined);
    assert.equal(parseStatus({ ...base, nativeSession: { ...nativeSession, name: "n".repeat(MAX_NATIVE_SESSION_NAME_LENGTH + 1) } }), undefined);
  });

  it("strictly validates authenticated rename commands and identity-bound acknowledgements", () => {
    const common = {
      version: 1,
      instanceId: randomUUID(),
      generation: randomUUID(),
      requestId: randomUUID(),
      expectedSessionId: "native-session-id",
      expectedSessionEpoch: 9,
    };
    const request = {
      ...common,
      type: "rename_request",
      token: "a".repeat(64),
      name: "persisted title",
    };
    assert.deepEqual(parseRenameRequest(request), request);
    assert.ok(parseRenameRequest({ ...request, name: "  native-normalized title  " }), "Pi's native setter may trim surrounding whitespace");
    assert.equal(parseRenameRequest({ ...request, name: "bad\nname" }), undefined);
    assert.equal(parseRenameRequest({ ...request, name: "line\u2028separator" }), undefined);
    assert.equal(parseRenameRequest({ ...request, name: "x".repeat(MAX_RENAME_NAME_BYTES + 1) }), undefined);
    assert.ok(parseRenameRequest({ ...request, name: "é".repeat(MAX_RENAME_NAME_BYTES / 2) }), "the limit is measured in UTF-8 bytes");
    assert.equal(parseRenameRequest({ ...request, name: "é".repeat(MAX_RENAME_NAME_BYTES / 2 + 1) }), undefined);
    assert.equal(parseRenameRequest({ ...request, expectedSessionEpoch: 0 }), undefined);
    assert.equal(parseRenameRequest({ ...request, token: "wrong" }), undefined);
    assert.ok(decodeFrame(encodeFrame(request as never)));

    const ack = {
      ...common,
      type: "rename_result",
      sessionId: common.expectedSessionId,
      sessionEpoch: common.expectedSessionEpoch,
      outcome: "renamed",
      reason: "none",
    };
    assert.deepEqual(parseRenameAck(ack), ack);
    assert.equal(parseRenameAck({ ...ack, sessionEpoch: ack.sessionEpoch + 1 }), undefined, "success cannot attest another session epoch");
    assert.equal(parseRenameAck({ ...ack, reason: "setter-failed" }), undefined);
    assert.ok(parseRenameAck({ ...ack, sessionId: "other-session", sessionEpoch: ack.sessionEpoch + 1, outcome: "rejected", reason: "stale-session" }));
  });

  it("requires both native session ID and monotonic epoch to match before and after rename", () => {
    const current = { sessionId: "native-one", epoch: 7, name: "title" };
    assert.equal(reporterTest.nativeSessionMatches(current, "native-one", 7), true);
    assert.equal(reporterTest.nativeSessionMatches(current, "native-two", 7), false);
    assert.equal(reporterTest.nativeSessionMatches(current, "native-one", 8), false);
    assert.equal(reporterTest.nativeSessionMatches(null, "native-one", 7), false, "unknown context fails closed");
  });

  it("derives only the bounded canonical native title and treats unavailable APIs as unknown", () => {
    assert.equal(reporterTest.readNativeSession(undefined), undefined);
    assert.equal(reporterTest.readNativeSession({ sessionManager: {
      getSessionId: () => { throw new Error("unavailable"); },
      getSessionName: () => undefined,
      getEntries: () => [],
    } }), undefined);
    assert.equal(reporterTest.readNativeSession({ sessionManager: {
      getSessionId: () => "native-id",
      getSessionName: () => { throw new Error("stale manager"); },
      getEntries: () => [],
    } }), undefined);

    const fallback = reporterTest.readNativeSession({ sessionManager: {
      getSessionId: () => "native-id",
      getSessionName: () => undefined,
      getEntries: () => [
        { type: "message", message: { role: "assistant", content: "not a title" } },
        { type: "message", message: { role: "user", content: "\x01 first\nmessage " } },
      ],
    } });
    assert.deepEqual(fallback, { sessionId: "native-id", displayName: "first message" });
    const noMessages = reporterTest.readNativeSession({ sessionManager: {
      getSessionId: () => "native-id",
      getSessionName: () => undefined,
      getEntries: () => [],
    } });
    assert.equal(noMessages?.displayName, "(no messages)");
    const clipped = reporterTest.readNativeSession({ sessionManager: {
      getSessionId: () => "native-id",
      getSessionName: () => "n".repeat(MAX_NATIVE_SESSION_NAME_LENGTH + 10),
      getEntries: () => [],
    } });
    assert.equal(clipped?.displayName.length, MAX_NATIVE_SESSION_NAME_LENGTH, "display name clipping never changes the stored name");
    assert.equal(clipped?.storedName?.length, MAX_NATIVE_SESSION_NAME_LENGTH + 10);
  });

  it("round-trips frames through encode/decode and rejects oversized lines", () => {
    const message: SessionHostStatus = {
      version: 1,
      type: "status",
      instanceId: randomUUID(),
      generation: randomUUID(),
      sequence: 7,
      busy: true,
      pendingInput: null,
      inputSurface: false,
      activity: ["Working"],
    };
    const frame = encodeFrame(message);
    assert.ok(frame.endsWith("\n"));
    assert.deepEqual(decodeFrame(frame), { ...message });

    assert.equal(decodeFrame("not json\n"), undefined);
    assert.equal(decodeFrame("a".repeat(20_000)), undefined); // over MAX_STATUS_FRAME_BYTES
  });

  it("strips terminal controls and truncates activity lines", () => {
    assert.equal(stripTerminalControls("\x1b[31mred\x1b[0m"), "red");
    assert.equal(stripTerminalControls("\x1b]0;window title\x07text"), "text");
    assert.equal(stripTerminalControls("a\x00b\x7fc\rd\ne"), "abcde");
    // C1 controls (U+0080..U+009F) include CSI/OSC/ST lookalikes: strip them.
    assert.ok(!/[\u0080-\u009f]/.test(stripTerminalControls("a\u009B[31mb\u009Dc")));
    assert.equal(sanitizeActivityLine(`t\u009Bname`), "tname");
    assert.equal(sanitizeActivityLine(`\x1b[1m${"t".repeat(200)}\x1b[0m`), "t".repeat(120));
  });

  it("rejects status frames carrying C1 controls in activity", () => {
    const base = {
      version: 1,
      type: "status",
      instanceId: randomUUID(),
      generation: randomUUID(),
      sequence: 1,
      busy: false,
      pendingInput: null,
      inputSurface: false,
    };
    assert.equal(parseStatus({ ...base, activity: ["\u009B"] }), undefined, "C1 CSI lookalike rejected");
    assert.equal(parseStatus({ ...base, activity: ["a\u009D"] }), undefined, "C1 ST lookalike rejected");
    assert.ok(parseStatus({ ...base, activity: ["clean"] }));
  });
});

// ----------------------------------------------------------------------
// Extension entry point: opt-in gating and env consumption
// ----------------------------------------------------------------------

describe("session-host reporter activation", () => {
  it("registers nothing and performs no IO without a bootstrap", async () => {
    const server = await startTestServer();
    const { pi, hooks } = createPi();
    await activate(pi);
    assert.equal(hooks.size, 0);
    assert.equal((globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY], undefined);
    // Even a TUI session_start must not connect: no hooks were registered.
    await sleep(20);
    assert.equal(server.connections, 0);
    assert.equal(server.frames.length, 0);
  });

  it("consumes the bootstrap env before any async work (descendant suppression)", async () => {
    const server = await startTestServer();
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(makeBootstrap(server.socketPath));
    const { pi, hooks } = createPi();
    await activate(pi);
    assert.equal(process.env[HOST_BOOTSTRAP_ENV], undefined);
    assert.ok(hooks.size > 0, "hooks registered with a valid bootstrap");
  });

  it("treats malformed bootstrap env as absent", async () => {
    const server = await startTestServer();
    for (const raw of [
      "not-json",
      JSON.stringify(makeBootstrap(server.socketPath, { token: "short" })),
      JSON.stringify(makeBootstrap(server.socketPath, { socketPath: "relative.sock" })),
      JSON.stringify(makeBootstrap(server.socketPath, { instanceId: "bad id!" })),
    ]) {
      process.env[HOST_BOOTSTRAP_ENV] = raw;
      const { pi, hooks } = createPi();
      await activate(pi);
      assert.equal(hooks.size, 0, `malformed env must not register: ${raw}`);
      assert.equal(process.env[HOST_BOOTSTRAP_ENV], undefined, "env still consumed");
    }
  });

  it("never activates in executor runtimes", async () => {
    const server = await startTestServer();
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(makeBootstrap(server.socketPath));
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
    const { pi, hooks } = createPi();
    await activate(pi);
    assert.equal(hooks.size, 0);
    assert.equal(process.env[HOST_BOOTSTRAP_ENV], undefined);
  });
});

// ----------------------------------------------------------------------
// Live session reporting against the local net server
// ----------------------------------------------------------------------

describe("session-host reporter status frames", () => {
  async function startSession(options: {
    server: TestServer;
    bootstrap?: Record<string, unknown>;
    mode?: string;
    ui?: TestUi;
    isIdle?: () => boolean;
    sessionManager?: TestCtx["sessionManager"];
    reporterOptions?: {
      reconnectDelayMs?: number;
      maxReconnectAttempts?: number;
      connectSocket?: (socketPath: string) => net.Socket;
      onSocket?: (socket: net.Socket) => void;
    };
  }): Promise<{ testPi: TestPi; ctx: TestCtx; bootstrap: Record<string, unknown> }> {
    const bootstrap = options.bootstrap ?? makeBootstrap(options.server.socketPath);
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);
    const testPi = createPi();
    await activate(testPi.pi, options.reporterOptions);
    const ui = options.ui ?? makeUi();
    const ctx = makeCtx(ui.ui, options.mode ?? "tui", options.isIdle ?? (() => true));
    if (options.sessionManager) ctx.sessionManager = options.sessionManager;
    await testPi.trigger("session_start", { type: "session_start", reason: "startup" }, ctx);
    return { testPi, ctx, bootstrap };
  }

  it("sends hello with the token, then an initial Ready status", async () => {
    const server = await startTestServer();
    const { testPi, bootstrap } = await startSession({ server });
    const hello = await server.waitForFrame((f) => f.message.type === "hello");
    assert.equal(hello.message.instanceId, bootstrap.instanceId);
    assert.equal(hello.message.generation, bootstrap.generation);
    assert.equal(hello.message.token, bootstrap.token);

    const status = await server.waitForFrame((f) => f.message.type === "status");
    assert.equal(status.message.busy, false);
    // The decorator only observes future setWidget calls; pending presence is
    // unknown until first observed, never a fabricated clear.
    assert.equal(status.message.pendingInput, null);
    assert.equal(status.message.inputSurface, false);
    assert.deepEqual(status.message.activity, ["Ready"]);
    assert.equal(status.message.nativeSession, null, "missing public session metadata remains unknown");
    assert.equal(status.message.sequence, 1);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("reports native canonical names, persists fenced renames through the public setter, and rebinds sessions", async () => {
    const server = await startTestServer();
    const native = {
      id: "native-session-one",
      name: undefined as string | undefined,
      entries: [
        { type: "message", message: { role: "assistant", content: "not the fallback" } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "\u0001  first\nuser prompt  " }] } },
      ] as unknown[],
    };
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => native.id,
      getSessionName: () => native.name,
      getEntries: () => native.entries,
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager });
    let setterCalls = 0;
    (testPi.pi as { setSessionName?: (name: string) => void }).setSessionName = (name) => {
      setterCalls += 1;
      native.name = name;
    };

    const initial = await server.waitForFrame((frame) => frame.message.type === "status");
    const firstNative = initial.message.nativeSession as { sessionId: string; epoch: number; name: string };
    assert.deepEqual(firstNative, {
      sessionId: native.id,
      epoch: 1,
      name: "first user prompt",
    }, "native first stored user message is the fallback; assistant text is ignored");

    const rename = {
      version: 1,
      type: "rename_request",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      token: bootstrap.token,
      requestId: randomUUID(),
      expectedSessionId: native.id,
      expectedSessionEpoch: firstNative.epoch,
      name: "Persisted title",
    };
    server.sendToClients(encodeFrame(rename as never));
    const ackFrame = await server.waitForFrame((frame) => frame.message.type === "rename_result");
    assert.equal(ackFrame.message.outcome, "renamed");
    assert.equal(ackFrame.message.sessionId, native.id);
    assert.equal(ackFrame.message.sessionEpoch, firstNative.epoch);
    assert.equal(native.name, "Persisted title", "only public setSessionName persists the rename");
    assert.equal(setterCalls, 1);
    const renamedStatus = await server.waitForFrame((frame) =>
      frame.message.type === "status"
      && (frame.message.nativeSession as { name?: string } | null)?.name === "Persisted title",
    );
    assert.ok(!renamedStatus.raw.includes(bootstrap.token as string), "the capability token never reaches status");

    // Native /name publishes the same persisted title through the public event.
    native.name = "Native /name title";
    await testPi.trigger("session_info_changed", { type: "session_info_changed" }, ctx);
    const nativeRenameStatus = await server.waitForFrame((frame) =>
      frame.message.type === "status"
      && (frame.message.nativeSession as { name?: string } | null)?.name === "Native /name title",
    );
    assert.equal((nativeRenameStatus.message.nativeSession as { sessionId: string }).sessionId, native.id);

    // A native /resume selection changes the manager's ID within this child.
    const oldEpoch = firstNative.epoch;
    native.id = "native-session-two";
    native.name = undefined;
    native.entries = [];
    await testPi.trigger("session_start", { type: "session_start", reason: "resume" }, ctx);
    const resumed = await server.waitForFrame((frame) =>
      frame.message.type === "status"
      && (frame.message.nativeSession as { sessionId?: string } | null)?.sessionId === native.id,
    );
    const resumedNative = resumed.message.nativeSession as { sessionId: string; epoch: number; name: string };
    assert.ok(resumedNative.epoch > oldEpoch, "the session epoch advances across native selection/reload boundaries");
    assert.equal(resumedNative.name, "(no messages)", "empty native sessions use Pi's native fallback");

    const staleRename = { ...rename, requestId: randomUUID(), name: "must not rename session two" };
    server.sendToClients(encodeFrame(staleRename as never));
    const staleAck = await server.waitForFrame((frame) =>
      frame.message.type === "rename_result" && frame.message.requestId === staleRename.requestId,
    );
    assert.equal(staleAck.message.outcome, "rejected");
    assert.equal(staleAck.message.reason, "stale-session");
    assert.equal(native.name, undefined, "stale request never mutates the newly selected native session");
    assert.equal(setterCalls, 1);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("bounds and drains rename acknowledgements under socket backpressure [review_ack_queue]", async () => {
    const fakeServer = { socketPath: join(process.cwd(), "unused-memory-reporter.sock") } as TestServer;
    const memory = createMemoryReporterSocket();
    const native = { id: "ack-queue-session", name: undefined as string | undefined, entries: [] as unknown[] };
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => native.id,
      getSessionName: () => native.name,
      getEntries: () => native.entries,
    };
    const { testPi, ctx, bootstrap } = await startSession({
      server: fakeServer,
      sessionManager,
      reporterOptions: { connectSocket: () => memory.socket },
    });
    let setterCalls = 0;
    (testPi.pi as { setSessionName?: (name: string) => void }).setSessionName = (name) => {
      setterCalls += 1;
      native.name = name;
    };
    let ackWriteCalls = 0;
    let blockAllAcks = false;
    memory.setWritePolicy((frame) => {
      if (frame.type !== "rename_result") return true;
      ackWriteCalls += 1;
      return ackWriteCalls !== 1 && !blockAllAcks;
    });

    try {
      memory.socket.emit("connect");
      const initial = memory.frames.find((frame) => frame.type === "status");
      assert.ok(initial?.type === "status" && initial.nativeSession);
      const firstBatchRequestIds: string[] = [];
      const firstBatch = Array.from({ length: 3 }, (_, index) => {
        const requestId = randomUUID();
        firstBatchRequestIds.push(requestId);
        return encodeFrame({
          version: 1,
          type: "rename_request",
          instanceId: bootstrap.instanceId,
          generation: bootstrap.generation,
          token: bootstrap.token,
          requestId,
          expectedSessionId: initial.nativeSession!.sessionId,
          expectedSessionEpoch: initial.nativeSession!.epoch,
          name: `first-batch-${index}`,
        } as never);
      });
      memory.socket.emit("data", Buffer.from(firstBatch.join(""), "utf8"));
      assert.equal(ackWriteCalls, 1, "write(false) stops direct acknowledgement writes");
      assert.equal(setterCalls, 3, "bounded queued replies still correspond to handled commands");

      memory.socket.emit("drain");
      assert.equal(ackWriteCalls, 3, "queued acknowledgements flush on drain");
      assert.deepEqual(
        memory.frames.filter((frame) => frame.type === "rename_result").map((frame) => frame.requestId),
        firstBatchRequestIds,
        "queued acknowledgements flush in request order",
      );

      blockAllAcks = true;
      const queueLimit = reporterTest.MAX_QUEUED_RENAME_ACKS;
      const overflowRequests = Array.from({ length: queueLimit + 2 }, (_, index) => encodeFrame({
        version: 1,
        type: "rename_request",
        instanceId: bootstrap.instanceId,
        generation: bootstrap.generation,
        token: bootstrap.token,
        requestId: randomUUID(),
        expectedSessionId: initial.nativeSession!.sessionId,
        expectedSessionEpoch: initial.nativeSession!.epoch,
        name: `overflow-batch-${index}`,
      } as never));
      memory.socket.emit("data", Buffer.from(overflowRequests.join(""), "utf8"));
      assert.equal(ackWriteCalls, 4, "only one overflow-batch reply reaches the backpressured socket");
      assert.equal(setterCalls, 3 + queueLimit + 1, "the command beyond reply capacity is rejected before mutation");
      assert.equal(memory.socket.destroyed, true, "reply-capacity exhaustion closes the authenticated channel");
    } finally {
      await testPi.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
    }
  });

  it("refreshes the canonical title after the first user message is persisted, before settlement [review_persisted_user]", async () => {
    const fakeServer = { socketPath: join(process.cwd(), "unused-memory-reporter.sock") } as TestServer;
    const memory = createMemoryReporterSocket();
    const native = { id: "stored-message-session", name: undefined as string | undefined, entries: [] as unknown[] };
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => native.id,
      getSessionName: () => native.name,
      getEntries: () => native.entries,
    };
    const { testPi, ctx } = await startSession({
      server: fakeServer,
      sessionManager,
      reporterOptions: { connectSocket: () => memory.socket },
    });

    try {
      memory.socket.emit("connect");
      const initial = memory.frames.filter((frame) => frame.type === "status").at(-1);
      assert.ok(initial?.type === "status" && initial.nativeSession);
      assert.equal(initial.nativeSession.name, "(no messages)");

      await testPi.trigger("agent_start", { type: "agent_start" }, ctx);
      const beforePersistence = memory.frames.filter((frame) => frame.type === "status").at(-1);
      assert.ok(beforePersistence?.type === "status");
      assert.equal(beforePersistence.busy, true);
      assert.equal(beforePersistence.nativeSession?.name, "(no messages)");

      const eventText = "message_end payload must not become a title";
      await testPi.trigger("message_end", {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: eventText }] },
      }, ctx);
      native.entries.push({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "stored native first message" }] },
      }); // Simulate Pi's SessionManager.appendMessage after the public message_end hook returns.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const refreshed = memory.frames.filter((frame) => frame.type === "status").at(-1);
      assert.ok(refreshed?.type === "status" && refreshed.nativeSession);
      assert.equal(refreshed.nativeSession.name, "stored native first message");
      assert.notEqual(refreshed.nativeSession.name, eventText, "metadata comes from stored SessionManager entries, not event text");
      assert.equal(refreshed.busy, true, "metadata refresh preserves busy state");
      assert.deepEqual(refreshed.activity, ["Working"], "metadata refresh preserves activity semantics");
    } finally {
      await testPi.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
    }
  });

  it("rejects host commands with the wrong token before calling the public rename setter", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "native-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager, reporterOptions: { reconnectDelayMs: 20 } });
    let setterCalls = 0;
    (testPi.pi as { setSessionName?: (name: string) => void }).setSessionName = () => { setterCalls += 1; };
    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const nativeSession = status.message.nativeSession as { sessionId: string; epoch: number };
    const command = {
      version: 1,
      type: "rename_request",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      token: "0".repeat(64),
      requestId: randomUUID(),
      expectedSessionId: nativeSession.sessionId,
      expectedSessionEpoch: nativeSession.epoch,
      name: "must be rejected",
    };
    server.sendToClients(encodeFrame(command as never));
    await server.waitForFrame((frame) => frame.message.type === "hello" && server.frames.filter((entry) => entry.message.type === "hello").length >= 2);
    assert.equal(setterCalls, 0, "wrong capability closes the channel without invoking the native setter");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("fences old reporter commands and epochs immediately across /reload", async () => {
    const server = await startTestServer();
    const bootstrap = makeBootstrap(server.socketPath);
    const native = { id: "reload-session", name: undefined as string | undefined };
    const ctx = makeCtx(makeUi().ui, "tui", () => true);
    ctx.sessionManager = {
      getSessionId: () => native.id,
      getSessionName: () => native.name,
      getEntries: () => [],
    };
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);
    const first = createPi();
    let firstSetterCalls = 0;
    (first.pi as { setSessionName?: (name: string) => void }).setSessionName = () => { firstSetterCalls += 1; };
    await activate(first.pi);
    await first.trigger("session_start", { type: "session_start" }, ctx);
    const firstStatus = await server.waitForFrame((frame) => frame.message.type === "status");
    const oldEpoch = (firstStatus.message.nativeSession as { epoch: number }).epoch;

    const reloaded = createPi();
    let reloadedSetterCalls = 0;
    (reloaded.pi as { setSessionName?: (name: string) => void }).setSessionName = () => { reloadedSetterCalls += 1; };
    await activate(reloaded.pi); // immediately tears down the previous reporter incarnation
    await reloaded.trigger("session_start", { type: "session_start", reason: "reload" }, ctx);
    await server.waitForFrame((frame) =>
      frame.message.type === "hello" && server.frames.filter((entry) => entry.message.type === "hello").length >= 2,
    );
    const current = await server.waitForFrame((frame) =>
      frame.message.type === "status"
      && (frame.message.nativeSession as { epoch?: number } | null)?.epoch !== undefined
      && ((frame.message.nativeSession as { epoch: number }).epoch > oldEpoch),
    );
    const currentNative = current.message.nativeSession as { sessionId: string; epoch: number };
    const stale = {
      version: 1,
      type: "rename_request",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      token: bootstrap.token,
      requestId: randomUUID(),
      expectedSessionId: currentNative.sessionId,
      expectedSessionEpoch: oldEpoch,
      name: "old incarnation must not rename",
    };
    server.sendToClients(encodeFrame(stale as never));
    const ack = await server.waitForFrame((frame) => frame.message.type === "rename_result" && frame.message.requestId === stale.requestId);
    assert.equal(ack.message.outcome, "rejected");
    assert.equal(ack.message.reason, "stale-session");
    assert.equal(firstSetterCalls, 0);
    assert.equal(reloadedSetterCalls, 0);
    await reloaded.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("reports unknown pending for a pre-existing panel and resolves on first observed set/clear", async () => {
    const server = await startTestServer();
    const ui = makeUi();
    const key = "review-gate-pending-questions";
    // A panel already present before the reporter registered: no getter can
    // see it, so it must read as unknown, not fabricated false.
    ui.original.call(ui.ui, key, ["Pending questions · Press Ctrl+Alt+Up"]);
    const { testPi, ctx } = await startSession({ server, ui });

    const initial = await server.waitForFrame((f) => f.message.type === "status");
    assert.equal(initial.message.pendingInput, null, "pre-existing panel is unknown, not false");

    // First observed clear resolves to false.
    setWidget(ctx, key, undefined, { placement: "aboveEditor" });
    const cleared = await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === false);
    assert.ok((cleared.message.sequence as number) > (initial.message.sequence as number));

    // First observed set resolves to true.
    setWidget(ctx, key, ["Pending questions · Press Ctrl+Alt+Up"]);
    const set = await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    assert.ok((set.message.sequence as number) > (cleared.message.sequence as number));
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("tracks busy on agent_start, ignores agent_end, settles via agent_settled isIdle", async () => {
    const server = await startTestServer();
    let idle = true;
    const { testPi, ctx: liveCtx } = await startSession({ server, isIdle: () => idle });

    await testPi.trigger("agent_start", { type: "agent_start" }, liveCtx);
    let status = await server.waitForFrame((f) => f.message.type === "status" && f.message.busy === true);
    assert.deepEqual(status.message.activity, ["Working"]);

    // agent_end is NOT an idle boundary: no new frame, still busy.
    const sequenceAfterAgentEnd = lastStatusSequence(server);
    await testPi.trigger("agent_end", { type: "agent_end" }, liveCtx);
    await sleep(30);
    assert.equal(lastStatusSequence(server), sequenceAfterAgentEnd);
    status = statusFrames(server).at(-1)!;
    assert.equal(status.message.busy, true);

    // agent_settled with a not-idle probe keeps busy.
    idle = false;
    await testPi.trigger("agent_settled", { type: "agent_settled" }, liveCtx);
    await sleep(30);
    assert.equal(lastStatusSequence(server), sequenceAfterAgentEnd, "not-idle settlement must not emit a new frame");

    // agent_settled with an idle probe settles to Ready.
    idle = true;
    await testPi.trigger("agent_settled", { type: "agent_settled" }, liveCtx);
    status = await server.waitForFrame((f) => f.message.type === "status" && f.message.busy === false && (f.message.sequence as number) > sequenceAfterAgentEnd);
    assert.deepEqual(status.message.activity, ["Ready"]);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("reports top-level tool activity by name only, ignoring nested calls and args", async () => {
    const server = await startTestServer();
    const { testPi, ctx } = await startSession({ server });

    await testPi.trigger("tool_execution_start", {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo SECRET-COMMAND-ARG" },
    }, ctx);
    const status = await server.waitForFrame((f) => f.message.type === "status" && (f.message.activity as string[])[0] === "bash");
    assert.deepEqual(status.message.activity, ["bash"]);
    assert.ok(!status.raw.includes("SECRET-COMMAND-ARG"), "tool args never enter a frame");

    // Nested (task-child) executions are not reported.
    const sequenceBeforeNested = lastStatusSequence(server);
    await testPi.trigger("tool_execution_start", {
      toolCallId: "call-2",
      parentToolCallId: "call-1",
      toolName: "SubtasksStart",
      args: { prompt: "SECRET-CHILD-PROMPT" },
    }, ctx);
    await sleep(30);
    assert.equal(lastStatusSequence(server), sequenceBeforeNested);
    assert.ok(!server.frames.some((f) => f.raw.includes("SECRET-CHILD-PROMPT")));

    // ANSI-laden and over-long tool names are sanitized.
    await testPi.trigger("tool_execution_start", { toolCallId: "call-3", toolName: `\x1b[31mgrep\x1b[0m` }, ctx);
    const sanitized = await server.waitForFrame((f) => f.message.type === "status" && (f.message.activity as string[])[0] === "grep");
    assert.deepEqual(sanitized.message.activity, ["grep"]);
    await testPi.trigger("tool_execution_start", { toolCallId: "call-4", toolName: "t".repeat(200) }, ctx);
    const truncated = await server.waitForFrame((f) => f.message.type === "status" && (f.message.activity as string[])[0] === "t".repeat(120));
    assert.deepEqual(truncated.message.activity, ["t".repeat(120)]);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("observes pending-question panel set/clear while busy; UI surface is independent", async () => {
    const server = await startTestServer();
    const ui = makeUi();
    const { testPi, ctx } = await startSession({ server, ui });
    const key = "review-gate-pending-questions";

    await testPi.trigger("agent_start", { type: "agent_start" }, ctx);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.busy === true);

    // Panel set (array) while busy: pending presence updates asynchronously.
    const returnValue = setWidget(ctx, key, ["Pending questions · Press Ctrl+Alt+Up"], { placement: "aboveEditor" });
    assert.equal(returnValue, "widget-result", "wrapper preserves the original return value");
    let status = await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    assert.equal(status.message.busy, true, "pending updates while runtime busy");

    // Modal input surface toggles independently of pending presence.
    await testPi.trigger("ui_prompt_start", { type: "ui_prompt_start" }, ctx);
    status = await server.waitForFrame((f) => f.message.type === "status" && f.message.inputSurface === true);
    assert.equal(status.message.pendingInput, true);
    const beforePromptEnd = server.frames.length - 1;
    await testPi.trigger("ui_prompt_end", { type: "ui_prompt_end" }, ctx);
    status = await server.waitForFrame((f) => f.message.type === "status" && f.message.inputSurface === false, 3_000, beforePromptEnd);
    assert.equal(status.message.pendingInput, true);

    // Panel clear (undefined) while still busy.
    setWidget(ctx, key, undefined, { placement: "aboveEditor" });
    status = await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === false);
    assert.equal(status.message.busy, true);

    // Question text never enters a frame.
    assert.ok(!server.frames.some((f) => f.raw.includes("Pending questions")), "panel line text stays out of frames");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("forwards setWidget this/args/errors unchanged and survives failing UIs", async () => {
    const server = await startTestServer();
    const ui = makeUi({ fail: true, returnValue: "sentinel" });
    const { testPi, ctx } = await startSession({ server, ui });
    const key = "review-gate-pending-questions";

    assert.throws(
      () => setWidget(ctx, key, ["question line"]),
      /ui setWidget failure/,
      "the original error propagates through the wrapper",
    );
    // A failed call establishes no verified widget presence.
    const status = await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === null);
    assert.equal(status.message.busy, false);
    assert.ok(!statusFrames(server).some((f) => f.message.pendingInput === true));

    // A failing UI that also swallows its own calls keeps forwarding.
    const foreignCalls: unknown[][] = [];
    const foreignUi = makeUi();
    const originalForeign = foreignUi.original;
    foreignUi.ui.setWidget = (...args: unknown[]) => {
      foreignCalls.push(args);
      return originalForeign.apply(foreignUi.ui, args);
    };
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    assert.equal(foreignUi.ui.setWidget, foreignUi.ui.setWidget); // sanity: still the foreign wrapper
    await testPi.trigger("session_start", { type: "session_start", reason: "restart" }, makeCtx(foreignUi.ui, "tui", () => true));
    const result = (foreignUi.ui.setWidget as (...args: unknown[]) => unknown)("other-key", ["x"], { placement: "aboveEditor" });
    assert.equal(result, "widget-result");
    assert.deepEqual(foreignCalls.at(-1), ["other-key", ["x"], { placement: "aboveEditor" }], "foreign decorator sees original this/args");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("does not report a failed native clear as no pending questions", async () => {
    const server = await startTestServer();
    const ui = makeUi();
    const key = "review-gate-pending-questions";
    const failure = new Error("native clear failed");
    const native = ui.original;
    ui.ui.setWidget = function (this: unknown, ...args: unknown[]): unknown {
      if (args[0] === key && args[1] === undefined) throw failure;
      return native.apply(this, args);
    };
    const { testPi, ctx } = await startSession({ server, ui });
    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const beforeClear = server.frames.length - 1;
    assert.throws(() => setWidget(ctx, key, undefined), (error: unknown) => error === failure);
    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeClear,
    );
    assert.ok(!server.frames.slice(beforeClear + 1).some(
      (f) => f.message.type === "status" && f.message.pendingInput === false,
    ));
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("never mutates frozen UIs and reports pendingInput null (unknown, not clear)", async () => {
    const server = await startTestServer();
    const ui = makeUi({ frozen: true });
    const { testPi } = await startSession({ server, ui });
    assert.equal(ui.ui.setWidget, ui.original, "frozen UI is never wrapped");
    const status = await server.waitForFrame((f) => f.message.type === "status");
    assert.equal(status.message.pendingInput, null);
    assert.equal(status.message.busy, false);
  });

  it("never observes or connects for non-TUI sessions", async () => {
    const server = await startTestServer();
    const ui = makeUi();
    const { testPi } = await startSession({ server, mode: "print", ui });
    assert.equal(ui.ui.setWidget, ui.original, "print UI is never wrapped");
    await sleep(30);
    assert.equal(server.connections, 0, "no socket connection for non-TUI sessions");
    assert.equal(server.frames.length, 0);
    // A later TUI session in the same process still reports.
    const tuiUi = makeUi();
    await testPi.trigger("session_start", { type: "session_start", reason: "restart" }, makeCtx(tuiUi.ui, "tui", () => true));
    await server.waitForFrame((f) => f.message.type === "hello");
  });

  it("restores only its own setWidget wrapper on session shutdown", async () => {
    const server = await startTestServer();
    const ui = makeUi();
    let foreignCalls = 0;
    const foreignWrapper = (...args: unknown[]): unknown => {
      foreignCalls += 1;
      return ui.original.apply(ui.ui, args);
    };
    ui.ui.setWidget = foreignWrapper;

    const { testPi, ctx } = await startSession({ server, ui });
    assert.notEqual(ctx.ui.setWidget, foreignWrapper, "reporter wrapped over the foreign decorator");

    setWidget(ctx, "review-gate-pending-questions", ["line"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    assert.equal(foreignCalls, 1, "foreign decorator stays in the call chain");

    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    assert.equal(ctx.ui.setWidget, foreignWrapper, "shutdown restores the foreign wrapper, not the original");

    // Reinstall and shutdown again: still only our own layer is removed.
    await testPi.trigger("session_start", { type: "session_start", reason: "restart" }, ctx);
    assert.notEqual(ctx.ui.setWidget, foreignWrapper);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    assert.equal(ctx.ui.setWidget, foreignWrapper);

    // Without a foreign wrapper the original is restored.
    const plainUi = makeUi();
    await testPi.trigger("session_start", { type: "session_start", reason: "restart" }, makeCtx(plainUi.ui, "tui", () => true));
    assert.notEqual(plainUi.ui.setWidget, plainUi.original);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    assert.equal(plainUi.ui.setWidget, plainUi.original);
  });

  it("reconnects after socket loss and sends hello then the LATEST status", async () => {
    const server = await startTestServer();
    let idle = true;
    const { testPi, ctx } = await startSession({ server, isIdle: () => idle, reporterOptions: { reconnectDelayMs: 20 } });
    await server.waitForFrame((f) => f.message.type === "hello");

    await testPi.trigger("agent_start", { type: "agent_start" }, ctx);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.busy === true);

    // Drop the connection; state changes while disconnected.
    server.destroyClients();
    idle = true;
    await testPi.trigger("agent_settled", { type: "agent_settled" }, ctx);
    await sleep(30); // let the (suppressed, disconnected) state settle

    // Bounded reconnect delivers hello then the latest snapshot only.
    await server.waitForFrame(
      (f) => f.message.type === "hello" && server.frames.filter((g) => g.message.type === "hello").length >= 2,
    );
    assert.ok(server.connections >= 2);
    const helloIndexes = server.frames.map((f, i) => (f.message.type === "hello" ? i : -1)).filter((i) => i >= 0);
    assert.equal(helloIndexes.length, 2, "reconnect re-hellos exactly once");
    const afterReconnect = server.frames.slice(helloIndexes[1]!).filter((f) => f.message.type === "status");
    assert.equal(afterReconnect.length, 1, "reconnect sends exactly the latest snapshot");
    assert.equal(afterReconnect[0]!.message.busy, false);
    assert.deepEqual(afterReconnect[0]!.message.activity, ["Ready"]);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("gives up reconnecting after a bounded number of attempts and keeps native hooks working", async () => {
    const server = await startTestServer();
    await server.close(); // listener gone: every connect attempt is refused
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(makeBootstrap(server.socketPath));
    const testPi = createPi();
    await activate(testPi.pi, { reconnectDelayMs: 10, maxReconnectAttempts: 2 });
    const ctx = makeCtx(makeUi().ui, "tui", () => true);
    await testPi.trigger("session_start", { type: "session_start" }, ctx);

    // Native hooks keep working while disconnected (no throw, no frame).
    await testPi.trigger("agent_start", { type: "agent_start" }, ctx);
    await testPi.trigger("agent_settled", { type: "agent_settled" }, ctx);
    await sleep(100); // well past 2 attempts x 10ms

    // A fresh session_start reconnects (attempts reset). The host reads
    // frames; drain here so buffered writes complete before teardown.
    const reopened = net.createServer((client) => {
      client.on("data", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      reopened.once("error", reject);
      reopened.listen(server.socketPath, resolve);
    });
    let reconnected = false;
    reopened.on("connection", () => {
      reconnected = true;
    });
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    await testPi.trigger("session_start", { type: "session_start", reason: "restart" }, ctx);
    const deadline = Date.now() + 2_000;
    while (!reconnected && Date.now() < deadline) await sleep(5);
    assert.ok(reconnected, "a new session retries the connection");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    await new Promise<void>((resolve) => reopened.close(() => resolve()));
    rmSync(server.socketPath, { force: true });
  });

  it("cancels pending reconnects on session shutdown (no stale callbacks into later sessions)", async () => {
    const server = await startTestServer();
    const { testPi } = await startSession({ server, reporterOptions: { reconnectDelayMs: 50 } });
    await server.waitForFrame((f) => f.message.type === "hello");

    server.destroyClients();
    await sleep(20); // close processed; reconnect timer now pending
    const framesBeforeShutdown = server.frames.length;
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    await sleep(150); // past the reconnect delay

    assert.equal(server.connections, 1, "no reconnect after shutdown");
    assert.equal(server.frames.length, framesBeforeShutdown, "no stale frames after shutdown");
  });

  it("keeps /reload sticky: same instance identity and monotonically increasing sequence", async () => {
    const server = await startTestServer();
    const bootstrap = makeBootstrap(server.socketPath);
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);

    const first = createPi();
    await activate(first.pi, { reconnectDelayMs: 20 });
    const ctx1 = makeCtx(makeUi().ui, "tui", () => true);
    await first.trigger("session_start", { type: "session_start" }, ctx1);
    await server.waitForFrame((f) => f.message.type === "status");
    const sequenceBeforeReload = lastStatusSequence(server);
    assert.ok(sequenceBeforeReload >= 1);

    // Simulate /reload: same process, env already consumed.
    const second = createPi();
    await activate(second.pi, { reconnectDelayMs: 20 });
    assert.ok(second.hooks.size > 0, "reloaded incarnation registers from sticky state");

    const ctx2 = makeCtx(makeUi().ui, "tui", () => true);
    await second.trigger("session_start", { type: "session_start", reason: "reload" }, ctx2);
    // The reloaded incarnation reconnects asynchronously; wait for its hello.
    await server.waitForFrame(
      (f) => f.message.type === "hello" && server.frames.filter((g) => g.message.type === "hello").length >= 2,
    );
    assert.equal(server.frames.filter((f) => f.message.type === "hello").length, 2, "reloaded incarnation re-authenticates");
    const status = await server.waitForFrame(
      (f) => f.message.type === "status" && (f.message.sequence as number) > sequenceBeforeReload,
    );
    assert.equal(status.message.instanceId, bootstrap.instanceId, "known instance identity preserved");
    assert.ok((status.message.sequence as number) > sequenceBeforeReload, "sequence continues across /reload");

    // A different instance in the environment is never attached to; the
    // known sticky instance stays authoritative.
    const third = createPi();
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(makeBootstrap(server.socketPath, { instanceId: randomUUID() }));
    await activate(third.pi);
    assert.ok(third.hooks.size > 0, "reloaded incarnation still attaches to the known instance");
    const sticky = (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY] as { bootstrap: { instanceId: string } };
    assert.equal(sticky.bootstrap.instanceId, bootstrap.instanceId, "foreign instance never attached");
    await second.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("never puts question text, titles, tool args, or the token into status frames", async () => {
    const server = await startTestServer();
    const ui = makeUi();
    const { testPi, ctx, bootstrap } = await startSession({ server, ui });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["Question: SECRET-TITLE what is the answer?"], { placement: "aboveEditor" });
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    await testPi.trigger("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "SECRET-ARG" } }, ctx);
    await server.waitForFrame((f) => f.message.type === "status" && (f.message.activity as string[])[0] === "bash");

    for (const frame of statusFrames(server)) {
      assert.ok(!frame.raw.includes("SECRET-TITLE"), "question text stays out of status frames");
      assert.ok(!frame.raw.includes("SECRET-ARG"), "tool args stay out of status frames");
      assert.ok(!frame.raw.includes(bootstrap.token as string), "token only ever appears in hello");
    }
    const hello = server.frames.find((f) => f.message.type === "hello")!;
    assert.ok(hello.raw.includes(bootstrap.token as string));
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("survives foreign decorators: retained wrappers keep forwarding after shutdown and reinstall", async () => {
    const server = await startTestServer();
    const ui = makeUi();
    const { testPi, ctx } = await startSession({ server, ui });
    const key = "review-gate-pending-questions";

    const reporterWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;
    assert.notEqual(reporterWrapper, ui.original);

    // A foreign decorator installs after the reporter, wrapping our wrapper.
    const inner = ctx.ui.setWidget as (...args: unknown[]) => unknown;
    let foreignCalls = 0;
    const foreignWrapper = function (this: unknown, ...args: unknown[]): unknown {
      foreignCalls += 1;
      return inner.apply(this, args);
    };
    ctx.ui.setWidget = foreignWrapper;

    // Calls reach native through the chain and are observed.
    setWidget(ctx, key, ["q1"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    assert.equal(ui.calls.length, 1, "native setWidget reached through the foreign decorator");

    // Shutdown leaves the foreign decorator installed; retained wrappers keep forwarding.
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    assert.equal(ctx.ui.setWidget, foreignWrapper, "foreign decorator left installed");
    const afterShutdown = setWidget(ctx, key, ["q2"]);
    assert.equal(afterShutdown, "widget-result", "calls after shutdown still reach native setWidget");
    assert.equal(ui.calls.length, 2, "native received the post-shutdown call");

    // Reinstall wraps the foreign decorator with a fresh wrapper; no recursion.
    await testPi.trigger("session_start", { type: "session_start", reason: "restart" }, ctx);
    const reinstalled = ctx.ui.setWidget as (...args: unknown[]) => unknown;
    assert.notEqual(reinstalled, reporterWrapper, "fresh wrapper per installation");
    assert.notEqual(reinstalled, foreignWrapper);

    const beforeQ3 = server.frames.length - 1;
    setWidget(ctx, key, ["q3"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true, 3_000, beforeQ3);
    assert.equal(foreignCalls, 3, "each call traverses the chain exactly once (no recursion)");
    assert.equal(ui.calls.length, 3);

    // A saved stale wrapper still forwards to native but does not observe.
    const staleSequence = lastStatusSequence(server);
    const staleResult = reporterWrapper.call(ui, key, ["q4"]);
    assert.equal(staleResult, "widget-result", "stale wrapper still forwards to native");
    assert.equal(ui.calls.length, 4);
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper does not observe the later session");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("bounds backpressure: retains only the latest snapshot while the host stops reading", async () => {
    serverCounter += 1;
    const socketPath = join(tmpdir(), `sh-${process.pid}-${serverCounter}.sock`);
    let client: net.Socket | undefined;
    const rawServer = net.createServer((c) => {
      client = c; // Accept but never read until released below.
    });
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(socketPath, resolve);
    });
    servers.push({
      socketPath,
      frames: [],
      connections: 0,
      waitForFrame: async () => {
        throw new Error("unused");
      },
      destroyClients() {
        client?.destroy();
      },
      close: async () => {
        client?.destroy();
        await new Promise<void>((resolve) => rawServer.close(() => resolve()));
        rmSync(socketPath, { force: true });
      },
    } as unknown as TestServer);

    let reporterSocket: net.Socket | undefined;
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(makeBootstrap(socketPath));
    const testPi = createPi();
    await activate(testPi.pi, { onSocket: (s) => { reporterSocket = s; } });
    const ctx = makeCtx(makeUi().ui, "tui", () => true);
    await testPi.trigger("session_start", { type: "session_start" }, ctx);
    assert.ok(reporterSocket, "test seam observed the connection");

    // Wait for the connection to actually establish before driving load.
    const connectDeadline = Date.now() + 3_000;
    while (!client || reporterSocket.connecting) {
      if (Date.now() > connectDeadline) throw new Error("connection did not establish");
      await sleep(5);
    }
    assert.ok(client, "server accepted the connection");

    // The host stops reading: drive far more state changes than any buffer holds.
    const changes = 8_000;
    for (let i = 0; i < changes; i += 1) {
      await testPi.trigger("tool_execution_start", { toolCallId: `c${i}`, toolName: `tool-${i}` }, ctx);
    }
    assert.ok(
      reporterSocket.writableLength < 512_000,
      `pending writes stay bounded while backpressured (got ${reporterSocket.writableLength})`,
    );

    // Release the reader: the retained latest snapshot flushes on drain.
    const received: Array<Record<string, unknown>> = [];
    let buffer = "";
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index + 1);
        buffer = buffer.slice(index + 1);
        try {
          received.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Ignore partial/malformed.
        }
      }
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const last = received.at(-1);
      if (last && last.type === "status" && (last.activity as string[])[0] === `tool-${changes - 1}`) break;
      await sleep(5);
    }
    const last = received.at(-1)!;
    assert.equal((last.activity as string[])[0], `tool-${changes - 1}`, "latest snapshot delivered after drain");
    const statusCount = received.filter((f) => f.type === "status").length;
    assert.ok(statusCount < changes, `not every intermediate snapshot was queued (got ${statusCount})`);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("probes live readiness at session_start instead of assuming Ready", async () => {
    // Starts mid-run: a valid false probe establishes busy.
    const server = await startTestServer();
    const { testPi, bootstrap } = await startSession({ server, isIdle: () => false });
    const busyStart = await server.waitForFrame((f) => f.message.type === "status");
    assert.equal(busyStart.message.busy, true, "non-idle session start reports busy");
    assert.deepEqual(busyStart.message.activity, ["Working"]);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });

    // Missing probe: unknown (null), never fabricated idle. Fresh process
    // state (no sticky): the env bootstrap is the only source and is accepted.
    const server2 = await startTestServer();
    delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY];
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify({ ...bootstrap, socketPath: server2.socketPath });
    const pi2 = createPi();
    await activate(pi2.pi);
    const noProbeCtx = { mode: "tui", ui: makeUi().ui, sessionManager: { getSessionId: () => randomUUID() } };
    await pi2.trigger("session_start", { type: "session_start" }, noProbeCtx);
    const unknownStart = await server2.waitForFrame((f) => f.message.type === "status");
    assert.equal(unknownStart.message.busy, null, "missing probe is unknown, not idle");
    assert.deepEqual(unknownStart.message.activity, []);
    await pi2.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("settled: a false probe establishes busy; throwing or missing probes never establish idle", async () => {
    const server = await startTestServer();
    let idle = true;
    const { testPi, ctx } = await startSession({ server, isIdle: () => idle });
    await server.waitForFrame((f) => f.message.type === "status"); // initial Ready (idle)

    // Idle -> settled with a valid false probe: establishes busy.
    idle = false;
    await testPi.trigger("agent_settled", { type: "agent_settled" }, ctx);
    const busySettle = await server.waitForFrame((f) => f.message.type === "status" && f.message.busy === true);
    assert.deepEqual(busySettle.message.activity, ["Working"]);

    // Throwing probe: retains the prior (busy) state.
    const throwingCtx = { ...ctx, isIdle: () => { throw new Error("stale"); } };
    await testPi.trigger("agent_settled", { type: "agent_settled" }, throwingCtx);
    await sleep(30);
    assert.equal(statusFrames(server).at(-1)!.message.busy, true, "throwing probe must not establish idle");

    // Missing probe: also retains.
    const noProbeCtx = { mode: ctx.mode, ui: ctx.ui, sessionManager: ctx.sessionManager };
    await testPi.trigger("agent_settled", { type: "agent_settled" }, noProbeCtx);
    await sleep(30);
    assert.equal(statusFrames(server).at(-1)!.message.busy, true, "missing probe must not establish idle");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("keeps the reconnect budget across accept-then-close connections", async () => {
    serverCounter += 1;
    const socketPath = join(tmpdir(), `sh-${process.pid}-${serverCounter}.sock`);
    let connections = 0;
    const broker = net.createServer((client) => {
      connections += 1;
      client.destroy(); // accept then immediately reject
    });
    await new Promise<void>((resolve, reject) => {
      broker.once("error", reject);
      broker.listen(socketPath, resolve);
    });

    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(makeBootstrap(socketPath));
    const testPi = createPi();
    await activate(testPi.pi, { reconnectDelayMs: 10, maxReconnectAttempts: 3 });
    const ctx = makeCtx(makeUi().ui, "tui", () => true);
    await testPi.trigger("session_start", { type: "session_start" }, ctx);

    await sleep(300); // well past initial + 3 attempts x 10ms
    assert.equal(connections, 4, "bounded attempts; an accept-then-close broker must not mint fresh budgets");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
    await sleep(50);
    assert.equal(connections, 4, "shutdown leaves no further attempts");
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    rmSync(socketPath, { force: true });
  });

  it("refreshes observation on consecutive session starts sharing one UI", async () => {
    const server = await startTestServer();
    const uiObj = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiObj });
    const key = "review-gate-pending-questions";
    const firstWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // Consecutive session_start without an intervening shutdown.
    await testPi.trigger("session_start", { type: "session_start", reason: "restart" }, ctx);
    const secondWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;
    assert.notEqual(secondWrapper, firstWrapper, "each session installs a fresh observation wrapper");

    // The new session observes through the fresh wrapper.
    const beforeSet = server.frames.length - 1;
    setWidget(ctx, key, ["q-new"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true, 3_000, beforeSet);

    // A saved wrapper from the previous session still forwards but emits nothing.
    const staleSequence = lastStatusSequence(server);
    const result = firstWrapper.call(uiObj.ui, key, ["q-stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper emits nothing into the new session");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("re-probes on a real compaction event: fresh UI starts unknown, stale wrapper only forwards", async () => {
    const server = await startTestServer();
    const uiOld = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiOld });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const staleWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // Real public event: compaction succeeded and the host hands out a fresh UI object.
    const uiNew = makeUi();
    const newCtx = makeCtx(uiNew.ui, "tui", () => true);
    const beforeReprobe = server.frames.length - 1;
    await testPi.trigger(
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false },
      newCtx,
    );

    // The fresh surface starts unknown; the old confirmed presence is dropped.
    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeReprobe,
    );

    // The retained old wrapper still forwards to its native but cannot update status.
    const staleSequence = lastStatusSequence(server);
    const result = staleWrapper.call(uiOld.ui, key, ["stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper cannot update the current status");

    // The new UI observes real set/clear.
    const beforeSet = server.frames.length - 1;
    setWidget(newCtx, key, ["new question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true, 3_000, beforeSet);
    const beforeClear = server.frames.length - 1;
    setWidget(newCtx, key, undefined);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === false, 3_000, beforeClear);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("disables the prior observer when a replacement UI lacks setWidget", async () => {
    const server = await startTestServer();
    const uiOld = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiOld });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const staleWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // Real public event with a replacement UI that has no setWidget at all.
    const bareUi: Record<string, unknown> = {};
    const newCtx = makeCtx(bareUi, "tui", () => true);
    const beforeReprobe = server.frames.length - 1;
    await testPi.trigger(
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false },
      newCtx,
    );

    // Observation unavailable: unknown published.
    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeReprobe,
    );

    // The retained old wrapper still forwards to its native but observes nothing.
    const staleSequence = lastStatusSequence(server);
    const result = staleWrapper.call(uiOld.ui, key, ["stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper cannot update the current status");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("handles a throwing setWidget getter on a replacement UI without stale observation", async () => {
    const server = await startTestServer();
    const uiOld = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiOld });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const staleWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // Replacement UI whose setWidget property has a throwing getter.
    const hostileUi: Record<string, unknown> = {};
    Object.defineProperty(hostileUi, "setWidget", {
      get() {
        throw new Error("hostile getter");
      },
      configurable: true,
    });
    const newCtx = makeCtx(hostileUi, "tui", () => true);
    const beforeReprobe = server.frames.length - 1;
    await testPi.trigger(
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false },
      newCtx,
    );

    // Observation unavailable: unknown published; the hook completed without a native exception.
    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeReprobe,
    );

    // The retained old wrapper still forwards to its native but observes nothing.
    const staleSequence = lastStatusSequence(server);
    const result = staleWrapper.call(uiOld.ui, key, ["stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper cannot update the current status");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("restores observation ownership when the old UI's setWidget getter throws", async () => {
    const server = await startTestServer();
    const uiOld = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiOld });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const staleWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // A foreign decorator replaces the observed property with a throwing getter.
    Object.defineProperty(uiOld.ui, "setWidget", {
      get() {
        throw new Error("hostile getter");
      },
      configurable: true,
    });

    // Re-probe on a fresh healthy UI: restoreObserver must survive the hostile getter.
    const uiNew = makeUi();
    const newCtx = makeCtx(uiNew.ui, "tui", () => true);
    const beforeReprobe = server.frames.length - 1;
    await testPi.trigger(
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false },
      newCtx,
    );

    // Fresh surface installed and unknown published despite the hostile old getter.
    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeReprobe,
    );
    assert.notEqual(newCtx.ui.setWidget, uiNew.original, "fresh UI wrapped");

    // The retained old wrapper still forwards to its captured native but observes nothing.
    const staleSequence = lastStatusSequence(server);
    const result = staleWrapper.call(uiOld.ui, key, ["stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper cannot update the current status");

    // Shutdown also survives the hostile getter (restoreObserver runs again).
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("re-probes unknown when the replacement context's ui getter throws", async () => {
    const server = await startTestServer();
    const uiOld = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiOld });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const staleWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // Replacement context whose ui getter throws.
    const hostileCtx: Record<string, unknown> = { mode: "tui", isIdle: () => true };
    Object.defineProperty(hostileCtx, "ui", {
      get() {
        throw new Error("hostile getter");
      },
      configurable: true,
    });
    const beforeReprobe = server.frames.length - 1;
    await testPi.trigger(
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false },
      hostileCtx,
    );

    // Observation unavailable: unknown published; the hook completed without a native exception.
    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeReprobe,
    );

    // The retained old wrapper still forwards to its native but observes nothing.
    const staleSequence = lastStatusSequence(server);
    const result = staleWrapper.call(uiOld.ui, key, ["stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper cannot update the current status");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("re-probes unknown when the replacement context has a null UI", async () => {
    const server = await startTestServer();
    const uiOld = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiOld });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const staleWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // Replacement context with a null UI.
    const nullUiCtx: Record<string, unknown> = { mode: "tui", ui: null, isIdle: () => true };
    const beforeReprobe = server.frames.length - 1;
    await testPi.trigger(
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false },
      nullUiCtx,
    );

    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeReprobe,
    );

    const staleSequence = lastStatusSequence(server);
    const result = staleWrapper.call(uiOld.ui, key, ["stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper cannot update the current status");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("deactivates on session_start when the context's ui getter throws", async () => {
    const server = await startTestServer();
    const { testPi, ctx } = await startSession({ server });
    await server.waitForFrame((f) => f.message.type === "status");

    // A replacement session whose context ui getter throws deactivates.
    const hostileCtx: Record<string, unknown> = {};
    Object.defineProperty(hostileCtx, "ui", {
      get() {
        throw new Error("hostile getter");
      },
      configurable: true,
    });
    await testPi.trigger("session_start", { type: "session_start", reason: "replace" }, hostileCtx);

    const framesAfter = server.frames.length;
    await testPi.trigger("agent_start", { type: "agent_start" }, ctx);
    await sleep(30);
    assert.equal(server.frames.length, framesAfter, "deactivated reporter emits nothing");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("settles to unknown readiness when the context's ui getter throws", async () => {
    const server = await startTestServer();
    const { testPi } = await startSession({ server }); // isIdle () => true -> initial Ready
    await server.waitForFrame((f) => f.message.type === "status");

    const hostileCtx: Record<string, unknown> = {};
    Object.defineProperty(hostileCtx, "ui", {
      get() {
        throw new Error("hostile getter");
      },
      configurable: true,
    });
    const beforeSettle = server.frames.length - 1;
    await testPi.trigger("agent_settled", { type: "agent_settled" }, hostileCtx);

    // Unknown readiness drops the Ready claim.
    const unknown = await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.busy === null,
      3_000, beforeSettle,
    );
    assert.deepEqual(unknown.message.activity, [], "no Ready activity after an unreadable context");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("drops confirmed pending when the same UI's setWidget is replaced by another callable", async () => {
    const server = await startTestServer();
    const uiOld = makeUi();
    const { testPi, ctx } = await startSession({ server, ui: uiOld });
    const key = "review-gate-pending-questions";

    setWidget(ctx, key, ["question"]);
    await server.waitForFrame((f) => f.message.type === "status" && f.message.pendingInput === true);
    const staleWrapper = ctx.ui.setWidget as (...args: unknown[]) => unknown;

    // The same UI object's property is replaced by the original native function.
    uiOld.ui.setWidget = uiOld.original;
    const beforeReprobe = server.frames.length - 1;
    await testPi.trigger(
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false },
      ctx,
    );

    // The confirmed state is no longer verifiable: unknown published.
    await server.waitForFrame(
      (f) => f.message.type === "status" && f.message.pendingInput === null,
      3_000, beforeReprobe,
    );

    // The saved old wrapper still forwards native calls/return/receiver...
    const staleSequence = lastStatusSequence(server);
    const result = staleWrapper.call(uiOld.ui, key, ["stale"]);
    assert.equal(result, "widget-result", "stale wrapper keeps forwarding to native");
    await sleep(30);
    // ...but cannot change the latest pending snapshot.
    assert.equal(lastStatusSequence(server), staleSequence, "stale wrapper cannot update the current status");

    // The foreign property is unchanged (still the original native function).
    assert.equal(uiOld.ui.setWidget, uiOld.original, "foreign property untouched");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("treats an ignored setWidget assignment as observation unavailable", async () => {
    const server = await startTestServer();
    const uiHostile = makeUi();
    const stored: unknown = uiHostile.original;
    Object.defineProperty(uiHostile.ui, "setWidget", {
      get() {
        return stored;
      },
      set() {
        // Hostile setter: ignores the assignment.
      },
      configurable: true,
    });
    const { testPi } = await startSession({ server, ui: uiHostile });

    // Install unverifiable: pending stays unknown, native forwarding intact.
    const status = await server.waitForFrame((f) => f.message.type === "status");
    assert.equal(status.message.pendingInput, null, "unverifiable install is unknown");
    const result = (uiHostile.ui.setWidget as (...args: unknown[]) => unknown)("review-gate-pending-questions", ["q"]);
    assert.equal(result, "widget-result", "native setWidget still callable");
    await sleep(30);
    assert.equal(statusFrames(server).length, 1, "no observation frames from an uninstalled wrapper");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("does not retransmit an accepted-but-backpressured status on drain", async () => {
    const server = await startTestServer();
    let reporterSocket: net.Socket | undefined;
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(makeBootstrap(server.socketPath));
    const testPi = createPi();
    await activate(testPi.pi, { onSocket: (s) => { reporterSocket = s; } });
    const ctx = makeCtx(makeUi().ui, "tui", () => true);
    await testPi.trigger("session_start", { type: "session_start" }, ctx);
    assert.ok(reporterSocket, "test seam observed the connection");
    await server.waitForFrame((f) => f.message.type === "status"); // connected; initial Ready delivered

    // Simulate Node's backpressure contract: the next write is accepted into
    // the buffer but reports false; drain follows once the host reads.
    const socketLike = reporterSocket as unknown as {
      write: (chunk: string, ...rest: unknown[]) => boolean;
    };
    const originalWrite = socketLike.write.bind(socketLike);
    let simulateBackpressure = false;
    socketLike.write = (chunk: string, ...rest: unknown[]) => {
      const accepted = originalWrite(chunk, ...rest);
      return simulateBackpressure ? false : accepted;
    };

    // One status change: the write is accepted but reports backpressure.
    simulateBackpressure = true;
    await testPi.trigger("agent_start", { type: "agent_start" }, ctx);

    // No further state changes. Drain follows (the host starts reading).
    reporterSocket.emit("drain");
    await sleep(50); // Let any (incorrect) retransmission surface.
    const sequences = statusFrames(server).map((f) => f.message.sequence as number);
    assert.ok(sequences.length >= 2, "initial and busy statuses delivered");
    assert.equal(new Set(sequences).size, sequences.length, "no sequence is retransmitted on drain");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("settled: an unavailable probe after Ready publishes unknown, not idle", async () => {
    const server = await startTestServer();
    const { testPi, ctx } = await startSession({ server }); // isIdle () => true -> initial Ready
    await server.waitForFrame((f) => f.message.type === "status");

    // Throwing probe directly after the initial Ready snapshot.
    const throwingCtx = { ...ctx, isIdle: () => { throw new Error("stale"); } };
    await testPi.trigger("agent_settled", { type: "agent_settled" }, throwingCtx);
    const unknown = await server.waitForFrame((f) => f.message.type === "status" && f.message.busy === null);
    assert.deepEqual(unknown.message.activity, [], "no Ready activity once readiness is unavailable");

    // Missing probe: same; state stays unknown (deduped, no new frame).
    const noProbeCtx = { mode: ctx.mode, ui: ctx.ui, sessionManager: ctx.sessionManager };
    await testPi.trigger("agent_settled", { type: "agent_settled" }, noProbeCtx);
    await sleep(30);
    const last = statusFrames(server).at(-1)!;
    assert.equal(last.message.busy, null, "unknown readiness is published, idle claim dropped");
    assert.deepEqual(last.message.activity, []);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });
});

// ----------------------------------------------------------------------
// Bootstrap preload (NODE_OPTIONS restore + pre-main priming)
// ----------------------------------------------------------------------

const PRELOAD_PATH = join(__dirname, "../src/session-host/bootstrap-preload.js");
const REPORTER_PATH = join(__dirname, "../src/session-host/reporter.js");

describe("session-host bootstrap preload", () => {
  function withNodeOptions<T>(value: string | undefined, fn: () => T): T {
    const previous = process.env.NODE_OPTIONS;
    if (value === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
      delete process.env[NODE_OPTIONS_RESTORE_ENV];
    }
  }

  it("restoreNodeOptions restores the original exactly and consumes the frame", () => {
    withNodeOptions(`--require=${PRELOAD_PATH} --max-old-space-size=100`, () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: "--max-old-space-size=100" });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=100");
      assert.equal(process.env[NODE_OPTIONS_RESTORE_ENV], undefined, "one-shot frame consumed");
    });
  });

  it("restoreNodeOptions deletes NODE_OPTIONS for a null original", () => {
    withNodeOptions(`--require=${PRELOAD_PATH}`, () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: null });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, undefined);
    });
  });

  it("restoreNodeOptions strips only its own flag on an invalid frame (no content dump)", () => {
    withNodeOptions(`--require=${PRELOAD_PATH} --other=1`, () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = "not-json";
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, "--other=1");

      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: 42 });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, "--other=1", "wrong shape fails closed the same way");
      assert.equal(process.env[NODE_OPTIONS_RESTORE_ENV], undefined);
    });
  });

  it("restoreNodeOptions is inert without a frame", () => {
    withNodeOptions("--unchanged=1", () => {
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, "--unchanged=1");
    });
  });

  it("restoreNodeOptions strips a quoted self flag and preserves spaced options verbatim", () => {
    withNodeOptions(`--require="${PRELOAD_PATH}" --require="/tmp/a b.js" --other=1`, () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = "malformed";
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, `--require="/tmp/a b.js" --other=1`);
    });
  });

  it("restoreNodeOptions restores a spaced original verbatim", () => {
    withNodeOptions(`--require=${PRELOAD_PATH}`, () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: `--require="/tmp/a b.js"` });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, `--require="/tmp/a b.js"`);
    });
  });

  it("restoreNodeOptions bounds the original in UTF-8 bytes, not UTF-16 length", () => {
    withNodeOptions(`--require="${PRELOAD_PATH}" --other=1`, () => {
      // 5000 code units but 10000 UTF-8 bytes: over the 8KiB launch limit.
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: "é".repeat(5_000) });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, "--other=1", "oversized multibyte original fails closed");

      // 4000 code units / 8000 UTF-8 bytes: under the limit, restored verbatim.
      const small = "é".repeat(4_000);
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: small });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, small);
    });
  });

  it("primeReporterBootstrap consumes the env and primes sticky state", () => {
    const bootstrap = makeBootstrap("/tmp/sh-prime.sock");
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);
    const primed = primeReporterBootstrap();
    assert.equal(primed?.instanceId, bootstrap.instanceId);
    assert.equal(process.env[HOST_BOOTSTRAP_ENV], undefined, "env consumed");
    const sticky = (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY] as
      | { bootstrap: { instanceId: string }; sequence: number }
      | undefined;
    assert.equal(sticky?.bootstrap.instanceId, bootstrap.instanceId);
    assert.equal(sticky?.sequence, 0);
  });

  it("primeReporterBootstrap consumes an invalid env without priming", () => {
    process.env[HOST_BOOTSTRAP_ENV] = "not-json";
    assert.equal(primeReporterBootstrap(), undefined);
    assert.equal(process.env[HOST_BOOTSTRAP_ENV], undefined, "env still consumed");
    assert.equal((globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY], undefined);
  });

  it("primeReporterBootstrap ignores a reappearing env with any changed identity field", () => {
    const bootstrap = makeBootstrap("/tmp/sh-prime.sock");
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);
    primeReporterBootstrap();

    // Same instanceId, changed generation/token/socket: consumed and ignored.
    const changed = {
      ...bootstrap,
      generation: randomUUID(),
      token: randomBytes(32).toString("hex"),
      socketPath: "/tmp/sh-other.sock",
    };
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(changed);
    assert.equal(primeReporterBootstrap(), undefined, "changed identity is never attached");
    assert.equal(process.env[HOST_BOOTSTRAP_ENV], undefined, "env still consumed");
    const sticky = (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY] as
      | { bootstrap: { instanceId: string; generation: string; token: string; socketPath: string }; sequence: number }
      | undefined;
    assert.equal(sticky?.bootstrap.socketPath, bootstrap.socketPath, "original capability retained");
    assert.equal(sticky?.bootstrap.token, bootstrap.token);
    assert.equal(sticky?.bootstrap.generation, bootstrap.generation);
    assert.equal(sticky?.sequence, 0);
  });

  it("primeReporterBootstrap bounds the raw env in UTF-8 bytes before parsing", () => {
    const bootstrap = makeBootstrap("/tmp/sh-prime.sock");
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify({ ...bootstrap, socketPath: `/x${"y".repeat(20_000)}.sock` });
    assert.equal(primeReporterBootstrap(), undefined, "oversized raw env is invalid");
    assert.equal(process.env[HOST_BOOTSTRAP_ENV], undefined, "env still consumed");
    assert.equal((globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY], undefined);
  });

  interface PreloadMarker {
    userFixture: { ran: boolean; nodeOptions: string | null };
    grandchild: { bootstrap: boolean; restore: boolean; nodeOptions: string | null };
  }

  // The ORIGINAL user --require fixture: records its own environment view and
  // spawns a Node descendant before main to prove no inheritance.
  // SH_TEST_GRANDCHILD guards re-entry: the descendant inherits the restored
  // NODE_OPTIONS (and thus reloads this fixture) but must not spawn again.
  const USER_FIXTURE_SOURCE = [
    'const { spawnSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'if (process.env.SH_TEST_GRANDCHILD !== "1") {',
    "  const grandchild = spawnSync(process.execPath, [\"-e\", \"process.stdout.write(JSON.stringify({ bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP !== undefined, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE !== undefined, nodeOptions: process.env.NODE_OPTIONS ?? null }))\"], { encoding: \"utf8\", env: { ...process.env, SH_TEST_GRANDCHILD: \"1\" } });",
    "  fs.writeFileSync(process.env.SH_TEST_MARKER, JSON.stringify({",
    "    userFixture: { ran: true, nodeOptions: process.env.NODE_OPTIONS ?? null },",
    "    grandchild: JSON.parse(grandchild.stdout),",
    "  }));",
    "}",
    "",
  ].join("\n");

  const CHILD_MAIN_SOURCE = [
    "const assert = require(\"node:assert/strict\");",
    "(async () => {",
    "  const reporter = require(process.env.SH_TEST_REPORTER);",
    "  assert.equal(process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined, \"bootstrap consumed pre-main\");",
    "  assert.equal(process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined, \"restore frame consumed pre-main\");",
    "  assert.equal(process.env.NODE_OPTIONS, process.env.SH_TEST_ORIGINAL_NODE_OPTIONS, \"original NODE_OPTIONS restored exactly\");",
    "  const sticky = globalThis[reporter.SESSION_HOST_STICKY_STATE_KEY];",
    "  assert.ok(sticky && sticky.bootstrap.instanceId === process.env.SH_TEST_INSTANCE_ID, \"sticky primed pre-main\");",
    "  const hooks = new Map();",
    "  const pi = { on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); } };",
    "  await reporter.activate(pi);",
    "  assert.ok(hooks.size > 0, \"default factory registers from primed sticky state\");",
    "  const ctx = { mode: \"tui\", ui: { setWidget() {} }, isIdle: () => true, sessionManager: { getSessionId: () => \"child\" } };",
    "  for (const h of hooks.get(\"session_start\") ?? []) await h({ type: \"session_start\" }, ctx);",
    "  await new Promise((r) => setTimeout(r, 300)); // let hello+status flush",
    "  for (const h of hooks.get(\"session_shutdown\") ?? []) await h({ type: \"session_shutdown\" });",
    "})().catch((e) => { console.error(e.message); process.exit(1); });",
    "",
  ].join("\n");

  async function runPreloadedChild(options: {
    bootstrap: Record<string, unknown>;
    restoreFrameFor: (userFixturePath: string) => string | undefined;
    nodeOptionsFor: (userFixturePath: string) => string;
    expectedNodeOptionsFor: (userFixturePath: string) => string;
    /** Optional parent directory for the fixture tree (e.g. one containing spaces). */
    fixturesRoot?: string;
    /** Reporter module the child main loads (defaults to the compiled package path). */
    reporterPath?: string;
  }): Promise<{ status: number | null; markerData: PreloadMarker; output: string }> {
    const ownsDir = options.fixturesRoot === undefined;
    const dir = ownsDir
      ? mkdtempSync(join(tmpdir(), "sh-preload-"))
      : join(options.fixturesRoot!, "fixtures");
    if (!ownsDir) mkdirSync(dir, { recursive: true });
    try {
      const userFixture = join(dir, "user-fixture.js");
      const childMain = join(dir, "child-main.js");
      const marker = join(dir, "marker.json");
      writeFileSync(userFixture, USER_FIXTURE_SOURCE);
      writeFileSync(childMain, CHILD_MAIN_SOURCE);

      const restoreFrame = options.restoreFrameFor(userFixture);
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.PI_REVIEW_GATE_RUNTIME_ROLE; // hermetic top-level surface
      childEnv.NODE_OPTIONS = options.nodeOptionsFor(userFixture);
      if (restoreFrame === undefined) delete childEnv[NODE_OPTIONS_RESTORE_ENV];
      else childEnv[NODE_OPTIONS_RESTORE_ENV] = restoreFrame;
      childEnv[HOST_BOOTSTRAP_ENV] = JSON.stringify(options.bootstrap);
      childEnv.SH_TEST_MARKER = marker;
      childEnv.SH_TEST_REPORTER = options.reporterPath ?? REPORTER_PATH;
      childEnv.SH_TEST_ORIGINAL_NODE_OPTIONS = options.expectedNodeOptionsFor(userFixture);
      childEnv.SH_TEST_INSTANCE_ID = options.bootstrap.instanceId as string;

      let output = "";
      const status = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [childMain], { env: childEnv });
        const watchdog = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`preloaded child timed out\n${output}`));
        }, 15_000);
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.on("error", (err) => {
          clearTimeout(watchdog);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(watchdog);
          resolve(code);
        });
      });
      const markerData = JSON.parse(readFileSync(marker, "utf8")) as PreloadMarker;
      return { status, markerData, output };
    } finally {
      if (ownsDir) rmSync(dir, { recursive: true, force: true });
    }
  }

  it("preloaded Node process restores env before user fixtures and reports via the default factory", async () => {
    const server = await startTestServer();
    const bootstrap = makeBootstrap(server.socketPath);
    const { status, markerData } = await runPreloadedChild({
      bootstrap,
      restoreFrameFor: (userFixture) => JSON.stringify({ original: `--require=${userFixture}` }),
      // Host contract: our --require is PREPENDED before the original options.
      nodeOptionsFor: (userFixture) => `--require=${PRELOAD_PATH} --require=${userFixture}`,
      expectedNodeOptionsFor: (userFixture) => `--require=${userFixture}`,
    });
    assert.equal(status, 0, "preloaded child exits cleanly (env hygiene + default factory assertions)");

    assert.equal(markerData.userFixture.ran, true, "original user fixture still executes");
    assert.ok(
      markerData.userFixture.nodeOptions !== null && !markerData.userFixture.nodeOptions.includes(PRELOAD_PATH),
      "prepended preload restores before the user fixture loads",
    );
    assert.equal(markerData.grandchild.bootstrap, false, "descendant never inherits the bootstrap secret");
    assert.equal(markerData.grandchild.restore, false, "descendant never inherits the restore frame");
    assert.equal(
      markerData.grandchild.nodeOptions,
      markerData.userFixture.nodeOptions,
      "descendant sees only the original NODE_OPTIONS (no extra preload)",
    );

    // The default factory reported authenticated production status.
    const hello = await server.waitForFrame((f) => f.message.type === "hello");
    assert.equal(hello.message.token, bootstrap.token);
    const statusFrame = await server.waitForFrame((f) => f.message.type === "status");
    assert.equal(statusFrame.message.instanceId, bootstrap.instanceId);
  });

  it("preloaded Node process strips a quoted self flag on a malformed restore frame", async () => {
    const server = await startTestServer();
    const bootstrap = makeBootstrap(server.socketPath);
    const { status, markerData } = await runPreloadedChild({
      bootstrap,
      restoreFrameFor: () => "malformed",
      nodeOptionsFor: (userFixture) => `--require="${PRELOAD_PATH}" --require="${userFixture}"`,
      expectedNodeOptionsFor: (userFixture) => `--require="${userFixture}"`,
    });
    assert.equal(status, 0, "preloaded child exits cleanly (quoted self flag stripped)");
    assert.ok(
      markerData.userFixture.nodeOptions !== null && !markerData.userFixture.nodeOptions.includes(PRELOAD_PATH),
      "quoted --require self flag removed from NODE_OPTIONS",
    );
    assert.equal(markerData.grandchild.bootstrap, false, "descendant never inherits the bootstrap secret");
    assert.equal(markerData.grandchild.restore, false, "descendant never inherits the restore frame");
    assert.equal(
      markerData.grandchild.nodeOptions,
      markerData.userFixture.nodeOptions,
      "descendant sees only the original NODE_OPTIONS (no extra preload)",
    );

    const hello = await server.waitForFrame((f) => f.message.type === "hello");
    assert.equal(hello.message.token, bootstrap.token);
  });

  it("preloaded Node process strips a spaced quoted self flag from a spaced compiled path", async () => {
    const server = await startTestServer();
    const bootstrap = makeBootstrap(server.socketPath);
    // Compiled output copied into a temporary tree whose paths contain spaces,
    // matching the authorized host's quoted-path launch form.
    const root = mkdtempSync(join(tmpdir(), "sh preload "));
    try {
      for (const [from, to] of [
        [join(__dirname, "../src/pi.js"), join(root, "src/pi.js")],
        [join(__dirname, "../src/session-host/protocol.js"), join(root, "src/session-host/protocol.js")],
        [join(__dirname, "../src/session-host/reporter.js"), join(root, "src/session-host/reporter.js")],
        [join(__dirname, "../src/session-host/bootstrap-preload.js"), join(root, "src/session-host/bootstrap-preload.js")],
      ]) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      const spacedPreload = join(root, "src/session-host/bootstrap-preload.js");
      assert.ok(spacedPreload.includes(" "), "fixture preload path contains spaces");

      // Malformed and oversized restoration frames must both fall back to the
      // quote-aware strip of the spaced self flag.
      for (const restoreFrame of ["malformed", JSON.stringify({ original: "é".repeat(5_000) })]) {
        const { status, markerData, output } = await runPreloadedChild({
          bootstrap,
          restoreFrameFor: () => restoreFrame,
          nodeOptionsFor: (userFixture) => `--require="${spacedPreload}" --require="${userFixture}"`,
          expectedNodeOptionsFor: (userFixture) => `--require="${userFixture}"`,
          fixturesRoot: root,
          reporterPath: join(root, "src/session-host/reporter.js"),
        });
        assert.equal(status, 0, `preloaded child exits cleanly (spaced self flag stripped)\n${output}`);
        assert.equal(
          markerData.userFixture.nodeOptions,
          `--require="${join(root, "fixtures/user-fixture.js")}"`,
          "user fixture receives exactly the original NODE_OPTIONS",
        );
        assert.ok(
          !markerData.userFixture.nodeOptions!.includes(spacedPreload),
          "spaced quoted self flag removed from NODE_OPTIONS",
        );
        assert.equal(markerData.grandchild.bootstrap, false, "descendant never inherits the bootstrap secret");
        assert.equal(markerData.grandchild.restore, false, "descendant never inherits the restore frame");
        assert.equal(
          markerData.grandchild.nodeOptions,
          markerData.userFixture.nodeOptions,
          "descendant sees only the original NODE_OPTIONS (no extra preload)",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      await server.close();
    }
  });
});
