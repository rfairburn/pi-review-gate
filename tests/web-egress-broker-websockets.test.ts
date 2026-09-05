import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import test from "node:test";
import { chromium } from "playwright";
import { chromiumEgressArgs } from "../src/web/browser";
import {
  DEFAULT_EGRESS_BUDGETS,
  EgressBroker,
  type BrokerAuth,
  type BrokerDial,
  type EgressBudgets,
  type EgressBrokerObserver,
  type EgressBrokerWebSocketPolicy,
} from "../src/web/egress-broker";
import type { HostResolver } from "../src/web/network";

// Focused coverage for the OPT-IN browser-owned live WebSocket transport
// (EgressBrokerWebSocketPolicy). Default OFF keeps passive extraction
// unchanged: every upgrade is refused before any dial. Opted in, the broker
// relays authenticated plain-ws upgrades to validated public destinations
// (proxy credentials stripped, admission/DNS pinning/budgets unchanged), keeps
// wss inside its ordinary opaque CONNECT tunnel, and lets the owner retain
// quiet live connections without ordinary idle eviction while every hard
// budget and broker teardown still fail closed.

const publicAnswer = "203.0.114.1"; // adjacent to TEST-NET-3, not blocked
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type AnyServer = net.Server | tls.Server;
type ClosableServer = AnyServer & { closeAllConnections?: () => void };

async function listen(server: AnyServer, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (address as AddressInfo).port;
}

async function close(server: AnyServer): Promise<void> {
  const closable = server as ClosableServer;
  closable.closeAllConnections?.();
  await new Promise<void>((resolveClose) => {
    const timer = setTimeout(() => {
      closable.closeAllConnections?.();
      resolveClose();
    }, 5_000);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolveClose();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms).unref?.());
}

async function withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function loopbackDial(dials: Array<{ hostname: string; port: number; address: string }> = []): BrokerDial {
  return (validated, port) => {
    dials.push({ hostname: validated.hostname, port, address: validated.addresses[0] ?? "" });
    return net.connect({ host: "127.0.0.1", port });
  };
}

interface BrokerHarness {
  broker: EgressBroker;
  port: number;
  dials: Array<{ hostname: string; port: number; address: string }>;
  stop(): Promise<void>;
}

function startBroker(
  resolver: HostResolver,
  options: {
    budgets?: Partial<EgressBudgets>;
    auth?: BrokerAuth;
    websockets?: EgressBrokerWebSocketPolicy;
    observer?: EgressBrokerObserver;
  } = {},
): Promise<BrokerHarness> {
  const dials: Array<{ hostname: string; port: number; address: string }> = [];
  const broker = new EgressBroker(
    resolver,
    loopbackDial(dials),
    { ...DEFAULT_EGRESS_BUDGETS, ...options.budgets },
    options.auth,
    options.observer,
    options.websockets,
  );
  return broker.start().then((port) => ({
    broker,
    port,
    dials,
    stop: async () => {
      await broker.close();
    },
  }));
}

