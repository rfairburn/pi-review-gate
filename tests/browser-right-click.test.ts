import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { normalizeConfig, type BrowserInteractionApproval } from "../src/config";
import {
  BrowserConfirmationPermits,
  BrowserConsequencePolicy,
  type BrowserClickButton,
  type BrowserConfirmationBinding,
  type BrowserTargetStructure,
} from "../src/web/browser-interaction-policy";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";

const PAGE_HTML = `<!doctype html>
<html><head><title>Right-click fixture</title></head>
<body>
  <a id="link" href="/next">Go next</a>
  <button id="act" type="button">Act</button>
  <script>
    const link = document.getElementById('link');
    const act = document.getElementById('act');
    for (const el of [link, act]) {
      el.addEventListener('click', () => { fetch('/clicked?from=' + el.id); });
      el.addEventListener('mousedown', (e) => { window.__down = e.button; });
      el.addEventListener('contextmenu', (e) => {
        // Suppress the browser's native context menu in this fixture.
        e.preventDefault();
        window.__ctx = { type: e.type, button: e.button };
        fetch('/contextmenu?button=' + e.button);
      });
    }
  </script>
</body></html>`;

const NEXT_HTML = "<!doctype html><title>Next page</title><p>Landed on next.</p>";

interface RightClickFixture {
  manager: InteractiveBrowserManager;
  opened: { session: string; tab: string };
  requests: string[];
  rootUrl: string;
  page: Page;
  ref(label: string): Promise<string>;
  close(): Promise<void>;
}

