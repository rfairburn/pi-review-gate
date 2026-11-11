import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import * as net from "node:net";
import test from "node:test";
import { chromium, errors as playwrightErrors, type Browser, type Page } from "playwright";
import { normalizeConfig } from "../src/config";
import { ownedBrowserQuiescent, prepareOwnedBrowser } from "../src/web/browser-owned-process";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";
import { managerFixture } from "./browser-fakes";

// Issue #632 regressions: a bounded `BrowserWait` must return one bounded
// observational outcome and leave the live session, its tab handles, its page
// state, and the actual owned Chromium process usable.
//
// Tier 1 drives the registered production tools through the real
// InteractiveBrowserManager, the real egress broker, and real owned headless
// Chromium against an owned local synthetic fixture: a `<canvas>` "board" plus a
// DOM HUD turn indicator with finite, deterministic DOM updates. No live game,
// opponent, credential, or third-party page is involved.
//
// Tier 2 uses the shared fake Playwright fixtures for the schedules real
// Chromium cannot reproduce deterministically: a page-side observation that only
// ever settles after the manager deadline, one that times out first with
// Playwright's own typed timeout, fatal loss that settles the observation while
// containment cannot confirm quiescence, and one observation that never settles
// at all. Both tiers exercise the real tool error path (the registered tool's
// thrown, sanitized exception), not a copied helper or a regex against a fixture
// string.
//
// The injected host resolver and broker dial are the repository's accepted
// test-only seam onto the owned local fixture; they are not live DNS, live
// platform, or real-internet evidence.

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shared seat behaviour for every fixture page: one click advances the seat
 * marker, so a later snapshot proves a normal interaction on the same tab. */
const MOVE_SCRIPT = `var seat = document.getElementById("seat");
var moves = 0;
document.getElementById("move").addEventListener("click", function () {
  moves += 1;
  seat.textContent = "seat:e4-move-" + moves;
  hud.textContent = "Black's Turn";
});`;

/** Synthetic ongoing-game page: a canvas board, a DOM HUD turn indicator, and a
 * seat marker. The HUD turn change is armed explicitly by the fixture (after
 * navigation has settled and while a wait is pending), never on a load timer, so
 * the satisfied case cannot pass on a change that already happened. */
const BOARD_PAGE = `<!doctype html><title>Turn fixture</title><main>
<canvas id="board" width="240" height="240"></canvas>
<p id="hud">White's Turn</p>
<p id="seat">seat:e4-move-0</p>
<button id="move">Move</button>
</main><script>
var hud = document.getElementById("hud");
var ctx = document.getElementById("board").getContext("2d");
ctx.fillStyle = "#123456";
ctx.fillRect(0, 0, 240, 240);
window.__turnFlip = function () { hud.textContent = "Black's Turn"; return true; };
${MOVE_SCRIPT}
</script>`;

/** Same fixture, plus a finite ticker that mutates the DOM while a wait expires.
 * The ticker is armed explicitly by the test after the wait begins, never on a
 * page-load timer, so the overlap window is under the test's control. */
const LIVE_PAGE = `<!doctype html><title>Turn fixture live</title><main>
<canvas id="board" width="240" height="240"></canvas>
<p id="hud">White's Turn</p>
<p id="ticker">tick-0</p>
<p id="seat">seat:e4-move-0</p>
<button id="move">Move</button>
</main><script>
var hud = document.getElementById("hud");
var ticker = document.getElementById("ticker");
var tick = 0;
var timer = null;
window.__startTicker = function () {
  if (timer) return false;
  timer = setInterval(function () {
    tick += 1;
    ticker.textContent = "tick-" + tick;
    if (tick >= 8) clearInterval(timer);
  }, 100);
  return true;
};
${MOVE_SCRIPT}
</script>`;

/** Page-initiated document change armed explicitly by the test while a wait is
 * pending, on a page whose awaited turn text exists only in the next document,
 * so the observation can only settle after the capability epoch changes. */
const NAVIGATING_PAGE = `<!doctype html><title>Turn fixture navigating</title><main>
<canvas id="board" width="240" height="240"></canvas>
<p id="hud">White's Turn</p>
<p id="seat">seat:e4-move-0</p>
<button id="move">Move</button>
</main><script>
var hud = document.getElementById("hud");
window.__navigateNow = function () { window.location.href = "/next"; return true; };
${MOVE_SCRIPT}
</script>`;

const NEXT_PAGE = `<!doctype html><title>Turn fixture next</title><main>
<canvas id="board" width="240" height="240"></canvas>
<p id="hud">Black's Turn</p>
<p id="seat">seat:e4-move-0</p>
<button id="move">Move</button>
</main><script>
var hud = document.getElementById("hud");
${MOVE_SCRIPT}
</script>`;

function toolHost(manager: InteractiveBrowserManager, config: ReturnType<typeof normalizeConfig>) {
  const tools = new Map<string, { execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> }>();
  const boundary = new WebToolManager({ registerTool: (tool: any) => tools.set(tool.name, tool) }, config, undefined, undefined, manager);
  boundary.register();
  return (name: string) => tools.get(name)! as {
    execute(id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, context?: unknown): Promise<any>;
  };
}

