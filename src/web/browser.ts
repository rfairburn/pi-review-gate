import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Response, type Route } from "playwright";
import type { DownloadedText, NetworkOptions } from "./network";
import { validatedPublicUrl } from "./network";

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
 */
export async function renderWithChromium(url: string, options: NetworkOptions): Promise<DownloadedText> {
  const requestedUrl = await validatedPublicUrl(url);
  assertChromiumAvailable();
  const approvedOrigins = new Set<string>([new URL(requestedUrl).origin]);
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
  let blockedNavigation: string | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: options.timeoutMs });
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
      const allowed = await allowBrowserRoute(route, approvedOrigins);
      if (!allowed) {
        if (route.request().isNavigationRequest()) blockedNavigation = route.request().url();
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());

    const page = await context.newPage();
    let latestMainNavigation: Response | null = null;
    page.on("response", (candidate) => {
      if (candidate.request().isNavigationRequest() && candidate.frame() === page.mainFrame()) {
        latestMainNavigation = candidate;
      }
    });
    page.on("dialog", (dialog) => void dialog.dismiss());
    page.on("download", (download) => void download.cancel());
    const response = await abortable(
      page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs }),
      controller.signal,
    );
    if (blockedNavigation) throw new Error(`Browser navigation to a non-public URL was blocked: ${blockedNavigation}`);
    await abortable(
      page.waitForLoadState("networkidle", { timeout: Math.min(5_000, Math.max(1_000, Math.floor(options.timeoutMs / 4))) })
        .catch(() => undefined),
      controller.signal,
    );
    const finalUrl = await validatedPublicUrl(page.url());
    const finalResponse = latestMainNavigation ?? response;
    assertSuccessfulBrowserNavigation(finalResponse?.status(), finalResponse?.url() ?? finalUrl);
    const text = await abortable(page.content(), controller.signal);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > options.maxBytes) {
      throw new Error(`Rendered page produced ${bytes} HTML bytes; limit is ${options.maxBytes}.`);
    }
    return {
      requestedUrl,
      finalUrl,
      contentType: finalResponse?.headers()["content-type"] ?? "text/html; charset=utf-8",
      text,
      bytes,
      fetchedAt: new Date().toISOString(),
    };
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
  if (status === undefined) throw new Error(`Browser navigation returned no HTTP response for ${url}.`);
  if (status < 200 || status >= 300) throw new Error(`Browser navigation returned HTTP ${status} for ${url}.`);
}

async function allowBrowserRoute(route: Route, approvedOrigins: Set<string>): Promise<boolean> {
  const request = route.request();
  if (PASSIVE_RESOURCE_TYPES.has(request.resourceType())) return false;
  let parsed: URL;
  try {
    parsed = new URL(request.url());
  } catch {
    return false;
  }
  if (LOCAL_BROWSER_PROTOCOLS.has(parsed.protocol)) return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (approvedOrigins.has(parsed.origin)) return true;
  try {
    await validatedPublicUrl(parsed.href);
    approvedOrigins.add(parsed.origin);
    return true;
  } catch {
    return false;
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
