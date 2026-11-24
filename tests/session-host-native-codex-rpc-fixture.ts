/**
 * Fake native Codex app-server for the owned-endpoint RPC observer tests.
 *
 * This is a REAL RFC6455 WebSocket server speaking the provider's JSON-RPC
 * envelope, mounted either on a Unix socket (the shipped transport: `GET /rpc`
 * over `unix://`, exactly as the provider's own app-server serves it) or on a
 * loopback TCP port (the `ws://127.0.0.1:<port>/rpc` form). The production
 * client connects to it with the same pinned `ws` dependency, so the tests
 * exercise the actual handshake, framing, fragmentation, and correlation path —
 * not a mock of it.
 *
 * It is deliberately narrow: the four metadata reads the observer is allowed to
 * make, the broadcast notifications it is allowed to receive, and a scripted
 * server-request emitter used to prove the observer never answers. Anything else
 * is refused, which is also how the tests prove the observer never asks.
 *
 * Every thread row carries distinctive marker values in the fields the observer
 * must drop (cwd, preview, name, model, command). The tests scan everything the
 * observer publishes for those markers.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

/** Marker text planted in every droppable field of every row. */
export const FAKE_MARKER = "SECRET-MARKER-9f3a";

export type FakeThreadStatus =
  | { readonly type: "idle" }
  | { readonly type: "active"; readonly activeFlags?: readonly string[] }
  | { readonly type: "systemError" }
  | { readonly type: "notLoaded" };

export interface FakeThread {
  readonly id: string;
  readonly parentThreadId: string | null;
  /** Status while loaded; a thread absent from `loadedIds` reports `notLoaded`. */
  readonly status: FakeThreadStatus;
  readonly cwd?: string;
  readonly preview?: string;
  readonly name?: string | null;
  readonly model?: string | null;
  readonly forkedFromId?: string | null;
  readonly ephemeral?: boolean;
  readonly sourceKind?: string;
}

export interface FakeBackgroundTerminal {
  readonly processId: string;
  readonly itemId?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly osPid?: number;
}

export interface FakeCodexServerOptions {
  readonly threads?: readonly FakeThread[];
  /** Ids currently loaded in the fake backend. Defaults to every thread. */
  readonly loadedIds?: readonly string[];
  readonly backgroundTerminals?: Readonly<Record<string, readonly FakeBackgroundTerminal[]>>;
  /** When set, the upgrade is refused with 401 unless this bearer token is presented. */
  readonly requireAuthorization?: string;
  /** Server-side page cap, so pagination is exercised regardless of the requested limit. */
  readonly pageSize?: number;
  /** Number of leading calls per method answered with a JSON-RPC error. */
  readonly failCalls?: Readonly<Partial<Record<string, number>>>;
  /** Real-response delay per method, to hold a census mid-walk. */
  readonly delayMs?: Readonly<Partial<Record<string, number>>>;
  /**
   * Methods the fake accepts and then NEVER answers: an upgraded peer that goes
   * silent, which is what bounding the handshake is for.
   */
  readonly ignoreMethods?: readonly string[];
  /** `codexHome` reported by `initialize`. */
  readonly codexHome?: string;
  /**
   * Exact result payload to answer one method with, bypassing normal handling.
   * Used to plant provider responses the fake would never produce on its own,
   * such as a page whose `nextCursor` is not a usable cursor.
   */
  readonly rawResults?: Readonly<Partial<Record<string, unknown>>>;
  /**
   * Ids whose `thread/read` answer is deliberately UNREADABLE metadata (an
   * unknown status discriminant). The client cannot decode a row at all, which
   * must degrade the census rather than mark the thread unrelated.
   */
  readonly unreadableThreadIds?: readonly string[];
  /**
   * Ids whose `thread/read` answer decodes but names a DIFFERENT thread, so the
   * client must reject the identity instead of adopting or dismissing it.
   */
  readonly mismatchedThreadIds?: readonly string[];
  /**
   * When set, the persisted `thread/list` answers only with these ids. Lets a
   * test hide an intermediate ancestor from the listing so proving a chain has to
   * read it, which is the ancestry-resolution path.
   */
  readonly persistedListing?: readonly string[];
}

/** What a per-request hook may do instead of the normal answer. */
export type FakeRequestOverride = "fail" | "ignore" | { readonly raw: unknown };

