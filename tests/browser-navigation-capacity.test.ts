import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

for (const control of ["recover", "security", "pending"] as const) test(`real navigation capacity failure: ${control}`, { timeout: 30000 }, async () => {
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
    if (control !== "recover") {
      const page = browser!.contexts()[0]!.pages()[0]!;
      const goto = page.goto.bind(page);
      page.goto = async (...args) => {
        try { return await goto(...args); } catch (error) {
          assert.match(String(error), /net::ERR_/);
          if (control === "pending") {
            // The original connection failed, but manager-owned command work
            // has not settled. Capacity cannot excuse this uncertainty.
            await new Promise<void>(resolve => page.once("close", () => resolve()));
          } else {
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
    await assert.rejects(navigating, /net::ERR_/);
    assert.equal(manager.activeSessionCount(), 1, "settled connection refusal must not destroy healthy browser");
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
