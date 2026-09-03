import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Response } from "playwright";
import { isBlockedAddress } from "./ip";
import {
  DEFAULT_EGRESS_BUDGETS,
  EgressBroker,
  type BrokerLedgerEntry,
  type EgressBudgets,
  type EgressSummary,
} from "./egress-broker";
import type { BrowserOmissions, DownloadedText, NetworkOptions, ValidatedUrl } from "./network";
import { defaultHostResolver, validatePublicUrl } from "./network";

const PASSIVE_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const LOCAL_BROWSER_PROTOCOLS = new Set(["about:", "blob:", "data:"]);
// Keep these in sync with SKIP_CHROMIUM_ENV and INSTALL_COMMAND in
// scripts/ensure-playwright-chromium.cjs; that script runs pre-build during
// postinstall and cannot import constants compiled from src.
export const PLAYWRIGHT_CHROMIUM_SKIP_ENV = "PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM";
export const PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND = "npx playwright install chromium";

/**
 * Default-deny Chromium host resolver rule: every hostname resolves to
 * NOTFOUND at the network layer before any socket can be created, with only
 * the loopback egress broker endpoint excluded so Chromium can reach the
 * proxy itself. Every destination hostname — proxied anyway — stays
 * unresolvable, so no non-proxied socket can ever resolve anything.
 */
export const CHROMIUM_DEFAULT_DENY_RESOLVER_RULES = "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1";

/** Grace period to await main-document completion after a budget abort. */
const MAIN_DOCUMENT_FINISH_GRACE_MS = 5_000;

/** Main-document navigation requests (redirect hops included) per render. */
export const MAX_MAIN_DOCUMENT_REDIRECTS = 10;

/** Minimum visible rendered text for a render with refused subresources. */
export const MIN_USEFUL_RENDER_CHARS = 40;

/** Fail-closed deadline for browser/broker teardown. */
export const CLEANUP_DEADLINE_MS = 5_000;

/**
 * Render one public page in an isolated headless Chromium process.
 *
 * Chromium is deliberately launched only for an uncached BrowserExtract URL
 * and is closed before this function returns. Indexed follow-up reads are
 * served by WebPageCache and do not launch a browser.
 *
 * Every Chromium request is forced through a per-render loopback HTTP/HTTPS
 * CONNECT egress broker (see src/web/egress-broker.ts). The broker is the only
 * network path: launch args set the proxy, remove Chromium's implicit loopback
 * bypass (`<-loopback>`), disable QUIC/Alt-Svc direct transports, and make the
 * host resolver default-deny, so no request — including speculative preconnect
 * or direct-IP attempts — can leave the browser except through the broker.
 * The broker canonicalizes every destination, resolves it exactly once,
 * requires every answer to be public, and dials only that validated address
 * set; original hostname semantics stay with the browser (Host header for
 * plain HTTP, TLS SNI and certificate checks end-to-end through the CONNECT
 * tunnel). Because Chromium cannot bypass the broker, the broker-owned
 * connection ledger (replacing Playwright's Response.serverAddr(), which would
 * only identify the local proxy) plus loopback-only binding prove where every
 * outbound socket went.
 *
 * Passive resources BrowserExtract intentionally omits (images, media, fonts)
 * are aborted by the route policy BEFORE any destination connection and never
 * taint the render, cross-host or not. Cross-host active resources and
 * redirects work through independently validated, DNS-pinned dials. Fatal
 * failures are: an unreachable/refused main document, a non-2xx navigation,
 * oversized rendered HTML, or a ledger/abort audit failure. Subresource
 * omissions (blocked passive resources, refused or budget-aborted transfers)
 * are nonfatal when the main document completed, and are disclosed as bounded
 * `browserOmissions` metadata on the result.
 */
