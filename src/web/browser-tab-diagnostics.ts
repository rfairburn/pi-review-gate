/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for per-tab diagnostic recording — the writers of the console and
 * network rings (#153 moved the ring/quota data structures themselves and
 * stay authoritative for capacity policy). Every record is bounded,
 * privacy-redacted through the shared output-privacy text filter supplied by
 * the manager, attributed by the session's creation clock, and skipped once
 * a tab stops diagnosing or its session has begun teardown. Recording never
 * captures untrusted content beyond the bounded fields it defines here.
 */
import type { ConsoleMessage, Page, Request, Response } from "playwright";
import {
  DiagnosticRing,
  boundedHttpStatus,
  boundedNonnegativeInteger,
  boundedUntrustedText,
  consoleLevel,
  diagnosticElapsed,
  diagnosticMethod,
  diagnosticNetworkFailure,
  diagnosticOrigin,
  diagnosticResourceKind,
} from "./browser-diagnostics.js";
import { safely } from "./browser-primitives.js";

export interface BrowserConsoleEvent {
  sequence: number;
  elapsedMs: number;
  kind: "console" | "page_error";
  level: "debug" | "info" | "log" | "warning" | "error" | "other";
  text: string;
  textTruncated: boolean;
  source: { origin: string; line: number; column: number } | null;
  errorName?: string;
}

export interface BrowserNetworkEvent {
  sequence: number;
  elapsedMs: number;
  phase: "request" | "response" | "failure" | "policy";
  method: string;
  origin: string;
  resourceKind: string;
  status?: number;
  durationMs?: number;
  outcome: "observed" | "succeeded" | "failed" | "policy_blocked";
  failure?: string;
  /**
   * WebSocket lifecycle marker, present only for websocket-kind records.
   * Truthful by construction: "created" is the observed route admission,
   * "closed" is the terminal state reported by the browser's own WebSocket
   * stack (or the manager-issued refusal close). No connected state is ever
   * claimed; a working connection is proven by page/app state. Frame content
   * is never retained.
   */
  wsState?: "created" | "closed";
  /** Close code as exposed by the browser's WebSocket stack, when present. */
  closeCode?: number;
}

/** Timing view of the owning session used to attribute diagnostic events. */
export interface TabDiagnosticsSessionView {
  createdAt: number;
  /** Present once teardown began; recording stops so late events do not resurrect. */
  teardown?: PromiseLike<unknown> | undefined;
}

/** The delegated diagnostic substate of one tab (the same rings the manager consults). */
export interface TabDiagnosticsTabView {
  diagnosticsActive: boolean;
  consoleDiagnostics: DiagnosticRing<BrowserConsoleEvent>;
  networkDiagnostics: DiagnosticRing<BrowserNetworkEvent>;
  networkStartedAt: WeakMap<Request, number>;
  networkPolicy: WeakMap<Request, string>;
}

export interface TabDiagnosticRecorderDeps {
  now(): number;
  /** Output-privacy redaction over raw untrusted text before it is retained. */
  text(value: string): string;
  /** Live console bound read at record time. */
  limits(): { maxConsoleTextChars: number; maxConsoleSourceChars: number };
}

export interface TabDiagnosticRecorder {
  consoleMessage(
    session: TabDiagnosticsSessionView,
    tab: TabDiagnosticsTabView,
    message: ConsoleMessage,
  ): void;
  pageError(session: TabDiagnosticsSessionView, tab: TabDiagnosticsTabView, error: Error): void;
  networkRequest(session: TabDiagnosticsSessionView, tab: TabDiagnosticsTabView, request: Request): void;
  networkResponse(session: TabDiagnosticsSessionView, tab: TabDiagnosticsTabView, response: Response): void;
  networkFailure(session: TabDiagnosticsSessionView, tab: TabDiagnosticsTabView, request: Request): void;
  /** Attribute and record a route-policy block for the request's owning tab. */
  policyBlocked(
    session: TabDiagnosticsSessionView,
    tabFor: (page: Page) => TabDiagnosticsTabView | undefined,
    request: Request,
    reason: string,
  ): void;
  /** Bounded per-tab WebSocket lifecycle metadata; never frame content. */
  websocket(
    session: TabDiagnosticsSessionView,
    tab: TabDiagnosticsTabView,
    event: Omit<BrowserNetworkEvent, "sequence" | "elapsedMs">,
  ): void;
  clear(tab: TabDiagnosticsTabView): void;
}

