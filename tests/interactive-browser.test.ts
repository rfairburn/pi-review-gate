import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { normalizeConfig } from "../src/config";
import {
  InteractiveBrowserManager,
  interactiveChromiumArgs,
  interactiveRouteDecision,
} from "../src/web/interactive-browser";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pngWithDimensions(width: number, height: number, bytes = ONE_PIXEL_PNG.byteLength) {
  const image = Buffer.alloc(Math.max(bytes, 24));
  ONE_PIXEL_PNG.subarray(0, Math.min(ONE_PIXEL_PNG.byteLength, image.byteLength)).copy(image);
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

class FakePage extends EventEmitter {
  private currentUrl = "about:blank";
  private closed = false;
  readonly frame = {};

  mainFrame() { return this.frame; }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async title() { return "Untrusted fixture title"; }
  viewportSize() { return { width: 1280, height: 720 }; }
  async ariaSnapshot() { return '- heading "Fixture" [level=1]\n- link "Next" [ref=e7]\n'; }
  async screenshot(_options?: Record<string, any>) { return ONE_PIXEL_PNG; }
  locator(selector: string) {
    assert.equal(selector, "aria-ref=e7", "only the Playwright ref retained from the semantic snapshot is used");
    return {
      scrollIntoViewIfNeeded: async () => undefined,
      boundingBox: async () => ({ x: 1, y: 2, width: 50, height: 20 }),
      screenshot: async () => { throw new Error("element screenshot must use a prevalidated page clip"); },
    };
  }
  async goto(url: string) {
    const request = {
      isNavigationRequest: () => true,
      frame: () => this.frame,
    };
    this.emit("request", request);
    this.currentUrl = url;
    this.emit("framenavigated", this.frame);
    return { status: () => 200 };
  }
  async waitForLoadState() {}
  async close() {
    if (this.closed) return;
    this.closed = true;
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
  async route() {}
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

function managerFixture(options: { cleanupMs?: number; hangingContextClose?: boolean } = {}) {
  const browser = new FakeBrowser();
  if (options.hangingContextClose) browser.context.close = async () => new Promise<void>(() => undefined);
  const config = normalizeConfig({}).web!.fetch;
  let serial = 0;
  const manager = new InteractiveBrowserManager(config, {
    resolveHostname: async (hostname: string) => net.isIP(hostname) ? [hostname] : ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    randomHandle: (kind: string) => `${kind}_${++serial}_${"x".repeat(32)}`,
    limits: options.cleanupMs === undefined ? undefined : { cleanupMs: options.cleanupMs },
  });
  return { manager, browser };
}

test("interactive browser route and launch policy has no direct-network escape hatch", () => {
  assert.equal(interactiveRouteDecision("image", "https://cdn.example/a.png").allowed, false);
  assert.equal(interactiveRouteDecision("font", "https://cdn.example/a.woff2").allowed, false);
  assert.equal(interactiveRouteDecision("media", "https://cdn.example/a.mp4").allowed, false);
  assert.equal(interactiveRouteDecision("media", "blob:https://example.com/media-id").allowed, false);
  assert.equal(interactiveRouteDecision("media", "data:video/mp4;base64,AAAA").allowed, false);
  assert.equal(interactiveRouteDecision("image", "blob:https://example.com/image-id").allowed, false);
  assert.equal(interactiveRouteDecision("image", "data:image/png;base64,AAAA").allowed, false);
  assert.equal(interactiveRouteDecision("font", "data:font/woff2;base64,AAAA").allowed, false);
  assert.equal(interactiveRouteDecision("eventsource", "https://example.com/events").allowed, false);
  assert.equal(interactiveRouteDecision("document", "file:///etc/passwd").allowed, false);
  assert.equal(interactiveRouteDecision("document", "mailto:test@example.com").allowed, false);
  assert.equal(interactiveRouteDecision("script", "data:text/javascript,void(0)").allowed, true);

  const args = interactiveChromiumArgs(4321).join(" ");
  assert.match(args, /proxy-server=http:\/\/127\.0\.0\.1:4321/);
  assert.match(args, /proxy-bypass-list=<-loopback>/);
  assert.match(args, /disable-quic/);
  assert.match(args, /disable_non_proxied_udp/);
  assert.match(args, /host-resolver-rules=MAP \* ~NOTFOUND/);
  assert.match(args, /blink-settings=imagesEnabled=false/);
  assert.match(args, /disable-remote-fonts/);
  assert.match(args, /disable-background-networking/);
});

test("BrowserOpen cancellation contains a browser that resolves after cancellation", async () => {
  const browser = new FakeBrowser();
  let releaseLaunch!: () => void;
  let announceLaunch!: () => void;
  const launched = new Promise<void>((resolve) => { announceLaunch = resolve; });
  const deferredLaunch = new Promise<Browser>((resolve) => {
    releaseLaunch = () => resolve(browser as unknown as Browser);
  });
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => {
      announceLaunch();
      return deferredLaunch;
    },
    limits: { cleanupMs: 100, navigationMs: 1_000 },
  });
  const controller = new AbortController();
  const opening = manager.open("https://example.com/start", controller.signal);
  await launched;
  controller.abort(new Error("cancel deferred launch"));
  releaseLaunch();
  await assert.rejects(opening, /cancel deferred launch/);
  assert.equal(browser.isConnected(), false, "late browser result is closed before BrowserOpen settles");
  assert.equal(manager.activeSessionCount(), 0);
});

test("shutdown aborts and awaits an in-progress BrowserOpen, then rejects future opens", async () => {
  const browser = new FakeBrowser();
  let releaseLaunch!: () => void;
  let announceLaunch!: () => void;
  const launched = new Promise<void>((resolve) => { announceLaunch = resolve; });
  const deferredLaunch = new Promise<Browser>((resolve) => {
    releaseLaunch = () => resolve(browser as unknown as Browser);
  });
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => {
      announceLaunch();
      return deferredLaunch;
    },
    limits: { cleanupMs: 100, navigationMs: 1_000 },
  });
  const opening = manager.open("https://example.com/start");
  const openingRejected = assert.rejects(opening, /cancelled by interactive browser shutdown/);
  await launched;
  const shuttingDown = manager.shutdown();
  releaseLaunch();
  await openingRejected;
  await shuttingDown;
  assert.equal(browser.isConnected(), false, "shutdown awaits containment of the late browser");
  assert.equal(manager.activeSessionCount(), 0);
  await assert.rejects(manager.open("https://example.com/after-shutdown"), /manager is shut down/);
});

