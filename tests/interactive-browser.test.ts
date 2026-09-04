import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { normalizeConfig } from "../src/config";
import type { BrowserTargetStructure } from "../src/web/browser-interaction-policy";
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
  private visited: string[] = [];
  private visitedIndex = -1;
  readonly frame = {};
  evaluateCalls = 0;
  hoverCalls = 0;
  clickCalls = 0;
  fillCalls: string[] = [];
  typeCalls: Array<{ text: string; delay: number }> = [];
  selectCalls: Array<Array<{ value?: string; label?: string }>> = [];
  pressCalls: string[] = [];
  onClick?: () => void | Promise<void>;
  targetStructure: BrowserTargetStructure = {
    tagName: "a", role: "link", href: "https://example.com/next", target: null,
    download: false, inputType: null, formAssociated: false, formAction: null,
    formMethod: null, ariaHasPopup: null, contentEditable: false, disabled: false,
    inlineEventHandler: false, summaryForDetails: false,
    domPath: "html:nth-of-type(1)> body:nth-of-type(1)> a:nth-of-type(1)",
  };
  readonly visibleTextMatches = new Map<string, number>();
  inspectDelayMs = 0;

  mainFrame() { return this.frame; }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async title() { return "Untrusted fixture title"; }
  viewportSize() { return { width: 1280, height: 720 }; }
  async ariaSnapshot() { return '- heading "Fixture" [level=1]\n- link "Next" [ref=e7]\n'; }
  async screenshot(_options?: Record<string, any>) { return ONE_PIXEL_PNG; }
  async evaluate() { this.evaluateCalls += 1; }
  async bringToFront() {}
  getByRole(role: string, options: { name?: string } = {}) {
    return { fixtureRole: role, fixtureName: options.name ?? "" };
  }
  getByText(text: string) {
    return {
      filter: ({ visible }: { visible: boolean }) => {
        assert.equal(visible, true);
        return {
          first: () => ({
            waitFor: async ({ state }: { state: string }) => {
              const visibleCount = this.visibleTextMatches.has(text)
                ? this.visibleTextMatches.get(text)!
                : text === "Missing" ? 0 : 1;
              if (state === "attached" && visibleCount === 0) throw new Error("no visible text match");
              if (state === "hidden" && visibleCount > 0) throw new Error("visible text match remains");
            },
          }),
        };
      },
    };
  }
  async waitForURL(predicate: (url: URL) => boolean) {
    if (!predicate(new URL(this.currentUrl))) throw new Error("fixture URL condition not satisfied");
  }
  async waitForNavigation() {}
  async waitForTimeout(durationMs: number) { await new Promise<void>((resolve) => setTimeout(resolve, durationMs)); }
  locator(selector: string): any {
    if (selector !== "aria-ref=e7") return { fixtureTag: selector };
    const page = this;
    return {
      scrollIntoViewIfNeeded: async () => undefined,
      waitFor: async () => undefined,
      getAttribute: async (name: string) => name === "type"
        ? page.targetStructure.inputType
        : name === "role" ? page.targetStructure.role
          : name === "href" ? page.targetStructure.href
            : name === "aria-description" ? "Fixture description" : null,
      ariaSnapshot: async () => {
        if (page.inspectDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, page.inspectDelayMs));
        const role = page.targetStructure.role ?? (page.targetStructure.tagName === "input" ? "textbox" : "generic");
        return `- ${role} "Next"${page.targetStructure.disabled ? " [disabled]" : ""} [ref=e7]`;
      },
      isDisabled: async () => page.targetStructure.disabled,
      isEditable: async () => page.targetStructure.contentEditable || ["input", "textarea", "select"].includes(page.targetStructure.tagName),
      isChecked: async () => { throw new Error("not checkable"); },
      innerText: async () => {
        if (page.inspectDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, page.inspectDelayMs));
        return "Visible fixture text";
      },
      and: (other: { fixtureTag?: string; fixtureRole?: string; fixtureName?: string }) => ({
        count: async () => {
          if (other.fixtureRole) {
            const role = page.targetStructure.role ?? (page.targetStructure.tagName === "input" ? "textbox" : "generic");
            return other.fixtureRole === role && other.fixtureName === "Next" ? 1 : 0;
          }
          return other.fixtureTag === page.targetStructure.tagName ? 1 : 0;
        },
      }),
      evaluate: async (_callback: unknown, ...args: unknown[]) => {
        if (Array.isArray(args[0])) return args[0].map(() => "value");
        if (args[0] === "append") return true;
        if (args.length > 0) return undefined;
        return { ...page.targetStructure };
      },
      hover: async () => { this.hoverCalls += 1; },
      click: async () => { this.clickCalls += 1; await this.onClick?.(); },
      fill: async (value: string) => { this.fillCalls.push(value); },
      pressSequentially: async (text: string, options: { delay?: number }) => {
        this.typeCalls.push({ text, delay: options.delay ?? 0 });
      },
      selectOption: async (options: Array<{ value?: string; label?: string }>) => {
        this.selectCalls.push(options);
      },
      press: async (key: string) => { this.pressCalls.push(key); },
      boundingBox: async () => ({ x: 1, y: 2, width: 50, height: 20 }),
      screenshot: async () => { throw new Error("element screenshot must use a prevalidated page clip"); },
    };
  }
  private commit(url: string, addHistory: boolean) {
    const request = {
      isNavigationRequest: () => true,
      frame: () => this.frame,
      redirectedFrom: () => null,
    };
    this.emit("request", request);
    this.currentUrl = url;
    if (addHistory) {
      this.visited.splice(this.visitedIndex + 1);
      this.visited.push(url);
      this.visitedIndex = this.visited.length - 1;
    }
    this.emit("framenavigated", this.frame);
    return { status: () => 200 };
  }
  async goto(url: string) { return this.commit(url, true); }
  async goBack() {
    if (this.visitedIndex <= 0) return null;
    this.visitedIndex -= 1;
    return this.commit(this.visited[this.visitedIndex]!, false);
  }
  async goForward() {
    if (this.visitedIndex >= this.visited.length - 1) return null;
    this.visitedIndex += 1;
    return this.commit(this.visited[this.visitedIndex]!, false);
  }
  async reload() { return this.commit(this.currentUrl, false); }
  async waitForLoadState() {}
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeContext extends EventEmitter {
  readonly page = new FakePage();
  readonly pages = [this.page];
  private created = 0;
  configureNextPage?: (page: FakePage) => void;
  routeHandler?: (route: any) => Promise<void>;
  nextPageDelayMs = 0;
  closed = false;
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async clearPermissions() {}
  async routeWebSocket() {}
  async route(_pattern: string, handler: (route: any) => Promise<void>) { this.routeHandler = handler; }
  async newPage() {
    const delayMs = this.created > 0 ? this.nextPageDelayMs : 0;
    this.nextPageDelayMs = 0;
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    const page = this.created++ === 0 ? this.page : new FakePage();
    if (!this.pages.includes(page)) this.pages.push(page);
    const configure = this.configureNextPage;
    this.configureNextPage = undefined;
    configure?.(page);
    this.emit("page", page);
    return page as unknown as Page;
  }
  async close() {
    this.closed = true;
    await Promise.all(this.pages.map((page) => page.close()));
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

function managerFixture(options: { cleanupMs?: number; hangingContextClose?: boolean; limits?: Record<string, number> } = {}) {
  const browser = new FakeBrowser();
  if (options.hangingContextClose) browser.context.close = async () => new Promise<void>(() => undefined);
  const config = normalizeConfig({}).web!.fetch;
  let serial = 0;
  const manager = new InteractiveBrowserManager(config, {
    resolveHostname: async (hostname: string) => net.isIP(hostname) ? [hostname] : ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    randomHandle: (kind: string) => `${kind}_${++serial}_${"x".repeat(32)}`,
    limits: { ...(options.limits ?? {}), ...(options.cleanupMs === undefined ? {} : { cleanupMs: options.cleanupMs }) },
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

test("quiescence drains an established session after another opening records teardown failure", async () => {
  const establishedBrowser = new FakeBrowser();
  const failingBrowser = new FakeBrowser();
  failingBrowser.close = async () => new Promise<void>(() => undefined);
  let releaseSecondLaunch!: () => void;
  let announceSecondLaunch!: () => void;
  const secondLaunched = new Promise<void>((resolve) => { announceSecondLaunch = resolve; });
  const deferredSecondLaunch = new Promise<Browser>((resolve) => {
    releaseSecondLaunch = () => resolve(failingBrowser as unknown as Browser);
  });
  let launches = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => {
      launches += 1;
      if (launches === 1) return establishedBrowser as unknown as Browser;
      announceSecondLaunch();
      return deferredSecondLaunch;
    },
    limits: { cleanupMs: 10, navigationMs: 1_000 },
  });
  await manager.open("https://example.com/established");
  const secondOpen = manager.open("https://example.com/failing-open");
  await secondLaunched;
  const barrier = manager.quiesce();
  releaseSecondLaunch();
  await assert.rejects(secondOpen, /teardown could not be confirmed/i);
  await assert.rejects(barrier, /could not confirm quiescence/i);
  assert.equal(establishedBrowser.isConnected(), false, "the established browser is drained despite the prior failure");
  assert.equal(manager.activeSessionCount(), 0);
});

test("settlement quiescence aborts an in-flight screenshot, proves zero ownership, and permits reuse", async () => {
  const browsers: FakeBrowser[] = [];
  let serial = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => {
      const browser = new FakeBrowser();
      browsers.push(browser);
      return browser as unknown as Browser;
    },
    randomHandle: (kind: string) => `${kind}_${++serial}_${"x".repeat(32)}`,
    limits: { cleanupMs: 100 },
  });
  const opened = await manager.open("https://example.com/first");
  let screenshotStarted!: () => void;
  const started = new Promise<void>((resolve) => { screenshotStarted = resolve; });
  browsers[0]!.context.page.screenshot = async () => {
    screenshotStarted();
    return new Promise<typeof ONE_PIXEL_PNG>(() => undefined);
  };
  const screenshot = manager.screenshot(opened.session, opened.tab, "viewport", undefined);
  await started;
  const barrier = manager.quiesce();
  await assert.rejects(screenshot, /agent settlement/);
  await barrier;
  assert.equal(manager.activeSessionCount(), 0);
  assert.equal(browsers[0]!.isConnected(), false);

  const reused = await manager.open("https://example.com/later-turn");
  assert.equal(manager.activeSessionCount(), 1);
  await manager.close(reused.session);
});

test("an unconfirmed settlement teardown permanently fails the browser manager closed", async () => {
  const { manager } = managerFixture({ hangingContextClose: true, cleanupMs: 10 });
  await manager.open("https://example.com/unconfirmed");
  await assert.rejects(manager.quiesce(), /could not confirm quiescence/i);
  await assert.rejects(manager.quiesce(), /could not confirm quiescence/i);
  await assert.rejects(manager.open("https://example.com/must-not-reopen"), /could not confirm quiescence/i);
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

test("BrowserScroll accepts only bounded page/ref operations and current scoped refs", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/scroll");
  const snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);

  const page = await fixture.manager.scroll(opened.session, opened.tab, "page", "down", 2, undefined);
  assert.equal(page.generation, snapshot.generation);
  assert.equal(fixture.browser.context.page.evaluateCalls, 1);
  const container = await fixture.manager.scroll(opened.session, opened.tab, "ref_container", "up", 1, ref);
  assert.equal(container.ref, ref);
  const positioned = await fixture.manager.scroll(opened.session, opened.tab, "ref", undefined, 1, ref);
  assert.equal(positioned.target, "ref");

  await assert.rejects(
    fixture.manager.scroll(opened.session, opened.tab, "page", "down", 4, undefined),
    /integer from 1-3/,
  );
  await assert.rejects(
    fixture.manager.scroll(opened.session, "tab_forged", "ref", undefined, 1, ref),
    /Invalid or stale browser session\/tab handle/,
  );
  await assert.rejects(
    fixture.manager.scroll(opened.session, opened.tab, "ref", undefined, 1, `${ref}_forged`),
    /fresh BrowserSnapshot/,
  );
  assert.equal(fixture.manager.activeSessionCount(), 0, "invalid semantic capabilities fail the session closed");
});

test("BrowserHover and structurally proven link clicks use only fresh refs and invalidate them", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/interaction");
  let snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  let ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);

  const hovered = await fixture.manager.hover(opened.session, opened.tab, ref);
  assert.equal(hovered.operation, "hover");
  assert.equal(hovered.effect, "completed");
  assert.equal(fixture.browser.context.page.hoverCalls, 1);
  await assert.rejects(fixture.manager.hover(opened.session, opened.tab, ref), /fresh BrowserSnapshot/);

  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "summary", role: null, href: null, inputType: null, summaryForDetails: true,
  };
  snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);
  const disclosed = await fixture.manager.click(opened.session, opened.tab, ref);
  assert.equal(disclosed.consequence, "local_disclosure");
  assert.equal(disclosed.confirmed, false);

  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "a", role: "link", href: "https://example.com/next", summaryForDetails: false,
  };
  snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);
  fixture.browser.context.page.onClick = () => fixture.browser.context.page.goto("https://example.com/next?private=redacted").then(() => undefined);
  const clicked = await fixture.manager.click(opened.session, opened.tab, ref);
  assert.equal(clicked.consequence, "ordinary_navigation");
  assert.equal(clicked.confirmed, false);
  assert.equal(clicked.effects.navigation, "observed");
  assert.equal(clicked.url, "https://example.com", "interaction output redacts path and query");
  assert.equal(fixture.browser.context.page.clickCalls, 0, "silent activation never dispatches page click handlers");
  await assert.rejects(fixture.manager.click(opened.session, opened.tab, ref), /fresh BrowserSnapshot/);
  await fixture.manager.shutdown();
});