export function createTabDiagnosticRecorder(deps: TabDiagnosticRecorderDeps): TabDiagnosticRecorder {
  return {
    consoleMessage(session, tab, message): void {
      if (!tab.diagnosticsActive || session.teardown) return;
      let rawText = "[console message unavailable]";
      let rawType = "other";
      let location: { url?: string; lineNumber?: number; columnNumber?: number } = {};
      try { rawText = message.text(); } catch { /* fixed fallback */ }
      try { rawType = message.type(); } catch { /* fixed fallback */ }
      try { location = message.location(); } catch { /* fixed fallback */ }
      const text = boundedUntrustedText(deps.text(rawText), deps.limits().maxConsoleTextChars);
      tab.consoleDiagnostics.push({
        elapsedMs: diagnosticElapsed(deps.now(), session.createdAt),
        kind: "console",
        level: consoleLevel(rawType),
        text: text.value,
        textTruncated: text.truncated,
        source: location.url ? {
          origin: diagnosticOrigin(location.url, deps.limits().maxConsoleSourceChars),
          line: boundedNonnegativeInteger(location.lineNumber),
          column: boundedNonnegativeInteger(location.columnNumber),
        } : null,
      });
    },
    pageError(session, tab, error): void {
      if (!tab.diagnosticsActive || session.teardown) return;
      const text = boundedUntrustedText(deps.text(error?.message || "Uncaught page error"), deps.limits().maxConsoleTextChars);
      const errorName = boundedUntrustedText(deps.text(error?.name || "Error"), 64);
      tab.consoleDiagnostics.push({
        elapsedMs: diagnosticElapsed(deps.now(), session.createdAt),
        kind: "page_error",
        level: "error",
        text: text.value,
        textTruncated: text.truncated || errorName.truncated,
        source: null,
        errorName: errorName.value,
      });
    },
    networkRequest(session, tab, request): void {
      if (!tab.diagnosticsActive || session.teardown) return;
      const elapsedMs = diagnosticElapsed(deps.now(), session.createdAt);
      tab.networkStartedAt.set(request, elapsedMs);
      tab.networkDiagnostics.push({
        elapsedMs,
        phase: "request",
        method: diagnosticMethod(safely(() => request.method(), "OTHER")),
        origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
        resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
        outcome: "observed",
      });
    },
    networkResponse(session, tab, response): void {
      if (!tab.diagnosticsActive || session.teardown) return;
      const request = response.request();
      const elapsedMs = diagnosticElapsed(deps.now(), session.createdAt);
      const started = tab.networkStartedAt.get(request);
      tab.networkDiagnostics.push({
        elapsedMs,
        phase: "response",
        method: diagnosticMethod(safely(() => request.method(), "OTHER")),
        origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
        resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
        status: boundedHttpStatus(safely(() => response.status(), 0)),
        ...(started === undefined ? {} : { durationMs: Math.max(0, elapsedMs - started) }),
        outcome: "succeeded",
      });
    },
    networkFailure(session, tab, request): void {
      if (!tab.diagnosticsActive || session.teardown) return;
      const elapsedMs = diagnosticElapsed(deps.now(), session.createdAt);
      const started = tab.networkStartedAt.get(request);
      const policy = tab.networkPolicy.get(request);
      const rawFailure = safely(() => request.failure()?.errorText, "request failed") ?? "request failed";
      const failure = policy ?? diagnosticNetworkFailure(rawFailure);
      tab.networkDiagnostics.push({
        elapsedMs,
        phase: "failure",
        method: diagnosticMethod(safely(() => request.method(), "OTHER")),
        origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
        resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
        ...(started === undefined ? {} : { durationMs: Math.max(0, elapsedMs - started) }),
        outcome: policy ? "policy_blocked" : "failed",
        failure,
      });
    },
    policyBlocked(session, tabFor, request, reason): void {
      const tab = safely(() => tabFor(request.frame().page()), undefined);
      if (!tab || !tab.diagnosticsActive || session.teardown) return;
      tab.networkPolicy.set(request, reason);
      const elapsedMs = diagnosticElapsed(deps.now(), session.createdAt);
      tab.networkDiagnostics.push({
        elapsedMs,
        phase: "policy",
        method: diagnosticMethod(safely(() => request.method(), "OTHER")),
        origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
        resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
        outcome: "policy_blocked",
        failure: boundedUntrustedText(reason, 160).value,
      });
    },
    websocket(session, tab, event): void {
      if (!tab.diagnosticsActive || session.teardown) return;
      tab.networkDiagnostics.push({
        elapsedMs: diagnosticElapsed(deps.now(), session.createdAt),
        ...event,
      });
    },
    clear(tab): void {
      tab.diagnosticsActive = false;
      tab.consoleDiagnostics.clear();
      tab.networkDiagnostics.clear();
      tab.networkStartedAt = new WeakMap<Request, number>();
      tab.networkPolicy = new WeakMap<Request, string>();
    },
  };
}