async function liveFixture() {
  const sockets = new Set<net.Socket>();
  const origin = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://turn.test").pathname;
    const body = path === "/live" ? LIVE_PAGE : path === "/navigating" ? NAVIGATING_PAGE : path === "/next" ? NEXT_PAGE : BOARD_PAGE;
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(body);
  });
  origin.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as net.AddressInfo).port;
  // Positive owned browser identity only: the child retained by the product's
  // own ownership bridge for this exact local launch. Nothing here scans process
  // names or signals any process the fixture did not start.
  const owned: { browser?: Browser; child?: ChildProcess } = {};
  const config = normalizeConfig({ web: { browserInteractionApproval: "automatically-accept" } });
  const manager = new InteractiveBrowserManager(config.web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      return socket;
    },
    launch: async (options) => {
      const browser = await prepareOwnedBrowser(await chromium.launch(options));
      const child = (browser as unknown as {
        _connection?: { toImpl?: (value: Browser) => { options?: { browserProcess?: { process?: ChildProcess } } } };
      })._connection?.toImpl?.(browser)?.options?.browserProcess?.process;
      assert.ok(child instanceof ChildProcess && child.pid !== undefined && child.pid > 0,
        "the fixture launched this Chromium itself, so its child process is a positive owned identity");
      owned.browser = browser;
      owned.child = child;
      return browser;
    },
  });
  const call = toolHost(manager, config);
  return {
    manager,
    port,
    call,
    /** True while the retained owned child is a live OS process, using the
     * product's own non-signalling quiescence probe plus the pid. */
    ownedAlive: () => {
      assert.ok(owned.browser && owned.child?.pid, "the fixture launched this Chromium itself");
      return !ownedBrowserQuiescent(owned.browser) && osProcessAlive(owned.child!.pid!);
    },
    /** The retained owned child, for the one test that must terminate it. */
    ownedChild: () => {
      assert.ok(owned.child, "the fixture launched this Chromium itself");
      return owned.child;
    },
    /** Arm one finite, explicit fixture-side DOM change on the page this fixture
     * launched. This is fixture control over the owned synthetic page; the asserted
     * wait outcome still comes from the registered tool. Each arm is invoked only
     * after the wait is already pending, so no fixture change can race the wait
     * from a page-load timer. */
    arm: async (arm: "__turnFlip" | "__startTicker" | "__navigateNow") => {
      const page = owned.browser?.contexts().flatMap((context) => context.pages()).at(0) as Page | undefined;
      assert.ok(page, "the fixture's owned browser still exposes the page it launched");
      const armed = await page.evaluate(`typeof ${arm} === "function" && ${arm}()`);
      assert.equal(armed, true, `the owned fixture page ran its ${arm} arm`);
    },
    async cleanup() {
      await manager.shutdown().catch(() => undefined);
      origin.closeAllConnections();
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    },
  };
}

/** Non-signalling existence probe for a pid this test launched itself. */
function osProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Applicable normal interaction on the same handles: one click advances the
 * fixture seat marker, so a later snapshot proves the retained tab still takes
 * real page input rather than only answering read-only calls. */
async function assertInteractionUsable(
  call: ReturnType<typeof toolHost>,
  snapshot: { details: { response: { snapshot: string } } },
  session: string,
  tab: string,
) {
  const ref = /"Move" \[ref=([^\]]+)\]/.exec(snapshot.details.response.snapshot)?.[1];
  assert.ok(ref, "the fixture button carries a current ref on the retained tab");
  const clicked = await call("BrowserClick").execute("issue-632-interaction", { session, tab, ref });
  assert.equal(clicked.details.response.session, session);
  assert.equal(clicked.details.response.tab, tab);
  const after = await call("BrowserSnapshot").execute("issue-632-interaction-after", { session, tab, maxChars: 4_000 });
  assert.match(after.details.response.snapshot, /seat:e4-move-1/, "the retained tab kept the normal interaction state");
}

/** The usability contract every BrowserWait outcome must satisfy: the same
 * session/tab handles still list, snapshot, and screenshot. */
async function assertHandlesUsable(
  call: ReturnType<typeof toolHost>,
  session: string,
  tab: string,
  expectedHud: RegExp,
) {
  // A real capture requires the host's image-delivery contract.
  const context = { model: { input: ["text", "image"] }, hasUI: true };
  const listed = await call("BrowserTabs").execute("issue-632-tabs", { session, operation: "list" });
  assert.deepEqual(listed.details.response.tabs.map((entry: { tab: string }) => entry.tab), [tab],
    "the same owned tab handle is still listed after the wait");
  assert.equal(listed.details.response.activeTab, tab);
  const snapshot = await call("BrowserSnapshot").execute("issue-632-snapshot", { session, tab, maxChars: 4_000 });
  assert.match(snapshot.details.response.snapshot, expectedHud, "the observed page state is retained after the wait");
  const shot = await call("BrowserScreenshot").execute("issue-632-screenshot", { session, tab, mode: "viewport" }, undefined, undefined, context);
  assert.equal(shot.isError, false);
  assert.ok(shot.content.some((part: { type: string }) => part.type === "image"),
    "the retained live tab still produces a real viewport capture");
  return snapshot;
}

