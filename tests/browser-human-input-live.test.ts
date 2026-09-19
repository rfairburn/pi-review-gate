import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

async function eventually(body: () => void): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { body(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

test("real browser: trusted human input renews the idle lease, page-script fabrication does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-human-input-"));
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  // Test-only local certificate and trust seam; production TLS validation is unchanged.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=live.test"], { stdio: "ignore" });
  const origin = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(`<!doctype html><title>Human input fixture</title><input id="field"><button id="go">Go</button>
      <script>setInterval(() => { const e = new Event("tick"); document.dispatchEvent(e); }, 25)</script>`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as net.AddressInfo).port;
  const config = normalizeConfig({ web: { browserIdleExpiryMinutes: 1 } });
  const browsers: Browser[] = [];
  let now = 0;
  const manager = new InteractiveBrowserManager(config.web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, destinationPort) => {
      assert.equal(destinationPort, port);
      return net.connect({ host: "127.0.0.1", port });
    },
    launch: async (options) => {
      const browser = await chromium.launch(options);
      browsers.push(browser);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = (contextOptions) => newContext({ ...contextOptions, ignoreHTTPSErrors: true });
      return browser;
    },
    now: () => now,
  });
  const page = () => browsers.at(-1)!.contexts()[0]!.pages()[0]!;
  try {
    // Scenario 1: genuine trusted input renews; the lease then expires exactly
    // on schedule, so untrusted chatter cannot be hiding behind it.
    await manager.open(`https://live.test:${port}/human`);
    now = 30_000;
    await page().locator("#field").click(); // trusted pointerdown/mousedown via the browser input pipeline
    await page().keyboard.type("hello"); // trusted keydown events
    await page().mouse.wheel(0, 120); // trusted wheel event
    await delay(400); // let detector signals land before driving the expiry edge
    now = 89_999; // last renewal (30s) + 59_999ms is inside the 60s window
    manager.updateConfig(config.web!.fetch, "ask", 1);
    await delay(60);
    assert.equal(manager.activeSessionCount(), 1, "trusted human input renewed the finite lease");
    now = 90_000; // last renewal + exactly 60_000ms
    manager.updateConfig(config.web!.fetch, "ask", 1);
    await eventually(() => assert.equal(manager.activeSessionCount(), 0, "lease expires on schedule after the last genuine input"));

    // Scenario 2: only page-reachable fabrication — untrusted dispatchEvent,
    // page-side isTrusted forgery (own property and Event.prototype patch, so
    // the main-world detector reading would have been spoofable), fabricated
    // trusted `click`, background timers, and direct console-channel noise.
    await manager.open(`https://live.test:${port}/scripted`);
    now = 149_999;
    await page().evaluate(() => {
      const forged = (kind: string) => {
        const event = new Event(kind);
        // Instance-level isTrusted is an own non-configurable getter in current
        // Chromium; try it anyway, the prototype-level forgery below is the
        // stronger main-world spoof.
        try { Object.defineProperty(event, "isTrusted", { value: true }); } catch { /* instance forgery refused */ }
        window.dispatchEvent(event);
      };
      for (const kind of ["pointerdown", "mousedown", "keydown", "wheel"]) forged(kind);
      // Prototype-level forgery: a main-world detector would now report every
      // subsequent synthetic event as browser-trusted.
      Object.defineProperty(Event.prototype, "isTrusted", { get: () => true, configurable: true });
      window.dispatchEvent(new KeyboardEvent("keydown"));
      (document.getElementById("field") as HTMLElement).click(); // fabricated trusted `click`, unmonitored kind
      window.scrollTo(0, 100); // programmatic scroll, unmonitored `scroll`
      console.debug("garbage");
      console.debug("0123456789abcdef.pointerdown.1." + "0".repeat(64));
      console.debug(42 as unknown as string);
    });
    await delay(400);
    now = 149_999; // armed at 90_000, expires at 150_000
    manager.updateConfig(config.web!.fetch, "ask", 1);
    await delay(60);
    assert.equal(manager.activeSessionCount(), 1, "page-script fabrication and background timers did not renew");
    now = 150_000;
    manager.updateConfig(config.web!.fetch, "ask", 1);
    await eventually(() => assert.equal(manager.activeSessionCount(), 0, "only genuine trusted input could have kept this alive"));
  } finally {
    await manager.shutdown().catch(() => undefined);
    for (const browser of browsers) await browser.close().catch(() => undefined);
    origin.closeAllConnections();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});