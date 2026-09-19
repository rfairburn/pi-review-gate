import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { normalizeConfig } from "../src/config";
import { BrowserSessionClosedError, InteractiveBrowserManager, type BrowserVisibilityResult } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";


// ---------------------------------------------------------------------------
// Fixtures: minimal fake browser family mirroring tests/interactive-browser.ts,
// extended with visibility-state detection, storage-state capture, per-call
// launch recording, forced redirects, and injectable failures.
// ---------------------------------------------------------------------------

class FakePage extends EventEmitter {
  currentUrl = "about:blank";
  /** Document visibility the manager reads for foreground-tab detection. */
  visibilityState = "visible";
  /** When set, goto commits this URL instead (server-redirect fixture). */
  redirectTarget?: string;
  /** When set, goto rejects (navigation failure fixture). */
  gotoFailure?: Error;
  /** When set, goto waits this long before committing (abort-race fixture). */
  gotoDelayMs = 0;
  /** Invoked when goto is dispatched (restore-progress observation). */
  onGoto?: () => void;
  broughtToFront = 0;
  closed = false;
  private visited: string[] = [];
  private visitedIndex = -1;
  private readonly frame = {
    url: () => this.currentUrl,
    locator: (_selector: string) => ({ first: () => ({ count: async () => 0 }) }),
    parentFrame: () => null,
  };

  mainFrame() { return this.frame; }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async routeWebSocket() {}
  async title() { return "Untrusted fixture title"; }
  async evaluate() { return this.visibilityState; }
  async bringToFront() { this.broughtToFront += 1; }
  async waitForLoadState() {}
  async ariaSnapshot() { return "- heading \"Fixture\" [level=1]\n- link \"Next\" [ref=e7]\n"; }

  private commit(url: string) {
    const request = {
      isNavigationRequest: () => true,
      frame: () => this.frame,
      redirectedFrom: () => null,
    };
    this.emit("request", request);
    this.currentUrl = url;
    this.visited.splice(this.visitedIndex + 1);
    this.visited.push(url);
    this.visitedIndex = this.visited.length - 1;
    const response = { status: () => 200, request: () => request };
    this.emit("response", response);
    this.emit("framenavigated", this.frame);
    return response;
  }

  navigationHistory() {
    return { currentIndex: this.visitedIndex, entries: this.visited.map((url, index) => ({ id: index + 1, url })) };
  }