export interface RecordedRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

let socketSequence = 0;

/** One fake backend. Start it, drive the client, inspect what it saw. */
export class FakeCodexAppServer {
  readonly #options: FakeCodexServerOptions;
  readonly #threads: FakeThread[];
  readonly #loaded: Set<string>;
  readonly #terminals: Map<string, FakeBackgroundTerminal[]>;
  readonly #failures = new Map<string, number>();
  readonly #clients = new Set<WebSocket>();

  #server: http.Server | null = null;
  #socketPath: string | null = null;
  #port: number | null = null;
  #upgradeCount = 0;
  #rejectedUpgrades = 0;
  #handshake: { url: string; host: string; headers: NodeJS.Dict<string> } | null = null;

  /** Every frame received, in order, as text. The no-reply invariant reads this. */
  readonly rawInboundFrames: string[] = [];
  /** Every decoded request received, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Live-mutable for tests: ids answered with undecodable metadata. */
  readonly unreadable = new Set<string>();
  /** Live-mutable for tests: ids answered with another thread's identity. */
  readonly mismatched = new Set<string>();
  /** Decoded `initialize` params, when a client sent one. */
  initializeParams: Record<string, unknown> | null = null;
  /** True once a client sent the `initialized` notification. */
  initializedSeen = false;
  /** Server requests this fake emitted. */
  readonly serverRequestsSent: { method: string; id: string }[] = [];
  /**
   * Live-settable per-request hook, run after a request is recorded and before
   * it is answered. It may mutate the population (a thread leaving the backend
   * between a listing and a per-thread request), return `"fail"` to answer this
   * one request with a JSON-RPC error, `"ignore"` to never answer it, or
   * `{ raw }` to answer it with exactly that (possibly undecodable) result.
   */
  onRequest: ((method: string, params: Record<string, unknown>) => FakeRequestOverride | void) | null = null;

  constructor(options: FakeCodexServerOptions = {}) {
    this.#options = options;
    for (const id of options.unreadableThreadIds ?? []) this.unreadable.add(id);
    for (const id of options.mismatchedThreadIds ?? []) this.mismatched.add(id);
    this.#threads = [...(options.threads ?? [])];
    this.#loaded = new Set(options.loadedIds ?? this.#threads.map((thread) => thread.id));
    this.#terminals = new Map();
    for (const [threadId, rows] of Object.entries(options.backgroundTerminals ?? {})) {
      this.#terminals.set(threadId, [...rows]);
    }
    for (const [method, times] of Object.entries(options.failCalls ?? {})) {
      if (typeof times === "number") this.#failures.set(method, times);
    }
  }

