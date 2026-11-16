/**
 * Owned Codex TUI relay acceptance (synthetic local sockets only).
 *
 * Everything here runs against a hand-built local fake upstream (a raw TCP
 * listener that speaks the backend side of the WebSocket handshake and frames)
 * and a raw fake TUI client that writes its own masked frames. No Codex binary,
 * provider, model, or real app-server is involved.
 *
 * What these tests prove: the relay only ever dials the owned backend cap; the
 * handshake is authenticated and refused at the HTTP layer; genuine bytes
 * (request line, headers, frame boundaries, client masks, fragmentation, large
 * frames, compressed/binary payloads) are forwarded unchanged with only `Host`
 * rewritten; the tap projects only the closed metadata union with no raw
 * payload, prompt, path, command, output, error message, or bearer leak; the
 * relay never originates an application-layer reply; generations are fenced;
 * tap detach, reconnect, consumer throws, and stop/settlement behave as
 * specified.
 *
 * What they do NOT prove: that a live Codex 0.169 TUI/backend pair works, that
 * the provider's real compression negotiation behaves as assumed, or that any
 * projected thread or turn is the row's ROOT. No root selection, session
 * adoption, or Main activation is implemented or claimed here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import type { OwnedCodexBackendReady, OwnedCodexTuiConnection } from "../src/session-host/native-codex-backend";
import {
  NativeCodexTuiRelayError,
  startNativeCodexTuiRelay,
  type NativeCodexTuiRelayLease,
  type NativeCodexTuiRelayMetadataEvent,
  type NativeCodexTuiRelayReadiness,
} from "../src/session-host/native-codex-tui-relay";

/* ------------------------------------------------------------- sentinels */

const BEARER = "syntheticBearer0123456789abcdef";
const AUTH_ENV_NAME = "PI_REVIEW_GATE_OWNED_CODEX_RPC_TEST";
const PROMPT_SENTINEL = "SENTINEL-PROMPT-MUST-NOT-LEAK";
const CWD_SENTINEL = "/home/operator/SENTINEL-CWD";
const NAME_SENTINEL = "SENTINEL-THREAD-NAME";
const COMMAND_SENTINEL = "echo SENTINEL-COMMAND";
const OPTION_SENTINEL = "SENTINEL-OPTION";
const ANSWER_SENTINEL = "SENTINEL-ANSWER";
const OUTPUT_SENTINEL = "SENTINEL-OUTPUT-TEXT";
const ERROR_MESSAGE_SENTINEL = "SENTINEL-ERROR-MESSAGE";
const ROLLOUT_SENTINEL = "/rollouts/SENTINEL-ROLLOUT.jsonl";

const WS_GUIDE = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

/* --------------------------------------------------------------- helpers */

function acceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(`${secWebSocketKey}${WS_GUIDE}`, "utf8").digest("base64");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${message}`);
    await sleep(5);
  }
}

async function bounded<T>(promise: Promise<T>, message: string, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${message}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function expectPending(promise: Promise<unknown>, ms = 60): Promise<void> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(() => "settled" as const, () => "rejected" as const),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  assert.equal(outcome, pending);
}

function xorMask(payload: Buffer, maskKey: Buffer): Buffer {
  const out = Buffer.from(payload);
  for (let index = 0; index < out.length; index += 1) out[index] ^= maskKey[index & 0x03];
  return out;
}

interface FrameOptions {
  readonly fin?: boolean;
  readonly rsv1?: boolean;
  readonly maskKey?: Buffer | null;
  readonly lengthForm?: "auto" | "force64bit";
}

/** Build exactly the RFC6455 bytes a peer would put on the wire. */
function buildFrame(opcode: number, payload: Buffer, options: FrameOptions = {}): Buffer {
  const fin = options.fin ?? true;
  const rsv1 = options.rsv1 ?? false;
  const maskKey = options.maskKey ?? null;
  const force64 = options.lengthForm === "force64bit";
  const length = payload.length;

  let lengthBytes: number[];
  if (!force64 && length < 126) lengthBytes = [length];
  else if (!force64 && length < 65_536) lengthBytes = [126, (length >> 8) & 0xff, length & 0xff];
  else {
    lengthBytes = [127];
    for (let shift = 56; shift >= 0; shift -= 8) lengthBytes.push(Math.floor(length / 2 ** shift) & 0xff);
  }

  const first = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  const second = (maskKey === null ? 0 : 0x80) | (lengthBytes[0] as number);
  const head = [first, second, ...lengthBytes.slice(1)];
  const maskedPayload = maskKey === null ? payload : xorMask(payload, maskKey);
  return Buffer.concat([
    Buffer.from(head),
    ...(maskKey === null ? [] : [maskKey]),
    maskedPayload,
  ]);
}

function jsonFrame(value: unknown, options: FrameOptions = {}): Buffer {
  return buildFrame(0x01, Buffer.from(JSON.stringify(value), "utf8"), options);
}

/** The owned backend capability the relay is allowed to front. */
function fakeBackendCap(endpoint: string): OwnedCodexBackendReady {
  return {
    endpoint,
    readObserverBearer: () => BEARER,
    createTuiConnection: (): OwnedCodexTuiConnection => Object.freeze({
      endpoint,
      args: Object.freeze(["--remote", endpoint, "--remote-auth-token-env", AUTH_ENV_NAME]),
      env: Object.freeze({ PATH: "/usr/bin", HOME: "/home/operator", [AUTH_ENV_NAME]: BEARER }),
    }),
  };
}

/* ----------------------------------------------------------- fake upstream */

interface UpstreamConnection {
  readonly socket: net.Socket;
  received: Buffer;
  headBytes: number;
  ended: boolean;
}

interface UpstreamOptions {
  /** Build the handshake response for one connection. */
  readonly respond?: (requestHead: string) => string;
  /** Close the socket immediately after the handshake response. */
  readonly closeAfterResponse?: boolean;
  /** Raw bytes written in the SAME write as the handshake response. */
  readonly extraAfterResponse?: Buffer;
  /** Delay the handshake response so client traffic arrives pre-upgrade. */
  readonly respondDelayMs?: number;
}

class FakeUpstream {
  readonly server: net.Server;
  readonly connections: UpstreamConnection[] = [];
  port = 0;
  #options: UpstreamOptions;
  #closed = false;

  constructor(options: UpstreamOptions = {}) {
    this.#options = options;
    this.server = net.createServer((socket) => {
      const connection: UpstreamConnection = { socket, received: Buffer.alloc(0), headBytes: -1, ended: false };
      this.connections.push(connection);
      socket.on("end", () => {
        connection.ended = true;
      });
      socket.on("data", (chunk: Buffer) => {
        connection.received = Buffer.concat([connection.received, chunk]);
        if (connection.headBytes < 0) {
          const end = connection.received.indexOf("\r\n\r\n");
          if (end >= 0) {
            connection.headBytes = end + 4;
            const head = connection.received.subarray(0, connection.headBytes).toString("latin1");
            const keyMatch = /sec-websocket-key: *([^\r\n]+)/i.exec(head);
            const response = this.#options.respond?.(head)
              ?? `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
                + `Sec-WebSocket-Accept: ${acceptKey(keyMatch?.[1] ?? SAMPLE_KEY)}\r\n\r\n`;
            const extra = this.#options.extraAfterResponse;
            const emit = (): void => {
              if (this.#closed) return;
              socket.write(extra === undefined
                ? Buffer.from(response, "latin1")
                : Buffer.concat([Buffer.from(response, "latin1"), extra]));
              if (this.#options.closeAfterResponse === true) socket.end();
            };
            const delay = this.#options.respondDelayMs ?? 0;
            if (delay > 0) {
              const timer = setTimeout(emit, delay);
              timer.unref?.();
            } else {
              emit();
            }
          }
        }
      });
    });
  }

  async start(): Promise<this> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    assert.ok(address !== null && typeof address === "object");
    this.port = address.port;
    return this;
  }

  get endpoint(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** Everything received after the handshake head on one connection. */
  postHead(index = 0): Buffer {
    const connection = this.connections[index];
    assert.ok(connection, `expected upstream connection ${index}`);
    return connection.headBytes < 0 ? Buffer.alloc(0) : connection.received.subarray(connection.headBytes);
  }

  requestHead(index = 0): string {
    const connection = this.connections[index];
    assert.ok(connection, `expected upstream connection ${index}`);
    return connection.headBytes < 0 ? "" : connection.received.subarray(0, connection.headBytes).toString("latin1");
  }

  send(bytes: Buffer, index = 0): void {
    const connection = this.connections[index];
    assert.ok(connection, `expected upstream connection ${index}`);
    connection.socket.write(bytes);
  }

  async waitForConnection(index: number): Promise<UpstreamConnection> {
    await until(() => this.connections.length > index, `upstream connection ${index}`);
    return this.connections[index] as UpstreamConnection;
  }

  async waitForPostHead(minBytes: number, index = 0): Promise<void> {
    await until(() => this.postHead(index).length >= minBytes, `${minBytes} upstream bytes`);
  }

  async stop(): Promise<void> {
    this.#closed = true;
    for (const connection of this.connections) {
      try {
        connection.socket.destroy();
      } catch {
        // Best effort.
      }
    }
    if (this.server.listening) {
      this.server.close();
      await once(this.server, "close").catch(() => undefined);
    }
  }
}

/* ------------------------------------------------------------ fake client */

