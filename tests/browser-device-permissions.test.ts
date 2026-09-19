/**
 * Issue #27 bounded slice: manager-level runtime enforcement for the remaining
 * browser permissions — camera/microphone/geolocation (per-origin device
 * grants), service workers (launch-pinned context mode with controlled live
 * replacement), and the popup restriction override (over-limit page-created
 * popup adoption). The fakes record the exact Playwright permission calls and
 * launch-time context options, so these tests assert on real manager behavior
 * (which grants are issued to which origin, when they are revoked, what mode
 * the replacement context gets) rather than on settings state. Raw-engine
 * facts live in browser-device-permissions-live.test.ts.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig, type WebBrowserPermissions } from "../src/config";
import { InteractiveBrowserManager, type BrowserVisibilityResult } from "../src/web/interactive-browser";

// ---------------------------------------------------------------------------
// Fixtures: minimal fake browser family (mirrors tests/browser-visibility.test.ts)
// extended with launch-time context-option recording and permission-grant
// recording.
// ---------------------------------------------------------------------------

class FakePage extends EventEmitter {
  currentUrl = "about:blank";
  visibilityState = "visible";
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
  onEvaluate?: (source: unknown, arg?: unknown) => unknown;
  async evaluate(source?: unknown, ...args: unknown[]) {
    if (this.onEvaluate) return this.onEvaluate(source, args[0]);
    return this.visibilityState;
  }
  async bringToFront() {}
  async waitForLoadState() {}
  async ariaSnapshot() { return "- heading \"Fixture\" [level=1]\n"; }

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
  async goto(url: string) { return this.commit(url); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeCdpSession {
  readonly sent: Array<{ method: string }> = [];
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
  pages(): FakePage[] { return this.pageList; }
  storageStateFixture?: StorageStateFixture;
  /** Issue #27: manager-issued permission grants, recorded for assertions.
   * Append-only call log — use finalPermissionState() for engine state. */
  readonly grantedPermissions: Array<{ permissions: string[]; origin: string }> = [];
  clearPermissionCalls = 0;
  /** Ordered grant/clear events so tests can fold the real engine state
   * (Chromium replaces an origin's allowed set per call; a clear wipes all). */
  readonly permissionLog: Array<{ kind: "grant"; permissions: string[]; origin: string } | { kind: "clear" }> = [];
  closed = false;
  readonly cdpSessions: FakeCdpSession[] = [];
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async newCDPSession(page: FakePage) {
    const session = new FakeCdpSession(page);
    this.cdpSessions.push(session);
    return session;
  }
  async grantPermissions(permissions: string[], options?: { origin?: string }) {
    const entry = { permissions: [...permissions], origin: options?.origin ?? "" };
    this.grantedPermissions.push(entry);
    this.permissionLog.push({ kind: "grant", ...entry });
  }
  async clearPermissions() {
    this.clearPermissionCalls += 1;
    this.permissionLog.push({ kind: "clear" });
  }
  /** Fold the event log into the engine's final per-origin permission state. */
  finalPermissionState(): Map<string, Set<string>> {
    const state = new Map<string, Set<string>>();
    for (const event of this.permissionLog) {
      if (event.kind === "clear") { state.clear(); continue; }
      state.set(event.origin, new Set(event.permissions));
    }
    return state;
  }
  async routeWebSocket() {}
  async route() {}
  async newPage() {
    const page = new FakePage();
    this.pageList.push(page);
    this.emit("page", page);
    return page as unknown as Page;
  }
  async storageState(): Promise<StorageStateFixture> {
    return this.storageStateFixture ?? { cookies: [], origins: [] };
  }
  async close() {
    this.closed = true;
    await Promise.all(this.pageList.map((page) => page.close()));
  }
}

class FakeBrowser extends EventEmitter {
  readonly context: FakeContext;
  /** Launch-time context options, recorded to assert the pinned SW mode. */
  contextOptions?: Record<string, unknown>;
  connected = true;
  constructor() { super(); this.context = new FakeContext(); }
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

interface DeviceHarness {
  manager: InteractiveBrowserManager;
  browsers: FakeBrowser[];
  setPermissions(permissions: WebBrowserPermissions, visible?: boolean): void;
}

function harness(): DeviceHarness {
  const browsers: FakeBrowser[] = [];
  let serial = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async (hostname: string) => net.isIP(hostname) ? [hostname] : ["93.184.216.34"],
    launch: async () => {
      const browser = new FakeBrowser();
      browsers.push(browser);
      return browser as unknown as Browser;
    },
    randomHandle: (kind: string) => `${kind}_${++serial}_${"x".repeat(32)}`,
  });
  return {
    manager,
    browsers,
    setPermissions(permissions: WebBrowserPermissions, visible = false) {
      manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, permissions, visible);
    },
  };
}