test("bounded form controls replace, append, multi-select, enforce key grammar, and keep values secret", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/form");
  const freshRef = async () => {
    const snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
    const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
    assert.ok(ref);
    return ref;
  };
  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "input", role: "textbox", href: null, inputType: "text",
    formAssociated: true, autocomplete: null, readOnly: false, multiple: false,
    explicitChangeHandler: false, explicitSubmitHandler: false,
    pageControlledEventsAbsent: true,
  };

  const secret = "ordinary text and ghp_abcdefghijklmnopqrstuvwxyz123456";
  const filled = await fixture.manager.fill(opened.session, opened.tab, await freshRef(), secret);
  assert.equal(filled.consequence, "local_editing");
  assert.equal(filled.confirmed, false);
  assert.equal(filled.effects.network, "not_observed");
  assert.equal(JSON.stringify(filled).includes(secret), false);
  assert.deepEqual(fixture.browser.context.page.fillCalls, [secret]);

  const appended = " appended";
  await fixture.manager.type(opened.session, opened.tab, await freshRef(), appended, 2);
  assert.deepEqual(fixture.browser.context.page.typeCalls, [{ text: appended, delay: 2 }]);

  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "select", role: "listbox", inputType: null, multiple: true,
  };
  const choices = ["Private A", "Private B"];
  const selected = await fixture.manager.select(opened.session, opened.tab, await freshRef(), choices);
  assert.equal(selected.consequence, "local_editing");
  assert.deepEqual(fixture.browser.context.page.selectCalls, [[{ value: "Private A" }, { value: "Private B" }]]);
  assert.equal(JSON.stringify(selected).includes("Private"), false);

  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "textarea", role: "textbox", inputType: null, multiple: false,
  };
  await fixture.manager.press(opened.session, opened.tab, await freshRef(), "ArrowDown");
  assert.deepEqual(fixture.browser.context.page.pressCalls, ["ArrowDown"]);
  await assert.rejects(
    fixture.manager.press(opened.session, opened.tab, await freshRef(), "Control+V"),
    /not_started/,
  );

  const enterRef = await freshRef();
  await assert.rejects(
    fixture.manager.press(opened.session, opened.tab, enterRef, "Enter"),
    /not_started.*requires an interactive Pi confirmation/,
  );
  const confirmed = await fixture.manager.press(opened.session, opened.tab, enterRef, "Enter", async (request) => {
    assert.match(request.title, /browser press/);
    assert.doesNotMatch(request.message, /ordinary text|Private A|appended/);
    return true;
  });
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(fixture.browser.context.page.pressCalls, ["ArrowDown", "Enter"]);

  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "input", role: "textbox", inputType: "email", autocomplete: null,
  };
  const sensitiveRef = await freshRef();
  await assert.rejects(
    fixture.manager.fill(opened.session, opened.tab, sensitiveRef, "private@example.test"),
    /not_started.*interactive Pi confirmation/,
  );
  await assert.rejects(
    fixture.manager.fill(opened.session, opened.tab, sensitiveRef, "private@example.test", async (request) => {
      assert.doesNotMatch(request.message, /private@example/);
      fixture.browser.context.page.targetStructure.domPath += "> changed";
      return true;
    }),
    /not_started.*confirmed target or consequence changed/,
  );

  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "button", role: "heading", inputType: "button", href: null,
  };
  let unsuitableConfirmations = 0;
  const pressCount = fixture.browser.context.page.pressCalls.length;
  await assert.rejects(
    fixture.manager.press(opened.session, opened.tab, await freshRef(), "Enter", async () => {
      unsuitableConfirmations += 1;
      return true;
    }),
    /not_started/,
  );
  assert.equal(unsuitableConfirmations, 0, "unsuitable roles are rejected before confirmation");
  assert.equal(fixture.browser.context.page.pressCalls.length, pressCount, "unsuitable roles are never dispatched");

  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "input", role: "textbox", inputType: "password",
  };
  await assert.rejects(
    fixture.manager.fill(opened.session, opened.tab, await freshRef(), "never-visible", async () => true),
    /not_started/,
  );
  await fixture.manager.shutdown();
});