/** Real Chromium behind the local public name pinned to a loopback broker. */
async function fixture(options: {
  approval?: BrowserInteractionApproval;
  confirmationPermits?: BrowserConfirmationPermits;
  openPath?: string;
} = {}): Promise<RightClickFixture> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/next" ? NEXT_HTML : PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let browser!: Browser;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    // right.test resolves to a fixed public address for the manager's policy,
    // while every brokered dial actually reaches the local loopback server.
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, destinationPort) => net.connect({ host: "127.0.0.1", port: destinationPort }),
    launch: async (launchOptions) => browser = await chromium.launch(launchOptions),
    ...(options.confirmationPermits ? { confirmationPermits: options.confirmationPermits } : {}),
  });
  manager.updateConfig(normalizeConfig({}).web!.fetch, options.approval ?? "ask");
  const rootUrl = `http://right.test:${port}${options.openPath ?? "/"}`;
  const opened = await manager.open(rootUrl);
  return {
    manager,
    opened,
    requests,
    rootUrl: `http://right.test:${port}/`,
    page: browser.contexts()[0]!.pages()[0]!,
    async ref(label: string) {
      const snapshot = await manager.snapshot(opened.session, opened.tab, 10_000);
      const line = snapshot.snapshot.split("\n").find((line) => line.includes(`"${label}"`) && line.includes("[ref="));
      const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
      assert.ok(ref, snapshot.snapshot);
      return ref;
    },
    async close() {
      await manager.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

interface PageMouseState { ctx: { type: string; button: number } | null; down: number | null }

function pageState(page: Page): Promise<PageMouseState> {
  return page.evaluate(() => ({
    ctx: (globalThis as Record<string, unknown>).__ctx ?? null,
    down: (globalThis as Record<string, unknown>).__down ?? null,
  })) as Promise<PageMouseState>;
}

/** Resolves only when the page's contextmenu handler actually ran. */
async function waitForContext(page: Page): Promise<void> {
  const handle = await page.waitForFunction(() => (globalThis as Record<string, unknown>).__ctx !== undefined);
  await handle.dispose();
}

test("omitted and explicit left clicks preserve controlled link navigation without page click handlers", async () => {
  const f = await fixture();
  try {
    const { session, tab } = f.opened;
    const omitted = await f.manager.click(session, tab, await f.ref("Go next"));
    assert.equal(omitted.button, "left");
    assert.equal(omitted.consequence, "ordinary_navigation");
    assert.equal(omitted.approval, "not_required");
    assert.equal(omitted.effects.navigation, "observed");
    assert.match(f.page.url(), /\/next$/);
    assert.equal(f.requests.some((r) => r.startsWith("/clicked")), false,
      "controlled navigation must not dispatch page click handlers");

    await f.manager.navigate(session, tab, f.rootUrl);
    const explicit = await f.manager.click(session, tab, await f.ref("Go next"), undefined, undefined, { button: "left" });
    assert.equal(explicit.button, "left");
    assert.equal(explicit.consequence, "ordinary_navigation");
    assert.equal(explicit.approval, "not_required");
    assert.match(f.page.url(), /\/next$/);
    assert.equal(f.requests.filter((r) => r.startsWith("/clicked")).length, 0);
  } finally { await f.close(); }
});

test("right-click on an ordinary link reaches page contextmenu without navigating", async () => {
  const f = await fixture();
  try {
    const { session, tab } = f.opened;
    const before = f.page.url();
    let prompt: string | undefined;
    const result = await f.manager.click(session, tab, await f.ref("Go next"), async (request) => {
      prompt = request.message;
      return true;
    }, undefined, { button: "right" });
    assert.equal(result.button, "right");
    assert.equal(result.consequence, "unknown_or_mixed",
      "the ordinary-left-link exemption never applies to right-clicks");
    assert.equal(result.approval, "human");
    assert.equal(result.confirmed, true);
    assert.match(prompt!, /right-click/);
    await waitForContext(f.page);
    assert.deepEqual(await pageState(f.page), { ctx: { type: "contextmenu", button: 2 }, down: 2 });
    assert.equal(f.page.url(), before, "a right-click must not navigate the ordinary link");
    assert.ok(f.requests.some((r) => r.startsWith("/contextmenu?button=2")));
    assert.equal(f.requests.some((r) => r.startsWith("/clicked")), false);
    assert.equal(result.effects.navigation, "not_observed");
  } finally { await f.close(); }
});

test("right-click dispatches a real button-2 mouse event under automatic approval", async () => {
  const f = await fixture({ approval: "automatically-accept" });
  try {
    const { session, tab } = f.opened;
    const result = await f.manager.click(session, tab, await f.ref("Act"), undefined, undefined, { button: "right" });
    assert.equal(result.button, "right");
    assert.equal(result.consequence, "unknown_or_mixed");
    assert.equal(result.approval, "automatic");
    assert.equal(result.confirmed, false);
    await waitForContext(f.page);
    const state = await pageState(f.page);
    assert.equal(state.down, 2, "the real mousedown carries button 2");
    assert.deepEqual(state.ctx, { type: "contextmenu", button: 2 });
    assert.ok(f.requests.some((r) => r.startsWith("/contextmenu?button=2")));
  } finally { await f.close(); }
});

test("Ask without UI, denial, unavailable confirmation, and automatic deny reject right-clicks before dispatch", async () => {
  const f = await fixture();
  try {
    const { session, tab } = f.opened;
    await assert.rejects(
      f.manager.click(session, tab, await f.ref("Act"), undefined, undefined, { button: "right" }),
      /not_started.*interactive Pi confirmation/,
    );
    await assert.rejects(
      f.manager.click(session, tab, await f.ref("Act"), async () => false, undefined, { button: "right" }),
      /not_started.*denied/,
    );
    await assert.rejects(
      f.manager.click(session, tab, await f.ref("Act"), async () => { throw new Error("UI unavailable"); }, undefined, { button: "right" }),
      /not_started.*unavailable or cancelled/,
    );
    f.manager.updateConfig(normalizeConfig({}).web!.fetch, "automatically-deny");
    await assert.rejects(
      f.manager.click(session, tab, await f.ref("Act"), async () => true, undefined, { button: "right" }),
      /not_started.*automatically denied/,
    );
    assert.deepEqual(await pageState(f.page), { ctx: null, down: null },
      "no page mouse effect occurred for any rejected attempt");

    // The healthy session survives rejections and still dispatches a valid right-click.
    f.manager.updateConfig(normalizeConfig({}).web!.fetch, "automatically-accept");
    const ok = await f.manager.click(session, tab, await f.ref("Act"), undefined, undefined, { button: "right" });
    assert.equal(ok.button, "right");
    await waitForContext(f.page);
  } finally { await f.close(); }
});

test("caller cancellation during right-click approval reports cancellation without page effects", async () => {
  const f = await fixture();
  try {
    const { session, tab } = f.opened;
    const controller = new AbortController();
    let entered = 0;
    let resolveEntered!: () => void;
    const enteredApproval = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const pending = f.manager.click(
      session, tab, await f.ref("Act"),
      // Like a real confirmation UI dismissed by Escape: settle on abort.
      () => {
        entered += 1;
        resolveEntered();
        return new Promise<boolean>((resolve) => {
          if (controller.signal.aborted) resolve(false);
          else controller.signal.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
      controller.signal,
      { button: "right" },
    );
    // Gate the cancellation on real entry into the approval phase, not a guess.
    await enteredApproval;
    controller.abort(new Error("caller cancellation"));
    await assert.rejects(pending, /Browser operation was cancelled.*no rollback is claimed/);
    assert.equal(entered, 1, "cancellation happens exactly once, inside the approval callback");
    // Teardown completion is the lifecycle gate: every in-flight browser command
    // (including any erroneously dispatched click and its subresource) has settled.
    assert.equal(f.manager.activeSessionCount(), 0, "cancellation tears the session down by design");
    assert.equal(f.requests.some((r) => r.startsWith("/contextmenu")), false);
  } finally { await f.close(); }
});

test("stale refs and post-approval target changes reject right-clicks before dispatch", async () => {
  const f = await fixture();
  try {
    const { session, tab } = f.opened;

    // A successful hover invalidates refs; the stale ref cannot be clicked.
    const staleRef = await f.ref("Act");
    await f.manager.hover(session, tab, staleRef);
    await assert.rejects(
      f.manager.click(session, tab, staleRef, async () => true, undefined, { button: "right" }),
      /not_started.*stale/,
    );

    // A target that changes between approval and revalidation cannot consume the permit.
    const ref = await f.ref("Go next");
    await assert.rejects(f.manager.click(session, tab, ref, async () => {
      await f.page.evaluate(() => document.getElementById("link")!.setAttribute("href", "/elsewhere"));
      return true;
    }, undefined, { button: "right" }), /not_started.*approved target or consequence changed/);

    assert.deepEqual(await pageState(f.page), { ctx: null, down: null },
      "no contextmenu effect occurred for rejected attempts");

    // The session is still healthy: a fresh right-click on the unchanged button works.
    const ok = await f.manager.click(session, tab, await f.ref("Act"), async () => true, undefined, { button: "right" });
    assert.equal(ok.button, "right");
    await waitForContext(f.page);
  } finally { await f.close(); }
});

test("click permits bind the exact mouse button and reject left/right mutation and replay", () => {
  let now = 1_000;
  let serial = 0;
  const permits = new BrowserConfirmationPermits(() => now, () => `permit-${++serial}`, 500);
  const policy = new BrowserConsequencePolicy();
  const baseTarget: BrowserTargetStructure = {
    tagName: "a", role: "link", href: "https://example.com/next", target: null,
    download: false, inputType: null, formAssociated: false, formAction: null,
    formMethod: null, ariaHasPopup: null, contentEditable: false, disabled: false,
    inlineEventHandler: false, summaryForDetails: false,
    domPath: "html:nth-of-type(1)> body:nth-of-type(1)> a:nth-of-type(1)",
  };
  const binding: BrowserConfirmationBinding = {
    session: "session", tab: "tab", generation: "generation", operation: "click", ref: "ref",
    origin: "https://example.com/private?token=one", destination: null,
    targetFingerprint: policy.fingerprint(baseTarget), consequence: "unknown_or_mixed",
    valueDigest: null, valueLengths: [], key: null, button: "left",
  };

  const leftPermit = permits.issue(binding);
  assert.equal(permits.consume(leftPermit, { ...binding, button: "right" }), false,
    "a left-click permit cannot authorize a right-click");
  assert.equal(permits.consume(leftPermit, binding), false, "the mismatched attempt already consumed the permit");

  const rightPermit = permits.issue({ ...binding, button: "right" });
  assert.equal(permits.consume(rightPermit, binding), false,
    "a right-click permit cannot authorize a left-click");
  // Mismatch consumes the permit; a fresh matching permit still works.
  const rightReplay = permits.issue({ ...binding, button: "right" });
  assert.equal(permits.consume(rightReplay, { ...binding, button: "right" }), true);
  assert.equal(permits.consume(rightReplay, { ...binding, button: "right" }), false,
    "a successfully consumed right-click permit cannot be replayed");

  // The same structure classified for the other button is a different decision.
  const linkTarget = { ...baseTarget };
  assert.deepEqual(policy.classify(linkTarget), { consequence: "ordinary_navigation", consequential: false, destination: "https://example.com/next" });
  assert.deepEqual(policy.classify(linkTarget, "right"), { consequence: "unknown_or_mixed", consequential: true, destination: null });
});

test("first classification and post-approval revalidation use the same button-aware policy", async () => {
  const permits = new BrowserConfirmationPermits();
  const seenButtons: Array<BrowserClickButton | null> = [];
  const originalIssue = permits.issue.bind(permits);
  permits.issue = (binding) => { seenButtons.push(binding.button); return originalIssue(binding); };
  const originalConsume = permits.consume.bind(permits);
  permits.consume = (permit, binding) => { seenButtons.push(binding.button); return originalConsume(permit, binding); };
  const f = await fixture({ approval: "automatically-accept", confirmationPermits: permits });
  try {
    const result = await f.manager.click(f.opened.session, f.opened.tab, await f.ref("Act"), undefined, undefined, { button: "right" });
    assert.equal(result.button, "right");
    assert.deepEqual(seenButtons, ["right", "right"],
      "issue and revalidated consume must bind the same exact button");
  } finally { await f.close(); }
});

test("invalid mouse buttons are rejected by the manager and tool before approval, effects, or session loss", async () => {
  const f = await fixture();
  try {
    const { session, tab } = f.opened;
    let confirmations = 0;
    const confirmation = async () => { confirmations += 1; return true; };
    for (const button of ["middle", "LEFT", "", 2, null]) {
      await assert.rejects(
        f.manager.click(session, tab, await f.ref("Act"), confirmation, undefined, { button: button as BrowserClickButton }),
        /not_started.*button must be exactly left or right/,
      );
    }
    assert.equal(confirmations, 0, "invalid buttons never reach approval");
    assert.deepEqual(await pageState(f.page), { ctx: null, down: null });

    const tools = new Map<string, any>();
    const web = new WebToolManager(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      normalizeConfig({}),
      undefined,
      undefined,
      f.manager,
    );
    web.register();
    await assert.rejects(tools.get("BrowserClick").execute(
      "bad-button",
      { session, tab, ref: await f.ref("Act"), button: "middle" },
    ), /not_started/);
    assert.equal(f.requests.some((r) => r.startsWith("/contextmenu")), false);

    // The healthy session survives: a valid right-click still works end to end.
    const ok = await tools.get("BrowserClick").execute(
      "good-button",
      { session, tab, ref: await f.ref("Act"), button: "right" },
      undefined,
      undefined,
      { hasUI: true, ui: { confirm: async () => true } },
    );
    assert.equal(ok.isError, false);
    assert.match(ok.content[0].text, /Button: right/);
    await waitForContext(f.page);
  } finally { await f.close(); }
});

test("right-click result metadata names the dispatched button without disclosing page or URL secrets", async () => {
  const f = await fixture({ approval: "automatically-accept", openPath: "/?token=internal-secret" });
  try {
    const { session, tab } = f.opened;
    const result = await f.manager.click(session, tab, await f.ref("Act"), undefined, undefined, { button: "right" });
    assert.equal(result.button, "right");
    assert.equal(result.url, new URL(f.rootUrl).origin, "interaction receipts disclose origin only");
    assert.doesNotMatch(JSON.stringify(result), /internal-secret/);

    const tools = new Map<string, any>();
    const web = new WebToolManager(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      normalizeConfig({}),
      undefined,
      undefined,
      f.manager,
    );
    web.register();
    const toolResult = await tools.get("BrowserClick").execute(
      "metadata",
      { session, tab, ref: await f.ref("Act"), button: "right" },
      undefined,
      undefined,
      { hasUI: true, ui: { confirm: async () => true } },
    );
    assert.equal(toolResult.isError, false);
    assert.match(toolResult.content[0].text, /Button: right/);
    assert.doesNotMatch(JSON.stringify(toolResult), /internal-secret/);
  } finally { await f.close(); }
});

test("hover remains observational and shared interaction schemas do not expose a button", async () => {
  const f = await fixture();
  try {
    const { session, tab } = f.opened;
    const tools = new Map<string, any>();
    const web = new WebToolManager(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      normalizeConfig({}),
      undefined,
      undefined,
      f.manager,
    );
    web.register();

    for (const name of ["BrowserHover", "BrowserInspect", "BrowserFill", "BrowserType", "BrowserSelect", "BrowserPress"]) {
      assert.equal(tools.get(name).parameters.properties.button, undefined,
        `${name} must not accept a click button`);
    }
    assert.deepEqual(Object.keys(tools.get("BrowserClick").parameters.properties), ["session", "tab", "ref", "button"]);
    assert.deepEqual(tools.get("BrowserClick").parameters.properties.button.enum, ["left", "right"]);
    assert.deepEqual(tools.get("BrowserClick").parameters.required, ["session", "tab", "ref"], "button stays optional");

    const hover = await f.manager.hover(session, tab, await f.ref("Go next"));
    assert.equal(hover.operation, "hover");
    assert.equal(hover.button, undefined);
    assert.equal(hover.consequence, "observational");
    assert.deepEqual(await pageState(f.page), { ctx: null, down: null },
      "hover must not trigger contextmenu or click handlers");
    assert.equal(f.requests.some((r) => r.startsWith("/clicked")), false);
  } finally { await f.close(); }
});