  get unixSocketPath(): string {
    if (this.#socketPath === null) throw new Error("fake server is not listening on a socket");
    return this.#socketPath;
  }

  get tcpPort(): number {
    if (this.#port === null) throw new Error("fake server is not listening on a port");
    return this.#port;
  }

  get upgradeCount(): number {
    return this.#upgradeCount;
  }

  get rejectedUpgradeCount(): number {
    return this.#rejectedUpgrades;
  }

  get handshakeInfo(): { url: string; host: string; headers: NodeJS.Dict<string> } | null {
    return this.#handshake;
  }

  get connectionCount(): number {
    return this.#clients.size;
  }

  /** Start on a Unix socket under the system temp directory. */
  async listenUnix(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prg-fake-codex-"));
    // Keep the resolved path well under the AF_UNIX limit the provider enforces.
    this.#socketPath = path.join(dir, `s${process.pid}-${socketSequence += 1}.sock`);
    await this.#listen(this.#socketPath);
    return this.#socketPath;
  }

  /** Start on a loopback TCP port. */
  async listenLoopback(): Promise<number> {
    await this.#listen(0);
    if (this.#port === null) throw new Error("fake server did not report a port");
    return this.#port;
  }

  async stop(): Promise<void> {
    for (const client of this.#clients) {
      try {
        client.terminate();
      } catch {
        // Already gone.
      }
    }
    this.#clients.clear();
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.removeAllListeners();
    }
    if (this.#socketPath !== null) {
      try {
        fs.rmSync(path.dirname(this.#socketPath), { recursive: true, force: true });
      } catch {
        // Temp cleanup is best effort.
      }
      this.#socketPath = null;
    }
  }

  /** Replace a thread row (or add one). */
  setThread(thread: FakeThread): void {
    const index = this.#threads.findIndex((row) => row.id === thread.id);
    if (index === -1) this.#threads.push(thread);
    else this.#threads[index] = thread;
  }

  /** Change one loaded thread's live status. */
  setStatus(threadId: string, status: FakeThreadStatus): void {
    this.setThread({ ...this.#threadOrThrow(threadId), status });
  }

  /** Remove a thread entirely: no longer loaded, listed, or readable (an ephemeral that ended). */
  removeThread(threadId: string): void {
    const index = this.#threads.findIndex((row) => row.id === threadId);
    if (index !== -1) this.#threads.splice(index, 1);
    this.#loaded.delete(threadId);
    this.#terminals.delete(threadId);
  }

  setLoaded(threadId: string, loaded: boolean): void {
    if (loaded) this.#loaded.add(threadId);
    else this.#loaded.delete(threadId);
  }

  /** Replace one thread's background terminals (the census reads them fresh). */
  setBackgroundTerminals(threadId: string, rows: readonly FakeBackgroundTerminal[]): void {
    this.#terminals.set(threadId, [...rows]);
  }

  /** Fail the next `times` calls to one method. */
  failMethod(method: string, times: number): void {
    this.#failures.set(method, times);
  }

  /** Broadcast one notification to every connected client. */
  broadcast(method: string, params: unknown): void {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const client of this.#clients) client.send(frame);
  }

  /** Send arbitrary bytes to every client: malformed frames, garbage, truncation. */
  sendRaw(text: string): void {
    for (const client of this.#clients) client.send(text);
  }

  /** Drop every client connection without shutting the listener down. */
  dropClientConnections(): void {
    for (const client of this.#clients) {
      try {
        client.terminate();
      } catch {
        // Already gone.
      }
    }
    this.#clients.clear();
  }

  /**
   * Emit a server REQUEST (an approval, question, permission, elicitation, or
   * auth prompt) with a payload full of marker text. A correct observer answers
   * nothing; the tests read `rawInboundFrames` to prove it.
   */
  sendServerRequest(method: string, params: Record<string, unknown>, id = `srv-${this.serverRequestsSent.length + 1}`): string {
    const seeded = {
      threadId: "thread-1",
      reason: `${FAKE_MARKER} reason`,
      command: `${FAKE_MARKER} command`,
      prompt: `${FAKE_MARKER} prompt`,
      fileChanges: `${FAKE_MARKER} diff`,
      cwd: `${FAKE_MARKER}/cwd`,
      ...params,
    };
    for (const client of this.#clients) {
      client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: seeded }));
    }
    this.serverRequestsSent.push({ method, id });
    return id;
  }

  /** Frames received after a given index (so a test can look at one window). */
  inboundFramesSince(index: number): string[] {
    return this.rawInboundFrames.slice(index);
  }

  /** True when any received frame carries one of the ids the server asked about. */
  repliedTo(ids: readonly string[]): boolean {
    return this.rawInboundFrames.some((frame) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame);
      } catch {
        return false;
      }
      if (typeof parsed !== "object" || parsed === null) return false;
      const record = parsed as Record<string, unknown>;
      return typeof record.method === "undefined" && ids.includes(String(record.id));
    });
  }

  /* ------------------------------------------------------------ internals */

  #threadOrThrow(threadId: string): FakeThread {
    const found = this.#threads.find((row) => row.id === threadId);
    if (found === undefined) throw new Error(`unknown fake thread ${threadId}`);
    return found;
  }