class FakeTui {
  readonly socket: net.Socket;
  received: Buffer = Buffer.alloc(0);
  closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.received = Buffer.concat([this.received, chunk]);
    });
    socket.on("close", () => {
      this.closed = true;
    });
  }

  static async connect(port: number): Promise<FakeTui> {
    const socket = net.connect({ host: "127.0.0.1", port });
    await once(socket, "connect");
    return new FakeTui(socket);
  }

  write(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  /** Write the upgrade head without waiting for the backend's response. */
  writeHandshakeHead(options: { readonly bearer?: string; readonly key?: string } = {}): void {
    const lines = [
      `GET / HTTP/1.1`,
      `Host: 127.0.0.1:0`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${options.key ?? SAMPLE_KEY}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Bearer ${options.bearer ?? BEARER}`,
      "",
      "",
    ];
    this.socket.write(Buffer.from(lines.join("\r\n"), "latin1"));
  }

  /** Wait for the handshake response head and return it as text. */
  async readHandshakeResponse(): Promise<string> {
    await until(() => this.received.indexOf("\r\n\r\n") >= 0, "handshake response");
    return this.received.subarray(0, this.received.indexOf("\r\n\r\n") + 4).toString("latin1");
  }

  /** Send a native-shaped upgrade request and wait for the response head. */
  async handshake(options: {
    readonly bearer?: string;
    readonly key?: string;
    readonly extraHeaders?: readonly string[];
    readonly path?: string;
    /** Bytes appended to the SAME write as the handshake head. */
    readonly trailingBytes?: Buffer;
  } = {}): Promise<string> {
    const bearer = options.bearer ?? BEARER;
    const lines = [
      `GET ${options.path ?? "/"} HTTP/1.1`,
      `Host: 127.0.0.1:0`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${options.key ?? SAMPLE_KEY}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Bearer ${bearer}`,
      ...(options.extraHeaders ?? []),
      "",
      "",
    ];
    const head = Buffer.from(lines.join("\r\n"), "latin1");
    this.socket.write(options.trailingBytes === undefined
      ? head
      : Buffer.concat([head, options.trailingBytes]));
    await until(() => this.received.indexOf("\r\n\r\n") >= 0, "handshake response");
    return this.received.subarray(0, this.received.indexOf("\r\n\r\n") + 4).toString("latin1");
  }

  async waitForReceived(minBytes: number): Promise<void> {
    await until(() => this.received.length >= minBytes, `${minBytes} client bytes`);
  }

  async waitForClose(): Promise<void> {
    await until(() => this.closed, "client close");
  }

  destroy(): void {
    try {
      this.socket.destroy();
    } catch {
      // Best effort.
    }
  }
}

/* --------------------------------------------------------------- harness */

interface Harness {
  readonly upstream: FakeUpstream;
  readonly lease: NativeCodexTuiRelayLease;
  readonly events: NativeCodexTuiRelayMetadataEvent[];
  ready(): Promise<NativeCodexTuiRelayReadiness>;
  teardown(): Promise<void>;
}

async function startHarness(
  options: {
    readonly metadataMaxMessageBytes?: number;
    readonly handshakeTimeoutMs?: number;
    readonly onMetadata?: (event: NativeCodexTuiRelayMetadataEvent) => void;
    readonly upstream?: UpstreamOptions;
  } = {},
): Promise<Harness> {
  const upstream = await new FakeUpstream(options.upstream ?? {}).start();
  const events: NativeCodexTuiRelayMetadataEvent[] = [];
  const lease = startNativeCodexTuiRelay({
    backend: fakeBackendCap(upstream.endpoint),
    onMetadata: (event) => {
      events.push(event);
      options.onMetadata?.(event);
    },
    ...(options.metadataMaxMessageBytes === undefined ? {} : { metadataMaxMessageBytes: options.metadataMaxMessageBytes }),
    ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
  });
  return {
    upstream,
    lease,
    events,
    ready: () => bounded(lease.readinessPromise, "relay readiness"),
    teardown: async () => {
      lease.requestStop();
      await bounded(lease.settlementPromise, "relay settlement").catch(() => undefined);
      await upstream.stop();
    },
  };
}

/** Open one fake TUI connection through the relay to the fake upstream. */
async function connectTui(harness: Harness, index: number, options: Parameters<FakeTui["handshake"]>[0] = {}): Promise<{
  readonly tui: FakeTui;
  readonly responseHead: string;
}> {
  const readiness = await harness.ready();
  const tui = await FakeTui.connect(readiness.port);
  const responseHead = await tui.handshake(options);
  await harness.upstream.waitForConnection(index);
  return { tui, responseHead };
}

/**
 * Write one client frame and wait until the fake upstream has it, so a
 * response the test sends next cannot race ahead of the request across the two
 * independent sockets.
 */
async function tuiRequest(tui: FakeTui, upstream: FakeUpstream, frame: Buffer, index = 0): Promise<void> {
  const before = upstream.postHead(index).length;
  tui.write(frame);
  await upstream.waitForPostHead(before + frame.length, index);
}

function eventsOfKind(
  events: readonly NativeCodexTuiRelayMetadataEvent[],
  kind: NativeCodexTuiRelayMetadataEvent["kind"],
): NativeCodexTuiRelayMetadataEvent[] {
  return events.filter((event) => event.kind === kind);
}

function assertNoSentinels(payload: string): void {
  for (const sentinel of [
    BEARER,
    PROMPT_SENTINEL,
    CWD_SENTINEL,
    NAME_SENTINEL,
    COMMAND_SENTINEL,
    OPTION_SENTINEL,
    ANSWER_SENTINEL,
    OUTPUT_SENTINEL,
    ERROR_MESSAGE_SENTINEL,
    ROLLOUT_SENTINEL,
  ]) {
    assert.ok(!payload.includes(sentinel), `payload must not contain ${sentinel.slice(0, 12)}...`);
  }
}

/* ================================================================= tests */

