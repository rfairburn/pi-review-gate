/**
 * #682 native MCP lane: closed broker family, broker registration, and the
 * stdio relay entry.
 *
 * Everything here runs against real local sockets of a real broker, with
 * owned test fixtures under the worker root: an injected recording endpoint,
 * private bootstrap files, and one genuine compiled relay child. No provider
 * CLI, model, approval, configuration, or authority state is used.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { afterEach } from "node:test";

import {
  __test as brokerTest,
  createStatusBroker,
  type NativeMcpStatusBroker,
  type StatusBrokerStatusHandlers,
} from "../src/session-host/broker";
import {
  MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION,
  MAX_NATIVE_MCP_REQUEST_FRAME_BYTES,
  NativeMcpFrameReader,
  decodeNativeMcpBootstrap,
  decodeNativeMcpClientFrame,
  decodeNativeMcpHello,
  decodeNativeMcpServerFrame,
  encodeNativeMcpBootstrap,
  encodeNativeMcpClientFrame,
  encodeNativeMcpHello,
  type NativeMcpBootstrap,
} from "../src/session-host/native-mcp-protocol";
import {
  NATIVE_MCP_RELAY_BOOTSTRAP_FLAG,
  flushNativeMcpOutput,
  isProtectedNativeMcpSocketPath,
  openNativeMcpBrokerLane,
  type NativeMcpPathStats,
  readNativeMcpBootstrapFile,
  runNativeMcpRelay,
  type NativeMcpBrokerLane,
  type NativeMcpRelayOutcome,
} from "../src/session-host/native-mcp-relay";
import {
  NATIVE_MCP_ERROR,
  type NativeMcpCallToolRequest,
  type NativeMcpCallToolResult,
  type NativeMcpListToolsRequest,
  type NativeMcpStdioSession,
  type NativeMcpToolDescriptor,
  type NativeMcpToolEndpoint,
} from "../src/session-host/native-mcp-stdio";
import { encodeNativeHookFrame } from "../src/session-host/native-hook-protocol";
import { encodeFrame } from "../src/session-host/protocol";
import * as payloadTransport from "../src/session-host/payload";

type Json = Record<string, any>;

const INSTANCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTANCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INSTANCE_PI = "11111111-1111-4111-8111-111111111111";

const WINDOWS_PIPE_ADDRESS = /^\\\\\.\\pipe\\prg-st-[0-9a-f]{32}$/;
/** Cases that need a usable private bootstrap: the reader refuses every Windows bootstrap by design. */
const posixBootstrap = { skip: process.platform === "win32" ? "Private bootstrap requires POSIX ownership checks" : false };

// The worker root is longer than a Unix socket address allows. Keep every
// socket inode under the root and express only the bind/connect address
// relatively (the same fixture approach as the native hook lane tests).
function rootRelativeSocketAddress(address: string): string {
  if (WINDOWS_PIPE_ADDRESS.test(address)) return address;
  const relative = path.relative(process.cwd(), address);
  if (path.isAbsolute(address) && relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && Buffer.byteLength(address, "utf8") > 100) return `./${relative}`;
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

const originalServerListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
  args[0] = rootRelativeSocketArgument(args[0]);
  return Reflect.apply(originalServerListen, this, args) as net.Server;
} as typeof net.Server.prototype.listen;

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  if (Array.isArray(args[0]) && args[0].length > 0) args[0][0] = rootRelativeSocketArgument(args[0][0]);
  else if (typeof args[0] === "string") args[0] = { path: rootRelativeSocketAddress(args[0]) };
  else args[0] = rootRelativeSocketArgument(args[0]);
  return Reflect.apply(originalSocketConnect, this, args) as net.Socket;
} as typeof net.Socket.prototype.connect;

const brokers = new Set<NativeMcpStatusBroker>();
const scratchDirectories = new Set<string>();
const sockets = new Set<net.Socket>();

function makeScratch(prefix: string, root = process.cwd()): string {
  const directory = fs.mkdtempSync(path.join(root, prefix));
  fs.chmodSync(directory, 0o700);
  scratchDirectories.add(directory);
  return directory;
}

let socketScratchBase: string | undefined;

/**
 * Where positive POSIX socket fixtures may live. The relay (correctly) refuses
 * a socket another local user could replace, so a fixture under the checkout
 * only works when the checkout's ancestry passes that same production walk.
 * Probe it once with a private directory and a stand-in socket leaf: keep the
 * fixtures in the workspace when it qualifies, otherwise use canonical /tmp
 * (deliberately not os.tmpdir(): TMPDIR may point back into the checkout
 * that just failed). Positive bootstrap files use the same root, since the
 * reader applies the same walk.
 */
function socketScratchRoot(): string {
  if (process.platform === "win32") return process.cwd();
  if (socketScratchBase === undefined) {
    const probe = fs.mkdtempSync(path.join(process.cwd(), ".prg-mcp-probe-"));
    try {
      fs.chmodSync(probe, 0o700);
      const leaf = path.join(probe, "s.sock");
      const uid = BigInt(process.getuid!());
      const usable = isProtectedNativeMcpSocketPath(leaf, {
        lstat: (target) => target === leaf
          ? { uid, mode: 0o140700n, isDirectory: () => false, isSocket: () => true }
          : fs.lstatSync(target, { bigint: true }),
      });
      socketScratchBase = usable ? process.cwd() : fs.realpathSync("/tmp");
    } finally {
      fs.rmdirSync(probe);
    }
  }
  return socketScratchBase;
}

function makeProtectedScratch(prefix: string): string {
  return makeScratch(prefix, socketScratchRoot());
}

async function makeBroker(): Promise<NativeMcpStatusBroker> {
  brokerTest.setSocketPathLimitForTests(4096);
  const broker = await createStatusBroker({ socketRoot: makeProtectedScratch(".prg-mcp-") });
  brokers.add(broker);
  return broker;
}

afterEach(async () => {
  brokerTest.setNativeMcpInFlightLimitForTests(undefined);
  brokerTest.setSocketPathLimitForTests(undefined);
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const broker of brokers) {
    try {
      await broker.dispose();
    } catch {
      // Cleanup never masks an assertion; disposal is idempotent.
    }
  }
  brokers.clear();
  for (const directory of scratchDirectories) fs.rmSync(directory, { recursive: true, force: true });
  scratchDirectories.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const TOOLS: NativeMcpToolDescriptor[] = [
  { name: "SubtasksStart", description: "start", inputSchema: { type: "object" } },
  { name: "SubtasksInspect", description: "inspect", inputSchema: { type: "object" } },
];

/** Recording endpoint: the only thing the lane may reach. */
class RecordingEndpoint implements NativeMcpToolEndpoint {
  readonly listCalls: NativeMcpListToolsRequest[] = [];
  readonly calls: NativeMcpCallToolRequest[] = [];
  readonly held: Array<Deferred<NativeMcpCallToolResult | undefined>> = [];
  hold = false;
  respond: (request: NativeMcpCallToolRequest) => Promise<NativeMcpCallToolResult | undefined> = async (request) => ({
    content: [{ type: "text", text: `ran ${request.name}` }],
    isError: false,
  });

  async listTools(request: NativeMcpListToolsRequest): Promise<readonly NativeMcpToolDescriptor[]> {
    this.listCalls.push(request);
    return TOOLS;
  }

  callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined> {
    this.calls.push(request);
    if (this.hold) {
      const pending = deferred<NativeMcpCallToolResult | undefined>();
      this.held.push(pending);
      return pending.promise;
    }
    return this.respond(request);
  }
}

/** Raw broker client for exercising the wire family directly. */
class RawClient {
  readonly frames: Json[] = [];
  closed = false;
  private buffer = "";

  constructor(readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        this.frames.push(JSON.parse(this.buffer.slice(0, newline)));
        this.buffer = this.buffer.slice(newline + 1);
      }
    });
    socket.on("close", () => { this.closed = true; });
  }

  write(text: string): void {
    this.socket.write(text);
  }

  request(seq: number, op: "list" | "call", name?: string, args: Json = {}): void {
    this.write(op === "list"
      ? encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_request", seq, op })
      : encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_request", seq, op, name: name!, arguments: args }));
  }

  response(seq: number): Json | undefined {
    return this.frames.find((frame) => frame.type === "native_mcp_response" && frame.seq === seq);
  }
}

async function rawConnect(address: string): Promise<RawClient> {
  const socket = net.connect({ path: address });
  sockets.add(socket);
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return new RawClient(socket);
}

function helloLine(bootstrap: NativeMcpBootstrap, overrides: Partial<Record<"instanceId" | "generation" | "backend" | "token", string>> = {}): string {
  return `${JSON.stringify({
    version: 1,
    type: "native_mcp_hello",
    instanceId: overrides.instanceId ?? bootstrap.instanceId,
    generation: overrides.generation ?? bootstrap.generation,
    backend: overrides.backend ?? bootstrap.backend,
    token: overrides.token ?? bootstrap.token,
  })}\n`;
}

async function authenticate(bootstrap: NativeMcpBootstrap): Promise<RawClient> {
  const client = await rawConnect(bootstrap.socketPath);
  client.write(encodeNativeMcpHello(bootstrap));
  await waitFor(() => client.frames.length > 0 || client.closed, "ready or close");
  assert.deepEqual(client.frames[0], { version: 1, type: "native_mcp_ready" }, "the lane authenticates");
  return client;
}

/** Sends one hello and expects a silent close: no ready, no frame, nothing echoed. */
async function expectRefused(address: string, line: string, label: string): Promise<void> {
  const client = await rawConnect(address);
  client.write(line);
  await waitFor(() => client.closed, `${label} closed`);
  assert.deepEqual(client.frames, [], `${label}: closed silently without ready`);
}

