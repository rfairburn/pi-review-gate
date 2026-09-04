import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as net from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

async function fixture(run: (manager: InteractiveBrowserManager, page: Page, url: string, requests: string[]) => Promise<void>, historyLimit = 32) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(request.url === "/final" ? 201 : 200, {
      "content-type": "text/html",
      ...(request.url === "/csp" ? { "content-security-policy": "base-uri 'none'" } : {}),
    });
    if (request.url === "/redirect") {
      response.end('<title>Before</title><script>setTimeout(() => location.replace("/final"), 80)</script>');
    } else if (request.url === "/final") {
      response.end('<title>After</title>');
    } else if (request.url === "/frame") {
      response.end('<base href="http://base.test/docs/"><a href="next#frame">Framed</a>');
    } else {
      response.end(`<!doctype html><title>Navigation</title>
        ${request.url === "/csp" ? '<base href="https://other.test/"><a href="relative">CSP link</a>' : ''}
        <a href="#clicked">Anchor</a><iframe src="/frame"></iframe>
        <input aria-label="Readonly" readonly value="PRIVATE">
        <textarea aria-label="Disabled" disabled>PRIVATE-TEXT</textarea>
        <div contenteditable role="textbox" aria-label="Editable">PRIVATE-EDITABLE</div>
        <button aria-label="Long description" aria-description="${"Description ".repeat(100)}">Long</button>
        <button aria-label="Long describedby" aria-describedby="long">By ID</button><span id="long">${"Reference ".repeat(100)}</span>
        <p id="effects">No getter effects</p>
        <script>
          const mark = () => { document.querySelector('#effects').textContent = 'Getter invoked'; fetch('/probe'); };
          const native = Element.prototype.getAttribute;
          Element.prototype.getAttribute = function(...args) { mark(); return native.apply(this,args); };
          Object.defineProperty(Node.prototype, 'baseURI', {get() {mark(); return 'http://wrong.test/';}});
        </script>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  let browser: Browser | undefined;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async hostname => net.isIP(hostname) ? [hostname] : ["93.184.216.34"],
    brokerDial: (_validated, destinationPort) => net.connect({ host: "127.0.0.1", port: destinationPort }),
    launch: async options => browser = await chromium.launch(options),
    limits: { maxHistoryEntries: historyLimit },
  });
  try {
    // The caller opens the session; expose its page after open through a proxy.
    const page = new Proxy({} as Page, { get: (_target, key) => {
      const actual = browser!.contexts()[0]!.pages()[0]!;
      const value = Reflect.get(actual, key);
      return typeof value === "function" ? value.bind(actual) : value;
    } });
    await run(manager, page, `http://navigation.test:${port}`, requests);
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function ref(manager: InteractiveBrowserManager, session: string, tab: string, name: string) {
  const snapshot = await manager.snapshot(session, tab, 12_000);
  const value = snapshot.snapshot.split("\n").find(line => line.includes(`"${name}"`))?.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(value, snapshot.snapshot);
  return value;
}

test("real navigation preserves fragments for open, navigate, tabs and controlled anchors", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/#opened`);
  assert.equal(page.url(), `${url}/#opened`);
  assert.equal(opened.url, page.url());
  const next = await manager.navigate(opened.session, opened.tab, `${url}/#next`);
  assert.equal(next.url, `${url}/#next`);
  assert.equal(next.status, 200);
  const clicked = await manager.click(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "Anchor"));
  assert.equal(page.url(), `${url}/#clicked`);
  assert.equal(clicked.url, url, "interaction receipts intentionally disclose origin only");
  const tabs = await manager.tabs(opened.session, "open", undefined, `${url}/#tab`);
  assert.equal(tabs.tabs.find(tab => tab.tab === tabs.openedTab)?.url, `${url}/#tab`);
}));

test("real same-document null goto response is successful", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/`);
  await page.evaluate(() => { location.hash = "old"; });
  const navigated = await manager.navigate(opened.session, opened.tab, `${url}/#new`);
  assert.equal(navigated.url, `${url}/#new`);
  assert.equal(navigated.status, 200);
}));