function lastContext(h: DeviceHarness): FakeContext {
  assert.ok(h.browsers.length > 0, "no browser launched");
  return h.browsers[h.browsers.length - 1]!.context;
}

/** Last grant call for one origin in a context (the engine's final state). */
function lastGrantFor(context: FakeContext, origin: string): { permissions: string[] } | undefined {
  for (let i = context.grantedPermissions.length - 1; i >= 0; i--) {
    if (context.grantedPermissions[i]!.origin === origin) return context.grantedPermissions[i]!;
  }
  return undefined;
}

const settle = () => delay(20);

// ---------------------------------------------------------------------------
// Device permission grants (camera / microphone / geolocation).
// ---------------------------------------------------------------------------

test("default-off: no device permission grant is issued on navigation commit", async () => {
  const h = harness();
  try {
    const opened = await h.manager.open("https://example.com/");
    await h.manager.navigate(opened.session, opened.tab, "https://example.org/");
    await settle();
    assert.deepEqual(lastContext(h).grantedPermissions, [], "no capability enabled: nothing may be granted");
  } finally { await h.manager.shutdown(); }
});

test("camera-only: exactly the camera descriptor is granted for the committed origin", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true });
    const opened = await h.manager.open("https://example.com/");
    await settle();
    const context = lastContext(h);
    const grant = lastGrantFor(context, "https://example.com");
    assert.deepEqual(grant?.permissions, ["camera"], "only the enabled device group is granted");
    assert.equal(context.grantedPermissions.every((entry) => entry.origin === "https://example.com"), true, "grants are per-origin, never context-wide");
  } finally { await h.manager.shutdown(); }
});

test("YOLO enables all three device groups as a union grant for the origin", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, yolo: true });
    const opened = await h.manager.open("https://cam.example.com/");
    await settle();
    const grant = lastGrantFor(lastContext(h), "https://cam.example.com");
    assert.deepEqual([...(grant?.permissions ?? [])].sort(), ["camera", "geolocation", "microphone"]);
  } finally { await h.manager.shutdown(); }
});

test("per-origin isolation: each committed origin gets its own grant entry", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelGeolocation: true });
    const opened = await h.manager.open("https://one.example.com/");
    await h.manager.navigate(opened.session, opened.tab, "https://two.example.org/");
    await settle();
    const context = lastContext(h);
    assert.deepEqual(lastGrantFor(context, "https://one.example.com")?.permissions, ["geolocation"]);
    assert.deepEqual(lastGrantFor(context, "https://two.example.org")?.permissions, ["geolocation"]);
  } finally { await h.manager.shutdown(); }
});

test("live revocation clears only the revoked group and keeps the others in force", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    assert.deepEqual([...context.finalPermissionState().get("https://devices.example.com")!].sort(), ["camera", "microphone"]);
    // Disable only the camera: microphone must survive in the same context.
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelMicrophone: true });
    await settle();
    assert.ok(context.clearPermissionCalls >= 2, "launch baseline clear plus the revocation clear");
    assert.deepEqual([...context.finalPermissionState().get("https://devices.example.com")!].sort(), ["microphone"], "only the revoked group is cleared");
    // Disable everything: the surviving grant goes too.
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS });
    await settle();
    assert.equal(context.finalPermissionState().has("https://devices.example.com"), false, "no grant remains for the origin");
  } finally { await h.manager.shutdown(); }
});

test("a revocation landing mid-chain is reconciled: no stale device grant survives", async () => {
  const h = harness();
  // Revoke the capability exactly while the chain's second grant round-trip
  // is in flight: updateConfig enqueues its clear behind the in-flight grant,
  // and the chain's remaining groups would otherwise land with no policy check.
  const realGrant = FakeContext.prototype.grantPermissions;
  let grantCalls = 0;
  FakeContext.prototype.grantPermissions = async function (this: FakeContext, permissions: string[], options?: { origin?: string }) {
    grantCalls += 1;
    if (grantCalls === 2) h.setPermissions(DEFAULT_BROWSER_PERMISSIONS);
    return realGrant.call(this, permissions, options);
  };
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, yolo: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    // The chain really was in flight: the first group landed, then the union
    // grant whose round-trip carried the revocation.
    assert.ok(context.grantedPermissions.length >= 2, "the device chain issued its grants before the revocation settled");
    // After settling, the engine state holds no device permission for the
    // origin: the mid-chain revocation won over the remaining groups.
    const state = context.finalPermissionState().get("https://devices.example.com");
    assert.ok(
      state === undefined || ![...state].some((permission) => ["camera", "microphone", "geolocation"].includes(permission)),
      `no stale device grant survives the mid-chain revocation (state: ${state ? [...state].join(", ") : "none"})`,
    );
  } finally {
    FakeContext.prototype.grantPermissions = realGrant;
    await h.manager.shutdown();
  }
});

