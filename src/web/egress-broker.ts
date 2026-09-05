/**
 * Per-render loopback egress broker owned by BrowserExtract (finding 16).
 *
 * The broker is a small HTTP/1.1 forward proxy that binds to 127.0.0.1 on an
 * ephemeral port and is the ONLY network path Chromium is given:
 *
 * - Chromium is launched with `--proxy-server` pointing at this broker,
 *   `--proxy-bypass-list=<-loopback>` (which removes Chromium's implicit
 *   loopback bypass so even loopback/private literal requests reach the broker
 *   and are refused here), `--disable-quic` (no QUIC/Alt-Svc direct
 *   transports), and a default-deny host resolver (`MAP * ~NOTFOUND`) so no
 *   non-proxied socket can ever resolve a hostname.
 * - Plain HTTP proxy requests must arrive in absolute form with the `http:`
 *   scheme; CONNECT tunnels carry the `host:port` authority. Both are
 *   canonicalized, capped in length, resolved exactly once through the caller
 *   supplied resolver, and every resolved address must be public before a
 *   single socket is dialed. There is no fallback to system DNS: the dial only
 *   uses the validated address set produced immediately above.
 * - Original hostname semantics are preserved end to end: the browser keeps
 *   the original `Host` header for plain HTTP, and HTTPS CONNECT tunnels are
 *   opaque byte pipes, so TLS SNI and certificate verification remain
 *   hostname-based at Chromium and the tunnel is never decrypted here.
 * - Every successful outbound dial is recorded in a connection ledger (the
 *   replacement for Playwright `Response.serverAddr()` verification, which
 *   only sees the local proxy). Each ledger entry names the validated hostname
 *   and the validated public address that was dialed.
 * - Budgets are explicit and fail closed: distinct hostnames, connections,
 *   per-connection and aggregate bytes, authority/header lengths, diagnostics,
 *   idle socket time, and the render's own total time bound the broker. Budget
 *   exhaustion destroys the affected connections, records bounded omissions,
 *   and refuses new ones; the render decides fatality (main-document failures
 *   are fatal, subresource omissions stay nonfatal).
 *
 * Browser-owned live WebSocket transport is OPT IN ONLY
 * (EgressBrokerWebSocketPolicy, default OFF). With the policy absent every
 * WebSocket upgrade is refused before any dial, exactly as the default passive
 * extraction behavior always did. When the owning interactive session
 * explicitly opts in:
 * - Plain `ws://` upgrades arrive as authenticated absolute-form HTTP Upgrade
 *   requests; the broker re-issues the upgrade to the validated public
 *   destination, strips its own proxy credentials (they never reach the
 *   origin), and on a 101 becomes a byte-accounted bidirectional pipe.
 * - `wss://` travels as an ordinary CONNECT tunnel: the WebSocket handshake
 *   and frames are INSIDE the browser's end-to-end TLS, so the broker never
 *   sees the upgrade or the frames and cannot — and does not need to — inspect
 *   them. Exemption from ordinary idle eviction for such tunnels is granted
 *   only by the same explicit opt-in; the tunnel stays fully subject to the
 *   hard byte/connection budgets and to deterministic broker teardown. The
 *   opt-in therefore controls the live transport without any TLS MITM.
 * Opted-in live connections are never evicted for ordinary elapsed lifetime
 * (no such expiry exists); quiet sockets are evicted by the ordinary idle
 * bound unless the owner explicitly disables that for live transports, and
 * owner closes plus hard budget failures still drain every socket.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { validatePublicUrl, type HostResolver, type ValidatedUrl } from "./network";

export interface EgressBudgets {
  /** Distinct destination hostnames admitted per render. */
  maxDistinctHosts: number;
  /** Outbound connections (dialed sockets) per render. */
  maxConnections: number;
  /**
   * Concurrent broker-facing client sockets (loopback peers), separate from
   * outbound dial accounting: a local process flooding unauthenticated
   * connections cannot exceed this before any HTTP request arrives.
   */
  maxClientConnections: number;
  /** Idle deadline that destroys a client socket before it authenticates. */
  preAuthSocketMs: number;
  /**
   * Total broker requests admitted per render, INCLUDING pre-dial refusals, so
   * adversarial request floods are bounded regardless of the dial budget.
   */
  maxRequests: number;
  /** Wall-clock time from broker start after which new requests are refused. */
  /** null only for a live interactive Pi session; renders retain a deadline. */
  maxTotalMs: number | null;
  /** Fail-closed deadline for broker teardown (socket/listener shutdown). */
  maxCleanupMs: number;
  /** Bytes per single connection (both directions combined). */
  maxConnectionBytes: number;
  /** Aggregate bytes across all connections per render. */
  maxTotalBytes: number;
  /** Maximum CONNECT-authority / proxy-URL length in characters. */
  maxAuthorityChars: number;
  /** Maximum forwarded request header block size in characters. */
  maxHeaderChars: number;
  /** Maximum retained omission diagnostics; the excess is only counted. */
  maxDiagnostics: number;
  /** Idle time (no bytes) after which a connection is destroyed. */
  idleSocketMs: number;
}

export const DEFAULT_EGRESS_BUDGETS: EgressBudgets = {
  maxDistinctHosts: 16,
  maxConnections: 96,
  maxClientConnections: 64,
  preAuthSocketMs: 5_000,
  maxRequests: 256,
  maxConnectionBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxAuthorityChars: 2_048,
  maxHeaderChars: 32_768,
  maxDiagnostics: 32,
  idleSocketMs: 20_000,
  maxTotalMs: 60_000,
  maxCleanupMs: 5_000,
};

/** One auditable outbound connection the broker actually dialed. */
export interface BrokerLedgerEntry {
  hostname: string;
  port: number;
  /** The validated public address chosen for this dial. */
  address: string;
  /** "ws" is an opted-in plain WebSocket upgrade; wss rides inside "connect". */
  kind: "http" | "connect" | "ws";
  bytesSent: number;
  bytesReceived: number;
  /** False when the connection was destroyed at a budget (never completed). */
  completed: boolean;
}