  #effectiveStatus(thread: FakeThread): FakeThreadStatus {
    // The provider derives status from its live watch manager: a persisted
    // thread that is not loaded reports `notLoaded` whatever was persisted.
    return this.#loaded.has(thread.id) ? thread.status : { type: "notLoaded" };
  }

  #wireThread(thread: FakeThread): Record<string, unknown> {
    const marker = `${FAKE_MARKER}`;
    return {
      id: thread.id,
      sessionId: thread.parentThreadId === null ? thread.id : `${thread.parentThreadId}-session`,
      forkedFromId: thread.forkedFromId ?? null,
      parentThreadId: thread.parentThreadId,
      preview: thread.preview ?? `${marker} preview`,
      ephemeral: thread.ephemeral ?? false,
      model: thread.model ?? null,
      modelProvider: `${marker}-provider`,
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: this.#effectiveStatus(thread),
      path: `${marker}/rollout-${thread.id}.jsonl`,
      cwd: thread.cwd ?? `${marker}/cwd`,
      cliVersion: "0.169.0",
      originator: `${marker}-originator`,
      source: { type: thread.sourceKind ?? "cli" },
      threadSource: null,
      agentNickname: `${marker}-nickname`,
      agentRole: null,
      gitInfo: null,
      // A thread with NO user-facing title is ordinary (a fresh thread reports its
      // `name` present with a null value), so an explicit null in a fixture stays
      // null instead of silently becoming the marker-bearing default.
      name: thread.name === undefined ? `${marker} title` : thread.name,
      turns: [],
    };
  }

  async #listen(bind: string | number): Promise<void> {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      this.#upgradeCount += 1;
      const expected = this.#options.requireAuthorization;
      if (expected !== undefined && req.headers.authorization !== `Bearer ${expected}`) {
        this.#rejectedUpgrades += 1;
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.#handshake = {
        url: req.url ?? "",
        host: String(req.headers.host ?? ""),
        headers: req.headers as NodeJS.Dict<string>,
      };
      wss.handleUpgrade(req, socket as net.Socket, head, (client) => {
        this.#clients.add(client);
        client.on("close", () => this.#clients.delete(client));
        client.on("message", (data) => this.#handleFrame(client, data.toString()));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bind as never, () => {
        const address = server.address();
        if (typeof address === "object" && address !== null) this.#port = address.port;
        resolve();
      });
    });
    this.#server = server;
  }

  #handleFrame(client: WebSocket, text: string): void {
    this.rawInboundFrames.push(text);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const record = frame as Record<string, unknown>;
    const method = typeof record.method === "string" ? record.method : null;
    const id = record.id;

    // A notification carries no id; `initialized` must still be observed.
    if (method === "initialized" && id === undefined) {
      this.initializedSeen = true;
      return;
    }
    if (method === null || id === undefined) return;
    const params = typeof record.params === "object" && record.params !== null
      ? record.params as Record<string, unknown>
      : {};

    this.requests.push({ method, params });

    const raw = this.#options.rawResults?.[method];
    if (raw !== undefined) {
      this.#send(client, id, raw);
      return;
    }

    const hooked = this.onRequest?.(method, params);
    const fail = this.#failures.get(method) ?? 0;
    if (hooked === "fail") {
      this.#send(client, id, null, { code: -32603, message: `${FAKE_MARKER} refused at ${FAKE_MARKER}/path` });
      return;
    }
    if (hooked === "ignore") return;
    if (typeof hooked === "object" && hooked !== null) {
      this.#send(client, id, hooked.raw);
      return;
    }
    if (fail > 0) {
      this.#failures.set(method, fail - 1);
      this.#send(client, id, null, {
        code: -32603,
        message: `${FAKE_MARKER} internal failure at ${FAKE_MARKER}/path/token`,
      });
      return;
    }

    const respond = (): void => {
      switch (method) {
        case "initialize": {
          this.initializeParams = params;
          this.#send(client, id, {
            userAgent: "codex-tui/0.169.0 (macOS 15.0; arm64)",
            codexHome: this.#options.codexHome ?? "/owned/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
          });
          return;
        }
        case "thread/read": {
          const threadId = String(params.threadId ?? "");
          const thread = this.#threads.find((row) => row.id === threadId);
          if (thread === undefined) {
            this.#send(client, id, null, { code: -32600, message: "no such thread" });
            return;
          }
          if (this.unreadable.has(threadId)) {
            // Metadata the client cannot decode: a status discriminant it has
            // never heard of, wrapped in the usual private fields.
            this.#send(client, id, {
              thread: { ...this.#wireThread(thread), status: { type: "unheardOf" }, preview: FAKE_MARKER },
            });
            return;
          }
          if (this.mismatched.has(threadId)) {
            // Decodable, but it describes a different thread: the client must
            // reject the identity rather than adopt or dismiss it.
            this.#send(client, id, { thread: { ...this.#wireThread(thread), id: `${threadId}-other` } });
            return;
          }
          this.#send(client, id, { thread: this.#wireThread(thread) });
          return;
        }
        case "thread/loaded/list": {
          const ids = [...this.#loaded].filter((threadId) => this.#threads.some((row) => row.id === threadId));
          const page = paginate(ids, params, this.#options.pageSize);
          this.#send(client, id, { data: page.data, nextCursor: page.nextCursor });
          return;
        }
        case "thread/list": {
          const rows = this.#listDescendants(params);
          const page = paginate(rows, params, this.#options.pageSize);
          this.#send(client, id, {
            data: page.data.map((row) => this.#wireThread(row)),
            nextCursor: page.nextCursor,
          });
          return;
        }
        case "thread/backgroundTerminals/list": {
          const threadId = String(params.threadId ?? "");
          // Like the provider's own handler, background terminals resolve against
          // the backend's IN-MEMORY threads and reject an unloaded id rather than
          // answering with an empty page. A client that asks for a historical
          // thread therefore fails its own shell census, exactly as the real
          // backend fails such a client.
          if (!this.#loaded.has(threadId)) {
            this.#send(client, id, null, { code: -32600, message: "no such thread handle" });
            return;
          }
          const rows = this.#terminals.get(threadId) ?? [];
          const page = paginate(rows, params, this.#options.pageSize);
          this.#send(client, id, { data: page.data, nextCursor: page.nextCursor });
          return;
        }
        default: {
          // Any control or mutation call is refused, so a test that sees one in
          // `requests` fails loudly instead of being silently satisfied.
          this.#send(client, id, null, { code: -32601, message: `unsupported method ${method}` });
        }
      }
    };

    const delay = this.#options.delayMs?.[method];
    if (delay !== undefined && delay > 0) {
      setTimeout(respond, delay);
      return;
    }
    if (this.#options.ignoreMethods?.includes(method) === true) return;
    respond();
  }

  /** The provider's `ancestorThreadId` semantics: descendants at any depth. */
  #listDescendants(params: Record<string, unknown>): FakeThread[] {
    const ancestor = typeof params.ancestorThreadId === "string" ? params.ancestorThreadId : null;
    const sourceKinds = Array.isArray(params.sourceKinds)
      ? params.sourceKinds.filter((kind): kind is string => typeof kind === "string")
      : null;
    return this.#threads.filter((thread) => {
      if (this.#options.persistedListing !== undefined
        && !this.#options.persistedListing.includes(thread.id)) {
        return false;
      }
      if (ancestor === null) return true;
      if (thread.id === ancestor) return false;
      if (!descendsFrom(thread, this.#threads, ancestor)) return false;
      if (sourceKinds !== null && sourceKinds.length > 0
        && !sourceKinds.includes(thread.sourceKind ?? "cli")) {
        return false;
      }
      return true;
    });
  }

  #send(client: WebSocket, id: unknown, result: unknown, error?: unknown): void {
    const frame: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error === undefined) frame.result = result;
    else frame.error = error;
    client.send(JSON.stringify(frame));
  }
}