export async function renderWithChromium(url: string, options: NetworkOptions): Promise<DownloadedText> {
  // The initial DNS validation runs under the SAME absolute render deadline
  // and external signal as everything else — a stalled resolver can never
  // hang the render outside the total-time cap.
  const renderStartedAt = Date.now();
  const requested = await validateInitialPublicUrl(url, options);
  const remainingMs = options.timeoutMs - (Date.now() - renderStartedAt);
  if (remainingMs <= 0) throw new Error(`Browser rendering timed out after ${options.timeoutMs}ms.`);
  assertChromiumAvailable();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Browser rendering timed out after ${options.timeoutMs}ms.`)),
    remainingMs,
  );
  timeout.unref?.();
  const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error("Browser rendering cancelled."));
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  // Per-render broker credentials: only this render's Chromium (which receives
  // them through Playwright's proxy option) can use the broker; other local
  // processes are challenged with 407.
  const brokerAuth = { username: "pi-review-gate", password: randomBytes(24).toString("base64url") };
  const broker = new EgressBroker(
    options.resolveHostname ?? defaultHostResolver,
    options.brokerDial,
    egressBudgetsFor(options.maxBytes, remainingMs),
    brokerAuth,
  );
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let renderViolation: Error | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const failRender = (error: Error) => {
    renderViolation ??= error;
    controller.abort(error);
  };
  try {
    const brokerPort = await broker.start();
    throwIfAborted(controller.signal);
    browser = await chromium.launch({
      headless: true,
      timeout: remainingMs,
      args: chromiumEgressArgs(brokerPort),
      proxy: { server: `http://127.0.0.1:${brokerPort}`, username: brokerAuth.username, password: brokerAuth.password },
    });
    throwIfAborted(controller.signal);
    context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: "block",
      userAgent: options.userAgent,
    });
    context.setDefaultTimeout(remainingMs);
    context.setDefaultNavigationTimeout(remainingMs);
    // Non-passive (safety-relevant) omissions made at the route layer: active
    // requests with unsupported protocols and every WebSocket. They are part
    // of the final quiesced-state safety evaluation below.
    let activeRouteOmissions = 0;
    await context.routeWebSocket("**/*", (socket) => {
      activeRouteOmissions += 1;
      broker.note(`WebSocket omitted before any destination connection: ${boundedBrowserUrl(socket.url())}`);
      socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const decision = browserRouteDecision(request.resourceType(), request.url());
      if (decision.allowed) {
        await route.continue().catch(() => undefined);
        return;
      }
      broker.note(
        decision.omittedPassive
          ? `passive resource omitted before any connection: ${request.resourceType()} ${boundedBrowserUrl(request.url())}`
          : `request aborted (${decision.omission ?? "unsupported"}): ${boundedBrowserUrl(request.url())}`,
      );
      if (!decision.omittedPassive) activeRouteOmissions += 1;
      await route.abort("blockedbyclient").catch(() => undefined);
    });

    const page = await context.newPage();
    let latestMainNavigation: Response | null = null;
    let mainDocumentFinished = false;
    let mainFrameNavigationRequests = 0;
    let activeRequestFailures = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        mainDocumentFinished = false;
        mainFrameNavigationRequests += 1;
        // Redirect chains are Chromium-internal; bound them explicitly.
        if (mainFrameNavigationRequests > MAX_MAIN_DOCUMENT_REDIRECTS) {
          failRender(new Error(`Browser navigation exceeded ${MAX_MAIN_DOCUMENT_REDIRECTS} redirect hops for ${boundedBrowserUrl(request.url())}; render aborted.`));
        }
      }
    });
    page.on("requestfinished", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) mainDocumentFinished = true;
    });
    page.on("requestfailed", (request) => {
      // Route-level passive and unsupported-protocol omissions are already
      // classified by the route handler; only requests the route ADMITTED
      // (and that failed after reaching the broker) are tracked here.
      if (!browserRouteDecision(request.resourceType(), request.url()).allowed) return;
      const failure = request.failure()?.errorText ?? "unknown network failure";
      broker.note(`active request failed after admission: ${boundedBrowserUrl(request.url())} (${failure})`);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        // A main-frame request superseded by a newer navigation (a script
        // redirect while the first document still streams) fails with
        // net::ERR_ABORTED; the replacement navigation resets and re-arms
        // mainDocumentFinished, which the pre-teardown and post-quiescence
        // checks enforce fail-closed. Every other main-frame failure is fatal.
        if (failure !== "net::ERR_ABORTED") {
          failRender(new Error(`Browser main-document navigation failed for ${boundedBrowserUrl(request.url())}: ${failure}`));
        }
        return;
      }
      activeRequestFailures += 1;
    });
    page.on("response", (candidate) => {
      if (candidate.request().isNavigationRequest() && candidate.frame() === page.mainFrame()) {
        latestMainNavigation = candidate;
      }
    });
    page.on("dialog", (dialog) => void dialog.dismiss());
    page.on("download", (download) => void download.cancel());
    let response: Response | null = null;
    try {
      response = await abortable(
        page.goto(requested.href, { waitUntil: "domcontentloaded", timeout: remainingMs }),
        controller.signal,
      );
    } catch (error) {
      if (renderViolation) throw renderViolation;
      throw error;
    }
    if (renderViolation) throw renderViolation;
    await abortable(
      page.waitForLoadState("networkidle", { timeout: Math.min(5_000, Math.max(1_000, Math.floor(remainingMs / 4))) })
        .catch(() => undefined),
      controller.signal,
    );
    const finalUrl = browserFinalUrl(page.url());
    const finalResponse = latestMainNavigation ?? response;
    assertSuccessfulBrowserNavigation(finalResponse?.status(), finalResponse?.url() ?? finalUrl);
    const text = await abortable(page.content(), controller.signal);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > options.maxBytes) {
      throw new Error(`Rendered page produced ${bytes} HTML bytes; limit is ${options.maxBytes}.`);
    }

    // Safety guard while the context is still open (completion events can
    // still arrive): the main document must have completed before the result
    // is honored — a budget that destroyed an in-flight transfer, or a
    // main-document body that never finished, both mean a possibly truncated
    // render, which fails closed.
    if (!mainDocumentFinished) {
      await waitForMainDocument(() => mainDocumentFinished, controller.signal);
      if (!mainDocumentFinished) {
        throw new Error(
          `Browser main-document navigation did not complete before teardown `
          + `(${broker.summary().budgetAborts} in-flight transfer(s) destroyed at a resource budget); `
          + `refusing a possibly truncated render.`,
        );
      }
    }

    // Quiesce browser networking, then the broker, BEFORE the result is
    // honored: close the context so no new requests can start, close the
    // broker (destroying every outbound socket and awaiting listener close
    // within the cleanup deadline), then audit the connection ledger and
    // evaluate the FINAL quiesced state for safety-related omissions.
    const finishedContext = context;
    const summary = await finalizeBrowserRender(
      async () => {
        await finishedContext.close();
        context = undefined;
      },
      broker,
      controller.signal,
    );
    auditEgressLedger(summary.ledger);
    if (renderViolation) throw renderViolation;
    if (!mainDocumentFinished) {
      throw new Error("Browser main-document navigation did not complete before final network quiescence; refusing a possibly truncated render.");
    }
    const incompleteTransfers = summary.ledger
      .filter((entry) => !entry.completed)
      .map((entry) => `incomplete transfer to ${entry.hostname}:${entry.port} (${entry.bytesSent} sent, ${entry.bytesReceived} received bytes)`);
    // Fatal omission classes: destination-truncated and budget-aborted
    // transfers. In-flight subresources at teardown are classified by the
    // broker as client-driven cancels (context.close() followed by
    // broker.close() closes Chromium's side first) and never appear here —
    // the main document is guarded separately by mainDocumentFinished.
    // Nonfatal only when useful text remains.
    const safetyRelatedOmission =
      activeRouteOmissions > 0
      || activeRequestFailures > 0
      || summary.refusals > 0
      || summary.budgetAborts > 0
      || incompleteTransfers.length > 0;
    if (safetyRelatedOmission && !hasUsefulRenderedContent(text)) {
      throw new Error(
        `Browser render omitted a required active resource `
        + `(${activeRouteOmissions} route-level, ${activeRequestFailures} active-request failures, `
        + `${summary.refusals} refused, ${summary.budgetAborts} budget-aborted, ${incompleteTransfers.length} incomplete) `
        + `and the remaining rendered content carries no useful text; refusing the unusable result.`,
      );
    }
    const browserOmissions = boundedOmissions(summary, incompleteTransfers);
    return {
      requestedUrl: requested.href,
      finalUrl,
      contentType: finalResponse?.headers()["content-type"] ?? "text/html; charset=utf-8",
      text,
      bytes,
      fetchedAt: new Date().toISOString(),
      ...(browserOmissions ? { browserOmissions } : {}),
    };
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
    // Fail-closed, deadline-bounded cleanup: browser and broker shutdown are
    // attempted together and can never hang the render past the deadline.
    const cleanup = await Promise.allSettled([
      boundedTeardown(
        browser ? browser.close() : context ? context.close() : Promise.resolve(),
        CLEANUP_DEADLINE_MS,
        "browser shutdown",
      ),
      boundedTeardown(broker.close(), CLEANUP_DEADLINE_MS, "egress broker shutdown"),
    ]);
    const failures = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    // Never mask the render's own failure with a cleanup error; when the body
    // succeeded, a cleanup failure fails the render closed. Cleanup failures
    // during a failed render are attached to the rethrown error's cause so a
    // hung teardown stays visible.
    if (failures.length > 0) {
      if (!bodyFailure) {
        if (failures.length === 1) throw failures[0]!;
        throw new AggregateError(failures, "Browser render cleanup failed.");
      }
      const original = bodyFailure.error;
      if (original instanceof Error) {
        const existing = original as { cause?: unknown };
        if (!existing.cause) {
          existing.cause = failures.length === 1 ? failures[0] : failures.map((failure) => failure);
        }
      }
    }
  }
}