test("consequential BrowserClick rejects no-UI and denial and revalidates an approved permit", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/risky");
  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "button", role: "button", href: null, inputType: "button",
    domPath: "html:nth-of-type(1)> body:nth-of-type(1)> button:nth-of-type(1)",
  };
  const snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);

  await assert.rejects(
    fixture.manager.click("s".repeat(257), opened.tab, ref),
    /not_started/,
  );
  await assert.rejects(
    fixture.manager.click(opened.session, opened.tab, "r".repeat(513)),
    /not_started/,
  );
  await assert.rejects(fixture.manager.click(opened.session, opened.tab, ref), /not_started.*requires an interactive Pi confirmation/);
  await assert.rejects(fixture.manager.click(opened.session, opened.tab, ref, async () => false), /not_started.*denied/);
  assert.equal(fixture.browser.context.page.clickCalls, 0);

  await assert.rejects(fixture.manager.click(opened.session, opened.tab, ref, async () => {
    fixture.browser.context.page.targetStructure.domPath += "> span:nth-of-type(1)";
    return true;
  }), /not_started.*confirmed target or consequence changed/);
  assert.equal(fixture.browser.context.page.clickCalls, 0, "changed targets are never dispatched");
  await fixture.manager.shutdown();
});

test("approved risky clicks pre-arm and account for popup, dialog, and canceled download without switching", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/effects");
  fixture.browser.context.page.targetStructure = {
    ...fixture.browser.context.page.targetStructure,
    tagName: "button", role: "button", href: null, inputType: "button",
  };
  const snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);
  let dismissed = 0;
  let canceled = 0;
  fixture.browser.context.page.onClick = async () => {
    setTimeout(() => fixture.browser.context.page.emit("dialog", {
      dismiss: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 45));
        dismissed += 1;
      },
    }), 25);
    setTimeout(() => fixture.browser.context.page.emit("download", {
      cancel: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        canceled += 1;
      },
    }), 55);
    setTimeout(() => { void fixture.browser.context.newPage(); }, 85);
    setTimeout(() => { void fixture.browser.context.page.goto("https://example.com/delayed-effect"); }, 115);
  };

  const result = await fixture.manager.click(opened.session, opened.tab, ref, async (request) => {
    assert.match(request.title, /Confirm consequential browser click/);
    assert.doesNotMatch(request.message, /\/effects|ref=|browser_session_/);
    return true;
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.effects.navigation, "observed");
  assert.equal(result.effects.observedPopupTabs, 1);
  assert.equal(result.effects.observedDialogsDismissed, 1);
  assert.equal(result.effects.download, "canceled");
  assert.equal(result.effects.accounting, "bounded_stable");
  assert.deepEqual([dismissed, canceled], [1, 1]);
  const tabs = await fixture.manager.tabs(opened.session, "list");
  assert.equal(tabs.activeTab, opened.tab, "a popup never auto-switches the active tab");
  await fixture.manager.shutdown();
});