function testAuth(): { auth: BrokerAuth; credentials: string } {
  const auth: BrokerAuth = { username: "pi-review-gate", password: randomBytes(24).toString("base64url") };
  return { auth, credentials: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}` };
}

/** Test-only resolver: pins TEST hostnames to loopback answers, refuses the rest. */
function testResolver(mapping: Record<string, string[]>): HostResolver {
  return (hostname) => {
    const answer = mapping[hostname];
    if (answer) return Promise.resolve(answer);
    return Promise.resolve([]);
  };
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 echo origin (no WebSocket dependency; handshakes and single
// text frames only, which is all the broker ever transports opaquely).
// ---------------------------------------------------------------------------

interface EchoOrigin {
  server: AnyServer;
  port: number;
  connections: number;
  handshakes: number;
  /** Upgrade request headers seen at the origin (credential-leak probe). */
  seenUpgradeHeaders: Array<Record<string, string>>;
  /** Upgrade response statuses the origin sent (e.g. a deliberate 404). */
  handshakeStatuses: number[];
  frames: string[];
}

function echoHandler(socket: net.Socket, origin: EchoOrigin, failPath?: string, initialFrame?: string): void {
  origin.connections += 1;
  let buffer = Buffer.alloc(0);
  let established = false;
  const cleanup = () => socket.destroy();
  socket.on("error", cleanup);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!established) {
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const head = buffer.subarray(0, headEnd).toString("utf8");
      buffer = buffer.subarray(headEnd + 4);
      const lines = head.split("\r\n");
      const requestLine = lines[0] ?? "";
      const headers: Record<string, string> = {};
      for (let index = 1; index < lines.length; index += 1) {
        const separator = lines[index]!.indexOf(":");
        if (separator === -1) continue;
        headers[lines[index]!.slice(0, separator).trim().toLowerCase()] = lines[index]!.slice(separator + 1).trim();
      }
      origin.seenUpgradeHeaders.push(headers);
      if (failPath && requestLine.includes(` ${failPath} `)) {
        origin.handshakeStatuses.push(404);
        socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        cleanup();
        return;
      }
      const key = headers["sec-websocket-key"];
      if (!key) {
        origin.handshakeStatuses.push(400);
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        cleanup();
        return;
      }
      origin.handshakes += 1;
      origin.handshakeStatuses.push(101);
      const accept = createHash("sha1").update(`${key}${WS_GUID}`, "utf8").digest("base64");
      const head101 = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
      // One write coalesces the 101 with the first server-initiated frame,
      // exactly what a live origin that immediately sends initial state does
      // (one TCP segment, no segmentation the broker could rely on).
      socket.write(initialFrame !== undefined
        ? Buffer.concat([Buffer.from(head101, "latin1"), encodeFrame(0x1, Buffer.from(initialFrame, "utf8"))])
        : head101);
      established = true;
    }
    // Frame loop after (or across) the handshake boundary.
    for (;;) {
      const frame = readFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        socket.write(encodeFrame(0x8, frame.payload));
        cleanup();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(0xA, frame.payload));
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        origin.frames.push(frame.payload.toString("utf8"));
        socket.write(encodeFrame(frame.opcode, frame.payload));
      }
    }
  });
}

function echoOrigin(tlsOptions?: tls.TlsOptions, failPath?: string, initialFrame?: string): Promise<EchoOrigin> {
  const origin: EchoOrigin = {
    server: undefined as unknown as AnyServer,
    port: 0,
    connections: 0,
    handshakes: 0,
    seenUpgradeHeaders: [],
    handshakeStatuses: [],
    frames: [],
  };
  const server: AnyServer = tlsOptions
    ? tls.createServer(tlsOptions, (socket) => echoHandler(socket, origin, failPath, initialFrame))
    : net.createServer((socket) => echoHandler(socket, origin, failPath, initialFrame));
  origin.server = server;
  return listen(server, "127.0.0.1").then((port) => {
    origin.port = port;
    return origin;
  });
}

interface WsFrame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

function readFrame(buffer: Buffer): WsFrame | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return { opcode, payload, consumed: offset + length };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Raw origin that emits a controlled response (possibly split across writes)
 * once the request head arrives — used for oversized/malformed response-head
 * regressions where the exact byte layout on the wire matters.
 */
interface RawHeadOrigin {
  server: net.Server;
  port: number;
  connections(): number;
}

function rawHeadOrigin(emit: (socket: net.Socket) => void | Promise<void>): Promise<RawHeadOrigin> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.on("error", () => undefined);
    let pending = Buffer.alloc(0);
    let responded = false;
    socket.on("data", (chunk: Buffer) => {
      if (responded) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.indexOf("\r\n\r\n") === -1) return;
      responded = true;
      void emit(socket);
    });
  });
  return listen(server).then((port) => ({ server, port, connections: () => connections }));
}

// ---------------------------------------------------------------------------
// Minimal raw ws client through the broker (absolute-form upgrade requests,
// exactly what a browser sends to an HTTP proxy for ws://).
// ---------------------------------------------------------------------------

class TestWsClient {
  readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private readonly pendingFrames: WsFrame[] = [];
  private readonly waiters: Array<(frame: WsFrame) => void> = [];

  constructor(port: number) {
    this.socket = net.connect({ host: "127.0.0.1", port });
    this.socket.on("error", () => undefined);
    this.socket.on("data", (chunk: Buffer) => {
      // Frame parsing starts only once the HTTP handshake head is consumed.
      if (this.handshakeComplete) this.ingestFrames(chunk);
    });
  }

  private handshakeComplete = false;

  /** Send an (optionally authenticated) absolute-form ws upgrade request. */
  async handshake(
    hostname: string,
    port: number,
    credentials: string | undefined,
    options: { path?: string; method?: string; upgrade?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<{ status: number; head: string }> {
    const path = options.path ?? "/echo";
    const method = options.method ?? "GET";
    const lines = [
      `${method} http://${hostname}:${port}${path} HTTP/1.1`,
      `Host: ${hostname}:${port}`,
      `Upgrade: ${options.upgrade ?? "websocket"}`,
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
    ];
    if (credentials) lines.push(`Proxy-Authorization: ${credentials}`);
    for (const [name, value] of Object.entries(options.extraHeaders ?? {})) lines.push(`${name}: ${value}`);
    const request = `${lines.join("\r\n")}\r\n\r\n`;
    const responseHead = await withTimeout(new Promise<string>((resolveHead, rejectHead) => {
      const onChunk = (chunk: Buffer) => {
        // Head bytes only: never feed the handshake through the frame parser.
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        this.socket.off("close", onClose);
        const head = this.buffer.subarray(0, end).toString("latin1");
        const rest = this.buffer.subarray(end + 4);
        this.buffer = Buffer.alloc(0);
        this.handshakeComplete = true;
        resolveHead(head);
        if (rest.length > 0) this.ingestFrames(rest);
      };
      const onClose = () => {
        this.socket.off("data", onChunk);
        rejectHead(new Error(`connection closed before a handshake response (${this.buffer.length} bytes buffered)`));
      };
      this.socket.on("data", onChunk);
      this.socket.once("close", onClose);
      this.socket.write(request);
    }), 4_000, "ws handshake");
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(responseHead)?.[1] ?? 0);
    return { status, head: responseHead };
  }

  private ingestFrames(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = readFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frame.consumed);
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.pendingFrames.push(frame);
    }
  }

  send(text: string): void {
    // Client frames are masked per RFC 6455.
    const payload = Buffer.from(text, "utf8");
    const mask = randomBytes(4);
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) masked[index] = masked[index]! ^ mask[index % 4]!;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  receive(ms = 4_000): Promise<WsFrame> {
    const pending = this.pendingFrames.shift();
    if (pending) return Promise.resolve(pending);
    return withTimeout(new Promise((resolveFrame) => this.waiters.push(resolveFrame)), ms, "ws frame");
  }

  closedWithin(ms: number): Promise<boolean> {
    if (this.socket.destroyed || this.socket.readyState === "closed") return Promise.resolve(true);
    return withTimeout(new Promise<boolean>((resolveClosed) => {
      const timer = setTimeout(() => resolveClosed(false), ms);
      timer.unref?.();
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolveClosed(true);
      });
    }), ms + 1_000, "socket close");
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function originConnections(origin: EchoOrigin): Promise<number> {
  return new Promise((resolveCount) => {
    origin.server.getConnections((error, connections) => resolveCount(error ? -1 : connections ?? -1));
  });
}

