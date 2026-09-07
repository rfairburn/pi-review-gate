import assert from "node:assert/strict";
import { ChildProcess, execFileSync } from "node:child_process";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { BrowserOwnershipError, installOwnedBrowserClose, ownedBrowserQuiescent, prepareOwnedBrowser } from "../src/web/browser-owned-process";

test("owned process bridge refuses remote, forged and incomplete ownership without signalling", () => {
  for (const candidate of [undefined, {}, { process: { pid: process.pid }, close() {}, kill() {} },
    { process: new ChildProcess(), close() {}, kill() {} }]) {
    const browser = { _connection: { toImpl: () => ({ options: { browserProcess: candidate } }) } };
    assert.throws(() => installOwnedBrowserClose(browser as unknown as Browser), /ownership bridge is unsupported/);
  }
});

test("unsupported ownership never turns a successful client close into proof of OS cleanup", async () => {
  let closes = 0;
  const browser = { close: async () => { closes++; }, isConnected: () => false };
  await assert.rejects(prepareOwnedBrowser(browser as unknown as Browser), BrowserOwnershipError);
  assert.equal(closes, 1);
});

test("a failed owned force operation reports unconfirmed closure and retains the actual child", async () => {
  const browser = await chromium.launch();
  const local = browser as unknown as { _connection: { toImpl(value: unknown): any } };
  const processOwner = local._connection.toImpl(browser).options.browserProcess;
  const kill = processOwner.kill.bind(processOwner);
  const close = browser.close.bind(browser);
  try {
    processOwner.kill = async () => { throw new Error("synthetic owned kill failure"); };
    browser.close = async () => { throw new Error("synthetic graceful failure"); };
    installOwnedBrowserClose(browser);
    await assert.rejects(browser.close(), /forced termination did not settle.*unconfirmed/);
    assert.equal(ownedBrowserQuiescent(browser), false);
    process.kill(processOwner.process.pid, 0);
  } finally { await kill(); await close(); }
});

function descendants(pid: number): number[] {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
    .map(line => line.trim().split(/\s+/).map(Number));
  const result = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [child, parent] of rows) if (result.has(parent!) && !result.has(child!)) {
      result.add(child!); changed = true;
    }
  }
  return [...result];
}

test("real local Chromium hung graceful close forces owned process tree after five seconds with owner alive", { timeout: 20000 }, async () => {
  const owner = process.pid;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<button>Local selector transport retained</button>");
  const local = browser as unknown as { _connection: { toImpl(value: unknown): any } };
  const implementation = local._connection.toImpl(browser);
  const child = implementation.options.browserProcess.process as ChildProcess;
  const pids = descendants(child.pid!);
  assert.ok(pids.length > 1, "fixture must observe actual Chromium descendants");
  const kill = implementation.options.browserProcess.kill.bind(implementation.options.browserProcess);
  const originalClose = browser.close.bind(browser);
  try {
    // Hang the real process graceful-close operation, not just a disconnected
    // client promise. The same direct local browser and owned kill remain live.
    implementation.options.browserProcess.close = () => new Promise(() => {});
    installOwnedBrowserClose(browser);
    assert.ok(local._connection.toImpl(page.mainFrame()), "local isolated-frame bridge remains available");
    const start = Date.now();
    await browser.close();
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 4900 && elapsed < 10100, `elapsed=${elapsed}ms`);
    assert.equal(ownedBrowserQuiescent(browser), true);
    const deadline = Date.now() + 3000;
    for (;;) {
      const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (alive.length === 0) break;
      assert.ok(Date.now() < deadline, `owned descendants remain: ${alive.join(",")}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(process.pid, owner);
    process.kill(owner, 0);
  } finally {
    await kill();
    await originalClose().catch(() => undefined);
  }
});
