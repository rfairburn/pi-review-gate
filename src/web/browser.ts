import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Response } from "playwright";
import { isBlockedAddress, parseIp } from "./ip";
import type { DownloadedText, NetworkOptions } from "./network";
import { validatePublicUrl, type ValidatedUrl } from "./network";

const PASSIVE_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const LOCAL_BROWSER_PROTOCOLS = new Set(["about:", "blob:", "data:"]);
// Keep these in sync with SKIP_CHROMIUM_ENV and INSTALL_COMMAND in
// scripts/ensure-playwright-chromium.cjs; that script runs pre-build during
// postinstall and cannot import constants compiled from src.
export const PLAYWRIGHT_CHROMIUM_SKIP_ENV = "PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM";
export const PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND = "npx playwright install chromium";

/**
 * Render one public page in an isolated headless Chromium process.
 *
 * Chromium is deliberately launched only for an uncached BrowserExtract URL
 * and is closed before this function returns. Indexed follow-up reads are
 * served by WebPageCache and do not launch a browser.
 *
 * DNS pinning has two layers. Primary: the initially validated hostname is
 * mapped to one validated public address with Chromium host-resolver rules and
 * browser proxying is disabled (`--no-proxy-server`), so neither Chromium nor
 * a proxy can perform a second DNS lookup for the admitted hostname; the
 * render enforces a hostname-based route policy (the MAP rule pins that
 * hostname for every scheme and port). Verification: every HTTP(S) response's actual remote
 * address is read via Playwright's `Response.serverAddr()` and must match the
 * pinned validated address; blocked or mismatched peers, or a missing server
 * address, abort the whole render immediately. Any HTTP(S) request or
 * navigation to a different hostname — which the MAP rule does not pin — fails
 * the whole render closed with actionable compatibility text (extract the
 * final URL directly instead).
 */