  async goto(url: string) {
    this.onGoto?.();
    if (this.gotoDelayMs > 0) await delay(this.gotoDelayMs);
    if (this.gotoFailure) throw this.gotoFailure;
    return this.commit(this.redirectTarget ?? url);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeCdpSession {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  detached = false;
  constructor(private readonly page: FakePage) {}
  async send(method: string) {
    this.sent.push({ method });
    if (method === "Page.getNavigationHistory") return this.page.navigationHistory();
    if (method === "Page.enable" || method === "Runtime.enable" || method === "Page.addScriptToEvaluateOnNewDocument") return {};
    throw new Error(`Unexpected internal protocol method ${method}`);
  }
  on() {}
  async detach() { this.detached = true; }
}

type StorageStateFixture = { cookies: Array<Record<string, unknown>>; origins: Array<Record<string, unknown>> };

class FakeContext extends EventEmitter {
  private readonly pageList: FakePage[] = [];
  constructor(private readonly pendingPageConfigs: Array<(page: FakePage) => void> = []) { super(); }
  /** Real Playwright exposes context.pages() as a method; a fresh context has none. */
  pages(): FakePage[] { return this.pageList; }
  storageStateFixture?: StorageStateFixture;
  storageStateFailure?: Error;
  /** When set, storageState() waits before returning (busy-lock race fixture). */
  storageStateDelayMs = 0;
  storageStateCalls = 0;
  closed = false;
  readonly cdpSessions: FakeCdpSession[] = [];
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async newCDPSession(page: FakePage) {
    const session = new FakeCdpSession(page);
    this.cdpSessions.push(session);
    return session;
  }
  async clearPermissions() {}
  async routeWebSocket() {}
  async route() {}
  async newPage() {
    const page = new FakePage();
    this.pendingPageConfigs.shift()?.(page);
    this.pageList.push(page);
    this.emit("page", page);
    return page as unknown as Page;
  }
  async storageState(): Promise<StorageStateFixture> {
    this.storageStateCalls += 1;
    if (this.storageStateDelayMs > 0) await delay(this.storageStateDelayMs);
    if (this.storageStateFailure) throw this.storageStateFailure;
    return this.storageStateFixture ?? { cookies: [], origins: [] };
  }
  async close() {
    this.closed = true;
    await Promise.all(this.pageList.map((page) => page.close()));
  }
}

class FakeBrowser extends EventEmitter {
  readonly context: FakeContext;
  constructor(pendingPageConfigs: Array<(page: FakePage) => void>) {
    super();
    this.context = new FakeContext(pendingPageConfigs);
  }
  /** Launch-time context options, recorded to assert memory-only state replay. */
  contextOptions?: Record<string, unknown>;
  connected = true;
  async newContext(options?: Record<string, unknown>) {
    this.contextOptions = options;
    if (options && "storageState" in options) this.context.storageStateFixture = options.storageState as StorageStateFixture;
    return this.context as unknown as BrowserContext;
  }
  contexts() { return this.context.closed ? [] : [this.context as unknown as BrowserContext]; }
  isConnected() { return this.connected; }
  async close() {
    this.connected = false;
    this.emit("disconnected");
  }
}

interface VisibilityHarness {
  manager: InteractiveBrowserManager;
  browsers: FakeBrowser[];
  launchOptions: Array<Record<string, unknown>>;
  pendingPageConfigs: Array<(page: FakePage) => void>;
  setLaunchFailure(error: Error | undefined): void;
  setLaunchDelayMs(ms: number): void;
}

function visibilityHarness(configOverrides: Record<string, unknown> = {}): VisibilityHarness {
  const browsers: FakeBrowser[] = [];
  const launchOptions: Array<Record<string, unknown>> = [];
  /** FIFO of configurators applied to pages created in replacement contexts. */
  const pendingPageConfigs: Array<(page: FakePage) => void> = [];
  let launchFailure: Error | undefined;
  let launchDelayMs = 0;
  const config = normalizeConfig({ web: configOverrides }).web!.fetch;
  let serial = 0;
  const manager = new InteractiveBrowserManager(config, {
    resolveHostname: async (hostname: string) => net.isIP(hostname) ? [hostname] : ["93.184.216.34"],
    launch: async (options) => {
      launchOptions.push({ ...(options as Record<string, unknown>) });
      if (launchFailure) throw launchFailure;
      if (launchDelayMs > 0) await delay(launchDelayMs);
      const browser = new FakeBrowser(pendingPageConfigs);
      browsers.push(browser);
      return browser as unknown as Browser;
    },
    randomHandle: (kind: string) => `${kind}_${++serial}_${"x".repeat(32)}`,
  });
  return {
    manager,
    browsers,
    launchOptions,
    pendingPageConfigs,
    setLaunchFailure: (error) => { launchFailure = error; },
    setLaunchDelayMs: (ms) => { launchDelayMs = ms; },
  };
}

function lastContext(harness: VisibilityHarness): FakeContext {
  assert.ok(harness.browsers.length > 0);
  return harness.browsers[harness.browsers.length - 1]!.context;
}

// ---------------------------------------------------------------------------
// Manager-level visibility replacement semantics.
// ---------------------------------------------------------------------------

test("applyVisibility with no live browser returns null and the preference applies at the next open", async () => {
  const harness = visibilityHarness();
  try {
    harness.manager.updateConfig(normalizeConfig({ web: { browserVisible: true } }).web!.fetch, "ask", 15, true);
    assert.equal(await harness.manager.applyVisibility(true), null);
    assert.equal(harness.browsers.length, 0, "no browser may be launched for a visibility save with no live browser");
    const opened = await harness.manager.open("https://example.com/");
    assert.equal(harness.launchOptions[0]!.headless, false, "saved headed preference applies at the next open");
    await harness.manager.close(opened.session);
    harness.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, false);
    const second = await harness.manager.open("https://example.com/");
    assert.equal(harness.launchOptions[1]!.headless, true, "saved headless preference applies at the next open");
    await harness.manager.close(second.session);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("same-mode save is idempotent: no restart and the session survives", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/");
    assert.equal(await harness.manager.applyVisibility(false), null);
    assert.equal(harness.browsers.length, 1, "no replacement browser for an idempotent save");
    assert.equal(harness.manager.activeSessionCount(), 1);
    const snapshot = await harness.manager.snapshot(opened.session, opened.tab, 1000);
    assert.match(snapshot.url, /example\.com/);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("headless→headed replacement restores ordered tabs, active tab, and memory-only state; old handles die", async () => {
  const harness = visibilityHarness();
  try {
    const cookies = [{ name: "session-cookie", value: "s3cr3t", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }];
    const origins = [{ origin: "https://example.com", localStorage: [{ name: "token", value: "local-value" }] }];
    const opened = await harness.manager.open("https://example.com/a");
    harness.browsers[0]!.context.storageStateFixture = { cookies, origins };
    await harness.manager.tabs(opened.session, "open", undefined, "https://example.com/b");
    // A semantic ref captured in the old session must not survive replacement.
    const oldSnapshot = await harness.manager.snapshot(opened.session, opened.tab, 1000);
    const oldRef = oldSnapshot.snapshot.match(/\[ref=([^\]]+)\]/)![1]!;

    const result = await harness.manager.applyVisibility(true) as BrowserVisibilityResult;
    assert.ok(result);
    assert.equal(result.relaunched, true);
    assert.equal(result.headless, false);
    assert.equal(result.previousSession, opened.session);
    assert.notEqual(result.session, opened.session);
    assert.equal(result.restoredTabs, 2);
    assert.equal(result.unrestoredTabs, 0);
    assert.equal(result.urlMismatches, 0);
    assert.equal(result.stateReapplied, true);
    assert.equal(result.stateCookies, 1);
    assert.equal(result.stateOrigins, 1);
    assert.deepEqual(result.tabs.map((tab) => tab.requestedUrl), ["https://example.com/a", "https://example.com/b"]);
    assert.deepEqual(result.tabs.map((tab) => tab.finalUrl), ["https://example.com/a", "https://example.com/b"]);
    assert.equal(result.tabs[1]!.active, true, "the recorded active tab (the last-opened tab) stays active");
    assert.equal(result.tabs[0]!.active, undefined);

    // Launch modes: headless first, headed second; memory-only object replay.
    assert.equal(harness.launchOptions[0]!.headless, true);
    assert.equal(harness.launchOptions[1]!.headless, false);
    const passed = harness.browsers[1]!.contextOptions?.storageState;
    assert.deepEqual(passed, { cookies, origins });
    assert.equal(typeof passed, "object", "state is passed as an object, never a disk path");

    // Old session handle rejected with the truthful visibility closure.
    await assert.rejects(harness.manager.snapshot(opened.session, opened.tab, 1000), (error) => {
      assert.ok(error instanceof BrowserSessionClosedError);
      assert.equal(error.closure?.kind, "visibility_reconfigure");
      return true;
    });
    // Forged/stale tab handles on the replacement session are rejected.
    await assert.rejects(harness.manager.snapshot(result.session!, "forged_tab_handle", 1000), /stale/);
    // The replacement session's handles work and list the restored order.
    const listed = await harness.manager.tabs(result.session!, "list");
    assert.deepEqual(listed.tabs.map((tab) => tab.url), ["https://example.com/a", "https://example.com/b"]);
    assert.equal(listed.activeTab, result.activeTab);
    assert.equal(listed.tabs.find((tab) => tab.tab === listed.activeTab)!.url, "https://example.com/b");
    // The old semantic ref is not usable in the replacement session.
    await assert.rejects(harness.manager.click(result.session!, listed.tabs[0]!.tab, oldRef), /invalid or stale|not_started|stale/);
    // A duplicate open reveals the replacement session instead of a second browser.
    await assert.rejects(harness.manager.open("https://example.com/"), (error: unknown) => {
      const recovery = error as { recovery?: { existingSession?: string } };
      assert.equal(recovery.recovery?.existingSession, result.session);
      return true;
    });
    assert.equal(harness.browsers.length, 2, "exactly one replacement browser, no duplicate or orphan");
    assert.equal(harness.browsers[0]!.connected, false);
    assert.equal(harness.browsers[1]!.connected, true);

    // The human-input bridge is installed in the replacement session, and the
    // old session's CDP callbacks are disposed on teardown.
    const bridge = harness.browsers[1]!.context.cdpSessions.find((session) =>
      session.sent.some((call) => call.method === "Page.addScriptToEvaluateOnNewDocument"));
    assert.ok(bridge, "human input bridge must install in the replacement session");
    assert.ok(harness.browsers[0]!.context.cdpSessions.length > 0);
    assert.ok(harness.browsers[0]!.context.cdpSessions.every((session) => session.detached));

    // Headed → headless works in the other direction too, replaying state.
    const back = await harness.manager.applyVisibility(false) as BrowserVisibilityResult;
    assert.ok(back);
    assert.equal(back.headless, true);
    assert.equal(harness.launchOptions[2]!.headless, true);
    assert.deepEqual(harness.browsers[2]!.contextOptions?.storageState, { cookies, origins });
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("foreground tab selected by the human in the headed window wins over the model's recorded active tab", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/a");
    await harness.manager.tabs(opened.session, "open", undefined, "https://example.com/b");
    // The model's recorded active tab is back on the first tab…
    await harness.manager.tabs(opened.session, "switch", opened.tab);
    // …while the human has clicked the second tab in the real window: only
    // that page reports document.visibilityState === "visible".
    const context = harness.browsers[0]!.context;
    context.pages()[0]!.visibilityState = "hidden";
    context.pages()[1]!.visibilityState = "visible";

    const result = await harness.manager.applyVisibility(true) as BrowserVisibilityResult;
    assert.ok(result);
    const activeRow = result.tabs.find((tab) => tab.active);
    assert.equal(activeRow?.requestedUrl, "https://example.com/b", "the human-selected foreground tab is restored as active");
    const listed = await harness.manager.tabs(result.session!, "list");
    assert.equal(listed.activeTab, result.activeTab);
    assert.equal(listed.tabs.find((tab) => tab.tab === listed.activeTab)!.url, "https://example.com/b");
    assert.ok(result.notes.some((note) => note.includes("foregrounded")), "the demotion of the recorded active tab is disclosed");
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("partial restoration: server redirect is disclosed, unsafe URL preserved-not-restored, per-tab restore failure", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/login-redirect");
    const context = harness.browsers[0]!.context;
    // Tab 2 became a local file URL through human address-bar use: never restored.
    await harness.manager.tabs(opened.session, "open", undefined, "https://example.com/file");
    context.pages()[1]!.currentUrl = "file:///etc/secrets.txt";
    // The replacement context restores /authed through a server-side redirect
    // to a login page, and /fails with a non-fatal transport failure.
    await harness.manager.tabs(opened.session, "open", undefined, "https://example.com/authed");
    await harness.manager.tabs(opened.session, "open", undefined, "https://example.com/fails");
    // Slot 0 configures nothing: the replacement reuses its own primary page
    // for the first restored tab; then /authed redirects and /fails transport-fails.
    harness.pendingPageConfigs.push(() => undefined);
    harness.pendingPageConfigs.push((page) => { page.redirectTarget = "https://example.com/login"; });
    harness.pendingPageConfigs.push((page) => { page.gotoFailure = new Error("page.goto: net::ERR_CONNECTION_RESET"); });

    const result = await harness.manager.applyVisibility(true) as BrowserVisibilityResult;
    assert.ok(result);
    assert.equal(result.restoredTabs, 2);
    assert.equal(result.unrestoredTabs, 2);
    assert.equal(result.urlMismatches, 1);
    assert.deepEqual(result.tabs.map((tab) => tab.requestedUrl), ["https://example.com/login-redirect", "file:///etc/secrets.txt", "https://example.com/authed", "https://example.com/fails"]);
    const byUrl = new Map(result.tabs.map((tab) => [tab.requestedUrl, tab]));
    assert.equal(byUrl.get("https://example.com/authed")!.restored, true);
    assert.equal(byUrl.get("https://example.com/authed")!.finalUrl, "https://example.com/login");
    assert.match(byUrl.get("https://example.com/authed")!.reason!, /different final URL/);
    assert.equal(result.urlMismatches, 1);
    assert.equal(byUrl.get("file:///etc/secrets.txt")!.restored, false);
    assert.equal(byUrl.get("file:///etc/secrets.txt")!.finalUrl, null);
    assert.match(byUrl.get("file:///etc/secrets.txt")!.reason!, /egress policy/);
    assert.ok(byUrl.get("file:///etc/secrets.txt")!.requestedUrl!.includes("file:///etc/secrets.txt"), "intended tab information is preserved in the result");
    assert.equal(byUrl.get("https://example.com/fails")!.restored, false);
    assert.match(byUrl.get("https://example.com/fails")!.reason!, /CONNECTION_RESET|failed/);
    assert.equal(byUrl.get("https://example.com/login-redirect")!.restored, true);
    // Only three pages exist in the replacement: restored primary, restored
    // /authed, and the /fails page whose navigation failed. No page was
    // created for the unrestorable file:// tab (no fabricated fallback).
    assert.equal(lastContext(harness).pages().length, 3);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("when no recorded tab URL passes the egress policy the browser is left unchanged, not destroyed", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/");
    harness.browsers[0]!.context.pages()[0]!.currentUrl = "chrome://settings";
    const result = await harness.manager.applyVisibility(true) as BrowserVisibilityResult;
    assert.ok(result);
    assert.equal(result.relaunched, false);
    assert.equal(result.session, opened.session, "the live browser is kept");
    assert.equal(result.restoredTabs, 0);
    assert.equal(harness.browsers.length, 1, "no replacement browser was launched");
    assert.ok(result.notes.some((note) => note.includes("left unchanged")));
    // The unchanged session remains usable.
    const listed = await harness.manager.tabs(opened.session, "list");
    assert.equal(listed.activeTab, opened.tab);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("applyVisibility serializes behind an in-flight BrowserOpen instead of orphaning a browser", async () => {
  const harness = visibilityHarness();
  harness.setLaunchDelayMs(150);
  try {
    // The open starts headless; the headed preference is saved while it is
    // still in flight.
    const pendingOpen = harness.manager.open("https://example.com/");
    harness.manager.updateConfig(normalizeConfig({ web: { browserVisible: true } }).web!.fetch, "ask", 15, true);
    const pendingApply = harness.manager.applyVisibility(true);
    const opened = await pendingOpen;
    const result = await pendingApply as BrowserVisibilityResult;
    assert.ok(opened);
    assert.ok(result);
    assert.equal(result.relaunched, true, "the completed open's live browser is replaced immediately");
    assert.equal(harness.browsers.length, 2);
    assert.equal(harness.launchOptions[0]!.headless, true);
    assert.equal(harness.launchOptions[1]!.headless, false);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("applyVisibility waits for an in-flight browser operation to settle, then replaces", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/");
    const page = harness.browsers[0]!.context.pages()[0]!;
    let snapshotSettled = false;
    const originalSnapshot = page.ariaSnapshot.bind(page);
    page.ariaSnapshot = async () => {
      await delay(150);
      const value = await originalSnapshot();
      snapshotSettled = true;
      return value;
    };
    const pending = harness.manager.snapshot(opened.session, opened.tab, 1000);
    await delay(20);
    const result = await harness.manager.applyVisibility(true) as BrowserVisibilityResult;
    const snapshot = await pending;
    assert.ok(snapshotSettled, "the in-flight snapshot was awaited, not torn down underneath the save");
    assert.ok(snapshot.url);
    assert.ok(result);
    assert.equal(result.relaunched, true);
    // The replaced session's old handles are rejected.
    await assert.rejects(harness.manager.snapshot(opened.session, opened.tab, 1000), BrowserSessionClosedError);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("a failed relaunch is reported truthfully and leaves no orphan browser", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/");
    harness.setLaunchFailure(new Error("chromium headed launch unavailable in fixture"));
    await assert.rejects(harness.manager.applyVisibility(true), /headed launch unavailable/);
    assert.equal(harness.manager.activeSessionCount(), 0, "no session survived the failed replacement");
    assert.equal(harness.browsers.length, 1, "no extra browser process exists");
    assert.equal(harness.browsers[0]!.connected, false, "the old browser is closed, not orphaned");
    await assert.rejects(harness.manager.snapshot(opened.session, opened.tab, 1000), (error) => {
      assert.ok(error instanceof BrowserSessionClosedError);
      assert.equal(error.closure?.kind, "visibility_reconfigure");
      return true;
    });
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("session-state capture failure is disclosed, not silently skipped", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/");
    harness.browsers[0]!.context.storageStateFailure = new Error("storage state capture unavailable");
    const result = await harness.manager.applyVisibility(true) as BrowserVisibilityResult;
    assert.ok(result);
    assert.equal(result.stateReapplied, false);
    assert.equal(result.stateCookies, null);
    assert.ok(result.notes.some((note) => note.includes("state capture failed")));
    assert.equal(result.restoredTabs, 1, "tab restoration continues without stored state");
    assert.equal(harness.browsers[1]!.contextOptions?.storageState, undefined, "no state object is passed when capture failed");
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("overflow pages beyond the tab cap are reported, never silently dropped", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/");
    const context = harness.browsers[0]!.context;
    const unowned = new FakePage();
    unowned.currentUrl = "https://example.com/overflow";
    context.pages().push(unowned);
    const result = await harness.manager.applyVisibility(true) as BrowserVisibilityResult;
    assert.ok(result);
    assert.equal(result.overflowPopups, 1);
    assert.equal(result.tabs.filter((tab) => !tab.restored).length, 1);
    assert.match(result.tabs.find((tab) => tab.requestedUrl === "https://example.com/overflow")!.reason!, /beyond the owned-tab limit/);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Settings boundary: /review-settings save semantics through WebToolManager.
// ---------------------------------------------------------------------------

test("WebToolManager.applySavedSettings applies saved visibility to the live browser and reports replacement handles", async () => {
  const harness = visibilityHarness();
  try {
    let registrations = 0;
    const boundary = new WebToolManager({ registerTool: () => { registrations += 1; } }, normalizeConfig({}), undefined, undefined, harness.manager);
    boundary.register();
    const toolCount = registrations;
    const opened = await harness.manager.open("https://example.com/");

    // Same-mode save: nothing changes, no notice.
    assert.equal(await boundary.applySavedSettings(normalizeConfig({})), null);
    assert.equal(harness.browsers.length, 1);
    assert.equal(registrations, toolCount, "the model tool set is never re-registered by a visibility save");

    // Headed save: immediate replacement with a truthful, bounded notice.
    const notice = await boundary.applySavedSettings(normalizeConfig({ web: { browserVisible: true } }));
    assert.ok(notice);
    assert.match(notice!, /applied immediately/);
    assert.match(notice!, /headed \(visible window\)/);
    assert.match(notice!, /old session\/tab\/ref handles are stale/);
    assert.match(notice!, /Session state replayed from memory \(0 cookie\(s\), 0 origin\(s\)\).*best-effort/);
    assert.doesNotMatch(notice!, /s3cr3t|password/i, "state values never appear in the notice");
    assert.equal(harness.browsers.length, 2);
    assert.equal(harness.launchOptions[1]!.headless, false);
    assert.equal(registrations, toolCount, "no new or removed model tools: exposure is the same visible or hidden");
    assert.equal(harness.manager.activeSessionCount(), 1);
    void opened;
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("WebToolManager.applySavedSettings with no live browser stays silent; the preference applies at next open", async () => {
  const harness = visibilityHarness();
  try {
    const boundary = new WebToolManager({ registerTool: () => undefined }, normalizeConfig({ web: { browserVisible: true } }), undefined, undefined, harness.manager);
    boundary.register();
    assert.equal(await boundary.applySavedSettings(normalizeConfig({ web: { browserVisible: true } })), null);
    assert.equal(harness.browsers.length, 0, "a save with no open browser must not launch anything");
    const opened = await harness.manager.open("https://example.com/");
    assert.equal(harness.launchOptions[0]!.headless, false);
    await harness.manager.close(opened.session);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("config normalization validates web.browserVisible", () => {
  assert.equal(normalizeConfig({}).web!.browserVisible, false);
  assert.equal(normalizeConfig({ web: { browserVisible: true } }).web!.browserVisible, true);
  assert.throws(() => normalizeConfig({ web: { browserVisible: "yes" } }), /web\.browserVisible must be a boolean/);
});

test("a Pi shutdown aborting a visibility restore reports structured cancellation, never success", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/a");
    await harness.manager.tabs(opened.session, "open", undefined, "https://example.com/b");
    // The replacement's primary restore navigation hangs until shutdown wins.
    let restoreGotoStarted = false;
    harness.pendingPageConfigs.push((page) => {
      page.onGoto = () => { restoreGotoStarted = true; };
      page.gotoDelayMs = 2_000;
    });
    const pendingApply = harness.manager.applyVisibility(true);
    // Poll for the dispatched restore navigation instead of assuming a fixed
    // 20ms is always enough on a loaded machine; the fixture pipeline is
    // deterministic, so this settles immediately when nothing is contended.
    const restoreStartedDeadline = Date.now() + 2_000;
    while (!restoreGotoStarted && Date.now() < restoreStartedDeadline) await delay(5);
    assert.ok(restoreGotoStarted, "the restore navigation was in flight when shutdown arrived");
    const pendingShutdown = harness.manager.shutdown();
    await assert.rejects(pendingApply, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cancelled by Pi session shutdown\/replacement\/reload/);
      return true;
    }, "an aborted restore must surface as the structured open cancellation, not a success result");
    await pendingShutdown;
    assert.equal(harness.manager.activeSessionCount(), 0, "no session survives the shutdown-aborted replacement");
    assert.equal(harness.browsers[0]!.connected, false, "the pre-replacement browser was closed");
    assert.equal(harness.browsers[1]!.connected, false, "the replacement browser was torn down by shutdown");
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

test("a browser operation arriving mid-replacement is rejected as busy, not started against a closing session", async () => {
  const harness = visibilityHarness();
  try {
    const opened = await harness.manager.open("https://example.com/");
    const context = harness.browsers[0]!.context;
    context.storageStateDelayMs = 300;
    const pendingApply = harness.manager.applyVisibility(true);
    const captureStarted = Date.now() + 2_000;
    while (context.storageStateCalls === 0 && Date.now() < captureStarted) await delay(5);
    assert.ok(context.storageStateCalls > 0, "the replacement's state capture was in flight");
    // The session busy lock is held across capture/validation: the operation
    // is rejected up front instead of running against a session that is about
    // to be torn down mid-flight.
    await assert.rejects(harness.manager.snapshot(opened.session, opened.tab, 1000), /busy with another bounded operation/);
    const result = await pendingApply as BrowserVisibilityResult;
    assert.ok(result);
    assert.equal(result.relaunched, true, "the replacement still completes once the window passes");
    // After release/teardown the old handle is rejected as replaced, and the
    // replacement session is immediately usable (lock not stranded).
    await assert.rejects(harness.manager.snapshot(opened.session, opened.tab, 1000), BrowserSessionClosedError);
    const listed = await harness.manager.tabs(result.session!, "list");
    assert.equal(listed.tabs.length, 1);
  } finally {
    await harness.manager.shutdown().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Real-runtime evidence: genuine Playwright storage-state replay with cookies,
// localStorage, IndexedDB, and multiple tab URLs, plus an owned disposable
// headed fixture (transparent skip when a headed window is unavailable). No
// live credentials and no external navigation: everything stays on a local
// loopback fixture.
// ---------------------------------------------------------------------------

test("real Chromium replays a captured storage state (cookies + localStorage + IndexedDB) across multi-tab contexts", async () => {
  const origin = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><title>state fixture</title><main>state</main>");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as AddressInfo).port;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const contextA = await browser.newContext();
    const paths = ["/one", "/two", "/three"];
    for (const path of paths) {
      const page = await contextA.newPage();
      await page.goto(`http://127.0.0.1:${port}${path}`);
      await page.evaluate((path) => {
        localStorage.setItem(`marker-${path}`, `value-${path}`);
        document.cookie = `k-${path}=v-${path}; path=/`;
      }, path);
    }
    // IndexedDB-backed session markers: capture must include them, because
    // pinned Playwright omits IndexedDB unless it is requested explicitly.
    const idbPage = await contextA.newPage();
    await idbPage.goto(`http://127.0.0.1:${port}${paths[0]}`);
    await idbPage.evaluate(() => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("pi-visibility-fixture", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put("idb-value", "idb-marker");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    }));
    // IndexedDB is explicitly requested so the documented claim is true.
    const captured = await contextA.storageState({ indexedDB: true });
    assert.ok(Array.isArray(captured.cookies) && captured.cookies.length >= 3);
    const originState = captured.origins.find((entry) => entry.origin === `http://127.0.0.1:${port}`);
    assert.ok(originState);
    // Captured IndexedDB is database-level: { name, version, stores[].records[] }.
    const idbCaptured = (originState as { indexedDB?: Array<{ name: string; stores?: Array<{ name: string; records?: Array<{ key: string; value: string }> }> }> })
      .indexedDB?.some((db) => db.name === "pi-visibility-fixture"
        && db.stores?.some((store) => store.records?.some((record) => record.key === "idb-marker" && record.value === "idb-value")));
    assert.equal(idbCaptured, true, "the captured state object carries the IndexedDB marker");

    const contextB = await browser.newContext({ storageState: captured });
    const seedPage = await contextB.newPage();
    await seedPage.goto(`http://127.0.0.1:${port}${paths[0]}`);
    const idbReplayed = await seedPage.evaluate(() => new Promise<string | null>((resolve, reject) => {
      const open = indexedDB.open("pi-visibility-fixture", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", "readonly");
        const request = tx.objectStore("kv").get("idb-marker");
        request.onsuccess = () => resolve((request.result as string | undefined) ?? null);
        request.onerror = () => reject(request.error);
      };
    }));
    assert.equal(idbReplayed, "idb-value", "IndexedDB-backed state is seeded into the replacement context");
    for (const path of paths) {
      const page = await contextB.newPage();
      await page.goto(`http://127.0.0.1:${port}${path}`);
      const cookie = await page.evaluate((path) => document.cookie, path);
      const stored = await page.evaluate((path) => localStorage.getItem(`marker-${path}`), path);
      assert.ok(cookie.includes(`k-${path}=v-${path}`), `cookie replayed for ${path}`);
      assert.equal(stored, `value-${path}`, `localStorage replayed for ${path}`);
    }
    await contextB.close();
    await contextA.close();
  } finally {
    await browser?.close().catch(() => undefined);
    origin.close();
  }
});

test("owned disposable headed Chromium fixture launches with a normal window on this machine (transparent skip otherwise)", async (t) => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (error) {
    // Per-test context skip: the module-level test.skip() declaration cannot
    // mark the currently running test, so an unavailable headed window would
    // otherwise pass with zero assertions instead of reporting a skip.
    t.skip(`headed window unavailable in this environment: ${(error as Error).message.slice(0, 120)}`);
    return;
  }
  try {
    assert.equal(browser.isConnected(), true, "headed binary launched and stayed connected");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");
    // Foreground-tab detection premise: the only tab of a headed window
    // reports document.visibilityState === "visible".
    assert.equal(await page.evaluate(() => document.visibilityState), "visible");
    await context.close();
  } finally {
    await browser.close();
    assert.equal(browser.isConnected(), false, "the owned headed fixture process is closed");
  }
});