test("shutdown preserves an unconfirmed in-progress-open teardown failure", async () => {
  const browser = new FakeBrowser();
  browser.close = async () => new Promise<void>(() => undefined);
  let releaseLaunch!: () => void;
  let announceLaunch!: () => void;
  const launched = new Promise<void>((resolve) => { announceLaunch = resolve; });
  const deferredLaunch = new Promise<Browser>((resolve) => {
    releaseLaunch = () => resolve(browser as unknown as Browser);
  });
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => {
      announceLaunch();
      return deferredLaunch;
    },
    limits: { cleanupMs: 10, navigationMs: 1_000 },
  });
  const opening = manager.open("https://example.com/start");
  const openingRejected = assert.rejects(opening, /teardown could not be confirmed/i);
  await launched;
  const shutdownRejected = assert.rejects(manager.shutdown(), /could not confirm quiescence/i);
  releaseLaunch();
  await openingRejected;
  await shutdownRejected;
  await assert.rejects(manager.shutdown(), /could not confirm quiescence/i);
});

test("open, navigate, semantic snapshot, handle rejection, and idempotent close are coherent", async () => {
  const { manager } = managerFixture();
  const opened = await manager.open("https://example.com/start");
  assert.match(opened.session, /^browser_session_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(opened.tab, /^tab_/);
  assert.equal(opened.status, 200);
  assert.equal(manager.activeSessionCount(), 1);

  const snapshot = await manager.snapshot(opened.session, opened.tab, 1_000);
  assert.match(snapshot.snapshot, /heading "Fixture"/);
  assert.match(snapshot.snapshot, new RegExp(`\\[ref=${snapshot.generation}_ref_`));
  assert.doesNotMatch(snapshot.snapshot, /ref=e7/);
  assert.equal(snapshot.truncation.truncated, false);
  const semanticRef = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(semanticRef);

  const viewport = await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
  assert.ok(Buffer.isBuffer(viewport.image));
  assert.equal(viewport.metadata.mode, "viewport");
  assert.equal(viewport.metadata.mimeType, "image/png");
  assert.equal(viewport.metadata.encodedBytes, ONE_PIXEL_PNG.byteLength);
  assert.deepEqual([viewport.metadata.width, viewport.metadata.height], [1, 1]);
  assert.equal("image" in viewport.metadata, false, "binary image data is not duplicated into metadata");

  const element = await manager.screenshot(opened.session, opened.tab, "element", semanticRef);
  assert.equal(element.metadata.mode, "element");
  assert.equal(element.metadata.ref, semanticRef);

  const navigated = await manager.navigate(opened.session, opened.tab, "https://example.com/next");
  assert.notEqual(navigated.generation, snapshot.generation, "navigation invalidates prior document refs");
  await assert.rejects(manager.snapshot(opened.session, "tab_forged", 1_000), /Invalid or stale/);
  await assert.rejects(manager.navigate("session_forged", opened.tab, "https://example.com", undefined), /Invalid or stale/);

  const firstClose = await manager.close(opened.session);
  assert.equal(firstClose.quiescent, true);
  assert.equal(firstClose.alreadyClosed, false);
  const secondClose = await manager.close(opened.session);
  assert.equal(secondClose.quiescent, true);
  assert.equal(secondClose.alreadyClosed, true);
  assert.equal(manager.activeSessionCount(), 0);
});

test("screenshot refs reject forged, stale, cross-session, and cross-tab use uniformly", async () => {
  const first = managerFixture();
  const firstOpened = await first.manager.open("https://example.com/first");
  const firstSnapshot = await first.manager.snapshot(firstOpened.session, firstOpened.tab, 1_000);
  const firstRef = firstSnapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(firstRef);

  await assert.rejects(
    first.manager.screenshot(firstOpened.session, "tab_forged", "element", firstRef),
    /Invalid or stale browser session\/tab handle/,
  );
  await assert.rejects(
    first.manager.screenshot(firstOpened.session, firstOpened.tab, "element", `${firstRef}_forged`),
    /fresh BrowserSnapshot/,
  );
  assert.equal(first.manager.activeSessionCount(), 0, "invalid element refs fail closed and clean up the session");

  const stale = managerFixture();
  const staleOpened = await stale.manager.open("https://example.com/stale");
  const staleSnapshot = await stale.manager.snapshot(staleOpened.session, staleOpened.tab, 1_000);
  const staleRef = staleSnapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(staleRef);
  await stale.manager.navigate(staleOpened.session, staleOpened.tab, "https://example.com/new-document");
  await assert.rejects(
    stale.manager.screenshot(staleOpened.session, staleOpened.tab, "element", staleRef),
    /fresh BrowserSnapshot/,
  );

  const crossBrowsers = [new FakeBrowser(), new FakeBrowser()];
  let crossSerial = 0;
  const crossManager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => crossBrowsers.shift() as unknown as Browser,
    randomHandle: (kind: string) => `${kind}_${++crossSerial}_${"c".repeat(32)}`,
  });
  const sourceSession = await crossManager.open("https://example.com/source-session");
  const sourceSnapshot = await crossManager.snapshot(sourceSession.session, sourceSession.tab, 1_000);
  const sourceRef = sourceSnapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(sourceRef);
  const targetSession = await crossManager.open("https://example.com/target-session");
  await crossManager.snapshot(targetSession.session, targetSession.tab, 1_000);
  await assert.rejects(
    crossManager.screenshot(targetSession.session, targetSession.tab, "element", sourceRef),
    /fresh BrowserSnapshot/,
  );
  await Promise.all([first.manager.shutdown(), stale.manager.shutdown(), crossManager.shutdown()]);
});