test("interaction cancellation reports dispatch uncertainty without claiming rollback", async () => {
  const before = managerFixture();
  const beforeOpened = await before.manager.open("https://example.com/cancel-before");
  const beforeSnapshot = await before.manager.snapshot(beforeOpened.session, beforeOpened.tab, 1_000);
  const beforeRef = beforeSnapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(beforeRef);
  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort(new Error("private cancellation reason"));
  await assert.rejects(
    before.manager.hover(beforeOpened.session, beforeOpened.tab, beforeRef, alreadyCanceled.signal),
    /effect status is not_started/,
  );
  assert.equal(before.browser.context.page.hoverCalls, 0);

  const during = managerFixture();
  const duringOpened = await during.manager.open("https://example.com/cancel-during");
  during.browser.context.page.targetStructure = {
    ...during.browser.context.page.targetStructure,
    tagName: "button", role: "button", href: null, inputType: "button",
  };
  const duringSnapshot = await during.manager.snapshot(duringOpened.session, duringOpened.tab, 1_000);
  const duringRef = duringSnapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(duringRef);
  let announceDispatch!: () => void;
  const dispatched = new Promise<void>((resolve) => { announceDispatch = resolve; });
  during.browser.context.page.onClick = async () => {
    announceDispatch();
    await new Promise<void>(() => undefined);
  };
  const controller = new AbortController();
  const clicking = during.manager.click(duringOpened.session, duringOpened.tab, duringRef, async () => true, controller.signal);
  await dispatched;
  controller.abort(new Error("private cancellation reason"));
  await assert.rejects(clicking, /effect status is unknown and no rollback is claimed/);
  assert.equal(during.manager.activeSessionCount(), 0, "an uncertain dispatched action tears down its session");
  await Promise.allSettled([before.manager.shutdown(), during.manager.shutdown()]);
});

test("BrowserWait exposes only bounded observational conditions and cancellation tears down", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/wait");
  const snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);

  for (const request of [
    { condition: "ref", ref, state: "visible" },
    { condition: "text", text: "Fixture", present: true },
    { condition: "text", text: "Missing", present: false },
    { condition: "url", url: "https://example.com/wait", match: "exact" },
    { condition: "url", url: "https://example.com/", match: "prefix" },
    { condition: "url", url: "^https://example\\.com/wait$", match: "pattern" },
    { condition: "navigation", state: "commit" },
    { condition: "load", state: "load" },
    { condition: "network_quiet" },
    { condition: "duration", durationMs: 1 },
  ] as const) {
    const result = await fixture.manager.wait(opened.session, opened.tab, request, 1_000);
    assert.equal(result.satisfied, true);
    assert.equal(result.condition, request.condition);
  }
  fixture.browser.context.page.visibleTextMatches.set("Repeated", 1); // one hidden match and a later visible match
  assert.equal((await fixture.manager.wait(
    opened.session,
    opened.tab,
    { condition: "text", text: "Repeated", present: true },
    100,
  )).satisfied, true);
  await assert.rejects(
    fixture.manager.wait(opened.session, opened.tab, { condition: "text", text: "Repeated", present: false }, 100),
    /visible text match remains/,
  );
  fixture.browser.context.page.visibleTextMatches.set("Repeated", 0); // all repeated matches are now hidden
  assert.equal((await fixture.manager.wait(
    opened.session,
    opened.tab,
    { condition: "text", text: "Repeated", present: false },
    100,
  )).satisfied, true);

  await assert.rejects(
    fixture.manager.wait(opened.session, opened.tab, { condition: "url", url: "(?=unsafe)", match: "pattern" }, 100),
    /invalid or unsupported by safe RE2/,
  );
  await assert.rejects(
    fixture.manager.wait(opened.session, opened.tab, { condition: "text", text: "x".repeat(513), present: true }, 100),
    /1-512 characters/,
  );

  const controller = new AbortController();
  const waiting = fixture.manager.wait(opened.session, opened.tab, { condition: "duration", durationMs: 500 }, 1_000, controller.signal);
  controller.abort(new Error("cancel wait fixture"));
  await assert.rejects(waiting, /cancel wait fixture/);
  assert.equal(fixture.manager.activeSessionCount(), 0);
});

test("BrowserHistory bounds entries and invalidates only the traversed tab generation", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/one");
  await fixture.manager.navigate(opened.session, opened.tab, "https://example.com/two");
  const snapshot = await fixture.manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);

  const listed = await fixture.manager.history(opened.session, opened.tab, "list", 1);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.truncated, true);
  const backed = await fixture.manager.history(opened.session, opened.tab, "back", 32);
  assert.equal(backed.url, "https://example.com/one");
  assert.notEqual(backed.generation, snapshot.generation);
  const reloaded = await fixture.manager.history(opened.session, opened.tab, "reload", 32);
  assert.equal(reloaded.entries.length, 2, "reload replaces rather than appends the current history entry");
  await assert.rejects(
    fixture.manager.screenshot(opened.session, opened.tab, "element", ref),
    /fresh BrowserSnapshot/,
  );
  assert.equal(fixture.manager.activeSessionCount(), 0);
});