function writeBootstrapFile(bootstrap: NativeMcpBootstrap, content?: string): string {
  const directory = makeProtectedScratch(".prg-mcp-bs-");
  const file = path.join(directory, "bootstrap.json");
  fs.writeFileSync(file, content ?? encodeNativeMcpBootstrap(bootstrap), { mode: 0o600, flag: "wx" });
  return file;
}

interface McpLaneCounts {
  inFlight: number;
  activeConnections: number;
  sources: number;
}

/** Focused test-only introspection; it exposes no token, request, or result data. */
function laneCounts(broker: NativeMcpStatusBroker): McpLaneCounts {
  return (broker as unknown as { __nativeMcpLaneCountsForTests(): McpLaneCounts }).__nativeMcpLaneCountsForTests();
}

function piHandlers(): StatusBrokerStatusHandlers {
  return { onStatus: () => undefined, onDisconnect: () => undefined };
}

// ---------------------------------------------------------------------------
// Closed wire family

test("the bootstrap record is canonical and closed, and no hook or Pi record parses as one", () => {
  const bootstrap: NativeMcpBootstrap = {
    version: 1,
    type: "native_mcp_bootstrap",
    socketPath: "/tmp/prg-st-x/s.sock",
    generation: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
    instanceId: INSTANCE_A,
    backend: "claude",
    token: "a".repeat(64),
  };
  const encoded = encodeNativeMcpBootstrap(bootstrap);
  assert.ok(encoded.endsWith("\n"));
  assert.deepEqual(decodeNativeMcpBootstrap(encoded), bootstrap);

  const parsed = JSON.parse(encoded);
  const variants = [
    JSON.stringify(parsed, null, 1) + "\n", // whitespace
    JSON.stringify({ ...parsed }), // no trailing newline
    `${encoded}\n`, // trailing data
    JSON.stringify({ token: parsed.token, ...parsed }) + "\n", // reordered
    encoded.replace(`"version":1,`, `"version":1,"version":1,`), // duplicate key
    JSON.stringify({ ...parsed, extra: true }) + "\n",
    JSON.stringify({ ...parsed, type: "native_hook_bootstrap" }) + "\n",
    JSON.stringify({ ...parsed, backend: "pi" }) + "\n",
    JSON.stringify({ ...parsed, token: "A".repeat(63) }) + "\n",
    JSON.stringify({ ...parsed, socketPath: "relative/s.sock" }) + "\n",
  ];
  for (const variant of variants) assert.equal(decodeNativeMcpBootstrap(variant), undefined, variant);
  // A native hook bootstrap (no `type`) is never a native MCP bootstrap.
  const { type: _type, ...hookShaped } = parsed;
  assert.equal(decodeNativeMcpBootstrap(`${JSON.stringify(hookShaped)}\n`), undefined);
});

test("hello, client, and server frames are strictly typed with closed keys", () => {
  const bootstrap: NativeMcpBootstrap = {
    version: 1, type: "native_mcp_bootstrap", socketPath: "/tmp/s", generation: "abc", instanceId: INSTANCE_A, backend: "codex", token: "b".repeat(64),
  };
  const hello = encodeNativeMcpHello(bootstrap);
  assert.deepEqual(decodeNativeMcpHello(hello), {
    version: 1, type: "native_mcp_hello", instanceId: INSTANCE_A, generation: "abc", backend: "codex", token: "b".repeat(64),
  });
  assert.equal(decodeNativeMcpHello(hello.replace(`"backend":"codex"`, `"backend":"codex","socketPath":"/x"`)), undefined);
  assert.equal(decodeNativeMcpHello(hello.replace("native_mcp_hello", "hello")), undefined);

  assert.deepEqual(decodeNativeMcpClientFrame(`{"version":1,"type":"native_mcp_request","seq":1,"op":"list"}`),
    { version: 1, type: "native_mcp_request", seq: 1, op: "list" });
  assert.deepEqual(decodeNativeMcpClientFrame(`{"version":1,"type":"native_mcp_request","seq":2,"op":"call","name":"X","arguments":{"a":1}}`),
    { version: 1, type: "native_mcp_request", seq: 2, op: "call", name: "X", arguments: { a: 1 } });
  // #682: one optional bounded tool-use matching key may ride a call.
  assert.deepEqual(decodeNativeMcpClientFrame(`{"version":1,"type":"native_mcp_request","seq":3,"op":"call","name":"X","arguments":{},"toolUseId":"toolu_01AB-c_9"}`),
    { version: 1, type: "native_mcp_request", seq: 3, op: "call", name: "X", arguments: {}, toolUseId: "toolu_01AB-c_9" });
  for (const bad of [
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"X","arguments":{},"toolUseId":""}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"X","arguments":{},"toolUseId":"a b"}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"X","arguments":{},"toolUseId":7}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"X","arguments":{},"toolUseId":"${"t".repeat(129)}"}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"list","toolUseId":"toolu_1"}`,
  ]) assert.equal(decodeNativeMcpClientFrame(bad), undefined, bad);
  for (const bad of [
    `{"version":1,"type":"native_mcp_request","seq":0,"op":"list"}`,
    `{"version":1,"type":"native_mcp_request","seq":1.5,"op":"list"}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"list","name":"X"}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"X","arguments":[]}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"","arguments":{}}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"${"n".repeat(129)}","arguments":{}}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"X","arguments":{},"_meta":{}}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"call","name":"X","arguments":{},"clientInfo":{}}`,
    `{"version":1,"type":"native_mcp_request","seq":1,"op":"exec"}`,
    `{"version":1,"type":"native_mcp_cancel","seq":1,"reason":"x"}`,
    `{"version":2,"type":"native_mcp_cancel","seq":1}`,
  ]) assert.equal(decodeNativeMcpClientFrame(bad), undefined, bad);

  assert.deepEqual(decodeNativeMcpServerFrame(`{"version":1,"type":"native_mcp_ready"}`), { version: 1, type: "native_mcp_ready" });
  assert.equal(decodeNativeMcpServerFrame(`{"version":1,"type":"native_mcp_response","seq":1,"outcome":"error","code":"retry"}`), undefined);
  assert.equal(decodeNativeMcpServerFrame(`{"version":1,"type":"native_mcp_response","seq":1,"outcome":"result","result":[]}`), undefined);
  assert.equal(decodeNativeMcpServerFrame(`{"version":1,"type":"native_mcp_ready","token":"x"}`), undefined);

  // A non-finite number would silently become null on the wire: refused instead.
  assert.throws(() => encodeNativeMcpClientFrame({
    version: 1, type: "native_mcp_request", seq: 1, op: "call", name: "X", arguments: { n: JSON.parse("1e400") },
  }), TypeError);
  assert.throws(() => encodeNativeMcpClientFrame({
    version: 1, type: "native_mcp_request", seq: 1, op: "call", name: "X", arguments: { big: "x".repeat(MAX_NATIVE_MCP_REQUEST_FRAME_BYTES) },
  }), RangeError);
});

test("the frame reader bounds partial frames before decoding and rejects invalid UTF-8", () => {
  const lines: string[] = [];
  const reader = new NativeMcpFrameReader(16);
  assert.equal(reader.push(Buffer.from("abc"), (line) => { lines.push(line); return true; }), "ok");
  assert.equal(reader.push(Buffer.from("de\nfg\n"), (line) => { lines.push(line); return true; }), "ok");
  assert.deepEqual(lines, ["abcde", "fg"]);
  const exact = new NativeMcpFrameReader(16);
  const exactLines: string[] = [];
  assert.equal(exact.push(Buffer.from(`${"y".repeat(15)}\n`), (line) => { exactLines.push(line); return true; }), "ok", "15 bytes plus the newline fit 16");
  assert.deepEqual(exactLines, ["y".repeat(15)]);
  // A byte-at-a-time sender at the exact bound is framed through one growing
  // buffer; one more byte overflows.
  const fragmented = new NativeMcpFrameReader(2049);
  const fragments: string[] = [];
  const collect = (line: string): boolean => { fragments.push(line); return true; };
  const byte = Buffer.from("a");
  for (let i = 0; i < 2048; i += 1) assert.equal(fragmented.push(byte, collect), "ok");
  assert.deepEqual(fragments, []);
  assert.equal(fragmented.push(Buffer.from("\nz\n"), collect), "ok");
  assert.deepEqual(fragments, ["a".repeat(2048), "z"]);
  const overByOne = new NativeMcpFrameReader(2049);
  for (let i = 0; i < 2048; i += 1) assert.equal(overByOne.push(byte, () => true), "ok");
  assert.equal(overByOne.push(byte, () => true), "overflow");
  assert.equal(reader.push(Buffer.from("x".repeat(16)), () => true), "overflow", "16 bytes plus the newline exceed 16");
  assert.equal(reader.push(Buffer.from("\n"), () => true), "overflow", "overflow is terminal");
  const utf8 = new NativeMcpFrameReader(16);
  assert.equal(utf8.push(Buffer.from([0xff, 0x0a]), () => true), "invalid_utf8");
  const stop = new NativeMcpFrameReader(16);
  const seen: string[] = [];
  assert.equal(stop.push(Buffer.from("a\nb\n"), (line) => { seen.push(line); return false; }), "stopped");
  assert.deepEqual(seen, ["a"], "bytes after a stop are never decoded");
  const bomReader = new NativeMcpFrameReader(64);
  const bomLines: string[] = [];
  bomReader.push(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{"version":1,"type":"native_mcp_ready"}\n`)]), (line) => { bomLines.push(line); return true; });
  assert.equal(bomLines[0]!.charCodeAt(0), 0xfeff, "a leading BOM is preserved, never stripped");
  assert.equal(decodeNativeMcpServerFrame(bomLines[0]!), undefined, "and the strict parse refuses it");
});