test("element screenshot fixes the validated clip before a resize race", async () => {
  const fixture = managerFixture();
  let elementWidth = 40.2;
  let screenshotOptions: Record<string, any> | undefined;
  fixture.browser.context.page.locator = (selector: string) => {
    assert.equal(selector, "aria-ref=e7");
    return {
      scrollIntoViewIfNeeded: async () => undefined,
      boundingBox: async () => {
        queueMicrotask(() => { elementWidth = 10_000; });
        return { x: 10.4, y: 20.2, width: elementWidth, height: 19.2 };
      },
      screenshot: async () => { throw new Error("unbounded locator screenshot must not run"); },
    };
  };
  fixture.browser.context.page.screenshot = async (options?: Record<string, any>) => {
    await Promise.resolve();
    assert.equal(elementWidth, 10_000, "fixture element changed after bounds acquisition");
    screenshotOptions = options;
    return pngWithDimensions(options!.clip.width, options!.clip.height);
  };
  const opened = await fixture.manager.open("https://example.com/resize-race");
  const snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);
  const captured = await fixture.manager.screenshot(opened.session, opened.tab, "element", ref);
  assert.deepEqual(screenshotOptions?.clip, { x: 10, y: 20, width: 41, height: 20 });
  assert.equal(screenshotOptions?.animations, "allow", "finite animations must not be fast-forwarded after preflight");
  assert.equal(screenshotOptions?.fullPage, false);
  assert.deepEqual([captured.metadata.width, captured.metadata.height], [41, 20]);
  await fixture.manager.close(opened.session);
});