test("real satisfied BrowserWait on a DOM turn change retains handles, page state, and the owned Chromium process", { timeout: 60_000 }, async () => {
  const fixture = await liveFixture();
  try {
    const opened = await fixture.call("BrowserOpen").execute("issue-632-open", { url: `http://turn.test:${fixture.port}/board` });
    const { session, tab } = opened.details.response;
    assert.ok(fixture.ownedAlive(), "the owned Chromium process is running before the wait");

    // The turn has not changed yet: navigation settled without any DOM change,
    // so a satisfied result can only come from a change observed while pending.
    const before = await fixture.call("BrowserSnapshot").execute("issue-632-before-flip", { session, tab, maxChars: 4_000 });
    assert.match(before.details.response.snapshot, /White's Turn/, "the fixture turn has not changed before the wait starts");
    assert.doesNotMatch(before.details.response.snapshot, /Black's Turn/);

    const waiting = fixture.call("BrowserWait").execute("issue-632-wait", {
      session, tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    // Yield so the registered wait reaches its page-side observation, then arm the
    // fixture's single finite HUD update underneath the pending wait.
    await delay(40);
    await fixture.arm("__turnFlip");
    const waited = await waiting;
    assert.equal(waited.details.response.satisfied, true);
    assert.equal(waited.details.response.session, session);
    assert.equal(waited.details.response.tab, tab);
    assert.ok(waited.details.response.elapsedMs >= 30,
      "the observation was already running when the page changed the turn");

    const snapshot = await assertHandlesUsable(fixture.call, session, tab, /Black's Turn/);
    assert.ok(fixture.ownedAlive(), "the actual owned Chromium process is still alive after the satisfied wait");

    // Applicable normal interaction on the same handles: the page keeps the
    // resulting seat state.
    await assertInteractionUsable(fixture.call, snapshot, session, tab);
    assert.ok(fixture.ownedAlive(), "a normal interaction after the wait does not disturb the owned process");

    // Literal punctuation semantics are unchanged: a typographic apostrophe is a
    // different literal string, so absence of it is trivially satisfied.
    const literal = await fixture.call("BrowserWait").execute("issue-632-literal", {
      session, tab, condition: "text", text: "Black\u2019s Turn", present: false, timeoutMs: 1_000,
    });
    assert.equal(literal.details.response.satisfied, true);
    await assertHandlesUsable(fixture.call, session, tab, /seat:e4-move-1/);
  } finally {
    await fixture.cleanup();
  }
});

test("real expired BrowserWait returns a bounded deadline outcome and keeps the same handles and owned process", { timeout: 60_000 }, async () => {
  const fixture = await liveFixture();
  try {
    const opened = await fixture.call("BrowserOpen").execute("issue-632-open", { url: `http://turn.test:${fixture.port}/board` });
    const { session, tab } = opened.details.response;

    await assert.rejects(
      fixture.call("BrowserWait").execute("issue-632-expired", {
        session, tab, condition: "text", text: "Checkmate", present: true, timeoutMs: 400,
      }),
      (error: Error) => {
        assert.match(error.message, /^BrowserWait failed: deadline exceeded/);
        assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight/);
        assert.ok(error.message.length < 512);
        return true;
      },
    );

    const snapshot = await assertHandlesUsable(fixture.call, session, tab, /White's Turn/);
    assert.ok(fixture.ownedAlive(), "the actual owned Chromium process survived the expired wait");
    // Applicable normal interaction on the same handles after the expired wait.
    await assertInteractionUsable(fixture.call, snapshot, session, tab);
    assert.ok(fixture.ownedAlive(), "a normal interaction after the expired wait does not disturb the owned process");

    // A second bounded wait on the same handles still works.
    const again = await fixture.call("BrowserWait").execute("issue-632-again", { session, tab, condition: "duration", durationMs: 10, timeoutMs: 1_000 });
    assert.equal(again.details.response.satisfied, true);
  } finally {
    await fixture.cleanup();
  }
});

test("real expired BrowserWait overlapping live finite DOM updates stays bounded and retains the session", { timeout: 60_000 }, async () => {
  const fixture = await liveFixture();
  try {
    const opened = await fixture.call("BrowserOpen").execute("issue-632-open", { url: `http://turn.test:${fixture.port}/live` });
    const { session, tab } = opened.details.response;
    const before = await fixture.call("BrowserSnapshot").execute("issue-632-before", { session, tab, maxChars: 4_000 });
    const tickBefore = Number(/tick-(\d+)/.exec(before.details.response.snapshot)?.[1]);
    assert.equal(tickBefore, 0, "the fixture ticker has not started before the wait does");

    const waiting = fixture.call("BrowserWait").execute("issue-632-overlap", {
      session, tab, condition: "text", text: "Mate in 1", present: true, timeoutMs: 700,
    });
    // The finite DOM updates are armed only once the wait is already pending, so
    // the overlap window is under the test's control rather than a load timer.
    await delay(40);
    await fixture.arm("__startTicker");

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: deadline exceeded/);
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight/);
      return true;
    });

    const after = await fixture.call("BrowserSnapshot").execute("issue-632-after", { session, tab, maxChars: 4_000 });
    const tickAfter = Number(/tick-(\d+)/.exec(after.details.response.snapshot)?.[1]);
    assert.ok(tickAfter > tickBefore, "the wait really overlapped live page DOM updates");
    const snapshot = await assertHandlesUsable(fixture.call, session, tab, /tick-\d+/);
    assert.ok(fixture.ownedAlive(), "the actual owned Chromium process survived a wait that expired mid-update");
    // Applicable normal interaction on the same handles while the page mutates.
    await assertInteractionUsable(fixture.call, snapshot, session, tab);
    assert.ok(fixture.ownedAlive(), "a normal interaction during live page updates does not disturb the owned process");
  } finally {
    await fixture.cleanup();
  }
});

test("real duration-at-deadline BrowserWait canary stays bounded and never strands the session", { timeout: 90_000 }, async () => {
  const fixture = await liveFixture();
  try {
    const opened = await fixture.call("BrowserOpen").execute("issue-632-open", { url: `http://turn.test:${fixture.port}/board` });
    const { session, tab } = opened.details.response;
    let boundedDeadlines = 0;
    let satisfied = 0;
    // The manager deadline and the page-side timeout start within the same tick,
    // so either side can win. Both outcomes must be bounded and must retain the
    // session; the reported failure mode was the deadline-first ordering.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const waited = await fixture.call("BrowserWait").execute(`issue-632-canary-${attempt}`, {
          session, tab, condition: "duration", durationMs: 250, timeoutMs: 250,
        });
        assert.equal(waited.details.response.satisfied, true);
        satisfied += 1;
      } catch (error) {
        boundedDeadlines += 1;
        const message = (error as Error).message;
        assert.match(message, /^BrowserWait failed: deadline exceeded/);
        assert.doesNotMatch(message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight|session was contained/);
      }
      await assertHandlesUsable(fixture.call, session, tab, /White's Turn/);
      assert.ok(fixture.ownedAlive(), "the actual owned Chromium process is alive after each canary attempt");
    }
    assert.equal(boundedDeadlines + satisfied, 4, "every canary attempt produced exactly one bounded outcome");
  } finally {
    await fixture.cleanup();
  }
});