// ---------------------------------------------------------------------------
// Broker lane

test("an authenticated lane delivers only the operation, name, arguments, and signal", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  assert.equal(registration.bootstrap.socketPath, broker.socketPath, "the existing listener, no new address");
  assert.equal(registration.bootstrap.generation, broker.generation);
  const client = await authenticate(registration.bootstrap);

  client.request(1, "list");
  client.request(2, "call", "SubtasksStart", { kind: "execute", nested: { a: [1, 2] } });
  await waitFor(() => client.response(1) !== undefined && client.response(2) !== undefined, "responses");
  assert.deepEqual(client.response(1), { version: 1, type: "native_mcp_response", seq: 1, outcome: "result", result: { tools: TOOLS } });
  assert.deepEqual(client.response(2), {
    version: 1, type: "native_mcp_response", seq: 2, outcome: "result",
    result: { content: [{ type: "text", text: "ran SubtasksStart" }], isError: false },
  });
  assert.equal(endpoint.listCalls.length, 1);
  assert.deepEqual(Object.keys(endpoint.listCalls[0]!), ["signal"]);
  assert.equal(endpoint.calls.length, 1);
  assert.deepEqual(Object.keys(endpoint.calls[0]!).sort(), ["arguments", "name", "signal"]);
  assert.equal(endpoint.calls[0]!.name, "SubtasksStart");
  assert.deepEqual(endpoint.calls[0]!.arguments, { kind: "execute", nested: { a: [1, 2] } });

  endpoint.respond = async () => undefined;
  client.request(3, "call", "Nope");
  await waitFor(() => client.response(3) !== undefined, "unknown tool");
  endpoint.respond = async () => { throw new Error("SECRET owner failure"); };
  client.request(4, "call", "SubtasksStart");
  await waitFor(() => client.response(4) !== undefined, "failure");
  assert.equal(client.response(3)!.code, "unknown_tool");
  assert.deepEqual(client.response(4), { version: 1, type: "native_mcp_response", seq: 4, outcome: "error", code: "failed" });
  assert.equal(JSON.stringify(client.frames).includes("SECRET"), false, "owner failure text never crosses");
  assert.deepEqual(laneCounts(broker), { inFlight: 0, activeConnections: 1, sources: 1 });
});

test("wrong, stale, released, cross-family, and mismatched proofs never reach the endpoint", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const hook = broker.registerNativeHookSource(INSTANCE_A, "claude", { onEvent: () => undefined, onFailure: () => undefined });
  const otherEndpoint = new RecordingEndpoint();
  const other = broker.registerNativeMcpSource(INSTANCE_B, "claude", otherEndpoint);
  const pi = broker.register(INSTANCE_PI, piHandlers());
  const otherBroker = await makeBroker();
  const foreign = otherBroker.registerNativeMcpSource(INSTANCE_A, "claude", new RecordingEndpoint());
  const address = broker.socketPath;
  const bootstrap = registration.bootstrap;

  await expectRefused(address, helloLine(bootstrap, { token: "0".repeat(64) }), "wrong token");
  await expectRefused(address, helloLine(bootstrap, { token: hook.bootstrap.token }), "hook token");
  await expectRefused(address, helloLine(bootstrap, { token: pi.bootstrap.token }), "Pi token");
  await expectRefused(address, helloLine(bootstrap, { token: other.bootstrap.token }), "another row's token");
  await expectRefused(address, helloLine(bootstrap, { backend: "codex" }), "backend mismatch");
  await expectRefused(address, helloLine(bootstrap, { generation: otherBroker.generation }), "stale generation");
  await expectRefused(address, encodeNativeMcpHello(foreign.bootstrap), "another host generation's bootstrap");
  await expectRefused(address, helloLine(bootstrap, { instanceId: INSTANCE_PI, token: pi.bootstrap.token }), "Pi registration id");
  await expectRefused(address, helloLine(bootstrap, { instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), "unknown id");

  // The MCP token authenticates nothing in the other two families.
  await expectRefused(address, encodeFrame({
    version: 1, type: "hello", instanceId: INSTANCE_PI, generation: broker.generation, token: bootstrap.token,
  } as never), "MCP token as a Pi hello");
  await expectRefused(address, encodeNativeHookFrame({
    version: 1, type: "native_hook_event", instanceId: INSTANCE_A, generation: broker.generation, backend: "claude",
    token: bootstrap.token, hook_event_name: "SessionStart",
  }), "MCP token as a hook event");

  registration.release();
  await expectRefused(address, encodeNativeMcpHello(bootstrap), "released registration");

  assert.equal(endpoint.calls.length + endpoint.listCalls.length, 0);
  assert.equal(otherEndpoint.calls.length + otherEndpoint.listCalls.length, 0);
  // The still-valid neighbour lane is untouched by every refusal.
  const neighbour = await authenticate(other.bootstrap);
  neighbour.request(1, "list");
  await waitFor(() => neighbour.response(1) !== undefined, "neighbour list");
  assert.equal(otherEndpoint.listCalls.length, 1);
});

test("the first authenticated connection wins: no takeover and no re-admission after close", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "codex", endpoint);
  const first = await authenticate(registration.bootstrap);
  endpoint.hold = true;
  first.request(1, "call", "SubtasksStart");
  await waitFor(() => endpoint.calls.length === 1, "first call delivered");

  await expectRefused(broker.socketPath, encodeNativeMcpHello(registration.bootstrap), "takeover attempt");
  assert.equal(first.closed, false);
  assert.equal(endpoint.calls[0]!.signal.aborted, false, "a refused takeover does not disturb in-flight work");
  endpoint.held[0]!.resolve({ content: [{ type: "text", text: "done" }] });
  await waitFor(() => first.response(1) !== undefined, "first response");

  first.socket.destroy();
  await waitFor(() => laneCounts(broker).activeConnections === 0, "lane closed");
  await expectRefused(broker.socketPath, encodeNativeMcpHello(registration.bootstrap), "re-hello after close");
  assert.equal(endpoint.calls.length, 1);
});

test("registration is separate, revocable, and refused beside a Pi row or a duplicate lane", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  assert.throws(() => broker.registerNativeMcpSource(INSTANCE_A, "pi" as never, endpoint), /backend/);
  assert.throws(() => broker.registerNativeMcpSource("not an id", "claude", endpoint), /malformed/);
  assert.throws(() => broker.registerNativeMcpSource(INSTANCE_A, "claude", {} as never), /endpoint/);

  broker.register(INSTANCE_PI, piHandlers());
  assert.throws(() => broker.registerNativeMcpSource(INSTANCE_PI, "claude", endpoint), /separate family/);

  const first = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  assert.throws(() => broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint), /already exists/);
  assert.throws(() => broker.register(INSTANCE_A, piHandlers()), /native MCP source/);
  // The same launch's hook observer coexists with its tool lane.
  broker.registerNativeHookSource(INSTANCE_A, "claude", { onEvent: () => undefined, onFailure: () => undefined });

  first.release();
  first.release();
  const second = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  assert.notEqual(second.bootstrap.token, first.bootstrap.token, "a re-registration gets a fresh token");
  await expectRefused(broker.socketPath, encodeNativeMcpHello(first.bootstrap), "the previous token");
  await authenticate(second.bootstrap);

  await broker.dispose();
  assert.throws(() => broker.registerNativeMcpSource(INSTANCE_B, "claude", endpoint), /disposed/);
});

test("in-flight bounds answer busy before delivery, per connection and broker-wide", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = await authenticate(registration.bootstrap);
  for (let seq = 1; seq <= MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION + 1; seq += 1) client.request(seq, "call", "SubtasksStart");
  const busySeq = MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION + 1;
  await waitFor(() => client.response(busySeq) !== undefined, "busy");
  assert.equal(client.response(busySeq)!.code, "busy");
  assert.equal(endpoint.calls.length, MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION, "the refused request never reached the endpoint");
  for (const held of endpoint.held) held.resolve({ content: [] });
  await waitFor(() => laneCounts(broker).inFlight === 0, "slots released");

  brokerTest.setNativeMcpInFlightLimitForTests(1);
  const otherEndpoint = new RecordingEndpoint();
  const other = broker.registerNativeMcpSource(INSTANCE_B, "claude", otherEndpoint);
  const otherClient = await authenticate(other.bootstrap);
  client.request(20, "call", "SubtasksStart");
  await waitFor(() => endpoint.calls.length === MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION + 1, "global slot taken");
  otherClient.request(1, "list");
  await waitFor(() => otherClient.response(1) !== undefined, "global busy");
  assert.equal(otherClient.response(1)!.code, "busy");
  assert.equal(otherEndpoint.listCalls.length, 0);
});