test("BrowserTabs owns popups, enforces its cap, switches deterministically, and closes the last tab/session", async () => {
  const browser = new FakeBrowser();
  let serial = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    randomHandle: (kind: string) => `${kind}_${++serial}_${"t".repeat(32)}`,
    limits: { maxTabsPerSession: 2 },
  });
  const opened = await manager.open("https://example.com/primary");
  const popup = await browser.context.newPage();
  const listed = await manager.tabs(opened.session, "list");
  assert.equal(listed.tabs.length, 2);
  const popupHandle = listed.tabs.find((tab) => tab.tab !== opened.tab)?.tab;
  assert.ok(popupHandle);

  const refused = await browser.context.newPage() as unknown as FakePage;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refused.isClosed(), true, "a popup over the cap is immediately contained");
  await assert.rejects(manager.tabs(opened.session, "open", undefined, "https://example.com/third"), /tab limit/);

  const switched = await manager.tabs(opened.session, "switch", popupHandle);
  assert.equal(switched.activeTab, popupHandle);
  const closedPopup = await manager.tabs(opened.session, "close", popupHandle);
  assert.equal(closedPopup.activeTab, opened.tab);
  assert.equal(closedPopup.sessionClosed, false);
  assert.equal((popup as unknown as FakePage).isClosed(), true);
  const closedLast = await manager.tabs(opened.session, "close", opened.tab);
  assert.equal(closedLast.sessionClosed, true);
  assert.equal(closedLast.activeTab, null);
  assert.equal(manager.activeSessionCount(), 0);
  assert.equal((await manager.close(opened.session)).alreadyClosed, true);
});

test("BrowserTabs contains rejected and hung excess-popup closes before retiring the session", async () => {
  for (const mode of ["reject", "hang"] as const) {
    const browser = new FakeBrowser();
    const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
      resolveHostname: async () => ["93.184.216.34"],
      launch: async () => browser as unknown as Browser,
      limits: { maxTabsPerSession: 1, cleanupMs: 30 },
    });
    const opened = await manager.open("https://example.com/primary");
    let refusedPage: FakePage | undefined;
    browser.context.configureNextPage = (page) => {
      refusedPage = page;
      const closeNormally = page.close.bind(page);
      let closeAttempts = 0;
      page.close = async () => {
        closeAttempts += 1;
        if (closeAttempts === 1 && mode === "reject") throw new Error("fixture refused-popup close rejected");
        if (closeAttempts === 1 && mode === "hang") return new Promise<void>(() => undefined);
        await closeNormally();
      };
    };

    await browser.context.newPage();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(manager.activeSessionCount(), 0, `${mode} containment failure must retire the session`);
    assert.equal(refusedPage?.isClosed(), true);
    assert.ok(browser.context.pages.every((page) => page.isClosed()));
    assert.equal(browser.isConnected(), false);
    assert.equal((await manager.close(opened.session)).alreadyClosed, true);
  }
});

test("BrowserTabs contains a page that resolves after its creation deadline", async () => {
  const browser = new FakeBrowser();
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    limits: { navigationMs: 20, cleanupMs: 100 },
  });
  const opened = await manager.open("https://example.com/primary");
  browser.context.nextPageDelayMs = 60;

  await assert.rejects(
    manager.tabs(opened.session, "open", undefined, "https://example.com/late"),
    /could not confirm whether a new page was created.*teardown started/i,
  );
  assert.equal(manager.activeSessionCount(), 0);
  assert.equal(browser.context.pages.length, 2, "the fixture produced a page after the operation deadline");
  assert.ok(browser.context.pages.every((page) => page.isClosed()), "every late page is contained before rejection returns");
  assert.equal(browser.isConnected(), false);
  assert.equal((await manager.close(opened.session)).alreadyClosed, true);
});

test("BrowserTabs failed open restores the prior active tab and confirms rollback closure", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/primary");
  let failedPage: FakePage | undefined;
  fixture.browser.context.configureNextPage = (page) => {
    failedPage = page;
    page.goto = async () => { throw new Error("fixture tab navigation failed"); };
  };

  await assert.rejects(
    fixture.manager.tabs(opened.session, "open", undefined, "https://example.com/failure"),
    /fixture tab navigation failed/,
  );
  assert.equal(failedPage?.isClosed(), true);
  const listed = await fixture.manager.tabs(opened.session, "list");
  assert.equal(listed.activeTab, opened.tab);
  assert.deepEqual(listed.tabs.map((tab) => tab.tab), [opened.tab]);
  await fixture.manager.close(opened.session);
});

test("BrowserTabs failed-open rollback close rejection tears down instead of orphaning the page", async () => {
  const fixture = managerFixture();
  const opened = await fixture.manager.open("https://example.com/primary");
  let failedPage: FakePage | undefined;
  fixture.browser.context.configureNextPage = (page) => {
    failedPage = page;
    page.goto = async () => { throw new Error("fixture tab navigation failed"); };
    const closeNormally = page.close.bind(page);
    let closeAttempts = 0;
    page.close = async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("fixture rollback close rejected");
      await closeNormally();
    };
  };

  await assert.rejects(
    fixture.manager.tabs(opened.session, "open", undefined, "https://example.com/failure"),
    /rollback could not confirm closure.*teardown started/i,
  );
  assert.equal(failedPage?.isClosed(), true);
  assert.equal(fixture.manager.activeSessionCount(), 0);
  assert.equal(fixture.browser.isConnected(), false);
  assert.equal((await fixture.manager.close(opened.session)).alreadyClosed, true);
});

test("BrowserTabs close rejection and delayed close fail into confirmed session teardown", async () => {
  for (const mode of ["reject", "delay"] as const) {
    const browser = new FakeBrowser();
    let serial = 0;
    const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
      resolveHostname: async () => ["93.184.216.34"],
      launch: async () => browser as unknown as Browser,
      randomHandle: (kind: string) => `${kind}_${++serial}_${"u".repeat(32)}`,
      limits: { actionMs: 20, cleanupMs: 100 },
    });
    const opened = await manager.open("https://example.com/primary");
    const added = await manager.tabs(opened.session, "open", undefined, "https://example.com/secondary");
    const tabHandle = added.openedTab;
    assert.ok(tabHandle);
    const page = browser.context.pages[1]!;
    const closeNormally = page.close.bind(page);
    let attempts = 0;
    page.close = async () => {
      attempts += 1;
      if (attempts === 1 && mode === "reject") throw new Error("fixture tab close rejected");
      if (attempts === 1 && mode === "delay") {
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
      }
      await closeNormally();
    };

    await assert.rejects(
      manager.tabs(opened.session, "close", tabHandle),
      /could not confirm closure.*teardown started|20ms total deadline/i,
    );
    assert.equal(manager.activeSessionCount(), 0, `${mode} close must not leave a usable session`);
    assert.equal(browser.isConnected(), false);
    assert.equal((await manager.close(opened.session)).alreadyClosed, true);
    if (mode === "delay") await new Promise<void>((resolve) => setTimeout(resolve, 70));
    assert.equal(page.isClosed(), true);
  }
});

