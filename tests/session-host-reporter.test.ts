/**
 * Session-host status companion tests (issue #323).
 *
 * Exercises the REAL production extension entry point (src/session-host/
 * reporter.ts) and protocol (src/session-host/protocol.ts) against a bounded
 * local net server on a POSIX socket or Windows named pipe and a synthetic Pi
 * event emitter/UI object. No state algorithm is duplicated here: frames are
 * observed on the wire and asserted as received.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NODE_OPTIONS_RESTORE_ENV, restoreNodeOptions } from "../src/session-host/bootstrap-preload";
import activate, { __test as reporterTest, primeReporterBootstrap, SESSION_HOST_STICKY_STATE_KEY } from "../src/session-host/reporter";
import { getSessionHostSpawnCapability, SESSION_HOST_SPAWN_CAPABILITY_KEY } from "../src/session-host/spawn-capability";
import {
  SESSION_HOST_STARTUP_REQUEST_ENV,
  SESSION_HOST_TITLE_COLUMNS_ENV,
  __test as startupRequestTest,
} from "../src/session-host/startup-request";
import {
  HOST_BOOTSTRAP_ENV,
  MAX_STATUS_FRAME_BYTES,
  MAX_NATIVE_SESSION_NAME_LENGTH,
  MAX_RENAME_NAME_BYTES,
  type SessionSpawnInput,
  decodeFrame,
  encodeFrame,
  parseBootstrap,
  parseRenameAck,
  parseRenameRequest,
  parseShutdownAck,
  parseShutdownRequest,
  parseStatus,
  sanitizeActivityLine,
  stripTerminalControls,
  type SessionHostMessage,
  type SessionHostStatus,
} from "../src/session-host/protocol";

// Keep POSIX integration socket files inside the isolated worker root while
// using relative addresses that fit macOS's bounded sun_path field.
function rootRelativeSocketAddress(address: string): string {
  if (address.startsWith("\\\\.\\pipe\\")) return address;
  const rooted = relative(process.cwd(), address);
  if (isAbsolute(address) && rooted && rooted !== ".." && !rooted.startsWith(`..${sep}`)
    && Buffer.byteLength(address, "utf8") > 100) return `./${rooted}`;
  return address;
}

function rootRelativeSocketArgument(value: unknown): unknown {
  if (typeof value === "string") return rootRelativeSocketAddress(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const options = value as Record<string, unknown>;
    if (typeof options.path === "string") return { ...options, path: rootRelativeSocketAddress(options.path) };
  }
  return value;
}

function rootRelativeSocketConnectArgument(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 0) {
    value[0] = rootRelativeSocketArgument(value[0]);
    return value;
  }
  if (typeof value === "string") return { path: rootRelativeSocketAddress(value) };
  return rootRelativeSocketArgument(value);
}

const originalServerListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
  args[0] = rootRelativeSocketArgument(args[0]);
  return Reflect.apply(originalServerListen, this, args) as net.Server;
} as typeof net.Server.prototype.listen;

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  args[0] = rootRelativeSocketConnectArgument(args[0]);
  return Reflect.apply(originalSocketConnect, this, args) as net.Socket;
} as typeof net.Socket.prototype.connect;

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
  abort?: () => void;
  shutdown?: () => void;
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
  // Keep POSIX paths well under the unix socket sun_path limit (~104 chars on
  // macOS); Windows test servers use a real public-Node named pipe.
  serverCounter += 1;
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\prg-st-${randomBytes(16).toString("hex")}`
    : join(tmpdir(), `sh-${process.pid}-${serverCounter}.sock`);
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
      if (process.platform !== "win32") rmSync(socketPath, { force: true });
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

/** Validator-admitted address for memory sockets; never opened as a real pipe. */
function makeMemorySocketAddress(): string {
  return `\\\\.\\pipe\\prg-st-${randomBytes(16).toString("hex")}`;
}

function makeShutdownRequest(
  bootstrap: Record<string, unknown>,
  expectedSessionId: string,
  expectedSessionEpoch: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    type: "shutdown_request",
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    token: bootstrap.token,
    requestId: randomUUID(),
    expectedSessionId,
    expectedSessionEpoch,
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
let previousStartupRequestEnv: string | undefined;
let previousTitleColumnsEnv: string | undefined;
const servers: TestServer[] = [];

beforeEach(() => {
  previousBootstrapEnv = process.env[HOST_BOOTSTRAP_ENV];
  previousStartupRequestEnv = process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  previousTitleColumnsEnv = process.env[SESSION_HOST_TITLE_COLUMNS_ENV];
  delete process.env[HOST_BOOTSTRAP_ENV];
  delete process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  delete process.env[SESSION_HOST_TITLE_COLUMNS_ENV];
  // Hermetic top-level surface: an inherited executor role (orchestrated
  // workers set it) would divert activate() to its no-op guard.
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_SPAWN_CAPABILITY_KEY];
  startupRequestTest.clearProcessMetadata();
});