test("cancel aborts the endpoint signal and the one response still settles the seq", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = await authenticate(registration.bootstrap);
  client.request(5, "call", "SubtasksStart");
  await waitFor(() => endpoint.calls.length === 1, "delivered");
  client.write(encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_cancel", seq: 5 }));
  await waitFor(() => endpoint.calls[0]!.signal.aborted, "aborted");
  client.write(encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_cancel", seq: 5 }));
  client.write(encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_cancel", seq: 2 }));
  await settle();
  assert.equal(client.closed, false, "a repeated or crossing cancel changes nothing");
  endpoint.held[0]!.resolve({ content: [{ type: "text", text: "late" }] });
  await waitFor(() => client.response(5) !== undefined, "response");
  assert.equal(client.frames.filter((frame) => frame.seq === 5).length, 1);
  assert.equal(endpoint.calls.length, 1);
});

test("protocol violations and oversized frames close the lane and abort in-flight work", async () => {
  const cases: Array<[string, (client: RawClient) => void]> = [
    ["seq reuse", (client) => client.request(1, "list")],
    ["seq regression", (client) => { client.request(5, "list"); client.request(4, "list"); }],
    ["cancel of an unsent seq", (client) => client.write(encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_cancel", seq: 99 }))],
    ["unknown frame", (client) => client.write(`{"version":1,"type":"native_mcp_request","seq":7,"op":"exec"}\n`)],
    ["a Pi frame after auth", (client) => client.write(`{"version":1,"type":"hello"}\n`)],
    ["invalid UTF-8", (client) => client.socket.write(Buffer.from([0xff, 0x0a]))],
    ["oversized frame", (client) => client.write("x".repeat(MAX_NATIVE_MCP_REQUEST_FRAME_BYTES))],
    ["BOM-prefixed frame", (client) => client.write(`\uFEFF${encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_request", seq: 9, op: "list" })}`)],
  ];
  for (const [label, violate] of cases) {
    const broker = await makeBroker();
    const endpoint = new RecordingEndpoint();
    endpoint.hold = true;
    const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
    const client = await authenticate(registration.bootstrap);
    client.request(1, "call", "SubtasksStart");
    await waitFor(() => endpoint.calls.length === 1, `${label}: delivered`);
    violate(client);
    await waitFor(() => client.closed, `${label}: closed`);
    assert.equal(endpoint.calls[0]!.signal.aborted, true, `${label}: in-flight signal aborted`);
    endpoint.held[0]!.resolve({ content: [] });
    await settle(10);
    assert.equal(client.response(1), undefined, `${label}: a late result is dropped`);
    assert.equal(endpoint.calls.length, 1, `${label}: nothing replayed`);
    assert.deepEqual(laneCounts(broker), { inFlight: 0, activeConnections: 0, sources: 1 });
  }
});

test("release and dispose abort in-flight endpoint signals and drop late results", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = await authenticate(registration.bootstrap);
  client.request(1, "call", "SubtasksStart");
  await waitFor(() => endpoint.calls.length === 1, "delivered");
  registration.release();
  await waitFor(() => client.closed, "release closes the lane");
  assert.equal(endpoint.calls[0]!.signal.aborted, true);
  endpoint.held[0]!.resolve({ content: [] });
  await settle(10);
  assert.deepEqual(client.frames, [{ version: 1, type: "native_mcp_ready" }]);
  assert.deepEqual(laneCounts(broker), { inFlight: 0, activeConnections: 0, sources: 0 });

  const disposeBroker = await makeBroker();
  const disposeEndpoint = new RecordingEndpoint();
  disposeEndpoint.hold = true;
  const disposeRegistration = disposeBroker.registerNativeMcpSource(INSTANCE_B, "codex", disposeEndpoint);
  const disposeClient = await authenticate(disposeRegistration.bootstrap);
  disposeClient.request(1, "list");
  disposeClient.request(2, "call", "SubtasksInspect");
  await waitFor(() => disposeEndpoint.calls.length === 1, "delivered before dispose");
  await disposeBroker.dispose();
  await waitFor(() => disposeClient.closed, "dispose closes the lane");
  assert.equal(disposeEndpoint.calls[0]!.signal.aborted, true);
});

test("disposal aborts MCP work before waiting for Pi payload cleanup", async (t) => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const { bootstrap } = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = await authenticate(bootstrap);
  client.request(1, "call", "SubtasksStart");
  await waitFor(() => endpoint.calls.length === 1, "MCP call delivered");

  // Hold one unrelated Pi payload cleanup open for the whole disposal.
  const cleanup = deferred<void>();
  const discard = t.mock.method(payloadTransport, "discardSessionHostPayload", () => cleanup.promise);
  const { instanceId, generation, token } = broker.register(INSTANCE_PI, piHandlers()).bootstrap;
  const pi = await rawConnect(broker.socketPath);
  pi.write(encodeFrame({ version: 1, type: "hello", instanceId, generation, token }) + encodeFrame({
    version: 1, type: "spawn_request", instanceId, generation, token,
    requestId: INSTANCE_B, workspace: process.cwd(), title: "Refused fixture",
    payload: { name: `p-${"a".repeat(32)}.json`, size: 1, sha256: "b".repeat(64) },
  } as never));
  await waitFor(() => discard.mock.callCount() === 1, "Pi cleanup held open");

  const { signal } = endpoint.calls[0]!;
  let revokedWhenAborted: boolean | undefined;
  let reentered: Promise<void> | undefined;
  signal.addEventListener("abort", () => {
    revokedWhenAborted = laneCounts(broker).sources === 0;
    reentered = broker.dispose();
  }, { once: true });
  const disposal = broker.dispose();
  try {
    assert.equal(signal.aborted, true, "abort does not wait for Pi cleanup");
    assert.equal(revokedWhenAborted, true, "every MCP registration was revoked before any abort");
    assert.equal(reentered, disposal, "reentrant disposal joins the same teardown");
    assert.equal(laneCounts(broker).inFlight, 1, "the owner has not settled yet, so its slot stays held");
    await waitFor(() => client.closed, "lane closed while cleanup is pending");
  } finally {
    endpoint.held[0]!.resolve({ content: [] });
    cleanup.resolve(undefined);
    await disposal;
  }
  assert.equal(client.response(1), undefined, "the late result was dropped");
  assert.equal(laneCounts(broker).inFlight, 0, "the slot returned once the owner settled");
});

test("peer EOF aborts native MCP work even while a reply is backpressured", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const { bootstrap } = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = await authenticate(bootstrap);
  // Stop reading so the first reply backs up inside the broker.
  client.socket.pause();
  client.request(1, "call", "SubtasksStart");
  client.request(2, "call", "SubtasksInspect");
  await waitFor(() => endpoint.calls.length === 2, "both calls delivered");
  try {
    endpoint.held[0]!.resolve({ content: [{ type: "text", text: "r".repeat(8 * 1024 * 1024) }] });
    await waitFor(() => laneCounts(broker).inFlight === 1, "large reply queued");
    assert.equal(endpoint.calls[1]!.signal.aborted, false);
    client.socket.end();
    await waitFor(() => endpoint.calls[1]!.signal.aborted, "peer EOF aborts the held call without draining the reply");
    assert.equal(laneCounts(broker).inFlight, 1, "the aborted call still holds its slot");
    assert.equal(laneCounts(broker).activeConnections, 0, "the lane is closed");
  } finally {
    endpoint.held[1]!.resolve({ content: [] });
  }
  await waitFor(() => laneCounts(broker).inFlight === 0, "slot returned once the endpoint settles");
  assert.equal(endpoint.calls.length, 2, "nothing replayed");
});

test("the broker caps queued replies in UTF-8 bytes", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const { bootstrap } = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = await authenticate(bootstrap);
  client.socket.pause();
  for (let seq = 1; seq <= 3; seq += 1) client.request(seq, "call", "SubtasksInspect");
  await waitFor(() => endpoint.calls.length === 3, "three calls delivered");
  // U+0800 is 3 UTF-8 bytes but 1 UTF-16 unit. Each reply (~15 MiB) fits the
  // 16 MiB frame bound alone; three queued replies exceed the 32 MiB cap in
  // bytes, though only ~15 Mi units counted as strings.
  const text = "\u0800".repeat(5 * 1024 * 1024);
  for (const held of endpoint.held) held.resolve({ content: [{ type: "text", text }] });
  await waitFor(() => laneCounts(broker).activeConnections === 0, "queued UTF-8 bytes close the lane", 10_000);
  assert.equal(client.response(1), undefined, "the paused reader never resumed");
});

test("a closed lane keeps its broker-wide slots until the endpoint actually settles", async () => {
  brokerTest.setNativeMcpInFlightLimitForTests(1);
  const broker = await makeBroker();
  const slow = new RecordingEndpoint();
  slow.hold = true;
  const first = broker.registerNativeMcpSource(INSTANCE_A, "claude", slow);
  const firstClient = await authenticate(first.bootstrap);
  firstClient.request(1, "call", "SubtasksStart");
  await waitFor(() => slow.calls.length === 1, "slow call delivered");

  first.release();
  await waitFor(() => firstClient.closed, "released lane closed");
  assert.equal(slow.calls[0]!.signal.aborted, true, "the owner was told to stop");
  assert.deepEqual(laneCounts(broker), { inFlight: 1, activeConnections: 0, sources: 0 }, "but its slot stays counted");

  const nextEndpoint = new RecordingEndpoint();
  const next = broker.registerNativeMcpSource(INSTANCE_B, "claude", nextEndpoint);
  const nextClient = await authenticate(next.bootstrap);
  nextClient.request(1, "list");
  nextClient.request(2, "call", "SubtasksStart");
  await waitFor(() => nextClient.response(2) !== undefined, "busy while old work runs");
  assert.equal(nextClient.response(1)!.code, "busy");
  assert.equal(nextClient.response(2)!.code, "busy");
  assert.equal(nextEndpoint.listCalls.length + nextEndpoint.calls.length, 0, "no dispatch past the global bound");

  slow.held[0]!.resolve({ content: [{ type: "text", text: "finished after abort" }] });
  await waitFor(() => laneCounts(broker).inFlight === 0, "slot returned on settlement");
  assert.equal(firstClient.response(1), undefined, "the late result is still dropped");
  nextClient.request(3, "call", "SubtasksStart");
  await waitFor(() => nextClient.response(3) !== undefined, "admission resumes");
  assert.equal(nextClient.response(3)!.outcome, "result");
  assert.equal(nextEndpoint.calls.length, 1);
});

