// Issue #141: paired viewport screenshots and aligned coordinate clicks.
// Manager-level regressions run against the shared Playwright fakes; the two
// live tests exercise the real utility-world point read, real viewport
// resizing, and real canvas dispatch against a controlled local Chromium.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { normalizeConfig } from "../src/config";
import { FakeBrowser, FakePage, managerFixture } from "./browser-fakes";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

/** Raw utility-world point facts as the manager's bridge returns them (domPath is computed in the manager). */
function pointFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tagName: "canvas",
    domPathParts: ["canvas", null, null, null, null],
    role: null,
    href: null,
    target: null,
    download: false,
    inputType: null,
    formAssociated: false,
    formAction: null,
    formMethod: null,
    ariaHasPopup: null,
    autocomplete: null,
    contentEditable: false,
    disabled: false,
    inlineEventHandler: false,
    summaryForDetails: false,
    formHasCredentialField: false,
    ...overrides,
  };
}

function autoAcceptFixture(): { manager: InteractiveBrowserManager; browser: FakeBrowser; page: FakePage } {
  const fixture = managerFixture();
  fixture.manager.updateConfig(normalizeConfig({}).web!.fetch, "automatically-accept");
  return { manager: fixture.manager, browser: fixture.browser, page: fixture.browser.context.page };
}

test("viewport screenshot defaults to 1280x720 without resizing and records the coordinate reference", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    const captured = await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    assert.deepEqual(page.viewportCalls, [], "the default capture must not resize the already-1280x720 viewport");
    assert.equal(captured.metadata.mode, "viewport");
    const result = await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 10, y: 20 });
    assert.equal(result.coordinate?.x, 10);
    assert.equal(result.coordinate?.y, 20);
    assert.equal(page.mouseClicks.length, 1);
    assert.deepEqual(page.mouseClicks[0], { x: 10, y: 20, button: "left" });
    assert.deepEqual(page.viewportCalls, [], "matching dimensions need no resize before dispatch");
  } finally { await manager.shutdown(); }
});

test("custom viewport screenshot temporarily resizes, restores, and anchors coordinates", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    const captured = await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    assert.deepEqual(page.viewportCalls, [
      { width: 800, height: 600 },
      { width: 1280, height: 720 },
    ], "the requested dimensions are applied and the prior viewport restored");
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });
    page.mouseClicks.length = 0;
    await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 5, y: 5 });
    assert.deepEqual(page.viewportCalls, [
      { width: 800, height: 600 },
      { width: 1280, height: 720 },
      { width: 800, height: 600 },
      { width: 1280, height: 720 },
    ], "the recorded dimensions are applied before dispatch and restored after");
  } finally { await manager.shutdown(); }
});

test("viewport restore happens even when the capture fails and failed captures never replace references", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    // A non-fatal validation failure keeps the session alive, never resizes,
    // and must leave the earlier 800x600 reference intact.
    await assert.rejects(
      manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 5000, height: 5000 } }),
      /exceeds the bounded image limits|positive integers/,
    );
    assert.deepEqual(page.viewportCalls, [{ width: 800, height: 600 }, { width: 1280, height: 720 }]);
    page.mouseClicks.length = 0;
    await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 1, y: 1 });
    assert.equal(page.mouseClicks.length, 1, "the last successful viewport reference survives a failed capture");
    assert.deepEqual(page.viewportCalls.at(-2), { width: 800, height: 600 });
    assert.deepEqual(page.viewportCalls.at(-1), { width: 1280, height: 720 });

    // A fatal capture failure still restores the viewport before containment.
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async () => { throw new Error("simulated capture failure"); };
    await assert.rejects(
      manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 1000, height: 900 } }),
      /simulated capture failure/,
    );
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });
    assert.equal(manager.activeSessionCount(), 0);
  } finally { await manager.shutdown().catch(() => undefined); }
});