async function expectOriginDrained(origin: EchoOrigin): Promise<void> {
  for (let attempts = 40; attempts > 0; attempts -= 1) {
    if (await originConnections(origin) === 0) return;
    await sleep(50);
  }
  assert.fail("the echo origin still holds connections after the broker closed");
}

// Self-signed TLS fixture for wss origins (Chromium trusts it only through the
// test-local --ignore-certificate-errors launch flag; the broker itself never
// terminates TLS). Generated at runtime; tests skip when openssl is missing.
async function tlsFixture(): Promise<{ key: string; cert: string } | undefined> {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "egress-ws-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    await promisify(execFile)(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certPath,
        "-subj", "/CN=wss.test", "-addext", "subjectAltName=DNS:wss.test"],
      { timeout: 15_000 },
    );
    return { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
  } catch {
    return undefined;
  }
}

const chromiumInstalled = (() => {
  try {
    return chromium.executablePath().length > 0;
  } catch {
    return false;
  }
})();

function pageWebSocketProbe(page: import("playwright").Page, url: string, message: string): Promise<{ ok: boolean; echoed?: string; error?: string }> {
  return page.evaluate(({ probeUrl, probeMessage }) => new Promise((resolve) => {
    const ws = new WebSocket(probeUrl);
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 8_000);
    timer.unref?.();
    ws.onopen = () => ws.send(probeMessage);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true, echoed: String(event.data) });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "error" });
    };
  }), { probeUrl: url, probeMessage: message });
}

// ---------------------------------------------------------------------------
// Default OFF: passive behavior unchanged, upgrades refused before any dial.
// ---------------------------------------------------------------------------

test("default broker refuses ws upgrades and CONNECT-with-upgrade-headers before any dial", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer], "http.test": [publicAnswer] }));
  const client = new TestWsClient(harness.port);
  const passive = await echoOrigin();
  try {
    const refused = await client.handshake("ws.test", origin.port, credentials);
    assert.equal(refused.status, 403, "the default must refuse the upgrade fail-closed");
    assert.equal(harness.dials.length, 0, "no destination may be dialed for a refused upgrade");
    assert.equal(origin.connections, 0, "the origin must receive zero connections");
    assert.ok(harness.broker.summary().refusals >= 1);
    assert.ok(
      harness.broker.summary().omissions.some((omission) => omission.includes("live WebSocket transport is not enabled")),
      "the refusal must disclose that the opt-in is off",
    );
    client.destroy();

    // CONNECT carrying WebSocket headers stays refused (never tunneled raw).
    const tunneled = await new Promise<number>((resolveStatus) => {
      const request = net.connect({ host: "127.0.0.1", port: harness.port }, () => {
        request.write(
          `CONNECT ws.test:${origin.port} HTTP/1.1\r\nHost: ws.test:${origin.port}\r\n`
          + "Upgrade: websocket\r\nConnection: Upgrade\r\nProxy-Authorization: Basic dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      request.on("data", (chunk: Buffer) => {
        resolveStatus(Number(/^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString("latin1"))?.[1] ?? 0));
        request.destroy();
      });
      request.on("error", () => resolveStatus(0));
    });
    assert.equal(tunneled, 403, "CONNECT with upgrade headers must stay refused");

    // The default passive HTTP path still works unchanged (plain responder).
    passive.server.removeAllListeners("connection");
    passive.server.on("connection", (socket: net.Socket) => {
      socket.on("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 10\r\n\r\nhttp-ok-ok"));
    });
    const plain = await new Promise<string>((resolveBody) => {
      const request = net.connect({ host: "127.0.0.1", port: harness.port }, () => {
        request.write(`GET http://http.test:${passive.port}/ HTTP/1.1\r\nHost: http.test\r\nConnection: close\r\n\r\n`);
      });
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("close", () => resolveBody(body));
      request.on("error", () => resolveBody(body));
    });
    assert.ok(plain.includes("200 OK") && plain.includes("http-ok-ok"), "default plain proxying is unchanged");
    assert.equal(harness.broker.summary().ledger.filter((entry) => entry.kind === "http").length, 1);
  } finally {
    client.destroy();
    await harness.stop();
    await Promise.all([close(origin.server), close(passive.server)]);
  }
});