/**
 * Explicit opt-in for browser-owned live WebSocket transport. Absent (or
 * `enabled: false`), every WebSocket upgrade and every upgrade-bearing request
 * is refused before any dial and the default passive/HTTP behavior is exactly
 * as before. When enabled by the owning interactive session:
 * - authenticated plain `ws://` upgrades are brokered to validated public
 *   destinations as "ws" ledger entries, and
 * - CONNECT tunnels (the only path `wss://` can take, opaque under the
 *   browser's end-to-end TLS) use `liveIdleSocketMs` instead of the ordinary
 *   HTTP idle bound, because quiet live transports must not be evicted by a
 *   timer meant for request/response traffic. `null` disables ordinary idle
 *   eviction for live transports entirely; hard byte/connection budgets and
 *   broker teardown still destroy them. There is no elapsed-lifetime expiry
 *   for live connections in either case.
 */
export interface EgressBrokerWebSocketPolicy {
  enabled: boolean;
  /**
   * Idle bound for live transports (opted-in ws upgrades and, because they
   * are opaque, CONNECT tunnels). Defaults to the broker's idleSocketMs;
   * `null` means no ordinary idle eviction.
   */
  liveIdleSocketMs?: number | null;
}

export interface EgressSummary {
  ledger: readonly BrokerLedgerEntry[];
  /** Bounded omission diagnostics (each entry is length-bounded). */
  omissions: readonly string[];
  /** Omissions beyond the diagnostics cap, counted only. */
  omissionsDropped: number;
  /** Connections destroyed at a budget (bytes or idle time). */
  budgetAborts: number;
  /** Requests/CONNECTs refused before any dial. */
  refusals: number;
}

/**
 * Optional lifecycle observer used by a persistent interactive browser
 * session. BrowserExtract deliberately omits it and keeps its existing
 * per-render result policy.
 */
export interface EgressBrokerObserver {
  policyFailure(reason: "refusal" | "budget_abort", diagnostic: string): void;
}

/**
 * Seam for deterministic tests: dials one outbound socket for a validated
 * destination. Production callers never set this; the default dials exactly
 * one validated public address (IPv4 preferred).
 */
export type BrokerDial = (validated: ValidatedUrl, port: number) => net.Socket;

export function preferredPinnedAddress(addresses: readonly string[]): string | undefined {
  return addresses.find((address) => !address.includes(":")) ?? addresses[0];
}

export function defaultBrokerDial(validated: ValidatedUrl, port: number): net.Socket {
  const address = preferredPinnedAddress(validated.addresses);
  if (!address) throw new Error(`No validated public address is available for ${validated.hostname}.`);
  return net.connect({ host: address, port });
}

/** Only loopback clients (the local browser) may talk to the broker. */
export function isLoopbackRemote(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress.replace(/^\[|\]$/g, "") === "::1";
}

const MAX_OMISSION_CHARS = 300;

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const WEBSOCKET_REQUEST_HEADERS = [
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "sec-websocket-extensions",
];

interface ParsedConnectAuthority {
  host: string;
  port: number;
}

/**
 * Per-render broker client credential. When set, every proxy request and
 * CONNECT must present the matching `Proxy-Authorization: Basic` header
 * (supplied by Chromium via Playwright's proxy auth) or it is challenged with
 * 407 and never processed, so other local processes cannot use the broker as
 * an open forward proxy during the render window.
 */
export interface BrokerAuth {
  username: string;
  password: string;
}

export class EgressBroker {
  private server?: http.Server;
  private startOperation?: Promise<number>;
  private startupPending = false;
  private brokerPort = 0;
  private closed = false;
  private startedAtMs = 0;
  private requests = 0;
  private readonly sockets = new Set<net.Socket>();
  private readonly clientSockets = new Set<net.Socket>();
  private readonly trackedSockets = new WeakSet<net.Socket>();
  private readonly preAuthSockets = new WeakSet<net.Socket>();
  private readonly preAuthTimeoutAttached = new WeakSet<net.Socket>();
  private readonly idleAttached = new WeakSet<net.Socket>();
  private readonly ledger: BrokerLedgerEntry[] = [];
  private readonly omissionEntries: string[] = [];
  private readonly abortedEntries = new Set<BrokerLedgerEntry>();
  private readonly hosts = new Set<string>();
  private omissionsDropped = 0;
  private budgetAborts = 0;
  private refusals = 0;
  private connectionCount = 0;
  private totalBytes = 0;
  private readonly expectedAuthorization?: string;
  /** Set only when live WebSocket transport was explicitly opted in. */
  private readonly websocketPolicy?: EgressBrokerWebSocketPolicy;

  constructor(
    private readonly resolve: HostResolver,
    private readonly dial: BrokerDial = defaultBrokerDial,
    private readonly budgets: EgressBudgets = DEFAULT_EGRESS_BUDGETS,
    auth?: BrokerAuth,
    private readonly observer?: EgressBrokerObserver,
    websockets?: EgressBrokerWebSocketPolicy,
  ) {
    this.websocketPolicy = websockets?.enabled === true ? websockets : undefined;
    if (auth) {
      this.expectedAuthorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
    }
  }

  get port(): number {
    return this.brokerPort;
  }