test("screenshot validates final encoded bytes, decoded dimensions, and allocation before delivery", async () => {
  const oversizedBytes = managerFixture();
  oversizedBytes.browser.context.page.screenshot = async () => pngWithDimensions(1, 1, 128);
  const bytesManager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => oversizedBytes.browser as unknown as Browser,
    limits: { maxScreenshotBytes: 100, cleanupMs: 100 },
  });
  const bytesOpened = await bytesManager.open("https://example.com/bytes");
  await assert.rejects(
    bytesManager.screenshot(bytesOpened.session, bytesOpened.tab, "viewport", undefined),
    /100-byte encoded output limit/,
  );
  assert.equal(bytesManager.activeSessionCount(), 0);

  const oversizedDimensions = managerFixture();
  oversizedDimensions.browser.context.page.screenshot = async () => pngWithDimensions(2_001, 1);
  const dimensionsManager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => oversizedDimensions.browser as unknown as Browser,
    limits: { cleanupMs: 100 },
  });
  const dimensionsOpened = await dimensionsManager.open("https://example.com/dimensions");
  await assert.rejects(
    dimensionsManager.screenshot(dimensionsOpened.session, dimensionsOpened.tab, "viewport", undefined),
    /final PNG exceeds the bounded image limits/,
  );
  assert.equal(dimensionsManager.activeSessionCount(), 0);

  const allocation = managerFixture();
  allocation.browser.context.page.viewportSize = () => ({ width: 100, height: 100 });
  allocation.browser.context.page.screenshot = async () => pngWithDimensions(100, 100);
  const allocationManager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => allocation.browser as unknown as Browser,
    limits: { maxScreenshotAllocationBytes: 40_100, cleanupMs: 100 },
  });
  const allocationOpened = await allocationManager.open("https://example.com/allocation");
  await assert.rejects(
    allocationManager.screenshot(allocationOpened.session, allocationOpened.tab, "viewport", undefined),
    /allocation limit/,
  );
  assert.equal(allocationManager.activeSessionCount(), 0);
});

