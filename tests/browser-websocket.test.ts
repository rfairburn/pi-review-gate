import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { activate } from "../src/index";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PUBLIC_ANSWER = "203.0.114.1";

function host() {
  const hooks = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  let active: string[] = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return active; },
    setActiveTools(names: string[]) { active = names; },
    notify(message: string) { notices.push(message); },
    sendMessage() {},
    sendUserMessage() {},
  };
  return {
    pi, commands, notices, tools,
    async emit(name: string, ...args: any[]) {
      const results = [];
      for (const hook of hooks.get(name) ?? []) results.push(await hook(...args));
      return results;
    },
  };
}

async function eventually(body: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await body(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

// --- Minimal RFC 6455 fixture codec (server side of the local origins). ---

interface ParsedFrame { fin: boolean; opcode: number; payload: Buffer; }

function parseFrames(buffer: Buffer): { frames: ParsedFrame[]; rest: Buffer } {
  const frames: ParsedFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let position = offset + 2;
    if (length === 126) {
      if (buffer.length - position < 2) break;
      length = buffer.readUInt16BE(position);
      position += 2;
    } else if (length === 127) {
      if (buffer.length - position < 8) break;
      length = Number(buffer.readBigUInt64BE(position));
      position += 8;
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (buffer.length - position < 4) break;
      mask = buffer.subarray(position, position + 4);
      position += 4;
    }
    if (buffer.length - position < length) break;
    const payload = Buffer.from(buffer.subarray(position, position + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index]! ^= mask[index % 4]!;
    }
    frames.push({ fin, opcode, payload });
    offset = position + length;
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64LE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

interface OriginClient {
  socket: net.Socket | tls.TLSSocket;
  upgradeHead: string;
  sendText(text: string): void;
  close(code: number, reason?: string): void;
  destroy(): void;
}

/**
 * Local WebSocket origin pinned to loopback. Records the raw upgrade head it
 * receives (used to prove broker credentials never reach origins) and drives
 * per-test frame behavior.
 */
class WsOrigin {
  readonly clients: OriginClient[] = [];
  connections = 0;
  receivedText: string[] = [];
  private server: net.Server | tls.Server;

  constructor(
    private readonly behavior: (client: OriginClient, text: string) => void,
    options?: { key?: Buffer; cert?: Buffer },
  ) {
    this.server = options?.key && options.cert
      ? tls.createServer({ key: options.key, cert: options.cert }, (socket) => this.onSocket(socket))
      : net.createServer((socket) => this.onSocket(socket));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  close(): void {
    for (const client of [...this.clients]) client.destroy();
    this.server.close();
  }

  private onSocket(socket: net.Socket | tls.TLSSocket): void {
    this.connections += 1;
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    const sendFrame = (opcode: number, payload: Buffer) => {
      if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
    };
    const close = (code: number, reason?: string) => {
      if (closed) return;
      closed = true;
      const head = Buffer.from([(code >> 8) & 0xff, code & 0xff]);
      sendFrame(0x8, reason ? Buffer.concat([head, Buffer.from(reason.slice(0, 123), "utf8")]) : head);
      socket.end();
    };
    const api: OriginClient = {
      socket,
      upgradeHead: "",
      sendText: (text) => sendFrame(0x1, Buffer.from(text, "utf8")),
      close,
      destroy: () => { closed = true; socket.destroy(); },
    };
    this.clients.push(api);
    // Teardown destroys peers mid-pipe; swallow the resulting ECONNRESET.
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        api.upgradeHead = buffer.subarray(0, end).toString("latin1");
        const keyMatch = /sec-websocket-key:\s*([!-~]+)\r\n/iu.exec(api.upgradeHead);
        const accept = createHash("sha1")
          .update(`${keyMatch?.[1] ?? ""}${WS_GUID}`, "utf8")
          .digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        buffer = Buffer.from(buffer.subarray(end + 4));
      }
      const { frames, rest } = parseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          close(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005);
          return;
        }
        if (frame.opcode === 0x9) { sendFrame(0xa, frame.payload); continue; }
        if (frame.opcode === 0xa) continue;
        if ((frame.opcode === 0x1 || frame.opcode === 0x0) && upgraded) {
          const text = frame.payload.toString("utf8");
          this.receivedText.push(text);
          this.behavior(api, text);
        }
      }
    });
    socket.on("close", () => {
      const index = this.clients.indexOf(api);
      if (index !== -1) this.clients.splice(index, 1);
    });
  }
}

