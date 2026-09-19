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
import { InteractiveBrowserManager, type BrowserPermissionRevocationReport, type BrowserVisibilityResult } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";

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
  setPermissions(permissions: WebBrowserPermissions, visible?: boolean): Promise<BrowserPermissionRevocationReport>;
}

function harness(options: { cleanupMs?: number } = {}): DeviceHarness {
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
    ...(options.cleanupMs === undefined ? {} : { limits: { cleanupMs: options.cleanupMs } }),
  });
  return {
    manager,
    browsers,
    setPermissions(permissions: WebBrowserPermissions, visible = false) {
      return manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, permissions, visible);
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
// Failed revocation containment: an engine clear that cannot be confirmed
// must fail the affected owned session closed (grants retained until the
// context close is confirmed), report through the settings channel with its
// closure status, and deny model tools — never claim the disable applied.
// ---------------------------------------------------------------------------

test("failed engine clear on a live disable: contained by teardown, reported through the settings channel, tools denied", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    // Mixed clipboard + device grants for the same origin.
    const context = lastContext(h);
    context.pages()[0]!.onEvaluate = () => Promise.resolve({ ok: true, text: "mixed-grant-clipboard" });
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true, modelClipboard: true });
    const read = await h.manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(read.text, "mixed-grant-clipboard");
    assert.deepEqual(
      [...context.finalPermissionState().get("https://devices.example.com")!].sort(),
      ["camera", "clipboard-read", "microphone"],
    );

    // The live disable's engine clear fails.
    const originalClear = context.clearPermissions.bind(context);
    context.clearPermissions = async () => { throw new Error("fixture CDP clear failure"); };
    try {
      // The real settings-activation path: the save must report the failed
      // revocation with its containment status, never a successful apply.
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true, modelClipboard: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      const notice = await boundary.applySavedSettings(normalizeConfig({}));
      assert.ok(notice, "the failed revocation is reported through the settings channel, not voided");
      assert.match(notice!, /revocation could not be confirmed/);
      assert.match(notice!, /closed to contain the retained grants/);
      assert.match(notice!, /Closure status: confirmed/);

      // The engine grant was never cleared: it persists in the engine log
      // until the owned context close, which containment now confirms.
      const state = context.finalPermissionState().get("https://devices.example.com");
      assert.ok(
        state && [...state].includes("camera") && [...state].includes("clipboard-read") && [...state].includes("microphone"),
        "no confirmed clear: the engine still holds the revoked grants",
      );
      assert.equal(context.closed, true, "the owned context is closed by containment teardown");
      assert.equal(h.browsers[0]!.connected, false, "the browser process close is confirmed");
      assert.equal(h.manager.activeSessionCount(), 0);

      // Model tools are denied with the truthful fatal reason.
      await assert.rejects(
        h.manager.snapshot(opened.session, opened.tab, 1_000),
        /Browser session is closed \(fatal_error: .*permission revocation could not be confirmed/,
      );
      // The cleanup status is retained for BrowserClose, not lost.
      const closed = await h.manager.close(opened.session);
      assert.equal(closed.alreadyClosed, true);
      assert.equal(closed.closure?.kind, "fatal_error");
      assert.match(closed.closure!.message, /permission revocation could not be confirmed/);
    } finally {
      context.clearPermissions = originalClear;
    }
  } finally { await h.manager.shutdown(); }
});

test("a failed context close during revocation containment is reported unconfirmed, never success", async () => {
  const h = harness({ cleanupMs: 25 });
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    const originalClear = context.clearPermissions.bind(context);
    const originalClose = context.close.bind(context);
    context.clearPermissions = async () => { throw new Error("fixture CDP clear failure"); };
    // The containment close itself hangs past the bounded cleanup deadline.
    context.close = () => new Promise<void>(() => undefined);
    try {
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      const notice = await boundary.applySavedSettings(normalizeConfig({}));
      assert.ok(notice);
      assert.match(notice!, /revocation could not be confirmed/);
      assert.match(notice!, /Closure status: unconfirmed/);

      // BrowserClose reports the unconfirmed teardown — never a success.
      await assert.rejects(h.manager.close(opened.session), /Browser closure is unconfirmed/);
    } finally {
      context.clearPermissions = originalClear;
      context.close = originalClose;
    }
  } finally {
    // The unconfirmed teardown fails closed for the remainder of the runtime.
    await h.manager.shutdown().catch(() => undefined);
  }
});