test("screenshot cancellation fails clearly and confirms session cleanup", async () => {
  const fixture = managerFixture();
  let announce!: () => void;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  fixture.browser.context.page.screenshot = async () => {
    announce();
    return new Promise<typeof ONE_PIXEL_PNG>(() => undefined);
  };
  const opened = await fixture.manager.open("https://example.com/cancel-image");
  const controller = new AbortController();
  const capture = fixture.manager.screenshot(opened.session, opened.tab, "viewport", undefined, controller.signal);
  await started;
  controller.abort(new Error("cancel screenshot test"));
  await assert.rejects(capture, /cancel screenshot test/);
  assert.equal(fixture.manager.activeSessionCount(), 0);
  assert.equal((await fixture.manager.close(opened.session)).alreadyClosed, true);
});

test("screenshot rejects captured bytes when the document generation changes mid-capture", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/changing-image");
  let release!: (image: typeof ONE_PIXEL_PNG) => void;
  let announce!: () => void;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  fixture.browser.context.page.screenshot = async () => {
    announce();
    return new Promise<typeof ONE_PIXEL_PNG>((resolve) => { release = resolve; });
  };
  const capture = fixture.manager.screenshot(opened.session, opened.tab, "viewport", undefined);
  await started;
  fixture.browser.context.page.emit("framenavigated", fixture.browser.context.page.frame);
  release(ONE_PIXEL_PNG);
  await assert.rejects(capture, /document changed during screenshot capture/i);
  assert.equal(fixture.manager.activeSessionCount(), 0);
});

test("screenshots reject closed and unexpectedly lost sessions without returning bytes", async () => {
  const closed = managerFixture();
  const closedOpened = await closed.manager.open("https://example.com/closed");
  await closed.manager.close(closedOpened.session);
  await assert.rejects(
    closed.manager.screenshot(closedOpened.session, closedOpened.tab, "viewport", undefined),
    /Invalid or stale browser session\/tab handle/,
  );

  const lost = managerFixture();
  const lostOpened = await lost.manager.open("https://example.com/lost");
  await lost.browser.context.page.close();
  await assert.rejects(
    lost.manager.screenshot(lostOpened.session, lostOpened.tab, "viewport", undefined),
    /closed unexpectedly|Invalid or stale|teardown/i,
  );
  await lost.manager.close(lostOpened.session);
  assert.equal(lost.manager.activeSessionCount(), 0);
  await Promise.all([closed.manager.shutdown(), lost.manager.shutdown()]);
});

test("navigation uses one absolute deadline across validation and page phases", async () => {
  const browser = new FakeBrowser();
  let phaseDelayMs = 0;
  const originalGoto = browser.context.page.goto.bind(browser.context.page);
  browser.context.page.goto = async (url: string) => {
    if (phaseDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, phaseDelayMs));
    return originalGoto(url);
  };
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => {
      if (phaseDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, phaseDelayMs));
      return ["93.184.216.34"];
    },
    launch: async () => browser as unknown as Browser,
    limits: { navigationMs: 80, cleanupMs: 100 },
  });
  const opened = await manager.open("https://example.com/start");
  phaseDelayMs = 55;
  const started = Date.now();
  await assert.rejects(
    manager.navigate(opened.session, opened.tab, "https://example.com/slow"),
    /80ms total deadline/,
  );
  assert.ok(Date.now() - started < 105, "phases must not each receive a fresh 80ms allowance");
  assert.equal(manager.activeSessionCount(), 0);
});