test("readiness exposes only the relay endpoint and backend-derived TUI material", async () => {
  const harness = await startHarness();
  try {
    const readiness = await harness.ready();
    assert.match(readiness.endpoint, /^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
    assert.notEqual(readiness.port, harness.upstream.port);

    const tui = readiness.createTuiConnection();
    assert.deepEqual(tui.args, ["--remote", readiness.endpoint, "--remote-auth-token-env", AUTH_ENV_NAME]);
    assert.equal(tui.endpoint, readiness.endpoint);
    assert.ok(!JSON.stringify(tui.args).includes(String(harness.upstream.port)));
    assert.equal(tui.env[AUTH_ENV_NAME], BEARER);
    assert.ok(Object.isFrozen(tui.args));
    assert.notStrictEqual(readiness.createTuiConnection().env, tui.env);

    assert.equal(JSON.stringify(readiness).includes(BEARER), false);
    const status = harness.lease.status();
    assert.equal(status.phase, "listening");
    assert.equal(status.listening, true);
    assert.equal(status.activeConnections, 0);
    assert.equal(status.openSockets, 0);
    assert.equal(status.metadataTapEnabled, true);
    assertNoSentinels(JSON.stringify(status));
  } finally {
    await harness.teardown();
  }
  const settled = await harness.lease.settlementPromise;
  assert.deepEqual(settled, {
    status: "settled",
    listenerClosed: true,
    socketsClosed: true,
    connectionGenerations: 0,
  });
  assert.equal(harness.lease.status().phase, "stopped");
});

test("a non-loopback or non-owned backend capability is refused before any listener", async () => {
  const events: NativeCodexTuiRelayMetadataEvent[] = [];
  for (const endpoint of ["ws://example.com:9100", "wss://127.0.0.1:9100", "ws://127.0.0.1:0", "ws://10.0.0.5:9100"]) {
    let threw = false;
    try {
      startNativeCodexTuiRelay({ backend: fakeBackendCap(endpoint), onMetadata: () => undefined });
    } catch (error) {
      threw = true;
      assert.ok(error instanceof NativeCodexTuiRelayError);
      assert.equal(error.code, "backend-endpoint-invalid");
    }
    assert.equal(threw, true, `expected ${endpoint} to be refused`);
  }
  assert.deepEqual(events, []);
});

test("an unauthenticated handshake is refused at the HTTP layer and never reaches the backend", async () => {
  const harness = await startHarness();
  try {
    const readiness = await harness.ready();
    const tui = await FakeTui.connect(readiness.port);
    const responseHead = await tui.handshake({ bearer: "wrong-bearer-value" });
    assert.match(responseHead, /^HTTP\/1\.1 401 Unauthorized/);
    assert.equal(responseHead.includes("jsonrpc"), false);

    await sleep(40);
    assert.equal(harness.upstream.connections.length, 0);
    assert.equal(harness.events.length, 0);
    assert.equal(harness.lease.status().refusedUnauthenticated, 1);
    assert.equal(harness.lease.status().activeConnections, 0);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("the handshake is forwarded with only Host rewritten; unknown headers survive", async () => {
  const harness = await startHarness();
  try {
    const readiness = await harness.ready();
    const tui = await FakeTui.connect(readiness.port);
    const responseHead = await tui.handshake({
      extraHeaders: [
        "X-Codex-Client-Tag: keepme",
        "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
        "X-Codex-Websocket-Max-Unfragmented-Message-Bytes: 16777216",
      ],
    });
    await harness.upstream.waitForConnection(0);
    const head = harness.upstream.requestHead(0);

    assert.ok(head.startsWith("GET / HTTP/1.1\r\n"), head);
    const hostLines = head.split("\r\n").filter((line) => /^host:/i.test(line));
    assert.deepEqual(hostLines, [`Host: 127.0.0.1:${harness.upstream.port}`]);
    assert.ok(!head.includes(String(readiness.port)), "the relay address must not reach the backend");
    assert.ok(head.includes("X-Codex-Client-Tag: keepme"));
    assert.ok(head.includes("Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits"));
    assert.ok(head.includes("X-Codex-Websocket-Max-Unfragmented-Message-Bytes: 16777216"));
    assert.ok(head.includes(`Authorization: Bearer ${BEARER}`), "the backend still receives the native secret");
    assert.ok(head.includes(`Sec-WebSocket-Key: ${SAMPLE_KEY}`));

    // The backend's own 101 reaches the TUI byte-for-byte.
    const expectedResponse = Buffer.from(responseHead, "latin1");
    await tui.waitForReceived(expectedResponse.length);
    assert.equal(tui.received.subarray(0, expectedResponse.length).equals(expectedResponse), true);
    assert.equal(eventsOfKind(harness.events, "metadata-unavailable").length, 0);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("client frames reach the backend byte-for-byte: masks, fragments, large and 64-bit frames", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    assert.equal(harness.upstream.postHead(0).length, 0);

    const frames = [
      // A masked single-frame JSON request.
      jsonFrame({ jsonrpc: "2.0", id: "f1", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
        { maskKey: Buffer.from([0x11, 0x22, 0x33, 0x44]) }),
      // A fragmented message with a distinct mask key per fragment.
      buildFrame(0x01, Buffer.from('{"jsonrpc":"2.0"', "utf8"), { fin: false, maskKey: Buffer.from([0x01, 0x02, 0x03, 0x04]) }),
      buildFrame(0x00, Buffer.from(',"id":"f2","method":"turn/', "utf8"), { fin: false, maskKey: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]) }),
      buildFrame(0x00, Buffer.from('start"}', "utf8"), { fin: true, maskKey: Buffer.from([0x77, 0x66, 0x55, 0x44]) }),
      // A large frame inside the native bounds (126-extended length).
      jsonFrame({ id: "f3", method: "big", text: "x".repeat(200_000) }, { maskKey: Buffer.from([0x0f, 0x0e, 0x0d, 0x0c]) }),
      // A 64-bit length encoding with a small payload.
      jsonFrame({ id: "f4", method: "sixtyfour" }, { maskKey: Buffer.from([0x05, 0x06, 0x07, 0x08]), lengthForm: "force64bit" }),
      // A masked ping control frame.
      buildFrame(0x09, Buffer.from("ping", "utf8"), { maskKey: Buffer.from([0x10, 0x20, 0x30, 0x40]) }),
    ];
    const expected = Buffer.concat(frames);
    tui.write(expected);

    await harness.upstream.waitForPostHead(expected.length);
    assert.equal(harness.upstream.postHead(0).length, expected.length);
    assert.equal(harness.upstream.postHead(0).equals(expected), true, "relay must not reframe client traffic");
    assert.equal(harness.lease.status().forwardedBytesToBackend, expected.length);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("backend frames reach the TUI byte-for-byte including fragmentation and large frames", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    const responseLength = tui.received.length;

    const frames = [
      buildFrame(0x01, Buffer.from('{"jsonrpc":"2.0","id":1,"res', "utf8"), { fin: false }),
      buildFrame(0x00, Buffer.from('ult":{"ok":true}}', "utf8"), { fin: true }),
      buildFrame(0x02, Buffer.from("y".repeat(150_000), "utf8")),
      buildFrame(0x0a, Buffer.alloc(0)),
    ];
    const expected = Buffer.concat(frames);
    harness.upstream.send(expected);

    await tui.waitForReceived(responseLength + expected.length);
    assert.equal(tui.received.subarray(responseLength).equals(expected), true);
    assert.equal(harness.lease.status().forwardedBytesToClient, expected.length);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("a negotiated compressed stream is copied untouched and metadata is withdrawn", async () => {
  const harness = await startHarness({
    upstream: {
      respond: (head) => {
        const key = /sec-websocket-key: *([^\r\n]+)/i.exec(head)?.[1] ?? SAMPLE_KEY;
        return "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
          + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
          + "Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover\r\n\r\n";
      },
    },
  });
  try {
    const { tui } = await connectTui(harness, 0);
    const afterHandshake = tui.received.length;

    // Opaque stateful binary payloads with RSV1 set, in both directions.
    const clientBytes = Buffer.concat([
      buildFrame(0x02, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x11, 0x22, 0x33, 0xff]), {
        maskKey: Buffer.from([0x01, 0x01, 0x01, 0x01]),
        rsv1: true,
      }),
      buildFrame(0x02, Buffer.from("not-deflatable-bytes".repeat(64), "latin1"), {
        maskKey: Buffer.from([0x02, 0x03, 0x04, 0x05]),
        rsv1: true,
      }),
    ]);
    tui.write(clientBytes);
    await harness.upstream.waitForPostHead(clientBytes.length);
    assert.equal(harness.upstream.postHead(0).equals(clientBytes), true);

    const serverBytes = Buffer.concat([
      buildFrame(0x02, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00, 0x00]), { rsv1: true }),
    ]);
    harness.upstream.send(serverBytes);
    await tui.waitForReceived(afterHandshake + serverBytes.length);
    assert.equal(tui.received.subarray(afterHandshake).equals(serverBytes), true);

    const unavailable = eventsOfKind(harness.events, "metadata-unavailable");
    assert.equal(unavailable.length, 1);
    const withdrawn = unavailable[0];
    assert.ok(withdrawn?.kind === "metadata-unavailable");
    assert.deepEqual(
      { scope: withdrawn.scope, reason: withdrawn.reason },
      { scope: "connection", reason: "compressed-stream" },
    );
    // No session metadata was projected from an undecodable stream.
    assert.equal(eventsOfKind(harness.events, "thread-candidate").length, 0);
    assert.equal(eventsOfKind(harness.events, "turn-work-target").length, 0);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("metadata correlates the genuine TUI's own thread and turn successes", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);

    await tuiRequest(tui, harness.upstream, jsonFrame({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        clientInfo: { name: "codex-tui", version: "0.169.0" },
        capabilities: { requiredHumanApproval: true },
      },
    }, { maskKey: Buffer.from([1, 2, 3, 4]) }));

    await tuiRequest(tui, harness.upstream, jsonFrame({
      jsonrpc: "2.0",
      id: "th-1",
      method: "thread/start",
      params: { cwd: CWD_SENTINEL, ephemeral: false, model: "gpt-5" },
    }, { maskKey: Buffer.from([5, 6, 7, 8]) }));
    harness.upstream.send(jsonFrame({
      jsonrpc: "2.0",
      id: "th-1",
      result: { thread: { id: "019a-thread-1", name: NAME_SENTINEL, ephemeral: false, rolloutPath: ROLLOUT_SENTINEL } },
    }));

    await tuiRequest(tui, harness.upstream, jsonFrame({
      jsonrpc: "2.0",
      id: "tu-1",
      method: "turn/start",
      params: { threadId: "019a-thread-1", input: [{ type: "text", text: PROMPT_SENTINEL }] },
    }, { maskKey: Buffer.from([9, 9, 9, 9]) }));
    harness.upstream.send(jsonFrame({
      jsonrpc: "2.0",
      id: "tu-1",
      result: { turn: { id: "019a-turn-1", status: "inProgress" } },
    }));

    await tuiRequest(tui, harness.upstream, jsonFrame({
      jsonrpc: "2.0",
      id: "th-2",
      method: "thread/fork",
      params: { threadId: "019a-thread-1" },
    }, { maskKey: Buffer.from([2, 2, 2, 2]) }));
    harness.upstream.send(jsonFrame({
      jsonrpc: "2.0",
      id: "th-2",
      result: { thread: { id: "019a-thread-2", ephemeral: true }, parentThreadId: "019a-thread-1" },
    }));

    await until(() => eventsOfKind(harness.events, "turn-work-target").length === 1
      && eventsOfKind(harness.events, "thread-candidate").length === 2, "correlated metadata");

    const initialize = eventsOfKind(harness.events, "genuine-tui-initialize");
    assert.equal(initialize.length, 1);
    assert.deepEqual(
      {
        kind: initialize[0]?.kind,
        clientName: initialize[0]?.kind === "genuine-tui-initialize" ? initialize[0].clientName : null,
        humanApprovalRequired: initialize[0]?.kind === "genuine-tui-initialize" ? initialize[0].humanApprovalRequired : null,
      },
      { kind: "genuine-tui-initialize", clientName: "codex-tui", humanApprovalRequired: true },
    );

    const candidates = eventsOfKind(harness.events, "thread-candidate");
    assert.deepEqual(candidates.map((event) => event.kind === "thread-candidate"
      ? { origin: event.origin, threadId: event.threadId, parentThreadId: event.parentThreadId, ephemeral: event.ephemeral }
      : null), [
      { origin: "thread-start", threadId: "019a-thread-1", parentThreadId: undefined, ephemeral: false },
      { origin: "thread-fork", threadId: "019a-thread-2", parentThreadId: "019a-thread-1", ephemeral: true },
    ]);

    const workTargets = eventsOfKind(harness.events, "turn-work-target");
    assert.equal(workTargets.length, 1);
    assert.deepEqual(workTargets.map((event) => event.kind === "turn-work-target"
      ? { threadId: event.threadId, turnId: event.turnId, requestIdKind: event.requestIdKind }
      : null), [{ threadId: "019a-thread-1", turnId: "019a-turn-1", requestIdKind: "native" }]);

    // Connection fencing: one generation, strictly increasing sequences.
    const connectionIds = new Set(harness.events.map((event) => event.connectionId));
    assert.equal(connectionIds.size, 1);
    const sequences = harness.events.map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(new Set(sequences).size, sequences.length);

    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("native helper request ids are labelled as helper traffic, never silently promoted", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({
      id: "init-h",
      method: "initialize",
      params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } },
    }, { maskKey: Buffer.from([1, 1, 1, 1]) }));

    await tuiRequest(tui, harness.upstream, jsonFrame({
      id: "temporary-structured-42",
      method: "turn/start",
      params: { threadId: "019a-thread-h", input: [{ type: "text", text: PROMPT_SENTINEL }] },
    }, { maskKey: Buffer.from([2, 2, 2, 2]) }));
    harness.upstream.send(jsonFrame({ id: "temporary-structured-42", result: { turn: { id: "019a-turn-h" } } }));

    await until(() => eventsOfKind(harness.events, "turn-work-target").length === 1, "helper-labelled work target");
    const workTarget = eventsOfKind(harness.events, "turn-work-target")[0];
    assert.ok(workTarget?.kind === "turn-work-target");
    assert.equal(workTarget.requestIdKind, "native-helper");
    assert.equal(workTarget.threadId, "019a-thread-h");
    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("a failed thread or turn response projects nothing, and no root is inferred", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([3, 3, 3, 3]) }));
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "t1", method: "thread/start", params: { cwd: CWD_SENTINEL } },
      { maskKey: Buffer.from([4, 4, 4, 4]) }));
    harness.upstream.send(jsonFrame({ id: "t1", error: { code: -32603, message: ERROR_MESSAGE_SENTINEL } }));

    await sleep(60);
    assert.equal(eventsOfKind(harness.events, "thread-candidate").length, 0);
    assert.equal(eventsOfKind(harness.events, "turn-work-target").length, 0);
    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("server approvals are observed with no relay reply until the TUI answers", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([1, 2, 3, 5]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");
    const afterInitialize = harness.upstream.postHead(0).length;
    harness.upstream.send(jsonFrame({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "019a-thread-a", command: ["/bin/sh", "-c", COMMAND_SENTINEL], cwd: CWD_SENTINEL },
    }));

    await until(() => eventsOfKind(harness.events, "input-request").length === 1, "input-request metadata");
    const inputRequest = eventsOfKind(harness.events, "input-request")[0];
    assert.ok(inputRequest?.kind === "input-request");
    assert.deepEqual({ requestId: inputRequest.requestId, method: inputRequest.method, threadId: inputRequest.threadId },
      { requestId: "7", method: "item/commandExecution/requestApproval", threadId: "019a-thread-a" });

    // The relay answers nothing on its own.
    await sleep(80);
    assert.equal(harness.upstream.postHead(0).length, afterInitialize, "the relay must never reply for the TUI");

    // Only the genuine TUI's own reply crosses the wire.
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: 7, result: { decision: ANSWER_SENTINEL } }, { maskKey: Buffer.from([7, 7, 7, 7]) }));
    assert.equal(harness.upstream.postHead(0).length > afterInitialize, true);

    harness.upstream.send(jsonFrame({ id: 8, method: "item/tool/requestUserInput", params: { threadId: "019a-thread-a", questions: [{ label: OPTION_SENTINEL }] } }));
    await until(() => eventsOfKind(harness.events, "input-request").length === 2, "second input-request");
    tui.write(jsonFrame({ id: 8, error: { code: -32602, message: ERROR_MESSAGE_SENTINEL } }, { maskKey: Buffer.from([8, 8, 8, 8]) }));

    await until(() => eventsOfKind(harness.events, "input-response").length === 2, "input-response metadata");
    assert.deepEqual(eventsOfKind(harness.events, "input-response").map((event) => event.kind === "input-response"
      ? { requestId: event.requestId, method: event.method, hasError: event.hasError }
      : null), [
      { requestId: "7", method: "item/commandExecution/requestApproval", hasError: false },
      { requestId: "8", method: "item/tool/requestUserInput", hasError: true },
    ]);

    // Backend requests outside the closed human-input allowlist are never
    // operator input: no projection, and their replies are never correlated.
    for (const method of ["currentTime/read", "item/tool/call", "someFuture/request"]) {
      harness.upstream.send(jsonFrame({ id: `n-${method}`, method, params: { threadId: "019a-thread-a" } }));
    }
    await sleep(60);
    assert.equal(eventsOfKind(harness.events, "input-request").length, 2, "only allowlisted requests project");
    tui.write(jsonFrame({ id: "n-currentTime/read", result: { epochMilliseconds: 1 } }, { maskKey: Buffer.from([6, 6, 6, 6]) }));
    await sleep(40);
    assert.equal(eventsOfKind(harness.events, "input-response").length, 2, "non-input replies are never correlated");
    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("typed item phases project closed categories and unknown kinds are ignored", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([1, 1, 2, 2]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");

    harness.upstream.send(jsonFrame({
      method: "item/started",
      params: {
        threadId: "019a-thread-i",
        turnId: "019a-turn-i",
        item: { type: "commandExecution", id: "item-1", command: COMMAND_SENTINEL, cwd: CWD_SENTINEL },
      },
    }));
    harness.upstream.send(jsonFrame({
      method: "item/completed",
      params: {
        threadId: "019a-thread-i",
        turnId: "019a-turn-i",
        item: { type: "mcpToolCall", id: "item-2", output: OUTPUT_SENTINEL },
      },
    }));
    harness.upstream.send(jsonFrame({
      method: "item/started",
      params: { threadId: "019a-thread-i", item: { type: "quantumLeap", id: "item-unknown" } },
    }));

    await until(() => eventsOfKind(harness.events, "item-phase").length === 2, "two item phases");
    assert.deepEqual(eventsOfKind(harness.events, "item-phase").map((event) => event.kind === "item-phase"
      ? { phase: event.phase, itemKind: event.itemKind, itemId: event.itemId, threadId: event.threadId, turnId: event.turnId, toolCategory: event.toolCategory }
      : null), [
      { phase: "started", itemKind: "commandExecution", itemId: "item-1", threadId: "019a-thread-i", turnId: "019a-turn-i", toolCategory: "command" },
      { phase: "completed", itemKind: "mcpToolCall", itemId: "item-2", threadId: "019a-thread-i", turnId: "019a-turn-i", toolCategory: "mcp-tool" },
    ]);
    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("traffic from a non-native client is forwarded but never becomes metadata", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    // Another client of the same backend identifies itself as a backend tool.
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "x1", method: "initialize", params: { clientInfo: { name: "codex-backend" } } },
      { maskKey: Buffer.from([1, 1, 1, 2]) }));
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "x2", method: "thread/start", params: { cwd: CWD_SENTINEL } },
      { maskKey: Buffer.from([2, 2, 2, 3]) }));
    harness.upstream.send(jsonFrame({ id: "x2", result: { thread: { id: "019a-foreign" } } }));
    harness.upstream.send(jsonFrame({ method: "item/started", params: { item: { type: "commandExecution", id: "foreign-1" } } }));

    await sleep(80);
    assert.equal(eventsOfKind(harness.events, "genuine-tui-initialize").length, 0);
    assert.equal(eventsOfKind(harness.events, "thread-candidate").length, 0);
    assert.equal(eventsOfKind(harness.events, "item-phase").length, 0);
    // Forwarding is unaffected.
    assert.equal(harness.upstream.postHead(0).length > 0, true);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("unreadable and unknown messages are forwarded, reported, and never answered", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([4, 4, 4, 4]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");
    const unreadableCount = (): number => harness.events.filter((event) =>
      event.kind === "metadata-unavailable" && event.reason === "json-unreadable").length;
    const before = harness.upstream.postHead(0).length;

    const junk = [
      Buffer.from("this is not json at all", "utf8"),
      Buffer.from('{"jsonrpc":"2.0", id: broken', "utf8"),
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "weird", method: "unheard/ofMethod", params: { anything: 1 } }), "utf8"),
    ].map((payload) => buildFrame(0x02, payload, { maskKey: Buffer.from([9, 8, 7, 6]) }));
    const expected = Buffer.concat(junk);
    tui.write(expected);

    await harness.upstream.waitForPostHead(before + expected.length);
    assert.equal(harness.upstream.postHead(0).subarray(before).equals(expected), true);
    await sleep(40);
    assert.equal(harness.upstream.postHead(0).length, before + expected.length, "no relay-generated reply");
    assert.equal(eventsOfKind(harness.events, "thread-candidate").length, 0);
    assert.equal(eventsOfKind(harness.events, "input-request").length, 0);
    // The two undecodable messages are reported with a fixed, payload-free
    // reason; the parseable-but-unknown message is not metadata at all.
    assert.equal(unreadableCount(), 2, "unreadable client messages are reported");

    // The same holds in the backend -> TUI direction.
    const clientBefore = tui.received.length;
    const serverJunk = buildFrame(0x01, Buffer.from("<<definitely not json>>", "utf8"));
    harness.upstream.send(serverJunk);
    await tui.waitForReceived(clientBefore + serverJunk.length);
    assert.equal(tui.received.subarray(clientBefore).equals(serverJunk), true);
    await until(() => unreadableCount() === 3, "unreadable backend message is reported");

    // The tap survives a decode failure and keeps projecting.
    harness.upstream.send(jsonFrame({ method: "item/started", params: { item: { type: "plan", id: "plan-1" } } }));
    await until(() => eventsOfKind(harness.events, "item-phase").length === 1, "projection after a decode failure");
    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("oversized metadata messages are forwarded in full and projected as unavailable", async () => {
  const harness = await startHarness({ metadataMaxMessageBytes: 1_024 });
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([1, 3, 5, 7]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");

    const before = harness.upstream.postHead(0).length;
    const big = jsonFrame({ id: "big", method: "turn/start", params: { threadId: "019a-thread-big", text: "z".repeat(4_000) } },
      { maskKey: Buffer.from([2, 4, 6, 8]) });
    tui.write(big);
    await harness.upstream.waitForPostHead(before + big.length);
    assert.equal(harness.upstream.postHead(0).subarray(before).equals(big), true);

    await until(() => eventsOfKind(harness.events, "metadata-unavailable").length === 1, "oversize notice");
    const unavailable = eventsOfKind(harness.events, "metadata-unavailable")[0];
    assert.ok(unavailable?.kind === "metadata-unavailable");
    assert.equal(unavailable.scope, "message");
    assert.equal(unavailable.reason, "message-oversize");
    // The tap stays alive for later, smaller messages.
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "th", method: "thread/resume", params: { threadId: "019a-thread-x" } },
      { maskKey: Buffer.from([3, 3, 3, 3]) }));
    harness.upstream.send(jsonFrame({ id: "th", result: { thread: { id: "019a-thread-x" } } }));
    await until(() => eventsOfKind(harness.events, "thread-candidate").length === 1, "later projection");
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("detachMetadataTap stops projection without touching the transport", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([1, 1, 1, 1]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");

    harness.lease.detachMetadataTap();
    assert.equal(harness.lease.status().metadataTapEnabled, false);
    assert.equal(harness.lease.status().activeConnections, 1);

    const before = harness.upstream.postHead(0).length;
    const request = jsonFrame({ id: "t9", method: "turn/start", params: { threadId: "019a-thread-d" } },
      { maskKey: Buffer.from([2, 2, 2, 2]) });
    tui.write(request);
    await harness.upstream.waitForPostHead(before + request.length);
    const response = jsonFrame({ id: "t9", result: { turn: { id: "019a-turn-d" } } });
    const clientBefore = tui.received.length;
    harness.upstream.send(response);
    await tui.waitForReceived(clientBefore + response.length);

    assert.equal(harness.upstream.postHead(0).subarray(before).equals(request), true);
    assert.equal(tui.received.subarray(clientBefore).equals(response), true);
    assert.equal(eventsOfKind(harness.events, "turn-work-target").length, 0);
    assert.equal(harness.lease.status().activeConnections, 1);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("a reconnect starts a new generation and old request ids never bleed", async () => {
  const harness = await startHarness();
  try {
    const first = await connectTui(harness, 0);
    await tuiRequest(first.tui, harness.upstream, jsonFrame({ id: "i1", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([1, 1, 1, 1]) }));
    await tuiRequest(first.tui, harness.upstream, jsonFrame({ id: "pending-1", method: "thread/start", params: { cwd: CWD_SENTINEL } },
      { maskKey: Buffer.from([2, 2, 2, 2]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "first initialize");

    first.tui.destroy();
    await until(() => eventsOfKind(harness.events, "generation-closed").length === 1, "first generation close");
    await until(() => harness.lease.status().activeConnections === 0, "slot released");

    const second = await connectTui(harness, 1);
    assert.equal(harness.lease.status().connectionGenerations, 2);
    await tuiRequest(second.tui, harness.upstream, jsonFrame({ id: "i2", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([3, 3, 3, 3]) }), 1);
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 2, "second initialize");

    // A late response carrying the PREVIOUS generation's id must not project.
    harness.upstream.send(jsonFrame({ id: "pending-1", result: { thread: { id: "019a-STALE" } } }), 1);
    await sleep(80);
    assert.equal(eventsOfKind(harness.events, "thread-candidate").length, 0);

    const connectionIds = new Set(harness.events.filter((event) => event.kind !== "generation-closed").map((event) => event.connectionId));
    assert.equal(connectionIds.size, 2);
    const closed = eventsOfKind(harness.events, "generation-closed");
    assert.equal(closed.length, 1);
    assert.ok(closed[0]?.kind === "generation-closed");
    assert.ok(["client-closed", "backend-closed"].includes(closed[0].reason));
    second.tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("a second concurrent connection is refused while one is active and accepted afterwards", async () => {
  const harness = await startHarness();
  try {
    const first = await connectTui(harness, 0);
    const readiness = await harness.ready();

    const busy = await FakeTui.connect(readiness.port);
    const busyHead = await busy.handshake();
    assert.match(busyHead, /^HTTP\/1\.1 503 /);
    assert.equal(busyHead.includes("jsonrpc"), false);
    assert.equal(harness.upstream.connections.length, 1);
    assert.equal(harness.lease.status().refusedBusy, 1);
    assert.equal(harness.lease.status().activeConnections, 1);
    busy.destroy();

    first.tui.destroy();
    await until(() => harness.lease.status().activeConnections === 0, "first slot released");

    const second = await connectTui(harness, 1);
    assert.equal(harness.lease.status().activeConnections, 1);
    assert.equal(harness.lease.status().connectionGenerations, 2);
    second.tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("a backend refusal is copied to the TUI unchanged and the generation closes", async () => {
  const harness = await startHarness({
    upstream: { respond: () => "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n" },
  });
  try {
    const readiness = await harness.ready();
    const tui = await FakeTui.connect(readiness.port);
    const responseHead = await tui.handshake();
    assert.match(responseHead, /^HTTP\/1\.1 404 Not Found/);
    assert.equal(responseHead.includes("jsonrpc"), false);

    await until(() => eventsOfKind(harness.events, "generation-closed").length === 1, "generation closed");
    const closed = eventsOfKind(harness.events, "generation-closed")[0];
    assert.ok(closed?.kind === "generation-closed");
    assert.equal(closed.reason, "backend-handshake-rejected");
    assert.equal(harness.lease.status().activeConnections, 0);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("a throwing metadata consumer is contained and the native path stays alive", async () => {
  const harness = await startHarness({
    onMetadata: () => {
      throw new Error(`${ERROR_MESSAGE_SENTINEL} consumer exploded`);
    },
  });
  try {
    const { tui } = await connectTui(harness, 0);
    const request = jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([1, 1, 1, 1]) });
    tui.write(request);
    await harness.upstream.waitForPostHead(request.length);

    const response = jsonFrame({ id: "i", result: { userAgent: "codex" } });
    const before = tui.received.length;
    harness.upstream.send(response);
    await tui.waitForReceived(before + response.length);

    assert.equal(harness.lease.status().metadataCallbackErrors > 0, true);
    assert.equal(harness.lease.status().activeConnections, 1);
    assert.equal(harness.upstream.postHead(0).subarray(0, request.length).equals(request), true);
    assert.equal(tui.received.subarray(before).equals(response), true);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("backpressure from a stalled backend does not lose or reorder genuine bytes", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    const connection = await harness.upstream.waitForConnection(0);
    connection.socket.pause();

    // Large enough that the stalled side must apply real backpressure.
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const frames = Buffer.concat([
      buildFrame(0x02, payload.subarray(0, 2 * 1024 * 1024), { maskKey: Buffer.from([1, 2, 3, 4]) }),
      buildFrame(0x02, payload.subarray(2 * 1024 * 1024), { maskKey: Buffer.from([5, 6, 7, 8]) }),
    ]);
    tui.write(frames);

    // Let the socket buffers fill, then drain.
    await sleep(80);
    connection.socket.resume();
    await harness.upstream.waitForPostHead(frames.length, 0);
    assert.equal(harness.upstream.postHead(0).equals(frames), true);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("stop settles on real listener and socket closes, before and during connections", async () => {
  // Stop before the bind completes.
  const early = await startHarness();
  early.lease.requestStop();
  await assert.rejects(early.lease.readinessPromise, (error: unknown) => {
    assert.ok(error instanceof NativeCodexTuiRelayError);
    assert.equal(error.code, "stopped");
    return true;
  });
  const earlySettlement = await bounded(early.lease.settlementPromise, "early settlement");
  assert.equal(earlySettlement.listenerClosed, true);
  assert.equal(earlySettlement.socketsClosed, true);
  assert.equal(early.lease.status().phase, "stopped");
  assert.equal(early.lease.status().openSockets, 0);
  await early.upstream.stop();

  // Stop while a connection is live.
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    const upstreamConnection = await harness.upstream.waitForConnection(0);
    let upstreamClosed = false;
    let tuiClosed = false;
    upstreamConnection.socket.on("close", () => {
      upstreamClosed = true;
    });
    tui.socket.on("close", () => {
      tuiClosed = true;
    });
    assert.equal(harness.lease.status().openSockets, 2);
    harness.lease.requestStop();
    // Settlement is never faked: the relay is still `stopping` until the real
    // close events land, and both sockets had actually closed by the time the
    // settlement promise resolved.
    assert.equal(harness.lease.status().phase, "stopping");
    assert.equal(harness.lease.status().openSockets > 0, true, "settlement must not precede the real closes");
    const settled = await bounded(harness.lease.settlementPromise, "live settlement");
    assert.deepEqual(settled, {
      status: "settled",
      listenerClosed: true,
      socketsClosed: true,
      connectionGenerations: 1,
    });
    await until(() => upstreamClosed && tuiClosed, "peer-side socket closes");
    const status = harness.lease.status();
    assert.equal(status.phase, "stopped");
    assert.equal(status.listening, false);
    assert.equal(status.openSockets, 0);
    assert.equal(status.activeConnections, 0);
    // Idempotent: a second stop never re-opens or re-settles anything.
    harness.lease.requestStop();
    assert.equal((await harness.lease.settlementPromise).status, "settled");
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("the relay never dials anything other than the owned backend endpoint", async () => {
  const harness = await startHarness();
  const other = await new FakeUpstream({ respond: () => "HTTP/1.1 418 Teapot\r\n\r\n" }).start();
  try {
    const { tui } = await connectTui(harness, 0);
    // A TUI asking for another origin is still just bytes on this connection.
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([1, 1, 1, 1]) }));
    await sleep(40);
    assert.equal(other.connections.length, 0);
    assert.equal(harness.upstream.connections.length, 1);
    assert.equal(harness.upstream.requestHead(0).includes(`Host: 127.0.0.1:${harness.upstream.port}`), true);
    tui.destroy();
  } finally {
    await other.stop();
    await harness.teardown();
  }
});

test("a 101 coalesced with a large frame and a handshake coalesced with frames stay intact", async () => {
  // A valid 101 head followed in the SAME write by far more than the response
  // header bound must not be mistaken for an oversized header.
  const extra = buildFrame(0x01, Buffer.from(JSON.stringify({
    method: "item/started",
    params: { item: { type: "unmodeledItemShape", id: "x".repeat(24 * 1024) } },
  }), "utf8"));
  assert.ok(extra.length > 16 * 1024, "the coalesced frame must exceed the response header bound");

  const harness = await startHarness({ upstream: { extraAfterResponse: extra } });
  try {
    const readiness = await harness.ready();
    const tui = await FakeTui.connect(readiness.port);
    const initializeFrame = jsonFrame({
      id: "i",
      method: "initialize",
      params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } },
    }, { maskKey: Buffer.from([1, 1, 1, 1]) });

    // The request head and a following frame also share one write.
    const responseHead = await tui.handshake({ trailingBytes: initializeFrame });
    await harness.upstream.waitForConnection(0);

    const expectedClient = Buffer.concat([Buffer.from(responseHead, "latin1"), extra]);
    await tui.waitForReceived(expectedClient.length);
    assert.equal(tui.received.subarray(0, expectedClient.length).equals(expectedClient), true);

    await harness.upstream.waitForPostHead(initializeFrame.length);
    assert.equal(harness.upstream.postHead(0).equals(initializeFrame), true);
    assert.equal(harness.upstream.requestHead(0).includes(`Host: 127.0.0.1:${harness.upstream.port}`), true);

    // Both directions stayed live, and the coalesced preface was still tapped.
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize from the coalesced preface");
    assert.equal(harness.lease.status().activeConnections, 1);
    assert.equal(eventsOfKind(harness.events, "metadata-unavailable").length, 0);

    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "t1", method: "thread/start", params: { cwd: CWD_SENTINEL } },
      { maskKey: Buffer.from([2, 2, 2, 2]) }));
    harness.upstream.send(jsonFrame({ id: "t1", result: { thread: { id: "019a-coalesced" } } }));
    await until(() => eventsOfKind(harness.events, "thread-candidate").length === 1, "correlation after coalescing");
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("interleaved ping and pong payloads never join a fragmented message", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({
      id: "i",
      method: "initialize",
      params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } },
    }, { maskKey: Buffer.from([1, 2, 3, 4]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");

    // Client side: control frames with payloads between fragments.
    const partOne = Buffer.from('{"jsonrpc":"2.0","id":"frag-1","method":"thread/start","params":{"cwd":', "utf8");
    const partTwo = Buffer.from(`"${CWD_SENTINEL}"}}`, "utf8");
    const clientFrames = [
      buildFrame(0x01, partOne, { fin: false, maskKey: Buffer.from([0x11, 0x11, 0x11, 0x11]) }),
      buildFrame(0x09, Buffer.from("keepalive-ping", "utf8"), { maskKey: Buffer.from([0x22, 0x22, 0x22, 0x22]) }),
      buildFrame(0x0a, Buffer.from("keepalive-pong", "utf8"), { maskKey: Buffer.from([0x33, 0x33, 0x33, 0x33]) }),
      buildFrame(0x00, partTwo, { fin: true, maskKey: Buffer.from([0x44, 0x44, 0x44, 0x44]) }),
    ];
    const expectedClient = Buffer.concat(clientFrames);
    await tuiRequest(tui, harness.upstream, expectedClient);
    harness.upstream.send(jsonFrame({ id: "frag-1", result: { thread: { id: "019a-fragmented" } } }));
    await until(() => eventsOfKind(harness.events, "thread-candidate").length === 1, "fragmented request correlation");
    const candidate = eventsOfKind(harness.events, "thread-candidate")[0];
    assert.ok(candidate?.kind === "thread-candidate");
    assert.equal(candidate.threadId, "019a-fragmented");

    // Backend side: the same interleaving inside a notification.
    const serverFrames = [
      buildFrame(0x01, Buffer.from('{"method":"item/started","params":{"item":{"type":"webSearch","id":', "utf8"), { fin: false }),
      buildFrame(0x09, Buffer.from("server-payload", "utf8")),
      buildFrame(0x00, Buffer.from('"it-pong"}}}', "utf8"), { fin: true }),
    ];
    const expectedServer = Buffer.concat(serverFrames);
    const clientBefore = tui.received.length;
    harness.upstream.send(expectedServer);
    await tui.waitForReceived(clientBefore + expectedServer.length);
    assert.equal(tui.received.subarray(clientBefore).equals(expectedServer), true);

    await until(() => eventsOfKind(harness.events, "item-phase").length === 1, "fragmented item phase");
    const item = eventsOfKind(harness.events, "item-phase")[0];
    assert.ok(item?.kind === "item-phase");
    assert.deepEqual({ itemKind: item.itemKind, itemId: item.itemId, toolCategory: item.toolCategory },
      { itemKind: "webSearch", itemId: "it-pong", toolCategory: "web-search" });
    // Control payloads did not corrupt either reassembly.
    assert.equal(eventsOfKind(harness.events, "metadata-unavailable").length, 0);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("an initialize without the human-approval capability never unlocks metadata", async () => {
  for (const capabilities of [undefined, { requiredHumanApproval: false }]) {
    const harness = await startHarness();
    try {
      const { tui } = await connectTui(harness, 0);
      await tuiRequest(tui, harness.upstream, jsonFrame({
        id: "gate-1",
        method: "initialize",
        params: {
          clientInfo: { name: "codex-tui" },
          ...(capabilities === undefined ? {} : { capabilities }),
        },
      }, { maskKey: Buffer.from([1, 2, 3, 4]) }));
      await tuiRequest(tui, harness.upstream, jsonFrame({ id: "gate-2", method: "thread/start", params: { cwd: CWD_SENTINEL } },
        { maskKey: Buffer.from([5, 6, 7, 8]) }));
      harness.upstream.send(jsonFrame({ id: "gate-2", result: { thread: { id: "019a-gated" } } }));
      harness.upstream.send(jsonFrame({ id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "019a-gated", command: COMMAND_SENTINEL } }));

      await sleep(80);
      assert.equal(eventsOfKind(harness.events, "genuine-tui-initialize").length, 0);
      assert.equal(eventsOfKind(harness.events, "thread-candidate").length, 0);
      assert.equal(eventsOfKind(harness.events, "input-request").length, 0);
      // Forwarding is unaffected by the closed gate.
      assert.equal(harness.upstream.postHead(0).length > 0, true);
      assert.equal(harness.lease.status().activeConnections, 1);

      // A later initialize that carries the capability unlocks this connection.
      await tuiRequest(tui, harness.upstream, jsonFrame({
        id: "gate-3",
        method: "initialize",
        params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } },
      }, { maskKey: Buffer.from([9, 9, 9, 9]) }));
      await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "capability-bearing initialize unlocks");
      await tuiRequest(tui, harness.upstream, jsonFrame({ id: "gate-4", method: "turn/start", params: { threadId: "019a-gated" } },
        { maskKey: Buffer.from([3, 3, 3, 3]) }));
      harness.upstream.send(jsonFrame({ id: "gate-4", result: { turn: { id: "019a-turn-gated" } } }));
      await until(() => eventsOfKind(harness.events, "turn-work-target").length === 1, "correlation after the unlock");
      tui.destroy();
    } finally {
      await harness.teardown();
    }
  }
});

test("the three native approval methods project and correlate with the TUI's own replies", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({
      id: "i",
      method: "initialize",
      params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } },
    }, { maskKey: Buffer.from([1, 2, 3, 4]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");
    const afterInitialize = harness.upstream.postHead(0).length;

    harness.upstream.send(jsonFrame({
      id: 100,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "019a-thread-ap", command: ["/bin/sh", "-c", COMMAND_SENTINEL], cwd: CWD_SENTINEL },
    }));
    harness.upstream.send(jsonFrame({
      id: 101,
      method: "item/fileChange/requestApproval",
      params: { threadId: "019a-thread-ap", changes: OUTPUT_SENTINEL },
    }));
    harness.upstream.send(jsonFrame({
      id: 102,
      method: "item/permissions/requestApproval",
      params: { threadId: "019a-thread-ap", reason: OPTION_SENTINEL },
    }));

    await until(() => eventsOfKind(harness.events, "input-request").length === 3, "three approval requests");
    assert.deepEqual(eventsOfKind(harness.events, "input-request").map((event) => event.kind === "input-request"
      ? { requestId: event.requestId, method: event.method, threadId: event.threadId }
      : null), [
      { requestId: "100", method: "item/commandExecution/requestApproval", threadId: "019a-thread-ap" },
      { requestId: "101", method: "item/fileChange/requestApproval", threadId: "019a-thread-ap" },
      { requestId: "102", method: "item/permissions/requestApproval", threadId: "019a-thread-ap" },
    ]);

    // Nothing was answered on the TUI's behalf.
    await sleep(80);
    assert.equal(harness.upstream.postHead(0).length, afterInitialize, "the relay must never reply for the TUI");

    await tuiRequest(tui, harness.upstream, jsonFrame({ id: 100, result: { decision: ANSWER_SENTINEL } }, { maskKey: Buffer.from([5, 5, 5, 5]) }));
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: 101, result: { decision: ANSWER_SENTINEL } }, { maskKey: Buffer.from([6, 6, 6, 6]) }));
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: 102, error: { code: -32602, message: ERROR_MESSAGE_SENTINEL } }, { maskKey: Buffer.from([7, 7, 7, 7]) }));

    await until(() => eventsOfKind(harness.events, "input-response").length === 3, "three input responses");
    assert.deepEqual(eventsOfKind(harness.events, "input-response").map((event) => event.kind === "input-response"
      ? { requestId: event.requestId, method: event.method, hasError: event.hasError }
      : null), [
      { requestId: "100", method: "item/commandExecution/requestApproval", hasError: false },
      { requestId: "101", method: "item/fileChange/requestApproval", hasError: false },
      { requestId: "102", method: "item/permissions/requestApproval", hasError: true },
    ]);
    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("pre-upgrade traffic beyond the metadata budget withdraws the generation's metadata", async () => {
  // The fake backend withholds its 101 so genuine-looking client traffic piles
  // up before the tap exists, and the stream crosses the metadata read budget
  // in the middle of a frame.
  const harness = await startHarness({
    metadataMaxMessageBytes: 1_024,
    upstream: { respondDelayMs: 150 },
  });
  try {
    const readiness = await harness.ready();
    const tui = await FakeTui.connect(readiness.port);
    tui.writeHandshakeHead();
    await harness.upstream.waitForConnection(0);
    await until(() => harness.upstream.requestHead(0).length > 0, "the relay dialed and forwarded the head");

    const big = buildFrame(0x02, Buffer.alloc(3_000, 0x7a), { maskKey: Buffer.from([1, 2, 3, 4]) });
    tui.write(big.subarray(0, 1_500));
    await sleep(20);
    tui.write(big.subarray(1_500));
    const initialize = jsonFrame({
      id: "pre-1",
      method: "initialize",
      params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } },
    }, { maskKey: Buffer.from([9, 9, 9, 9]) });
    tui.write(initialize);

    const responseHead = await tui.readHandshakeResponse();
    const forwarded = Buffer.concat([big, initialize]);
    await harness.upstream.waitForPostHead(forwarded.length);
    // Forwarding is byte-exact and never waited on the tap.
    assert.equal(harness.upstream.postHead(0).equals(forwarded), true);
    assert.equal(tui.received.subarray(0, responseHead.length).equals(Buffer.from(responseHead, "latin1")), true);

    // Metadata is withdrawn once, for the whole connection, with a closed reason.
    await until(() => eventsOfKind(harness.events, "metadata-unavailable").length === 1, "connection-scoped withdrawal");
    const withdrawn = eventsOfKind(harness.events, "metadata-unavailable")[0];
    assert.ok(withdrawn?.kind === "metadata-unavailable");
    assert.deepEqual({ scope: withdrawn.scope, reason: withdrawn.reason },
      { scope: "connection", reason: "message-oversize" });

    // Perfectly valid later traffic still projects nothing for this generation.
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "late-1", method: "thread/start", params: { cwd: CWD_SENTINEL } },
      { maskKey: Buffer.from([2, 2, 2, 2]) }));
    const lateResponse = jsonFrame({ id: "late-1", result: { thread: { id: "019a-late" } } });
    harness.upstream.send(lateResponse);
    const before = tui.received.length;
    await tui.waitForReceived(before + lateResponse.length);
    await sleep(60);

    assert.equal(eventsOfKind(harness.events, "genuine-tui-initialize").length, 0);
    assert.equal(eventsOfKind(harness.events, "thread-candidate").length, 0);
    assert.equal(eventsOfKind(harness.events, "metadata-unavailable").length, 1, "withdrawal is reported once");
    // The native path stayed alive and byte-exact in both directions.
    assert.equal(harness.lease.status().activeConnections, 1);
    assert.equal(tui.received.subarray(before).equals(lateResponse), true);
    assertNoSentinels(JSON.stringify(harness.events));
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

/** Large enough that a stalled peer keeps data in flight across the close. */
function queuedTailPayload(): Buffer {
  return Buffer.concat([
    Buffer.alloc(4 * 1024 * 1024 - 48, 0x5a),
    Buffer.from("|final-tail-of-the-orderly-stream", "utf8"),
  ]);
}

function closedGeneration(
  events: readonly NativeCodexTuiRelayMetadataEvent[],
): { readonly reason: string } | undefined {
  const event = eventsOfKind(events, "generation-closed")[0];
  return event?.kind === "generation-closed" ? { reason: event.reason } : undefined;
}

test("an orderly TUI EOF with a stalled backend forwards the whole queued tail", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    const connection = await harness.upstream.waitForConnection(0);
    const payload = queuedTailPayload();
    const before = harness.upstream.postHead(0).length;

    connection.socket.pause();
    tui.write(payload);
    await sleep(120);
    // Orderly EOF from the TUI while the backend has consumed nothing.
    tui.socket.end();
    await sleep(120);

    const delivered = harness.upstream.postHead(0).length - before;
    assert.ok(delivered < payload.length, "the stalled backend must not have consumed the payload yet");

    connection.socket.resume();
    await harness.upstream.waitForPostHead(before + payload.length, 0);
    assert.equal(
      harness.upstream.postHead(0).subarray(before, before + payload.length).equals(payload),
      true,
      "every queued byte, including the final tail, must reach the backend",
    );
    await until(() => connection.ended, "the backend saw the orderly EOF");
    await until(() => closedGeneration(harness.events) !== undefined, "generation closed after the drain");
    assert.deepEqual(closedGeneration(harness.events), { reason: "client-closed" });
    await until(() => harness.lease.status().openSockets === 0, "every relay socket closed");
    assert.equal(harness.lease.status().openSockets, 0);
  } finally {
    await harness.teardown();
  }
});

test("an orderly backend EOF with a stalled TUI forwards the whole queued tail", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    const connection = await harness.upstream.waitForConnection(0);
    const payload = queuedTailPayload();
    const before = tui.received.length;

    tui.socket.pause();
    connection.socket.write(payload);
    await sleep(120);
    // Orderly EOF from the backend while the TUI has consumed nothing.
    connection.socket.end();
    await sleep(120);

    assert.ok(tui.received.length - before < payload.length, "the stalled TUI must not have consumed the payload yet");

    tui.socket.resume();
    await until(() => tui.received.length - before >= payload.length, "the queued tail flushed to the TUI");
    assert.equal(
      tui.received.subarray(before, before + payload.length).equals(payload),
      true,
      "every queued byte, including the final tail, must reach the TUI",
    );
    await until(() => closedGeneration(harness.events) !== undefined, "generation closed after the drain");
    assert.deepEqual(closedGeneration(harness.events), { reason: "backend-closed" });
    await until(() => harness.lease.status().openSockets === 0, "every relay socket closed");
    assert.equal(harness.lease.status().openSockets, 0);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

/* ------------------------------------------------ async question projections */

const QUESTION_SENTINEL = "SENTINEL-QUESTION-TITLE";
const THREAD_Q = "019a-thread-q";
const TURN_Q = "019a-turn-q";

function replyEnvelope(replies: unknown): string {
  return `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
}

function questionKey(itemId: string, index: number): string {
  return JSON.stringify(["request_user_input_async", itemId, index]);
}

test("async questions, committed reply envelopes, and live terminals project closed identities only", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    await tuiRequest(tui, harness.upstream, jsonFrame({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } },
      { maskKey: Buffer.from([3, 1, 2, 2]) }));
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");

    const questions = [
      { title: QUESTION_SENTINEL, options: [OPTION_SENTINEL, "second"] },
      { title: "free text", options: null },
    ];
    const send = (method: string, params: Record<string, unknown>): void => {
      harness.upstream.send(jsonFrame({ method, params }));
    };
    const reply = (content: unknown, threadId: string = THREAD_Q): void => {
      send("item/completed", { threadId, turnId: TURN_Q, item: { type: "userMessage", id: "user-1", content } });
    };

    // A started item may already carry questions; the native TUI registers them
    // only on completion, so started projects no question.
    send("item/started", { threadId: THREAD_Q, turnId: TURN_Q, item: { type: "agentMessage", id: "call-q", text: "", delivery: "async", questions } });
    send("item/completed", { threadId: THREAD_Q, turnId: TURN_Q, item: { type: "agentMessage", id: "call-q", text: "", delivery: "async", questions } });
    // An empty list is ignored by the native queue, but it is a complete read
    // of that item's question set and is projected with a zero count.
    send("item/completed", { threadId: THREAD_Q, turnId: TURN_Q, item: { type: "agentMessage", id: "call-empty", text: "", delivery: "async", questions: [] } });
    // An ordinary agent message carries no question at all.
    send("item/completed", { threadId: THREAD_Q, turnId: TURN_Q, item: { type: "agentMessage", id: "msg-plain", text: OUTPUT_SENTINEL } });
    // Unreadable question shapes are gaps, never "none".
    send("item/completed", { threadId: THREAD_Q, turnId: TURN_Q, item: { type: "agentMessage", id: "call-bad", delivery: "async", questions: [{ title: 7 }] } });
    send("item/completed", { threadId: THREAD_Q, turnId: TURN_Q, item: { type: "agentMessage", id: "call-nodelivery", questions } });
    // An unbounded item id cannot scope the gap: it stays turn-scoped.
    send("item/completed", { threadId: THREAD_Q, turnId: TURN_Q, item: { type: "agentMessage", id: "x".repeat(300), delivery: "async", questions } });

    // The canonical machine envelope: one exact key, one whole-item identity,
    // a skill attachment ignored, and the canonical IDE context prefix.
    reply([
      { type: "skill", name: "s", path: "/skills/s" },
      {
        type: "text",
        text: `# Context from my IDE setup:\n${PROMPT_SENTINEL}\n## My request for Codex:\n${replyEnvelope([
          { questionItemId: questionKey("call-q", 1), question: QUESTION_SENTINEL, answer: ANSWER_SENTINEL },
          { questionItemId: "call-older", question: QUESTION_SENTINEL, answer: ANSWER_SENTINEL },
          // An identity longer than any bounded native item id cannot match and is skipped.
          { questionItemId: "x".repeat(300), question: "q", answer: "a" },
        ])}`,
      },
    ]);
    // Not replies: malformed envelope, prose, two text items, missing markers.
    reply([{ type: "text", text: replyEnvelope([{ questionItemId: questionKey("call-q", 0), question: "q" }]) }]);
    reply([{ type: "text", text: `please answer ${questionKey("call-q", 0)}` }]);
    reply([{ type: "text", text: replyEnvelope([{ questionItemId: questionKey("call-q", 0), question: "q", answer: "a" }]) }, { type: "text", text: "more" }]);
    reply([{ type: "text", text: JSON.stringify([{ questionItemId: questionKey("call-q", 0), question: "q", answer: "a" }]) }]);
    reply([{ type: "text", text: replyEnvelope([]) }]);
    // Ordinary text that happens to spell an internal outcome name is just text:
    // no reply and no input gap.
    reply([{ type: "text", text: "unreadable" }]);
    reply([{ type: "text", text: "not-reply" }]);
    // An unreadable committed user item could have hidden a reply.
    reply({ not: "a list" });

    // Live terminals: only a terminal status projects.
    send("turn/completed", { threadId: THREAD_Q, turn: { id: "019a-turn-running", status: "inProgress", items: [] } });
    send("turn/completed", { threadId: THREAD_Q, turn: { id: TURN_Q, status: "interrupted", items: [], error: { message: ERROR_MESSAGE_SENTINEL } } });

    await until(() => eventsOfKind(harness.events, "turn-terminal").length === 1, "the terminal projection");
    const asyncEvents = harness.events
      .filter((event) => event.kind === "async-questions" || event.kind === "async-question-reply"
        || event.kind === "async-input-unreadable" || event.kind === "turn-terminal")
      .map((event) => {
        const { connectionId: _connection, sequence: _sequence, ...rest } = event;
        return rest;
      });
    assert.deepEqual(asyncEvents, [
      { kind: "async-questions", itemId: "call-q", questionCount: 2, threadId: THREAD_Q, turnId: TURN_Q },
      { kind: "async-questions", itemId: "call-empty", questionCount: 0, threadId: THREAD_Q, turnId: TURN_Q },
      // A readable item id scopes each question gap to its own item.
      { kind: "async-input-unreadable", source: "questions", itemId: "call-bad", threadId: THREAD_Q, turnId: TURN_Q },
      { kind: "async-input-unreadable", source: "questions", itemId: "call-nodelivery", threadId: THREAD_Q, turnId: TURN_Q },
      { kind: "async-input-unreadable", source: "questions", threadId: THREAD_Q, turnId: TURN_Q },
      {
        kind: "async-question-reply",
        answers: [{ itemId: "call-q", index: 1 }, { itemId: "call-older" }],
        threadId: THREAD_Q,
        turnId: TURN_Q,
      },
      { kind: "async-input-unreadable", source: "user-input", threadId: THREAD_Q, turnId: TURN_Q },
      { kind: "turn-terminal", threadId: THREAD_Q, turnId: TURN_Q, status: "interrupted" },
    ]);
    // The existing item-phase projection is unchanged for the same items.
    assert.ok(eventsOfKind(harness.events, "item-phase").some((event) => event.kind === "item-phase"
      && event.itemKind === "agentMessage" && event.itemId === "call-q" && event.phase === "completed"));
    // No question, option, answer, prompt, or error text crosses the projection.
    const serialized = JSON.stringify(harness.events);
    assertNoSentinels(serialized);
    assert.equal(serialized.includes(QUESTION_SENTINEL), false);
    assert.equal(serialized.includes("free text"), false);
    // Nothing was ever answered or generated by the relay.
    assert.equal(eventsOfKind(harness.events, "input-request").length, 0);
    assert.equal(eventsOfKind(harness.events, "input-response").length, 0);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("own ordinary turn/start and turn/steer input projects at the client frame; reply envelopes and empty input do not", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    let mask = 0;
    const request = async (value: Record<string, unknown>): Promise<void> => {
      mask += 1;
      await tuiRequest(tui, harness.upstream, jsonFrame({ jsonrpc: "2.0", ...value }, { maskKey: Buffer.from([mask, 7, 3, mask]) }));
    };
    const text = (value: string): Record<string, unknown> => ({ type: "text", text: value, text_elements: [] });
    const envelope = replyEnvelope([{ questionItemId: questionKey("call-q", 0), question: QUESTION_SENTINEL, answer: ANSWER_SENTINEL }]);

    // Before the genuine initialize nothing this client sends is metadata.
    await request({ id: "pre-1", method: "turn/start", params: { threadId: THREAD_Q, input: [text(PROMPT_SENTINEL)] } });
    await request({ id: "i", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } });
    await until(() => eventsOfKind(harness.events, "genuine-tui-initialize").length === 1, "genuine initialize");
    assert.equal(eventsOfKind(harness.events, "ordinary-input").length, 0);

    // An ordinary prompt projects as soon as the client frame is observed,
    // before (and independent of) any backend response.
    await request({ id: 7, method: "turn/start", params: { threadId: THREAD_Q, input: [text(PROMPT_SENTINEL)] } });
    await until(() => eventsOfKind(harness.events, "ordinary-input").length === 1, "ordinary turn/start");
    // A steer is the same ordinary submission; it registers no correlation.
    await request({ id: 8, method: "turn/steer", params: { threadId: THREAD_Q, expectedTurnId: TURN_Q, input: [text(PROMPT_SENTINEL)] } });
    // The TUI's own question-answer submission (the canonical envelope, with an
    // ignored skill attachment) keeps its questions until the committed reply.
    await request({ id: 9, method: "turn/start", params: { threadId: THREAD_Q, input: [{ type: "skill", name: "s", path: "/skills/s" }, text(envelope)] } });
    await request({ id: 10, method: "turn/steer", params: { threadId: THREAD_Q, expectedTurnId: TURN_Q, input: [text(envelope)] } });
    // No model input at all is not a submission.
    await request({ id: 11, method: "turn/start", params: { threadId: THREAD_Q, input: [] } });
    await request({ id: 12, method: "turn/start", params: { threadId: THREAD_Q, input: [{ type: "mention", name: "m", path: "app://m" }] } });
    await request({ id: 13, method: "turn/start", params: { threadId: THREAD_Q, input: [text("")] } });
    // Other client requests (status reads, shell commands) are not model input.
    await request({ id: 14, method: "thread/read", params: { threadId: THREAD_Q, input: [text(PROMPT_SENTINEL)] } });
    // Not exactly the envelope: an image beside it, a malformed envelope, prose.
    await request({ id: 15, method: "turn/start", params: { threadId: THREAD_Q, input: [text(envelope), { type: "image", url: "data:x" }] } });
    await request({ id: 16, method: "turn/start", params: { threadId: THREAD_Q, input: [text(replyEnvelope([{ questionItemId: questionKey("call-q", 0), question: "q" }]))] } });
    await request({ id: 17, method: "turn/start", params: { threadId: THREAD_Q, input: [{ type: "localImage", path: "/tmp/x.png" }] } });
    // Unreadable input or thread scope is projected, never dropped as "none".
    await request({ id: 18, method: "turn/start", params: { threadId: THREAD_Q, input: { not: "a list" } } });
    await request({ id: 19, method: "turn/steer", params: { input: [text(PROMPT_SENTINEL)] } });
    await request({ id: 20, method: "turn/start", params: { threadId: THREAD_Q, input: [{ type: "text", text: 5 }] } });
    // Helper traffic is labelled, not deleted; a notification carries nothing.
    await request({ id: "temporary-structured-9", method: "turn/start", params: { threadId: "019a-helper", input: [text(PROMPT_SENTINEL)] } });
    await request({ method: "turn/start", params: { threadId: THREAD_Q, input: [text(PROMPT_SENTINEL)] } });

    await until(() => eventsOfKind(harness.events, "ordinary-input").length === 9, "every ordinary projection");
    // Acknowledgements and errors add nothing and never become a work target for a steer.
    harness.upstream.send(jsonFrame({ id: 8, result: { turnId: TURN_Q } }));
    harness.upstream.send(jsonFrame({ id: 7, error: { code: -32600, message: ERROR_MESSAGE_SENTINEL } }));
    harness.upstream.send(jsonFrame({ id: 9, result: { turn: { id: "019a-turn-answer" } } }));
    await until(() => eventsOfKind(harness.events, "turn-work-target").length === 1, "the answer turn's own work target");
    await sleep(40);

    const ordinary = eventsOfKind(harness.events, "ordinary-input").map((event) => {
      const { connectionId: _connection, sequence: _sequence, ...rest } = event;
      return rest;
    });
    const native = { kind: "ordinary-input", requestIdKind: "native", threadId: THREAD_Q };
    assert.deepEqual(ordinary, [
      native, // ordinary turn/start
      native, // ordinary turn/steer
      native, // envelope beside an image
      native, // malformed envelope
      native, // local image only
      native, // unreadable input list
      { kind: "ordinary-input", requestIdKind: "native" }, // unscoped steer
      native, // unreadable text entry
      { kind: "ordinary-input", requestIdKind: "native-helper", threadId: "019a-helper" },
    ]);
    // No prompt, answer, question, or error text crosses the projection.
    const serialized = JSON.stringify(harness.events);
    assertNoSentinels(serialized);
    assert.equal(serialized.includes(QUESTION_SENTINEL), false);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});

test("resume and fork candidates carry the request's own threadId as id-only provenance; bytes are unchanged", async () => {
  const harness = await startHarness();
  try {
    const { tui } = await connectTui(harness, 0);
    const clientFrames: Buffer[] = [];
    const serverFrames: Buffer[] = [];
    const afterHandshake = tui.received.length;
    const request = async (message: Record<string, unknown>, maskKey: number[]): Promise<void> => {
      const frame = jsonFrame(message, { maskKey: Buffer.from(maskKey) });
      clientFrames.push(frame);
      await tuiRequest(tui, harness.upstream, frame);
    };
    const respond = (message: Record<string, unknown>): void => {
      const frame = jsonFrame(message);
      serverFrames.push(frame);
      harness.upstream.send(frame);
    };
    const restored = "019a0000-0000-7000-8000-00000000000b";

    await request({ id: "init", method: "initialize", params: { clientInfo: { name: "codex-tui" }, capabilities: { requiredHumanApproval: true } } }, [1, 2, 3, 4]);
    // A start never carries a requested thread.
    await request({ id: "s1", method: "thread/start", params: { cwd: CWD_SENTINEL, threadId: "019a-ignored" } }, [5, 6, 7, 8]);
    respond({ id: "s1", result: { thread: { id: "019a-start", ephemeral: false } } });
    // A native pagination retry: the error projects nothing; only the paired
    // success is a candidate, carrying the request's own threadId.
    await request({ id: 7, method: "thread/resume", params: { threadId: restored, cwd: CWD_SENTINEL, excludeTurns: true } }, [9, 9, 9, 9]);
    respond({ id: 7, error: { code: -32600, message: ERROR_MESSAGE_SENTINEL } });
    await request({ id: 8, method: "thread/resume", params: { threadId: restored, cwd: CWD_SENTINEL, excludeTurns: false } }, [2, 4, 6, 8]);
    respond({ id: 8, result: { thread: { id: restored, ephemeral: false, name: NAME_SENTINEL, path: ROLLOUT_SENTINEL }, cwd: CWD_SENTINEL } });
    // A response naming another thread is reported faithfully, never copied
    // into the requested slot.
    await request({ id: "r3", method: "thread/resume", params: { threadId: "019a-asked" } }, [3, 3, 3, 3]);
    respond({ id: "r3", result: { thread: { id: "019a-other" } } });
    // A request without a bounded threadId projects no requested thread.
    await request({ id: "r4", method: "thread/resume", params: { path: ROLLOUT_SENTINEL } }, [4, 4, 4, 4]);
    respond({ id: "r4", result: { thread: { id: "019a-by-path" } } });
    await request({ id: "f1", method: "thread/fork", params: { threadId: restored } }, [6, 6, 6, 6]);
    respond({ id: "f1", result: { thread: { id: "019a-fork", ephemeral: false }, parentThreadId: restored } });
    // A helper resume keeps its label and its own provenance.
    await request({ id: "temporary-structured-9", method: "thread/resume", params: { threadId: "019a-helper" } }, [7, 7, 7, 7]);
    respond({ id: "temporary-structured-9", result: { thread: { id: "019a-helper" } } });

    await until(() => eventsOfKind(harness.events, "thread-candidate").length === 6, "six candidates");
    const serverBytes = Buffer.concat(serverFrames);
    await tui.waitForReceived(afterHandshake + serverBytes.length);

    const candidates = eventsOfKind(harness.events, "thread-candidate");
    assert.deepEqual(candidates.map((event) => event.kind === "thread-candidate"
      ? {
        origin: event.origin,
        requestIdKind: event.requestIdKind,
        threadId: event.threadId,
        requestedThreadId: event.requestedThreadId,
        parentThreadId: event.parentThreadId,
        ephemeral: event.ephemeral,
      }
      : null), [
      { origin: "thread-start", requestIdKind: "native", threadId: "019a-start", requestedThreadId: undefined, parentThreadId: undefined, ephemeral: false },
      { origin: "thread-resume", requestIdKind: "native", threadId: restored, requestedThreadId: restored, parentThreadId: undefined, ephemeral: false },
      { origin: "thread-resume", requestIdKind: "native", threadId: "019a-other", requestedThreadId: "019a-asked", parentThreadId: undefined, ephemeral: undefined },
      { origin: "thread-resume", requestIdKind: "native", threadId: "019a-by-path", requestedThreadId: undefined, parentThreadId: undefined, ephemeral: undefined },
      { origin: "thread-fork", requestIdKind: "native", threadId: "019a-fork", requestedThreadId: restored, parentThreadId: restored, ephemeral: false },
      { origin: "thread-resume", requestIdKind: "native-helper", threadId: "019a-helper", requestedThreadId: "019a-helper", parentThreadId: undefined, ephemeral: undefined },
    ]);
    for (const event of candidates) {
      assert.deepEqual(
        Object.keys(event).filter((key) => !["kind", "connectionId", "sequence", "origin", "requestIdKind", "threadId", "requestedThreadId", "parentThreadId", "ephemeral"].includes(key)),
        [],
        "no other request or response field is projected",
      );
      if (event.kind === "thread-candidate" && event.origin === "thread-start") assert.equal("requestedThreadId" in event, false);
    }
    assert.equal(eventsOfKind(harness.events, "metadata-unavailable").length, 0);
    assertNoSentinels(JSON.stringify(harness.events));

    // Transport is byte-opaque in both directions.
    const clientBytes = Buffer.concat(clientFrames);
    assert.equal(harness.upstream.postHead(0).equals(clientBytes), true, "client frames forwarded unchanged");
    assert.equal(tui.received.subarray(afterHandshake).equals(serverBytes), true, "backend frames forwarded unchanged");
    assert.equal(harness.lease.status().forwardedBytesToBackend, clientBytes.length);
    tui.destroy();
  } finally {
    await harness.teardown();
  }
});
