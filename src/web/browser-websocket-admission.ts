/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for live page-created WebSocket admission. Every ws/wss route created
 * by a page is validated against the same public-URL policy as ordinary
 * navigation before Chromium's native stack is allowed to connect through
 * the session broker, under the pre-DNS concurrent-admission cap and a hard
 * admission deadline. The module is admission and terminal metadata only:
 * frames relay transparently in Playwright's passthrough and never enter
 * manager memory. The manager owns the delegated per-session admission set
 * and passes the live local-network policy so a settings change applies to
 * subsequent admissions without a restart.
 */
import type { Request } from "playwright";
import type { WebSocketRoute } from "playwright";
import { boundedWsCloseCode, boundedWsCloseReason, diagnosticElapsed, diagnosticWsOrigin } from "./browser-diagnostics.js";
import type { DiagnosticRing } from "./browser-diagnostics.js";
import { validatePublicUrl, type HostResolver } from "./network.js";
import type { TabDiagnosticRecorder, BrowserConsoleEvent, BrowserNetworkEvent } from "./browser-tab-diagnostics.js";

/** Manager-side admission bounds for page-created ws/wss routes, checked
 * before Chromium's native stack is allowed to connect through the session
 * broker. The broker independently re-validates and pins every destination. */
const WS_MAX_URL_CHARS = 2_048;
const WS_MAX_PROTOCOLS = 8;
const WS_PROTOCOL_MAX_CHARS = 128;
/** Per-session cap on concurrent in-flight WebSocket admissions (pre-DNS). */
const WS_MAX_PENDING_ADMISSIONS = 8;
/** Hard deadline for one admission's destination validation. */
const WS_ADMISSION_MS = 5_000;

export interface WebSocketAdmissionDeps {
  now(): number;
  resolveHostname: HostResolver;
  /** Live effective local-network permission; re-read per admission. */
  allowLocalNetworks(): boolean;
  /** The tab diagnostic recorder owns the bounded ring write. */
  recorder: Pick<TabDiagnosticRecorder, "websocket">;
}

/** Delegated admission substate of the owning session (the same objects the manager drains). */
export interface WebSocketAdmissionSessionView {
  createdAt: number;
  /** Present once teardown began; no admission may connect after it. */
  teardown?: PromiseLike<unknown> | undefined;
  /** In-flight page-initiated WebSocket admissions; settled on teardown. */
  pendingWebSocketAdmissions: Set<Promise<void>>;
  /** Aborted when teardown begins so pending admissions stop waiting at once. */
  admissionAbort: AbortController;
}

/** Delegated substate of the tab whose page created the route. */
export interface WebSocketAdmissionTabView {
  diagnosticsActive: boolean;
  consoleDiagnostics: DiagnosticRing<BrowserConsoleEvent>;
  networkDiagnostics: DiagnosticRing<BrowserNetworkEvent>;
  networkStartedAt: WeakMap<Request, number>;
  networkPolicy: WeakMap<Request, string>;
  closing: boolean;
}

/** Synchronous admission checks for one page-created WebSocket URL. */
function validateLiveWebSocket(
  rawUrl: string,
  protocols: readonly string[],
): { allowed: true; url: URL; protocols: string[] } | { allowed: false; reason: string } {
  if (rawUrl.length === 0 || rawUrl.length > WS_MAX_URL_CHARS) return { allowed: false, reason: "websocket URL exceeds bound" };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { allowed: false, reason: "websocket URL is malformed" }; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return { allowed: false, reason: "websocket protocol not allowed" };
  if (url.username !== "" || url.password !== "") return { allowed: false, reason: "websocket credentials not allowed" };
  if (!url.hostname) return { allowed: false, reason: "websocket URL is malformed" };
  if (protocols.length > WS_MAX_PROTOCOLS) return { allowed: false, reason: "websocket subprotocol not allowed" };
  const cleanProtocols: string[] = [];
  for (const protocol of protocols) {
    // RFC 6455 token characters only; anything else is refused fail-closed.
    if (typeof protocol !== "string" || protocol.length === 0 || protocol.length > WS_PROTOCOL_MAX_CHARS
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(protocol)) {
      return { allowed: false, reason: "websocket subprotocol not allowed" };
    }
    cleanProtocols.push(protocol);
  }
  return { allowed: true, url, protocols: cleanProtocols };
}

/**
 * One page-created WebSocket. This module's role is admission and metadata,
 * never protocol: validate the requested ws/wss destination against the
 * same public-URL policy as ordinary navigation, then hand the socket to
 * Chromium's native stack via connectToServer(). Frames relay transparently
 * between page and origin (Playwright passthrough) and never enter manager
 * memory. The terminal state is observed from the browser's own close
 * event; no connected state is ever claimed, and a working connection is
 * proven by page/app state, not by this metadata.
 */