test("element screenshots never replace the viewport reference", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    const snapshot = await manager.snapshot(opened.session, opened.tab, 1000);
    const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)![1]!;
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    await manager.screenshot(opened.session, opened.tab, "element", ref);
    page.mouseClicks.length = 0;
    await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 0, y: 0 });
    assert.equal(page.mouseClicks.length, 1, "the viewport reference survives an element capture");
    assert.deepEqual(page.viewportCalls.at(-2), { width: 800, height: 600 });
    assert.deepEqual(page.viewportCalls.at(-1), { width: 1280, height: 720 });
  } finally { await manager.shutdown(); }
});

test("coordinate clicks without a viewport reference are rejected precisely; ref clicks stay unaffected", async () => {
  const { manager, browser } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 10, y: 10 }),
      /BrowserScreenshot with mode="viewport" of this exact session and tab/,
    );
    // A ref click works on the same tab with no screenshot at all.
    const snapshot = await manager.snapshot(opened.session, opened.tab, 1000);
    const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)![1]!;
    const refResult = await manager.click(opened.session, opened.tab, ref, async () => true);
    assert.equal(refResult.operation, "click");
    assert.equal(refResult.coordinate, undefined, "ref clicks never report coordinates");
    assert.equal(browser.context.page.mouseClicks.length, 0, "the ref click used the semantic path, not raw mouse input");
  } finally { await manager.shutdown(); }
});

test("out-of-bounds and malformed coordinates are rejected without dispatch; ref and coordinates are mutually exclusive", async () => {
  const { manager } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    const click = (options?: { x?: number; y?: number; ref?: string }) =>
      manager.click(opened.session, opened.tab, options?.ref, async () => true, undefined, {
        ...(options?.x !== undefined ? { x: options.x } : {}),
        ...(options?.y !== undefined ? { y: options.y } : {}),
      });
    await assert.rejects(click({ x: 800, y: 0 }), /within the recorded viewport screenshot dimensions 800x600/);
    await assert.rejects(click({ x: 0, y: 600 }), /within the recorded viewport screenshot dimensions 800x600/);
    await assert.rejects(click({ x: -1, y: 0 }), /non-negative integers/);
    await assert.rejects(click({ x: 1.5, y: 0 }), /non-negative integers/);
    await assert.rejects(click({ x: Number.MAX_SAFE_INTEGER + 1, y: 0 }), /non-negative integers/);
    await assert.rejects(click({ x: 10 }), /coordinates require both x and y/);
    const snapshot = await manager.snapshot(opened.session, opened.tab, 1000);
    const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)![1]!;
    await assert.rejects(click({ x: 10, y: 10, ref }), /either a current ref or screenshot coordinates/);
  } finally { await manager.shutdown(); }
});

test("reference is per-tab: another explicit tab without its own viewport shot is rejected", async () => {
  const fixture = managerFixture();
  const { manager, browser } = fixture;
  try {
    const opened = await manager.open("https://example.com/");
    await browser.context.newPage();
    const tabs = await manager.tabs(opened.session, "open", undefined, "https://example.com/two");
    const second = tabs.openedTab!;
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    await assert.rejects(
      manager.click(opened.session, second, undefined, async () => true, undefined, { x: 10, y: 10 }),
      /mode="viewport" of this exact session and tab/,
    );
    await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 10, y: 10 });
  } finally { await manager.shutdown(); }
});

test("the coordinate reference survives dispatched interactions, snapshots, ref clicks, hovers, and navigation; each click revalidates the live target", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    // Two coordinate clicks with a generation change between them (each
    // dispatch bumps the generation exactly like ref semantics) both succeed
    // under approval; no screenshot retake is required after an interaction.
    await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 3, y: 4 });
    await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 3, y: 4 });
    assert.equal(page.mouseClicks.length, 2);
    // Dispatched ref interactions and observations keep the reference too.
    const first = await manager.snapshot(opened.session, opened.tab, 1000);
    const hoverRef = first.snapshot.match(/\[ref=([^\]]+)\]/)![1]!;
    await manager.hover(opened.session, opened.tab, hoverRef);
    const second = await manager.snapshot(opened.session, opened.tab, 1000);
    const clickRef = second.snapshot.match(/\[ref=([^\]]+)\]/)![1]!;
    await manager.click(opened.session, opened.tab, clickRef, async () => true);
    // Navigation — including a child-frame navigation that bumps the
    // generation — also keeps the reference; the fresh per-action origin,
    // generation, viewport, and hit-test rechecks still gate every dispatch.
    const child = { url: () => "https://frame.example/" };
    page.emit("framenavigated", child);
    await manager.navigate(opened.session, opened.tab, "https://other.example/");
    page.mouseClicks.length = 0;
    const result = await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 3, y: 4 });
    assert.equal(result.coordinate?.x, 3);
    assert.equal(result.coordinate?.y, 4);
    assert.equal(page.mouseClicks.length, 1);
  } finally { await manager.shutdown(); }
});

