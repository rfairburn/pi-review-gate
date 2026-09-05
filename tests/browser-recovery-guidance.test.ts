import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";

// Recovery-guidance regressions run through the registered WebToolManager
// tools (the sanitized native exception contract) with a real
// InteractiveBrowserManager over fake deferred Playwright lifecycle fixtures.
// No expectation here is hand-copied from a failure site: the tests assert the
// fixed sanitized guidance contract and structured metadata behavior.

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class FakePage extends EventEmitter {
  currentUrl = "about:blank";
  closedState = false;
  gotoInvoked = false;
  gotoDispatches = 0;
  gotoGate?: Promise<void>;
  private visited: string[] = [];
  private visitedIndex = -1;
  private inFlightGotoReleases: Array<() => void> = [];
  readonly frame = {
    url: () => this.url(),
    locator: (_selector: string) => ({ first: () => ({ count: async () => 0 }) }),
    parentFrame: () => null,
  };
  mainFrame() { return this.frame; }
  url() { return this.currentUrl; }
  isClosed() { return this.closedState; }
  async routeWebSocket() {}
  async title() { return "Fixture title"; }
  viewportSize() { return { width: 1280, height: 720 }; }
  async ariaSnapshot() { return '- heading "Fixture" [level=1]\n- link "Next" [ref=e7]\n'; }
  async waitForLoadState() {}
  async bringToFront() {}
  async goto(url: string) {
    if (this.closedState) throw new Error("Target page, context or browser has been closed");
    this.gotoInvoked = true;
    this.gotoDispatches += 1;
    let releaseOnClose!: () => void;
    const closedWhileInFlight = new Promise<void>((resolve) => { releaseOnClose = resolve; });
    this.inFlightGotoReleases.push(releaseOnClose);
    try {
      if (this.gotoGate) {
        // Playwright rejects an in-flight navigation when the page, context,
        // or browser closes before it settles; model that here.
        await Promise.race([
          this.gotoGate.then(() => false),
          closedWhileInFlight.then(() => true),
        ]);
        if (this.closedState) throw new Error("Target page, context or browser has been closed");
      }
      const request = { isNavigationRequest: () => true, frame: () => this.frame, redirectedFrom: () => null };
      this.emit("request", request);
      this.currentUrl = url;
      this.visited.splice(this.visitedIndex + 1);
      this.visited.push(url);
      this.visitedIndex = this.visited.length - 1;
      const response = { status: () => 200, request: () => request };
      this.emit("response", response);
      this.emit("framenavigated", this.frame);
      return response;
    } finally {
      const index = this.inFlightGotoReleases.indexOf(releaseOnClose);
      if (index >= 0) this.inFlightGotoReleases.splice(index, 1);
    }
  }
  navigationHistory() {
    const entries = this.visited.length > 0 ? this.visited : ["about:blank"];
    return {
      currentIndex: Math.max(0, this.visitedIndex),
      entries: entries.map((url, index) => ({ id: index + 1, url })),
    };
  }
  async close() {
    if (this.closedState) return;
    this.closedState = true;
    for (const release of this.inFlightGotoReleases.splice(0)) release();
    this.emit("close");
  }
}

class FakeContext extends EventEmitter {
  readonly page = new FakePage();
  closed = false;
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async clearPermissions() {}
  async routeWebSocket() {}
  async route(_pattern: string, _handler: (route: unknown) => Promise<void>) {}
  async newCDPSession(page: FakePage) {
    return {
      send: async (method: string) => {
        if (method === "Page.getNavigationHistory") return page.navigationHistory();
        throw new Error(`Unexpected internal protocol method ${method}`);
      },
      detach: async () => undefined,
    };
  }
  async newPage() {
    this.emit("page", this.page);
    return this.page as unknown as Page;
  }
  async close() {
    this.closed = true;
    await this.page.close();
  }
}

class FakeBrowser extends EventEmitter {
  readonly context = new FakeContext();
  connected = true;
  async newContext() { return this.context as unknown as BrowserContext; }
  contexts() { return this.context.closed ? [] : [this.context as unknown as BrowserContext]; }
  isConnected() { return this.connected; }
  async close() {
    this.connected = false;
    this.emit("disconnected");
  }
}