test("a BOM-prefixed hello is not a native MCP hello", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  await expectRefused(broker.socketPath, `\uFEFF${encodeNativeMcpHello(registration.bootstrap)}`, "BOM-prefixed hello");
  await authenticate(registration.bootstrap);
});

test("an oversized completed call is reported as result_too_large, never as not run", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.respond = async () => ({ content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }] });
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = await authenticate(registration.bootstrap);
  client.request(1, "call", "SubtasksStart");
  await waitFor(() => client.response(1) !== undefined, "withheld response", 10_000);
  assert.deepEqual(client.response(1), { version: 1, type: "native_mcp_response", seq: 1, outcome: "error", code: "result_too_large" });
});

// ---------------------------------------------------------------------------
// Bootstrap file reader

test("the bootstrap file is read once only when private, owned, regular, single-link, bounded, and canonical", posixBootstrap, async () => {
  const broker = await makeBroker();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", new RecordingEndpoint());
  const bootstrap = registration.bootstrap;

  const valid = writeBootstrapFile(bootstrap);
  assert.deepEqual(readNativeMcpBootstrapFile(valid), { ok: true, bootstrap });
  assert.equal(fs.existsSync(valid), false, "a valid bootstrap is consumed");
  assert.deepEqual(readNativeMcpBootstrapFile(valid), { ok: false, reason: "file_invalid" }, "and cannot be read twice");

  assert.deepEqual(readNativeMcpBootstrapFile("relative/bootstrap.json"), { ok: false, reason: "path_invalid" });

  const groupReadable = writeBootstrapFile(bootstrap);
  fs.chmodSync(groupReadable, 0o640);
  assert.deepEqual(readNativeMcpBootstrapFile(groupReadable), { ok: false, reason: "file_invalid" });
  assert.equal(fs.existsSync(groupReadable), true, "a refused file is left for its owner");

  const openParent = writeBootstrapFile(bootstrap);
  fs.chmodSync(path.dirname(openParent), 0o755);
  assert.deepEqual(readNativeMcpBootstrapFile(openParent), { ok: false, reason: "parent_invalid" });

  const target = writeBootstrapFile(bootstrap);
  const symlink = path.join(path.dirname(target), "link.json");
  fs.symlinkSync(target, symlink);
  assert.deepEqual(readNativeMcpBootstrapFile(symlink), { ok: false, reason: "file_invalid" });

  const linked = writeBootstrapFile(bootstrap);
  fs.linkSync(linked, path.join(path.dirname(linked), "alias.json"));
  assert.deepEqual(readNativeMcpBootstrapFile(linked), { ok: false, reason: "file_invalid" });

  const fifoDirectory = makeProtectedScratch(".prg-mcp-bs-");
  const fifo = path.join(fifoDirectory, "bootstrap.json");
  const made = spawn("mkfifo", ["-m", "600", fifo], { stdio: "ignore" });
  const fifoCode = await new Promise<number | null>((resolve) => { made.on("close", resolve); made.on("error", () => resolve(null)); });
  if (fifoCode === 0) assert.deepEqual(readNativeMcpBootstrapFile(fifo), { ok: false, reason: "file_invalid" });

  const oversized = writeBootstrapFile(bootstrap, "x".repeat(4097));
  assert.deepEqual(readNativeMcpBootstrapFile(oversized), { ok: false, reason: "file_invalid" });

  const pretty = writeBootstrapFile(bootstrap, `${JSON.stringify(bootstrap, null, 2)}\n`);
  assert.deepEqual(readNativeMcpBootstrapFile(pretty), { ok: false, reason: "record_invalid" });
  assert.equal(fs.existsSync(pretty), true);

  const { type: _type, ...hookShaped } = bootstrap;
  const hookRecord = writeBootstrapFile(bootstrap, `${JSON.stringify(hookShaped)}\n`);
  assert.deepEqual(readNativeMcpBootstrapFile(hookRecord), { ok: false, reason: "record_invalid" });

  const notUtf8 = writeBootstrapFile(bootstrap, "");
  fs.writeFileSync(notUtf8, Buffer.from([0xff, 0xfe, 0x0a]));
  assert.deepEqual(readNativeMcpBootstrapFile(notUtf8), { ok: false, reason: "record_invalid" });

  // A BOM is never part of the canonical encoding, so it is refused, not stripped.
  const bom = writeBootstrapFile(bootstrap, `\uFEFF${encodeNativeMcpBootstrap(bootstrap)}`);
  assert.equal(fs.readFileSync(bom)[0], 0xef, "the fixture really starts with a UTF-8 BOM");
  assert.deepEqual(readNativeMcpBootstrapFile(bom), { ok: false, reason: "record_invalid" });
  assert.equal(fs.existsSync(bom), true);
});

test("a bootstrap beneath a replaceable ancestor is refused before any file lookup and left untouched", posixBootstrap, async () => {
  const broker = await makeBroker();
  const { bootstrap } = broker.registerNativeMcpSource(INSTANCE_A, "claude", new RecordingEndpoint());
  const file = writeBootstrapFile(bootstrap);
  const parent = path.dirname(file);
  const grandparent = path.dirname(parent);
  const lookups: string[] = [];
  // The real tree, except one ancestor reported world-writable and non-sticky,
  // with no private directory above it (a tree the worker root cannot hold).
  const replaceable = (target: string): NativeMcpPathStats => {
    lookups.push(target);
    const real = fs.lstatSync(target, { bigint: true });
    if (target === grandparent) return { uid: real.uid, mode: 0o40777n, isDirectory: () => true, isSocket: () => false };
    const shieldStripped = target !== parent && (real.mode & 0o077n) === 0n ? real.mode | 0o055n : real.mode;
    return { uid: real.uid, mode: shieldStripped, isDirectory: () => real.isDirectory(), isSocket: () => real.isSocket() };
  };
  assert.deepEqual(readNativeMcpBootstrapFile(file, { ancestryLstat: replaceable }), { ok: false, reason: "parent_invalid" });
  assert.equal(lookups.includes(file), false, "the file itself was never looked up");
  assert.equal(fs.existsSync(file), true, "a refused bootstrap is never consumed");

  // A symlinked ancestor on the real filesystem is refused the same way.
  const viaLink = path.join(makeProtectedScratch(".prg-mcp-ln-"), "via");
  fs.symlinkSync(parent, viaLink);
  assert.deepEqual(readNativeMcpBootstrapFile(path.join(viaLink, path.basename(file))), { ok: false, reason: "parent_invalid" });
  assert.equal(fs.existsSync(file), true);

  // The same file through its protected real path is valid (and consumed).
  assert.deepEqual(readNativeMcpBootstrapFile(file), { ok: true, bootstrap });
  assert.equal(fs.existsSync(file), false);
});

test("an unverifiable Windows bootstrap is refused without consumption", async () => {
  const broker = await makeBroker();
  const { bootstrap } = broker.registerNativeMcpSource(INSTANCE_A, "claude", new RecordingEndpoint());
  const file = writeBootstrapFile(bootstrap);
  const options = process.platform === "win32" ? undefined : { platform: "win32" as const };
  assert.deepEqual(readNativeMcpBootstrapFile(file, options), { ok: false, reason: "platform_unverifiable" });
  assert.equal(fs.existsSync(file), true, "a Windows bootstrap is never read or consumed");
});

// ---------------------------------------------------------------------------
// stdio -> relay -> real broker -> injected endpoint

class StdioClient {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly frames: Json[] = [];
  private buffer = "";

  constructor() {
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        this.frames.push(JSON.parse(this.buffer.slice(0, newline)));
        this.buffer = this.buffer.slice(newline + 1);
      }
    });
  }

  send(message: Json): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  async response(id: number | string, label = `response ${id}`): Promise<Json> {
    await waitFor(() => this.frames.some((frame) => frame.id === id), label);
    return this.frames.find((frame) => frame.id === id)!;
  }

  async initialize(): Promise<Json> {
    this.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claimed-owner", version: "9" } } });
    const result = await this.response(0);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }
}

interface StartedRelay {
  outcome: Promise<NativeMcpRelayOutcome>;
  started: Promise<{ session: NativeMcpStdioSession; lane: NativeMcpBrokerLane }>;
}

function startRelay(file: string, client: StdioClient, env: NodeJS.ProcessEnv = {}): StartedRelay {
  const started = deferred<{ session: NativeMcpStdioSession; lane: NativeMcpBrokerLane }>();
  const outcome = runNativeMcpRelay({
    argv: [NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, file],
    env,
    input: client.input,
    output: client.output,
    onStarted: (session, lane) => started.resolve({ session, lane }),
  });
  void outcome.then((value) => { if (value.status !== "ended") started.reject(new Error(value.status)); });
  return { outcome, started: started.promise };
}