test("real delayed redirect returns one coherent final document", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/redirect`);
  assert.equal(opened.url, page.url());
  assert.equal(opened.url, `${url}/final`);
  assert.equal(opened.title, "After");
  assert.equal(opened.status, 201);
  const history = await manager.history(opened.session, opened.tab, "list", 32);
  assert.equal(history.generation, opened.generation);
  assert.deepEqual(history.entries.map(entry => entry.url), [`${url}/final`]);
  assert.equal(history.entries[0]?.generation, opened.generation);
}));

test("real history distinguishes replacement, identical pushes, page traversal and reload", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/`);
  await page.evaluate(() => {
    history.pushState({}, "", "/one");
    history.replaceState({}, "", "/replacement");
    history.pushState({}, "", "/replacement");
  });
  const listed = await manager.history(opened.session, opened.tab, "list", 32);
  assert.deepEqual(listed.entries.map(entry => entry.url), [`${url}/`, `${url}/replacement`, `${url}/replacement`]);
  const backed = await manager.history(opened.session, opened.tab, "back", 32);
  assert.equal(backed.entries.findIndex(entry => entry.current), 1);
  await page.evaluate(() => history.back());
  await page.waitForURL(`${url}/`);
  const traversed = await manager.history(opened.session, opened.tab, "list", 32);
  assert.equal(traversed.entries.findIndex(entry => entry.current), 0);
  const reloaded = await manager.history(opened.session, opened.tab, "reload", 32);
  assert.equal(reloaded.entries.length, 3);
  const forward = await manager.history(opened.session, opened.tab, "forward", 32);
  assert.equal(forward.url, `${url}/replacement`);
}));

test("real history reports retained-window omissions and includes current entry", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/`);
  await page.evaluate(() => { for (let i = 0; i < 5; i++) history.pushState({}, "", `/entry-${i}`); });
  const listed = await manager.history(opened.session, opened.tab, "list", 3);
  assert.equal(listed.entries.length, 3);
  assert.equal(listed.truncated, true);
  assert.equal(listed.omittedEntries, 3);
  await page.evaluate(() => history.go(-4));
  await page.waitForURL(`${url}/entry-0`);
  const back = await manager.history(opened.session, opened.tab, "list", 1);
  assert.equal(back.entries[0]?.current, true);
  assert.equal(back.omittedEntries, 5);
}, 3));

test("real controlled iframe self link is rejected before top-level effects", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/`);
  await assert.rejects(manager.click(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "Framed")), /not_started.*frame/i);
  assert.equal(page.url(), `${url}/`);
  assert.equal(page.frames()[1]?.url(), `${url}/frame`);
}));

test("real inspect preserves noneditable state and suppresses private text", async () => fixture(async (manager, _page, url, requests) => {
  const opened = await manager.open(`${url}/`);
  for (const name of ["Readonly", "Disabled"]) {
    const inspected = await manager.inspect(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, name));
    assert.equal(inspected.semantic.states.editable, false, name);
    assert.equal(inspected.semantic.visibleText.suppressed, true);
    assert.doesNotMatch(JSON.stringify(inspected), /PRIVATE/);
  }
  const editable = await manager.inspect(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "Editable"));
  assert.equal(editable.semantic.states.editable, true);
  assert.equal(editable.semantic.visibleText.suppressed, true);
  assert.equal(requests.includes("/probe"), false);
}));

test("real inspect resolves frame document base", async () => fixture(async (manager, _page, url, requests) => {
  const opened = await manager.open(`${url}/`);
  const framed = await manager.inspect(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "Framed"));
  assert.equal(framed.semantic.hrefOrigin, "http://base.test");
  assert.equal(requests.includes("/probe"), false);
}));

