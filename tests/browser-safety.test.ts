import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";
import { createEvidenceState, recordToolResultEvidence } from "../src/evidence";

async function fixture(html: string, shortDeadlines = false) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser!: Browser;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, port) => net.connect({ host: "127.0.0.1", port }),
    launch: async options => browser = await chromium.launch(options),
    ...(shortDeadlines ? { limits: { actionMs: 200, confirmationMs: 200, cleanupMs: 1_000 } } : {}),
  });
  const opened = await manager.open(`http://safety.test:${(server.address() as AddressInfo).port}/`);
  return {
    manager, opened, requests, page: browser.contexts()[0]!.pages()[0]!,
    async ref(label: string) {
      const snapshot = await manager.snapshot(opened.session, opened.tab, 10_000);
      const line = snapshot.snapshot.split("\n").find(line => line.includes(`"${label}"`) && line.includes("[ref="));
      const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
      assert.ok(ref, snapshot.snapshot);
      return ref;
    },
    async close() {
      await manager.shutdown();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("preflight and hover never invoke page-owned structural getters", async () => {
  const f = await fixture(`<!doctype html><button>Act</button><input aria-label="Field"><a href="https://example.com/">Link</a>
    <script>
    const mark = () => { document.title = 'preflight side effect'; fetch('/probe'); };
    const native = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function(...args) { mark(); return native.apply(this,args); };
    for (const [proto, key] of [[HTMLAnchorElement.prototype,'href'],[HTMLInputElement.prototype,'form']]) {
      const descriptor = Object.getOwnPropertyDescriptor(proto,key);
      Object.defineProperty(proto,key,{ get() { mark(); return descriptor.get.call(this); } });
    }
    </script>`);
  try {
    const { session, tab } = f.opened;
    await assert.rejects(f.manager.click(session, tab, await f.ref("Act"), async () => false));
    await assert.rejects(f.manager.fill(session, tab, await f.ref("Field"), "private", async () => false));
    await f.manager.hover(session, tab, await f.ref("Link"));
    await f.page.waitForTimeout(80);
    assert.equal(f.requests.includes("/probe"), false);
    assert.notEqual(await f.page.title(), "preflight side effect");
  } finally { await f.close(); }
});

test("native disclosure toggle handlers require authorization", async () => {
  const f = await fixture(`<!doctype html><details><summary>Details</summary>Content</details>
    <script>document.querySelector('details').addEventListener('toggle', () => fetch('/toggle'));</script>`);
  try {
    const { session, tab } = f.opened;
    const ref = await f.ref("Details");
    await assert.rejects(f.manager.click(session, tab, ref));
    await f.page.waitForTimeout(80);
    assert.equal(f.requests.includes("/toggle"), false);
    await f.manager.click(session, tab, ref, async () => true);
    assert.equal(f.requests.includes("/toggle"), true);
  } finally { await f.close(); }
});

test("literal form values and selected labels remain private in later observations", async () => {
  const f = await fixture(`<!doctype html><input aria-label="Field"><select aria-label="Choices"><option value="a">Initial</option><option value="chosen-value-915">Customer Label 915</option></select><p id="echo">Useful observation</p>
    <script>document.querySelector('input').addEventListener('input', e => {
      const value = e.target.value;
      setTimeout(() => { document.title = value; document.querySelector('#echo').textContent = value;
        console.log(value); history.replaceState({}, '', '/'+value); }, 350);
    });</script>`);
  try {
    const { session, tab } = f.opened;
    await f.manager.fill(session, tab, await f.ref("Field"), "customer-marker-742", async () => true);
    await f.page.waitForTimeout(450);
    const snapshot = await f.manager.snapshot(session, tab, 10_000);
    const consoleResult = await f.manager.console(session, tab, 0, 20);
    assert.doesNotMatch(JSON.stringify([snapshot, consoleResult]), /customer-marker-742/);
    const tools = new Map<string, any>();
    const toolManager = new WebToolManager({ registerTool: tool => tools.set(tool.name, tool) }, normalizeConfig({}), undefined, undefined, f.manager);
    toolManager.register();
    const evidence = createEvidenceState();
    for (const name of ["BrowserSnapshot", "BrowserConsole", "BrowserTabs"]) {
      const result = await tools.get(name).execute("fixture", name === "BrowserTabs" ? { session, operation: "list" } : { session, tab });
      recordToolResultEvidence({ state: evidence, toolName: name, result });
      assert.doesNotMatch(JSON.stringify(result), /customer-marker-742/);
    }
    assert.doesNotMatch(JSON.stringify(evidence), /customer-marker-742/);
    await f.manager.select(session, tab, await f.ref("Choices"), ["chosen-value-915"], async () => true);
    assert.doesNotMatch(JSON.stringify(await f.manager.snapshot(session, tab, 10_000)), /Customer Label 915/);
    await f.page.locator('#echo').textContent();
    await f.page.evaluate(() => { document.querySelector('#echo')!.textContent = 'Useful observation'; });
    assert.match((await f.manager.snapshot(session, tab, 10_000)).snapshot, /Useful observation/);
  } finally { await f.close(); }
});

test("preflight deadline contains and drains pending engine work before returning", async () => {
  const f = await fixture('<!doctype html><button>Act</button>', true);
  try {
    const { session, tab } = f.opened;
    const ref = await f.ref("Act");
    const nativeLocator = f.page.locator.bind(f.page);
    let settled = false;
    f.page.locator = ((selector: string) => {
      const locator = nativeLocator(selector);
      if (selector.startsWith("aria-ref=")) {
        const nativeGet = locator.getAttribute.bind(locator);
        locator.getAttribute = async (name, options) => {
          try {
            await new Promise(resolve => setTimeout(resolve, 400));
            return await nativeGet(name, options);
          } finally { settled = true; }
        };
      }
      return locator;
    }) as typeof f.page.locator;
    const failure = await f.manager.click(session, tab, ref, async () => true).catch(error => error);
    assert.equal(f.page.isClosed(), true, "deadline must not release a still-live browser");
    assert.match(failure.message, /effect status is unknown/);
    assert.equal(settled, true, "no pending engine command is abandoned at the deadline race");
    assert.equal(f.manager.activeSessionCount(), 0);
  } finally { await f.close(); }
});

test("tab-switch deadline drains bringToFront instead of releasing a live session", async () => {
  const f = await fixture('<!doctype html><button>Act</button>', true);
  try {
    const { session, tab } = f.opened;
    const native = f.page.bringToFront.bind(f.page);
    let settled = false;
    f.page.bringToFront = async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 400));
        await native();
      } finally { settled = true; }
    };
    const failure = await f.manager.tabs(session, "switch", tab).catch(error => error);
    assert.equal(f.page.isClosed(), true, "deadline must not release a still-live browser");
    assert.match(failure.message, /effect status is unknown/);
    assert.equal(settled, true);
    assert.equal(f.manager.activeSessionCount(), 0);
  } finally { await f.close(); }
});