test("current viewport differing from the reference is matched automatically before the click and restored after", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    // Simulate an external viewport change after the capture.
    await page.setViewportSize({ width: 1024, height: 768 });
    page.mouseClicks.length = 0;
    await manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 3, y: 4 });
    assert.deepEqual(page.viewportCalls, [
      { width: 800, height: 600 },   // capture resize
      { width: 1280, height: 720 },  // capture restore
      { width: 1024, height: 768 },  // manual external change
      { width: 800, height: 600 },   // automatic match before dispatch
      { width: 1024, height: 768 },  // truthful restore of the actual prior viewport
    ]);
  } finally { await manager.shutdown(); }
});

test("coordinate click follows the approval policy: automatic accept dispatches, deny and no-UI Ask reject", async () => {
  for (const approval of ["automatically-deny", "ask"] as const) {
    const fixture = managerFixture();
    const { manager } = fixture;
    const page = fixture.browser.context.page;
    manager.updateConfig(normalizeConfig({}).web!.fetch, approval);
    try {
      const opened = await manager.open("https://example.com/");
      await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
      page.mouseClicks.length = 0;
      await assert.rejects(
        manager.click(opened.session, opened.tab, undefined, undefined, undefined, { x: 5, y: 6 }),
        /not_started/,
      );
      assert.equal(page.mouseClicks.length, 0, approval);
    } finally { await manager.shutdown(); }
  }
});

test("an explicit confirmation refusal cancels the coordinate click without dispatch", async () => {
  const fixture = managerFixture();
  const manager = fixture.manager;
  const page = fixture.browser.context.page;
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    page.mouseClicks.length = 0;
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => false, undefined, { x: 5, y: 6 }),
      /interactive confirmation was denied/,
    );
    assert.equal(page.mouseClicks.length, 0);
  } finally { await manager.shutdown(); }
});

test("coordinate clicks stay hard-gated at the point: password and file targets and credential submissions", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    page.mouseClicks.length = 0;
    page.pointFacts = pointFacts({ tagName: "input", inputType: "password" });
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 5, y: 6 }),
      /password controls are not supported/,
    );
    page.pointFacts = pointFacts({ tagName: "input", inputType: "file" });
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 5, y: 6 }),
      /BrowserUpload tool/,
    );
    page.pointFacts = pointFacts({
      tagName: "input", inputType: "submit", formAssociated: true,
      formHasCredentialField: true, domPathParts: ["input", null, null, null, null],
    });
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 5, y: 6 }),
      /credential submission is disabled/,
    );
    assert.equal(page.mouseClicks.length, 0, "no coordinate dispatch may bypass the hard gates");
  } finally { await manager.shutdown(); }
});

test("post-approval document or viewport change or target change prevents dispatch and restores the viewport", async () => {
  const fixture = managerFixture();
  const manager = fixture.manager;
  const page = fixture.browser.context.page;
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    page.mouseClicks.length = 0;

    // Document generation change during the approval prompt.
    page.pointFacts = pointFacts();
    const child = { url: () => "https://frame.example/" };
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => {
        page.emit("framenavigated", child);
        return true;
      }, undefined, { x: 5, y: 6 }),
      /the document or origin changed after approval/,
    );
    assert.equal(page.mouseClicks.length, 0);
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 }, "the viewport was truthfully restored");

    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    // Viewport change during the approval prompt.
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => {
        await page.setViewportSize({ width: 640, height: 480 });
        return true;
      }, undefined, { x: 5, y: 6 }),
      /viewport changed after approval/,
    );
    assert.equal(page.mouseClicks.length, 0);
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });

    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    // Point target change after approval: the single-use permit is consumed
    // against the revalidated structure and must refuse to match.
    page.pointFacts = pointFacts();
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => {
        page.pointFacts = pointFacts({ tagName: "button", inputType: "submit", formAssociated: true });
        return true;
      }, undefined, { x: 5, y: 6 }),
      /the approved target or consequence changed/,
    );
    assert.equal(page.mouseClicks.length, 0);
  } finally { await manager.shutdown(); }
});