test("real settled observational error (document change during a wait) keeps read-only language and the same handles", { timeout: 60_000 }, async () => {
  const fixture = await liveFixture();
  try {
    const opened = await fixture.call("BrowserOpen").execute("issue-632-open", { url: `http://turn.test:${fixture.port}/navigating` });
    const { session, tab } = opened.details.response;

    const waiting = fixture.call("BrowserWait").execute("issue-632-document-changed", {
      session, tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    // The page-initiated document change is armed only once the wait is already
    // pending, so the epoch change cannot race the wait from a load timer.
    await delay(120);
    await fixture.arm("__navigateNow");

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: the observed document changed during the wait/);
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment/);
      assert.ok(error.message.length < 512);
      return true;
    });

    const snapshot = await assertHandlesUsable(fixture.call, session, tab, /Black's Turn/);
    assert.ok(fixture.ownedAlive(), "the actual owned Chromium process is alive after the rejected observation");
    // Applicable normal interaction on the same handles after the document change.
    await assertInteractionUsable(fixture.call, snapshot, session, tab);
    assert.ok(fixture.ownedAlive(), "a normal interaction after the document change does not disturb the owned process");
  } finally {
    await fixture.cleanup();
  }
});

test("real owned Chromium loss during a BrowserWait stays fail-closed and reports the authoritative closed session", { timeout: 60_000 }, async () => {
  const fixture = await liveFixture();
  try {
    const opened = await fixture.call("BrowserOpen").execute("issue-632-open", { url: `http://turn.test:${fixture.port}/board` });
    const { session, tab } = opened.details.response;
    const waiting = fixture.call("BrowserWait").execute("issue-632-loss", {
      session, tab, condition: "text", text: "Checkmate", present: true, timeoutMs: 8_000,
    });
    await delay(400);
    // Positive owned process identity only: this fixture launched this Chromium.
    const child = fixture.ownedChild();
    child.kill("SIGKILL");

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: /);
      assert.doesNotMatch(error.message, /were retained|no page effect occurred|remain usable|was not closed/,
        "a lost browser is never reported as a retained session");
      assert.doesNotMatch(error.message, /net::|Target (page|closed)|browser has been closed|playwright/i,
        "the loss report never echoes raw page, Chromium, or Playwright text");
      assert.doesNotMatch(error.message, /BrowserTabs operation=list/,
        "whole-session loss never offers the tab listing that cannot work on a dead session handle");
      assert.match(error.message, /BrowserOpen/, "whole-session loss names the one recovery that works");
      assert.ok(error.message.length < 512);
      return true;
    });

    assert.equal(fixture.ownedAlive(), false, "the owned Chromium process this fixture terminated is gone");

    await assert.rejects(
      fixture.call("BrowserTabs").execute("issue-632-after-loss", { session, operation: "list" }),
      (error: Error) => {
        assert.match(error.message, /the browser session is closed \((fatal_error|session_shutdown); category=browser_process_failure\)/,
          "the follow-up call reports the authoritative closure state with its safe cause, not a generic containment hint");
        assert.match(error.message, /BrowserOpen/);
        assert.doesNotMatch(error.message, /check session containment|net::|Target (page|closed)|SIGKILL|Chromium|crashed/,
          "the safe category is a fixed enum value, never a guess about the operating-system process or raw browser text");
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a deadline that wins the race drains the read-only observation instead of containing a healthy session", async () => {
  const { manager, browser } = managerFixture({ cleanupMs: 500 });
  try {
    // The page-side observation never times out on its own: the manager's own
    // deadline always wins the race, and the observation settles only after it.
    // This is the deterministic shape of the reported failure.
    browser.context.page.getByText = () => ({
      filter: () => ({ first: () => ({ waitFor: async () => { await delay(80); } }) }),
    });
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    await assert.rejects(
      call("BrowserWait").execute("issue-632-deadline-first", {
        session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 20,
      }),
      (error: Error) => {
        assert.match(error.message, /^BrowserWait failed: deadline exceeded/);
        assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight|session was contained/);
        return true;
      },
    );
    assert.equal(manager.activeSessionCount(), 1, "the deadline-first race no longer tears the session down");
    const snapshot = await assertHandlesUsable(call, opened.session, opened.tab, /Next/);
    // Applicable normal interaction on the same handles after the drained deadline.
    const ref = /\[ref=([^\]]+)\]/.exec(snapshot.details.response.snapshot)?.[1];
    assert.ok(ref, "the retained tab still hands out a current ref");
    const clicked = await call("BrowserClick").execute("issue-632-deadline-first-click", {
      session: opened.session, tab: opened.tab, ref: ref!,
    });
    assert.equal(clicked.details.response.session, opened.session);
    assert.equal(clicked.details.response.tab, opened.tab);
  } finally {
    await manager.shutdown();
  }
});

