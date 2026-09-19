/**
 * Issue #27 bounded slice: real-engine facts for the remaining browser
 * permissions that a fake cannot prove. A local 127.0.0.1 fixture origin is a
 * secure context (loopback http), which device and service-worker APIs
 * require; `localNetworks` is enabled so the egress broker may reach it. Raw
 * Playwright probes on the manager's own browser context prove: that the
 * default-off state is a real engine denial (geolocation permission denied),
 * that an enabled capability lands as a real per-origin grant (permission
 * state transitions to granted and the denial code disappears — without any
 * fabricated coordinates), that live revocation clears the grant from the
 * running context, that headless camera/microphone report their honest host
 * limitation (granted permission, unsupported device) rather than a
 * permission failure, and that service workers are genuinely blocked at
 * context creation by default and register/activate only after the controlled
 * replacement under the enabled policy — with worker traffic still arriving
 * through the broker-only egress path.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig } from "../src/config";
import { InteractiveBrowserManager, type BrowserVisibilityResult } from "../src/web/interactive-browser";

const SW_JS = [
  "self.addEventListener('install', (e) => self.skipWaiting());",
  "self.addEventListener('activate', async (e) => {",
  "  await self.clients.claim();",
  // Worker-initiated fetch: if it reaches the fixture server, the worker's
  // network path traversed the broker-only egress stack end to end.
  "  try { await fetch('/sw-worker-fetch'); } catch (e) {}",
  "});",
].join("\n");

interface DeviceLiveFixture {
  manager: InteractiveBrowserManager;
  server: Server;
  origin: string;
  workspaceRoot: string;
  /** Requests the fixture origin received, by URL path. */
  hits: Map<string, number>;
  browser(): Browser;
  close(): Promise<void>;
}