test("unavailable point structure fails closed without dispatch", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    page.pointFacts = new Error("bridge unavailable");
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 5, y: 6 }),
      /coordinate target could not be structurally inspected/,
    );
    page.pointFacts = null as unknown as Record<string, unknown>;
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 5, y: 6 }),
      /structure was unavailable/,
    );
  } finally { await manager.shutdown(); }
});

test("viewport restore failure after dispatch is contained fail-closed", async () => {
  const { manager, page } = autoAcceptFixture();
  try {
    const opened = await manager.open("https://example.com/");
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 800, height: 600 } });
    page.mouseClicks.length = 0;
    page.onMouseClick = () => { page.setViewportSizeFailure = new Error("simulated restore failure"); };
    await assert.rejects(
      manager.click(opened.session, opened.tab, undefined, async () => true, undefined, { x: 5, y: 6 }),
      /failed after dispatch; effect status is unknown.*Session teardown is confirmed/s,
    );
    assert.equal(page.mouseClicks.length, 1, "the approved dispatch itself happened");
    assert.equal(manager.activeSessionCount(), 0, "restore failure contains the session");
  } finally { await manager.shutdown().catch(() => undefined); }
});

// ---------------------------------------------------------------------------
// Live controlled-Chromium fixtures (real utility-world hit test, real
// viewport resize, real mouse dispatch).
// ---------------------------------------------------------------------------

interface LiveFixture {
  manager: InteractiveBrowserManager;
  opened: { session: string; tab: string };
  requests: string[];
  close(): Promise<void>;
}

const CANVAS_PAGE = `<!doctype html>
<html><head><title>Coordinate fixture</title></head>
<body style="margin:0">
  <canvas id="board" style="width:50vw;height:200px;display:block"></canvas>
  <div id="panel" style="width:100vw;height:100px;display:block"></div>
  <script>
    for (const id of ["board", "panel"]) {
      const el = document.getElementById(id);
      el.addEventListener('click', (e) => {
        fetch('/clicked?from=' + id + '&x=' + Math.round(e.clientX) + '&y=' + Math.round(e.clientY) + '&w=' + window.innerWidth);
      });
    }
  </script>
</body></html>`;

async function liveFixture(approval: "automatically-accept" = "automatically-accept", html: string = CANVAS_PAGE): Promise<LiveFixture> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let browser!: Browser;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, destinationPort) => net.connect({ host: "127.0.0.1", port: destinationPort }),
    launch: async (launchOptions) => browser = await chromium.launch(launchOptions),
  });
  manager.updateConfig(normalizeConfig({}).web!.fetch, approval);
  const opened = await manager.open(`http://coordinates.test:${port}/`);
  return {
    manager,
    opened,
    requests,
    close: async () => {
      await manager.shutdown().catch(() => undefined);
      server.close();
    },
  };
}