test("unauthenticated upgrades are challenged with 407 even when the owner opted in", async () => {
  const origin = await echoOrigin();
  const { auth } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    websockets: { enabled: true, liveIdleSocketMs: null },
  });
  const client = new TestWsClient(harness.port);
  try {
    const challenged = await client.handshake("ws.test", origin.port, undefined);
    assert.equal(challenged.status, 407);
    assert.ok(challenged.head.includes("Proxy-Authenticate: Basic realm="));
    assert.equal(harness.dials.length, 0, "a 407 challenge must never dial");
    assert.equal(origin.connections, 0);
    assert.equal(harness.broker.summary().refusals, 0, "407 challenges are not policy refusals");
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

// ---------------------------------------------------------------------------
// Opted-in plain ws: authenticated upgrade, validation, bidirectional echo.
// ---------------------------------------------------------------------------

test("opted-in plain ws upgrades handshake and echo bidirectionally through the broker", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  try {
    const handshake = await client.handshake("ws.test", origin.port, credentials);
    assert.equal(handshake.status, 101, "the broker must relay the origin's 101");
    assert.ok(handshake.head.includes("Sec-WebSocket-Accept"), "the origin accept key must reach the browser");
    // Bidirectional traffic: client -> origin echo.
    client.send("broker-echo-probe");
    const echoed = await client.receive();
    assert.equal(echoed.payload.toString("utf8"), "broker-echo-probe");
    // One validated, pinned dial with hostname semantics intact.
    assert.deepEqual(harness.dials, [{ hostname: "ws.test", port: origin.port, address: publicAnswer }]);
    const entry = harness.broker.summary().ledger[0];
    assert.equal(entry?.kind, "ws");
    assert.equal(entry?.hostname, "ws.test");
    assert.equal(entry?.address, publicAnswer);
    assert.ok((entry?.bytesSent ?? 0) > 0 && (entry?.bytesReceived ?? 0) > 0, "both directions are byte-accounted");
    assert.equal(harness.broker.summary().refusals, 0);
    // Proxy credentials must never reach the origin.
    assert.equal(origin.handshakes, 1);
    const seenHeaders = origin.seenUpgradeHeaders[0] ?? {};
    assert.equal(seenHeaders["proxy-authorization"], undefined, "proxy credentials are stripped before the origin");
    assert.equal(seenHeaders.host, `ws.test:${origin.port}`, "hostname-based Host semantics are preserved");
    assert.equal(seenHeaders["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==", "the browser's handshake reaches the origin");
    client.destroy();
    await client.closedWithin(2_000);
    await sleep(100);
    assert.equal(harness.broker.summary().ledger[0]?.completed, true, "an owner-closed live ws counts complete");
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

test("malformed and non-websocket upgrades are refused without dialing", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  const probe = () => new TestWsClient(harness.port);
  try {
    // Non-GET method. Every refusal destroys the broker-facing socket, so each
    // probe uses a fresh client (no reuse after a refusal).
    assert.equal((await probe().handshake("ws.test", origin.port, credentials, { method: "POST" })).status, 400);
    // Upgrade header is not "websocket".
    assert.equal((await probe().handshake("ws.test", origin.port, credentials, { upgrade: "h2c" })).status, 400);
    // A body-bearing upgrade.
    assert.equal(
      (await probe().handshake("ws.test", origin.port, credentials, { extraHeaders: { "content-length": "4" } })).status,
      400,
    );
    // Unresolvable destination host (admission refusal).
    assert.equal((await probe().handshake("unresolved.test", origin.port, credentials)).status, 403);
    assert.equal(harness.dials.length, 0, "no malformed refusal may dial");
    assert.equal(origin.connections, 0);
    assert.ok(harness.broker.summary().refusals >= 4);
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

test("a ws destination whose DNS rebinds to a private address is refused with zero origin connections", async () => {
  const origin = await echoOrigin();
  let privateConnections = 0;
  const privateTarget = net.createServer((socket) => {
    privateConnections += 1;
    socket.on("error", () => undefined);
  });
  const privatePort = await listen(privateTarget);
  let answers: string[] = [publicAnswer];
  const harness = await startBroker(() => Promise.resolve(answers), {
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  try {
    const first = await client.handshake("rebind.test", origin.port, undefined);
    assert.equal(first.status, 101, "the public answer is admitted (dialed through the seam to loopback)");
    client.destroy();
    answers = ["127.0.0.1"];
    const rebound = new TestWsClient(harness.port);
    try {
      assert.equal((await rebound.handshake("rebind.test", privatePort, undefined)).status, 403);
      assert.equal(privateConnections, 0, "the private target receives zero connections");
      assert.equal(harness.broker.summary().omissions.some((omission) => omission.includes("non-public address")), true);
    } finally {
      rebound.destroy();
    }
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
    await close(privateTarget);
  }
});

test("non-101 destination responses are relayed as a bare status and never upgrade", async () => {
  const origin = await echoOrigin(undefined, "/missing");
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  try {
    const rejected = await client.handshake("ws.test", origin.port, credentials, { path: "/missing" });
    assert.equal(rejected.status, 404, "the destination refusal status is relayed");
    assert.ok(!rejected.head.toLowerCase().includes("sec-websocket"), "no upgrade headers may be invented");
    assert.deepEqual(origin.handshakeStatuses, [404]);
    assert.deepEqual(harness.dials, [{ hostname: "ws.test", port: origin.port, address: publicAnswer }]);
    // The dial happened, so the ledger names the validated destination; the
    // exchange completed without a live connection.
    assert.equal(harness.broker.summary().ledger[0]?.completed, true);
    await client.closedWithin(2_000);
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

// ---------------------------------------------------------------------------
// Origin response-head handling: a 101 legitimately coalesced with the first
// server-initiated frame must be relayed (not destroyed), and the response-
// header bound applies to the ACTUAL head length regardless of chunking.
// ---------------------------------------------------------------------------

test("a 101 coalesced with an initial server frame in one write is relayed exactly once, in order", async () => {
  const origin = await echoOrigin(undefined, undefined, "initial-state");
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  try {
    const handshake = await client.handshake("ws.test", origin.port, credentials);
    assert.equal(handshake.status, 101, "the coalesced 101 must still complete the handshake");
    // The first server-initiated frame rode the same segment as the 101.
    const initial = await client.receive();
    assert.equal(initial.payload.toString("utf8"), "initial-state");
    // The coalesced remainder is byte-accounted exactly once (2-byte frame
    // header + 13-byte payload).
    assert.equal(harness.broker.summary().ledger[0]?.bytesReceived, 2 + "initial-state".length);
    // Bidirectional traffic still works afterwards, and no duplicate of the
    // coalesced frame is replayed: the next frame is our own echo.
    client.send("after-coalesce");
    const echoed = await client.receive();
    assert.equal(echoed.payload.toString("utf8"), "after-coalesce");
    assert.equal(harness.broker.summary().refusals, 0);
    client.destroy();
    await client.closedWithin(2_000);
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

test("an oversized complete response head in one chunk is refused at the exact bound", async () => {
  // 34 (status line) + 7 ("X-Pad: ") + 600 + 4 (CRLFCRLF) = 645 > 512, with
  // the terminating delimiter in the SAME chunk as the oversized head.
  const bigHead = `HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${"a".repeat(600)}\r\n\r\n`;
  assert.ok(bigHead.length > 512);
  const origin = await rawHeadOrigin((socket) => { socket.write(bigHead); });
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    budgets: { maxHeaderChars: 512 },
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  try {
    // Handshake read failures fail closed with an abrupt close (no 101 may
    // ever be relayed); -1 records a close before any response arrived.
    const outcome = await client.handshake("ws.test", origin.port, credentials)
      .then((response) => response.status, () => -1);
    assert.notEqual(outcome, 101, "an oversized head must fail closed, not be forwarded");
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("HTTP head exceeded")));
    assert.equal(origin.connections(), 1, "the dial happened; the oversized head came from the origin");
    assert.equal(harness.broker.summary().ledger[0]?.completed, false);
    assert.ok(harness.broker.summary().refusals >= 1);
    assert.equal(await client.closedWithin(2_000), true, "no tunnel may be established");
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

test("an oversized response head whose delimiter arrives in the final chunk is refused", async () => {
  // First write: 34 + 7 + 470 = 511 bytes, under the bound and WITHOUT the
  // delimiter (the early size check cannot fire). The second write completes
  // the head at 525 > 512 with the delimiter in the final chunk — exactly
  // the case that bypassed maxHeaderChars before the exact-bound fix.
  const part1 = `HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${"a".repeat(470)}`;
  assert.equal(part1.length, 511);
  const origin = await rawHeadOrigin(async (socket) => {
    socket.write(part1);
    await sleep(50); // force a separate segment for the final chunk
    socket.write(`${"a".repeat(10)}\r\n\r\n`);
  });
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    budgets: { maxHeaderChars: 512 },
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  try {
    const outcome = await client.handshake("ws.test", origin.port, credentials)
      .then((response) => response.status, () => -1);
    assert.notEqual(outcome, 101, "the bound must hold regardless of chunk boundaries");
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("HTTP head exceeded")));
    assert.equal(origin.connections(), 1);
    assert.equal(harness.broker.summary().ledger[0]?.completed, false);
    assert.ok(harness.broker.summary().refusals >= 1);
    assert.equal(await client.closedWithin(2_000), true, "no tunnel may be established");
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

// ---------------------------------------------------------------------------
// Diagnostics hygiene: ws refusal paths must never retain request paths,
// queries, or userinfo in summaries or observer diagnostics.
// ---------------------------------------------------------------------------

test("ws refusal diagnostics never expose request paths, queries, or userinfo", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  const observed: string[] = [];
  const observer: EgressBrokerObserver = {
    policyFailure: (_reason, diagnostic) => { observed.push(diagnostic); },
  };
  const harness = await startBroker(testResolver({ "rebind.test": ["127.0.0.1"] }), {
    auth,
    observer,
    websockets: { enabled: true },
  });
  const budgeted = await startBroker(testResolver({}), {
    auth,
    observer,
    budgets: { maxConnections: 0 },
    websockets: { enabled: true },
  });
  const secretPath = "SECRET_PATH_TOKEN";
  const secretQuery = "SECRET_QUERY_TOKEN";
  const secretUserinfo = "SECRET_USERINFO_TOKEN";
  const a = new TestWsClient(harness.port);
  const b = new TestWsClient(harness.port);
  const c = new TestWsClient(harness.port);
  const d = new TestWsClient(budgeted.port);
  try {
    // Malformed target carrying secrets in userinfo, path, AND query.
    assert.equal(
      (await a.handshake(`user:${secretUserinfo}@leak.test`, origin.port, credentials, { path: `/${secretPath}?token=${secretQuery}` })).status,
      400,
    );
    // Malformed method on an otherwise valid secret URL.
    assert.equal(
      (await b.handshake("leak.test", origin.port, credentials, { path: `/${secretPath}?token=${secretQuery}`, method: "POST" })).status,
      400,
    );
    // Validly parsed upgrade whose destination fails DNS validation (private).
    assert.equal(
      (await c.handshake("rebind.test", origin.port, credentials, { path: `/${secretPath}?token=${secretQuery}` })).status,
      403,
    );
    // Connection-budget exhaustion on a ws entry with a secret URL.
    assert.equal(
      (await d.handshake("leak.test", origin.port, credentials, { path: `/${secretPath}?token=${secretQuery}` })).status,
      403,
    );
    const retained = JSON.stringify([harness.broker.summary(), budgeted.broker.summary(), observed]);
    for (const secret of [secretPath, secretQuery, secretUserinfo]) {
      assert.equal(retained.includes(secret), false, `no summary or observer diagnostic may expose ${secret}`);
    }
    // Admission failures stay diagnosable by validated hostname and port only.
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes(`rebind.test:${origin.port}`)));
    assert.equal(harness.dials.length, 0, "no refusal may dial");
    assert.equal(budgeted.dials.length, 0, "no refusal may dial");
    assert.equal(origin.connections, 0);
  } finally {
    a.destroy();
    b.destroy();
    c.destroy();
    d.destroy();
    await harness.stop();
    await budgeted.stop();
    await close(origin.server);
  }
});

test("hard byte budgets abort live ws connections and never expose payloads", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    budgets: { maxConnectionBytes: 256, maxTotalBytes: 8 * 1024 * 1024 },
    websockets: { enabled: true },
  });
  const client = new TestWsClient(harness.port);
  try {
    assert.equal((await client.handshake("ws.test", origin.port, credentials)).status, 101);
    // Blast well past the connection byte budget in both directions.
    const payload = "SECRET-WS-PAYLOAD-MARKER".repeat(12);
    for (let index = 0; index < 8; index += 1) client.send(payload);
    assert.equal(await client.closedWithin(3_000), true, "the over-budget live connection must be destroyed");
    const summary = harness.broker.summary();
    assert.equal(summary.budgetAborts, 1);
    assert.equal(summary.ledger[0]?.completed, false, "a budget abort is never reported complete");
    assert.ok(summary.omissions.some((omission) => omission.includes("byte budget exceeded")));
    assert.equal(
      JSON.stringify(summary).includes(payload),
      false,
      "no diagnostic may retain payload or frame content",
    );
    assert.equal(JSON.stringify(summary).includes("SECRET"), false);
  } finally {
    client.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

test("the request budget bounds upgrade attempts like every other request", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    budgets: { maxRequests: 1 },
    websockets: { enabled: true },
  });
  const first = new TestWsClient(harness.port);
  const second = new TestWsClient(harness.port);
  try {
    assert.equal((await first.handshake("ws.test", origin.port, credentials)).status, 101);
    assert.equal((await second.handshake("ws.test", origin.port, credentials)).status, 403);
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("request budget")));
  } finally {
    first.destroy();
    second.destroy();
    await harness.stop();
    await close(origin.server);
  }
});

// ---------------------------------------------------------------------------
// Live-transport retention: quiet connections are not evicted by the ordinary
// HTTP idle timer unless the owner opts into an idle bound.
// ---------------------------------------------------------------------------

test("quiet live connections survive ordinary idle windows only under the explicit opt-in", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  // Broker A: opted in with a SHORT live idle bound — eviction still happens,
  // at the owner's chosen bound, without any fatal notification.
  const strict = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    budgets: { idleSocketMs: 60_000 },
    websockets: { enabled: true, liveIdleSocketMs: 300 },
  });
  // Broker B: opted in with idle eviction DISABLED for live transports.
  const live = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    budgets: { idleSocketMs: 300 },
    websockets: { enabled: true, liveIdleSocketMs: null },
  });
  const strictClient = new TestWsClient(strict.port);
  const liveClient = new TestWsClient(live.port);
  try {
    assert.equal((await strictClient.handshake("ws.test", origin.port, credentials)).status, 101);
    assert.equal((await liveClient.handshake("ws.test", origin.port, credentials)).status, 101);
    // No frames from either side for well past the ordinary HTTP idle window.
    await sleep(1_200);
    assert.equal(await strictClient.closedWithin(2_000), true, "the owner's explicit live idle bound evicts quiet sockets");
    assert.ok(strict.broker.summary().omissions.some((omission) => omission.includes("idle timeout")));
    assert.equal(strict.broker.summary().budgetAborts, 1);
    assert.equal(strict.broker.summary().ledger[0]?.completed, false);
    // The quiet live connection is STILL available and functional.
    liveClient.send("still-alive");
    assert.equal((await liveClient.receive()).payload.toString("utf8"), "still-alive");
    assert.equal(live.broker.summary().budgetAborts, 0, "no ordinary idle/lifetime eviction happened");
    assert.equal(live.broker.summary().ledger[0]?.completed, false, "an open live connection is simply still open");
    strictClient.destroy();
    liveClient.destroy();
  } finally {
    strictClient.destroy();
    liveClient.destroy();
    await strict.stop();
    await live.stop();
    await close(origin.server);
  }
});

test("owner close and hard failure still drain opted-in live connections", async () => {
  const origin = await echoOrigin();
  const { auth, credentials } = testAuth();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    auth,
    websockets: { enabled: true, liveIdleSocketMs: null },
  });
  const client = new TestWsClient(harness.port);
  try {
    assert.equal((await client.handshake("ws.test", origin.port, credentials)).status, 101);
    const clientClosed = client.closedWithin(4_000);
    await harness.stop();
    assert.equal(await clientClosed, true, "broker close must destroy even opted-in live sockets");
    assert.equal(harness.broker.isQuiescent(), true);
    await expectOriginDrained(origin);
  } finally {
    client.destroy();
    await close(origin.server);
  }
});

test("a late-resolved dial for a vanished client never leaks a destination socket", async () => {
  const origin = await echoOrigin();
  const dials: Array<{ hostname: string; port: number; address: string }> = [];
  const broker = new EgressBroker(
    async () => {
      await sleep(400);
      return [publicAnswer];
    },
    (validated, port) => {
      dials.push({ hostname: validated.hostname, port, address: validated.addresses[0] ?? "" });
      return net.connect({ host: "127.0.0.1", port });
    },
    DEFAULT_EGRESS_BUDGETS,
    undefined,
    undefined,
    { enabled: true, liveIdleSocketMs: null },
  );
  const brokerPort = await broker.start();
  const client = new TestWsClient(brokerPort);
  try {
    // The client gives up while the (slow) admission resolution is pending.
    void client.handshake("ws.test", origin.port, undefined).catch(() => undefined);
    await sleep(100);
    client.destroy();
    await sleep(700);
    assert.equal(origin.handshakes, 0, "no handshake may complete for a vanished client");
    await broker.close();
    assert.equal(broker.isQuiescent(), true, "no socket may linger after the late dial resolved");
    await expectOriginDrained(origin);
  } finally {
    client.destroy();
    await close(origin.server);
  }
});

// ---------------------------------------------------------------------------
// Real Chromium through the authenticated broker (skipped when Chromium is not
// installed). The resolver pins the TEST hostname to loopback; TLS trust for
// the wss origin comes from a test-local --ignore-certificate-errors launch
// flag, NOT from any broker-side TLS interception (there is none).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Real Chromium through the opted-in broker (skipped when Chromium is not
// installed). The resolver pins the TEST hostname to loopback; TLS trust for
// the wss origin comes from a test-local --ignore-certificate-errors launch
// flag, NOT from any broker-side TLS interception (there is none).
//
// These transports tests run the broker WITHOUT its per-render proxy
// credential on purpose: Chromium's WebSocket network stack never supplies
// proxy credentials (it fails a 407 challenge with "Proxy authentication
// failed" without retrying), so an authenticated-broker ws/wss launch is
// impossible at the BROWSER layer for ANY proxy, independent of this broker.
// The authenticated upgrade path — 407 challenges, credential stripping at
// the origin, full-value comparison — is covered by the raw-client
// regressions above; here real Chromium proves admission, DNS pinning,
// byte accounting, and bidirectional delivery of live browser traffic.
// ---------------------------------------------------------------------------

test("real Chromium delivers plain ws through the opted-in broker", { skip: !chromiumInstalled }, async (t) => {
  const origin = await echoOrigin();
  const harness = await startBroker(testResolver({ "ws.test": [publicAnswer] }), {
    websockets: { enabled: true, liveIdleSocketMs: null },
  });
  let browser: import("playwright").Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 20_000,
      args: chromiumEgressArgs(harness.port),
      proxy: { server: `http://127.0.0.1:${harness.port}` },
    });
    const page = await (await browser.newContext()).newPage();
    const result = await pageWebSocketProbe(page, `ws://ws.test:${origin.port}/echo`, "chromium-live-ws");
    assert.equal(result.ok, true, `the page WebSocket must connect and echo: ${result.error ?? ""}`);
    assert.equal(result.echoed, "chromium-live-ws");
    assert.deepEqual(harness.dials, [{ hostname: "ws.test", port: origin.port, address: publicAnswer }]);
    // Chromium tunnels even plain ws through CONNECT; the broker never sees
    // or inspects the upgrade either way.
    assert.equal(harness.broker.summary().ledger[0]?.kind, "connect");
    assert.equal(origin.handshakes, 1);
    assert.equal((origin.seenUpgradeHeaders[0] ?? {})["proxy-authorization"], undefined);
    assert.ok(origin.frames.includes("chromium-live-ws"));
    await browser.close();
    browser = undefined;
    await harness.stop();
    assert.equal(harness.broker.isQuiescent(), true, "the broker drains after the browser closes");
  } finally {
    await browser?.close().catch(() => undefined);
    await harness.stop().catch(() => undefined);
    await close(origin.server);
  }
});