/**
 * Initial URL validation bounded by the absolute render deadline and the
 * external abort signal, so a stalled or hostile resolver can never hang
 * BrowserExtract outside the total-time cap.
 */
async function validateInitialPublicUrl(url: string, options: NetworkOptions): Promise<ValidatedUrl> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Browser rendering timed out after ${options.timeoutMs}ms.`)),
    options.timeoutMs,
  );
  timeout.unref?.();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Browser rendering cancelled."));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await abortable(validatePublicUrl(url, options.resolveHostname), controller.signal);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function assertChromiumAvailable(
  executablePath: string = chromium.executablePath(),
  exists: (path: string) => boolean = existsSync,
): void {
  if (!exists(executablePath)) throw missingChromiumError(executablePath);
}

export function missingChromiumError(executablePath: string = chromium.executablePath()): Error {
  return new Error(
    `Playwright Chromium is not installed${executablePath ? ` at ${executablePath}` : ""}, so BrowserExtract cannot run. `
    + `Install it with \`${PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND}\` and retry. `
    + `If ${PLAYWRIGHT_CHROMIUM_SKIP_ENV} was set during installation, unset ${PLAYWRIGHT_CHROMIUM_SKIP_ENV} before reinstalling or run the install command manually.`,
  );
}

export function assertSuccessfulBrowserNavigation(status: number | undefined, url: string): void {
  if (status === undefined) throw new Error(`Browser navigation returned no HTTP response for ${boundedBrowserUrl(url)}.`);
  if (status < 200 || status >= 300) throw new Error(`Browser navigation returned HTTP ${status} for ${boundedBrowserUrl(url)}.`);
}