test("BrowserOpen setup phases share one absolute deadline", async () => {
  const browser = new FakeBrowser();
  browser.context.clearPermissions = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 55));
  };
  browser.context.routeWebSocket = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 55));
  };
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    limits: { navigationMs: 80, cleanupMs: 100 },
  });
  const started = Date.now();
  await assert.rejects(manager.open("https://example.com/start"), /80ms total deadline/);
  assert.ok(Date.now() - started < 105, "open setup phases must share the advertised deadline");
  assert.equal(browser.isConnected(), false);
  assert.equal(manager.activeSessionCount(), 0);
});

test("snapshot acquisition and metadata reads share one absolute deadline", async () => {
  const boundedBrowser = new FakeBrowser();
  boundedBrowser.context.page.ariaSnapshot = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 55));
    return '- heading "slow snapshot"';
  };
  boundedBrowser.context.page.title = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 55));
    return "slow title";
  };
  const boundedManager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => boundedBrowser as unknown as Browser,
    limits: { actionMs: 80, cleanupMs: 100 },
  });
  const boundedOpened = await boundedManager.open("https://example.com/start");
  const started = Date.now();
  await assert.rejects(
    boundedManager.snapshot(boundedOpened.session, boundedOpened.tab, 1_000),
    /80ms total deadline/,
  );
  assert.ok(Date.now() - started < 105, "snapshot phases must not each receive a fresh allowance");
  assert.equal(boundedManager.activeSessionCount(), 0);
});

test("snapshot rejects evidence when the document generation changes mid-capture", async () => {
  const { manager, browser } = managerFixture();
  const opened = await manager.open("https://example.com/start");
  let resolveSnapshot!: (value: string) => void;
  let announceSnapshot!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => { announceSnapshot = resolve; });
  browser.context.page.ariaSnapshot = async () => {
    announceSnapshot();
    return new Promise<string>((resolve) => { resolveSnapshot = resolve; });
  };
  const snapshot = manager.snapshot(opened.session, opened.tab, 1_000);
  await snapshotStarted;
  browser.context.page.emit("framenavigated", browser.context.page.frame);
  resolveSnapshot('- link "old document" [ref=e1]');
  await assert.rejects(snapshot, /document changed during semantic snapshot/i);
  assert.equal(manager.activeSessionCount(), 0);
});