test("a failed device grant fails closed: no bookkeeping claim, session stays usable", async () => {
  const h = harness();
  // Fail every engine grant from the first launch onward (prototype hook,
  // restored in finally) so no grant can ever be issued in this session.
  const realGrant = FakeContext.prototype.grantPermissions;
  FakeContext.prototype.grantPermissions = async function (this: FakeContext) {
    throw new Error("fixture grant failure");
  };
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true });
    const opened = await h.manager.open("https://flaky.example.com/");
    await settle();
    const context = lastContext(h);
    assert.deepEqual(context.grantedPermissions, [], "a failed grant is never recorded as issued");
    // Fail closed end-to-end: revoking the group must be a no-op (nothing
    // held) — only the launch-time fail-closed clear may have occurred.
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS });
    await settle();
    assert.equal(context.clearPermissionCalls, 1, "no revocation clear is needed for grants that were never issued");
    // The session remains fully usable.
    const navigated = await h.manager.navigate(opened.session, opened.tab, "https://flaky.example.com/deeper/");
    assert.equal(navigated.status, 200);
  } finally {
    FakeContext.prototype.grantPermissions = realGrant;
    await h.manager.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Popup restriction override.
// ---------------------------------------------------------------------------

async function fillSessionTabs(h: DeviceHarness, session: string): Promise<void> {
  for (const path of ["/t1", "/t2", "/t3"]) {
    await h.manager.tabs(session, "open", undefined, `https://popups.example.com${path}`);
  }
}

async function waitForPageClose(page: FakePage): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!page.isClosed()) {
    if (Date.now() >= deadline) throw new Error("refused popup page did not close");
    await delay(10);
  }
}

test("override off: an over-limit page-created popup is contained and closed", async () => {
  const h = harness();
  try {
    const opened = await h.manager.open("https://popups.example.com/");
    await fillSessionTabs(h, opened.session); // 4 tabs total (open + 3)
    const context = lastContext(h);
    const popup = (await context.newPage()) as unknown as FakePage; // page-created popup beyond the cap
    await waitForPageClose(popup);
    const listed = await h.manager.tabs(opened.session, "list");
    assert.equal(listed.tabs.length, 4, "the refused popup is not adopted");
  } finally { await h.manager.shutdown(); }
});

test("override on: an over-limit page-created popup is adopted as an owned tab", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelPopupRestrictionOverride: true });
    const opened = await h.manager.open("https://popups.example.com/");
    await fillSessionTabs(h, opened.session); // 4 tabs total (open + 3)
    const popup = (await lastContext(h).newPage()) as unknown as FakePage;
    await settle();
    assert.equal(popup.isClosed(), false, "the over-limit popup stays open while the override is enabled");
    const listed = await h.manager.tabs(opened.session, "list");
    assert.equal(listed.tabs.length, 5, "the adopted popup is an owned explicit tab handle");
  } finally { await h.manager.shutdown(); }
});

test("off transition: already-adopted popup tabs stay; new over-limit popups are refused", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelPopupRestrictionOverride: true });
    const opened = await h.manager.open("https://popups.example.com/");
    await fillSessionTabs(h, opened.session);
    const adopted = (await lastContext(h).newPage()) as unknown as FakePage;
    await settle();
    assert.equal(adopted.isClosed(), false);
    // Disable the override: nothing already adopted is destroyed...
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS });
    await settle();
    assert.equal(adopted.isClosed(), false, "already-adopted popup tabs remain owned tabs");
    // ...but a new over-limit popup is refused and closed.
    const next = (await lastContext(h).newPage()) as unknown as FakePage;
    await waitForPageClose(next);
    const listed = await h.manager.tabs(opened.session, "list");
    assert.equal(listed.tabs.length, 5, "the session keeps its five owned tabs and no sixth is admitted");
  } finally { await h.manager.shutdown(); }
});

// ---------------------------------------------------------------------------
// Service workers: launch-pinned mode + controlled live replacement.
// ---------------------------------------------------------------------------

test("context is created with serviceWorkers block by default and allow when enabled at launch", async () => {
  const h = harness();
  try {
    await h.manager.open("https://sw.example.com/");
    assert.equal(h.browsers[0]!.contextOptions?.serviceWorkers, "block", "default: service workers blocked at context creation");
  } finally { await h.manager.shutdown(); }

  const h2 = harness();
  try {
    h2.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelServiceWorkers: true });
    await h2.manager.open("https://sw.example.com/");
    assert.equal(h2.browsers[0]!.contextOptions?.serviceWorkers, "allow", "enabled: the context allows service workers");
  } finally { await h2.manager.shutdown(); }
});