test("stdio -> relay -> real broker -> endpoint forwards only validated operations", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const file = writeBootstrapFile(registration.bootstrap);
  const client = new StdioClient();
  const relay = startRelay(file, client);
  await relay.started;
  assert.equal(fs.existsSync(file), false, "the relay consumed its bootstrap");

  const init = await client.initialize();
  assert.equal(init.result.serverInfo.name, "pi-review-gate");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { progressToken: "p" } } });
  assert.deepEqual((await client.response(1)).result, { tools: TOOLS });
  client.send({
    jsonrpc: "2.0", id: "call-1", method: "tools/call",
    params: { name: "SubtasksStart", arguments: { kind: "execute", prompt: "do it" }, _meta: { progressToken: 7, owner: "claimed" } },
  });
  assert.deepEqual((await client.response("call-1")).result, { content: [{ type: "text", text: "ran SubtasksStart" }], isError: false });

  assert.equal(endpoint.calls.length, 1);
  assert.deepEqual(Object.keys(endpoint.calls[0]!).sort(), ["arguments", "name", "signal"], "no id, _meta, or clientInfo crosses");
  assert.deepEqual(endpoint.calls[0]!.arguments, { kind: "execute", prompt: "do it" });
  assert.equal(JSON.stringify(endpoint.calls[0]!.arguments).includes("claimed"), false);

  // #682: Claude's `_meta["claudecode/toolUseId"]` crosses relay and broker as the one
  // bounded matching key, and nothing else from `_meta` does.
  client.send({
    jsonrpc: "2.0", id: "call-2", method: "tools/call",
    params: { name: "SubtasksStart", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_01XYZ", owner: "claimed" } },
  });
  assert.deepEqual((await client.response("call-2")).result, { content: [{ type: "text", text: "ran SubtasksStart" }], isError: false });
  assert.equal(endpoint.calls.length, 2);
  assert.deepEqual(Object.keys(endpoint.calls[1]!).sort(), ["arguments", "name", "signal", "toolUseId"]);
  assert.equal(endpoint.calls[1]!.toolUseId, "toolu_01XYZ");

  endpoint.respond = async () => undefined;
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "Missing" } });
  assert.equal((await client.response(2)).error.code, NATIVE_MCP_ERROR.invalidParams);
  endpoint.respond = async () => { throw new Error("SECRET"); };
  client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "SubtasksStart" } });
  const failed = await client.response(3);
  assert.equal(failed.error.code, NATIVE_MCP_ERROR.internalError);
  assert.match(failed.error.message, /not retried and its effects are unknown/);
  // Raw text: the stdio parser yields Infinity, which JSON would silently
  // re-encode as null. The relay refuses to send it, and says nothing ran.
  const callsBefore = endpoint.calls.length;
  client.input.write(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"SubtasksStart","arguments":{"n":1e400}}}\n`);
  const unencodable = await client.response(4);
  assert.equal(unencodable.result.isError, true);
  assert.match(unencodable.result.content[0].text, /not sent and nothing ran/);
  assert.equal(endpoint.calls.length, callsBefore, "an unfaithful request never reaches the endpoint");

  client.input.end();
  const outcome = await relay.outcome;
  assert.deepEqual(outcome, { status: "ended", reason: "input_ended", laneClosedFirst: false });
  await waitFor(() => laneCounts(broker).activeConnections === 0, "lane closed with the session");
  assert.equal(JSON.stringify(client.frames).includes(registration.bootstrap.token), false);
});

test("MCP cancellation crosses as one cancel; stdin end aborts in-flight work at the owner", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const client = new StdioClient();
  const relay = startRelay(writeBootstrapFile(registration.bootstrap), client);
  await relay.started;
  await client.initialize();

  client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } });
  await waitFor(() => endpoint.calls.length === 1, "delivered");
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
  await waitFor(() => endpoint.calls[0]!.signal.aborted, "owner signal aborted by cancel");
  endpoint.held[0]!.resolve({ content: [{ type: "text", text: "late" }] });
  await settle();
  assert.equal(client.frames.some((frame) => frame.id === 1), false, "a cancelled request gets no response");

  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "SubtasksStart" } });
  await waitFor(() => endpoint.calls.length === 2, "second delivered");
  client.input.end();
  await relay.outcome;
  await waitFor(() => endpoint.calls[1]!.signal.aborted, "stdin end aborts in-flight owner work");
  assert.equal(endpoint.calls.length, 2, "nothing replayed");
});

test("revocation mid-call is an unknown outcome, later calls are not sent, and nothing is replayed", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "codex", endpoint);
  const client = new StdioClient();
  const relay = startRelay(writeBootstrapFile(registration.bootstrap), client);
  const { lane } = await relay.started;
  await client.initialize();

  client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } });
  await waitFor(() => endpoint.calls.length === 1, "delivered");
  registration.release();
  const lost = await client.response(1);
  assert.equal(lost.error.code, NATIVE_MCP_ERROR.internalError);
  assert.match(lost.error.message, /not retried and its effects are unknown/);
  assert.equal(endpoint.calls[0]!.signal.aborted, true);
  assert.equal(lane.isClosed, true);

  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "SubtasksStart" } });
  const notSent = await client.response(2);
  assert.equal(notSent.result.isError, true);
  assert.match(notSent.result.content[0].text, /not sent and nothing ran/);
  client.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal((await client.response(3)).error.code, NATIVE_MCP_ERROR.internalError);
  assert.equal(endpoint.calls.length, 1, "no reconnect and no replay");

  client.input.end();
  assert.deepEqual(await relay.outcome, { status: "ended", reason: "input_ended", laneClosedFirst: true });
});

test("the relay fails closed on worker roles, bad argv, invalid or stale bootstraps", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const run = (argv: string[], env: NodeJS.ProcessEnv = {}): Promise<NativeMcpRelayOutcome> =>
    runNativeMcpRelay({ argv, env, input: new PassThrough(), output: new PassThrough() });

  const untouched = writeBootstrapFile(registration.bootstrap);
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, untouched], { PI_REVIEW_GATE_RUNTIME_ROLE: "executor" }), { status: "worker_role" });
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, untouched], { pi_review_gate_executor_tool_catalog: "" }), { status: "worker_role" });
  assert.equal(fs.existsSync(untouched), true, "a worker-role refusal never reads the bootstrap");

  assert.deepEqual(await run([]), { status: "usage" });
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG]), { status: "usage" });
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, untouched, "--extra"]), { status: "usage" });
  assert.deepEqual(await run(["--bootstrap", untouched]), { status: "usage" });
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, `${untouched}.missing`]), { status: "bootstrap_invalid" });

  // A forged token in an otherwise valid private file is refused by the broker.
  const forged = writeBootstrapFile({ ...registration.bootstrap, token: "f".repeat(64) });
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, forged]), { status: "refused" });
  registration.release();
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, untouched]), { status: "refused" }, "a released bootstrap is stale");
  await broker.dispose();
  const gone = writeBootstrapFile({ ...registration.bootstrap });
  // The disposed broker's socket no longer exists: refused before any connect.
  assert.deepEqual(await run([NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, gone]), { status: "unprotected" });
  assert.equal(endpoint.calls.length + endpoint.listCalls.length, 0);
});

test("the socket-path walk trusts only paths no other local user can replace", () => {
  const me = 1000n;
  type Entry = { uid: bigint; mode: number; kind: "dir" | "socket" | "symlink" };
  const check = (tree: Record<string, Entry>, socketPath = "/srv/a/b/s.sock"): boolean =>
    isProtectedNativeMcpSocketPath(socketPath, {
      uid: me,
      lstat: (p): NativeMcpPathStats => {
        const entry = tree[p];
        if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return {
          uid: entry.uid,
          mode: BigInt(entry.mode),
          isDirectory: () => entry.kind === "dir",
          isSocket: () => entry.kind === "socket",
        };
      },
    });
  const base = (): Record<string, Entry> => ({
    "/": { uid: 0n, mode: 0o755, kind: "dir" },
    "/srv": { uid: 0n, mode: 0o755, kind: "dir" },
    "/srv/a": { uid: me, mode: 0o755, kind: "dir" },
    "/srv/a/b": { uid: me, mode: 0o700, kind: "dir" },
    "/srv/a/b/s.sock": { uid: me, mode: 0o755, kind: "socket" },
  });
  assert.equal(check(base()), true, "a root/self-owned, non-writable chain to a private directory");

  // The reviewer's case: a writable, non-sticky ancestor with no shield above.
  const writableAncestor = base();
  writableAncestor["/srv"] = { uid: 0n, mode: 0o777, kind: "dir" };
  assert.equal(check(writableAncestor), false, "a world-writable ancestor makes the path replaceable");
  const groupWritable = base();
  groupWritable["/srv/a"] = { uid: me, mode: 0o775, kind: "dir" };
  assert.equal(check(groupWritable), false, "group write on a non-sticky parent is refused too");

  const sticky = base();
  sticky["/srv"] = { uid: 0n, mode: 0o1777, kind: "dir" };
  assert.equal(check(sticky), true, "a sticky shared directory (like /tmp) protects entries it does not own");

  // A private ancestor shields everything below it, whatever the lower modes.
  const shielded: Record<string, Entry> = {
    "/": { uid: 0n, mode: 0o755, kind: "dir" },
    "/srv": { uid: 0n, mode: 0o1777, kind: "dir" },
    "/srv/a": { uid: me, mode: 0o700, kind: "dir" },
    "/srv/a/b": { uid: me, mode: 0o775, kind: "dir" },
    "/srv/a/b/c": { uid: me, mode: 0o700, kind: "dir" },
    "/srv/a/b/c/s.sock": { uid: me, mode: 0o755, kind: "socket" },
  };
  assert.equal(check(shielded, "/srv/a/b/c/s.sock"), true, "others cannot search into a private ancestor");
  const shieldBelowWritable = { ...shielded, "/srv": { uid: 0n, mode: 0o777, kind: "dir" as const } };
  assert.equal(check(shieldBelowWritable, "/srv/a/b/c/s.sock"), false, "a shield that is itself replaceable shields nothing");

  const symlink = base();
  symlink["/srv/a"] = { uid: me, mode: 0o755, kind: "symlink" };
  assert.equal(check(symlink), false, "a symlinked component is never followed");
  const foreign = base();
  foreign["/srv/a"] = { uid: 2000n, mode: 0o755, kind: "dir" };
  assert.equal(check(foreign), false, "a component owned by another user is refused");
  const openSocketDirectory = base();
  openSocketDirectory["/srv/a/b"] = { uid: me, mode: 0o750, kind: "dir" };
  assert.equal(check(openSocketDirectory), false, "the socket's own directory must be private");
  const foreignSocket = base();
  foreignSocket["/srv/a/b/s.sock"] = { uid: 2000n, mode: 0o755, kind: "socket" };
  assert.equal(check(foreignSocket), false, "the socket must be owned by this user");
  const notSocket = base();
  notSocket["/srv/a/b/s.sock"] = { uid: me, mode: 0o600, kind: "dir" };
  assert.equal(check(notSocket), false);
  assert.equal(check(base(), "/srv/a/b/../b/s.sock"), false, "only a normalized absolute path");
  assert.equal(check(base(), "relative/s.sock"), false);
  assert.equal(check(base(), "/srv/a/b/missing.sock"), false, "a missing socket is not trusted");
});

test("the relay never connects to an unprotected broker path, and does connect to a protected one", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const { bootstrap } = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const transportDir = path.dirname(broker.socketPath);
  let attempts = 0;
  const countingConnect = (address: string): net.Socket => { attempts += 1; return net.connect({ path: address }); };

  fs.chmodSync(transportDir, 0o755);
  try {
    assert.deepEqual(await openNativeMcpBrokerLane(bootstrap, { connect: countingConnect }), { ok: false, reason: "unprotected" });
  } finally {
    fs.chmodSync(transportDir, 0o700);
  }
  const symlinkDir = makeScratch(".prg-mcp-ln-");
  const linked = path.join(symlinkDir, "via");
  fs.symlinkSync(transportDir, linked);
  assert.deepEqual(await openNativeMcpBrokerLane({ ...bootstrap, socketPath: path.join(linked, path.basename(broker.socketPath)) }, { connect: countingConnect }),
    { ok: false, reason: "unprotected" });
  assert.equal(attempts, 0, "no connection was attempted, so no hello (token) was ever sent");

  // A protected path whose connect fails is unreachable (nothing was delivered).
  const failingConnect = (): net.Socket => net.connect({ path: path.join(makeScratch(".prg-mcp-none-"), "absent.sock") });
  assert.deepEqual(await openNativeMcpBrokerLane(bootstrap, { connect: failingConnect }), { ok: false, reason: "unreachable" });

  // The same bootstrap through the protected real path authenticates.
  const opened = await openNativeMcpBrokerLane(bootstrap, { connect: countingConnect });
  assert.equal(opened.ok, true);
  assert.equal(attempts, 1);
  (opened as { lane: NativeMcpBrokerLane }).lane.close();
  assert.equal(endpoint.calls.length + endpoint.listCalls.length, 0);
});

test("the exported lane enforces its own pending bound before using a seq or sending a byte", async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  endpoint.hold = true;
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const opened = await openNativeMcpBrokerLane(registration.bootstrap);
  assert.equal(opened.ok, true);
  const lane = (opened as { lane: NativeMcpBrokerLane }).lane;
  const signal = new AbortController().signal;
  const held = Array.from({ length: MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION }, () =>
    lane.callTool({ name: "SubtasksStart", arguments: {}, signal }).catch(() => undefined));
  await waitFor(() => endpoint.calls.length === MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION, "held calls at the broker");
  assert.equal(lane.pendingCount, MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION);

  // Refused locally and synchronously: no pending entry, seq, or byte is
  // created (the broker's own bound would also answer busy, but only after a send).
  const refusing = lane.callTool({ name: "SubtasksStart", arguments: {}, signal });
  assert.equal(lane.pendingCount, MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION, "refused before a pending entry exists");
  const refused = await refusing;
  assert.equal(refused?.isError, true);
  assert.match(String(refused?.content[0]?.text), /busy; the call was not run/);
  await assert.rejects(lane.listTools({ signal }), "a refused list is not a result");
  assert.equal(lane.pendingCount, MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION, "nothing was added");
  await settle();
  assert.equal(endpoint.calls.length, MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION, "nothing reached the broker");
  assert.equal(endpoint.listCalls.length, 0);

  // A freed slot admits the next call, with the next unused seq.
  endpoint.held[0]!.resolve({ content: [{ type: "text", text: "one done" }] });
  await waitFor(() => lane.pendingCount === MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION - 1, "slot freed");
  void lane.callTool({ name: "SubtasksInspect", arguments: {}, signal }).catch(() => undefined);
  await waitFor(() => endpoint.calls.length === MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION + 1, "admitted after a slot freed");

  lane.close();
  for (const pending of endpoint.held) pending.resolve({ content: [] });
  await Promise.all(held);
});

/** A scripted local socket fixture standing in for a misbehaving broker. */
async function scriptedServer(onConnection: (socket: net.Socket) => void): Promise<{ address: string; close(): Promise<void> }> {
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\prg-st-${randomBytes(16).toString("hex")}`
    : path.join(makeProtectedScratch(".prg-mcp-srv-"), "s.sock");
  const own = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    sockets.add(socket);
    own.add(socket);
    onConnection(socket);
    // Keep the fixture flowing so a peer close is always observed.
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));
  return {
    address,
    close: () => new Promise<void>((resolve) => {
      for (const socket of own) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

test("the relay lane bounds its handshake and closes on untrustworthy broker output", async () => {
  const bootstrapFor = (address: string): NativeMcpBootstrap => ({
    version: 1, type: "native_mcp_bootstrap", socketPath: address, generation: "abc", instanceId: INSTANCE_A, backend: "claude", token: "c".repeat(64),
  });
  const ready = `{"version":1,"type":"native_mcp_ready"}\n`;

  const silent = await scriptedServer(() => undefined);
  assert.deepEqual(await openNativeMcpBrokerLane(bootstrapFor(silent.address), { readyMs: 50 }), { ok: false, reason: "timeout" });
  await silent.close();

  const closing = await scriptedServer((socket) => socket.once("data", () => socket.destroy()));
  assert.deepEqual(await openNativeMcpBrokerLane(bootstrapFor(closing.address)), { ok: false, reason: "refused" });
  await closing.close();

  for (const reply of [`{"version":1,"type":"native_mcp_response","seq":1,"outcome":"error","code":"busy"}\n`, `${ready}{"x":1}\n`, "x".repeat(200)]) {
    const garbage = await scriptedServer((socket) => socket.once("data", () => socket.write(reply)));
    assert.deepEqual(await openNativeMcpBrokerLane(bootstrapFor(garbage.address)), { ok: false, reason: "protocol" }, reply);
    await garbage.close();
  }

  // After ready, an uncorrelated answer makes the stream untrustworthy: the
  // in-flight call becomes an unknown outcome and nothing is resent.
  const received: string[] = [];
  const uncorrelated = await scriptedServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received.push(chunk);
      if (received.length === 1) socket.write(ready);
      else socket.write(`{"version":1,"type":"native_mcp_response","seq":99,"outcome":"error","code":"failed"}\n`);
    });
  });
  const opened = await openNativeMcpBrokerLane(bootstrapFor(uncorrelated.address));
  assert.equal(opened.ok, true);
  const lane = (opened as { lane: NativeMcpBrokerLane }).lane;
  await assert.rejects(lane.callTool({ name: "SubtasksStart", arguments: {}, signal: new AbortController().signal }));
  assert.equal(lane.isClosed, true);
  const notSent = await lane.callTool({ name: "SubtasksStart", arguments: {}, signal: new AbortController().signal });
  assert.equal(notSent?.isError, true);
  assert.equal(received.join("").split("\n").filter((line) => line.includes("native_mcp_request")).length, 1, "the call was sent once");
  await uncorrelated.close();
});