test("confirmed close remains idempotent after successful diagnostics are evicted", async () => {
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => new FakeBrowser() as unknown as Browser,
  });
  let earliest = "";
  for (let index = 0; index < 40; index += 1) {
    const opened = await manager.open(`https://example.com/${index}`);
    if (index === 0) earliest = opened.session;
    assert.equal((await manager.close(opened.session)).alreadyClosed, false);
  }
  const repeated = await manager.close(earliest);
  assert.equal(repeated.alreadyClosed, true);
  assert.equal(repeated.quiescent, true);
  assert.equal(repeated.diagnosticsRetained, false);
  assert.equal(repeated.broker, null);
  const forged = `${earliest.slice(0, -1)}${earliest.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(manager.close(forged), /Invalid or stale/);
});

test("semantic output and cumulative action budgets are hard-capped", async () => {
  const browser = new FakeBrowser();
  browser.context.page.ariaSnapshot = async () => `- paragraph "${"untrusted ".repeat(500)}"`;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    limits: { maxSnapshotChars: 1_000, maxActions: 1 },
  });
  const opened = await manager.open("https://example.com/start");
  const snapshot = await manager.snapshot(opened.session, opened.tab, 24_000);
  assert.equal(snapshot.snapshot.length, 1_000);
  assert.deepEqual(snapshot.truncation, {
    truncated: true,
    originalChars: 5_014,
    returnedChars: 1_000,
    maxChars: 1_000,
  });
  await assert.rejects(manager.snapshot(opened.session, opened.tab, 1_000), /action limit/i);
  assert.equal(manager.activeSessionCount(), 0);
  assert.equal((await manager.close(opened.session)).alreadyClosed, true);
});

test("real Chromium follows a public redirect only through the pinned broker dial", async () => {
  const origin = createServer((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: `http://redirect.test:${(origin.address() as AddressInfo).port}/final` });
      response.end();
      return;
    }
    if (request.url === "/private-redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${(origin.address() as AddressInfo).port}/private` });
      response.end();
      return;
    }
    if (request.url === "/animated") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Animated element</title><style>
        @keyframes grow { from { width: 64px; height: 24px } to { width: 10000px; height: 10000px } }
        #animated { display: block; width: 64px; height: 24px; overflow: hidden;
          animation: grow 1s linear forwards; animation-play-state: paused; }
      </style><a id="animated" href="/next">Animated bounded link</a>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Redirect complete</title><main><h1>Brokered evidence</h1><a href='/next'>Next</a></main>");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as AddressInfo).port;
  const dials: string[] = [];
  const config = normalizeConfig({}).web!.fetch;
  const manager = new InteractiveBrowserManager(config, {
    resolveHostname: async (hostname: string) => net.isIP(hostname) ? [hostname] : ["93.184.216.34"],
    brokerDial: (validated, port) => {
      dials.push(`${validated.hostname}:${port}:${validated.addresses[0]}`);
      return net.connect({ host: "127.0.0.1", port });
    },
  });
  try {
    const opened = await manager.open(`http://public.test:${originPort}/start`);
    assert.equal(opened.url, `http://redirect.test:${originPort}/final`);
    assert.equal(opened.status, 200);
    assert.ok(dials.some((dial) => dial.startsWith(`public.test:${originPort}:93.184.216.34`)));
    assert.ok(dials.some((dial) => dial.startsWith(`redirect.test:${originPort}:93.184.216.34`)));
    const snapshot = await manager.snapshot(opened.session, opened.tab, 2_000);
    assert.match(snapshot.snapshot, /Brokered evidence/);
    const viewportImage = await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    assert.deepEqual([viewportImage.metadata.width, viewportImage.metadata.height], [1_280, 720]);
    assert.ok(viewportImage.metadata.encodedBytes <= viewportImage.metadata.limits.maxEncodedBytes);
    assert.equal(viewportImage.image.subarray(1, 4).toString("ascii"), "PNG");
    const linkRef = snapshot.snapshot.match(/link "Next" \[ref=([^\]]+)\]/)?.[1];
    assert.ok(linkRef, "real AI snapshot exposes a current semantic ref");
    const elementImage = await manager.screenshot(opened.session, opened.tab, "element", linkRef);
    assert.equal(elementImage.metadata.mode, "element");
    assert.ok(elementImage.metadata.width > 0 && elementImage.metadata.height > 0);

    await manager.navigate(opened.session, opened.tab, `http://public.test:${originPort}/animated`);
    const animatedSnapshot = await manager.snapshot(opened.session, opened.tab, 2_000);
    const animatedRef = animatedSnapshot.snapshot.match(/link "Animated bounded link" \[ref=([^\]]+)\]/)?.[1];
    assert.ok(animatedRef);
    const animatedImage = await manager.screenshot(opened.session, opened.tab, "element", animatedRef);
    assert.ok(animatedImage.metadata.width <= 65 && animatedImage.metadata.height <= 25,
      "paused finite animation is not fast-forwarded to its oversized final keyframe after preflight");

    await assert.rejects(
      manager.navigate(opened.session, opened.tab, `http://public.test:${originPort}/private-redirect`),
      /egress policy|ERR_FAILED|navigation/i,
    );
    assert.equal(dials.some((dial) => dial.startsWith("127.0.0.1:")), false, "private redirect is refused before dial");
    const closed = await manager.close(opened.session);
    assert.equal(closed.quiescent, true);
    assert.equal(closed.alreadyClosed, true);
    assert.ok(closed.broker && closed.broker.connections >= 2);
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve()));
  }
});