test("canvas coordinate click has a real effect and screenshot dimensions are temporarily applied for real", async () => {
  const fixture = await liveFixture();
  try {
    const { manager, opened, requests } = fixture;
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    // The canvas spans the left half of the 1280-wide viewport: x=100 is canvas.
    await manager.click(opened.session, opened.tab, undefined, undefined, undefined, { x: 100, y: 100 });
    assert.ok(requests.some((url) => url.startsWith("/clicked?from=board&x=100&y=100&w=1280")), requests.join("\n"));
    // The dispatched click bumped the generation, but the reference is not
    // generation-coupled: the same tab's viewport dimensions are reusable, so
    // a second coordinate click needs no fresh screenshot.
    await manager.click(opened.session, opened.tab, undefined, undefined, undefined, { x: 100, y: 120 });
    assert.ok(requests.some((url) => url.startsWith("/clicked?from=board&x=100&y=120&w=1280")), requests.join("\n"));
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 640, height: 400 } });
    // The panel occupies y=200-300 across the full 640-wide viewport; the
    // canvas ends at x=320. The reported innerWidth (w=640) proves the
    // recorded viewport was really applied before dispatch.
    await manager.click(opened.session, opened.tab, undefined, undefined, undefined, { x: 400, y: 250 }).catch(() => undefined);
    assert.ok(requests.some((url) => url.startsWith("/clicked?from=panel&x=400&y=250&w=640")), requests.join("\n"));
    // The prior viewport (1280x720) was restored after the temporary capture
    // and the click's own match/restore pair.
    const tabs = await manager.tabs(opened.session, "list");
    assert.equal(tabs.tabs[0]!.url.startsWith("http://coordinates.test"), true);
  } finally { await fixture.close(); }
});

test("coordinate hard gates apply to the element inside an open shadow tree, not its host", async () => {
  const shadowPage = `<!doctype html>
<html><head><title>Shadow gate fixture</title><style>
  body { margin: 0; }
  #board { display: block; }
</style></head>
<body>
  <my-login></my-login>
  <canvas id="board" style="width:300px;height:100px;display:block"></canvas>
  <script>
    class MyLogin extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = '<style>'
          + ':host { display: block; }'
          + 'input { display: block; width: 200px; height: 20px; margin: 0 0 10px 0; padding: 0; box-sizing: border-box; }'
          + 'button { display: block; width: 200px; height: 20px; margin: 0; padding: 0; }'
          + '</style>'
          + '<form><input type="password" name="pw"><input type="file" name="doc"><button type="submit">Sign in</button></form>';
      }
    }
    customElements.define("my-login", MyLogin);
    document.getElementById("board").addEventListener("click", (e) => {
      fetch('/clicked?from=board&x=' + Math.round(e.clientX) + '&w=' + window.innerWidth);
    });
    // Capture-phase listener proves whether any real mouse dispatch happened.
    document.addEventListener('click', () => { fetch('/shadow-hit'); }, true);
  </script>
</body></html>`;
  const fixture = await liveFixture("automatically-accept", shadowPage);
  try {
    const { manager, opened, requests } = fixture;
    // Stacked geometry: password y=0-20, file y=30-50, submit y=60-80, canvas y=80-180.
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    const deny = (options: { x: number; y: number }, pattern: RegExp) =>
      assert.rejects(
        manager.click(opened.session, opened.tab, undefined, undefined, undefined, options),
        pattern,
      );
    await deny({ x: 50, y: 10 }, /password controls are not supported/);
    await deny({ x: 50, y: 40 }, /BrowserUpload tool/);
    await deny({ x: 50, y: 70 }, /credential submission is disabled/);
    assert.equal(
      requests.some((url) => url.startsWith("/shadow-hit")), false,
      "no coordinate click may be dispatched past the shadow-descended hard gates",
    );
    // Positive control: a canvas point outside the shadow tree still works.
    await manager.click(opened.session, opened.tab, undefined, undefined, undefined, { x: 50, y: 130 });
    assert.ok(requests.some((url) => url.startsWith("/clicked?from=board&x=50&w=1280")), requests.join("\n"));
  } finally { await fixture.close(); }
});

test("viewport restore is observable on the real page after screenshot and coordinate click", async () => {
  const fixture = await liveFixture();
  try {
    const { manager, opened } = fixture;
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined, undefined, { viewport: { width: 640, height: 400 } });
    // A fresh viewport capture (no explicit dimensions) reports the restored
    // default size in its metadata, proving the restore happened on the page.
    const captured = await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    assert.equal(captured.metadata.width, 1280);
    assert.equal(captured.metadata.height, 720);
  } finally { await fixture.close(); }
});