function fixture(options: { hangBrowserClose?: boolean } = {}) {
  const browser = new FakeBrowser();
  if (options.hangBrowserClose) browser.close = async () => new Promise<void>(() => undefined);
  let serial = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    randomHandle: (kind) => `${kind}_${++serial}_${"x".repeat(32)}`,
    limits: { cleanupMs: 150 },
  });
  return { manager, browser };
}

function toolHost(manager: InteractiveBrowserManager) {
  const tools = new Map<string, any>();
  const host = { registerTool: (tool: any) => { tools.set(tool.name, tool); } };
  new WebToolManager(host as any, normalizeConfig({}), undefined, undefined, manager).register();
  return (name: string) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    return {
      execute: (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("fixture", params, signal),
    };
  };
}

test("registered BrowserOpen cancellation before navigation dispatch is sanitized, retry-safe, and drains the late launch", async () => {
  const lateBrowser = new FakeBrowser();
  const browsers: FakeBrowser[] = [lateBrowser];
  let releaseLaunch!: () => void;
  const deferredLaunch = new Promise<Browser>((resolve) => { releaseLaunch = () => resolve(lateBrowser as unknown as Browser); });
  let launchInvokedResolve!: () => void;
  const launchInvoked = new Promise<void>((resolve) => { launchInvokedResolve = resolve; });
  let deferredConsumed = false;
  let serial = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => {
      if (!deferredConsumed) {
        deferredConsumed = true;
        launchInvokedResolve();
        return deferredLaunch;
      }
      const fresh = new FakeBrowser();
      browsers.push(fresh);
      return fresh as unknown as Browser;
    },
    randomHandle: (kind) => `${kind}_${++serial}_${"x".repeat(32)}`,
    limits: { cleanupMs: 150, navigationMs: 1_000 },
  });
  try {
    const browserOpen = toolHost(manager)("BrowserOpen");
    const controller = new AbortController();
    const opening = browserOpen.execute({ url: "https://example.com/" }, controller.signal);
    await launchInvoked;
    controller.abort(new Error("private rewind marker 9182"));
    releaseLaunch();
    await assert.rejects(opening, (error: Error) => {
      assert.match(error.message, /BrowserOpen was cancelled before dispatch/);
      assert.match(error.message, /no page effects occurred and cleanup was confirmed/);
      assert.match(error.message, /safe to retry BrowserOpen/);
      assert.ok(error.message.length < 512, "public failure stays bounded");
      assert.doesNotMatch(error.message, /private rewind marker 9182/, "no raw abort reason leakage");
      return true;
    });
    assert.equal(lateBrowser.isConnected(), false, "late launch result is drained and closed");
    assert.equal(manager.activeSessionCount(), 0);
    const reopened = await browserOpen.execute({ url: "https://example.com/retry" });
    assert.ok(reopened.details.response.session, "retry BrowserOpen succeeds after confirmed pre-dispatch cleanup");
    assert.equal(manager.activeSessionCount(), 1);
    assert.equal(browsers.at(-1)!.isConnected(), true);
  } finally {
    await manager.shutdown();
  }
});

test("registered BrowserOpen cancellation after navigation dispatch reports possible effects with confirmed cleanup", async () => {
  const { manager, browser } = fixture();
  try {
    browser.context.page.gotoGate = new Promise<void>(() => undefined);
    const browserOpen = toolHost(manager)("BrowserOpen");
    const controller = new AbortController();
    const opening = browserOpen.execute({ url: "https://example.com/" }, controller.signal);
    while (!browser.context.page.gotoInvoked) await delay(5);
    controller.abort(new Error("escape rewind marker"));
    await assert.rejects(opening, (error: Error) => {
      assert.match(error.message, /BrowserOpen was cancelled after dispatch/);
      assert.match(error.message, /network effects may have occurred/);
      assert.match(error.message, /effect status is unknown/);
      assert.match(error.message, /no rollback is claimed/);
      assert.match(error.message, /Cleanup was confirmed/);
      assert.ok(error.message.length < 512);
      assert.doesNotMatch(error.message, /escape rewind marker/, "no raw abort reason leakage");
      return true;
    });
    assert.equal(browser.isConnected(), false);
    assert.equal(manager.activeSessionCount(), 0);
  } finally {
    await manager.shutdown();
  }
});