test("real inspect honors CSP-blocked bases without invoking page getters", async () => fixture(async (manager, page, url, requests) => {
  const opened = await manager.open(`${url}/csp`);
  const inspected = await manager.inspect(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "CSP link"));
  assert.equal(inspected.semantic.hrefOrigin, url);
  assert.equal(await page.locator("#effects").innerText(), "No getter effects");
  assert.equal(requests.includes("/probe"), false);
}));

test("real inspect honors the CSP base policy of a cross-origin owning frame", async () => fixture(async (manager, page, url, requests) => {
  const opened = await manager.open(`${url}/`);
  const frameOrigin = url.replace("navigation.test", "csp-frame.test");
  await page.evaluate(src => {
    const frame = document.createElement("iframe");
    frame.src = src;
    document.body.append(frame);
  }, `${frameOrigin}/csp`);
  const frame = page.frameLocator("iframe").last();
  await frame.getByText("CSP link").waitFor();
  const inspected = await manager.inspect(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "CSP link"));
  assert.equal(inspected.semantic.hrefOrigin, frameOrigin);
  assert.equal(await frame.locator("#effects").innerText(), "No getter effects");
  assert.equal(requests.includes("/probe"), false);
}));

test("real inspect retains bounded long descriptions", async () => fixture(async (manager, _page, url, requests) => {
  const opened = await manager.open(`${url}/`);
  for (const name of ["Long description", "Long describedby"]) {
    const inspected = await manager.inspect(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, name));
    assert.ok(inspected.semantic.accessibleDescription.length > 400, name);
    assert.ok(inspected.semantic.accessibleDescription.length <= 512, name);
  }
  assert.equal(requests.includes("/probe"), false);
}));

test("real child-frame navigation invalidates its prior opaque refs", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/`);
  const framed = await ref(manager, opened.session, opened.tab, "Framed");
  await page.frames()[1]!.goto(`${url}/frame#changed`);
  await assert.rejects(manager.inspect(opened.session, opened.tab, framed), /stale browser semantic ref/);
}));

test("real controlled links reject a non-self document base target before effects", async () => fixture(async (manager, page, url) => {
  const opened = await manager.open(`${url}/`);
  await page.evaluate(() => {
    const base = document.createElement("base");
    base.target = "_blank";
    document.head.append(base);
  });
  await assert.rejects(manager.click(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "Anchor")), /not_started.*effective target/);
  assert.equal(page.url(), `${url}/`);
  assert.equal((await manager.tabs(opened.session, "list")).tabs.length, 1);
}));

test("real interactive fragments do not bypass public URL or redirect validation", async () => fixture(async (manager, _page, url) => {
  await assert.rejects(manager.open("http://127.0.0.1/#public.test"), /private|public|blocked|address/i);
  const opened = await manager.open(`${url}/#http://127.0.0.1/`);
  await assert.rejects(manager.navigate(opened.session, opened.tab, "http://127.0.0.1/#safe"), /private|public|blocked|address/i);
}));

test("real inspect reads inherited document bases and ignores HTML-forbidden base schemes", async () => fixture(async (manager, page, url, requests) => {
  const opened = await manager.open(`${url}/`);
  await page.evaluate(() => {
    const base = document.createElement("base");
    base.href = "javascript:void(0)";
    document.head.append(base);
    const frame = document.createElement("iframe");
    frame.srcdoc = '<a href="relative">Inherited</a>';
    document.body.append(frame);
  });
  await page.frameLocator("iframe").last().getByText("Inherited").waitFor();
  const anchor = await manager.inspect(opened.session, opened.tab, await ref(manager, opened.session, opened.tab, "Anchor"));
  assert.equal(anchor.semantic.hrefOrigin, url);
  const inherited = await ref(manager, opened.session, opened.tab, "Inherited");
  const inheritedDetail = await manager.inspect(opened.session, opened.tab, inherited);
  assert.equal(inheritedDetail.semantic.hrefOrigin, url);
  assert.equal(requests.includes("/probe"), false);
  assert.equal(manager.activeSessionCount(), 1);
}));