/**
 * Chromium launch arguments that make the loopback egress broker the browser's
 * only network path. `<-loopback>` removes Chromium's implicit loopback bypass
 * so even loopback/private literal requests must pass the broker (and are
 * refused there); QUIC and other direct transports are disabled; and the host
 * resolver is default-deny so no non-proxied socket can resolve anything.
 */
export function chromiumEgressArgs(brokerPort: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${brokerPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    // WebRTC would otherwise open direct UDP (ICE/STUN) to IP literals,
    // bypassing both the CONNECT broker and the resolver rules; non-proxied
    // UDP is disabled so peer connections can only use the proxied path.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--host-resolver-rules=${CHROMIUM_DEFAULT_DENY_RESOLVER_RULES}`,
  ];
}

/** Explicit per-render egress budgets, scaled from the download byte cap. */
export function egressBudgetsFor(maxBytes: number, timeoutMs: number): EgressBudgets {
  return {
    ...DEFAULT_EGRESS_BUDGETS,
    maxConnectionBytes: Math.max(maxBytes * 2, DEFAULT_EGRESS_BUDGETS.maxConnectionBytes),
    maxTotalBytes: Math.max(maxBytes * 8, DEFAULT_EGRESS_BUDGETS.maxTotalBytes),
    // The broker's own total-time budget equals the render's timeout, so it
    // can never outlive the render window.
    maxTotalMs: timeoutMs,
  };
}

/**
 * Close browser networking, then close the broker (destroying all outbound
 * sockets and awaiting the listener shutdown) so browser plus sockets quiesce
 * before the caller inspects the result, and re-check the abort signal. Both
 * teardown steps are bounded by a fail-closed cleanup deadline.
 */
export async function finalizeBrowserRender(
  closeNetwork: () => Promise<void>,
  broker: Pick<EgressBroker, "close">,
  signal?: AbortSignal,
  cleanupDeadlineMs: number = CLEANUP_DEADLINE_MS,
): Promise<EgressSummary> {
  // The broker is ALWAYS shut down, even when browser-network closure fails
  // or times out; both failures are aggregated rather than masking each other.
  let networkFailure: unknown;
  try {
    await boundedTeardown(closeNetwork(), cleanupDeadlineMs, "browser network close");
  } catch (error) {
    networkFailure = error;
  }
  let summary: EgressSummary;
  try {
    summary = await boundedTeardown(broker.close(), cleanupDeadlineMs, "egress broker shutdown");
  } catch (error) {
    if (networkFailure) throw new AggregateError([networkFailure, error], "Browser render cleanup failed.");
    throw error;
  }
  if (networkFailure) throw networkFailure;
  if (signal) throwIfAborted(signal);
  return summary;
}

