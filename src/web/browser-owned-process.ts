import { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";

export const BROWSER_GRACEFUL_CLOSE_MS = 5_000;
/** Additional verification allowance, not additional graceful-close time. */
export const BROWSER_FORCE_VERIFY_MS = 5_000;

type OwnedProcess = { process: ChildProcess; close(): Promise<void>; kill(): Promise<void> };
const owned = new WeakMap<Browser, OwnedProcess>();

export class BrowserOwnershipError extends Error {
  constructor(cause: unknown) {
    super("Unsupported local Chromium ownership; startup cleanup is unconfirmed.", { cause });
  }
}

export async function prepareOwnedBrowser(browser: Browser): Promise<Browser> {
  try { return installOwnedBrowserClose(browser); }
  catch (error) {
    // Best effort only: without the owned-process seam even a disconnected
    // browser is not proof of OS disappearance. Permanently retire the owner.
    await settlesWithin(Promise.resolve().then(() => browser.close()), BROWSER_GRACEFUL_CLOSE_MS);
    throw new BrowserOwnershipError(error);
  }
}

export function browserCleanupDeadline(browser: Browser | undefined, fallback: number): number {
  return browser && owned.has(browser)
    ? Math.max(fallback, BROWSER_GRACEFUL_CLOSE_MS + BROWSER_FORCE_VERIFY_MS + 100)
    : fallback;
}

/** Called only on the direct result of our local chromium.launch, never on page
 * data or a remote connection. Keep local transport: isolated selectors use it.
 * Playwright exposes this same kill operation through BrowserServer.kill, but
 * switching to BrowserServer would lose the local isolated-selector bridge. */
export function installOwnedBrowserClose(browser: Browser): Browser {
  if (owned.has(browser)) return browser;
  const local = browser as unknown as {
    _connection?: { toImpl?: (browser: Browser) => { options?: { browserProcess?: OwnedProcess } } };
  };
  const connection = local._connection;
  const candidate = connection?.toImpl?.(browser)?.options?.browserProcess;
  if (!candidate || !(candidate.process instanceof ChildProcess)
    || !Number.isSafeInteger(candidate.process.pid) || candidate.process.pid! <= 0 || candidate.process.pid === process.pid
    || typeof candidate.process.spawnfile !== "string"
    || !candidate.process.spawnargs.includes("--remote-debugging-pipe")
    || typeof candidate.close !== "function" || typeof candidate.kill !== "function") {
    throw new Error("Local Chromium process ownership bridge is unsupported; cleanup cannot be proven.");
  }
  // Retain the actual child and bound functions now; never resolve ownership
  // again after page execution, nor discover targets by scanning process names.
  const handle: OwnedProcess = {
    process: candidate.process,
    close: candidate.close.bind(candidate),
    kill: candidate.kill.bind(candidate),
  };
  owned.set(browser, handle);
  const gracefulClose = browser.close.bind(browser);
  let closing: Promise<void> | undefined;
  browser.close = (options) => closing ??= (async () => {
    await settlesWithin(Promise.resolve().then(() => gracefulClose(options)), BROWSER_GRACEFUL_CLOSE_MS);
    if (!ownedBrowserQuiescent(browser)) {
      const killed = await settlesWithin(Promise.resolve().then(() => handle.kill()), BROWSER_FORCE_VERIFY_MS);
      if (!killed) throw new Error("Owned Chromium forced termination did not settle; closure is unconfirmed.");
    }
    if (!ownedBrowserQuiescent(browser)) {
      throw new Error("Owned Chromium process disappearance was not proven; closure is unconfirmed.");
    }
  })();
  return browser;
}

/** Non-signalling liveness probe, only for the retained child identity. A reused
 * PID is conservatively unconfirmed, never a reason to signal that new process. */
export function ownedBrowserQuiescent(browser: Browser): boolean {
  const handle = owned.get(browser);
  if (!handle) return !browser.isConnected(); // injected test adapters retain existing checks
  const child = handle.process;
  if (child.exitCode === null && child.signalCode === null) return false;
  if (browser.isConnected()) return false;
  try { process.kill(child.pid!, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function settlesWithin(operation: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