afterEach(async () => {
  if (previousBootstrapEnv === undefined) delete process.env[HOST_BOOTSTRAP_ENV];
  else process.env[HOST_BOOTSTRAP_ENV] = previousBootstrapEnv;
  if (previousStartupRequestEnv === undefined) delete process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  else process.env[SESSION_HOST_STARTUP_REQUEST_ENV] = previousStartupRequestEnv;
  if (previousTitleColumnsEnv === undefined) delete process.env[SESSION_HOST_TITLE_COLUMNS_ENV];
  else process.env[SESSION_HOST_TITLE_COLUMNS_ENV] = previousTitleColumnsEnv;
  if (previousRuntimeRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRuntimeRole;
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_SPAWN_CAPABILITY_KEY];
  startupRequestTest.clearProcessMetadata();
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

    const localPipe = `\\\\.\\pipe\\prg-st-${"a".repeat(32)}`;
    assert.ok(parseBootstrap({ ...bootstrap, socketPath: localPipe }), "generated local Windows pipe namespace is admitted cross-platform");
    for (const socketPath of [
      `\\\\server\\pipe\\prg-st-${"a".repeat(32)}`,
      `\\\\?\\pipe\\prg-st-${"a".repeat(32)}`,
      `\\\\.\\pipe\\other-${"a".repeat(32)}`,
      `\\\\.\\pipe\\prg-st-..${"a".repeat(30)}`,
      `\\\\.\\pipe\\prg-st-${"A".repeat(32)}`,
      `${localPipe}\n`,
      "/tmp/../socket.sock",
      "//tmp/socket.sock",
      "/tmp/socket.sock/",
      "/",
    ]) {
      assert.equal(parseBootstrap({ ...bootstrap, socketPath }), undefined, `rejected noncanonical IPC address: ${socketPath}`);
    }

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

  it("strictly validates graceful shutdown requests and request-only acknowledgements", () => {
    const request = {
      version: 1,
      type: "shutdown_request",
      instanceId: randomUUID(),
      generation: randomUUID(),
      token: "a".repeat(64),
      requestId: randomUUID(),
      expectedSessionId: "native-session",
      expectedSessionEpoch: 8,
    };
    assert.deepEqual(parseShutdownRequest(request), request);
    assert.deepEqual(decodeFrame(encodeFrame(request as never)), request);
    assert.equal(parseShutdownRequest({ ...request, token: "wrong" }), undefined);
    assert.equal(parseShutdownRequest({ ...request, expectedSessionEpoch: 0 }), undefined);
    assert.equal(parseShutdownRequest({ ...request, expectedSessionId: "../sibling" }), undefined);

    const ack = {
      version: 1,
      type: "shutdown_result",
      instanceId: request.instanceId,
      generation: request.generation,
      requestId: request.requestId,
      expectedSessionId: request.expectedSessionId,
      expectedSessionEpoch: request.expectedSessionEpoch,
      outcome: "requested",
      reason: "none",
    };
    assert.deepEqual(parseShutdownAck(ack), ack);
    assert.deepEqual(decodeFrame(encodeFrame(ack as never)), ack);
    assert.equal(parseShutdownAck({ ...ack, reason: "already-requested" }), undefined);
    assert.equal(parseShutdownAck({ ...ack, outcome: "rejected", reason: "none" }), undefined);
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
    assert.equal(getSessionHostSpawnCapability(), undefined, "standalone runs have no SessionSpawn capability");
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
    assert.equal(getSessionHostSpawnCapability(), undefined, "executor processes never publish SessionSpawn authority");
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
    startupRequest?: { readonly title: string; readonly prompt: string };
    titleColumns?: number;
    onStartupApi?: {
      setSessionName(name: string): void;
      sendUserMessage(message: string, options?: { expandPromptTemplates?: boolean }): void;
    };
    reporterOptions?: {
      reconnectDelayMs?: number;
      maxReconnectAttempts?: number;
      spawnTimeoutMs?: number;
      connectSocket?: (socketPath: string) => net.Socket;
      onSocket?: (socket: net.Socket) => void;
    };
  }): Promise<{ testPi: TestPi; ctx: TestCtx; bootstrap: Record<string, unknown> }> {
    const bootstrap = options.bootstrap ?? makeBootstrap(options.server.socketPath);
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);
    process.env[SESSION_HOST_TITLE_COLUMNS_ENV] = String(options.titleColumns ?? 32);
    if (options.startupRequest !== undefined) {
      process.env[SESSION_HOST_STARTUP_REQUEST_ENV] = JSON.stringify(options.startupRequest);
    }
    const testPi = createPi();
    if (options.onStartupApi) {
      Object.assign(testPi.pi as object, options.onStartupApi);
    }
    await activate(testPi.pi, options.reporterOptions);
    const ui = options.ui ?? makeUi();
    const ctx = makeCtx(ui.ui, options.mode ?? "tui", options.isIdle ?? (() => true));
    if (options.sessionManager) ctx.sessionManager = options.sessionManager;
    await testPi.trigger("session_start", { type: "session_start", reason: "startup" }, ctx);
    return { testPi, ctx, bootstrap };
  }

  it("publishes an authenticated, exact-once SessionSpawn capability only for a hosted TUI child", async () => {
    const server = await startTestServer();
    const { testPi, bootstrap } = await startSession({ server });
    const capability = getSessionHostSpawnCapability();
    assert.ok(capability, "valid reporter bootstrap publishes the process-local tool capability");
    assert.equal(capability.titleColumns, 32, "the capability carries host-issued title-space metadata, not an auth token");
    await server.waitForFrame((frame) => frame.message.type === "hello");
    const input: SessionSpawnInput = {
      workspace: "/existing exact workspace",
      title: "A title beyond the sidebar recommendation ".repeat(7),
      prompt: "--session is prompt content, not a native option\nPreserve this exactly.\n",
    };
    const pending = capability.spawn(input);
    const request = await server.waitForFrame((frame) => frame.message.type === "spawn_request");
    assert.equal(request.message.instanceId, bootstrap.instanceId);
    assert.equal(request.message.generation, bootstrap.generation);
    assert.equal(request.message.token, bootstrap.token, "only the authenticated local protocol carries the capability token");
    assert.equal(request.message.workspace, input.workspace);
    assert.equal(request.message.title, input.title);
    assert.equal(request.message.prompt, input.prompt);
    assert.equal(server.frames.filter((frame) => frame.message.type === "spawn_request").length, 1);
    assert.equal(statusFrames(server).some((frame) => JSON.stringify(frame.message).includes(input.prompt)), false,
      "the initial prompt never enters status frames");

    server.sendToClients(encodeFrame({
      version: 1,
      type: "spawn_result",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      requestId: request.message.requestId,
      outcome: "started",
    } as never));
    assert.equal(await pending, "started");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("does not dispatch the initial request from the reporter's early session_start hook", async () => {
    const server = await startTestServer();
    const title = "A title retained for the gate initializer";
    const prompt = "@/path-that-must-not-be-read\n--session /tmp/old.jsonl\n/prompt-template run\n";
    const submittedNames: string[] = [];
    const submitted: Array<{ message: string; options?: { expandPromptTemplates?: boolean } }> = [];
    const { testPi } = await startSession({
      server,
      startupRequest: { title, prompt },
      titleColumns: 47,
      onStartupApi: {
        setSessionName: (name) => { submittedNames.push(name); },
        sendUserMessage: (message, options) => { submitted.push({ message, options }); },
      },
    });
    assert.deepEqual(submittedNames, [], "review-gate session initialization owns native title dispatch");
    assert.deepEqual(submitted, [], "the reporter must not start a turn before gate authorization/checkpoint setup");
    assert.equal(process.env[SESSION_HOST_STARTUP_REQUEST_ENV], undefined, "the authenticated reporter consumes the one-shot request env");
    assert.equal(getSessionHostSpawnCapability()?.titleColumns, 47, "title guidance uses the host's actual visible-layout snapshot");
    assert.equal(statusFrames(server).some((frame) => JSON.stringify(frame.message).includes(prompt)), false,
      "the exact prompt is not retained in reporter status frames");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("returns unknown after post-send cancellation and does not retry on a later acknowledgement", async () => {
    const server = await startTestServer();
    const { testPi, bootstrap } = await startSession({ server });
    await server.waitForFrame((frame) => frame.message.type === "hello");
    const capability = getSessionHostSpawnCapability();
    assert.ok(capability);
    const controller = new AbortController();
    const pending = capability.spawn({ workspace: "/existing", title: "Child", prompt: "Explicit prompt." }, controller.signal);
    const request = await server.waitForFrame((frame) => frame.message.type === "spawn_request");
    controller.abort();
    assert.equal(await pending, "unknown", "cancellation after write cannot claim no child");
    server.sendToClients(encodeFrame({
      version: 1,
      type: "spawn_result",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      requestId: request.message.requestId,
      outcome: "started",
    } as never));
    await sleep(20);
    assert.equal(server.frames.filter((frame) => frame.message.type === "spawn_request").length, 1,
      "the reporter never resends after cancellation or a later connection event");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("bounds the caller wait and reports unknown without claiming a child was not created", async () => {
    const server = await startTestServer();
    const { testPi } = await startSession({ server, reporterOptions: { spawnTimeoutMs: 15 } });
    await server.waitForFrame((frame) => frame.message.type === "hello");
    const capability = getSessionHostSpawnCapability();
    assert.ok(capability);
    const outcome = capability.spawn({ workspace: "/existing", title: "Child", prompt: "Start." });
    await server.waitForFrame((frame) => frame.message.type === "spawn_request");
    assert.equal(await outcome, "unknown");
    assert.equal(server.frames.filter((frame) => frame.message.type === "spawn_request").length, 1);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

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
    const firstNative = initial.message.nativeSession as { sessionId: string; epoch: number; name: string; persistence: string };
    assert.deepEqual(firstNative, {
      sessionId: native.id,
      epoch: 1,
      name: "first user prompt",
      // The stub manager has no getSessionFile, so persistence fails closed to unknown.
      persistence: "unknown",
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
    const fakeServer = { socketPath: makeMemorySocketAddress() } as TestServer;
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
    const fakeServer = { socketPath: makeMemorySocketAddress() } as TestServer;
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

  it("rejects host commands with the wrong token before invoking public rename or shutdown APIs", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "native-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager, reporterOptions: { reconnectDelayMs: 20 } });
    let setterCalls = 0;
    let shutdownCalls = 0;
    (testPi.pi as { setSessionName?: (name: string) => void }).setSessionName = () => { setterCalls += 1; };
    ctx.shutdown = () => { shutdownCalls += 1; };
    ctx.abort = () => undefined;
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
    const shutdown = makeShutdownRequest(bootstrap, nativeSession.sessionId, nativeSession.epoch, { token: "0".repeat(64) });
    server.sendToClients(encodeFrame(shutdown as never));
    await server.waitForFrame((frame) => frame.message.type === "hello" && server.frames.filter((entry) => entry.message.type === "hello").length >= 3);
    assert.equal(shutdownCalls, 0, "wrong capability closes the channel without calling public shutdown");
    assert.equal(server.frames.some((frame) => frame.message.type === "shutdown_result"), false);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("closes malformed and oversized host frames without invoking shutdown", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "malformed-shutdown-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx } = await startSession({
      server,
      sessionManager,
      reporterOptions: { reconnectDelayMs: 20 },
    });
    let shutdownCalls = 0;
    ctx.shutdown = () => { shutdownCalls += 1; };
    ctx.abort = () => undefined;
    await server.waitForFrame((frame) => frame.message.type === "status");

    server.sendToClients("{not-json}\n");
    await server.waitForFrame((frame) => frame.message.type === "hello"
      && server.frames.filter((entry) => entry.message.type === "hello").length >= 2);
    server.sendToClients("x".repeat(MAX_STATUS_FRAME_BYTES + 1));
    await server.waitForFrame((frame) => frame.message.type === "hello"
      && server.frames.filter((entry) => entry.message.type === "hello").length >= 3);
    assert.equal(shutdownCalls, 0);
    assert.equal(server.frames.some((frame) => frame.message.type === "shutdown_result"), false);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("requests public graceful shutdown once, aborting busy work only after shutdown and never claiming exit", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "shutdown-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager });
    const calls: string[] = [];
    ctx.isIdle = () => { calls.push("isIdle"); return false; };
    ctx.shutdown = () => { calls.push("shutdown"); };
    ctx.abort = () => { calls.push("abort"); };

    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const native = status.message.nativeSession as { sessionId: string; epoch: number };
    const request = makeShutdownRequest(bootstrap, native.sessionId, native.epoch);
    const encoded = encodeFrame(request as never);
    const before = server.frames.length;
    // Exact replay must acknowledge the cached result without repeating either public side effect.
    server.sendToClients(encoded + encoded);
    const firstAck = await server.waitForFrame(
      (frame) => frame.message.type === "shutdown_result" && frame.message.requestId === request.requestId,
      3_000,
      before - 1,
    );
    const secondAck = await server.waitForFrame(
      (frame) => frame.message.type === "shutdown_result" && frame.message.requestId === request.requestId,
      3_000,
      server.frames.indexOf(firstAck),
    );
    assert.equal(firstAck.message.outcome, "requested");
    assert.equal(firstAck.message.reason, "none");
    assert.deepEqual(calls, ["isIdle", "shutdown", "isIdle", "abort"], "busy cancellation follows the public shutdown request and only runs if still busy");
    assert.equal(server.connections, 1, "request acknowledgement does not imply PTY exit or reporter disconnect");
    assert.equal("exited" in firstAck.message || "processExited" in firstAck.message, false);
    assert.equal("token" in firstAck.message, false);
    assert.equal("name" in firstAck.message, false);
    assert.equal(secondAck.message.outcome, "requested", "duplicate request replays only its bounded acknowledgement");

    const distinct = makeShutdownRequest(bootstrap, native.sessionId, native.epoch);
    const afterReplay = server.frames.length;
    server.sendToClients(encodeFrame(distinct as never));
    const terminalAck = await server.waitForFrame(
      (frame) => frame.message.type === "shutdown_result" && frame.message.requestId === distinct.requestId,
      3_000,
      afterReplay - 1,
    );
    assert.equal(terminalAck.message.outcome, "rejected");
    assert.equal(terminalAck.message.reason, "already-requested");
    assert.deepEqual(calls, ["isIdle", "shutdown", "isIdle", "abort"], "shutdown is terminal and idempotent for this process incarnation");
    const helloCount = server.frames.filter((frame) => frame.message.type === "hello").length;
    const reloaded = createPi();
    await activate(reloaded.pi);
    await reloaded.trigger("session_start", { type: "session_start", reason: "reload" }, ctx);
    await sleep(30);
    assert.equal(server.frames.filter((frame) => frame.message.type === "hello").length, helloCount,
      "sticky terminal state prevents /reload from reattaching to the old context");
    assert.deepEqual(calls, ["isIdle", "shutdown", "isIdle", "abort"]);
    await reloaded.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("fails closed for stale, foreign, missing, and throwing public shutdown contexts", async () => {
    const server = await startTestServer();
    const native = { id: "shutdown-fence-session", name: undefined as string | undefined };
    let sessionReadThrows = false;
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => {
        if (sessionReadThrows) throw new Error("stale session getter");
        return native.id;
      },
      getSessionName: () => native.name,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager });
    let shutdownCalls = 0;
    let abortCalls = 0;
    ctx.shutdown = () => { shutdownCalls += 1; };
    ctx.abort = () => { abortCalls += 1; };
    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const observed = status.message.nativeSession as { sessionId: string; epoch: number };

    const sendAndRead = async (request: Record<string, unknown>) => {
      const after = server.frames.length;
      server.sendToClients(encodeFrame(request as never));
      return server.waitForFrame(
        (frame) => frame.message.type === "shutdown_result" && frame.message.requestId === request.requestId,
        3_000,
        after - 1,
      );
    };

    ctx.mode = "rpc"; // A foreign/non-native TUI context must not be shut down.
    let ack = await sendAndRead(makeShutdownRequest(bootstrap, observed.sessionId, observed.epoch));
    assert.equal(ack.message.reason, "unavailable");
    ctx.mode = "tui";

    ctx.isIdle = () => { throw new Error("stale isIdle"); };
    ack = await sendAndRead(makeShutdownRequest(bootstrap, observed.sessionId, observed.epoch));
    assert.equal(ack.message.reason, "unavailable");
    ctx.isIdle = () => false;

    sessionReadThrows = true;
    ack = await sendAndRead(makeShutdownRequest(bootstrap, observed.sessionId, observed.epoch));
    assert.equal(ack.message.reason, "unavailable", "a throwing public session getter fails closed");
    sessionReadThrows = false;

    ctx.abort = undefined; // Busy work cannot be left running if public abort is unavailable.
    ack = await sendAndRead(makeShutdownRequest(bootstrap, observed.sessionId, observed.epoch));
    assert.equal(ack.message.reason, "unavailable");
    assert.equal(shutdownCalls, 0, "missing abort is rejected before shutdown side effects");
    ctx.abort = () => { abortCalls += 1; };

    ctx.shutdown = undefined;
    ack = await sendAndRead(makeShutdownRequest(bootstrap, observed.sessionId, observed.epoch));
    assert.equal(ack.message.reason, "unavailable", "missing public shutdown is rejected before side effects");
    ctx.shutdown = () => { shutdownCalls += 1; };

    Object.defineProperty(ctx, "shutdown", {
      configurable: true,
      get() { throw new Error("hostile public API getter"); },
    });
    ack = await sendAndRead(makeShutdownRequest(bootstrap, observed.sessionId, observed.epoch));
    assert.equal(ack.message.reason, "unavailable");
    Object.defineProperty(ctx, "shutdown", {
      configurable: true,
      writable: true,
      value: () => { shutdownCalls += 1; },
    });

    native.id = "different-current-session";
    ack = await sendAndRead(makeShutdownRequest(bootstrap, observed.sessionId, observed.epoch));
    assert.equal(ack.message.reason, "stale-session");
    assert.equal(shutdownCalls, 0, "a conversation change cannot redirect an old request");
    assert.equal(abortCalls, 0);

    const previousStatusCount = statusFrames(server).length;
    await testPi.trigger("session_info_changed", { type: "session_info_changed" }, ctx);
    const updated = await server.waitForFrame(
      (frame) => frame.message.type === "status"
        && (frame.message.nativeSession as { sessionId?: string } | null)?.sessionId === native.id,
      3_000,
      server.frames.length - 2,
    );
    assert.ok(statusFrames(server).length > previousStatusCount);
    const current = updated.message.nativeSession as { sessionId: string; epoch: number };
    ctx.isIdle = () => true;
    ctx.shutdown = () => { throw new Error("public shutdown threw"); };
    ack = await sendAndRead(makeShutdownRequest(bootstrap, current.sessionId, current.epoch));
    assert.equal(ack.message.outcome, "rejected");
    assert.equal(ack.message.reason, "shutdown-failed", "a throwing public shutdown API is not acknowledged as requested");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" });
  });

  it("keeps reporting and reloadable when the final public shutdown getter rejects before invocation", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "shutdown-getter-rejection-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager });
    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const native = status.message.nativeSession as { sessionId: string; epoch: number };
    let getterCalls = 0;
    let shutdownCalls = 0;
    Object.defineProperty(ctx, "shutdown", {
      configurable: true,
      get() {
        getterCalls += 1;
        if (getterCalls === 2) throw new Error("second public shutdown getter failed");
        return () => { shutdownCalls += 1; };
      },
    });

    const request = makeShutdownRequest(bootstrap, native.sessionId, native.epoch);
    const afterRequest = server.frames.length;
    server.sendToClients(encodeFrame(request as never));
    const ack = await server.waitForFrame(
      (frame) => frame.message.type === "shutdown_result" && frame.message.requestId === request.requestId,
      3_000,
      afterRequest - 1,
    );
    assert.equal(ack.message.outcome, "rejected");
    assert.equal(ack.message.reason, "unavailable");
    assert.equal(shutdownCalls, 0);
    let sticky = (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY] as { shutdownRequested?: boolean };
    assert.equal(sticky.shutdownRequested, false, "pre-invocation rejection does not commit a terminal sticky fence");

    const sequenceBeforeActivity = lastStatusSequence(server);
    await testPi.trigger("agent_start", { type: "agent_start" }, ctx);
    const activity = await server.waitForFrame((frame) => frame.message.type === "status"
      && (frame.message.sequence as number) > sequenceBeforeActivity);
    assert.equal(activity.message.busy, true, "ordinary status forwarding continues after rejection");

    const previousHelloCount = server.frames.filter((frame) => frame.message.type === "hello").length;
    const previousSequence = activity.message.sequence as number;
    const reloaded = createPi();
    await activate(reloaded.pi);
    await reloaded.trigger("session_start", { type: "session_start", reason: "reload" }, ctx);
    await server.waitForFrame((frame) => frame.message.type === "hello"
      && server.frames.filter((entry) => entry.message.type === "hello").length > previousHelloCount);
    const restored = await server.waitForFrame((frame) => frame.message.type === "status"
      && (frame.message.sequence as number) > previousSequence);
    assert.equal(restored.message.nativeSession && (restored.message.nativeSession as { sessionId: string }).sessionId, native.sessionId);
    sticky = (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY] as { shutdownRequested?: boolean };
    assert.equal(sticky.shutdownRequested, false, "reload restores the nonterminal reporter incarnation");
    await reloaded.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
  });

  it("does not shut down through a reporter socket destroyed by a public getter", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "shutdown-getter-destroy-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    let reporterSocket: net.Socket | undefined;
    const { testPi, ctx, bootstrap } = await startSession({
      server,
      sessionManager,
      reporterOptions: { onSocket: (candidate) => { reporterSocket = candidate; } },
    });
    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const native = status.message.nativeSession as { sessionId: string; epoch: number };
    let shutdownCalls = 0;
    let abortCalls = 0;
    ctx.isIdle = () => false;
    ctx.abort = () => { abortCalls += 1; };
    Object.defineProperty(ctx, "shutdown", {
      configurable: true,
      get() {
        reporterSocket?.destroy();
        return () => { shutdownCalls += 1; };
      },
    });

    server.sendToClients(encodeFrame(makeShutdownRequest(bootstrap, native.sessionId, native.epoch) as never));
    await sleep(40);
    assert.equal(reporterSocket?.destroyed, true);
    assert.equal(shutdownCalls, 0, "a synchronously destroyed owned socket cannot authorize shutdown");
    assert.equal(abortCalls, 0);
    assert.equal(server.frames.some((frame) => frame.message.type === "shutdown_result"), false);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
  });

  it("does not abort busy work when public shutdown destroys its reporter socket", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "shutdown-during-call-destroy-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    let reporterSocket: net.Socket | undefined;
    const { testPi, ctx, bootstrap } = await startSession({
      server,
      sessionManager,
      reporterOptions: { onSocket: (candidate) => { reporterSocket = candidate; } },
    });
    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const native = status.message.nativeSession as { sessionId: string; epoch: number };
    let shutdownCalls = 0;
    let abortCalls = 0;
    ctx.isIdle = () => false;
    ctx.shutdown = () => {
      shutdownCalls += 1;
      reporterSocket?.destroy();
    };
    ctx.abort = () => { abortCalls += 1; };

    server.sendToClients(encodeFrame(makeShutdownRequest(bootstrap, native.sessionId, native.epoch) as never));
    await sleep(40);
    assert.equal(shutdownCalls, 1);
    assert.equal(reporterSocket?.destroyed, true);
    assert.equal(abortCalls, 0, "destroyed ownership prevents the follow-up public abort");
    assert.equal(server.frames.some((frame) => frame.message.type === "shutdown_result"), false);
    await testPi.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
  });

  it("rechecks ownership after reentrant public getters and withholds acknowledgements after teardown", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "reentrant-shutdown-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager });
    let oldCalls = 0;
    let newCalls = 0;
    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const native = status.message.nativeSession as { sessionId: string; epoch: number };
    const replacement = makeCtx(makeUi().ui, "tui", () => true);
    replacement.sessionManager = sessionManager;
    replacement.shutdown = () => { newCalls += 1; };
    replacement.abort = () => undefined;
    Object.defineProperty(ctx, "shutdown", {
      configurable: true,
      get() {
        // A reentrant new-session event replaces the current context and socket
        // while this old context's API getter is being evaluated.
        void testPi.trigger("session_start", { type: "session_start", reason: "reentrant" }, replacement);
        return () => { oldCalls += 1; };
      },
    });
    server.sendToClients(encodeFrame(makeShutdownRequest(bootstrap, native.sessionId, native.epoch) as never));
    await server.waitForFrame((frame) =>
      frame.message.type === "hello" && server.frames.filter((entry) => entry.message.type === "hello").length >= 2,
    );
    assert.equal(oldCalls, 0, "stale context getter re-entry prevents old-context shutdown");
    assert.equal(newCalls, 0, "a request for the old session is not redirected to its replacement");
    assert.equal(server.frames.some((frame) => frame.message.type === "shutdown_result"), false, "stale connection gets no acknowledgement");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" }, replacement);
  });

  it("does not fabricate a shutdown acknowledgement when native teardown precedes it", async () => {
    const server = await startTestServer();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "teardown-before-ack-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({ server, sessionManager });
    const status = await server.waitForFrame((frame) => frame.message.type === "status");
    const native = status.message.nativeSession as { sessionId: string; epoch: number };
    ctx.isIdle = () => true;
    ctx.shutdown = () => {
      (testPi.hooks.get("session_shutdown")?.[0] as (...args: unknown[]) => unknown)({ type: "session_shutdown" }, ctx);
    };
    server.sendToClients(encodeFrame(makeShutdownRequest(bootstrap, native.sessionId, native.epoch) as never));
    await sleep(40);
    assert.equal(server.frames.some((frame) => frame.message.type === "shutdown_result"), false);
    assert.equal(server.connections, 1, "session_shutdown tears down the reporter transport but is not a PTY-exit witness");
  });

  it("bounds shutdown acknowledgements under writable backpressure before further side effects", async () => {
    const fakeServer = { socketPath: makeMemorySocketAddress() } as TestServer;
    const memory = createMemoryReporterSocket();
    const sessionManager: TestCtx["sessionManager"] = {
      getSessionId: () => "backpressure-shutdown-session",
      getSessionName: () => undefined,
      getEntries: () => [],
    };
    const { testPi, ctx, bootstrap } = await startSession({
      server: fakeServer,
      sessionManager,
      reporterOptions: { connectSocket: () => memory.socket },
    });
    let shutdownCalls = 0;
    ctx.isIdle = () => true;
    ctx.shutdown = () => { shutdownCalls += 1; };
    memory.socket.emit("connect");
    const initial = memory.frames.find((frame) => frame.type === "status");
    assert.ok(initial?.type === "status" && initial.nativeSession);

    let shutdownAckWrites = 0;
    memory.setWritePolicy((frame) => {
      if (frame.type !== "shutdown_result") return true;
      shutdownAckWrites += 1;
      return shutdownAckWrites !== 1;
    });
    const queueLimit = reporterTest.MAX_QUEUED_RENAME_ACKS;
    const requests = Array.from({ length: queueLimit + 2 }, () => encodeFrame(makeShutdownRequest(
      bootstrap,
      initial.nativeSession!.sessionId,
      initial.nativeSession!.epoch,
    ) as never));
    memory.socket.emit("data", Buffer.from(requests.join(""), "utf8"));
    assert.equal(shutdownCalls, 1, "terminal shutdown is invoked only once while replies queue");
    assert.equal(shutdownAckWrites, 1, "queued replies do not bypass the writable backpressure signal");
    assert.equal(memory.socket.destroyed, true, "queue exhaustion closes the authenticated channel");
    await testPi.trigger("session_shutdown", { type: "session_shutdown" }, ctx);
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
    if (process.platform !== "win32") rmSync(server.socketPath, { force: true });
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
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\prg-st-${randomBytes(16).toString("hex")}`
      : join(tmpdir(), `sh-${process.pid}-${serverCounter}.sock`);
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
        if (process.platform !== "win32") rmSync(socketPath, { force: true });
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
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\prg-st-${randomBytes(16).toString("hex")}`
      : join(tmpdir(), `sh-${process.pid}-${serverCounter}.sock`);
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
    if (process.platform !== "win32") rmSync(socketPath, { force: true });
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

/** Node's quoted NODE_OPTIONS grammar treats Windows backslashes as escapes. */
function nodeOptionsPath(pathname: string): string {
  return pathname.replace(/\\/g, "/");
}

function nodeRequireOption(pathname: string, quoted = false): string {
  const portablePath = nodeOptionsPath(pathname);
  return quoted ? `--require="${portablePath}"` : `--require=${portablePath}`;
}

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
    withNodeOptions(`${nodeRequireOption(PRELOAD_PATH)} --max-old-space-size=100`, () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: "--max-old-space-size=100" });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=100");
      assert.equal(process.env[NODE_OPTIONS_RESTORE_ENV], undefined, "one-shot frame consumed");
    });
  });

  it("restoreNodeOptions deletes NODE_OPTIONS for a null original", () => {
    withNodeOptions(nodeRequireOption(PRELOAD_PATH), () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: null });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, undefined);
    });
  });

  it("restoreNodeOptions strips only its own flag on an invalid frame (no content dump)", () => {
    withNodeOptions(`${nodeRequireOption(PRELOAD_PATH)} --other=1`, () => {
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
    withNodeOptions(`${nodeRequireOption(PRELOAD_PATH, true)} --require="/tmp/a b.js" --other=1`, () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = "malformed";
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, `--require="/tmp/a b.js" --other=1`);
    });
  });

  it("restoreNodeOptions restores a spaced original verbatim", () => {
    withNodeOptions(nodeRequireOption(PRELOAD_PATH), () => {
      process.env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: `--require="/tmp/a b.js"` });
      restoreNodeOptions();
      assert.equal(process.env.NODE_OPTIONS, `--require="/tmp/a b.js"`);
    });
  });

  it("restoreNodeOptions bounds the original in UTF-8 bytes, not UTF-16 length", () => {
    withNodeOptions(`${nodeRequireOption(PRELOAD_PATH, true)} --other=1`, () => {
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

  // The descendant probe CLI: a retained regular nonsymlink file (never an
  // inline script or shell) that records the environment view the descendant
  // must NOT have.
  const GRANDCHILD_CLI_SOURCE = [
    "process.stdout.write(JSON.stringify({",
    "  bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP !== undefined,",
    "  restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE !== undefined,",
    "  nodeOptions: process.env.NODE_OPTIONS ?? null,",
    "}));",
    "",
  ].join("\n");

  // The ORIGINAL user --require fixture: records its own environment view and
  // runs the retained grandchild CLI before main to prove no inheritance.
  // SH_TEST_GRANDCHILD guards re-entry: the descendant inherits the restored
  // NODE_OPTIONS (and thus reloads this fixture) but must not spawn again.
  const USER_FIXTURE_SOURCE = [
    'const { spawnSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'if (process.env.SH_TEST_GRANDCHILD !== "1") {',
    "  // Finite deadline and bounded capture on the trusted interpreter; only",
    "  // an explicit successful spawn outcome admits the grandchild JSON.",
    "  const grandchild = spawnSync(process.execPath, [process.env.SH_TEST_GRANDCHILD_CLI], { encoding: \"utf8\", timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, SH_TEST_GRANDCHILD: \"1\" } });",
    "  if (grandchild.error !== undefined || grandchild.status !== 0) {",
    "    fs.writeFileSync(process.env.SH_TEST_MARKER, JSON.stringify({",
    "      userFixture: { ran: true, nodeOptions: process.env.NODE_OPTIONS ?? null },",
    "      grandchild: { spawnFailed: true },",
    '    }), { flag: \"wx\", mode: 0o600 });',
    '    throw new Error(\"grandchild probe did not settle successfully\");',
    "  }",
    "  fs.writeFileSync(process.env.SH_TEST_MARKER, JSON.stringify({",
    "    userFixture: { ran: true, nodeOptions: process.env.NODE_OPTIONS ?? null },",
    "    grandchild: JSON.parse(grandchild.stdout),",
    '  }), { flag: \"wx\", mode: 0o600 });',
    "}",
    "",
  ].join("\n");

  const CHILD_MAIN_SOURCE = [
    "const assert = require(\"node:assert/strict\");",
    "const net = require(\"node:net\");",
    "const originalConnect = net.Socket.prototype.connect;",
    "net.Socket.prototype.connect = function (...args) {",
    "  const relative = process.env.SH_TEST_RELATIVE_SOCKET;",
    "  const normalized = Array.isArray(args[0]);",
    "  const options = normalized ? args[0][0] : args[0];",
    "  if (relative && typeof options === \"string\") {",
    "    const replacement = { path: relative };",
    "    if (normalized) args[0][0] = replacement; else args[0] = replacement;",
    "  } else if (relative && options && typeof options === \"object\" && typeof options.path === \"string\") {",
    "    const replacement = { ...options, path: relative };",
    "    if (normalized) args[0][0] = replacement; else args[0] = replacement;",
    "  }",
    "  return originalConnect.apply(this, args);",
    "};",
    "(async () => {",
    "  const reporter = require(process.env.SH_TEST_REPORTER);",
    "  assert.equal(process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined, \"bootstrap consumed pre-main\");",
    "  assert.equal(process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined, \"restore frame consumed pre-main\");",
    "  assert.equal(process.env.NODE_OPTIONS, process.env.SH_TEST_ORIGINAL_NODE_OPTIONS, \"original NODE_OPTIONS restored exactly\");",
    "  const sticky = globalThis[reporter.SESSION_HOST_STICKY_STATE_KEY];",
    "  assert.ok(sticky && sticky.bootstrap.instanceId === process.env.SH_TEST_INSTANCE_ID, \"sticky primed pre-main\");",
    "  const hooks = new Map();",
    "  const pi = { on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); } };",
    "  // Event-driven observation on the reporter's OWN socket: hello and status",
    "  // delivery is witnessed through its original channel with write",
    "  // forwarding intact. Only a SUCCESSFUL original write callback settles a",
    "  // frame as delivered; attempted writes never count. The deadline is",
    "  // failure, never readiness; no polling or sleep stands in for delivery.",
    "  const observedTypes = new Set();",
    "  let deliver;",
    "  const delivery = new Promise((resolve, reject) => {",
    "    const deadline = setTimeout(() => reject(new Error(\"hello/status not delivered within the bounded deadline\")), 10_000);",
    "    deliver = (ok, types) => {",
    "      if (!ok) {",
    "        clearTimeout(deadline);",
    "        reject(new Error(\"original write failed before delivery settlement\"));",
    "        return;",
    "      }",
    "      for (const type of types) observedTypes.add(type);",
    "      if (observedTypes.has(\"hello\") && observedTypes.has(\"status\")) {",
    "        clearTimeout(deadline);",
    "        resolve();",
    "      }",
    "    };",
    "  });",
    "  await reporter.activate(pi, {",
    "    onSocket: (socket) => {",
    "      const originalWrite = socket.write.bind(socket);",
    "      socket.write = (chunk, ...rest) => {",
    "        const text = typeof chunk === \"string\" ? chunk : Buffer.from(chunk).toString(\"utf8\");",
    "        const types = [];",
    "        for (const line of text.split(\"\\n\")) {",
    "          if (!line) continue;",
    "          try {",
    "            const type = JSON.parse(line).type;",
    "            if (typeof type === \"string\") types.push(type);",
    "          } catch { /* not a frame */ }",
    "        }",
    "        const settle = (error) => deliver(error === undefined || error === null, types);",
    "        if (typeof rest[rest.length - 1] === \"function\") {",
    "          const prior = rest.pop();",
    "          return originalWrite(chunk, ...rest, (error) => { settle(error); prior(error); });",
    "        }",
    "        return originalWrite(chunk, ...rest, settle);",
    "      };",
    "    },",
    "  });",
    "  assert.ok(hooks.size > 0, \"default factory registers from primed sticky state\");",
    "  const ctx = { mode: \"tui\", ui: { setWidget() {} }, isIdle: () => true, sessionManager: { getSessionId: () => \"child\" } };",
    "  for (const h of hooks.get(\"session_start\") ?? []) await h({ type: \"session_start\" }, ctx);",
    "  await delivery;",
    "  for (const h of hooks.get(\"session_shutdown\") ?? []) await h({ type: \"session_shutdown\" });",
    "})().catch((e) => { console.error(e.message); process.exit(1); });",
    "",
  ].join("\n");

  // Inherited ORIGINAL runtime-surface markers (runtime role and executor tool
  // catalog) must never be stripped to authorize a preloaded child: the
  // scenario requires a genuine top-level surface. The suite's beforeEach saves
  // and removes the canonical role for in-process hermeticity, so the inherited
  // value is witnessed through previousRuntimeRole; case aliases and the
  // catalog marker are witnessed through the live env (env names are
  // case-insensitive on Windows). Presence, including empty values, refuses
  // before any fixture mutation. Never stripped, never laundered.
  const RUNTIME_SURFACE_MARKER_NAMES = [
    "PI_REVIEW_GATE_RUNTIME_ROLE",
    "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
  ];

  function inheritedRuntimeSurfaceMarker(): string | undefined {
    if (previousRuntimeRole !== undefined) return "PI_REVIEW_GATE_RUNTIME_ROLE";
    for (const key of Object.keys(process.env)) {
      if (RUNTIME_SURFACE_MARKER_NAMES.includes(key.toUpperCase())) return key;
    }
    return undefined;
  }

  async function runPreloadedChild(options: {
    bootstrap: Record<string, unknown>;
    restoreFrameFor: (userFixturePath: string) => string | undefined;
    nodeOptionsFor: (userFixturePath: string) => string;
    expectedNodeOptionsFor: (userFixturePath: string) => string;
    /** Optional parent directory for the fixture tree (e.g. one containing spaces). */
    fixturesRoot?: string;
    /** Reporter module the child main loads (defaults to the compiled package path). */
    reporterPath?: string;
  }): Promise<{ status: number; markerData: PreloadMarker; userFixturePath: string }> {
    // Refuse an inherited original runtime-surface marker before any helper or
    // spaced-fixture mutation; it is never stripped to authorize a child.
    const surfaceMarker = inheritedRuntimeSurfaceMarker();
    if (surfaceMarker !== undefined) {
      throw new Error(`inherited runtime-surface marker ${surfaceMarker} refuses the preloaded child`);
    }
    // Every invocation gets a fresh, exclusively created fixture directory that
    // is retained as evidence for that attempt: no teardown sweep can drop a
    // later attempt's marker, and an earlier attempt's marker can never be
    // mistaken for this invocation's.
    const dir = options.fixturesRoot === undefined
      ? mkdtempSync(join(tmpdir(), "sh-preload-"))
      : mkdtempSync(join(options.fixturesRoot, "fixture-"));
    const userFixture = join(dir, "user-fixture.js");
    const childMain = join(dir, "child-main.js");
    const grandchildCli = join(dir, "grandchild-cli.js");
    const marker = join(dir, "marker.json");
    writeFileSync(userFixture, USER_FIXTURE_SOURCE, { flag: "wx", mode: 0o600 });
    writeFileSync(childMain, CHILD_MAIN_SOURCE, { flag: "wx", mode: 0o600 });
    writeFileSync(grandchildCli, GRANDCHILD_CLI_SOURCE, { flag: "wx", mode: 0o600 });

    const restoreFrame = options.restoreFrameFor(userFixture);
    // The parent environment is preserved as-is: the marker guard above already
    // refused any inherited runtime-surface marker, and only the explicit
    // synthetic NODE_OPTIONS/bootstrap/restore frames below are test-local
    // injections. No general env laundering.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    childEnv.NODE_OPTIONS = options.nodeOptionsFor(userFixture);
    if (restoreFrame === undefined) delete childEnv[NODE_OPTIONS_RESTORE_ENV];
    else childEnv[NODE_OPTIONS_RESTORE_ENV] = restoreFrame;
    childEnv[HOST_BOOTSTRAP_ENV] = JSON.stringify(options.bootstrap);
    childEnv.SH_TEST_MARKER = marker;
    childEnv.SH_TEST_GRANDCHILD_CLI = grandchildCli;
    childEnv.SH_TEST_RELATIVE_SOCKET = rootRelativeSocketAddress(options.bootstrap.socketPath as string);
    childEnv.SH_TEST_REPORTER = options.reporterPath ?? REPORTER_PATH;
    childEnv.SH_TEST_ORIGINAL_NODE_OPTIONS = options.expectedNodeOptionsFor(userFixture);
    childEnv.SH_TEST_INSTANCE_ID = options.bootstrap.instanceId as string;

    // Bounded settlement only (code/signal/spawn failure/unsettled): raw
    // output, env, and arguments are never captured or surfaced. The original
    // ChildProcess and its exit/close observers are retained in the ownership
    // record until exact process/stdio settlement; a timeout is force intent,
    // never exit proof, and any error latches failure so no later zero exit
    // can admit the marker.
    type ChildSettlement =
      | { kind: "exited"; code: number | null; forced: boolean; errored: boolean }
      | { kind: "signal"; signal: NodeJS.Signals; forced: boolean; errored: boolean }
      | { kind: "spawn-failure" }
      | { kind: "unsettled" };
    const ownership: {
      child: ChildProcess | undefined;
      settled: boolean;
      code: number | null;
      signal: NodeJS.Signals | null;
    } = { child: undefined, settled: false, code: null, signal: null };
    const settlement = await new Promise<ChildSettlement>((resolve) => {
      let reported = false;
      let forceIntent = false;
      let errorLatched = false;
      let forceWatchdog: NodeJS.Timeout | undefined;
      const child = spawn(process.execPath, [childMain], { env: childEnv, stdio: ["ignore", "ignore", "ignore"] });
      ownership.child = child;
      // Bounded result reporting is separate from original settlement: the
      // close observer keeps recording the eventual exact settlement in the
      // ownership record even after a bounded result was reported.
      const report = (result: ChildSettlement): void => {
        if (reported) return;
        reported = true;
        resolve(result);
      };
      const watchdog = setTimeout(() => {
        if (reported) return;
        // Timeout is failure/force intent, never exit proof: attempt the kill
        // honestly (it may throw or refuse), then wait for the original close
        // within a second finite bound.
        forceIntent = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // A refused or failed kill is not settlement either.
        }
        forceWatchdog = setTimeout(() => {
          if (reported) return;
          // Bounded result reported UNSETTLED; the original owner and its
          // close observer stay retained in the ownership record for the
          // eventual exact settlement.
          report({ kind: "unsettled" });
        }, 5_000);
      }, 15_000);
      child.on("error", () => {
        errorLatched = true;
        if (reported) return;
        // Positive no-spawn evidence: a spawn failure never assigns a pid. A
        // post-spawn error latches failure but is not settlement; the close
        // observer and watchdogs stay in charge of the finite outcome.
        if (child.pid === undefined) {
          clearTimeout(watchdog);
          if (forceWatchdog !== undefined) clearTimeout(forceWatchdog);
          report({ kind: "spawn-failure" });
        }
      });
      // The original close observer is the settlement witness (process exit
      // plus all stdio closed). It records the eventual settlement in the
      // ownership record even after a bounded result was reported, and it is
      // never removed or replaced.
      child.on("close", (code, signal) => {
        ownership.settled = true;
        ownership.code = code;
        ownership.signal = signal;
        clearTimeout(watchdog);
        if (forceWatchdog !== undefined) clearTimeout(forceWatchdog);
        report(signal === null
          ? { kind: "exited", code, forced: forceIntent, errored: errorLatched }
          : { kind: "signal", signal, forced: forceIntent, errored: errorLatched });
      });
    });

    // The original child settlement is the launch result. A timeout, force,
    // error, signal, or unsettled outcome can never admit marker success even
    // if a prior/current marker exists; only an unforced clean exit does. A
    // missing marker can never replace a failed settlement with ENOENT or
    // accept an earlier attempt's success; it is only read after this
    // invocation exited cleanly.
    if (settlement.kind === "spawn-failure") throw new Error("preloaded child failed to start");
    if (settlement.kind === "unsettled") {
      throw new Error("preloaded child UNSETTLED: original exit could not be confirmed within the finite bound");
    }
    if (settlement.errored) throw new Error("preloaded child failed with a post-spawn error before settlement");
    if (settlement.forced) {
      throw new Error(settlement.kind === "signal"
        ? `preloaded child timed out; force settlement by signal ${settlement.signal}`
        : `preloaded child timed out; force settlement with exit code ${settlement.code}`);
    }
    if (settlement.kind === "signal") throw new Error(`preloaded child terminated by signal ${settlement.signal}`);
    const status = settlement.code;
    if (status !== 0) throw new Error(`preloaded child exited with code ${status}`);

    let markerData: PreloadMarker;
    try {
      markerData = JSON.parse(readFileSync(marker, "utf8")) as PreloadMarker;
    } catch {
      throw new Error("preloaded child settled cleanly but its exclusive marker is missing");
    }
    return { status, markerData, userFixturePath: userFixture };
  }

  it("refuses inherited runtime-role/catalog markers before any fixture mutation", async () => {
    // Source witness: runPreloadedChild's first act is the marker guard,
    // before mkdtempSync/writeFileSync/spawn. This regression is zero-IO: pure
    // env inspection and a rejected promise; no fixture, no child. Every
    // touched marker entry is captured before injection and restored exactly
    // in finally (env names are case-insensitive on Windows), so an originally
    // inherited surface is never laundered by this test.
    const inheritedCases: Array<[string, string]> = [
      ["PI_REVIEW_GATE_RUNTIME_ROLE", "executor"],
      ["PI_REVIEW_GATE_RUNTIME_ROLE", ""],
      ["pi_review_gate_runtime_role", "executor"],
      ["PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG", "1"],
      ["Pi_Review_Gate_Executor_Tool_Catalog", ""],
    ];
    const originalResidual = inheritedRuntimeSurfaceMarker();
    const originalValues = new Map<string, string | undefined>();
    for (const [key] of inheritedCases) originalValues.set(key, process.env[key]);
    try {
      for (const [key, value] of inheritedCases) {
        process.env[key] = value;
        await assert.rejects(
          runPreloadedChild({
            bootstrap: makeBootstrap("/tmp/sh-refused.sock"),
            restoreFrameFor: () => undefined,
            nodeOptionsFor: () => "",
            expectedNodeOptionsFor: () => "",
          }),
          /inherited runtime-surface marker/,
          `${key} refuses the preloaded child`,
        );
      }
    } finally {
      for (const [key] of inheritedCases) {
        const original = originalValues.get(key);
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    }
    // A clean surface is only claimed when the original surface had no marker.
    if (originalResidual === undefined) {
      assert.equal(inheritedRuntimeSurfaceMarker(), undefined, "restored surface matches the original clean surface");
    }
  });

  it("preloaded Node process restores env before user fixtures and reports via the default factory", async () => {
    const server = await startTestServer();
    const bootstrap = makeBootstrap(server.socketPath);
    const { status, markerData } = await runPreloadedChild({
      bootstrap,
      restoreFrameFor: (userFixture) => JSON.stringify({ original: nodeRequireOption(userFixture, true) }),
      // Host contract: our --require is PREPENDED before the original options.
      nodeOptionsFor: (userFixture) => `${nodeRequireOption(PRELOAD_PATH, true)} ${nodeRequireOption(userFixture, true)}`,
      expectedNodeOptionsFor: (userFixture) => nodeRequireOption(userFixture, true),
    });
    assert.equal(status, 0, "preloaded child exits cleanly (env hygiene + default factory assertions)");

    assert.equal(markerData.userFixture.ran, true, "original user fixture still executes");
    assert.ok(
      markerData.userFixture.nodeOptions !== null && !markerData.userFixture.nodeOptions.includes(nodeOptionsPath(PRELOAD_PATH)),
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
      nodeOptionsFor: (userFixture) => `${nodeRequireOption(PRELOAD_PATH, true)} ${nodeRequireOption(userFixture, true)}`,
      expectedNodeOptionsFor: (userFixture) => nodeRequireOption(userFixture, true),
    });
    assert.equal(status, 0, "preloaded child exits cleanly (quoted self flag stripped)");
    assert.ok(
      markerData.userFixture.nodeOptions !== null && !markerData.userFixture.nodeOptions.includes(nodeOptionsPath(PRELOAD_PATH)),
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

  // Bounded per-leaf byte bound for staged compiled sources.
  const STAGED_LEAF_MAX_BYTES = 1_048_576;

  interface PathIdentity {
    dev: bigint;
    ino: bigint;
  }

  /**
   * Ownership ledger for the spaced fixture tree: the BigInt identity of every
   * retained ancestor, every created directory, and every staged leaf. One
   * ledger spans all six leaves so an ancestor or leaf replacement between
   * leaves can never become the next accepted baseline. It is revalidated
   * before and after each mutation and on failure.
   */
  interface StagingLedger {
    root: string;
    identities: Map<string, PathIdentity>;
  }

  // Retained ownership evidence on both success and failure; never swept.
  const retainedStagingLedgers = new Set<StagingLedger>();

  function lstatFixture(path: string, label: string) {
    try {
      return lstatSync(path, { bigint: true });
    } catch {
      throw new Error(`staged fixture path missing for ${label}`);
    }
  }

  function assertGenuineDirectory(path: string, label: string): PathIdentity {
    const stats = lstatFixture(path, label);
    if (!stats.isDirectory()) throw new Error(`staged fixture ancestor is not a genuine directory for ${label}`);
    return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
  }

  function assertIdentityUnchanged(path: string, label: string, expected: PathIdentity): void {
    const stats = lstatFixture(path, label);
    if (BigInt(stats.dev) !== expected.dev || BigInt(stats.ino) !== expected.ino) {
      throw new Error(`staged fixture identity changed for ${label}`);
    }
  }

  /** Fixture-rooted chain from root (inclusive) down to target (inclusive). */
  function ancestorChain(root: string, target: string): string[] {
    const chain = [root];
    let current = root;
    for (const segment of relative(root, target).split(sep)) {
      if (segment === "" || segment === ".") continue;
      current = join(current, segment);
      chain.push(current);
    }
    return chain;
  }

  function ledgerLabel(ledger: StagingLedger, path: string): string {
    return path === ledger.root ? "fixture root" : relative(ledger.root, path);
  }

  /** Revalidates every ledger entry against the live tree. */
  function revalidateLedger(ledger: StagingLedger): void {
    for (const [path, identity] of ledger.identities) {
      assertIdentityUnchanged(path, ledgerLabel(ledger, path), identity);
    }
  }

  function createStagingLedger(root: string): StagingLedger {
    return { root, identities: new Map([[root, assertGenuineDirectory(root, "fixture root")]]) };
  }

  /**
   * Ensures the chain from the ledger root down to leafDir exists. Each
   * missing directory is created individually and exclusively (non-recursive
   * mkdir: a concurrent creation or preexisting entry of any type refuses),
   * and its identity is captured in the ledger. Retained ancestors are
   * revalidated before and after each creation. Fresh roots and prechecks are
   * not atomic containment: swaps are detected, never claimed impossible.
   */
  function ensureAncestorChain(ledger: StagingLedger, leafDir: string): void {
    for (const path of ancestorChain(ledger.root, leafDir)) {
      if (ledger.identities.has(path)) continue; // retained or created earlier
      const label = ledgerLabel(ledger, path);
      revalidateLedger(ledger);
      try {
        mkdirSync(path); // non-recursive: exclusive creation of this level only
      } catch {
        throw new Error(`staged fixture ancestor creation refused; entry retained: ${label}`);
      }
      ledger.identities.set(path, assertGenuineDirectory(path, label));
      revalidateLedger(ledger);
    }
  }

  /** Exclusive (wx) destination create: any preexisting leaf of any type refuses. */
  function openExclusiveLeaf(path: string, label: string): number {
    try {
      return openSync(path, "wx");
    } catch {
      throw new Error(`staged destination already exists and is retained: ${label}`);
    }
  }

  /**
   * Flag policy for the staged-leaf source open, as a pure function of the
   * platform and available constants so it can be regression-tested with
   * explicit inputs:
   * - win32: plain read-only. Windows exposes neither O_NONBLOCK nor
   *   O_NOFOLLOW; safety comes from the descriptor-identity revalidation in
   *   stageCompiledLeaf (a followed symlink or swapped entry presents a
   *   descriptor whose BigInt dev/ino differ from the pre-lstat regular file
   *   and is refused). Matches the established bounded-copier strategy in
   *   scripts/ci/session-host-windows-acceptance.cjs and
   *   src/session-host/saved-sessions.ts; observational public-API checks
   *   only, no atomic containment claimed.
   * - every other platform: strict fail-closed — both O_NONBLOCK and
   *   O_NOFOLLOW must be nonzero numbers, otherwise the policy refuses
   *   (undefined) rather than open with weakened flags.
   */
  function stagedSourceOpenFlags(platform: string, oRdonly: number, oNonblock: unknown, oNofollow: unknown): number | undefined {
    if (platform === "win32") return oRdonly;
    if (typeof oNonblock !== "number" || oNonblock === 0
      || typeof oNofollow !== "number" || oNofollow === 0) return undefined;
    return oRdonly | oNonblock | oNofollow;
  }

  /** Structural stats view for admitted-source revalidation. */
  interface SourceSnapshot {
    isFile(): boolean;
    dev: number | bigint;
    ino: number | bigint;
    size: number | bigint;
  }

  /**
   * Exact admitted-source comparison: regular type, identity, and the
   * initially observed size must all hold. Applied to the source descriptor
   * after open (admission-to-open drift) and to both the descriptor and the
   * path after copy (in-place mutation).
   */
  function sameAdmittedSource(snapshot: SourceSnapshot, identity: PathIdentity, admittedSize: bigint): boolean {
    return snapshot.isFile() && BigInt(snapshot.dev) === identity.dev
      && BigInt(snapshot.ino) === identity.ino && BigInt(snapshot.size) === admittedSize;
  }

  /**
   * Stages one explicit compiled leaf from a genuine regular nonsymlink source
   * into an exclusively created destination inside the spaced fixture root.
   * Any refusal retains whatever exists; nothing is overwritten, deleted, or
   * cleaned up here.
   */
  function stageCompiledLeaf(ledger: StagingLedger, leafRelative: string, sourcePath: string): void {
    const destination = join(ledger.root, leafRelative);
    const leafDir = dirname(destination);

    // Source: genuine regular nonsymlink file with bounded bytes. lstat does
    // not follow symlinks, so a symlinked source is refused here.
    const sourceLstat = lstatFixture(sourcePath, leafRelative);
    if (!sourceLstat.isFile()) throw new Error(`staged source is not a regular nonsymlink file: ${leafRelative}`);
    if (sourceLstat.size > STAGED_LEAF_MAX_BYTES) throw new Error(`staged source exceeds the byte bound: ${leafRelative}`);
    const admittedSize = BigInt(sourceLstat.size);
    const sourceIdentity = { dev: BigInt(sourceLstat.dev), ino: BigInt(sourceLstat.ino) };

    revalidateLedger(ledger);
    ensureAncestorChain(ledger, leafDir);

    // Exclusive destination write: any preexisting leaf of any type refuses;
    // it is retained, never overwritten or deleted.
    const destFd = openExclusiveLeaf(destination, leafRelative);
    let sourceFd: number | undefined;
    let totalBytes = 0;
    let destIdentity: PathIdentity | undefined;
    try {
      // Record output ownership before copying: the created descriptor's
      // identity enters the ledger immediately, so failure revalidation
      // covers partial outputs too.
      const createdDestination = fstatSync(destFd, { bigint: true });
      if (!createdDestination.isFile()) {
        throw new Error(`staged destination is not a regular file: ${leafRelative}`);
      }
      destIdentity = { dev: BigInt(createdDestination.dev), ino: BigInt(createdDestination.ino) };
      ledger.identities.set(destination, destIdentity);
      revalidateLedger(ledger);
      // Platform contract: POSIX opens with strict nonblocking + nofollow
      // protection and refuses to weaken it; Windows opens plain read-only
      // and relies on the descriptor identity check below — a reparse-point
      // follow or swapped entry yields a descriptor whose BigInt identity
      // differs from the pre-lstat entry.
      const sourceFlags = stagedSourceOpenFlags(process.platform, constants.O_RDONLY, constants.O_NONBLOCK, constants.O_NOFOLLOW);
      if (sourceFlags === undefined) {
        throw new Error(`bounded nonsymlink source open unsupported on ${process.platform}: ${leafRelative}`);
      }
      try {
        sourceFd = openSync(sourcePath, sourceFlags);
      } catch {
        throw new Error(`staged source could not be opened: ${leafRelative}`);
      }
      const sourceFstat = fstatSync(sourceFd, { bigint: true });
      if (!sourceFstat.isFile() || BigInt(sourceFstat.dev) !== sourceIdentity.dev || BigInt(sourceFstat.ino) !== sourceIdentity.ino) {
        throw new Error(`staged source identity changed: ${leafRelative}`);
      }
      // The descriptor must be the exact admitted entry, including its size:
      // a same-identity mutation between admission and open is refused.
      if (!sameAdmittedSource(sourceFstat, sourceIdentity, admittedSize)) {
        throw new Error(`staged source size changed before copy: ${leafRelative}`);
      }
      if (sourceFstat.size > STAGED_LEAF_MAX_BYTES) throw new Error(`staged source exceeds the byte bound: ${leafRelative}`);
      // Path revalidated against the original identity after the open.
      assertIdentityUnchanged(sourcePath, leafRelative, sourceIdentity);

      // Bounded copy of exactly the admitted size, position-tracked; short
      // writes are refused. The ledger is revalidated before and after every
      // write; these remain observational checks, not atomic containment.
      totalBytes = Number(admittedSize);
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < totalBytes) {
        const toRead = Math.min(buffer.length, totalBytes - offset);
        const bytesRead = readSync(sourceFd, buffer, 0, toRead, offset);
        if (bytesRead === 0) throw new Error(`staged source ended before its declared size: ${leafRelative}`);
        revalidateLedger(ledger);
        const bytesWritten = writeSync(destFd, buffer, 0, bytesRead, offset);
        revalidateLedger(ledger);
        if (bytesWritten !== bytesRead) throw new Error(`staged destination short write: ${leafRelative}`);
        offset += bytesRead;
      }

      // Destination byte count verified on the open descriptor.
      const destFstat = fstatSync(destFd, { bigint: true });
      if (!destFstat.isFile() || Number(destFstat.size) !== totalBytes) {
        throw new Error(`staged destination size mismatch: ${leafRelative}`);
      }

      // Source revalidation after the copy, on both the open descriptor and
      // the path: regular type, identity, and the admitted size must all
      // hold; any drift makes the staged output ambiguous; refuse and retain.
      if (!sameAdmittedSource(fstatSync(sourceFd, { bigint: true }), sourceIdentity, admittedSize)) {
        throw new Error(`staged source changed during copy: ${leafRelative}`);
      }
      const sourceAfter = lstatFixture(sourcePath, leafRelative);
      if (!sameAdmittedSource(sourceAfter, sourceIdentity, admittedSize)) {
        throw new Error(`staged source changed during copy: ${leafRelative}`);
      }
    } finally {
      try {
        if (sourceFd !== undefined) closeSync(sourceFd);
      } finally {
        closeSync(destFd);
      }
    }

    // Final identity revalidation: a genuine regular nonsymlink leaf whose
    // path identity matches the created descriptor; ledger retained.
    if (destIdentity === undefined) throw new Error(`staged destination identity missing: ${leafRelative}`);
    const destLstat = lstatFixture(destination, leafRelative);
    if (!destLstat.isFile() || BigInt(destLstat.dev) !== destIdentity.dev || BigInt(destLstat.ino) !== destIdentity.ino
      || Number(destLstat.size) !== totalBytes) {
      throw new Error(`staged destination identity changed: ${leafRelative}`);
    }
    revalidateLedger(ledger);
  }

  /**
   * Stages the explicit six-leaf closure under one shared ownership ledger.
   * On failure the ledger is revalidated to surface concurrent tampering, and
   * everything created is retained.
   */
  function stageModuleClosure(root: string, leaves: Array<{ relative: string; source: string }>): void {
    const ledger = createStagingLedger(root);
    retainedStagingLedgers.add(ledger);
    for (const leaf of leaves) {
      try {
        stageCompiledLeaf(ledger, leaf.relative, leaf.source);
      } catch (error) {
        try {
          revalidateLedger(ledger);
        } catch (tamperError) {
          throw tamperError;
        }
        throw error;
      }
    }
  }

  it("staged source open flags follow the platform contract", () => {
    // Source-test-only platform pin for the staged-leaf copier: POSIX keeps
    // the strict nonblocking + nofollow source open and refuses to weaken it;
    // Windows has neither constant, so it stages with a plain read-only open
    // whose safety comes from the descriptor-identity revalidation (a followed
    // symlink or swapped entry presents a different BigInt dev/ino and is
    // refused). No unavailable kernel guarantee is claimed on Windows.
    const live = stagedSourceOpenFlags(process.platform, constants.O_RDONLY, constants.O_NONBLOCK, constants.O_NOFOLLOW);
    assert.notEqual(live, undefined, "the live platform must support the staged source open");
    if (process.platform === "win32") {
      assert.equal(live, constants.O_RDONLY, "Windows stages with a plain read-only source open");
    } else {
      assert.equal(live, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        "POSIX staging keeps strict nonblocking + nofollow protection");
    }

    // Pure policy regressions with explicit platform/constants inputs: the
    // plain read-only fallback is Windows-only; every other platform requires
    // both nonzero numeric flags and refuses otherwise.
    assert.equal(stagedSourceOpenFlags("win32", 1024, undefined, undefined), 1024);
    assert.equal(stagedSourceOpenFlags("win32", 1024, 0, 0), 1024);
    assert.equal(stagedSourceOpenFlags("linux", 1, 2048, 256), 1 | 2048 | 256);
    assert.equal(stagedSourceOpenFlags("darwin", 1, undefined, 256), undefined, "missing O_NONBLOCK refuses on POSIX");
    assert.equal(stagedSourceOpenFlags("linux", 1, 2048, undefined), undefined, "missing O_NOFOLLOW refuses on POSIX");
    assert.equal(stagedSourceOpenFlags("darwin", 1, 0, 256), undefined, "zero O_NONBLOCK refuses on POSIX");
    assert.equal(stagedSourceOpenFlags("linux", 1, 2048, 0), undefined, "zero O_NOFOLLOW refuses on POSIX");
  });

  it("staged source admission binds the initially observed size", () => {
    // Pure snapshot-comparison regression: identity and regular type alone do
    // not admit a source; the initially observed size is part of the
    // admission, so a same-identity growth or shrinkage between admission and
    // open (or during copy) is refused.
    const identity = { dev: 42n, ino: 7n };
    const admittedSize = 100n;
    assert.ok(sameAdmittedSource({ isFile: () => true, dev: 42n, ino: 7n, size: 100n }, identity, admittedSize),
      "the exact admitted entry holds");
    assert.ok(!sameAdmittedSource({ isFile: () => true, dev: 42n, ino: 7n, size: 101n }, identity, admittedSize),
      "same-identity growth refuses");
    assert.ok(!sameAdmittedSource({ isFile: () => true, dev: 42n, ino: 7n, size: 99n }, identity, admittedSize),
      "same-identity shrinkage refuses");
    assert.ok(!sameAdmittedSource({ isFile: () => false, dev: 42n, ino: 7n, size: 100n }, identity, admittedSize),
      "non-regular type refuses");
    assert.ok(!sameAdmittedSource({ isFile: () => true, dev: 43n, ino: 7n, size: 100n }, identity, admittedSize),
      "identity change refuses");
  });

  it("preloaded Node process strips a spaced quoted self flag from a spaced compiled path", async () => {
    // Refuse an inherited original runtime-surface marker before any spaced
    // fixture mutation (server, root, staging); the helper's entry guard is
    // defense in depth.
    const surfaceMarker = inheritedRuntimeSurfaceMarker();
    if (surfaceMarker !== undefined) {
      throw new Error(`inherited runtime-surface marker ${surfaceMarker} refuses the spaced preload scenario`);
    }
    const server = await startTestServer();
    const bootstrap = makeBootstrap(server.socketPath);
    // Compiled output staged into a temporary tree whose paths contain spaces,
    // matching the authorized host's quoted-path launch form.
    const root = mkdtempSync(join(tmpdir(), "sh preload "));
    try {
      // The exact staged module closure the spaced preload and reporter load:
      // six explicit compiled leaves under one shared ownership ledger, each
      // descriptor-checked and written exclusively; no stubs, no dynamic
      // substitution, no tree copying.
      stageModuleClosure(root, [
        { relative: "src/pi.js", source: join(__dirname, "..", "src/pi.js") },
        { relative: "src/session-host/protocol.js", source: join(__dirname, "..", "src/session-host/protocol.js") },
        { relative: "src/session-host/reporter.js", source: join(__dirname, "..", "src/session-host/reporter.js") },
        { relative: "src/session-host/bootstrap-preload.js", source: join(__dirname, "..", "src/session-host/bootstrap-preload.js") },
        { relative: "src/session-host/native-persistence.js", source: join(__dirname, "..", "src/session-host/native-persistence.js") },
        { relative: "src/session-host/owned-activity.js", source: join(__dirname, "..", "src/session-host/owned-activity.js") },
        { relative: "src/session-host/spawn-capability.js", source: join(__dirname, "..", "src/session-host/spawn-capability.js") },
        { relative: "src/session-host/startup-request.js", source: join(__dirname, "..", "src/session-host/startup-request.js") },
      ]);
      const spacedPreload = join(root, "src/session-host/bootstrap-preload.js");
      assert.ok(spacedPreload.includes(" "), "fixture preload path contains spaces");

      // Malformed and oversized restoration frames must both fall back to the
      // quote-aware strip of the spaced self flag.
      for (const restoreFrame of ["malformed", JSON.stringify({ original: "é".repeat(5_000) })]) {
        const { status, markerData, userFixturePath } = await runPreloadedChild({
          bootstrap,
          restoreFrameFor: () => restoreFrame,
          nodeOptionsFor: (userFixture) => `${nodeRequireOption(spacedPreload, true)} ${nodeRequireOption(userFixture, true)}`,
          expectedNodeOptionsFor: (userFixture) => nodeRequireOption(userFixture, true),
          fixturesRoot: root,
          reporterPath: join(root, "src/session-host/reporter.js"),
        });
        assert.equal(status, 0, "preloaded child exits cleanly (spaced self flag stripped)");
        assert.ok(userFixturePath.includes(" "), "per-invocation fixture directory stays inside the spaced tree");
        assert.equal(
          markerData.userFixture.nodeOptions,
          nodeRequireOption(userFixturePath, true),
          "user fixture receives exactly the original NODE_OPTIONS",
        );
        assert.ok(
          !markerData.userFixture.nodeOptions!.includes(nodeOptionsPath(spacedPreload)),
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
      // Retain the spaced tree and every per-invocation fixture directory/marker
      // as evidence; only the test server is torn down.
      await server.close();
    }
  });
});