test("BrowserHistory validates empty traversal harmlessly and tears down before a timed-out late commit", async () => {
  const browser = new FakeBrowser();
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    limits: { navigationMs: 20, cleanupMs: 100 },
  });
  const opened = await manager.open("https://example.com/one");
  await assert.rejects(manager.history(opened.session, opened.tab, "back", 16), /no bounded session-local entry/);
  assert.equal(manager.activeSessionCount(), 1, "preflight history errors are harmless");
  await manager.navigate(opened.session, opened.tab, "https://example.com/two");

  const goBackNormally = browser.context.page.goBack.bind(browser.context.page);
  browser.context.page.goBack = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    return goBackNormally();
  };
  await assert.rejects(
    manager.history(opened.session, opened.tab, "back", 16),
    /20ms total deadline/,
  );
  assert.equal(manager.activeSessionCount(), 0, "an uncertain traversal is contained before rejection returns");
  assert.equal(browser.context.page.isClosed(), true);
  assert.equal(browser.isConnected(), false);
  assert.equal((await manager.close(opened.session)).alreadyClosed, true);
  await new Promise<void>((resolve) => setTimeout(resolve, 70));
  assert.equal(manager.activeSessionCount(), 0, "a late fake commit cannot resurrect the torn-down session");
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
      waitFor: async () => undefined,
      getAttribute: async () => null,
      evaluate: async () => undefined,
      hover: async () => undefined,
      click: async () => undefined,
      fill: async () => undefined,
      pressSequentially: async () => undefined,
      selectOption: async () => undefined,
      press: async () => undefined,
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

test("real browser form listeners require confirmation before any background dispatch", async () => {
  let autosaves = 0;
  const origin = createServer((request, response) => {
    if (request.url === "/autosave") {
      autosaves += 1;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Listener form</title>
      <label>Name <input id="name" type="text"></label>
      <label>Secret <input id="secret" type="password"></label>
      <label>Choice <select id="choice"><option value="private-choice">A</option></select></label>
      <button id="bad-role" role="heading">Bad role</button>
      <script>
        const save = () => fetch('/autosave', {method: 'POST'});
        const nativeGetAttribute = Element.prototype.getAttribute;
        Element.prototype.getAttribute = function(attribute) {
          if (this.id === 'secret' && attribute === 'type') return 'text';
          if (this.id === 'bad-role' && attribute === 'role') return 'button';
          return nativeGetAttribute.call(this, attribute);
        };
        const nativeIsArray = Array.isArray;
        Array.isArray = (value) => {
          const result = nativeIsArray(value);
          if (result && value.length === 1 && value[0] === 'private-choice') save();
          return result;
        };
        document.getElementById('name').addEventListener('input', save);
        document.getElementById('secret').addEventListener('input', save);
        document.addEventListener('change', save);
        window.onkeydown = save;
      </script>`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as AddressInfo).port;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, destinationPort) => net.connect({ host: "127.0.0.1", port: destinationPort }),
  });
  try {
    const opened = await manager.open(`http://public.test:${port}/form`);
    const snapshot = await manager.snapshot(opened.session, opened.tab, 4_000);
    const inputRef = snapshot.snapshot.match(/textbox "Name" \[ref=([^\]]+)\]/)?.[1];
    const passwordRef = snapshot.snapshot.match(/textbox "Secret" \[ref=([^\]]+)\]/)?.[1];
    const selectRef = snapshot.snapshot.match(/combobox "Choice" \[ref=([^\]]+)\]/)?.[1];
    const badRoleRef = snapshot.snapshot.match(/heading "Bad role"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    assert.ok(inputRef);
    assert.ok(passwordRef);
    assert.ok(selectRef);
    assert.ok(badRoleRef);
    let badRoleConfirmations = 0;
    await assert.rejects(manager.press(opened.session, opened.tab, badRoleRef, "Enter", async () => {
      badRoleConfirmations += 1;
      return true;
    }), /not_started/);
    assert.equal(badRoleConfirmations, 0, "spoofed unsuitable roles are rejected before confirmation");
    await assert.rejects(manager.fill(opened.session, opened.tab, inputRef, "private"), /not_started.*confirmation/);
    await assert.rejects(manager.type(opened.session, opened.tab, inputRef, "private"), /not_started.*confirmation/);
    await assert.rejects(manager.press(opened.session, opened.tab, inputRef, "ArrowDown"), /not_started.*confirmation/);
    let passwordConfirmations = 0;
    await assert.rejects(manager.fill(opened.session, opened.tab, passwordRef, "never-send", async () => {
      passwordConfirmations += 1;
      return true;
    }), /not_started/);
    assert.equal(passwordConfirmations, 0, "isolated password inspection rejects before confirmation");
    await assert.rejects(manager.select(opened.session, opened.tab, selectRef, ["private-choice"]), /not_started.*confirmation/);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(autosaves, 0, "direct, delegated, and keyboard listeners never run before UI approval");
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve()));
  }
});

test("real BrowserType appends despite an existing caret at the start", async () => {
  const origin = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><label>Name <input value="tail"></label><p id="mirror">tail</p>
      <script>
        const input = document.querySelector('input');
        const mirror = document.getElementById('mirror');
        input.focus();
        input.setSelectionRange(0, 0);
        input.addEventListener('input', () => { mirror.textContent = input.value; });
      </script>`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as AddressInfo).port;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, destinationPort) => net.connect({ host: "127.0.0.1", port: destinationPort }),
  });
  try {
    const opened = await manager.open(`http://public.test:${port}/`);
    const before = await manager.snapshot(opened.session, opened.tab, 2_000);
    const ref = before.snapshot.match(/textbox "Name"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    assert.ok(ref);
    await manager.type(opened.session, opened.tab, ref, "head", 0, async () => true);
    const after = await manager.snapshot(opened.session, opened.tab, 2_000);
    assert.match(after.snapshot, /tailhead/);
    assert.doesNotMatch(after.snapshot, /headtail/);
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve()));
  }
});