// --- Chess-like fixture: empty board + join dialog until live WS state. ---

const BACK_RANK = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];

function initialPieces(): Array<{ kind: string; color: string; square: string }> {
  const files = "abcdefgh";
  const pieces: Array<{ kind: string; color: string; square: string }> = [];
  for (let file = 0; file < 8; file += 1) {
    pieces.push({ kind: "pawn", color: "white", square: `${files[file]}2` });
    pieces.push({ kind: BACK_RANK[file]!, color: "white", square: `${files[file]}1` });
    pieces.push({ kind: "pawn", color: "black", square: `${files[file]}7` });
    pieces.push({ kind: BACK_RANK[file]!, color: "black", square: `${files[file]}8` });
  }
  return pieces;
}

function chessPageHtml(wsPort: number): string {
  return `<!doctype html><title>Chess</title>
<main>
  <div id="chooser" hidden>
    <button id="white">White</button><button id="black">Black</button><button id="spectate">Spectate</button>
  </div>
  <div id="board"></div>
</main>
<script>
const ws = new WebSocket("ws://chess.test:${wsPort}/game");
window.__wsState = () => ws.readyState;
ws.onopen = () => { document.getElementById("chooser").hidden = false; ws.send(JSON.stringify({ type: "hello" })); };
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type !== "state") return;
  const board = document.getElementById("board");
  board.textContent = "";
  for (const piece of message.pieces) {
    const cell = document.createElement("div");
    cell.className = "piece " + piece.color;
    cell.dataset.square = piece.square;
    cell.textContent = piece.kind;
    board.appendChild(cell);
  }
};
window.__sendMove = (from, to) => ws.send(JSON.stringify({ type: "move", from, to }));
window.__closeWs = (code) => ws.close(code);
</script>`;
}

function createChessOrigin(): { origin: WsOrigin; pieces: Array<{ kind: string; color: string; square: string }>; pushState: () => void } {
  const pieces = initialPieces();
  const state = () => JSON.stringify({ type: "state", pieces });
  let client: OriginClient | undefined;
  const origin = new WsOrigin((active, text) => {
    client = active;
    let message: { type?: string; from?: string; to?: string };
    try { message = JSON.parse(text); } catch { return; }
    if (message.type === "hello") active.sendText(state());
    else if (message.type === "move" && message.from && message.to) {
      const piece = pieces.find((entry) => entry.square === message.from);
      if (piece) { piece.square = message.to; active.sendText(state()); }
    }
  });
  return { origin, pieces, pushState: () => client?.sendText(state()) };
}

