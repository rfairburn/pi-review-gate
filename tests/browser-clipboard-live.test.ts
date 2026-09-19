/**
 * Issue #27 bounded slice: real-engine behavior for BrowserClipboard. A local
 * 127.0.0.1 fixture origin is a secure context (loopback http), which the
 * clipboard API requires; `localNetworks` is enabled so the egress broker may
 * reach it. Raw Playwright probes on the same browser context prove engine
 * facts the manager cannot assert about itself: that no grant exists while the
 * capability is off, that an approved operation really lands text in the
 * engine clipboard, that grants are per-origin (a second loopback origin with
 * no grant is still refused), and that live revocation clears the grant from
 * the running context. Headless Chromium keeps a per-instance virtual
 * clipboard; the manager reports that scope honestly instead of claiming host
 * pasteboard access.
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
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ClipboardFixture {
  manager: InteractiveBrowserManager;
  serverA: Server;
  serverB: Server;
  originA: string;
  originB: string;
  workspaceRoot: string;
  /** The real launched browser, captured by the launch seam for raw probes. */
  browser(): Browser;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Clipboard fixture</title><main><p id=\"clip\">clipboard-fixture-page</p></main>");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function fixture(): Promise<ClipboardFixture> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "browser-clipboard-live-"));
  const a = await startFixtureServer();
  const b = await startFixtureServer();
  let browser: Browser | undefined;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async (hostname) => (net.isIP(hostname) ? [hostname] : ["93.184.216.34"]),
    launch: async (options) => browser = await chromium.launch(options),
    workspaceRoot,
  });
  return {
    manager,
    serverA: a.server,
    serverB: b.server,
    originA: a.origin,
    originB: b.origin,
    workspaceRoot,
    browser() {
      if (!browser) throw new Error("browser has not launched yet");
      return browser;
    },
    async close() {
      await manager.shutdown();
      if (browser) await browser.close().catch(() => undefined);
      await Promise.all([a.server, b.server].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

/** Raw engine probe: read the clipboard with no manager involvement. */
async function rawRead(page: Page): Promise<{ ok: boolean; text?: string; name?: string }> {
  return page.evaluate(async () => {
    try {
      const text = await navigator.clipboard.readText();
      return { ok: true, text };
    } catch (error) {
      return { ok: false, name: error instanceof Error ? error.name : String(error) };
    }
  });
}

async function rawReadEventually(page: Page, wantOk: boolean): Promise<{ ok: boolean; text?: string; name?: string }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await rawRead(page);
    if (result.ok === wantOk) return result;
    if (Date.now() >= deadline) throw new Error(`clipboard grant state did not reach ok=${wantOk} (last: ${JSON.stringify(result)})`);
    await delay(50);
  }
}

test("default-off: the precise denial precedes any dispatch and no per-origin grant is issued", async () => {
  const fx = await fixture();
  try {
    // localNetworks must be on for the loopback origin to load at all; the
    // clipboard capability itself stays at its default (off).
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true });
    const opened = await fx.manager.open(`${fx.originA}/`);
    let prompts = 0;
    await assert.rejects(
      fx.manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => { prompts += 1; return true; }),
      /not_started: model clipboard read\/write is disabled by the managed-browser permissions; nothing was read from or written to the clipboard\./,
    );
    assert.equal(prompts, 0);
    // Raw engine probe: without a manager-issued grant the origin is refused.
    const page = fx.browser().contexts()[0].pages()[0];
    const raw = await rawRead(page);
    assert.equal(raw.ok, false, "an ungranted secure-context origin cannot read the clipboard");
    assert.equal(raw.name, "NotAllowedError");
  } finally { await fx.close(); }
});

test("enabled + Ask accept: write/read roundtrip lands real text in the engine clipboard", async () => {
  const fx = await fixture();
  try {
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true, modelClipboard: true });
    const opened = await fx.manager.open(`${fx.originA}/`);
    const page = fx.browser().contexts()[0].pages()[0];
    const payload = `clipboard-live-roundtrip-${Date.now()}`;
    let prompt: { title: string; message: string } | undefined;
    const written = await fx.manager.clipboard(opened.session, opened.tab, "clipboard_write", payload, async (request) => {
      prompt = request;
      return true;
    });
    assert.equal(written.operation, "clipboard_write");
    assert.equal(written.approval, "human");
    assert.equal(written.confirmed, true);
    assert.equal(written.writtenChars, payload.length);
    assert.equal(written.clipboardScope, "browser-internal", "headless Chromium keeps a virtual clipboard; the manager says so");
    assert.ok(prompt!.message.includes(`${payload.length} character(s)`));
    assert.ok(!prompt!.message.includes(payload), "the approval prompt never shows the value");
    // Least privilege: the approved write granted only clipboard-write for
    // this origin — a raw read is still refused by the engine.
    const rawBeforeRead = await rawRead(page);
    assert.equal(rawBeforeRead.ok, false, "an approved write must not grant standing read access to the origin");
    assert.equal(rawBeforeRead.name, "NotAllowedError");
    // The manager's own approved read takes its own per-direction grant and
    // returns the exact text.
    const read = await fx.manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(read.operation, "clipboard_read");
    assert.equal(read.approval, "human");
    assert.equal(read.text, payload);
    assert.equal(read.truncated, false);
    assert.equal(read.originalChars, payload.length);
    // Raw engine probe: with the read direction granted, the text really is
    // in the engine clipboard — proving the approved write landed.
    const raw = await rawRead(page);
    assert.equal(raw.ok, true, "the manager-issued per-origin read grant lets the page read the clipboard");
    assert.equal(raw.text, payload);
  } finally { await fx.close(); }
});

test("grants are per-origin and live revocation clears the grant from the running context", async () => {
  const fx = await fixture();
  try {
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true, modelClipboard: true });
    const opened = await fx.manager.open(`${fx.originA}/`);
    const context = fx.browser().contexts()[0];
    const pageA = context.pages()[0];
    // An approved read issues the per-origin grant for origin A.
    const read = await fx.manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(read.approval, "human");
    // Origin B (different loopback port) has no grant: the engine refuses it
    // even though origin A in the same context is granted.
    const pageB = await context.newPage();
    await pageB.goto(`${fx.originB}/`);
    const rawB = await rawRead(pageB);
    assert.equal(rawB.ok, false, "a grant for one origin never leaks to another");
    assert.equal(rawB.name, "NotAllowedError");
    // Live revocation: the capability turns off while the session is open.
    fx.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, localNetworks: true });
    const rawAfter = await rawReadEventually(pageA, false);
    assert.equal(rawAfter.name, "NotAllowedError", "the running context lost the grant");
    // And the manager denies again before any approval prompt.
    let prompts = 0;
    await assert.rejects(
      fx.manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => { prompts += 1; return true; }),
      /not_started: model clipboard read\/write is disabled by the managed-browser permissions/,
    );
    assert.equal(prompts, 0);
  } finally { await fx.close(); }
});