test("real BrowserInspect uses computed accessibility semantics without invoking page overrides", async () => {
  const requests: string[] = [];
  const origin = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Frame semantics</title>
        <input aria-label="Framed field" aria-describedby="frame-description">
        <span id="frame-description">Frame-owned description</span>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Inspect semantics</title>
      <label for="field">Native label</label>
      <input id="field" aria-describedby="description" value="PRIVATE-VALUE">
      <div id="shadow-host"></div>
      <span id="description" aria-label="Computed description">Raw description must not escape</span>
      <fieldset disabled><button id="button" aria-labelledby="button-name"><span id="button-name">Computed button</span></button></fieldset>
      <input id="check" type="checkbox" aria-label="Current check">
      <button id="expand" aria-expanded="false">Disclosure</button>
      <div role="listbox" aria-label="Choices"><div id="option" role="option" aria-selected="false" tabindex="0">Second</div></div>
      <a id="link" href="/private/path?token=secret">Link text</a>
      <span id="frame-description">Main-document collision</span>
      <iframe src="/frame"></iframe>
      <p id="mutation">untouched</p>
      <script>
        document.querySelector("#shadow-host").attachShadow({ mode: "open" }).innerHTML =
          '<span id="description" aria-label="Shadow description">Unrelated shadow text</span>';
        const mark = path => {
          document.querySelector("#mutation").textContent = "mutated";
          fetch(path).catch(() => {});
        };
        const nativeGetAttribute = Element.prototype.getAttribute;
        Element.prototype.getAttribute = function(...args) { mark("/probe-get-attribute"); return nativeGetAttribute.apply(this, args); };
        const nativeStyle = globalThis.getComputedStyle;
        globalThis.getComputedStyle = function(...args) { mark("/probe-style"); return nativeStyle.apply(this, args); };
        const hrefDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href");
        Object.defineProperty(HTMLAnchorElement.prototype, "href", {
          configurable: true,
          get() { mark("/probe-href"); return hrefDescriptor.get.call(this); },
          set(value) { return hrefDescriptor.set.call(this, value); },
        });
      </script>`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as AddressInfo).port;
  let launchedBrowser: Browser | undefined;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, requestedPort) => net.connect({ host: "127.0.0.1", port: requestedPort }),
    launch: async (options) => {
      launchedBrowser = await chromium.launch(options);
      return launchedBrowser;
    },
  });
  try {
    const opened = await manager.open(`http://inspect.test:${port}/`);
    const snapshot = await manager.snapshot(opened.session, opened.tab, 6_000);
    const inputRef = snapshot.snapshot.match(/textbox "Native label"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    const buttonRef = snapshot.snapshot.match(/button "Computed button"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    const checkRef = snapshot.snapshot.match(/checkbox "Current check"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    const expandRef = snapshot.snapshot.match(/button "Disclosure"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    const optionRef = snapshot.snapshot.match(/option "Second"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    const linkRef = snapshot.snapshot.match(/link "Link text"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    const frameRef = snapshot.snapshot.match(/textbox "Framed field"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    assert.ok(inputRef && buttonRef && checkRef && expandRef && optionRef && linkRef && frameRef, snapshot.snapshot);

    const input = await manager.inspect(opened.session, opened.tab, inputRef);
    assert.equal(input.semantic.role, "textbox");
    assert.equal(input.semantic.tag, "input");
    assert.equal(input.semantic.accessibleName, "Native label");
    assert.equal(input.semantic.accessibleDescription, "Computed description");
    assert.doesNotMatch(JSON.stringify(input), /Raw description|Shadow description|Unrelated shadow/);
    assert.equal(input.semantic.states.editable, true);
    assert.deepEqual(input.semantic.visibleText, { text: "", returnedChars: 0, truncated: false, suppressed: true });
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE-VALUE/);

    const button = await manager.inspect(opened.session, opened.tab, buttonRef);
    assert.equal(button.semantic.role, "button");
    assert.equal(button.semantic.tag, "button");
    assert.equal(button.semantic.accessibleName, "Computed button");
    assert.equal(button.semantic.states.disabled, true, "disabled fieldset is reflected as effective state");

    const ownedPage = launchedBrowser!.contexts()[0]!.pages()[0]!;
    await ownedPage.evaluate(() => {
      (document.querySelector("#check") as HTMLInputElement).checked = true;
      document.querySelector("#expand")!.setAttribute("aria-expanded", "true");
      document.querySelector("#option")!.setAttribute("aria-selected", "true");
    });
    const checked = await manager.inspect(opened.session, opened.tab, checkRef);
    const expanded = await manager.inspect(opened.session, opened.tab, expandRef);
    const selected = await manager.inspect(opened.session, opened.tab, optionRef);
    assert.equal(checked.semantic.states.checked, true, "inspection reads post-snapshot checked state");
    assert.equal(expanded.semantic.states.expanded, true, "inspection reads post-snapshot expanded state");
    assert.equal(selected.semantic.states.selected, true, "inspection reads post-snapshot selected state");

    const link = await manager.inspect(opened.session, opened.tab, linkRef);
    assert.equal(link.semantic.role, "link");
    assert.equal(link.semantic.tag, "a");
    assert.equal(link.semantic.hrefOrigin, `http://inspect.test:${port}`);
    assert.doesNotMatch(JSON.stringify(link), /private\/path|token=secret/);

    const framed = await manager.inspect(opened.session, opened.tab, frameRef);
    assert.equal(framed.semantic.tag, "input");
    assert.equal(framed.semantic.accessibleName, "Framed field");
    assert.equal(framed.semantic.accessibleDescription, "Frame-owned description");
    assert.doesNotMatch(JSON.stringify(framed), /Main-document collision/);

    const after = await manager.snapshot(opened.session, opened.tab, 6_000);
    assert.match(after.snapshot, /untouched/);
    assert.doesNotMatch(after.snapshot, /mutated/);
    assert.equal(requests.some((request) => request.startsWith("/probe-")), false);
    await manager.close(opened.session);
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve()));
  }
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
  await assert.rejects(manager.open("https://example.com/after-unconfirmed-close"), /manager is shut down/i);
});

test("browser diagnostics are bounded, redacted, cursor-based, ref-scoped, and memory-only", async () => {
  const { manager, browser } = managerFixture({
    limits: { maxConsoleEvents: 2, maxNetworkEvents: 3, maxDiagnosticReadEvents: 2 },
  });
  const opened = await manager.open("https://example.com/start?session_token=never-return-this");
  const page = browser.context.page;

  const consoleMessage = (text: string, type = "log", url = "https://example.com/private/source.js?token=nope") => ({
    text: () => text,
    type: () => type,
    location: () => ({ url, lineNumber: 7, columnNumber: 9 }),
  });
  page.emit("console", consoleMessage("first is dropped"));
  page.emit("console", consoleMessage("password=hunter2\u001b[31m", "warn"));
  const pageError = new Error("api_key=super-secret uncaught");
  pageError.stack = "STACK MUST NEVER APPEAR";
  page.emit("pageerror", pageError);

  const firstConsole = await manager.console(opened.session, opened.tab, 0, 1);
  assert.equal(firstConsole.counts.dropped, 1);
  assert.equal(firstConsole.counts.totalDropped, 1);
  assert.equal(firstConsole.counts.truncated, 1);
  assert.equal(firstConsole.events.length, 1);
  assert.match(firstConsole.events[0]!.text, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(firstConsole), /hunter2|private\/source|token=nope|STACK MUST NEVER APPEAR/);
  assert.equal(firstConsole.events[0]!.source?.origin, "https://example.com");
  const secondConsole = await manager.console(opened.session, opened.tab, firstConsole.cursor.next, 2);
  assert.equal(secondConsole.events[0]!.kind, "page_error");
  assert.match(secondConsole.events[0]!.text, /\[REDACTED\]/);
  assert.equal(secondConsole.cursor.next, secondConsole.cursor.latest);

  const request = {
    method: () => "POST",
    url: () => "https://api.example.com/customer/42?authorization=Bearer-secret",
    resourceType: () => "fetch",
    failure: () => ({ errorText: "net::ERR_FAILED authorization=top-secret" }),
    isNavigationRequest: () => false,
  };
  page.emit("request", request);
  page.emit("response", { request: () => request, status: () => 503 });
  const failed = {
    method: () => "GET",
    url: () => "https://api.example.com/another/private/path?cookie=secret",
    resourceType: () => "xhr",
    failure: () => ({ errorText: "token=failure-secret" }),
    isNavigationRequest: () => false,
  };
  page.emit("request", failed);
  page.emit("requestfailed", failed);
  const policyRequest = {
    method: () => "GET",
    url: () => "https://images.example.com/secret/path?token=never",
    resourceType: () => "image",
    frame: () => ({ page: () => page }),
  };
  await browser.context.routeHandler?.({
    request: () => policyRequest,
    abort: async () => undefined,
    continue: async () => undefined,
  });
  const network = await manager.network(opened.session, opened.tab, 0, 2);
  assert.ok(network.counts.dropped > 0);
  assert.ok(network.counts.truncated > 0);
  const networkRemainder = await manager.network(opened.session, opened.tab, network.cursor.next, 2);
  const serializedNetwork = JSON.stringify([network, networkRemainder]);
  assert.doesNotMatch(serializedNetwork, /customer|another|authorization|Bearer-secret|cookie=secret|failure-secret|headers|postData|body/);
  assert.match(serializedNetwork, /https:\/\/api\.example\.com/);
  assert.match(serializedNetwork, /policy_blocked/);
  assert.match(serializedNetwork, /image resource blocked/);

  const snapshot = await manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);
  const detail = await manager.inspect(opened.session, opened.tab, ref);
  assert.deepEqual(Object.keys(detail.semantic), [
    "role", "tag", "type", "accessibleName", "accessibleDescription", "states", "hrefOrigin", "visibleText",
  ]);
  assert.equal(detail.semantic.hrefOrigin, "https://example.com");
  assert.equal(detail.semantic.visibleText.text, "Visible fixture text");
  assert.equal((detail.semantic as Record<string, unknown>).value, undefined);

  page.targetStructure = { ...page.targetStructure, tagName: "input", inputType: "password", contentEditable: true };
  const suppressed = await manager.inspect(opened.session, opened.tab, ref);
  assert.equal(suppressed.semantic.visibleText.suppressed, true);
  assert.equal(suppressed.semantic.visibleText.text, "");
  await manager.navigate(opened.session, opened.tab, "https://example.com/new-document");
  await assert.rejects(manager.inspect(opened.session, opened.tab, ref), /Invalid or stale browser semantic ref/);
  await manager.close(opened.session);
  await assert.rejects(manager.console(opened.session, opened.tab), /Invalid or stale browser session\/tab handle/);
});

test("browser diagnostics stay tab-local and cancellation tears down the owning session", async () => {
  const { manager, browser } = managerFixture();
  const opened = await manager.open("https://example.com/one");
  const second = await manager.tabs(opened.session, "open", undefined, "https://example.com/two");
  assert.ok(second.openedTab);
  const firstPage = browser.context.pages[0]!;
  const secondPage = browser.context.pages[1]!;
  const message = (text: string) => ({
    text: () => text,
    type: () => "info",
    location: () => ({ url: "https://example.com/source.js", lineNumber: 1, columnNumber: 1 }),
  });
  firstPage.emit("console", message("first-tab-only"));
  secondPage.emit("console", message("second-tab-only"));
  const first = await manager.console(opened.session, opened.tab);
  const other = await manager.console(opened.session, second.openedTab!);
  assert.match(JSON.stringify(first.events), /first-tab-only/);
  assert.doesNotMatch(JSON.stringify(first.events), /second-tab-only/);
  assert.match(JSON.stringify(other.events), /second-tab-only/);
  assert.doesNotMatch(JSON.stringify(other.events), /first-tab-only/);

  const snapshot = await manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);
  await assert.rejects(manager.inspect(opened.session, second.openedTab!, ref), /Invalid or stale browser semantic ref/);

  const controller = new AbortController();
  controller.abort(new Error("cancel diagnostic read"));
  await assert.rejects(manager.console(opened.session, opened.tab, 0, 1, controller.signal), /cancel diagnostic read/);
  assert.equal(manager.activeSessionCount(), 0);
});

test("a timed-out BrowserInspect is contained before action serialization is released", async () => {
  const { manager, browser } = managerFixture({ limits: { actionMs: 15, cleanupMs: 100 } });
  const opened = await manager.open("https://example.com/inspect-timeout");
  const snapshot = await manager.snapshot(opened.session, opened.tab, 1_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref);
  browser.context.page.inspectDelayMs = 100;
  await assert.rejects(manager.inspect(opened.session, opened.tab, ref), /15ms total deadline/);
  assert.equal(manager.activeSessionCount(), 0, "timeout teardown completes before BrowserInspect rejects");
  assert.equal(browser.context.page.isClosed(), true);
});