export async function renderWithChromium(url: string, options: NetworkOptions): Promise<DownloadedText> {
  const requested = await validatePublicUrl(url, options.resolveHostname);
  assertChromiumAvailable();
  const pinnedHostname = requested.hostname;
  const pinnedAddress = preferredPinnedAddress(requested.addresses);
  if (!pinnedAddress) throw new Error(`No validated public address is available for ${pinnedHostname}.`);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Browser rendering timed out after ${options.timeoutMs}ms.`)),
    options.timeoutMs,
  );
  timeout.unref?.();
  const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error("Browser rendering cancelled."));
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let blockedRequest: string | undefined;
  let renderViolation: Error | undefined;
  const failRender = (error: Error) => {
    renderViolation ??= error;
    controller.abort(error);
  };
  const pendingServerAddressChecks: Promise<void>[] = [];
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: options.timeoutMs,
      args: chromiumDnsPinningArgs(requested, pinnedAddress),
    });
    throwIfAborted(controller.signal);
    context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: "block",
      userAgent: options.userAgent,
    });
    context.setDefaultTimeout(options.timeoutMs);
    context.setDefaultNavigationTimeout(options.timeoutMs);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const decision = browserRouteDecision(request.resourceType(), request.url(), pinnedHostname);
      if (decision.allowed) {
        await route.continue().catch(() => undefined);
        return;
      }
      if (decision.crossOriginBlock) {
        blockedRequest ??= decision.crossOriginBlock;
        failRender(new Error(crossOriginBlockedMessage(decision.crossOriginBlock)));
      }
      await route.abort("blockedbyclient").catch(() => undefined);
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    // Verify actual response remote addresses where Playwright exposes them:
    // a response from a blocked or non-pinned peer aborts the render.
    const checkServerAddress = (candidate: Response): Promise<void> => {
      const check = candidate
        .serverAddr()
        .then((serverAddr) => assertPinnedServerAddress(candidate.url(), serverAddr, pinnedAddress))
        .catch((error: unknown) => {
          failRender(error instanceof Error ? error : new Error(String(error)));
        });
      pendingServerAddressChecks.push(check);
      return check;
    };
    context.on("response", (candidate) => {
      void checkServerAddress(candidate).catch(() => undefined);
    });

    const page = await context.newPage();
    let latestMainNavigation: Response | null = null;
    page.on("response", (candidate) => {
      if (candidate.request().isNavigationRequest() && candidate.frame() === page.mainFrame()) {
        latestMainNavigation = candidate;
      }
    });
    page.on("dialog", (dialog) => void dialog.dismiss());
    page.on("download", (download) => void download.cancel());
    let response: Response | null;
    try {
      response = await abortable(
        page.goto(requested.href, { waitUntil: "domcontentloaded", timeout: options.timeoutMs }),
        controller.signal,
      );
    } catch (error) {
      // A cross-origin navigation is rejected by Chromium itself before the
      // goto promise settles; surface the actionable compatibility message.
      if (blockedRequest) throw new Error(crossOriginBlockedMessage(blockedRequest), { cause: error });
      throw error;
    }
    // Fail closed for any HTTP(S) request the browser could not pin, not just
    // navigations: a blocked cross-origin subresource means the page depends on
    // an unpinned destination, so the render result is refused.
    if (blockedRequest) throw new Error(crossOriginBlockedMessage(blockedRequest));
    await abortable(
      page.waitForLoadState("networkidle", { timeout: Math.min(5_000, Math.max(1_000, Math.floor(options.timeoutMs / 4))) })
        .catch(() => undefined),
      controller.signal,
    );
    if (blockedRequest) throw new Error(crossOriginBlockedMessage(blockedRequest));
    const finalUrl = browserFinalUrl(page.url(), pinnedHostname);
    const finalResponse = latestMainNavigation ?? response;
    assertSuccessfulBrowserNavigation(finalResponse?.status(), finalResponse?.url() ?? finalUrl);
    await Promise.allSettled(pendingServerAddressChecks);
    if (renderViolation) throw renderViolation;
    const text = await abortable(page.content(), controller.signal);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > options.maxBytes) {
      throw new Error(`Rendered page produced ${bytes} HTML bytes; limit is ${options.maxBytes}.`);
    }
    const result: DownloadedText = {
      requestedUrl: requested.href,
      finalUrl,
      contentType: finalResponse?.headers()["content-type"] ?? "text/html; charset=utf-8",
      text,
      bytes,
      fetchedAt: new Date().toISOString(),
    };
    // Quiesce browser networking BEFORE the final pending-check drain: close
    // the context so no new responses can start, then await every check that
    // was appended during closure, and only then honor the render result.
    const finishedContext = context;
    await finalizeBrowserNetwork(
      async () => {
        await finishedContext.close();
        context = undefined;
      },
      pendingServerAddressChecks,
      () => renderViolation,
      controller.signal,
    );
    return result;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
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
 * Chromium host-resolver rule pinning the validated hostname to one validated
 * public address. IPv4 is preferred because headless environments have more
 * reliable IPv4 routing; if the pinned address is unreachable the render fails
 * closed rather than falling back to a second, unpinned DNS resolution.
 */
export function chromiumHostResolverRules(validated: ValidatedUrl, pinnedAddress?: string): string {
  const address = pinnedAddress ?? preferredPinnedAddress(validated.addresses);
  if (!address) throw new Error(`No validated public address is available for ${validated.hostname}.`);
  const target = address.includes(":") ? `[${address}]` : address;
  // Playwright routing does not mediate every socket Chromium may create (for
  // example speculative preconnect or alternative-service endpoints), so the
  // resolver itself is made default-deny: mapping rules are evaluated in
  // order, the exact admitted-host mapping stays first, and every other
  // hostname is answered NOTFOUND at the network layer before any socket can
  // be created.
  return `MAP ${validated.hostname} ${target}, MAP * ~NOTFOUND`;
}

/**
 * Chromium launch arguments enforcing the DNS pin: the host-resolver MAP rule
 * plus `--no-proxy-server`, because host-resolver rules do not govern DNS
 * performed by an HTTP/SOCKS/system proxy — a proxy could re-resolve the
 * admitted hostname to a private address before per-response verification
 * could react.
 */
export function chromiumDnsPinningArgs(validated: ValidatedUrl, pinnedAddress?: string): string[] {
  return [
    "--no-proxy-server",
    "--host-resolver-rules=" + chromiumHostResolverRules(validated, pinnedAddress),
  ];
}

/**
 * Close browser networking, then drain every pending server-address check —
 * including checks appended while networking was being closed — and re-check
 * the render violation and abort signal, so a late response can never slip
 * past the final verification.
 */
export async function finalizeBrowserNetwork(
  closeNetwork: () => Promise<void>,
  pendingChecks: Promise<void>[],
  getViolation: () => Error | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await closeNetwork();
  await Promise.allSettled(pendingChecks);
  const violation = getViolation();
  if (violation) throw violation;
  if (signal) throwIfAborted(signal);
}

export function preferredPinnedAddress(addresses: readonly string[]): string | undefined {
  return addresses.find((address) => !address.includes(":")) ?? addresses[0];
}

/**
 * Verify the actual remote address Playwright exposed for one response: it
 * must be the pinned validated address. Non-HTTP(S) URLs are skipped, a
 * missing server address fails closed, and a blocked or merely different
 * peer address aborts the render.
 */
export function assertPinnedServerAddress(
  url: string,
  serverAddr: { ipAddress: string; port: number } | null,
  pinnedAddress: string,
): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Browser response URL is invalid: ${boundedBrowserUrl(url)}`);
  }
  if (protocol !== "http:" && protocol !== "https:") return;
  if (!serverAddr) {
    throw new Error(`Browser response for ${boundedBrowserUrl(url)} exposed no server address; refusing unverifiable render.`);
  }
  const ip = serverAddr.ipAddress.replace(/^\[|\]$/g, "");
  if (isBlockedAddress(ip) || !sameIpLiteral(ip, pinnedAddress)) {
    throw new Error(
      `Browser response for ${boundedBrowserUrl(url)} came from ${ip}, not the pinned validated address ${pinnedAddress}; render aborted.`,
    );
  }
}