test("a page-side timeout that wins the race is still reported as the wait's own bounded deadline", async () => {
  const { manager, browser } = managerFixture();
  try {
    // The page-side observation times out first with Playwright's own typed
    // timeout error, before the manager deadline can trip.
    const pageTimeout = new playwrightErrors.TimeoutError("locator.waitFor: Timeout 20ms exceeded.");
    browser.context.page.getByText = () => ({
      filter: () => ({ first: () => ({ waitFor: async () => { throw pageTimeout; } }) }),
    });
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    await assert.rejects(
      call("BrowserWait").execute("issue-632-page-timeout-first", {
        session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
      }),
      (error: Error) => {
        assert.match(error.message, /^BrowserWait failed: deadline exceeded/,
          "a page-side timeout must not be reported as a settled observational error");
        assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight|session was contained/);
        assert.ok(error.message.length < 512);
        return true;
      },
    );
    assert.equal(manager.activeSessionCount(), 1, "the page-side timeout race does not contain a healthy session");
    await assertHandlesUsable(call, opened.session, opened.tab, /Next/);
  } finally {
    await manager.shutdown();
  }
});

test("fatal loss that settles the observation with unconfirmable containment keeps observation-only wording", async () => {
  const { manager, browser } = managerFixture({ cleanupMs: 10, hangingContextClose: true });
  try {
    const opened = await manager.open("https://example.com/turn");
    // The observation settles only when the owned browser goes away: this is a
    // settled read-only observation ended by fatal loss, not a wedged read.
    browser.context.page.getByText = () => ({
      filter: () => ({
        first: () => ({
          waitFor: () => new Promise<never>((_resolve, reject) => {
            browser.once("disconnected", () => reject(new Error("fixture: owned browser disconnected")));
          }),
        }),
      }),
    });
    const call = toolHost(manager, normalizeConfig({}));
    const waiting = call("BrowserWait").execute("issue-632-fatal-unconfirmed", {
      session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    await delay(10);
    await browser.close();

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: /);
      assert.match(error.message, /teardown could not be confirmed/, "the unconfirmed containment is stated truthfully");
      assert.match(error.message, /restart(ing)? the Pi session/, "restart is the recovery that applies");
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight/,
        "a settled read-only observation is never reported as page-effect or rollback uncertainty");
      assert.doesNotMatch(error.message, /did not settle/, "a settled observation is never labelled unsettled");
      assert.doesNotMatch(error.message, /were retained|remain usable/, "a lost session is never claimed retained");
      assert.ok(error.message.length < 512);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "the failed session is not reusable");
    // Fail-closed reuse: uncertain ownership rejects new work immediately, and
    // shutdown publishes the permanent unconfirmed-quiescence failure.
    await assert.rejects(manager.open("https://example.com/after-unconfirmed"), /browser manager is shut down/i);
    await assert.rejects(manager.shutdown(), /could not confirm quiescence/i);
  } finally {
    await manager.shutdown().catch(() => undefined);
  }
});