test("approval binds the effective owning-form method and action for internal and external controls", async () => {
  for (const external of [false, true]) {
    for (const attribute of ["method", "action"]) {
      const button = `<button ${external ? 'form="owned"' : ''}>Submit</button>`;
      const f = await fixture(`<!doctype html><form id="owned" method="get" action="/approved">${external ? '' : button}</form>${external ? button : ''}`);
      try {
        const { session, tab } = f.opened;
        const ref = await f.ref("Submit");
        await assert.rejects(f.manager.click(session, tab, ref, async () => {
          await f.page.locator("form").evaluate((form, attribute) => form.setAttribute(attribute, attribute === "method" ? "post" : "/changed"), attribute);
          return true;
        }), /not_started.*approved target or consequence changed/);
        assert.equal(f.requests.some(url => url.startsWith("/approved") || url.startsWith("/changed")), false);
        assert.equal(f.manager.activeSessionCount(), 1);
        await f.manager.snapshot(session, tab, 2_000);
      } finally { await f.close(); }
    }
  }
});

test("a failed parallel inspection read cannot orphan a pending sibling command", async () => {
  for (const [operation, delayMs] of [["click", 50], ["click", 400], ["inspect", 50], ["inspect", 400]] as const) {
    const f = await fixture('<!doctype html><button>Act</button>', true);
    try {
      const { session, tab } = f.opened;
      const ref = await f.ref("Act");
      const nativeLocator = f.page.locator.bind(f.page);
      let siblingStarted = false;
      let siblingSettled = false;
      f.page.locator = ((selector: string) => {
        const locator = nativeLocator(selector);
        if (selector.startsWith("aria-ref=")) {
          const nativeGet = locator.getAttribute.bind(locator);
          locator.getAttribute = async (name, options) => {
            if (name === "type") throw new Error("fixture rejected one inspection read");
            if (name === "href") {
              siblingStarted = true;
              try {
                await new Promise(resolve => setTimeout(resolve, delayMs));
                return await nativeGet(name, options);
              } finally { siblingSettled = true; }
            }
            return nativeGet(name, options);
          };
        }
        return locator;
      }) as typeof f.page.locator;
      const failure = await (operation === "click"
        ? f.manager.click(session, tab, ref, async () => true)
        : f.manager.inspect(session, tab, ref)).catch(error => error);
      assert.equal(siblingStarted, true);
      assert.equal(siblingSettled, true, `${operation} must drain the sibling before returning`);
      if (delayMs > 200) {
        assert.equal(f.page.isClosed(), true, "deadline contains still-pending engine work");
        assert.match(failure.message, /effect status is unknown/);
        assert.equal(f.manager.activeSessionCount(), 0);
      } else {
        assert.equal(f.page.isClosed(), false, "settled validation errors need not destroy healthy sessions");
        assert.equal(f.manager.activeSessionCount(), 1);
        assert.match((await f.manager.snapshot(session, tab, 2_000)).snapshot, /Act/);
      }
    } finally { await f.close(); }
  }
});