test("a save landing mid-teardown reports the superseded revocation with that teardown's closure status", async () => {
  const h = harness({ cleanupMs: 25 });
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    // Make the explicit close hang past the bounded cleanup deadline so the
    // in-flight teardown ends unconfirmed.
    const originalClose = context.close.bind(context);
    context.close = () => new Promise<void>(() => undefined);
    try {
      // beginTeardown is synchronous, so this save lands strictly mid-teardown:
      // the revocation is superseded by it and must still observe its closure.
      const closing = h.manager.close(opened.session);
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      const notice = await boundary.applySavedSettings(normalizeConfig({}));
      assert.ok(notice, "the superseded revocation with an unconfirmed closure is reported, not dropped");
      assert.match(notice!, /superseded by an in-progress session teardown/);
      assert.match(notice!, /closure could not be confirmed/);
      await assert.rejects(closing, /Browser closure is unconfirmed/);
    } finally {
      context.close = originalClose;
    }
  } finally {
    await h.manager.shutdown().catch(() => undefined);
  }
});

test("a failed visibility apply does not drop an unconfirmed revocation report", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    const originalClear = context.clearPermissions.bind(context);
    const originalVisibility = h.manager.applyVisibility.bind(h.manager);
    context.clearPermissions = async () => { throw new Error("fixture CDP clear failure"); };
    h.manager.applyVisibility = async () => { throw new Error("fixture visibility failure"); };
    try {
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      // Both the visibility apply and the revocation containment fail: the
      // thrown error must carry both, not just the visibility one.
      await assert.rejects(
        boundary.applySavedSettings(normalizeConfig({})),
        (error: Error) => {
          assert.match(error.message, /fixture visibility failure/);
          assert.match(error.message, /revocation could not be confirmed/);
          assert.match(error.message, /Closure status: confirmed/);
          return true;
        },
      );
      // The containment still happened and is confirmed.
      assert.equal(context.closed, true);
      assert.equal(h.manager.activeSessionCount(), 0);
    } finally {
      context.clearPermissions = originalClear;
      h.manager.applyVisibility = originalVisibility;
    }
  } finally { await h.manager.shutdown(); }
});

test("a wedged permission clear delays the save at most the cleanup deadline, then reports in-flight with confirmed containment", async () => {
  const h = harness({ cleanupMs: 25 });
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    // The engine clear never settles: a wedged-but-connected driver.
    const originalClear = context.clearPermissions.bind(context);
    context.clearPermissions = () => new Promise<void>(() => undefined);
    try {
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      // The save must settle at the bounded deadline — not block on the wedged
      // driver — and report the revocation as in flight, not applied.
      const started = Date.now();
      const notice = await boundary.applySavedSettings(normalizeConfig({}));
      assert.ok(Date.now() - started < 2_000, "the save is not blocked past the bounded cleanup deadline");
      assert.ok(notice, "the in-flight revocation is reported through the settings channel");
      assert.match(notice!, /still in flight/);
      assert.match(notice!, /not been confirmed applied/);
      assert.match(notice!, /exceeded its 25ms deadline/);
      // The save itself started containment: no manual BrowserClose is needed,
      // the owned context and process are closed (engine grants contained),
      // and the closure is reported confirmed — while the engine clear itself
      // stays unconfirmed.
      assert.match(notice!, /Session closure status: confirmed/);
      assert.match(notice!, /already closed, so the retained grants are contained/);
      assert.doesNotMatch(notice!, /Use BrowserClose/);
      assert.equal(h.manager.activeSessionCount(), 0);
      assert.equal(context.closed, true, "the owned context is closed by containment teardown");
      assert.equal(h.browsers[0]!.connected, false, "the browser process close is confirmed");

      // Model tools fail closed with the truthful fatal reason.
      await assert.rejects(
        h.manager.snapshot(opened.session, opened.tab, 1_000),
        /Browser session is closed \(fatal_error: .*permission revocation did not settle/,
      );
      // The closure status is retained for BrowserClose, not lost.
      const closed = await h.manager.close(opened.session);
      assert.equal(closed.alreadyClosed, true);
      assert.equal(closed.closure?.kind, "fatal_error");
    } finally {
      context.clearPermissions = originalClear;
    }
  } finally { await h.manager.shutdown(); }
});

