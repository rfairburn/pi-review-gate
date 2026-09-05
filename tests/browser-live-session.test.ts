import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { activate } from "../src/index";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";
import { awaitPiSettlementReceipt, createPiSettlementBootstrap, piSettlementEnvironment } from "../src/execution/pi-settlement-receipt";

function host() {
  const hooks = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  let active: string[] = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return active; },
    setActiveTools(names: string[]) { active = names; },
    notify(message: string) { notices.push(message); },
    sendMessage() {},
    sendUserMessage() {},
  };
  return {
    pi, commands, notices,
    async emit(name: string, ...args: any[]) {
      const results = [];
      for (const hook of hooks.get(name) ?? []) results.push(await hook(...args));
      return results;
    },
  };
}

async function eventually(body: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await body(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

test("real CONNECT browser stays live through idle, permission wait, Pi turns/reviews, then terminal reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-live-session-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  // Test-only local certificate and trust seam; production TLS validation is unchanged.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=live.test"], { stdio: "ignore" });
  const origin = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(`<!doctype html><title>Live fixture</title><main><p id="tick">Tick 0</p>
      <button onclick="this.textContent='Applied'">Apply</button></main>
      <script>let tick=0;setInterval(()=>document.getElementById('tick').textContent='Tick '+(++tick),25)</script>`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as net.AddressInfo).port;
  const sockets = new Set<net.Socket>();
  const browsers: Browser[] = [];
  let resolutions = 0;
  let dialCount = 0;
  const marker = join(root, "review-started");
  const config = normalizeConfig({ enabled: true, retainBundles: "never", decider: {
    id: "fixture", adapter: "generic-cli", command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'fixture reviewed',findings:[]})),800))`],
    timeoutMs: 15_000,
  } });
  const createManager = () => new InteractiveBrowserManager(config.web!.fetch, {
    resolveHostname: async () => { resolutions++; return ["93.184.216.34"]; },
    brokerDial: (_validated, destinationPort) => {
      assert.equal(destinationPort, port);
      dialCount++;
      const socket = net.connect({ host: "127.0.0.1", port });
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      return socket;
    },
    launch: async (options) => {
      const browser = await chromium.launch(options);
      browsers.push(browser);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = (contextOptions) => newContext({ ...contextOptions, ignoreHTTPSErrors: true });
      return browser;
    },
    limits: { idleSocketMs: 750 },
  });
  const manager = createManager();
  let workerManager: InteractiveBrowserManager | undefined;
  let bootstrap: ReturnType<typeof createPiSettlementBootstrap> | undefined;
  try {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    const parent = host();
    await activate(parent.pi, { webTools: new WebToolManager(parent.pi, config, undefined, undefined, manager) });
    const ctx = { cwd: root, isIdle: () => true, notify: parent.pi.notify };
    await parent.emit("session_start", { reason: "startup" }, ctx);
    const opened = await manager.open(`https://live.test:${port}/first`);
    await delay(1_200);
    assert.equal(manager.activeSessionCount(), 1, "idle retention of quiet CONNECTs is not browser expiry");
    // Interactive sessions intentionally retain quiet opaque CONNECT tunnels
    // across idle (no broker eviction). Prove the usable-session contract:
    // nudge Chromium's own pool from the origin side, then require a fresh,
    // DNS-revalidated connection on the next navigation.
    origin.closeAllConnections();
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    const beforeDns = resolutions;
    await manager.navigate(opened.session, opened.tab, `https://live.test:${port}/second`);
    assert.ok(resolutions > beforeDns && dialCount >= 2, "fresh connections revalidate DNS");
    const snapshot = await manager.snapshot(opened.session, opened.tab, 2_000);
    const ref = snapshot.snapshot.match(/button "Apply" \[ref=([^\]]+)\]/)?.[1];
    assert.ok(ref);
    const clicked = await manager.click(opened.session, opened.tab, ref, async () => {
      await delay(1_200);
      assert.equal(manager.activeSessionCount(), 1, "idle cannot kill a pending permission decision");
      return true;
    });
    assert.equal(clicked.confirmed, true);

    // Automatic review, manual review, and ask-reviewer all use the real hooks.
    await writeFile(join(root, "work.ts"), "before\n");
    await parent.emit("before_agent_start", { prompt: "change fixture", systemPrompt: "fixture" }, ctx);
    await writeFile(join(root, "work.ts"), "after\n");
    await parent.emit("agent_end", { messages: [] }, ctx);
    const automatic = parent.emit("agent_settled", {}, ctx);
    await eventually(() => access(marker));
    const tickBefore = await manager.snapshot(opened.session, opened.tab, 2_000);
    await delay(100);
    const tickAfter = await manager.snapshot(opened.session, opened.tab, 2_000);
    assert.notEqual(tickAfter.snapshot, tickBefore.snapshot, "page JS remains live DURING review");
    await automatic;
    assert.match(parent.notices.join("\n"), /passed/);
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    await parent.emit("before_agent_start", { prompt: "another change", systemPrompt: "fixture" }, ctx);
    await writeFile(join(root, "work.ts"), "third\n");
    await parent.commands.get("review-now").handler("", ctx);
    // Exercise active-turn ask-reviewer pause, released only by agent_settled.
    const asking = parent.commands.get("ask-reviewer").handler("is the fixture sound?", { ...ctx, isIdle: () => false });
    await delay(25);
    await parent.emit("agent_end", { messages: [] }, ctx);
    await parent.emit("agent_settled", {}, ctx);
    await asking;
    await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    assert.equal(browsers.length, 1, "all turns and reviews retain the same browser");
    const closed = await manager.close(opened.session);
    assert.ok(closed.broker && closed.broker.connections >= 1, "the ledger tracked real tunnels, not mocked idle");
    assert.equal(sockets.size, 0, "terminal close drained every broker socket");
    const reopened = await manager.open(`https://live.test:${port}/reopened`);
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    assert.equal(browsers.every((browser) => !browser.isConnected()), true);
    assert.equal(sockets.size, 0);
    await assert.rejects(manager.snapshot(reopened.session, reopened.tab, 2_000), /closed.*session_shutdown/);

    // Pi reload/replacement creates a fresh extension manager. Workers retain
    // browsers across authenticated settlements, never a false zero-owner ack.
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
    bootstrap = createPiSettlementBootstrap(root, "worker-session");
    bootstrap.pid = process.pid;
    Object.assign(process.env, piSettlementEnvironment(bootstrap));
    workerManager = createManager();
    const worker = host();
    await activate(worker.pi, { webTools: new WebToolManager(worker.pi, config, undefined, undefined, workerManager) });
    await worker.emit("session_start", { reason: "startup" }, ctx);
    const workerOpened = await workerManager.open(`https://live.test:${port}/worker`);
    for (let generation = 1; generation <= 2; generation++) {
      await worker.emit("agent_settled", {}, ctx);
      assert.equal(await awaitPiSettlementReceipt(bootstrap, generation - 1, 1_000), generation);
      await workerManager.screenshot(workerOpened.session, workerOpened.tab, "viewport", undefined);
    }
    await worker.emit("session_shutdown", { reason: "reload" }, ctx);
    assert.equal(workerManager.activeSessionCount(), 0);
    await assert.rejects(worker.emit("agent_settled", {}, ctx), /retired.*reload/);
    const reloadedWorker = host();
    await activate(reloadedWorker.pi);
    const blocked = await reloadedWorker.emit("tool_call", { toolName: "BrowserOpen" }, ctx);
    assert.ok(blocked.some((result) => result?.block && /restart this worker/.test(result.reason)));
    await assert.rejects(reloadedWorker.emit("agent_settled", {}, ctx), /bootstrap.*unavailable/);
    await reloadedWorker.emit("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    await manager.shutdown();
    await workerManager?.shutdown();
    for (const browser of browsers) await browser.close();
    origin.closeAllConnections();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    if (bootstrap) for (const name of Object.keys(piSettlementEnvironment(bootstrap))) delete process.env[name];
    for (const [name, value] of Object.entries({ PI_REVIEW_GATE_CONFIG: previousConfig, PI_REVIEW_GATE_RUNTIME_ROLE: previousRole, PI_REVIEW_GATE_DISABLED: previousDisabled })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