test("effective form reads bypass hostile getters and named properties while honoring submitter overrides", async () => {
  const f = await fixture(`<!doctype html><form id="owned" method="get" action="/original">
    <input hidden name="action" value="shadow"><input hidden name="method" value="shadow">
    <button formaction="/fixed" formmethod="post">Submit</button></form>
    <script>
      for (const key of ['action', 'method']) {
        const native = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, key);
        Object.defineProperty(HTMLFormElement.prototype, key, {
          get() { fetch('/probe-' + key); return native.get.call(this); }
        });
      }
      const nativeForm = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'form');
      Object.defineProperty(HTMLButtonElement.prototype, 'form', {
        get() { fetch('/probe-form'); return nativeForm.get.call(this); }
      });
    </script>`);
  try {
    const { session, tab } = f.opened;
    const result = await f.manager.click(session, tab, await f.ref("Submit"), async () => {
      // The effective submitter override remains unchanged, so this approval
      // should stay valid even though the form's unused defaults change.
      await f.page.locator("form").evaluate(form => {
        form.setAttribute("action", "/changed");
        form.setAttribute("method", "post");
      });
      return true;
    });
    assert.equal(result.confirmed, true);
    assert.equal(f.requests.includes("/fixed"), true);
    assert.equal(f.requests.some(url => url.startsWith("/probe-") || url.startsWith("/changed") || url.startsWith("/original")), false);
  } finally { await f.close(); }
});

test("harmless screenshot argument errors preserve a usable browser session", async () => {
  const f = await fixture('<!doctype html><button>Act</button>');
  try {
    const { session, tab } = f.opened;
    await assert.rejects(f.manager.screenshot(session, tab, "viewport", await f.ref("Act")), /does not accept ref/);
    assert.equal(f.manager.activeSessionCount(), 1);
    assert.match((await f.manager.snapshot(session, tab, 2_000)).snapshot, /Act/);
    await assert.rejects(f.manager.screenshot(session, tab, "element", undefined), /requires a current ref/);
    assert.equal(f.manager.activeSessionCount(), 1);
    assert.match((await f.manager.snapshot(session, tab, 2_000)).snapshot, /Act/);
  } finally { await f.close(); }
});