test("a wedged permission clear whose containment close fails reports in-flight with unconfirmed closure, never success", async () => {
  const h = harness({ cleanupMs: 25 });
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    // The engine clear never settles (a wedged driver), and the containment
    // close hangs past the bounded cleanup deadline, so the save-started
    // teardown ends unconfirmed and the session becomes a failed tombstone.
    const originalClear = context.clearPermissions.bind(context);
    const originalClose = context.close.bind(context);
    context.clearPermissions = () => new Promise<void>(() => undefined);
    context.close = () => new Promise<void>(() => undefined);
    try {
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      // The save must still settle at its bounded deadline and report both the
      // unconfirmed clear and the unconfirmed containment — never success.
      const started = Date.now();
      const notice = await boundary.applySavedSettings(normalizeConfig({}));
      assert.ok(Date.now() - started < 2_000, "the save is not blocked past the bounded cleanup deadline");
      assert.ok(notice, "the in-flight revocation is reported through the settings channel");
      assert.match(notice!, /still in flight/);
      assert.match(notice!, /not been confirmed applied/);
      assert.match(notice!, /exceeded its 25ms deadline/);
      assert.match(notice!, /Session closure status: unconfirmed/);
      assert.match(notice!, /teardown could not be confirmed, so containment is unconfirmed/);
      assert.match(notice!, /recover by restarting the Pi session/);
      // The save-started teardown failed; BrowserClose can only echo the same
      // failure, so the notice must not point at it.
      assert.doesNotMatch(notice!, /Use BrowserClose/);
      await assert.rejects(h.manager.close(opened.session), /Browser closure is unconfirmed/);
    } finally {
      context.clearPermissions = originalClear;
      context.close = originalClose;
    }
  } finally {
    // The unconfirmed teardown fails closed for the remainder of the runtime.
    await h.manager.shutdown().catch(() => undefined);
  }
});

test("an in-flight revocation whose session closes meanwhile reports the confirmed closure", async () => {
  const h = harness({ cleanupMs: 300 });
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    // The engine clear never settles: a wedged-but-connected driver.
    const originalClear = context.clearPermissions.bind(context);
    let clearCalls = 0;
    context.clearPermissions = () => {
      clearCalls += 1;
      return new Promise<void>(() => undefined);
    };
    try {
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      const saving = boundary.applySavedSettings(normalizeConfig({}));
      // Let the wedged clear get in flight, then close the session. The
      // teardown does not await the mutation tail, so it confirms
      // independently of the wedged clear; the save must report that
      // confirmed closure rather than stale live-browser advice.
      for (let i = 0; i < 400 && clearCalls === 0; i += 1) await delay(5);
      assert.ok(clearCalls > 0, "the revocation reached the engine clear");
      const closing = h.manager.close(opened.session);
      const notice = await saving;
      assert.ok(notice, "the in-flight revocation is reported through the settings channel");
      assert.match(notice!, /still in flight/);
      assert.match(notice!, /not been confirmed applied/);
      assert.match(notice!, /Session closure status: confirmed/);
      assert.match(notice!, /already closed, so the retained grants are contained/);
      assert.doesNotMatch(notice!, /on the live browser/);
      assert.doesNotMatch(notice!, /Use BrowserClose/);
      const closed = await closing;
      assert.equal(closed.closed, true);
    } finally {
      context.clearPermissions = originalClear;
    }
  } finally { await h.manager.shutdown(); }
});

test("an in-flight revocation whose concurrent teardown fails reports unconfirmed containment without BrowserClose advice", async () => {
  const h = harness({ cleanupMs: 25 });
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://devices.example.com/");
    await settle();
    const context = lastContext(h);
    // The engine clear never settles (a wedged driver), and the concurrent
    // containment close hangs past the bounded cleanup deadline, so the
    // teardown ends unconfirmed and the session becomes a failed tombstone.
    const originalClear = context.clearPermissions.bind(context);
    const originalClose = context.close.bind(context);
    let clearCalls = 0;
    context.clearPermissions = () => {
      clearCalls += 1;
      return new Promise<void>(() => undefined);
    };
    context.close = () => new Promise<void>(() => undefined);
    try {
      const boundary = new WebToolManager(
        { registerTool: () => undefined },
        normalizeConfig({ web: { browserPermissions: { modelCamera: true, modelMicrophone: true } } }),
        undefined,
        undefined,
        h.manager,
      );
      const saving = boundary.applySavedSettings(normalizeConfig({}));
      // Let the wedged clear get in flight, then start a close whose containment
      // cannot be confirmed.
      for (let i = 0; i < 400 && clearCalls === 0; i += 1) await delay(5);
      assert.ok(clearCalls > 0, "the revocation reached the engine clear");
      const closing = h.manager.close(opened.session);
      // Attach a handler immediately: the teardown rejects at the cleanup
      // deadline, long before the final assertion would observe it.
      void closing.catch(() => undefined);
      const notice = await saving;
      assert.ok(notice, "the in-flight revocation is reported through the settings channel");
      assert.match(notice!, /still in flight/);
      assert.match(notice!, /not been confirmed applied/);
      assert.match(notice!, /Session closure status: unconfirmed/);
      assert.match(notice!, /teardown could not be confirmed, so containment is unconfirmed/);
      assert.match(notice!, /recover by restarting the Pi session/);
      // The session is a failed tombstone now; BrowserClose can only echo the
      // same failure, so the notice must not point at it.
      assert.doesNotMatch(notice!, /Use BrowserClose/);
      await assert.rejects(closing, /Browser closure is unconfirmed/);
    } finally {
      context.clearPermissions = originalClear;
      context.close = originalClose;
    }
  } finally {
    // The unconfirmed teardown fails closed for the remainder of the runtime.
    await h.manager.shutdown().catch(() => undefined);
  }
});