test("unconfirmed BrowserOpen cleanup fails the manager closed and reports terminal restart guidance", async () => {
  const hangingBrowser = new FakeBrowser();
  hangingBrowser.close = async () => new Promise<void>(() => undefined);
  let releaseLaunch!: () => void;
  const deferredLaunch = new Promise<Browser>((resolve) => { releaseLaunch = () => resolve(hangingBrowser as unknown as Browser); });
  let launchInvokedResolve!: () => void;
  const launchInvoked = new Promise<void>((resolve) => { launchInvokedResolve = resolve; });
  let serial = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => {
      launchInvokedResolve();
      return deferredLaunch;
    },
    randomHandle: (kind) => `${kind}_${++serial}_${"x".repeat(32)}`,
    limits: { cleanupMs: 150, navigationMs: 1_000 },
  });
  try {
    const browserOpen = toolHost(manager)("BrowserOpen");
    const controller = new AbortController();
    const opening = browserOpen.execute({ url: "https://example.com/" }, controller.signal);
    await launchInvoked;
    controller.abort(new Error("escape rewind marker"));
    releaseLaunch();
    await assert.rejects(opening, (error: Error) => {
      assert.match(error.message, /teardown could not be confirmed/);
      assert.match(error.message, /fail-closed/);
      assert.match(error.message, /restarting the Pi session/);
      assert.ok(error.message.length < 512);
      assert.doesNotMatch(error.message, /escape rewind marker/);
      return true;
    });
    await assert.rejects(browserOpen.execute({ url: "https://example.com/again" }), /restarting the Pi session/, "fail-closed manager blocks reuse with restart guidance");
  } finally {
    await manager.shutdown().catch(() => undefined);
  }
});

test("duplicate BrowserOpen after a lost rewind result reveals the authenticated live session for recovery", async () => {
  const { manager } = fixture();
  try {
    const call = toolHost(manager);
    const opened = await call("BrowserOpen").execute({ url: "https://example.com/" });
    const session: string = opened.details.response.session;
    await assert.rejects(call("BrowserOpen").execute({ url: "https://example.com/second" }), (error: Error) => {
      assert.match(error.message, /already open/);
      assert.match(error.message, /rewind or Escape/);
      assert.match(error.message, /BrowserTabs operation=list/);
      assert.match(error.message, /BrowserClose/);
      assert.ok(error.message.includes(session), "only the internally branded authenticated session handle is revealed");
      assert.ok(error.message.length < 512);
      assert.doesNotMatch(error.message, /example\.com\/second/, "no arbitrary caller text passthrough");
      return true;
    });
    assert.equal(manager.activeSessionCount(), 1, "duplicate open preserves the live session");
    const tabs = await call("BrowserTabs").execute({ session, operation: "list" });
    assert.deepEqual(
      tabs.details.response.tabs.map((entry: { tab: string }) => entry.tab),
      [opened.details.response.tab],
      "BrowserTabs list recovers the live session's owned tabs",
    );
    const closed = await call("BrowserClose").execute({ session });
    assert.match(closed.content[0].text, /quiescence confirmed/);
    assert.equal(manager.activeSessionCount(), 0);
  } finally {
    await manager.shutdown();
  }
});

test("a replacement manager rejects stale handles with BrowserOpen guidance and keeps its own session healthy", async () => {
  const previous = fixture();
  const previousOpened = await toolHost(previous.manager)("BrowserOpen").execute({ url: "https://example.com/old" });
  await previous.manager.shutdown();
  const replacement = fixture();
  try {
    const call = toolHost(replacement.manager);
    const opened = await call("BrowserOpen").execute({ url: "https://example.com/new" });
    await assert.rejects(call("BrowserSnapshot").execute({
      session: previousOpened.details.response.session,
      tab: previousOpened.details.response.tab,
    }), (error: Error) => {
      assert.match(error.message, /BrowserOpen/);
      assert.match(error.message, /BrowserSnapshot cannot recover/);
      assert.ok(error.message.length < 512);
      assert.doesNotMatch(error.message, /take a fresh BrowserSnapshot/, "stale cross-manager session never suggests an impossible snapshot");
      return true;
    });
    const snapshot = await call("BrowserSnapshot").execute({
      session: opened.details.response.session,
      tab: opened.details.response.tab,
    });
    assert.match(snapshot.details.response.snapshot, /Fixture/, "replacement manager's healthy session is intact");
  } finally {
    await replacement.manager.shutdown();
  }
});