test("a settled observational error keeps read-only language and the same usable session", async () => {
  const { manager } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    const before = await call("BrowserSnapshot").execute("issue-632-before-error", { session: opened.session, tab: opened.tab, maxChars: 1_000 });
    assert.match(before.details.response.snapshot, /Next/);
    // The shared fake settles the observation with an error immediately, so this
    // is a settled observational failure rather than a deadline.
    await assert.rejects(
      call("BrowserWait").execute("issue-632-observation-error", {
        session: opened.session, tab: opened.tab, condition: "text", text: "Missing", present: true, timeoutMs: 1_000,
      }),
      (error: Error) => {
        assert.match(error.message, /^BrowserWait failed: the bounded read-only observation settled with an error/);
        assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|Missing/);
        assert.ok(error.message.length < 512);
        return true;
      },
    );
    assert.equal(manager.activeSessionCount(), 1, "a settled read-only observation error does not contain the session");
    await assertHandlesUsable(call, opened.session, opened.tab, /Next/);
  } finally {
    await manager.shutdown();
  }
});

test("a genuinely wedged read-only observation is still contained fail-closed with the observation-specific reason", async () => {
  const { manager, browser } = managerFixture({ cleanupMs: 30 });
  try {
    // Never settles while the page is live; it only rejects when teardown closes
    // the page, which is what a real in-flight page command does.
    const page = browser.context.page;
    page.getByText = () => ({
      filter: () => ({
        first: () => ({
          waitFor: () => new Promise<never>((_resolve, reject) => {
            page.once("close", () => reject(new Error("fixture: page closed")));
          }),
        }),
      }),
    });
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    await assert.rejects(
      call("BrowserWait").execute("issue-632-wedged", {
        session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 20,
      }),
      (error: Error) => {
        assert.match(error.message, /^BrowserWait failed: the bounded read-only observation did not settle/);
        assert.match(error.message, /BrowserOpen/);
        assert.doesNotMatch(error.message, /were retained|no page effect occurred|remain usable/);
        assert.ok(error.message.length < 512);
        return true;
      },
    );
    assert.equal(manager.activeSessionCount(), 0, "a wedged observation still contains the session fail-closed");
  } finally {
    await manager.shutdown();
  }
});

test("external cancellation of a BrowserWait keeps its existing containment policy", async () => {
  const { manager } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const controller = new AbortController();
    const waiting = manager.wait(opened.session, opened.tab, { condition: "duration", durationMs: 500 }, 1_000, controller.signal);
    await delay(10);
    controller.abort(new Error("cancel wait fixture"));
    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait was cancelled/);
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment/,
        "a cancelled read-only observation never claims page-effect or rollback uncertainty");
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "cancellation still contains the session as before");
  } finally {
    await manager.shutdown();
  }
});

test("external cancellation of a registered BrowserWait reports observation-only cancellation at the tool boundary", async () => {
  const { manager } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    const controller = new AbortController();
    const waiting = call("BrowserWait").execute("issue-632-cancel-boundary", {
      session: opened.session, tab: opened.tab, condition: "duration", durationMs: 500, timeoutMs: 1_000,
    }, controller.signal);
    await delay(10);
    controller.abort(new Error("cancel wait fixture"));

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait was cancelled during its bounded read-only observation/);
      assert.match(error.message, /no page effect occurred and no rollback applies/);
      assert.match(error.message, /Session teardown was confirmed; use BrowserOpen/);
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight/);
      assert.ok(error.message.length < 512);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "cancellation still contains the session fail-closed");
  } finally {
    await manager.shutdown();
  }
});

test("external cancellation while the bounded drain is running still contains the session and reports observation-only cancellation", async () => {
  const { manager, browser } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    // The observation settles only when the test releases it, so the wait's own
    // deadline is already tripped and the body is inside the bounded drain when
    // the external cancellation arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    browser.context.page.getByText = () => ({
      filter: () => ({ first: () => ({ waitFor: async () => { await gate; } }) }),
    });
    const call = toolHost(manager, normalizeConfig({}));
    const controller = new AbortController();
    const waiting = call("BrowserWait").execute("issue-632-cancel-during-drain", {
      session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 100,
    }, controller.signal);
    await delay(150);
    controller.abort(new Error("cancel wait fixture"));
    await delay(20);
    release();

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait was cancelled during its bounded read-only observation/);
      assert.match(error.message, /Session teardown was confirmed; use BrowserOpen/);
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|did not settle/,
        "a drained read-only observation is never reported as unsettled page work");
      assert.ok(error.message.length < 512);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "cancellation during the drain still contains the session fail-closed");
  } finally {
    await manager.shutdown();
  }
});