test("a post-grant revocation race whose clear fails is contained, not claimed", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true, modelClipboard: true });
    const opened = await h.manager.open("https://race.example.com/");
    await settle();
    const context = lastContext(h);
    context.pages()[0]!.onEvaluate = () => Promise.resolve({ ok: true, text: "race-clipboard" });
    // The save revokes everything exactly while the clipboard grant round-trip
    // is in flight; updateConfig's own revocation queues behind the in-flight
    // grant and its clear fails.
    const originalGrant = context.grantPermissions.bind(context);
    let reportPromise: Promise<BrowserPermissionRevocationReport> | undefined;
    let revoked = false;
    context.grantPermissions = async (permissions: string[], options?: { origin?: string }) => {
      if (!revoked) {
        revoked = true;
        reportPromise = h.setPermissions(DEFAULT_BROWSER_PERMISSIONS);
      }
      return originalGrant(permissions, options);
    };
    const originalClear = context.clearPermissions.bind(context);
    context.clearPermissions = async () => { throw new Error("fixture CDP clear failure"); };
    try {
      await assert.rejects(
        h.manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true),
        /not_started: model clipboard read\/write is disabled.*revocation could not be confirmed.*Session teardown is confirmed/,
      );
      const report = await reportPromise!;
      assert.equal(report.entries.length, 1);
      const entry = report.entries[0]!;
      if (entry.outcome.status !== "unconfirmed") throw new Error(`expected unconfirmed, got ${JSON.stringify(entry.outcome)}`);
      assert.equal(entry.closure, "confirmed");
      // No confirmed clear: the mixed engine grants persist until the owned
      // context close.
      const state = context.finalPermissionState().get("https://race.example.com");
      assert.ok(
        state && [...state].includes("camera") && [...state].includes("clipboard-read"),
        "the engine still holds the revoked grants",
      );
      assert.equal(context.closed, true);
      assert.equal(h.manager.activeSessionCount(), 0);
      await assert.rejects(
        h.manager.snapshot(opened.session, opened.tab, 1_000),
        /Browser session is closed \(fatal_error: .*permission revocation could not be confirmed/,
      );
    } finally {
      context.grantPermissions = originalGrant;
      context.clearPermissions = originalClear;
    }
  } finally { await h.manager.shutdown(); }
});

test("a failed re-grant after a confirmed clear is a reported safe loss, not retained forbidden authority", async () => {
  const h = harness();
  try {
    h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true, modelMicrophone: true });
    const opened = await h.manager.open("https://one.example.com/");
    await settle();
    await h.manager.navigate(opened.session, opened.tab, "https://two.example.org/");
    await settle();
    const context = lastContext(h);
    assert.deepEqual([...context.finalPermissionState().get("https://one.example.com")!].sort(), ["camera", "microphone"]);
    assert.deepEqual([...context.finalPermissionState().get("https://two.example.org")!].sort(), ["camera", "microphone"]);

    // Disable the microphone; the second origin's re-grant fails after the clear.
    const originalGrant = context.grantPermissions.bind(context);
    context.grantPermissions = async (permissions: string[], options?: { origin?: string }) => {
      if (options?.origin === "https://two.example.org") throw new Error("fixture re-grant failure");
      return originalGrant(permissions, options);
    };
    try {
      const report = await h.setPermissions({ ...DEFAULT_BROWSER_PERMISSIONS, modelCamera: true });
      assert.equal(report.entries.length, 1);
      const outcome = report.entries[0]!.outcome;
      if (outcome.status !== "revoked") throw new Error(`expected revoked, got ${JSON.stringify(outcome)}`);
      assert.deepEqual(outcome.regrantFailures.map((failure) => failure.origin), ["https://two.example.org"]);

      // Safe direction: the cleared origin holds nothing (no forbidden grant
      // retained), and the surviving enabled group is intact elsewhere.
      const stateOne = context.finalPermissionState().get("https://one.example.com");
      const stateTwo = context.finalPermissionState().get("https://two.example.org");
      assert.deepEqual([...(stateOne ?? [])].sort(), ["camera"], "the surviving enabled group is re-issued");
      assert.ok(
        stateTwo === undefined || ![...stateTwo].includes("microphone"),
        "no forbidden grant is retained for the failed origin",
      );

      // The session remains usable: a safe loss is reported, not contained.
      const navigated = await h.manager.navigate(opened.session, opened.tab, "https://one.example.com/again/");
      assert.equal(navigated.status, 200);
    } finally {
      context.grantPermissions = originalGrant;
    }
  } finally { await h.manager.shutdown(); }
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