  /** The loopback address the broker is bound to, once started. */
  get boundAddress(): string | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? (address as AddressInfo).address : undefined;
  }

  /** Start listening on loopback only and return the ephemeral broker port. */
  start(): Promise<number> {
    if (this.startOperation || this.server || this.closed) {
      return Promise.reject(new Error(this.closed ? "Egress broker is closing." : "Egress broker is already started."));
    }
    this.startupPending = true;
    const operation = this.startListening().finally(() => {
      this.startupPending = false;
    });
    this.startOperation = operation;
    return operation;
  }

  private async startListening(): Promise<number> {
    const server = http.createServer();
    server.on("connection", (socket) => this.admitClient(socket));
    server.on("request", (request, response) => {
      void this.handlePlainProxyRequest(request, response).catch(() => undefined);
    });
    server.on("upgrade", (request, duplexSocket, head) => {
      // Upgrade sockets on an http.Server are always real net.Sockets.
      const socket = duplexSocket as net.Socket;
      void this.handleUpgrade(request, socket, head).catch(() => undefined);
    });
    server.on("connect", (request, duplexSocket, head) => {
      // CONNECT sockets on an http.Server are always real net.Sockets.
      const socket = duplexSocket as net.Socket;
      void this.handleConnect(request, socket, head).catch(() => undefined);
    });
    server.on("clientError", (_error, duplexSocket) => {
      const socket = duplexSocket as net.Socket;
      this.track(socket);
      socket.destroy();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address !== "object" || (address as AddressInfo).address !== "127.0.0.1") {
      await closeHttpServer(server);
      throw new Error("Egress broker must listen on 127.0.0.1 only.");
    }
    // close() may have won while listen() was pending. Never publish a late
    // listener after closure; shut it down before the start promise settles.
    if (this.closed) {
      await closeHttpServer(server);
      throw new Error("Egress broker closed during startup.");
    }
    this.brokerPort = (address as AddressInfo).port;
    this.server = server;
    this.startedAtMs = Date.now();
    return this.brokerPort;
  }

  /**
   * Validate the proxy client: when a per-render credential is configured,
   * the request must carry the matching `Proxy-Authorization: Basic` header.
   * Missing or wrong credentials are challenged with 407 (never counted as
   * policy refusals), so only the render's own browser can use the broker.
   */
  private authorized(request: IncomingMessage): boolean {
    if (!this.expectedAuthorization) return true;
    const presented = request.headers["proxy-authorization"];
    if (typeof presented !== "string" || presented.length === 0) return false;
    // Compare fixed-length SHA-256 digests of the FULL header values: no
    // truncation (production credentials exceed 64 characters), no length
    // leak, constant time.
    const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
    return timingSafeEqual(digest(presented), digest(this.expectedAuthorization));
  }

  /**
   * Record one bounded omission diagnostic. Diagnostics past the cap are
   * counted, never retained, so attacker-controlled page content cannot grow
   * memory or output.
   */
  note(text: string): void {
    const bounded = text.length > MAX_OMISSION_CHARS ? `${text.slice(0, MAX_OMISSION_CHARS)}…` : text;
    if (this.omissionEntries.length >= this.budgets.maxDiagnostics) {
      this.omissionsDropped += 1;
      return;
    }
    this.omissionEntries.push(bounded);
  }

  /**
   * Idempotent, fail-closed teardown: destroys every tracked socket, stops the
   * listener, force-closes any remaining connections, and completes within the
   * cleanup deadline or throws.
   */
  async close(): Promise<EgressSummary> {
    this.closed = true;
    // If close races listen(), startListening observes `closed`, closes the
    // late listener itself, and only then rejects. Await that containment
    // before evaluating quiescence.
    if (this.startOperation && !this.server) {
      await this.boundedWait(this.startOperation.then(() => undefined, () => undefined), "egress broker startup settlement");
    }
    const sockets = [...this.sockets];
    // A destroyed socket can remain in the set until its asynchronous `close`
    // event. Attach every waiter before destroy() so that state transition can
    // neither be missed nor mistaken for quiescence.
    const socketClosures = sockets.map((socket) => once(socket, "close").then(() => undefined));
    for (const socket of sockets) socket.destroy();
    const server = this.server;
    const waits: Promise<unknown>[] = [...socketClosures];
    if (server) {
      this.server = undefined;
      const listenerClosed = once(server, "close");
      server.close();
      server.closeAllConnections?.();
      waits.push(listenerClosed);
    }
    if (waits.length > 0) {
      await this.boundedWait(Promise.all(waits), "egress broker socket and listener close");
    }
    if (!this.isQuiescent()) {
      throw new Error(`Egress broker shutdown completed without quiescence (${this.sockets.size} socket(s) remain).`);
    }
    return this.summary();
  }

  /** True only after the listener is gone and every tracked socket closed. */
  isQuiescent(): boolean {
    return !this.startupPending && this.server === undefined && this.sockets.size === 0 && this.clientSockets.size === 0;
  }

  /** Reject when `operation` does not settle within the cleanup deadline. */
  private async boundedWait(operation: Promise<unknown>, what: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Egress broker cleanup deadline (${this.budgets.maxCleanupMs}ms) exceeded during ${what}.`)), this.budgets.maxCleanupMs);
      timer.unref?.();
    });
    deadline.catch(() => undefined);
    operation.catch(() => undefined);
    try {
      await Promise.race([operation, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  summary(): EgressSummary {
    return {
      ledger: [...this.ledger],
      omissions: [...this.omissionEntries],
      omissionsDropped: this.omissionsDropped,
      budgetAborts: this.budgetAborts,
      refusals: this.refusals,
    };
  }

  /** Record and surface a policy refusal to persistent-session owners. */
  private recordPolicyRefusal(diagnostic: string): void {
    this.refusals += 1;
    this.note(diagnostic);
    this.observer?.policyFailure("refusal", diagnostic);
  }

  private track(socket: net.Socket): void {
    // Keep-alive client sockets arrive here once per request; attach listeners
    // only on first sight so they cannot accumulate (MaxListeners).
    if (this.trackedSockets.has(socket)) return;
    this.trackedSockets.add(socket);
    this.sockets.add(socket);
    // Upgraded CONNECT sockets lose http.Server's own error listener; an
    // errored socket must be torn down (autoDestroy), never crash the process.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.clientSockets.delete(socket);
    });
    if (this.closed) socket.destroy();
  }

  /**
   * Admit one broker-facing client socket: loopback only, bounded by an
   * explicit client-connection budget (independent of outbound dial
   * accounting), and destroyed when idle before it authenticates.
   */
  private admitClient(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    if (!isLoopbackRemote(socket.remoteAddress)) {
      this.note(`egress broker refused non-loopback client ${socket.remoteAddress ?? "unknown"}.`);
      socket.destroy();
      return;
    }
    if (this.clientSockets.size >= this.budgets.maxClientConnections) {
      this.recordPolicyRefusal(`egress broker refused client connection: client-connection budget (${this.budgets.maxClientConnections}) exhausted.`);
      socket.destroy();
      return;
    }
    this.clientSockets.add(socket);
    this.track(socket);
    this.preAuthSockets.add(socket);
    this.attachPreAuthDeadline(socket);
  }

  /**
   * Idle deadline for pre-authentication client sockets: a loopback peer that
   * never sends an authenticated HTTP request cannot hold broker resources.
   * Once the socket carries an authorized request, its membership is dropped
   * (the guard makes the attached timeout listener a benign no-op).
   */
  private attachPreAuthDeadline(socket: net.Socket): void {
    socket.setTimeout(this.budgets.preAuthSocketMs);
    if (this.preAuthTimeoutAttached.has(socket)) return;
    this.preAuthTimeoutAttached.add(socket);
    socket.on("timeout", () => {
      if (!this.preAuthSockets.has(socket)) return;
      this.note(`pre-authentication idle deadline (${this.budgets.preAuthSocketMs}ms) destroyed an idle client socket.`);
      this.clientSockets.delete(socket);
      socket.destroy();
    });
  }

  /**
   * The socket now carries an authorized request: drop its pre-authentication
   * membership AND disarm the pre-auth inactivity timer. http.Server attaches
   * its own `timeout` handler to every plain-HTTP connection and destroys the
   * socket when no request/response/server listener handles the event, so a
   * still-armed timer would silently cut authorized plain-HTTP transfers with
   * more than preAuthSocketMs of inactivity (slow origins) short and the
   * ledger would misclassify them as client cancels. Authorized client
   * sockets are governed by the destination's idleSocketMs budget and the
   * render's total-time budget instead; CONNECT tunnels re-arm their own idle
   * budget in pipeTunnel.
   */
  private markClientAuthorized(socket: net.Socket): void {
    if (!this.preAuthSockets.has(socket)) return;
    this.preAuthSockets.delete(socket);
    // Disable the net.Socket timer itself. Node's HTTP server also handles
    // `timeout` and may destroy the socket even when our listener is a no-op.
    socket.setTimeout(0);
  }

  /**
   * Validate one destination BEFORE any socket is dialed: budgets are checked,
   * the hostname is resolved exactly once, and every resolved address must be
   * public. Returns undefined (and records a refusal) when the destination is
   * not admissible; the caller then responds with an error and dials nothing.
   */
  /**
   * Validate one destination and atomically reserve its host/connection
   * budget slots BEFORE any asynchronous DNS work: the synchronous prefix
   * checks and increments are the admission point, so concurrent requests
   * cannot all pass the checks and exceed the limits. Reservations are rolled
   * back when validation fails (they still consumed the request budget, which
   * bounds refusal work too).
   */
  private async admit(url: URL, kind: "http" | "connect" | "ws"): Promise<ValidatedUrl | undefined> {
    if (this.closed) {
      this.note(`${kind} destination refused: broker is closing.`);
      return undefined;
    }
    if (this.budgets.maxTotalMs !== null && Date.now() - this.startedAtMs >= this.budgets.maxTotalMs) {
      this.recordPolicyRefusal(`${kind} destination refused: total-time budget (${this.budgets.maxTotalMs}ms) exhausted.`);
      return undefined;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // Opted-in WebSocket upgrades must never disclose the request path, query,
    // or userinfo in diagnostics: only the validated hostname and port.
    const target = kind === "ws" ? boundedText(`${hostname}:${url.port || 80}`) : boundedText(url.href);
    const firstSeenHost = !this.hosts.has(hostname);
    // Synchronous reservation: no await may happen between these checks and
    // the increments.
    if (firstSeenHost && this.hosts.size >= this.budgets.maxDistinctHosts) {
      this.recordPolicyRefusal(`${kind} destination refused: distinct-host budget (${this.budgets.maxDistinctHosts}) exhausted for ${boundedText(hostname)}.`);
      return undefined;
    }
    if (this.connectionCount >= this.budgets.maxConnections) {
      this.recordPolicyRefusal(`${kind} destination refused: connection budget (${this.budgets.maxConnections}) exhausted for ${target}.`);
      return undefined;
    }
    if (this.totalBytes >= this.budgets.maxTotalBytes) {
      this.recordPolicyRefusal(`${kind} destination refused: aggregate byte budget (${this.budgets.maxTotalBytes}) exhausted.`);
      return undefined;
    }
    // Keep first-seen hostnames reserved for the whole render, including
    // failed DNS attempts: deleting here could erase another concurrent
    // request's reservation and let the distinct-host cap be exceeded.
    if (firstSeenHost) this.hosts.add(hostname);
    this.connectionCount += 1;
    try {
      const validated = await validatePublicUrl(url.href, this.resolve);
      return validated;
    } catch (error) {
      // Roll back the connection reservation (the request budget and any
      // first-seen hostname reservation stay consumed, bounding adversarial
      // refusal loops).
      this.connectionCount -= 1;
      this.recordPolicyRefusal(`${kind} destination refused: ${error instanceof Error ? error.message : String(error)} (${target}).`);
      return undefined;
    }
  }

  private async handlePlainProxyRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // IncomingMessage.socket is typed as Duplex; for an http.Server connection
    // it is always a net.Socket.
    const clientSocket = request.socket as net.Socket;
    this.track(clientSocket);
    const finish = (status: number, message: string, extraHeaders?: Record<string, string>, diagnostic?: string) => {
      if (diagnostic) this.note(diagnostic);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close", ...extraHeaders });
        response.end(message);
      } else {
        response.destroy();
      }
    };
    try {
      // Any upgrade-bearing request that reached the plain request path (the
      // real Upgrade event path handles genuine upgrades) is fail-closed: an
      // upgrade can never be forwarded as a mangled plain request.
      if (request.headers.upgrade !== undefined) {
        this.recordPolicyRefusal("proxy request refused: upgrade header on the plain request path.");
        finish(403, "Egress broker refuses upgrades on this path.");
        return;
      }
      // Validate the client credential BEFORE consuming the request budget so
      // an unauthenticated local process cannot exhaust it (local DoS on the
      // active render).
      if (!this.authorized(request)) {
        finish(407, "Proxy authentication required.", { "proxy-authenticate": 'Basic realm="pi-review-gate-egress-broker"' });
        return;
      }
      this.markClientAuthorized(clientSocket);
      this.requests += 1;
      if (this.requests > this.budgets.maxRequests) {
        const diagnostic = `proxy request refused: request budget (${this.budgets.maxRequests}) exhausted.`;
        this.recordPolicyRefusal(diagnostic);
        finish(502, "Egress broker request budget exhausted.");
        return;
      }
      const target = this.parseProxyRequest(request);
      if (!target) {
        const diagnostic = `proxy request refused by authority/header/protocol policy: ${boundedText(String(request.url ?? ""))}`;
        this.recordPolicyRefusal(diagnostic);
        finish(400, "Egress broker refuses this proxy request.");
        return;
      }
      const validated = await this.admit(target.url, "http");
      if (this.closed || !validated) {
        finish(403, "Egress broker refused the requested destination.");
        return;
      }
      const port = target.port;
      const entry: BrokerLedgerEntry = {
        hostname: validated.hostname,
        port,
        address: preferredPinnedAddress(validated.addresses) ?? "",
        kind: "http",
        bytesSent: 0,
        bytesReceived: 0,
        completed: false,
      };
      const destination = this.dial(validated, port);
      this.track(destination);
      await awaitSocketConnect(destination);
      if (this.closed) {
        destination.destroy();
        finish(502, "Egress broker is closing.");
        return;
      }
      this.ledger.push(entry);
      // Idle budget applies to the dedicated destination socket only; the
      // client socket is Chromium's reused keep-alive connection.
      this.attachIdle(destination, entry, [destination, clientSocket]);
      const proxyRequest = http.request(target.url.href, {
        createConnection: () => destination,
        method: request.method,
        headers: forwardRequestHeaders(request),
      });
      // A destination truncation (the origin failed or closed mid-body) leaves
      // the ledger entry incomplete and cuts the client response short so
      // Chromium observes the failure. A client-driven cancel (Chromium closed
      // its side first, e.g. a main document superseded by a script redirect)
      // is not a truncation: the entry counts complete unless a budget
      // destroyed it.
      let destinationTruncated = false;
      const onDestinationTruncated = () => {
        destinationTruncated = true;
        destination.destroy();
        response.destroy();
      };
      request.on("data", (chunk: Buffer) => {
        entry.bytesSent += chunk.length;
        this.totalBytes += chunk.length;
        this.enforceByteBudget(entry, [destination, clientSocket]);
      });
      proxyRequest.on("response", (proxyResponse) => {
        proxyResponse.on("data", (chunk: Buffer) => {
          entry.bytesReceived += chunk.length;
          this.totalBytes += chunk.length;
          if (this.enforceByteBudget(entry, [destination, clientSocket])) proxyResponse.destroy();
        });
        proxyResponse.on("end", () => {
          entry.completed = true;
        });
        proxyResponse.on("aborted", onDestinationTruncated);
        proxyResponse.on("error", onDestinationTruncated);
        response.writeHead(proxyResponse.statusCode ?? 502, forwardResponseHeaders(proxyResponse));
        proxyResponse.pipe(response);
      });
      proxyRequest.on("error", (error) => {
        destinationTruncated = true;
        this.note(`origin connection failed for ${validated.hostname}:${port}: ${boundedText(error instanceof Error ? error.message : String(error))}.`);
        destination.destroy();
        finish(502, "Egress broker could not reach the validated destination.");
      });
      response.on("close", () => {
        // Client-driven cancels (Chromium closed its side first, e.g. a main
        // document superseded by a script redirect) are not truncations: the
        // entry counts complete unless a budget destroyed it. A destination
        // truncation keeps the entry incomplete so the render's final safety
        // gate can fail closed when no useful content remains.
        if (!entry.completed && !destinationTruncated && !this.abortedEntries.has(entry)) {
          entry.completed = true;
        }
        proxyRequest.destroy();
        destination.destroy();
      });
      request.pipe(proxyRequest);
    } catch (error) {
      this.refusals += 1;
      finish(502, "Egress broker request failed.", undefined, `proxy request failed: ${boundedText(error instanceof Error ? error.message : String(error))}.`);
    }
  }

  private parseProxyRequest(request: IncomingMessage): { url: URL; port: number } | undefined {
    const raw = typeof request.url === "string" ? request.url : "";
    if (raw.length === 0 || raw.length > this.budgets.maxAuthorityChars) return undefined;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if (url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    let headerChars = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headerChars += request.rawHeaders[index]!.length + request.rawHeaders[index + 1]!.length;
    }
    if (headerChars > this.budgets.maxHeaderChars) return undefined;
    const port = url.port ? Number(url.port) : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { url, port };
  }

  private async handleConnect(request: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    this.track(socket);
    const refuse = (status: number, diagnostic?: string, extraHeaders?: string) => {
      if (diagnostic) this.note(diagnostic);
      if (!socket.destroyed && socket.writable) {
        socket.end(
          `HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Forbidden"}\r\n`
          + `${extraHeaders ?? ""}Connection: close\r\n\r\n`,
          () => socket.destroy(),
        );
      } else {
        socket.destroy();
      }
    };
    try {
      if (this.closed) {
        socket.destroy();
        return;
      }
      if (!this.authorized(request)) {
        refuse(407, undefined, 'Proxy-Authenticate: Basic realm="pi-review-gate-egress-broker"\r\n');
        return;
      }
      this.markClientAuthorized(socket);
      this.requests += 1;
      if (this.requests > this.budgets.maxRequests) {
        const diagnostic = `CONNECT refused: request budget (${this.budgets.maxRequests}) exhausted.`;
        this.recordPolicyRefusal(diagnostic);
        refuse(502);
        return;
      }
      const authority = typeof request.url === "string" ? request.url : "";
      if (authority.length > this.budgets.maxAuthorityChars) {
        const diagnostic = `CONNECT refused: authority exceeds ${this.budgets.maxAuthorityChars} characters.`;
        this.recordPolicyRefusal(diagnostic);
        refuse(400);
        return;
      }
      let connectHeaderChars = 0;
      for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
        connectHeaderChars += request.rawHeaders[index]!.length + request.rawHeaders[index + 1]!.length;
      }
      if (connectHeaderChars > this.budgets.maxHeaderChars) {
        const diagnostic = `CONNECT refused: header block exceeds ${this.budgets.maxHeaderChars} characters.`;
        this.recordPolicyRefusal(diagnostic);
        refuse(400);
        return;
      }
      const parsed = parseConnectAuthority(authority);
      if (!parsed) {
        const diagnostic = `CONNECT refused: invalid authority ${boundedText(authority)}.`;
        this.recordPolicyRefusal(diagnostic);
        refuse(400);
        return;
      }
      if (WEBSOCKET_REQUEST_HEADERS.some((name) => request.headers[name] !== undefined)
        // Any upgrade-bearing CONNECT is rejected outright: a genuine wss
        // handshake travels INSIDE the opaque TLS tunnel, never on the
        // CONNECT itself, so such a request is a malformed direct-upgrade or
        // non-WebSocket tunneling attempt and fails closed.
        || request.headers.upgrade !== undefined) {
        const diagnostic = `CONNECT refused: WebSocket upgrade to ${parsed.host}:${parsed.port}.`;
        this.recordPolicyRefusal(diagnostic);
        refuse(403);
        return;
      }
      // Re-bracket IPv6 literals so the URL is parseable (the parser strips
      // brackets; the WHATWG URL requires them again).
      const urlHost = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
      let url: URL;
      try {
        url = new URL(`https://${urlHost}:${parsed.port}/`);
      } catch {
        const diagnostic = `CONNECT refused: unparseable authority ${boundedText(authority)}.`;
        this.recordPolicyRefusal(diagnostic);
        refuse(400);
        return;
      }
      const validated = await this.admit(url, "connect");
      if (this.closed || !validated) {
        refuse(403, undefined);
        return;
      }
      const entry: BrokerLedgerEntry = {
        hostname: validated.hostname,
        port: parsed.port,
        address: preferredPinnedAddress(validated.addresses) ?? "",
        kind: "connect",
        bytesSent: 0,
        bytesReceived: 0,
        completed: false,
      };
      const destination = this.dial(validated, parsed.port);
      this.track(destination);
      await awaitSocketConnect(destination);
      if (this.closed) {
        socket.destroy();
        destination.destroy();
        return;
      }
      this.ledger.push(entry);
      // Bytes pipelined after the CONNECT header arrive in `head`; they are
      // counted and budget-enforced BEFORE they reach the destination, so
      // pipelined payloads can never bypass the byte caps.
      if (head.length > 0) {
        entry.bytesSent += head.length;
        this.totalBytes += head.length;
        if (this.enforceByteBudget(entry, [socket, destination])) return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) destination.write(head);
      this.pipeTunnel(socket, destination, entry, this.liveIdleSocketMs());
    } catch (error) {
      this.refusals += 1;
      refuse(502, `CONNECT tunnel failed: ${boundedText(error instanceof Error ? error.message : String(error))}.`);
    }
  }

  /**
   * Idle bound for live transports. Without the explicit WebSocket opt-in this
   * is exactly the ordinary budgets.idleSocketMs (default behavior unchanged);
   * only the opt-in can relax (liveIdleSocketMs) or disable (null) it.
   */
  private liveIdleSocketMs(): number | null {
    if (!this.websocketPolicy) return this.budgets.idleSocketMs;
    return this.websocketPolicy.liveIdleSocketMs === undefined ? this.budgets.idleSocketMs : this.websocketPolicy.liveIdleSocketMs;
  }

  /**
   * Handle one authenticated plain-`ws://` HTTP upgrade through the proxy
   * path. This is reachable only when the owner explicitly opted in via
   * EgressBrokerWebSocketPolicy; otherwise the upgrade is refused 403 BEFORE
   * any budget consumption beyond the request attempt and before any dial.
   * The origin's credentials-free upgrade request is re-issued verbatim (minus
   * hop-by-hop and proxy headers) to the validated public destination; a 101
   * switches both sockets into the same byte-accounted, budget-enforced pipe
   * used by CONNECT tunnels.
   */
  private async handleUpgrade(request: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    this.track(socket);
    const refuse = (status: number, diagnostic?: string) => {
      if (diagnostic) this.note(diagnostic);
      if (!socket.destroyed && socket.writable) {
        socket.end(
          `HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : status === 502 ? "Bad Gateway" : "Forbidden"}\r\n`
          + `${status === 407 ? 'Proxy-Authenticate: Basic realm="pi-review-gate-egress-broker"\r\n' : ""}Connection: close\r\n\r\n`,
          () => socket.destroy(),
        );
      } else {
        socket.destroy();
      }
    };
    try {
      if (this.closed) {
        socket.destroy();
        return;
      }
      if (!this.authorized(request)) {
        refuse(407);
        return;
      }
      this.markClientAuthorized(socket);
      this.requests += 1;
      if (this.requests > this.budgets.maxRequests) {
        this.recordPolicyRefusal(`websocket upgrade refused: request budget (${this.budgets.maxRequests}) exhausted.`);
        refuse(403);
        return;
      }
      if (!this.websocketPolicy) {
        this.recordPolicyRefusal("websocket upgrade refused: live WebSocket transport is not enabled for this broker.");
        refuse(403);
        return;
      }
      const parsed = this.parseUpgradeRequest(request);
      if (!parsed) {
        // Fixed text only: the request target may carry a path, query, or
        // userinfo that must never reach diagnostics, summaries, or observers.
        this.recordPolicyRefusal("websocket upgrade refused: malformed upgrade target.");
        refuse(400);
        return;
      }
      // Bytes pipelined after the upgrade request head are protocol violations
      // before the 101 completes; fail closed (they are counted first).
      if (head.length > 0) {
        this.totalBytes += head.length;
        this.note("websocket upgrade refused: pipelined bytes before the upgrade completed.");
        socket.destroy();
        return;
      }
      const validated = await this.admit(parsed.url, "ws");
      if (this.closed || !validated) {
        refuse(403);
        return;
      }
      const entry: BrokerLedgerEntry = {
        hostname: validated.hostname,
        port: parsed.port,
        address: preferredPinnedAddress(validated.addresses) ?? "",
        kind: "ws",
        bytesSent: 0,
        bytesReceived: 0,
        completed: false,
      };
      const originHead = this.buildOriginUpgradeHead(request, parsed.url);
      if (!originHead) {
        this.refusals += 1;
        refuse(400, "websocket upgrade refused: unforwardable upgrade request.");
        return;
      }
      const destination = this.dial(validated, parsed.port);
      this.track(destination);
      // If the client goes away while the dial or the origin handshake is in
      // flight, the destination must go away too (a FIN from the peer ends the
      // readable side without destroying our socket, so poll readableEnded
      // explicitly and hook close as a backstop).
      const onClientGone = () => destination.destroy();
      socket.once("close", onClientGone);
      await awaitSocketConnect(destination);
      // A late-resolved dial for a vanished client must never leak a
      // destination socket or complete a handshake on its behalf.
      if (this.closed || socket.destroyed || socket.readableEnded || socket.readyState === "closed") {
        socket.destroy();
        destination.destroy();
        return;
      }
      this.ledger.push(entry);
      const handshakeDeadline = setTimeout(() => destination.destroy(), this.budgets.preAuthSocketMs);
      handshakeDeadline.unref?.();
      try {
        destination.write(originHead);
        const responseHead = await readHttpHead(destination, this.budgets.maxHeaderChars, this.budgets.preAuthSocketMs);
        const status = parseStatusLine(responseHead.head);
        if (!status || status.code !== 101 || !headerContains(responseHead.head, "upgrade", "websocket")) {
          // Non-101 (or a 101 without the required header): relay only the
          // status line, never origin headers or payload, and fail closed.
          entry.completed = true;
          this.note(`websocket upgrade refused by destination with HTTP ${status?.code ?? 0} for ${validated.hostname}:${parsed.port}.`);
          if (!socket.destroyed && socket.writable) {
            socket.end(`HTTP/1.1 ${status?.code ?? 502} ${status?.reason ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
          } else {
            socket.destroy();
          }
          destination.destroy();
          return;
        }
        socket.write(responseHead.head);
        // Bytes the origin coalesced with the 101 (e.g. the first
        // server-initiated frame) are forwarded exactly once, byte-accounted,
        // BEFORE the pipe takes over; same-socket write ordering keeps them
        // ahead of all subsequent destination data.
        if (responseHead.remainder.length > 0) {
          entry.bytesReceived += responseHead.remainder.length;
          this.totalBytes += responseHead.remainder.length;
          if (!this.enforceByteBudget(entry, [socket, destination])) {
            socket.write(responseHead.remainder);
          }
        }
        if (socket.destroyed || destination.destroyed) return;
        this.pipeTunnel(socket, destination, entry, this.liveIdleSocketMs());
      } finally {
        clearTimeout(handshakeDeadline);
      }
    } catch (error) {
      this.refusals += 1;
      socket.destroy();
      refuse(403, `websocket upgrade failed: ${boundedText(error instanceof Error ? error.message : String(error))}.`);
    }
  }

  /**
   * Validate one client upgrade request: absolute-form `http:` target, GET,
   * `Upgrade: websocket`, no body, bounded authority/headers. Returns undefined
   * (refuse) for anything else.
   */
  private parseUpgradeRequest(request: IncomingMessage): { url: URL; port: number } | undefined {
    if (request.method !== "GET") return undefined;
    const upgrade = typeof request.headers.upgrade === "string" ? request.headers.upgrade.trim().toLowerCase() : "";
    if (upgrade !== "websocket") return undefined;
    if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) return undefined;
    return this.parseProxyRequest(request);
  }

  /**
   * Build the origin-bound upgrade request head: origin-form target, original
   * Host, forwarded non-hop-by-hop headers (proxy credentials and proxy hops
   * are stripped — the broker's credentials must never reach the origin), and
   * the fixed upgrade headers. Returns undefined when the request cannot be
   * forwarded safely.
   */
  private buildOriginUpgradeHead(request: IncomingMessage, target: URL): string | undefined {
    const lines = [`GET ${target.pathname}${target.search || ""} HTTP/1.1`];
    let sawHost = false;
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]!;
      const value = request.rawHeaders[index + 1]!;
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
      // Duplicate Host headers could smuggle a different authority at the
      // origin; only a single Host header is forwarded.
      if (lower === "host") {
        if (sawHost) return undefined;
        sawHost = true;
      }
      lines.push(`${name}: ${value}`);
    }
    if (!sawHost) lines.push(`Host: ${target.host}`);
    lines.push("Connection: Upgrade", "Upgrade: websocket");
    return `${lines.join("\r\n")}\r\n\r\n`;
  }

  private pipeTunnel(client: net.Socket, destination: net.Socket, entry: BrokerLedgerEntry, idleMs: number | null = this.budgets.idleSocketMs): void {
    const countFrom = (from: net.Socket, direction: "bytesSent" | "bytesReceived") => {
      from.on("data", (chunk: Buffer) => {
        entry[direction] += chunk.length;
        this.totalBytes += chunk.length;
        this.enforceByteBudget(entry, [client, destination]);
      });
    };
    countFrom(client, "bytesSent");
    countFrom(destination, "bytesReceived");
    client.pipe(destination);
    destination.pipe(client);
    if (idleMs !== null) {
      this.attachIdle(client, entry, [client, destination], idleMs);
      this.attachIdle(destination, entry, [client, destination], idleMs);
    }
    const destroyBoth = () => {
      if (!this.abortedEntries.has(entry)) entry.completed = true;
      client.destroy();
      destination.destroy();
    };
    client.on("error", destroyBoth);
    destination.on("error", destroyBoth);
    client.on("close", destroyBoth);
    destination.on("close", destroyBoth);
  }

  private attachIdle(socket: net.Socket, entry: BrokerLedgerEntry, peers: net.Socket[], idleMs: number = this.budgets.idleSocketMs): void {
    // Only ever call this on sockets dedicated to ONE connection (dialed
    // destination sockets, CONNECT tunnel sockets) — never on Chromium's
    // reused keep-alive client socket. The WeakSet guard additionally makes
    // the attachment idempotent so timeout listeners cannot accumulate.
    socket.setTimeout(idleMs);
    if (this.idleAttached.has(socket)) return;
    this.idleAttached.add(socket);
    socket.on("timeout", () => {
      this.note(`idle timeout (${idleMs}ms) destroyed connection to ${entry.hostname}:${entry.port}.`);
      // Evict quiet sockets, not their owning browser. TLS tunnels are opaque:
      // we cannot attest completion, but idleness is not a security violation.
      // Subsequent connections still pass admit() and fresh DNS validation.
      this.abortConnections(entry, peers, "idle");
    });
  }

  /** Returns true when the budget was exceeded and the connection destroyed. */
  private enforceByteBudget(entry: BrokerLedgerEntry, peers: net.Socket[]): boolean {
    const connectionBytes = entry.bytesSent + entry.bytesReceived;
    if (connectionBytes <= this.budgets.maxConnectionBytes && this.totalBytes <= this.budgets.maxTotalBytes) return false;
    this.note(
      `byte budget exceeded for ${entry.hostname}:${entry.port} `
      + `(${connectionBytes} on connection, ${this.totalBytes} total); connection destroyed.`,
    );
    this.abortConnections(entry, peers);
    return true;
  }

  private abortConnections(entry: BrokerLedgerEntry, peers: net.Socket[], reason: "budget" | "idle" = "budget"): void {
    if (!this.abortedEntries.has(entry)) {
      this.abortedEntries.add(entry);
      entry.completed = false;
      this.budgetAborts += 1;
      // Preserve conservative render accounting (including incomplete idle
      // transfers), but notify the fatal observer only for hard budgets.
      if (reason === "budget") this.observer?.policyFailure(
        "budget_abort",
        `Egress budget aborted a connection to ${entry.hostname}:${entry.port}.`,
      );
    }
    for (const socket of peers) socket.destroy();
  }
}

/**
 * Parse a CONNECT authority (`host:port`, IPv6 `[host]:port`). Rejects
 * userinfo, out-of-range ports, and empty hosts — fail closed.
 */
export function parseConnectAuthority(authority: string): ParsedConnectAuthority | undefined {
  if (authority.includes("@")) return undefined;
  let host: string;
  let port = 443;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end === -1) return undefined;
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest === "") {
      // [host] with no port: keep the default.
    } else if (rest.startsWith(":")) {
      port = Number(rest.slice(1));
    } else {
      return undefined;
    }
  } else {
    const separator = authority.lastIndexOf(":");
    if (separator !== -1) {
      port = Number(authority.slice(separator + 1));
      host = authority.slice(0, separator);
    } else {
      host = authority;
    }
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: host.toLowerCase(), port };
}

/** Await a dialed socket's connect event without hanging on error/close. */
async function awaitSocketConnect(socket: net.Socket): Promise<void> {  if (socket.readyState === "open") return;
  if (socket.destroyed) throw new Error("Dial socket was destroyed before connecting.");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Dial socket closed before connecting."));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/** One HTTP response head plus any bytes that arrived coalesced behind it. */
interface ReadHttpHeadResult {
  /** The status line and headers, through and including CRLFCRLF. */
  head: Buffer;
  /**
   * Bytes the origin sent in the same segment(s) as the head. For a WebSocket
   * 101 this is legitimately the first server-initiated frame; the caller
   * must forward it exactly once, in order, before piped data resumes.
   */
  remainder: Buffer;
}

/**
 * Read one HTTP head (through CRLFCRLF) from a raw socket, bounded in bytes
 * and time. Fails closed on truncation, oversized heads, timeouts, and early
 * closes. The bound is enforced against the ACTUAL head length through
 * CRLFCRLF regardless of chunk boundaries, and bytes coalesced behind the
 * delimiter are returned as `remainder` instead of destroying the connection:
 * a WebSocket origin may legitimately send its 101 and first frame together.
 * Never inspects or retains payload content beyond returning it to the caller.
 */
async function readHttpHead(socket: net.Socket, maxChars: number, deadlineMs: number): Promise<ReadHttpHeadResult> {
  return await new Promise<ReadHttpHeadResult>((resolveHead, rejectHead) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
    };
    const fail = (error: Error) => {
      cleanup();
      rejectHead(error);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      const joined = Buffer.concat(chunks);
      const headEnd = joined.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        // Early bound: do not buffer an unbounded oversized head when the
        // delimiter has not arrived yet.
        if (size > maxChars) {
          socket.destroy();
          fail(new Error(`HTTP head exceeded ${maxChars} characters.`));
        }
        return;
      }
      cleanup();
      // Exact bound on the real head length through CRLFCRLF: an oversized
      // head whose delimiter arrives in the same (or final) chunk must fail
      // closed, not slip past the early size check.
      if (headEnd + 4 > maxChars) {
        socket.destroy();
        rejectHead(new Error(`HTTP head exceeded ${maxChars} characters.`));
        return;
      }
      resolveHead({ head: joined.subarray(0, headEnd + 4), remainder: joined.subarray(headEnd + 4) });
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("Connection closed before the HTTP head completed."));
    timer = setTimeout(() => {
      socket.destroy();
      fail(new Error(`HTTP head did not arrive within ${deadlineMs}ms.`));
    }, deadlineMs);
    timer.unref?.();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/** Parse an HTTP/1.x status line; returns undefined when malformed. */
function parseStatusLine(head: Buffer): { code: number; reason: string } | undefined {
  const statusLine = head.toString("latin1").split("\r\n", 1)[0] ?? "";
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!match) return undefined;
  return { code: Number(match[1]), reason: (match[2] ?? "").slice(0, 64) };
}

/** True when the head carries `name: value` (case-insensitive, token-contained). */
function headerContains(head: Buffer, name: string, value: string): boolean {
  const lines = head.toString("latin1").split("\r\n");
  for (let index = 1; index < lines.length; index += 1) {
    const separator = lines[index]!.indexOf(":");
    if (separator === -1) continue;
    if (lines[index]!.slice(0, separator).trim().toLowerCase() !== name) continue;
    if (lines[index]!.slice(separator + 1).trim().toLowerCase().split(/\s*,\s*/).includes(value)) return true;
  }
  return false;
}

async function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeAllConnections?.();
  });
}

/**
 * Forward request headers while stripping hop-by-hop headers; duplicate names
 * (e.g. multiple Cookie headers) are preserved as arrays.
 */
function forwardRequestHeaders(request: IncomingMessage): Record<string, string | string[]> {
  return forwardRawHeaders(request.rawHeaders, HOP_BY_HOP_REQUEST_HEADERS);
}

function forwardResponseHeaders(response: IncomingMessage): Record<string, string | string[]> {
  return forwardRawHeaders(response.rawHeaders, HOP_BY_HOP_RESPONSE_HEADERS);
}

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardRawHeaders(
  rawHeaders: readonly string[],
  hopByHop: ReadonlySet<string>,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const value = rawHeaders[index + 1]!;
    if (hopByHop.has(name.toLowerCase())) continue;
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  return headers;
}

function boundedText(text: string): string {
  return text.length > MAX_OMISSION_CHARS ? `${text.slice(0, MAX_OMISSION_CHARS)}…` : text;
}