test("real Chromium does not load data/blob images or custom downloadable fonts", async () => {
  const requests: string[] = [];
  const origin = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/font.ttf") {
      response.writeHead(200, { "content-type": "font/ttf" });
      response.end(Buffer.alloc(256, 1));
      return;
    }
    const port = (origin.address() as AddressInfo).port;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Visual blocking</title><main>
      <p id="data-status">data image pending</p>
      <p id="blob-status">blob image pending</p>
      <p id="font-status">custom font pending</p>
    </main><script>
      const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const watchImage = (image, id, label) => {
        const status = document.getElementById(id);
        image.onload = () => status.textContent = label + " loaded";
        image.onerror = () => status.textContent = label + " blocked";
        setTimeout(() => { if (status.textContent.endsWith("pending")) status.textContent = label + " blocked"; }, 150);
      };
      const dataImage = new Image();
      watchImage(dataImage, "data-status", "data image");
      dataImage.src = "data:image/png;base64," + pixel;
      const bytes = Uint8Array.from(atob(pixel), character => character.charCodeAt(0));
      const blobImage = new Image();
      watchImage(blobImage, "blob-status", "blob image");
      blobImage.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      const fontStatus = document.getElementById("font-status");
      try {
        new FontFace("BlockedCustom", "url(http://visual.test:${port}/font.ttf)").load()
          .then(() => fontStatus.textContent = "custom font loaded")
          .catch(() => fontStatus.textContent = "custom font blocked");
      } catch { fontStatus.textContent = "custom font blocked"; }
      setTimeout(() => { if (fontStatus.textContent.endsWith("pending")) fontStatus.textContent = "custom font blocked"; }, 150);
    </script>`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as AddressInfo).port;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, requestedPort) => net.connect({ host: "127.0.0.1", port: requestedPort }),
  });
  try {
    const opened = await manager.open(`http://visual.test:${port}/visual`);
    const snapshot = await manager.snapshot(opened.session, opened.tab, 4_000);
    assert.match(snapshot.snapshot, /data image blocked/);
    assert.match(snapshot.snapshot, /blob image blocked/);
    assert.match(snapshot.snapshot, /custom font blocked/);
    assert.doesNotMatch(snapshot.snapshot, /(?:data image|blob image|custom font) loaded/);
    assert.equal(requests.includes("/font.ttf"), false, "custom font is blocked before broker/origin transfer");
    await manager.close(opened.session);
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve()));
  }
});

test("private destinations fail before launch and cancellation tears down an active session", async () => {
  const config = normalizeConfig({}).web!.fetch;
  let launches = 0;
  const blocked = new InteractiveBrowserManager(config, {
    resolveHostname: async () => ["127.0.0.1"],
    launch: async () => { launches += 1; return new FakeBrowser() as unknown as Browser; },
  });
  await assert.rejects(blocked.open("http://localhost/private"), /non-public|blocked/i);
  assert.equal(launches, 0);

  const { manager } = managerFixture();
  const opened = await manager.open("https://example.com/start");
  await assert.rejects(
    manager.navigate(opened.session, opened.tab, "http://127.0.0.1/private"),
    /non-public|blocked/i,
  );
  assert.equal(manager.activeSessionCount(), 0, "a private navigation tears down the session fail-closed");

  const cancellationFixture = managerFixture();
  const cancellable = await cancellationFixture.manager.open("https://example.com/start");
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(
    cancellationFixture.manager.navigate(cancellable.session, cancellable.tab, "https://example.com/next", controller.signal),
    /cancelled by test/,
  );
  assert.equal(cancellationFixture.manager.activeSessionCount(), 0);
  const closed = await cancellationFixture.manager.close(cancellable.session);
  assert.equal(closed.quiescent, true);
  assert.equal(closed.alreadyClosed, true);
});

test("close never claims success when browser/context quiescence is unconfirmed", async () => {
  const { manager } = managerFixture({ cleanupMs: 10, hangingContextClose: true });
  const opened = await manager.open("https://example.com/start");
  await assert.rejects(manager.close(opened.session), /closure is unconfirmed/i);
  await assert.rejects(manager.close(opened.session), /closure is unconfirmed/i);
});