test("live enable performs a controlled replacement that restores tabs and reports the new mode", async () => {
  const h = harness();
  try {
    const opened = await h.manager.open("https://sw.example.com/page");
    assert.equal(h.browsers[0]!.contextOptions?.serviceWorkers, "block");
    // Save modelServiceWorkers on: the launch-pinned mode differs, so the
    // live browser is replaced through the ordinary ownership path.
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelServiceWorkers: true });
    const result = (await h.manager.applyVisibility(false)) as BrowserVisibilityResult;
    assert.equal(result.relaunched, true);
    assert.equal(result.serviceWorkers, "allow");
    assert.equal(result.headless, true, "visibility is unchanged by a service-worker save");
    assert.equal(result.restoredTabs, 1);
    assert.equal(result.tabs[0]!.restored, true);
    assert.equal(result.tabs[0]!.finalUrl, "https://sw.example.com/page");
    assert.notEqual(result.session, opened.session, "old session handles are stale after replacement");
    assert.equal(h.browsers.length, 2, "exactly one replacement browser exists");
    assert.equal(h.browsers[1]!.contextOptions?.serviceWorkers, "allow");
    // The restored tab really lives in the new context.
    const pages = lastContext(h).pages();
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.url(), "https://sw.example.com/page");
  } finally { await h.manager.shutdown(); }
});

test("live disable of service workers also replaces: the allow context is destroyed", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelServiceWorkers: true });
    await h.manager.open("https://sw.example.com/");
    assert.equal(h.browsers[0]!.contextOptions?.serviceWorkers, "allow");
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS });
    const result = (await h.manager.applyVisibility(false)) as BrowserVisibilityResult;
    assert.equal(result.relaunched, true);
    assert.equal(result.serviceWorkers, "block", "the replacement context enforces the new block policy");
    assert.ok(h.browsers[0]!.context.closed, "the old allow-mode context is closed with its service workers");
  } finally { await h.manager.shutdown(); }
});

test("a service-worker save landing during context startup still drives a replacement", async () => {
  const h = harness();
  const realClear = FakeContext.prototype.clearPermissions;
  let flipped = false;
  FakeContext.prototype.clearPermissions = async function (this: FakeContext) {
    if (!flipped) {
      flipped = true;
      // The save lands after the context options were read and before the
      // session record: the record must still name the launched mode.
      h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS });
    }
    return realClear.call(this);
  };
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelServiceWorkers: true });
    await h.manager.open("https://sw.example.com/");
    // The save's deferred applySavedSettings reaches exactly this compare.
    const result = (await h.manager.applyVisibility(false)) as BrowserVisibilityResult;
    assert.ok(result, "the launched/saved service-worker mismatch must trigger a replacement");
    assert.equal(result.relaunched, true);
    assert.equal(h.browsers.length, 2, "exactly one replacement browser exists");
    assert.equal(h.browsers[1]!.contextOptions?.serviceWorkers, "block", "the replacement context enforces the saved off policy");
  } finally {
    FakeContext.prototype.clearPermissions = realClear;
    await h.manager.shutdown();
  }
});

test("idempotent: matching visibility and service-worker policy relaunches nothing", async () => {
  const h = harness();
  try {
    await h.manager.open("https://sw.example.com/");
    assert.equal(await h.manager.applyVisibility(false), null, "no launch-pinned setting differs");
    assert.equal(h.browsers.length, 1);
  } finally { await h.manager.shutdown(); }
});

test("device grants carry over the replacement, filtered by the current effective policy", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    await h.manager.open("https://devices.example.com/");
    await settle();
    assert.deepEqual(
      [...(lastGrantFor(lastContext(h), "https://devices.example.com")?.permissions ?? [])].sort(),
      ["camera", "microphone"],
    );
    // The save that triggers the replacement also revokes the microphone:
    // the carried grant must not ride along.
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelServiceWorkers: true });
    const result = (await h.manager.applyVisibility(false)) as BrowserVisibilityResult;
    assert.equal(result.relaunched, true);
    await settle();
    const fresh = lastContext(h);
    assert.deepEqual(lastGrantFor(fresh, "https://devices.example.com")?.permissions, ["camera"], "only still-enabled groups are re-issued");
    assert.ok(fresh.grantedPermissions.every((entry) => !entry.permissions.includes("microphone")), "the revoked group is never re-granted to the replacement context");
  } finally { await h.manager.shutdown(); }
});

test("visibility and service-worker changes together produce one replacement reporting both", async () => {
  const h = harness();
  try {
    await h.manager.open("https://sw.example.com/");
    // Save headed + modelServiceWorkers in one transaction.
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelServiceWorkers: true }, true);
    const result = (await h.manager.applyVisibility(true)) as BrowserVisibilityResult;
    assert.equal(result.relaunched, true);
    assert.equal(result.headless, false);
    assert.equal(result.serviceWorkers, "allow");
    assert.equal(h.browsers.length, 2, "both changes share a single controlled replacement");
  } finally { await h.manager.shutdown(); }
});
