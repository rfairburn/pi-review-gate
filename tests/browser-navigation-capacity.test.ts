import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { normalizeConfig } from "../src/config";
import { BrowserFailureError, InteractiveBrowserManager } from "../src/web/interactive-browser";

// Only emit fixed tokens, never URLs, credentials or arbitrary error messages.
function failureDiagnostic(error: unknown): string {
  const chain: string[] = [];
  for (let depth = 0; error instanceof Error && depth < 4; depth++) {
    chain.push(JSON.stringify({
      phase: error instanceof BrowserFailureError ? error.phase : undefined,
      category: error instanceof BrowserFailureError ? error.category : undefined,
      codes: error.message.slice(0, 4096).match(/\bnet::ERR_[A-Z_]{1,64}\b/g)?.slice(0, 8),
      timeout: /timeout|deadline/i.test(error.message),
      pending: /in flight|unknown/i.test(error.message),
      policy: /blocked|non-public|policy/i.test(error.message),
      closed: /closed|disconnect/i.test(error.message),
    }));
    error = error.cause;
  }
  return chain.join(" caused by ");
}

for (const control of ["recover", "security", "pending"] as const) test(`real navigation capacity failure: ${control}`, { timeout: 30000 }, async t => {
  const origin = createServer((_req, res) => {
    res.setHeader("Connection", "close");
    res.end('<title>Capacity fixture</title><button>Apply</button>');
  });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as net.AddressInfo).port;
  let proxyPort = 0;
  let authorization = "";
  let browser: Browser;
  const sockets: net.Socket[] = [];
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    limits: { navigationMs: 3000 },
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: () => net.connect({ host: "127.0.0.1", port: originPort }),
    launch: async options => {
      proxyPort = Number(new URL(options!.proxy!.server).port);
      authorization = Buffer.from(`${options!.proxy!.username}:${options!.proxy!.password}`).toString("base64");
      browser = await chromium.launch(options);
      return browser;
    },
  });
  try {
    const opened = await manager.open("http://capacity.test/first");
    const snapshot = await manager.snapshot(opened.session, opened.tab, 2000);
    const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)![1]!;
    for (let i = 0; i < 64; i++) {
      const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    }
    await delay(50);
    let originalFailure: unknown;
    {
      const page = browser!.contexts()[0]!.pages()[0]!;
      const goto = page.goto.bind(page);
      page.goto = async (...args) => {
        try { return await goto(...args); } catch (error) {
          originalFailure = error;
          assert.match(String(error), /net::ERR_/);
          if (control === "pending") {
            // The original connection failed, but manager-owned command work
            // has not settled. Capacity cannot excuse this uncertainty.
            await new Promise<void>(resolve => page.once("close", () => resolve()));
          } else if (control === "security") {
            sockets[0]!.destroy();
            await delay(50);
            const denied = net.connect({ host: "127.0.0.1", port: proxyPort });
            sockets.push(denied);
            denied.on("error", () => undefined);
            const response = new Promise<void>(resolve => {
              denied.once("data", () => resolve());
              denied.once("close", () => resolve());
            });
            denied.write(`CONNECT denied.test:443 HTTP/1.1\r\nHost: denied.test:443\r\nUpgrade: websocket\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
            await response;
            denied.destroy();
          }
          throw error;
        }
      };
    }
    const navigating = manager.navigate(opened.session, opened.tab, "http://other-capacity.test/second");
    if (control !== "recover") {
      await assert.rejects(navigating, control === "pending" ? /in flight.*unknown/ : /non-public|blocked|refused|in flight.*unknown/i);
      assert.equal(manager.activeSessionCount(), 0, `${control} must remain fatal despite capacity refusal`);
      return;
    }
    let navigationFailure: unknown;
    await assert.rejects(navigating, error => {
      navigationFailure = error;
      assert.match(String(error), /net::ERR_/);
      return true;
    });
    t.diagnostic(failureDiagnostic(navigationFailure));
    assert.equal(manager.activeSessionCount(), 1, `settled connection refusal must not destroy healthy browser: manager=${failureDiagnostic(navigationFailure)}; goto=${failureDiagnostic(originalFailure)}`);
    assert.ok((await manager.network(opened.session, opened.tab)).brokerCapacityRefusals > 0);
    await assert.rejects(manager.inspect(opened.session, opened.tab, ref), /stale|snapshot|ref/i);
    for (const socket of sockets) socket.destroy();
    await delay(100);
    const recovered = await manager.navigate(opened.session, opened.tab, "http://recovered.test/third");
    assert.equal(recovered.title, "Capacity fixture");
  } finally {
    for (const socket of sockets) socket.destroy();
    await manager.shutdown();
    origin.closeAllConnections();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  }
});