test("cancellation whose containment cannot confirm teardown keeps the unconfirmed teardown and restart recovery without effect claims", async () => {
  const { manager, browser } = managerFixture({ cleanupMs: 10, hangingContextClose: true });
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    const controller = new AbortController();
    const waiting = call("BrowserWait").execute("issue-632-cancel-unconfirmed", {
      session: opened.session, tab: opened.tab, condition: "duration", durationMs: 500, timeoutMs: 1_000,
    }, controller.signal);
    await delay(10);
    controller.abort(new Error("cancel wait fixture"));

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait was cancelled during its bounded read-only observation/);
      assert.match(error.message, /teardown could not be confirmed/, "the unconfirmed containment stays stated truthfully");
      assert.match(error.message, /restart(ing)? the Pi session/, "restart is the recovery that applies");
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment/,
        "a cancelled read-only observation never claims page-effect or rollback uncertainty");
      assert.ok(error.message.length < 512);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "the failed session is not reusable");
    await assert.rejects(manager.shutdown(), /could not confirm quiescence/i);
  } finally {
    await manager.shutdown().catch(() => undefined);
  }
});

test("one closed observed tab in a live session reports tab-only loss with the single recovery that works", async () => {
  const { manager, browser } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    const second = await call("BrowserTabs").execute("issue-632-tab-loss-open", {
      session: opened.session, operation: "open", url: "https://example.com/other",
    });
    const otherTab = second.details.response.openedTab as string;
    assert.ok(otherTab && otherTab !== opened.tab, "the session owns a second usable tab");

    const page = browser.context.page;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The observation settles only after the observed page is gone, the way a
    // real in-flight page command rejects on closure.
    page.getByText = () => ({
      filter: () => ({
        first: () => ({
          waitFor: async () => {
            await gate;
            throw new Error("fixture: observed page closed");
          },
        }),
      }),
    });
    const waiting = call("BrowserWait").execute("issue-632-tab-loss", {
      session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    await delay(20);
    await page.close();
    release();

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: the observed tab closed during the bounded observation while the browser session stayed live/);
      assert.match(error.message, /BrowserTabs operation=list on this session/,
        "tab-only loss names the one recovery that works on a live session");
      assert.doesNotMatch(error.message, /BrowserOpen|were retained|effect status is unknown|no rollback is claimed|check session containment/,
        "tab-only loss never sends the caller to BrowserOpen for a live session, nor claims the dead tab handle");
      assert.ok(error.message.length < 512);
      return true;
    });

    assert.equal(manager.activeSessionCount(), 1, "the live session survives the loss of one observed tab");
    const listed = await call("BrowserTabs").execute("issue-632-tab-loss-list", { session: opened.session, operation: "list" });
    assert.deepEqual(listed.details.response.tabs.map((entry: { tab: string }) => entry.tab), [otherTab],
      "the listed tab is the recovery the report points to");
  } finally {
    await manager.shutdown();
  }
});

/** Give the shared fake page a gated text observation that only settles when the
 * test releases it, and settles successfully rather than rejecting. */
function pageGate(browser: { context: { page: any } }, gate: Promise<void>): void {
  browser.context.page.getByText = () => ({
    filter: () => ({ first: () => ({ waitFor: async () => { await gate; } }) }),
  });
}

test("a successfully settled observation whose tab closed meanwhile reports tab-only loss instead of a satisfied result", async () => {
  const { manager, browser } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    const second = await call("BrowserTabs").execute("issue-632-settled-tab-open", {
      session: opened.session, operation: "open", url: "https://example.com/other",
    });
    const otherTab = second.details.response.openedTab as string;
    assert.ok(otherTab && otherTab !== opened.tab, "the session owns a second usable tab");

    const page = browser.context.page;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // No navigation event and no fatal session state: the document epoch is
    // unchanged, so only the manager's own liveness inspection on the success
    // path can stop this from being reported as a satisfied wait.
    pageGate(browser, gate);
    const waiting = call("BrowserWait").execute("issue-632-settled-tab-loss", {
      session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    await delay(20);
    await page.close();
    release();

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: the observed tab closed during the bounded observation while the browser session stayed live/,
        "a settled observation on a closed tab is never a satisfied result");
      assert.match(error.message, /BrowserTabs operation=list on this session/);
      assert.doesNotMatch(error.message, /BrowserOpen|were retained|effect status is unknown|no rollback is claimed|check session containment/,
        "the closed tab handle is never claimed retained and no dead-session recovery is offered");
      assert.ok(error.message.length < 512);
      return true;
    });

    assert.equal(manager.activeSessionCount(), 1, "the owning session stays live with its other tab");
    const listed = await call("BrowserTabs").execute("issue-632-settled-tab-loss-list", { session: opened.session, operation: "list" });
    assert.deepEqual(listed.details.response.tabs.map((entry: { tab: string }) => entry.tab), [otherTab],
      "the listed tab is the recovery the report points to");
  } finally {
    await manager.shutdown();
  }
});

