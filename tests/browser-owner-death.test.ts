import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { test } from "node:test";
import { once } from "node:events";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)!;
    return { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
  });
}

for (const mode of ["shutdown", "idle", "SIGKILL", "acquisition-SIGKILL"] as const) {
  test(`real manager owned Chromium and broker disappear after ${mode}`, { timeout: 45_000 }, async (t) => {
    const sockets = new Set<net.Socket>();
    const origin = createServer((request, response) => {
      if (request.url === "/stream") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("owned streaming response\n");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<title>Owned lifecycle fixture</title><script>fetch("/stream")</script>');
    });
    origin.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const port = (origin.address() as net.AddressInfo).port;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { InteractiveBrowserManager } from './dist-test/src/web/interactive-browser.js';
      import { normalizeConfig } from './dist-test/src/config.js';
      import net from 'node:net';
      import { chromium } from 'playwright';
      let now = 0;
      const manager = new InteractiveBrowserManager(normalizeConfig({}).web.fetch, {
        now: () => now,
        ...(${JSON.stringify(mode)} === 'acquisition-SIGKILL' ? {
          launch: async options => {
            await chromium.launch(options);
            console.log('READY');
            return await new Promise(() => {});
          },
        } : {}),
        resolveHostname: async () => ['93.184.216.34'],
        brokerDial: (_host, port) => net.connect({host:'127.0.0.1',port}),
      });
      const opened = await manager.open('http://public.test:${port}/');
      console.log('READY');
      process.stdin.on('data', async data => {
        if (data.toString().trim() === 'exit') {
          await manager.shutdown();
          process.exit(0);
        }
        if (${JSON.stringify(mode)} === 'idle') {
          const config = normalizeConfig({}).web.fetch;
          manager.updateConfig(config, 'ask', 1);
          const activity = [
            () => manager.console(opened.session, opened.tab),
            () => manager.network(opened.session, opened.tab),
            () => manager.tabs(opened.session, 'list'),
            () => manager.snapshot(opened.session, opened.tab, 1000),
            () => manager.fill(opened.session, opened.tab, 'invalid', 'value').catch(() => {}),
            () => manager.press(opened.session, opened.tab, 'invalid', 'invalid-key').catch(() => {}),
            () => manager.open('http://public.test:${port}/').catch(() => {}),
          ];
          for (const call of activity) {
            now += 50_000;
            await call();
            now += 59_999;
            manager.updateConfig(config, 'ask', 1);
            await new Promise(resolve => setTimeout(resolve, 10));
            if (manager.activeSessionCount() !== 1) throw new Error('tool activity failed to renew');
          }
          now += 1;
          manager.updateConfig(config, 'ask', 1);
          await new Promise(resolve => setTimeout(resolve, 20));
          const closed = await manager.close(opened.session);
          if (!closed.closure.message.includes('expired')) throw new Error('expiry reason missing');
          try { await manager.snapshot(opened.session, opened.tab, 1000); throw new Error('resurrected'); }
          catch (error) { if (!/expired.*BrowserOpen/s.test(error.message)) throw error; }
        }
        // Idle must prove expiry cleanup itself, not a subsequent shutdown.
        if (${JSON.stringify(mode)} !== 'idle') await manager.shutdown();
        console.log('CLEANED');
      });
    `], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const exited = once(child, "exit");
    let owned: ReturnType<typeof processes> = [];
    try {
      const deadline = Date.now() + 30_000;
      while (!output.includes("READY") && child.exitCode === null && Date.now() < deadline) await pause(50);
      assert.match(output, /READY/);
      const table = processes();
      const parents = new Set([child.pid!]);
      for (let added = true; added;) {
        added = false;
        for (const entry of table) if (parents.has(entry.parent) && !parents.has(entry.pid)) {
          parents.add(entry.pid); owned.push(entry); added = true;
        }
      }
      const browser = owned.find(entry => entry.parent === child.pid && /--remote-debugging-pipe/.test(entry.command));
      assert.ok(browser, "OS parent identity proves this manager owns Chromium");
      const brokerPort = Number(browser.command.match(/--proxy-server=http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
      assert.ok(brokerPort, "owned Chromium identifies the broker listener");
      t.diagnostic(`Verified owner PID ${child.pid}, Chromium PID ${browser.pid}, owned descendant PIDs ${owned.map(p => p.pid).join(",")}`);
      if (mode !== "acquisition-SIGKILL") assert.ok(sockets.size > 0, "fixture has live broker upstream sockets before teardown");
      const killed = mode.endsWith("SIGKILL");
      const waitForExit = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            exited,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("owner exit timed out")), 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const assertOwnerAlive = () => {
        assert.equal(child.exitCode, null, output);
        assert.equal(child.signalCode, null, output);
        assert.ok(processes().some(entry => entry.pid === child.pid), "owner remains alive during cleanup verification");
      };
      let cleanupStarted = Date.now();
      if (!killed) {
        child.stdin.write("shutdown\n");
        const completionDeadline = cleanupStarted + 5_000;
        while (!output.includes("CLEANED") && Date.now() < completionDeadline) {
          assertOwnerAlive();
          await pause(20);
        }
        assert.match(output, /CLEANED/, "manager cleanup completes without owner exit");
        assertOwnerAlive();
      } else {
        child.kill("SIGKILL");
        const [, signal] = await waitForExit();
        assert.equal(signal, "SIGKILL");
        cleanupStarted = Date.now();
      }
      const cleanupDeadline = cleanupStarted + 5_000;
      let remaining = owned;
      do {
        const current = processes();
        remaining = owned.filter(entry => current.some(p => p.pid === entry.pid && p.command === entry.command));
        if (!remaining.length && !sockets.size) break;
        await pause(50);
      } while (Date.now() < cleanupDeadline);
      assert.deepEqual(remaining, [], "OS process disappearance, not Playwright disconnect");
      assert.equal(sockets.size, 0, "broker upstream sockets closed");
      t.diagnostic(`Owned OS processes and upstream sockets absent within ${Date.now() - cleanupStarted}ms of ${killed ? "owner exit" : "cleanup request, with owner alive"}`);
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(brokerPort, "127.0.0.1");
        socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error("listener probe timed out")); });
        socket.on("connect", () => { socket.destroy(); reject(new Error("broker listener survived")); });
        socket.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
      });
      if (!killed) {
        assertOwnerAlive();
        assert.ok(Date.now() <= cleanupDeadline, "graceful resource verification completes within the cleanup bound");
        // Only now may parent-disconnect cleanup become possible.
        child.stdin.write("exit\n");
        const [code, signal] = await waitForExit();
        assert.equal(code, 0, output);
        assert.equal(signal, null, output);
      }
    } finally {
      child.kill("SIGKILL");
      const current = processes();
      for (const entry of owned) if (current.some(p => p.pid === entry.pid && p.command === entry.command)) {
        try { process.kill(entry.pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });
}