// ---------------------------------------------------------------------------
// Genuine compiled relay child

function writeSocketPathPreload(): string {
  const directory = makeScratch(".prg-mcp-pre-");
  const file = path.join(directory, "socket-path-shim.cjs");
  fs.writeFileSync(file, `
const net = require("node:net");
const path = require("node:path");
const original = net.Socket.prototype.connect;
function shorten(address) {
  if (typeof address !== "string" || !path.isAbsolute(address) || Buffer.byteLength(address, "utf8") <= 100) return address;
  const relative = path.relative(process.cwd(), address);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep)) return address;
  return "./" + relative;
}
net.Socket.prototype.connect = function (...args) {
  if (Array.isArray(args[0]) && args[0].length > 0) {
    const first = args[0][0];
    if (typeof first === "string") args[0][0] = { path: shorten(first) };
    else if (first && typeof first === "object" && typeof first.path === "string") args[0][0] = { ...first, path: shorten(first.path) };
  } else if (typeof args[0] === "string") args[0] = { path: shorten(args[0]) };
  else if (args[0] && typeof args[0] === "object" && typeof args[0].path === "string") args[0] = { ...args[0], path: shorten(args[0].path) };
  return original.apply(this, args);
};
`, { mode: 0o600 });
  return file;
}

test("the genuine compiled relay serves MCP over its own stdio and keeps secrets out of argv, env, and output", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const file = writeBootstrapFile(registration.bootstrap);
  const entry = path.join(__dirname, "..", "src", "session-host", "native-mcp-relay.js");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require=${writeSocketPathPreload()}` };
  const argv = [entry, NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, file];
  assert.equal(JSON.stringify([argv, env]).includes(registration.bootstrap.token), false, "the token is in neither argv nor env");

  const child = spawn(process.execPath, argv, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  const frames = (): Json[] => stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const send = (message: Json): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };

  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
  await waitFor(() => frames().some((frame) => frame.id === 0), "child initialize", 8000);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksInspect", arguments: { id: "x" } } });
  await waitFor(() => frames().some((frame) => frame.id === 1), "child call", 8000);
  assert.deepEqual(frames().find((frame) => frame.id === 1)!.result, { content: [{ type: "text", text: "ran SubtasksInspect" }], isError: false });
  assert.deepEqual(endpoint.calls.map((call) => [call.name, call.arguments]), [["SubtasksInspect", { id: "x" }]]);
  assert.equal(fs.existsSync(file), false, "the child consumed its bootstrap");

  child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(stderr, "");
  assert.equal(stdout.includes(registration.bootstrap.token), false);
  assert.ok(frames().every((frame) => frame.jsonrpc === "2.0"), "stdout carries MCP messages only");
  await waitFor(() => laneCounts(broker).activeConnections === 0, "child lane closed");

  // A startup refusal writes exactly one closed code and nothing secret.
  const refusedFile = writeBootstrapFile(registration.bootstrap);
  const refused = spawn(process.execPath, [entry, NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, refusedFile], {
    cwd: process.cwd(), env: { ...env, PI_REVIEW_GATE_RUNTIME_ROLE: "executor" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let refusedErr = "";
  let refusedOut = "";
  refused.stderr.setEncoding("utf8");
  refused.stdout.setEncoding("utf8");
  refused.stderr.on("data", (chunk: string) => { refusedErr += chunk; });
  refused.stdout.on("data", (chunk: string) => { refusedOut += chunk; });
  const refusedCode = await new Promise<number | null>((resolve) => refused.once("close", resolve));
  assert.equal(refusedCode, 1);
  assert.equal(refusedErr, "pi-review-gate native MCP relay: worker_role\n");
  assert.equal(refusedOut, "");
  assert.equal(fs.existsSync(refusedFile), true);
});

test("the output flush barrier waits for accepted bytes and never reports a failed flush as clean", async () => {
  let release: (() => void) | undefined;
  const slow = new Writable({ write(_chunk, _encoding, callback) { release = () => callback(); } });
  slow.write("pending reply");
  let flushed: boolean | undefined;
  void flushNativeMcpOutput(slow, 2000).then((value) => { flushed = value; });
  await settle(30);
  assert.equal(flushed, undefined, "no exit while an accepted write is still pending");
  release!();
  await settle(10);
  assert.equal(flushed, undefined, "the barrier write is ordered behind the pending one");
  // The empty barrier write itself reaches _write next; complete it too.
  release!();
  await waitFor(() => flushed === true, "flushed after the pending write completed");

  const stuck = new Writable({ write() { /* never completes */ } });
  stuck.write("never flushed");
  assert.equal(await flushNativeMcpOutput(stuck, 30), false, "an unreadable pipe is bounded and not clean");

  // The deadline alone must keep a process alive until it settles: in a fresh
  // process with no other handle, a stuck stream still yields `false`.
  const relayModule = path.join(__dirname, "..", "src", "session-host", "native-mcp-relay.js");
  const script = `
    const { Writable } = require("node:stream");
    const { flushNativeMcpOutput } = require(${JSON.stringify(relayModule)});
    const stuck = new Writable({ write() {} });
    stuck.write("never flushed");
    flushNativeMcpOutput(stuck, 50).then((flushed) => process.stdout.write("settled:" + flushed));
  `;
  const isolated = spawn(process.execPath, ["-e", script], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
  let isolatedOut = "";
  isolated.stdout.setEncoding("utf8");
  isolated.stdout.on("data", (chunk: string) => { isolatedOut += chunk; });
  isolated.stderr.resume();
  assert.equal(await new Promise<number | null>((resolve) => isolated.once("close", resolve)), 0);
  assert.equal(isolatedOut, "settled:false", "the bounded deadline settled instead of the loop draining first");

  const failing = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("EPIPE")); } });
  failing.on("error", () => undefined);
  assert.equal(await flushNativeMcpOutput(failing, 2000), false, "a write error is not clean");

  const done = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  done.end();
  await settle(5);
  assert.equal(await flushNativeMcpOutput(done, 2000), true, "nothing pending on a finished stream is clean");
});

test("the compiled relay flushes a reply already handed to stdout before exiting", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const payload = "r".repeat(4 * 1024 * 1024);
  endpoint.respond = async () => ({ content: [{ type: "text", text: payload }] });
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const file = writeBootstrapFile(registration.bootstrap);
  const entry = path.join(__dirname, "..", "src", "session-host", "native-mcp-relay.js");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require=${writeSocketPathPreload()}` };
  const child = spawn(process.execPath, [entry, NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, file], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const ended = new Promise<void>((resolve) => child.stdout.once("end", () => resolve()));
  // Pull-mode reading: with no 'data' listener the parent stops reading at its
  // buffer bound, so the child's pipe really fills.
  const pull = (): void => {
    let chunk: Buffer | null;
    while ((chunk = child.stdout.read() as Buffer | null) !== null) chunks.push(chunk);
  };
  const text = (): string => Buffer.concat(chunks).toString("utf8");
  const send = (message: Json): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };

  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
  await waitFor(() => { pull(); return text().includes(`"id":0`); }, "initialize", 8000);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // Stop reading, let the large reply start, then close the session while
  // most of that reply is still pending inside the child.
  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } });
  await waitFor(() => endpoint.calls.length === 1, "large call delivered", 8000);
  await waitFor(() => child.stdout.readableLength > 0, "reply started", 8000);
  await settle(200);
  child.kill("SIGTERM");
  await settle(300);
  // Resume reading, still in pull mode only.
  child.stdout.on("readable", pull);
  pull();

  assert.equal(await exited, 0, "a flushed reply is a clean exit");
  await ended;
  assert.equal((text().match(/r/g) ?? []).length >= payload.length, true, `received ${(text().match(/r/g) ?? []).length} of ${payload.length} payload bytes`);
  assert.equal(stderr, "");
  assert.ok(text().endsWith("\n"), "the final frame is complete");
  const reply = text().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json).find((frame) => frame.id === 1);
  assert.ok(reply, "the whole reply frame arrived");
  assert.equal(reply!.result.content[0].text.length, payload.length);
});