async function startFixtureServer(hits: Map<string, number>): Promise<{ server: Server; origin: string }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? "/";
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (request.method === "GET" && url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Device fixture</title><main><p id=\"device\">device-fixture-page</p><a id=\"popup-link\" href=\"/popup-target\" target=\"_blank\">open popup</a></main>");
      return;
    }
    if (request.method === "GET" && url === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
      response.end(SW_JS);
      return;
    }
    if (request.method === "GET" && url === "/sw-worker-fetch") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("worker-fetch-ok");
      return;
    }
    if (request.method === "GET") {
      // /t1..t3 and /popup-target: plain document pages.
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>Fixture ${url}</title><main><p>fixture-page</p></main>`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function fixture(): Promise<DeviceLiveFixture> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "browser-device-live-"));
  const hits = new Map<string, number>();
  const started = await startFixtureServer(hits);
  let browser: Browser | undefined;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async (hostname) => (net.isIP(hostname) ? [hostname] : ["93.184.216.34"]),
    launch: async (options) => browser = await chromium.launch(options),
    workspaceRoot,
  });
  return {
    manager,
    server: started.server,
    origin: started.origin,
    workspaceRoot,
    hits,
    browser() {
      if (!browser) throw new Error("browser has not launched yet");
      return browser;
    },
    async close() {
      await manager.shutdown();
      if (browser) await browser.close().catch(() => undefined);
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

/** Probe the engine's own permission state for a name on the current page. */
async function queryPermission(page: Page, name: string): Promise<string> {
  return page.evaluate(async (permissionName) => {
    try {
      const status = await navigator.permissions.query({ name: permissionName as PermissionName });
      return status.state;
    } catch {
      return "unqueryable";
    }
  }, name);
}

/** Geolocation probe: resolves to the error code (or null when a position was
 * actually delivered — never fabricated by this test). */
async function geolocationProbe(page: Page): Promise<{ code: number | null; coords?: { latitude: number } }> {
  return page.evaluate(() => new Promise<{ code: number | null; coords?: { latitude: number } }>((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ code: null, coords: { latitude: position.coords.latitude } }),
        (error) => resolve({ code: error.code }),
        { timeout: 4_000, maximumAge: 600_000 },
      );
    } catch (error) {
      resolve({ code: -1, coords: undefined });
      void error;
    }
  }));
}

test("default-off: geolocation is a real engine denial before any manager grant", async () => {
  const fx = await fixture();
  try {
    // localNetworks must be on for the loopback origin to load at all; every
    // device capability stays at its default (off).
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true });
    const opened = await fx.manager.open(`${fx.origin}/`);
    const page = fx.browser().contexts()[0].pages()[0];
    const state = await queryPermission(page, "geolocation");
    assert.notEqual(state, "granted", "no capability enabled: the engine must not report a grant");
    const probe = await geolocationProbe(page);
    assert.equal(probe.code, 1, "PERMISSION_DENIED: the default is a real denial, not just settings state");
    void opened;
  } finally { await fx.close(); }
});

test("enabled: per-origin grant transitions the engine state and revocation clears it live", async () => {
  const fx = await fixture();
  try {
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true, modelGeolocation: true });
    const opened = await fx.manager.open(`${fx.origin}/`);
    const page = fx.browser().contexts()[0].pages()[0];
    // The navigation commit issued the per-origin grant; the engine agrees.
    assert.equal(await queryPermission(page, "geolocation"), "granted");
    // The denial code is gone: either a real position (never fabricated here)
    // or a non-permission failure such as POSITION_UNAVAILABLE in a sandbox
    // without a location source. Both prove the grant is in force.
    const probe = await geolocationProbe(page);
    assert.notEqual(probe.code, 1, "a granted origin must not be permission-denied");
    if (probe.code !== null) {
      assert.ok(probe.code >= 2, `expected a non-permission geolocation failure code, got ${probe.code}`);
    }
    // Live revocation clears the grant from the running context.
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true });
    await delay(100);
    assert.notEqual(await queryPermission(page, "geolocation"), "granted", "the running context lost its grant on revocation");
    void opened;
  } finally { await fx.close(); }
});

test("camera/microphone: granted permission state with the honest headless device limitation", async () => {
  const fx = await fixture();
  try {
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true, modelCamera: true, modelMicrophone: true });
    const opened = await fx.manager.open(`${fx.origin}/`);
    const page = fx.browser().contexts()[0].pages()[0];
    assert.equal(await queryPermission(page, "camera"), "granted");
    assert.equal(await queryPermission(page, "microphone"), "granted");
    // Headless Chromium has no camera device path: the honest outcome is a
    // device-level failure (NotSupportedError on the pinned build), NOT a
    // permission failure. The assertion pins that distinction.
    const video = await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((track) => track.stop());
        return { name: "ok" };
      } catch (error) {
        return { name: error instanceof Error ? error.name : String(error) };
      }
    });
    assert.notEqual(video.name, "NotAllowedError", "the permission was granted; the failure (if any) is a device limitation");
    void opened;
  } finally { await fx.close(); }
});

test("service workers: blocked at context creation by default; allowed only after the controlled replacement", async () => {
  const fx = await fixture();
  try {
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true });
    const opened = await fx.manager.open(`${fx.origin}/`);
    const page = fx.browser().contexts()[0].pages()[0];
    // Default: registration never activates.
    const blocked = await page.evaluate(async () => {
      try {
        const reg = await Promise.race([
          navigator.serviceWorker.register("/sw.js"),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
        ]);
        if (!reg) return "pending";
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        return reg.active ? "active" : "inactive";
      } catch {
        return "rejected";
      }
    });
    assert.notEqual(blocked, "active", "the default context blocks service workers at creation");
    // Enable the capability: the launch-pinned mode differs, so the live
    // browser is replaced through the ordinary ownership path.
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true, modelServiceWorkers: true });
    const result = (await fx.manager.applyVisibility(false)) as BrowserVisibilityResult;
    assert.equal(result.relaunched, true);
    assert.equal(result.serviceWorkers, "allow");
    // In the replacement context the same registration activates...
    const freshPage = fx.browser().contexts()[0].pages()[0];
    const activated = await freshPage.evaluate(async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const active = reg.active ?? await new Promise<ServiceWorker | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 10_000);
          reg.installing?.addEventListener("statechange", () => {
            if (reg.active) { clearTimeout(timer); resolve(reg.active); }
          });
        });
        return active ? "active" : "inactive";
      } catch {
        return "rejected";
      }
    });
    assert.equal(activated, "active");
    // ...and its worker-initiated fetch reached the fixture origin through
    // the broker-only egress path (the only network route Chromium has).
    const deadline = Date.now() + 5_000;
    while ((fx.hits.get("/sw-worker-fetch") ?? 0) === 0 && Date.now() < deadline) await delay(100);
    assert.ok((fx.hits.get("/sw-worker-fetch") ?? 0) > 0, "service-worker traffic egressed through the broker to the origin");
    void opened;
  } finally { await fx.close(); }
});

test("popup override on: a real page-created popup beyond the cap is adopted as an owned tab", async () => {
  const fx = await fixture();
  try {
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true, modelPopupRestrictionOverride: true });
    const opened = await fx.manager.open(`${fx.origin}/`);
    for (const suffix of ["/t1", "/t2", "/t3"]) {
      await fx.manager.tabs(opened.session, "open", undefined, `${fx.origin}${suffix}`);
    }
    // Four owned tabs: a page-created popup now exceeds the ordinary cap.
    // A trusted click on a target=_blank link is what creates it (headless
    // Chromium blocks untrusted window.open).
    const page = fx.browser().contexts()[0].pages()[0];
    await page.click("#popup-link");
    // Wait for adoption (or refusal) to settle.
    let listed: Awaited<ReturnType<InteractiveBrowserManager["tabs"]>> | undefined;
    const deadline = Date.now() + 5_000;
    for (;;) {
      listed = await fx.manager.tabs(opened.session, "list");
      if (listed.tabs.length >= 5 || Date.now() >= deadline) break;
      await delay(100);
    }
    assert.equal(listed?.tabs.length, 5, "the over-limit popup was adopted as an owned tab while the override is enabled");
  } finally { await fx.close(); }
});