function createHttpOrigin(body: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

interface ManagerHarness {
  manager: InteractiveBrowserManager;
  dials: number[];
  sockets: Set<net.Socket>;
  browsers: Browser[];
}

function baseConfig() {
  return normalizeConfig({ enabled: true, retainBundles: "never" });
}

interface ManagerHarnessOptions {
  launchArgs?: string[];
  limits?: Record<string, unknown>;
  config?: ReturnType<typeof normalizeConfig>;
  /** Hostname whose resolution is held until releaseDns() (shared gate). */
  dnsGate?: { host: string; addresses: string[] };
}

function createManagerHarness(options?: ManagerHarnessOptions): ManagerHarness & { releaseDns: () => void } {
  const dials: number[] = [];
  const sockets = new Set<net.Socket>();
  const browsers: Browser[] = [];
  let gate: Promise<void> | undefined;
  let gateRelease: (() => void) | undefined;
  const waitGate = () => (gate ??= new Promise<void>((resolve) => { gateRelease = resolve; }));
  const manager = new InteractiveBrowserManager((options?.config ?? baseConfig()).web!.fetch, {
    resolveHostname: async (hostname) => {
      if (options?.dnsGate && hostname === options.dnsGate.host) await waitGate();
      if (hostname === "chess.test" || hostname === "ws.test" || hostname === "wss.test") return [PUBLIC_ANSWER];
      if (hostname === "private.test") return ["127.0.0.1"];
      if (options?.dnsGate && hostname === options.dnsGate.host) return options.dnsGate.addresses;
      return [];
    },
    brokerDial: (_validated, destinationPort) => {
      dials.push(destinationPort);
      const socket = net.connect({ host: "127.0.0.1", port: destinationPort });
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      return socket;
    },
    launch: async (launchOptions) => {
      const browser = await chromium.launch({ ...launchOptions, args: [...(launchOptions?.args ?? []), ...(options?.launchArgs ?? [])] });
      browsers.push(browser);
      return browser;
    },
    ...(options?.limits ? { limits: options.limits } : {}),
  });
  return { manager, dials, sockets, browsers, releaseDns: () => { gateRelease?.(); } };
}

/** Test-only observation of the real page behind a manager session. */
function realPage(browsers: Browser[]): import("playwright").Page {
  const browser = browsers[browsers.length - 1]!;
  const context = browser.contexts()[0]!;
  return context.pages()[0]!;
}

test("chess-like page initializes real WebSocket state through the authenticated broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-chess-"));
  const { origin: wsOrigin, pushState } = createChessOrigin();
  const wsPort = await wsOrigin.listen();
  const httpOrigin = await createHttpOrigin(chessPageHtml(wsPort));
  const harness = createManagerHarness();
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    // The join dialog appears only on a verified live WebSocket open.
    await page.waitForSelector("#chooser:not([hidden])", { timeout: 20_000 });
    // Server state renders the full board through the same socket.
    await page.waitForFunction(() => document.querySelectorAll("#board .piece").length === 32, undefined, { timeout: 20_000 });
    assert.equal(await page.evaluate(() => (window as any).__wsState()), 1, "page WebSocket is OPEN after verified 101");

    // A move sent by the page travels through the manager to the origin.
    await page.evaluate(() => (window as any).__sendMove("e2", "e4"));
    await page.waitForFunction(() => document.querySelector('#board .piece[data-square="e4"]') !== null, undefined, { timeout: 20_000 });
    assert.equal(await page.locator('#board .piece[data-square="e2"]').count(), 0);
    pushState();

    const network = await harness.manager.network(opened.session, opened.tab);
    const wsEvents = network.events.filter((event) => event.resourceKind === "websocket");
    assert.ok(wsEvents.some((event) => event.wsState === "created" && event.outcome === "observed"), "created lifecycle record");
    for (const event of wsEvents) {
      assert.ok(event.wsState === "created" || event.wsState === "closed", "no connected state is ever claimed");
    }
    const created = wsEvents.find((event) => event.wsState === "created")!;
    assert.equal(created.origin, `ws://chess.test:${wsPort}`, "bounded origin without path or credentials");

    // Page-initiated close: the browser's own close event is the terminal
    // observation; app state (readyState) proves the round trip worked.
    await page.evaluate(() => (window as any).__closeWs(1000));
    await page.waitForFunction(() => (window as any).__wsState() === 3, undefined, { timeout: 20_000 });
    const settled = await harness.manager.network(opened.session, opened.tab);
    const closedEvent = settled.events.find((event) => event.resourceKind === "websocket" && event.wsState === "closed");
    assert.ok(closedEvent, "terminal close recorded from the browser's own close event");
    assert.equal(closedEvent?.closeCode, 1000, "close code as exposed by the browser stack");
    assert.equal(closedEvent?.outcome, "succeeded", "clean closure is not a failure");

    // The only way to the origin is the pinned broker dial.
    assert.ok(harness.dials.filter((port) => port === wsPort).length >= 1, "broker dialed the WS origin");
    for (const client of wsOrigin.clients) {
      assert.ok(!/proxy-authorization:/iu.test(client.upgradeHead), "broker credentials never reach the origin");
    }

    const closed = await harness.manager.close(opened.session);
    assert.equal(closed.closed, true);
    assert.ok(closed.broker && closed.broker.connections >= 2, "page and websocket connections accounted for");
    await eventually(async () => assert.equal(harness.sockets.size, 0), 15_000);
  } finally {
    await harness.manager.shutdown();
    wsOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ws and wss connect through the broker with end-to-end TLS and credential secrecy", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-secure-"));
  const keyPath = join(root, "key.pem");
  const certPath = join(root, "cert.pem");
  // Test-only local certificate and trust seam; production TLS validation is unchanged.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=wss.test", "-addext", "subjectAltName=DNS:wss.test"], { stdio: "ignore" });
  const plainOrigin = new WsOrigin((client, text) => client.sendText(`plain:${text}`));
  const secureOrigin = new WsOrigin((client, text) => client.sendText(`secure:${text}`), {
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  });
  const plainPort = await plainOrigin.listen();
  const securePort = await secureOrigin.listen();
  const probePage = `<!doctype html><title>Probe</title>
<script>
window.__wsResults = {};
function probe(name, url) {
  const ws = new WebSocket(url);
  ws.onopen = () => ws.send("marker-" + name);
  ws.onmessage = (event) => { window.__wsResults[name] = event.data; };
  ws.onerror = () => { window.__wsResults[name] = "error"; };
}
probe("plain", "ws://ws.test:${plainPort}/echo");
probe("secure", "wss://wss.test:${securePort}/echo");
</script>`;
  const httpOrigin = await createHttpOrigin(probePage);
  // Test-local trust seam for the self-signed local origin only (same pattern
  // as the broker's own wss test): it relaxes Chromium's local certificate
  // check, not proxy auth and not end-to-end TLS — the broker pipes opaque
  // bytes and the "upgrade inside TLS" assertion below proves it.
  const harness = createManagerHarness({ launchArgs: ["--ignore-certificate-errors"] });
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    await page.waitForFunction(
      () => (window as any).__wsResults.plain === "plain:marker-plain" && (window as any).__wsResults.secure === "secure:marker-secure",
      undefined,
      { timeout: 20_000 },
    );
    // Plain ws used the broker's authenticated upgrade path; wss used an
    // opaque CONNECT tunnel with end-to-end TLS (the origin saw the upgrade
    // inside TLS, which a broker MITM could not produce).
    assert.ok(harness.dials.includes(plainPort), "plain ws dialed through the broker");
    assert.ok(harness.dials.includes(securePort), "wss CONNECT dialed through the broker");
    for (const client of [...plainOrigin.clients, ...secureOrigin.clients]) {
      assert.ok(!/proxy-authorization:/iu.test(client.upgradeHead), "no proxy credentials at either origin");
    }
    const secureClient = secureOrigin.clients[0]!;
    assert.match(secureClient.upgradeHead, /^GET \/echo HTTP\/1\.1/u, "wss upgrade happened inside end-to-end TLS");

    const network = await harness.manager.network(opened.session, opened.tab);
    const created = network.events.filter((event) => event.resourceKind === "websocket" && event.wsState === "created");
    assert.equal(created.length, 2, "both websockets recorded created");
    for (const event of network.events) {
      if (event.resourceKind === "websocket") assert.notEqual(event.wsState as string, "connected", "no connected state is ever claimed");
    }
    const closed = await harness.manager.close(opened.session);
    assert.ok(closed.broker && closed.broker.connections >= 3);
    await eventually(async () => assert.equal(harness.sockets.size, 0), 15_000);
  } finally {
    await harness.manager.shutdown();
    plainOrigin.close();
    secureOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-host WebSocket targets connect through the broker after navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-crosshost-"));
  const echoOrigin = new WsOrigin((client, text) => client.sendText(`echo:${text}`));
  const echoPort = await echoOrigin.listen();
  const pageHtml = `<!doctype html><title>Cross</title>
<script>
window.__openCross = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => ws.send("ping");
  ws.onmessage = (event) => { resolve(event.data); };
  ws.onerror = () => reject(new Error("socket error"));
});
</script>`;
  const httpOrigin = await createHttpOrigin(pageHtml);
  const harness = createManagerHarness();
  try {
    // The page is served from chess.test; the socket targets a different host.
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    const result = await page.evaluate((port: number) => (window as any).__openCross(`ws://ws.test:${port}/cross`), echoPort);
    assert.equal(result, "echo:ping", "cross-host socket echoed through the broker");
    assert.ok(harness.dials.includes(echoPort), "broker dialed the cross-host origin");
    for (const client of echoOrigin.clients) {
      assert.ok(!/proxy-authorization:/iu.test(client.upgradeHead), "no proxy credentials at the cross-host origin");
    }
    const network = await harness.manager.network(opened.session, opened.tab);
    const created = network.events.find((event) => event.resourceKind === "websocket" && event.wsState === "created");
    assert.equal(created?.origin, `ws://ws.test:${echoPort}`, "diagnostic origin is the socket target, not the page host");
    await harness.manager.close(opened.session);
  } finally {
    await harness.manager.shutdown();
    echoOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("background-delayed WebSocket creation after idle still connects", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-delayed-"));
  const echoOrigin = new WsOrigin((client, text) => client.sendText(`echo:${text}`));
  const echoPort = await echoOrigin.listen();
  // The socket is created by page JS well after load, while the page sat idle.
  const pageHtml = `<!doctype html><title>Delayed</title>
<script>
window.__delayed = null;
setTimeout(() => {
  const ws = new WebSocket("ws://ws.test:${echoPort}/late");
  ws.onopen = () => ws.send("late");
  ws.onmessage = (event) => { window.__delayed = event.data; };
}, 600);
</script>`;
  const httpOrigin = await createHttpOrigin(pageHtml);
  const harness = createManagerHarness();
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    await page.waitForFunction(() => (window as any).__delayed === "echo:late", undefined, { timeout: 20_000 });
    assert.ok(harness.dials.includes(echoPort), "broker dialed the delayed socket origin");
    for (const client of echoOrigin.clients) {
      assert.ok(!/proxy-authorization:/iu.test(client.upgradeHead), "no proxy credentials at the delayed socket origin");
    }
    const network = await harness.manager.network(opened.session, opened.tab);
    const created = network.events.find((event) => event.resourceKind === "websocket" && event.wsState === "created");
    assert.equal(created?.origin, `ws://ws.test:${echoPort}`, "delayed socket recorded created");
    await harness.manager.close(opened.session);
  } finally {
    await harness.manager.shutdown();
    echoOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("teardown contains pending WebSocket admissions without late connects", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-admission-"));
  const echoOrigin = new WsOrigin((client, text) => client.sendText(`echo:${text}`));
  const wsPort = await echoOrigin.listen();
  const pageHtml = `<!doctype html><title>Admissions</title>
<script>
window.__results = {};
window.__opened = [];
window.__attempt = (name, url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  ws.onopen = () => window.__opened.push(name);
  let settled = false;
  const done = (code) => { if (!settled) { settled = true; window.__results[name] = code; resolve(code); } };
  ws.onclose = (event) => done(event.code);
});
</script>`;
  const httpOrigin = await createHttpOrigin(pageHtml);
  // slow.test's resolution is held until releaseDns(): every admitted socket
  // parks in its destination validation.
  const harness = createManagerHarness({ dnsGate: { host: "slow.test", addresses: [PUBLIC_ANSWER] } });
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    const dialsBefore = harness.dials.length;
    const connectionsBefore = echoOrigin.connections;

    // 12 concurrent admissions: the first 8 park in the held DNS validation,
    // the rest are refused before any resolution starts. Fire-and-forget:
    // the parked ones only settle at teardown, so they must not be awaited.
    await page.evaluate((port: number) => {
      for (let index = 0; index < 12; index += 1) {
        (window as any).__attempt(`a${index}`, `ws://slow.test:${port}/x`);
      }
    }, wsPort);
    // Exactly the excess was refused immediately with the manager-issued code.
    await page.waitForFunction(() => Object.keys((window as any).__results).length === 4, undefined, { timeout: 20_000 });
    const network = await harness.manager.network(opened.session, opened.tab);
    const blocked = network.events.filter((event) => event.resourceKind === "websocket" && event.outcome === "policy_blocked");
    assert.equal(blocked.length, 4, "excess admissions refused before DNS resolution");
    for (const event of blocked) {
      assert.equal(event.failure, "websocket admission limit exceeded");
      assert.equal(event.closeCode, 1008);
    }
    assert.equal(harness.dials.length, dialsBefore, "no dial while admissions are pending");
    assert.deepEqual(await page.evaluate(() => (window as any).__opened), [],
      "neither DNS-pending nor rejected sockets may report open before a native connection");

    // Closing the manager must settle the parked admissions without waiting
    // for the held resolution and without any late connect.
    const closed = await harness.manager.close(opened.session);
    assert.equal(closed.closed, true, "close settles pending admissions");
    assert.equal(harness.dials.length, dialsBefore, "no destination dial after close");

    // Release the held resolution: the continuations must observe teardown
    // and stop, never dialing or connecting late.
    harness.releaseDns();
    await delay(200);
    assert.equal(harness.dials.length, dialsBefore, "no late destination dial after release");
    assert.equal(echoOrigin.connections, connectionsBefore, "origin never contacted");
  } finally {
    harness.releaseDns();
    await harness.manager.shutdown();
    echoOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quiet live WebSocket survives shortened idle budget across turns and review", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-idle-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  const marker = join(root, "review-started");
  const reviewConfig = normalizeConfig({ enabled: true, retainBundles: "never", decider: {
    id: "fixture", adapter: "generic-cli", command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'fixture reviewed',findings:[]})),800))`],
    timeoutMs: 15_000,
  } });
  const { origin: wsOrigin, pieces, pushState } = createChessOrigin();
  const wsPort = await wsOrigin.listen();
  const httpOrigin = await createHttpOrigin(chessPageHtml(wsPort));
  // Deliberately short ordinary idle budget: a live transport must not be
  // evicted by it, while dead sockets still are.
  const harness = createManagerHarness({ limits: { idleSocketMs: 400 }, config: reviewConfig });
  try {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify(reviewConfig));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    const parent = host();
    await activate(parent.pi, { webTools: new WebToolManager(parent.pi, reviewConfig, undefined, undefined, harness.manager) });
    const ctx = { cwd: root, isIdle: () => true, notify: parent.pi.notify };
    await parent.emit("session_start", { reason: "startup" }, ctx);

    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    await page.waitForFunction(() => document.querySelectorAll("#board .piece").length === 32, undefined, { timeout: 20_000 });

    // Far past the 400ms ordinary idle window: the quiet live socket stays.
    await delay(1_500);
    assert.equal(await page.evaluate(() => (window as any).__wsState()), 1, "quiet live WS survives the idle budget");

    // A full turn + automatic review runs while the socket stays quiet.
    await writeFile(join(root, "work.ts"), "before\n");
    await parent.emit("before_agent_start", { prompt: "change fixture", systemPrompt: "fixture" }, ctx);
    await writeFile(join(root, "work.ts"), "after\n");
    await parent.emit("agent_end", { messages: [] }, ctx);
    const automatic = parent.emit("agent_settled", {}, ctx);
    await delay(200);
    assert.equal(await page.evaluate(() => (window as any).__wsState()), 1, "quiet live WS survives an active review");
    await automatic;

    // The same socket must carry FRESH state after the review: move a piece
    // server-side and wait for that distinct DOM update. Re-pushing identical
    // state would pass even if no post-idle message ever arrived.
    const pawn = pieces.find((entry) => entry.square === "a2")!;
    pawn.square = "a3";
    pushState();
    await page.waitForFunction(() => document.querySelector('#board .piece[data-square="a3"]') !== null, undefined, { timeout: 20_000 });

    const closed = await harness.manager.close(opened.session);
    assert.equal(closed.broker?.budgetAborts ?? 0, 0, "live transport was never idle-evicted");
    await eventually(async () => assert.equal(harness.sockets.size, 0), 15_000);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
    else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
    if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
    if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
    else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
    await harness.manager.shutdown();
    wsOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("private, mapped-IP, credential, and malformed WebSockets are refused without dials", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-refused-"));
  const { origin: wsOrigin } = createChessOrigin();
  const wsPort = await wsOrigin.listen();
  const attemptPage = `<!doctype html><title>Attempts</title>
<script>
window.__attempts = {};
window.__attempt = (name, url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  let settled = false;
  const done = (code) => { if (!settled) { settled = true; window.__attempts[name] = code; resolve(code); } };
  ws.onclose = (event) => done(event.code);
});
</script>`;
  const httpOrigin = await createHttpOrigin(attemptPage);
  const harness = createManagerHarness();
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    const dialsBefore = harness.dials.length;
    const connectionsBefore = wsOrigin.connections;

    const [mapped, credentials, overlong, unresolved] = await page.evaluate(async (port: number) => {
      return Promise.all([
        (window as any).__attempt("mapped", `ws://private.test:${port}/x`),
        (window as any).__attempt("credentials", `ws://user:pass@chess.test:${port}/x`),
        (window as any).__attempt("overlong", `ws://chess.test:${port}/` + "a".repeat(3_000)),
        (window as any).__attempt("unresolved", `ws://unresolved.test:${port}/x`),
      ]);
    }, wsPort);

    // Every attempt is refused before any destination dial.
    assert.equal(harness.dials.length, dialsBefore, "no broker dials for refused WebSockets");
    assert.equal(wsOrigin.connections, connectionsBefore, "origin never contacted");
    // Policy violations close the page side with 1008; none ever connected.
    assert.equal(mapped, 1008);
    assert.equal(credentials, 1008);
    assert.equal(overlong, 1008);
    assert.equal(unresolved, 1008);

    const network = await harness.manager.network(opened.session, opened.tab);
    const wsEvents = network.events.filter((event) => event.resourceKind === "websocket");
    const created = wsEvents.filter((event) => event.phase === "request" && event.wsState === "created");
    const blocked = wsEvents.filter((event) => event.outcome === "policy_blocked");
    assert.equal(created.length, 4, "one observed record per refused attempt");
    assert.equal(blocked.length, 4, "one bounded policy record per refused attempt");
    for (const event of blocked) {
      assert.notEqual(event.wsState, "connected", "refused sockets are never recorded connected");
      assert.equal(event.closeCode, 1008);
    }
    const failures = blocked.map((event) => event.failure);
    assert.ok(failures.filter((failure) => failure === "websocket destination failed public validation").length === 2, "mapped-IP and unresolved both fail public validation");
    assert.ok(failures.includes("websocket credentials not allowed"));
    assert.ok(failures.includes("websocket URL exceeds bound"));
    await harness.manager.close(opened.session);
  } finally {
    await harness.manager.shutdown();
    wsOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("origin error and close drain live WebSockets without leaking sockets", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-drain-"));
  const { origin: wsOrigin } = createChessOrigin();
  const wsPort = await wsOrigin.listen();
  const httpOrigin = await createHttpOrigin(chessPageHtml(wsPort));
  const harness = createManagerHarness();
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    await page.waitForFunction(() => document.querySelectorAll("#board .piece").length === 32, undefined, { timeout: 20_000 });

    // The origin dies hard (no close frame): the page must see an abnormal
    // close and the manager must drain the transport.
    const liveClient = wsOrigin.clients[0]!;
    liveClient.destroy();
    await page.waitForFunction(() => (window as any).__wsState() === 3, undefined, { timeout: 20_000 });

    let network = await harness.manager.network(opened.session, opened.tab);
    const abnormal = network.events.find((event) => event.resourceKind === "websocket" && event.wsState === "closed" && event.outcome === "failed");
    assert.ok(abnormal, "abnormal close recorded");
    assert.equal(abnormal?.closeCode, 1006);

    // The session remains fully usable: a reload reconnects through the broker.
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#board .piece").length === 32, undefined, { timeout: 20_000 });
    network = await harness.manager.network(opened.session, opened.tab);
    const created = network.events.filter((event) => event.resourceKind === "websocket" && event.wsState === "created");
    assert.equal(created.length, 2, "reconnect recorded after drain");

    const closed = await harness.manager.close(opened.session);
    assert.equal(closed.closed, true);
    assert.ok(closed.broker && closed.broker.connections >= 3);
    await eventually(async () => assert.equal(harness.sockets.size, 0), 15_000);
    await eventually(async () => assert.equal(wsOrigin.clients.length, 0), 15_000);
  } finally {
    await harness.manager.shutdown();
    wsOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manager shutdown drains every live WebSocket and broker socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-shutdown-"));
  const { origin: wsOrigin } = createChessOrigin();
  const wsPort = await wsOrigin.listen();
  const httpOrigin = await createHttpOrigin(chessPageHtml(wsPort));
  const harness = createManagerHarness();
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    await page.waitForFunction(() => document.querySelectorAll("#board .piece").length === 32, undefined, { timeout: 20_000 });

    await harness.manager.shutdown();
    assert.equal(harness.browsers.every((browser) => !browser.isConnected()), true, "browser process gone");
    await eventually(async () => assert.equal(harness.sockets.size, 0), 15_000);
    await eventually(async () => assert.equal(wsOrigin.clients.length, 0), 15_000);
    void opened;
  } finally {
    wsOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("frame payload markers never appear in diagnostics or tool text", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-secrecy-"));
  const marker = `SECRET-MARKER-${Date.now().toString(36)}`;
  const { origin: wsOrigin, pushState } = createChessOrigin();
  const wsPort = await wsOrigin.listen();
  const httpOrigin = await createHttpOrigin(chessPageHtml(wsPort));
  const harness = createManagerHarness();
  try {
    const parent = host();
    await activate(parent.pi, { webTools: new WebToolManager(parent.pi, baseConfig(), undefined, undefined, harness.manager) });
    const ctx = { cwd: root, isIdle: () => true, notify: parent.pi.notify };
    await parent.emit("session_start", { reason: "startup" }, ctx);

    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    await page.waitForFunction(() => document.querySelectorAll("#board .piece").length === 32, undefined, { timeout: 20_000 });

    // Server -> page frame the page ignores; page -> server frame it sends.
    const liveClient = wsOrigin.clients[0]!;
    liveClient.sendText(JSON.stringify({ type: "noise", payload: marker }));
    await page.evaluate((value: string) => (window as any).__sendMove(value, value), marker);
    await delay(300);
    assert.ok(wsOrigin.receivedText.some((text) => text.includes(marker)), "origin received the page frame");

    const network = await harness.manager.network(opened.session, opened.tab);
    const consoleEvents = await harness.manager.console(opened.session, opened.tab);
    const tool = parent.tools.get("BrowserNetwork") as { execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> };
    const toolResult = await tool.execute("fixture", { session: opened.session, tab: opened.tab });
    const evidence = JSON.stringify({ network, consoleEvents, toolResult });
    assert.ok(!evidence.includes(marker), "frame content never reaches diagnostics or tool text");

    const closed = await harness.manager.close(opened.session);
    assert.ok(!JSON.stringify(closed).includes(marker), "close result carries no frame content");
  } finally {
    await harness.manager.shutdown();
    wsOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate open with a live WebSocket preserves recovery guidance and the socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-websocket-duplicate-"));
  const { origin: wsOrigin, pieces, pushState } = createChessOrigin();
  const wsPort = await wsOrigin.listen();
  const httpOrigin = await createHttpOrigin(chessPageHtml(wsPort));
  const harness = createManagerHarness();
  try {
    const opened = await harness.manager.open(`http://chess.test:${httpOrigin.port}/`);
    const page = realPage(harness.browsers);
    await page.waitForFunction(() => document.querySelectorAll("#board .piece").length === 32, undefined, { timeout: 20_000 });

    await assert.rejects(
      harness.manager.open(`http://chess.test:${httpOrigin.port}/again`),
      (error: unknown) => {
        assert.ok(error instanceof Error && error.name === "BrowserRecoveryError", "recovery error type");
        const recovery = (error as { recovery?: { kind?: string; existingSession?: string; existingTab?: string } }).recovery;
        assert.equal(recovery?.kind, "duplicate_open");
        assert.equal(recovery?.existingSession, opened.session);
        assert.equal(recovery?.existingTab, opened.tab);
        return true;
      },
    );

    // The live WebSocket survived the refused duplicate open: a fresh state
    // change pushed server-side must reach the page (identical-state re-push
    // would pass even if the socket were dead).
    const pawn = pieces.find((entry) => entry.square === "h2")!;
    pawn.square = "h3";
    pushState();
    await page.waitForFunction(() => document.querySelector('#board .piece[data-square="h3"]') !== null, undefined, { timeout: 20_000 });
    assert.equal(await page.evaluate(() => (window as any).__wsState()), 1);

    const closed = await harness.manager.close(opened.session);
    assert.equal(closed.closed, true);
    await eventually(async () => assert.equal(harness.sockets.size, 0), 15_000);
  } finally {
    await harness.manager.shutdown();
    wsOrigin.close();
    httpOrigin.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