test("the compiled relay exits nonzero with a fixed code when the stdio session closes abnormally", posixBootstrap, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "claude", endpoint);
  const file = writeBootstrapFile(registration.bootstrap);
  const entry = path.join(__dirname, "..", "src", "session-host", "native-mcp-relay.js");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require=${writeSocketPathPreload()}` };
  const child = spawn(process.execPath, [entry, NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, file], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } })}\n`);
  await waitFor(() => stdout.includes(`"id":0`), "initialize", 8000);
  // Invalid UTF-8 makes the byte stream untrustworthy: the adapter answers
  // once with an uncorrelated error and closes the session.
  child.stdin.write(Buffer.from([0xff, 0xfe, 0x0a]));

  assert.equal(await exited, 1, "an abnormal closure is never a clean exit");
  assert.equal(stderr, "pi-review-gate native MCP relay: invalid_encoding\n");
  assert.ok(stdout.endsWith("\n"), "the error frame is complete");
  const frames = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json);
  assert.deepEqual(frames.at(-1), { jsonrpc: "2.0", id: null, error: { code: NATIVE_MCP_ERROR.parseError, message: "Parse error" } });
  assert.equal(stdout.includes(registration.bootstrap.token) || stderr.includes(registration.bootstrap.token), false);
  assert.equal(endpoint.calls.length + endpoint.listCalls.length, 0);
});

test("#682: the Claude tool-use key is Claude-only — a Codex relay never forwards it and a Codex lane rejects it", posixBootstrap, async () => {
  for (const backend of ["claude", "codex"] as const) {
    const broker = await makeBroker();
    const endpoint = new RecordingEndpoint();
    const registration = broker.registerNativeMcpSource(INSTANCE_A, backend, endpoint);
    const client = new StdioClient();
    const relay = startRelay(writeBootstrapFile(registration.bootstrap), client);
    await relay.started;
    await client.initialize();
    client.send({
      jsonrpc: "2.0", id: "meta-call", method: "tools/call",
      params: { name: "SubtasksStart", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_01META" } },
    });
    assert.deepEqual((await client.response("meta-call")).result, { content: [{ type: "text", text: "ran SubtasksStart" }], isError: false });
    assert.equal(endpoint.calls.length, 1, backend);
    assert.deepEqual(Object.keys(endpoint.calls[0]!).sort(),
      backend === "claude" ? ["arguments", "name", "signal", "toolUseId"] : ["arguments", "name", "signal"],
      `${backend}: the same metadata-bearing stdio call`);
    if (backend === "claude") assert.equal(endpoint.calls[0]!.toolUseId, "toolu_01META");
    client.input.end();
    await relay.outcome;
  }

  // At the broker, a Codex lane still treats the field as an unexpected one.
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_A, "codex", endpoint);
  const raw = await authenticate(registration.bootstrap);
  raw.write(encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_request", seq: 1, op: "call", name: "SubtasksStart", arguments: {}, toolUseId: "toolu_01X" }));
  await waitFor(() => raw.closed, "the Codex lane closes on the extra field");
  assert.equal(endpoint.calls.length, 0, "the endpoint is never reached");
  assert.equal(raw.response(1), undefined);
});