/** Reject when teardown does not settle within the cleanup deadline. */
async function boundedTeardown<T>(operation: Promise<T>, deadlineMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Browser render cleanup deadline (${deadlineMs}ms) exceeded during ${what}.`)), deadlineMs);
    timer.unref?.();
  });
  deadline.catch(() => undefined);
  operation.catch(() => undefined);
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Final broker-owned audit replacing per-response serverAddr verification:
 * every ledger entry must name a non-empty validated destination with a public
 * address. Anything else fails the render closed.
 */
export function auditEgressLedger(ledger: readonly BrokerLedgerEntry[]): void {
  for (const entry of ledger) {
    if (!entry.hostname || !entry.address) {
      throw new Error("Browser egress ledger recorded a connection without a validated destination; render aborted.");
    }
    if (isBlockedAddress(entry.address)) {
      throw new Error(
        `Browser egress ledger recorded a connection to non-public address ${entry.address} (${entry.hostname}); render aborted.`,
      );
    }
  }
}

/**
 * Bounded omission metadata for the render result: retained diagnostics plus
 * any dropped beyond the cap, and (for the final quiesced state) one bounded
 * entry per incomplete broker connection.
 */
export function boundedOmissions(summary: EgressSummary, extra?: readonly string[]): BrowserOmissions | undefined {
  const total = summary.omissions.length + summary.omissionsDropped + (extra?.length ?? 0);
  if (total === 0) return undefined;
  const entries = [...summary.omissions, ...(extra ?? [])].slice(0, 32);
  return {
    count: total,
    truncated: summary.omissionsDropped > 0 || entries.length < total,
    entries,
  };
}

/**
 * Bounded usefulness check for renders whose active subresources were refused
 * or budget-aborted: the result is nonfatal only when meaningful rendered text
 * remains (script/style bodies stripped, tags removed).
 */
export function hasUsefulRenderedContent(html: string): boolean {
  const visible = html
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return visible.length >= MIN_USEFUL_RENDER_CHARS;
}

/**
 * Pure route policy for one browser request. Local browser protocols are
 * narrowly allowed; passive resources (images/media/fonts) are aborted before
 * any connection as intentional omissions that never taint the render; HTTP(S)
 * to any hostname is allowed through the broker (which validates and pins each
 * destination); everything else is aborted as a bounded omission.
 */
export function browserRouteDecision(resourceType: string, requestUrl: string): { allowed: boolean; omittedPassive?: boolean; omission?: string } {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return { allowed: false, omission: "unparseable request URL" };
  }
  if (LOCAL_BROWSER_PROTOCOLS.has(parsed.protocol)) return { allowed: true };
  if (PASSIVE_RESOURCE_TYPES.has(resourceType)) return { allowed: false, omittedPassive: true };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, omission: `unsupported protocol ${parsed.protocol}` };
  }
  return { allowed: true };
}

const MAX_BROWSER_URL_DIAGNOSTIC_CHARS = 500;

function boundedBrowserUrl(url: string): string {
  if (url.length <= MAX_BROWSER_URL_DIAGNOSTIC_CHARS) return url;
  const marker = "… (truncated)";
  return `${url.slice(0, MAX_BROWSER_URL_DIAGNOSTIC_CHARS - marker.length)}${marker}`;
}

export function browserFinalUrl(pageUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error(`Browser ended at an invalid URL: ${boundedBrowserUrl(pageUrl)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && !LOCAL_BROWSER_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Browser ended at an unsupported URL: ${boundedBrowserUrl(pageUrl)}`);
  }
  parsed.hash = "";
  return parsed.href;
}

/**
 * Bounded wait for main-document completion. The grace period observes the
 * render abort signal so it can never extend past the absolute render
 * deadline; each polling delay is abortable.
 */
export async function waitForMainDocument(mainDocumentFinished: () => boolean, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + MAIN_DOCUMENT_FINISH_GRACE_MS;
  while (!mainDocumentFinished()) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) return;
    await abortable(
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 25);
        timer.unref?.();
      }),
      signal,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Browser rendering cancelled.");
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Browser rendering cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