export interface BrowserRouteDecision {
  allowed: boolean;
  /** Set when an HTTP(S) request could not be pinned to the requested hostname. */
  crossOriginBlock?: string;
}

/**
 * Pure fail-closed route policy for one browser request: local browser
 * protocols are narrowly allowed, HTTP(S) to the pinned hostname is allowed
 * for every scheme and port (the Chromium MAP rule pins that hostname, and
 * each response's actual peer address is verified separately), WebSockets are
 * closed by the separate WebSocket route, and every other HTTP(S) destination
 * or protocol is blocked and reported. Cross-origin passive resources are
 * reported too, so no unpinned cross-origin request can pass silently. No DNS
 * resolution happens here, so no rebinding window can open between approval
 * and connection.
 */
export function browserRouteDecision(resourceType: string, requestUrl: string, pinnedHostname: string): BrowserRouteDecision {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return { allowed: false, crossOriginBlock: requestUrl };
  }
  if (LOCAL_BROWSER_PROTOCOLS.has(parsed.protocol)) return { allowed: true };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, crossOriginBlock: requestUrl };
  }
  if (urlHostname(parsed) !== pinnedHostname) return { allowed: false, crossOriginBlock: requestUrl };
  // Same-hostname passive resources stay blocked by policy, but they are
  // pinned, so they do not taint the render.
  if (PASSIVE_RESOURCE_TYPES.has(resourceType)) return { allowed: false };
  return { allowed: true };
}

const MAX_BROWSER_URL_DIAGNOSTIC_CHARS = 500;

function boundedBrowserUrl(url: string): string {
  if (url.length <= MAX_BROWSER_URL_DIAGNOSTIC_CHARS) return url;
  const marker = "… (truncated)";
  return `${url.slice(0, MAX_BROWSER_URL_DIAGNOSTIC_CHARS - marker.length)}${marker}`;
}

function sameIpLiteral(left: string, right: string): boolean {
  const a = parseIp(left.trim().toLowerCase());
  const b = parseIp(right.trim().toLowerCase());
  if (!a || !b || a.version !== b.version || a.bytes.length !== b.bytes.length) return false;
  return a.bytes.every((byte, index) => byte === b.bytes[index]);
}

export function crossOriginBlockedMessage(blockedUrl: string): string {
  const visibleUrl = boundedBrowserUrl(blockedUrl);
  return (
    `Browser render blocked an HTTP(S) request that could not be pinned: ${visibleUrl}. `
    + `Requests to other hostnames cannot be DNS-pinned in this browser instance, so the render fails closed `
    + `instead of admitting a rebinding window. If the page redirected to another hostname or loaded it as a resource, `
    + `extract that final URL directly instead: run WebFetch (or BrowserExtract) on ${visibleUrl}.`
  );
}

/**
 * Hostname of a browser URL in the same spelling as `ValidatedUrl.hostname`:
 * WHATWG `URL.hostname` keeps IPv6 brackets, the validated pin does not.
 */
function urlHostname(parsed: URL): string {
  return parsed.hostname.replace(/^\[|\]$/g, "");
}

function browserFinalUrl(pageUrl: string, pinnedHostname: string): string {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error(`Browser ended at an invalid URL: ${boundedBrowserUrl(pageUrl)}`);
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (urlHostname(parsed) !== pinnedHostname) throw new Error(crossOriginBlockedMessage(pageUrl));
  } else if (!LOCAL_BROWSER_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Browser ended at an unsupported URL: ${boundedBrowserUrl(pageUrl)}`);
  }
  parsed.hash = "";
  return parsed.href;
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