test("BrowserClose with a foreign handle explains recovery via BrowserOpen and idempotent close still works", async () => {
  const { manager } = fixture();
  try {
    const call = toolHost(manager);
    const opened = await call("BrowserOpen").execute({ url: "https://example.com/" });
    for (const fabricated of ["unknown", "default"]) {
      await assert.rejects(call("BrowserClose").execute({ session: fabricated }), (error: Error) => {
        assert.match(error.message, /BrowserOpen/);
        assert.match(error.message, /no owned browser session was changed/);
        assert.ok(error.message.length < 512);
        return true;
      });
    }
    assert.equal(manager.activeSessionCount(), 1, "fabricated close handles leave the live session intact");
    const closed = await call("BrowserClose").execute({ session: opened.details.response.session });
    assert.match(closed.content[0].text, /quiescence confirmed/);
    const repeated = await call("BrowserClose").execute({ session: opened.details.response.session });
    assert.match(repeated.content[0].text, /already closed/, "same-owner close stays idempotent");
  } finally {
    await manager.shutdown();
  }
});

test("invalid tab handle lists the current real owned tabs without fabricated handles", async () => {
  const { manager } = fixture();
  try {
    const call = toolHost(manager);
    const opened = await call("BrowserOpen").execute({ url: "https://example.com/" });
    await assert.rejects(call("BrowserSnapshot").execute({
      session: opened.details.response.session,
      tab: "tab_forged",
    }), (error: Error) => {
      assert.match(error.message, /invalid or stale browser tab handle/);
      assert.match(error.message, /BrowserTabs operation=list/);
      assert.ok(error.message.includes(opened.details.response.tab), "real owned tab handle is listed");
      assert.doesNotMatch(error.message, /tab_forged/);
      assert.ok(error.message.length < 512);
      return true;
    });
    const snapshot = await call("BrowserSnapshot").execute({
      session: opened.details.response.session,
      tab: opened.details.response.tab,
    });
    assert.match(snapshot.details.response.snapshot, /Fixture/, "session survives invalid tab-handle use");
  } finally {
    await manager.shutdown();
  }
});

test("registered BrowserNavigate cancellation after dispatch reports unknown effects and confirmed teardown", async () => {
  const { manager, browser } = fixture();
  try {
    const call = toolHost(manager);
    const opened = await call("BrowserOpen").execute({ url: "https://example.com/" });
    const dispatchesBeforeNavigate = browser.context.page.gotoDispatches;
    browser.context.page.gotoGate = new Promise<void>(() => undefined);
    const controller = new AbortController();
    const navigating = call("BrowserNavigate").execute({
      session: opened.details.response.session,
      tab: opened.details.response.tab,
      url: "https://example.com/next",
    }, controller.signal);
    while (browser.context.page.gotoDispatches === dispatchesBeforeNavigate) await delay(5);
    controller.abort(new Error("escape rewind marker"));
    await assert.rejects(navigating, (error: Error) => {
      assert.match(error.message, /BrowserNavigate was cancelled after dispatch/);
      assert.match(error.message, /network effects may have occurred/);
      assert.match(error.message, /effect status is unknown/);
      assert.match(error.message, /no rollback is claimed/);
      assert.match(error.message, /Cleanup was confirmed/);
      assert.match(error.message, /use BrowserOpen to start a new browser session/);
      assert.ok(error.message.length < 512);
      assert.doesNotMatch(error.message, /escape rewind marker/);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "post-dispatch cancellation requires a fresh BrowserOpen");
  } finally {
    await manager.shutdown();
  }
});