test("real Chromium delivers wss inside the opaque CONNECT tunnel", { skip: !chromiumInstalled }, async (t) => {
  const fixture = await tlsFixture();
  if (!fixture) {
    t.skip("openssl is unavailable; the wss TLS fixture cannot be generated");
    return;
  }
  const origin = await echoOrigin({ key: fixture.key, cert: fixture.cert });
  const harness = await startBroker(testResolver({ "wss.test": [publicAnswer] }), {
    websockets: { enabled: true, liveIdleSocketMs: null },
  });
  let browser: import("playwright").Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 20_000,
      // Test-local trust instrumentation for the self-signed fixture; the
      // broker never terminates or inspects TLS.
      args: [...chromiumEgressArgs(harness.port), "--ignore-certificate-errors"],
      proxy: { server: `http://127.0.0.1:${harness.port}` },
    });
    const page = await (await browser.newContext()).newPage();
    const result = await pageWebSocketProbe(page, `wss://wss.test:${origin.port}/echo`, "chromium-live-wss");
    assert.equal(result.ok, true, `the page wss WebSocket must connect and echo: ${result.error ?? ""}`);
    assert.equal(result.echoed, "chromium-live-wss");
    // The broker saw only an ordinary CONNECT tunnel; the upgrade and frames
    // stayed inside the browser's end-to-end TLS.
    assert.equal(harness.broker.summary().ledger[0]?.kind, "connect");
    assert.deepEqual(harness.dials, [{ hostname: "wss.test", port: origin.port, address: publicAnswer }]);
    assert.equal(origin.handshakes, 1);
    assert.equal(origin.frames.includes("chromium-live-wss"), true);
    await browser.close();
    browser = undefined;
    await harness.stop();
  } finally {
    await browser?.close().catch(() => undefined);
    await harness.stop().catch(() => undefined);
    await close(origin.server);
  }
});

// Note: there is deliberately no "Chromium cannot open a WebSocket without the
// opt-in" test at the broker layer. An opaque CONNECT tunnel is indistinguish
// from a wss tunnel by design (the default broker has always permitted it), so
// scheme-level WebSocket refusal belongs to the browser route layer (a separate
// integration). The default-off guarantee this layer owns — refusal of
// upgrade-path requests before any dial — is covered by the first test.