test("whole-browser loss at a successfully settled observation keeps observation-only wording with the confirmed BrowserOpen recovery", async () => {
  const { manager, browser } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The observation settles successfully right after the browser goes away, so
    // only the success-path liveness check can keep this off the generic fatal
    // error path with its page-effect uncertainty wording.
    pageGate(browser, gate);
    const waiting = call("BrowserWait").execute("issue-632-settled-session-loss", {
      session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    await delay(20);
    await browser.close();
    release();

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: the observed page's browser session became unavailable during the bounded observation/);
      assert.match(error.message, /use BrowserOpen to start a new browser for this Pi session/);
      assert.doesNotMatch(error.message, /BrowserTabs operation=list|were retained|effect status is unknown|no rollback is claimed|check session containment|left work in flight|did not settle/);
      assert.ok(error.message.length < 512);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "the lost session is contained fail-closed");
  } finally {
    await manager.shutdown();
  }
});

test("whole-browser loss at a successfully settled observation with unconfirmable containment keeps observation wording and restart recovery", async () => {
  const { manager, browser } = managerFixture({ cleanupMs: 10, hangingContextClose: true });
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    pageGate(browser, gate);
    const waiting = call("BrowserWait").execute("issue-632-settled-session-loss-unconfirmed", {
      session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    await delay(20);
    await browser.close();
    release();

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: the observed page or its browser session became unavailable during the bounded observation/);
      assert.match(error.message, /teardown could not be confirmed/, "the unconfirmed containment stays stated truthfully");
      assert.match(error.message, /restart(ing)? the Pi session/, "restart is the recovery that applies");
      assert.doesNotMatch(error.message, /effect status is unknown|no rollback is claimed|check session containment|left work in flight|did not settle|were retained/,
        "a settled read-only observation is never reported as page-effect or rollback uncertainty");
      assert.ok(error.message.length < 512);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 0, "the lost session is not reusable");
    await assert.rejects(manager.shutdown(), /could not confirm quiescence/i);
  } finally {
    await manager.shutdown().catch(() => undefined);
  }
});

test("a document change is only reported as a same-handle retry while liveness is proved; real loss wins over the document wording", async () => {
  const { manager, browser } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    await call("BrowserTabs").execute("issue-632-epoch-loss-open", {
      session: opened.session, operation: "open", url: "https://example.com/other",
    });

    const page = browser.context.page;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The observation succeeds, so only the manager's own liveness inspection can
    // stop it from claiming the same session and tab handles.
    page.getByText = () => ({ filter: () => ({ first: () => ({ waitFor: async () => { await gate; } }) }) });
    const waiting = call("BrowserWait").execute("issue-632-epoch-and-loss", {
      session: opened.session, tab: opened.tab, condition: "text", text: "Black's Turn", present: true, timeoutMs: 5_000,
    });
    await delay(20);
    page.emit("framenavigated", page.frame);   // the tab's document epoch changes
    await page.close();                        // and the observed tab really goes away
    release();

    await assert.rejects(waiting, (error: Error) => {
      assert.match(error.message, /^BrowserWait failed: the observed tab closed during the bounded observation/,
        "authoritative loss wins over the document-change wording");
      assert.doesNotMatch(error.message, /the observed document changed|same session and tab handles/,
        "a lost tab is never told to retry with the same handles");
      assert.ok(error.message.length < 512);
      return true;
    });
    assert.equal(manager.activeSessionCount(), 1, "the owning session is still live for its remaining tab");
  } finally {
    await manager.shutdown();
  }
});

test("a closed session's tombstone names the safe manager-computed cause beside the closure kind for every later call", async () => {
  const { manager, browser } = managerFixture();
  try {
    const opened = await manager.open("https://example.com/turn");
    const call = toolHost(manager, normalizeConfig({}));
    // Authoritative whole-browser loss the manager observes itself, so the safe
    // cause is computed from fixed manager-owned state rather than a guess.
    await browser.close();
    for (let attempt = 0; attempt < 100 && manager.activeSessionCount() > 0; attempt += 1) await delay(10);
    assert.equal(manager.activeSessionCount(), 0, "the disconnected session is contained");

    await assert.rejects(
      call("BrowserSnapshot").execute("issue-632-tombstone", { session: opened.session, tab: opened.tab, maxChars: 1_000 }),
      (error: Error) => {
        assert.match(error.message, /the browser session is closed \(fatal_error; category=browser_process_failure\)/,
          "the safe fixed cause is reported alongside the closure kind");
        assert.match(error.message, /BrowserOpen/);
        assert.doesNotMatch(error.message, /check session containment|owned elsewhere|fixture|Target (page|closed)/);
        return true;
      },
    );
  } finally {
    await manager.shutdown();
  }
});