export async function handleLiveWebSocket(
    session: WebSocketAdmissionSessionView,
    tab: WebSocketAdmissionTabView,
    route: WebSocketRoute,
    deps: WebSocketAdmissionDeps,
  ): Promise<void> {
  const createdAtMs = deps.now();
    let rawUrl = "";
    try { rawUrl = route.url(); } catch { /* fixed fallback */ }
    const origin = diagnosticWsOrigin(rawUrl);
    deps.recorder.websocket(session, tab, {
      phase: "request",
      method: "GET",
      origin,
      resourceKind: "websocket",
      wsState: "created",
      outcome: "observed",
    });
    let requestedProtocols: readonly string[] = [];
    try { requestedProtocols = route.protocols(); } catch { /* fixed fallback */ }
    const decision = validateLiveWebSocket(rawUrl, requestedProtocols);
    if (!decision.allowed) {
      await refuseLiveWebSocket(session, tab, route, origin, createdAtMs, decision.reason, true, deps);
      return;
    }
    // Bounded admission: excess concurrent requests are refused before any
    // DNS resolution, and every in-flight validation is tracked so teardown
    // can settle it. No unbounded validator fan-out survives the session.
    if (session.pendingWebSocketAdmissions.size >= WS_MAX_PENDING_ADMISSIONS) {
      await refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "websocket admission limit exceeded", true, deps);
      return;
    }
    let admission!: Promise<void>;
    admission = (async () => {
      const verdict = await validateWebSocketDestination(deps, decision.url, session.admissionAbort.signal);
      // Teardown or tab closure during validation: contain without connecting.
      if (session.teardown || tab.closing) return;
      if (verdict === "refused") {
        await refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "websocket destination failed public validation", true, deps);
        return;
      }
      if (verdict === "timed_out") {
        await refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "websocket admission timed out", false, deps);
        return;
      }
      let server: WebSocketRoute;
      try {
        // Rechecked immediately before the native connect: a session that
        // began tearing down during validation never reaches this point.
        if (session.teardown || tab.closing) return;
        // Native browser networking from here on: the in-page socket connects
        // through the context proxy (authenticated) to the broker-pinned origin.
        server = route.connectToServer();
      } catch {
        if (!session.teardown && !tab.closing) {
          await refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "browser websocket connect failed", false, deps);
        }
        return;
      }
      let terminalRecorded = false;
      server.onClose((code, reason) => {
        if (terminalRecorded) return;
        terminalRecorded = true;
        const closeCode = boundedWsCloseCode(code);
        // Without a clean/abnormal flag from the API, only codes that attest
        // normal closure are recorded as success; everything else is failure.
        const normal = closeCode === 1000 || (closeCode !== undefined && closeCode >= 3000 && closeCode <= 4999);
        deps.recorder.websocket(session, tab, {
          phase: normal ? "response" : "failure",
          method: "GET",
          origin,
          resourceKind: "websocket",
          wsState: "closed",
          ...(closeCode === undefined ? {} : { closeCode }),
          durationMs: diagnosticElapsed(deps.now(), createdAtMs),
          outcome: normal ? "succeeded" : "failed",
          ...(normal ? {} : { failure: "ws_closed_abnormal" }),
        });
        // Relay the terminal to the page side exactly as passthrough would.
        void route.close({ code: closeCode, reason: boundedWsCloseReason(reason) }).catch(() => undefined);
      });
    })().finally(() => { session.pendingWebSocketAdmissions.delete(admission); });
    session.pendingWebSocketAdmissions.add(admission);
    // Playwright synthesizes an open event when a route handler completes
    // without connecting. Keep it pending until admission connects or closes
    // the route; otherwise DNS-pending sockets would falsely appear open.
    await admission;
  }


async function refuseLiveWebSocket(
    session: WebSocketAdmissionSessionView,
    tab: WebSocketAdmissionTabView,
    route: WebSocketRoute,
    origin: string,
    createdAtMs: number,
    token: string,
    policy: boolean,
    deps: WebSocketAdmissionDeps,
  ): Promise<void> {
    // 1008 = policy violation, 1006 = abnormal failure; the page observes
    // exactly the code issued here.
    const closeCode = policy ? 1008 : 1006;
    deps.recorder.websocket(session, tab, {
      phase: policy ? "policy" : "failure",
      method: "GET",
      origin,
      resourceKind: "websocket",
      wsState: "closed",
      closeCode,
      durationMs: diagnosticElapsed(deps.now(), createdAtMs),
      outcome: policy ? "policy_blocked" : "failed",
      failure: token,
    });
    await route.close({ code: closeCode }).catch(() => undefined);
  }

/**
 * Map the ws/wss authority onto the existing http/https validator:
 * the hostname is resolved exactly once and every address must be admitted
 by the CURRENT effective policy (public-only by default; local-network
 * destinations only under localNetworks/YOLO).
 * Bounded by a hard deadline and cancelable by session teardown, so no
 * admission can wait unboundedly or act after the session is gone.
 */
async function validateWebSocketDestination(
  deps: WebSocketAdmissionDeps,
  url: URL,
  signal: AbortSignal,
): Promise<"public" | "refused" | "timed_out"> {
    const mapped = new URL(`${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/`);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        validatePublicUrl(mapped.href, deps.resolveHostname, { allowLocalNetworks: deps.allowLocalNetworks() }).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error("websocket admission deadline")); }, WS_ADMISSION_MS);
        }),
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error("session teardown")); return; }
          onAbort = () => reject(new Error("session teardown"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      return "public";
    } catch {
      return timedOut ? "timed_out" : "refused";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