function descendsFrom(thread: FakeThread, all: readonly FakeThread[], ancestor: string): boolean {
  const visited = new Set<string>([thread.id]);
  let current = thread.parentThreadId;
  while (current !== null && current !== undefined) {
    if (current === ancestor) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = all.find((row) => row.id === current)?.parentThreadId ?? null;
  }
  return false;
}

function paginate<T>(rows: readonly T[], params: Record<string, unknown>, forcedSize?: number): Page<T> {
  const requested = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : rows.length;
  const size = forcedSize === undefined || forcedSize <= 0 ? requested : Math.min(forcedSize, requested);
  const offset = typeof params.cursor === "string" && /^p(\d+)$/.test(params.cursor)
    ? Number.parseInt(params.cursor.slice(1), 10) * size
    : 0;
  const data = rows.slice(offset, offset + size);
  const nextOffset = offset + size;
  return {
    data,
    nextCursor: nextOffset < rows.length ? `p${Math.floor(nextOffset / size)}` : null,
  };
}

/** Wire-shaped status helpers, so tests read like the provider's own vocabulary. */
export function activeStatus(flags: readonly string[] = []): FakeThreadStatus {
  return { type: "active", activeFlags: flags };
}

export const idleStatus: FakeThreadStatus = { type: "idle" };
export const systemErrorStatus: FakeThreadStatus = { type: "systemError" };
export const notLoadedStatus: FakeThreadStatus = { type: "notLoaded" };
