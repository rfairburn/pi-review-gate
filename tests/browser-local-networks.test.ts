/**
 * Issue #27 runtime phase: effective local-network permission wired through
 * interactive browsing. Every "local" destination here is a synthetic
 * hostname resolved by a test resolver to a fixed private/loopback/metadata
 * literal; the broker dial seam records the validated address but always dials
 * the loopback fixture origin, so no real cloud-metadata or local-service
 * probe ever occurs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright";
import { DEFAULT_EGRESS_BUDGETS, EgressBroker, type EgressPolicyFailureContext } from "../src/web/egress-broker";
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig, type WebBrowserPermissions } from "../src/config";
import { BrowserFailureError, InteractiveBrowserManager } from "../src/web/interactive-browser";

const PUBLIC_IP = "93.184.216.34";
/** Synthetic private/local/metadata destinations; never dialed for real. */
const LOCAL_HOSTS: Record<string, string> = {
  "local.test": "127.0.0.1",
  "private.test": "10.0.0.5",
  "linklocal.test": "169.254.33.4",
  "metadata.test": "169.254.169.254",
  "redirect-local.test": "192.168.50.7",
  "v6local.test": "fe80::1",
};

interface OriginFixture {
  port: number;
  close(): Promise<void>;
}

/**
 * Loopback fixture origin standing in for every synthetic destination. Raw
 * socket based because Chromium tunnels even plain ws:// through CONNECT:
 * the origin must answer CONNECT, then complete a WebSocket handshake inside
 * the tunnel, while ordinary page loads arrive as plain HTTP requests.
 */
async function createOrigin(): Promise<OriginFixture> {
  const sockets: net.Socket[] = [];
  let port = 0;
  const pageFor = (path: string): { status: number; headers: Record<string, string>; body: string } => {
    if (path === "/start") {
      return { status: 302, headers: { location: `http://redirect-local.test:${port}/final` }, body: "" };
    }
    if (path === "/data") {
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
        body: "fixture-data",
      };
    }
    if (path === "/popup-host") {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><title>Popup host</title><main>popup-host-ok</main><script>
          setTimeout(() => window.open('http://local.test:${port}/popup-target', '_blank'), 50);
        </script>`,
      };
    }
    if (path === "/ws-page") {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><title>WS page</title><main><p id="w">ws-pending</p></main><script>
          const el = document.getElementById('w');
          try {
            const ws = new WebSocket('ws://local.test:${port}/ws');
            ws.onopen = () => { el.textContent = 'ws-open'; };
            ws.onerror = () => { if (el.textContent === 'ws-pending') el.textContent = 'ws-error'; };
            ws.onclose = (event) => { el.textContent = 'ws-close-' + event.code; };
          } catch (error) { el.textContent = 'ws-error'; }
        </script>`,
      };
    }
    if (path === "/fetch-page") {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><title>Fetch page</title><main><p id="f">fetch-pending</p></main><script>
          const el = document.getElementById('f');
          fetch('http://local.test:${port}/data')
            .then((r) => r.text())
            .then((text) => { el.textContent = 'fetch-ok:' + text; })
            .catch(() => { el.textContent = 'fetch-failed'; });
        </script>`,
      };
    }
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<!doctype html><title>Local fixture</title><main>local-fixture-ok</main>",
    };
  };
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let inTunnel = false;
    let wsHandshaken = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // CONNECT and the in-tunnel WebSocket handshake can arrive coalesced in
      // one segment: keep draining buffered heads until none remain or the
      // pipe becomes opaque (post-handshake frames are never parsed).
      for (;;) {
        if (wsHandshaken) return;
        const headEnd = buffer.indexOf("\r\n\r\n");
        if (headEnd === -1) return;
        const head = buffer.subarray(0, headEnd).toString("latin1");
        buffer = buffer.subarray(headEnd + 4);
        const lines = head.split("\r\n");
        const requestLine = lines[0] ?? "";
        if (!inTunnel && /^CONNECT /i.test(requestLine)) {
          // Chromium tunnels plain ws:// (and TLS) through CONNECT.
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          inTunnel = true;
          continue;
        }
        if (inTunnel) {
          // Inside the tunnel: complete exactly one WebSocket handshake, then
          // hold the pipe; no frames are ever sent or retained.
          if (!wsHandshaken && /^GET /i.test(requestLine)) {
            const headers: Record<string, string> = {};
            for (const line of lines.slice(1)) {
              const separator = line.indexOf(":");
              if (separator === -1) continue;
              headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
            }
            const key = headers["sec-websocket-key"];
            if (!key) { socket.destroy(); return; }
            const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
            socket.write(
              "HTTP/1.1 101 Switching Protocols\r\n"
              + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
              + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            wsHandshaken = true;
          }
          return;
        }
        // Plain HTTP request (absolute-form via the proxy or origin-form).
        // A WebSocket upgrade relayed by the broker arrives as an ordinary
        // request head carrying sec-websocket-key: complete the handshake and
        // hold the pipe instead of answering with HTML.
        const requestHeaders: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const separator = line.indexOf(":");
          if (separator === -1) continue;
          requestHeaders[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
        const wsKey = requestHeaders["sec-websocket-key"];
        if (wsKey) {
          const accept = createHash("sha1").update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n"
            + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          wsHandshaken = true;
          return;
        }
        const target = requestLine.split(/\s+/)[1] ?? "/";
        let path: string;
        try { path = new URL(target, "http://fixture.local/").pathname; } catch { path = "/"; }
        const response = pageFor(path);
        const body = Buffer.from(response.body, "utf8");
        const headOut =
          `HTTP/1.1 ${response.status} ${response.status === 302 ? "Found" : "OK"}\r\n`
          + Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n") + "\r\n"
          + `Content-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`;
        socket.write(Buffer.concat([Buffer.from(headOut, "latin1"), body]));
        socket.end();
        return;
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      port = (server.address() as AddressInfo).port;
      resolveListen();
    });
  });
  return {
    port,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

function localResolver(): (hostname: string) => Promise<readonly string[]> {
  return async (hostname: string) => {
    if (net.isIP(hostname)) return [hostname];
    const mapped = LOCAL_HOSTS[hostname];
    return [mapped ?? PUBLIC_IP];
  };
}

function localPermissions(field: keyof WebBrowserPermissions): WebBrowserPermissions {
  return { ...DEFAULT_BROWSER_PERMISSIONS, [field]: true };
}

interface ManagerFixture {
  manager: InteractiveBrowserManager;
  dials: string[];
}

/** Real Chromium + synthetic resolver + dial seam that never leaves loopback. */
function createLocalManager(originPort: number): ManagerFixture {
  const dials: string[] = [];
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: localResolver(),
    brokerDial: (validated, port) => {
      dials.push(`${validated.hostname}:${port}:${validated.addresses.join(",")}`);
      return net.connect({ host: "127.0.0.1", port: originPort });
    },
  });
  return { manager, dials };
}

function setPolicy(manager: InteractiveBrowserManager, permissions: WebBrowserPermissions): void {
  manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, permissions);
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Poll ARIA snapshots until the pattern matches or the session dies. */
async function waitForSnapshot(
  manager: InteractiveBrowserManager,
  session: string,
  tab: string,
  pattern: RegExp,
  timeoutMs = 8_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (manager.activeSessionCount() === 0) throw new Error(`Session died before snapshot matched ${pattern}`);
    const snapshot = await manager.snapshot(session, tab, 4_000);
    if (pattern.test(snapshot.snapshot)) return snapshot.snapshot;
    if (Date.now() > deadline) throw new Error(`Snapshot never matched ${pattern}: ${snapshot.snapshot}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForSessionGone(manager: InteractiveBrowserManager, timeoutMs = 8_000): Promise<void> {
  await waitFor(() => manager.activeSessionCount() === 0, "session teardown", timeoutMs);
}

test("default policy denies local literals and private DNS before any browser starts", async () => {
  const origin = await createOrigin();
  try {
    const { manager, dials } = createLocalManager(origin.port);
    const targets = [
      `http://127.0.0.1:${origin.port}/`,
      `http://[::1]:${origin.port}/`,
      `http://local.test:${origin.port}/`,
      `http://private.test:${origin.port}/`,
      `http://linklocal.test:${origin.port}/`,
      `http://metadata.test:${origin.port}/`,
      `http://v6local.test:${origin.port}/`,
    ];
    for (const target of targets) {
      await assert.rejects(manager.open(target), /non-public|blocked/i, target);
    }
    assert.equal(dials.length, 0, "no destination was dialed");
    assert.equal(manager.activeSessionCount(), 0);
    await manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("localNetworks admits initial navigation to loopback, private, and metadata destinations", async () => {
  const origin = await createOrigin();
  try {
    const { manager, dials } = createLocalManager(origin.port);
    setPolicy(manager, localPermissions("localNetworks"));
    const opened = await manager.open(`http://metadata.test:${origin.port}/`);
    assert.equal(opened.status, 200);
    let snapshot = await manager.snapshot(opened.session, opened.tab, 2_000);
    assert.match(snapshot.snapshot, /local-fixture-ok/);
    const navigated = await manager.navigate(opened.session, opened.tab, `http://local.test:${origin.port}/loopback`);
    assert.equal(navigated.url, `http://local.test:${origin.port}/loopback`);
    const privateNav = await manager.navigate(opened.session, opened.tab, `http://private.test:${origin.port}/rfc1918`);
    assert.equal(privateNav.url, `http://private.test:${origin.port}/rfc1918`);
    // The ledger names the validated (pinned) addresses; the sockets themselves
    // went to the loopback fixture via the dial seam.
    assert.ok(dials.some((dial) => dial === `metadata.test:${origin.port}:169.254.169.254`));
    assert.ok(dials.some((dial) => dial === `local.test:${origin.port}:127.0.0.1`));
    assert.ok(dials.some((dial) => dial === `private.test:${origin.port}:10.0.0.5`));
    const closed = await manager.close(opened.session);
    // Historical local entries must audit truthfully at teardown.
    assert.equal(closed.quiescent, true);
    assert.ok((closed.broker?.connections ?? 0) >= 3);
    await manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("YOLO admits local destinations without an explicit localNetworks toggle", async () => {
  const origin = await createOrigin();
  try {
    const { manager, dials } = createLocalManager(origin.port);
    setPolicy(manager, localPermissions("yolo"));
    const opened = await manager.open(`http://linklocal.test:${origin.port}/`);
    assert.equal(opened.url, `http://linklocal.test:${origin.port}/`);
    assert.ok(dials.some((dial) => dial === `linklocal.test:${origin.port}:169.254.33.4`));
    await manager.close(opened.session);
    await manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("live enable applies to subsequent navigation and tab opens without restart", async () => {
  const origin = await createOrigin();
  try {
    const { manager, dials } = createLocalManager(origin.port);
    // Default public-only: the initial (public) open works with no permission.
    const opened = await manager.open(`http://public.test:${origin.port}/`);
    assert.equal(opened.status, 200);
    setPolicy(manager, localPermissions("localNetworks"));
    const navigated = await manager.navigate(opened.session, opened.tab, `http://private.test:${origin.port}/after-enable`);
    assert.equal(navigated.url, `http://private.test:${origin.port}/after-enable`);
    const tabs = await manager.tabs(opened.session, "open", undefined, `http://metadata.test:${origin.port}/tab`);
    assert.ok(tabs.tabs.some((entry) => entry.url === `http://metadata.test:${origin.port}/tab`));
    assert.ok(dials.some((dial) => dial === `private.test:${origin.port}:10.0.0.5`));
    assert.ok(dials.some((dial) => dial === `metadata.test:${origin.port}:169.254.169.254`));
    const closed = await manager.close(opened.session);
    assert.equal(closed.quiescent, true);
    await manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("page-initiated requests honor the same effective boundary as model navigation", async () => {
  const origin = await createOrigin();
  try {
    // Enabled: the page's own fetch to a local destination is admitted.
    const enabled = createLocalManager(origin.port);
    setPolicy(enabled.manager, localPermissions("localNetworks"));
    const openedEnabled = await enabled.manager.open(`http://public.test:${origin.port}/fetch-page`);
    await waitForSnapshot(enabled.manager, openedEnabled.session, openedEnabled.tab, /fetch-ok:fixture-data/);
    assert.ok(enabled.dials.some((dial) => dial === `local.test:${origin.port}:127.0.0.1`));
    await enabled.manager.close(openedEnabled.session);
    await enabled.manager.shutdown();

    // Disabled (default): the same page request is refused before any dial and
    // the hard broker refusal fails the session closed, exactly as it does for
    // a model navigation to the same destination.
    const denied = createLocalManager(origin.port);
    try {
      await denied.manager.open(`http://public.test:${origin.port}/fetch-page`);
    } catch (error) {
      assert.ok(error instanceof BrowserFailureError, `expected structured broker refusal, got ${String(error)}`);
    }
    await waitForSessionGone(denied.manager);
    assert.equal(denied.dials.some((dial) => dial.startsWith("local.test:")), false, "no local destination was dialed");
    await denied.manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("private main-document redirect follows the effective policy", async () => {
  const origin = await createOrigin();
  try {
    // Default: the redirect hop is refused before dial; session fails closed.
    const denied = createLocalManager(origin.port);
    try {
      await denied.manager.open(`http://public.test:${origin.port}/start`);
    } catch (error) {
      assert.ok(error instanceof BrowserFailureError, `expected structured broker refusal, got ${String(error)}`);
      assert.equal(error.phase, "broker_admission");
      assert.equal(error.category, "non_public_address_denied");
    }
    await waitForSessionGone(denied.manager);
    assert.equal(denied.dials.some((dial) => dial.startsWith("redirect-local.test:")), false);
    await denied.manager.shutdown();

    // Enabled: the same redirect completes at the private destination.
    const enabled = createLocalManager(origin.port);
    setPolicy(enabled.manager, localPermissions("localNetworks"));
    const opened = await enabled.manager.open(`http://public.test:${origin.port}/start`);
    assert.equal(opened.url, `http://redirect-local.test:${origin.port}/final`);
    assert.equal(opened.status, 200);
    assert.ok(enabled.dials.some((dial) => dial === `redirect-local.test:${origin.port}:192.168.50.7`));
    await enabled.manager.close(opened.session);
    await enabled.manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("adopted popups to local destinations follow the effective policy", async () => {
  const origin = await createOrigin();
  try {
    // Enabled: the page-opened popup is admitted and becomes an owned tab.
    const enabled = createLocalManager(origin.port);
    setPolicy(enabled.manager, localPermissions("localNetworks"));
    const opened = await enabled.manager.open(`http://public.test:${origin.port}/popup-host`);
    await waitFor(async () => {
      const tabs = await enabled.manager.tabs(opened.session, "list");
      return tabs.tabs.length === 2;
    }, "second (popup) tab to be adopted");
    const tabs = await enabled.manager.tabs(opened.session, "list");
    assert.ok(tabs.tabs.some((entry) => entry.url === `http://local.test:${origin.port}/popup-target`));
    assert.ok(enabled.dials.some((dial) => dial === `local.test:${origin.port}:127.0.0.1`));
    await enabled.manager.close(opened.session);
    await enabled.manager.shutdown();

    // Disabled: the popup's main-document request is refused before dial and
    // the hard broker refusal fails the session closed.
    const denied = createLocalManager(origin.port);
    try {
      await denied.manager.open(`http://public.test:${origin.port}/popup-host`);
    } catch (error) {
      assert.ok(error instanceof BrowserFailureError, `expected structured broker refusal, got ${String(error)}`);
    }
    await waitForSessionGone(denied.manager);
    assert.equal(denied.dials.some((dial) => dial.startsWith("local.test:")), false);
    await denied.manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("page-created WebSockets to local destinations follow the effective policy", async () => {
  const origin = await createOrigin();
  try {
    // Enabled: manager-side admission and broker revalidation both pass.
    const enabled = createLocalManager(origin.port);
    setPolicy(enabled.manager, localPermissions("localNetworks"));
    const opened = await enabled.manager.open(`http://public.test:${origin.port}/ws-page`);
    await waitForSnapshot(enabled.manager, opened.session, opened.tab, /ws-open/);
    assert.ok(enabled.dials.some((dial) => dial === `local.test:${origin.port}:127.0.0.1`));
    const closed = await enabled.manager.close(opened.session);
    assert.equal(closed.quiescent, true);
    await enabled.manager.shutdown();

    // Disabled: the manager refuses the socket before any connection; the
    // refusal is recorded in network diagnostics and the session survives.
    const denied = createLocalManager(origin.port);
    const openedDenied = await denied.manager.open(`http://public.test:${origin.port}/ws-page`);
    await waitFor(async () => {
      const diagnostics = await denied.manager.network(openedDenied.session, openedDenied.tab);
      return diagnostics.events.some((event) => event.outcome === "policy_blocked" && event.resourceKind === "websocket");
    }, "manager-side websocket policy refusal");
    const diagnostics = await denied.manager.network(openedDenied.session, openedDenied.tab);
    const refusal = diagnostics.events.find((event) => event.outcome === "policy_blocked" && event.resourceKind === "websocket")!;
    assert.match(refusal.failure ?? "", /public validation/);
    assert.equal(denied.dials.some((dial) => dial.startsWith("local.test:")), false, "no local destination was dialed");
    assert.equal(denied.manager.activeSessionCount(), 1, "manager-side refusal is contained, not session-fatal");
    const closedDenied = await denied.manager.close(openedDenied.session);
    assert.equal(closedDenied.quiescent, true);
    await denied.manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("disabling local networks revokes established local connections and subsequent admissions", async () => {
  const origin = await createOrigin();
  try {
    const { manager, dials } = createLocalManager(origin.port);
    setPolicy(manager, localPermissions("localNetworks"));
    const opened = await manager.open(`http://public.test:${origin.port}/ws-page`);
    await waitForSnapshot(manager, opened.session, opened.tab, /ws-open/);
    const dialsBeforeRevocation = dials.length;

    // Live disable: no restart. The established local WebSocket pipe is closed
    // narrowly (the page observes an abnormal close) while the session itself
    // keeps running with public-only egress.
    setPolicy(manager, DEFAULT_BROWSER_PERMISSIONS);
    await waitForSnapshot(manager, opened.session, opened.tab, /ws-close-\d+/);
    assert.equal(manager.activeSessionCount(), 1, "revocation is not a browser reset");

    // Subsequent admissions use the current (disabled) setting.
    await assert.rejects(
      manager.navigate(opened.session, opened.tab, `http://local.test:${origin.port}/after-disable`),
      /non-public|blocked/i,
    );
    assert.equal(dials.length, dialsBeforeRevocation, "no new local destination was dialed after revocation");

    // Teardown audits the historical local entry truthfully instead of
    // reclassifying it; the close confirms quiescence.
    const closed = await manager.close(opened.session);
    assert.equal(closed.quiescent, true);
    assert.ok((closed.broker?.connections ?? 0) >= 1, "historical local ledger entry is retained");
    await manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("turning YOLO off revokes the local-network authority it granted", async () => {
  const origin = await createOrigin();
  try {
    const { manager, dials } = createLocalManager(origin.port);
    setPolicy(manager, localPermissions("yolo"));
    const opened = await manager.open(`http://public.test:${origin.port}/ws-page`);
    await waitForSnapshot(manager, opened.session, opened.tab, /ws-open/);
    assert.ok(dials.some((dial) => dial === `local.test:${origin.port}:127.0.0.1`));

    setPolicy(manager, DEFAULT_BROWSER_PERMISSIONS);
    await waitForSnapshot(manager, opened.session, opened.tab, /ws-close-\d+/);
    assert.equal(manager.activeSessionCount(), 1);
    await assert.rejects(
      manager.navigate(opened.session, opened.tab, `http://metadata.test:${origin.port}/`),
      /non-public|blocked/i,
    );
    const closed = await manager.close(opened.session);
    assert.equal(closed.quiescent, true);
    await manager.shutdown();
  } finally {
    await origin.close();
  }
});

test("pending broker admission cannot dial after a live local-network revocation", async () => {
  const holdSockets: net.Socket[] = [];
  const hold = net.createServer((socket) => { holdSockets.push(socket); socket.on("error", () => undefined); });
  await new Promise<void>((resolveHold) => hold.listen(0, "127.0.0.1", resolveHold));
  const holdPort = (hold.address() as AddressInfo).port;
  try {
    let dnsGate: (addresses: string[]) => void = () => undefined;
    const resolver = async (hostname: string) => {
      if (hostname === "slowlocal.test") return new Promise<string[]>((resolveDns) => { dnsGate = resolveDns; });
      return [PUBLIC_IP];
    };
    const dials: string[] = [];
    const failures: Array<{ reason: "refusal" | "budget_abort"; context?: EgressPolicyFailureContext }> = [];
    const broker = new EgressBroker(
      resolver,
      (validated, port) => {
        dials.push(`${validated.hostname}:${port}`);
        return net.connect({ host: "127.0.0.1", port: holdPort });
      },
      { ...DEFAULT_EGRESS_BUDGETS, mode: "interactive", maxTotalMs: null, allowLocalNetworks: true },
      undefined,
      { policyFailure: (reason, _diagnostic, context) => { failures.push({ reason, context }); } },
    );
    const port = await broker.start();
    const client = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });
    client.write(
      `GET http://slowlocal.test:80/ HTTP/1.1\r\nHost: slowlocal.test\r\nConnection: close\r\n\r\n`,
    );
    // Let the admission reach its (gated) DNS validation, then revoke while it
    // is in flight: the validated local answer must not be dialed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(broker.setLocalNetworksAllowed(false), 0, "no established connection yet");
    dnsGate(["192.168.7.7"]);
    const response = await new Promise<string>((resolveResponse) => {
      let buffer = "";
      client.on("data", (chunk) => { buffer += chunk.toString("latin1"); });
      client.on("close", () => resolveResponse(buffer));
    });
    assert.match(response, /HTTP\/1\.1 403/);
    assert.equal(dials.length, 0, "the pending admission dialed nothing after revocation");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.context?.category, "non_public_address_denied");
    assert.equal(broker.localNetworksEverAllowed, true);
    await broker.close();
  } finally {
    for (const socket of holdSockets) socket.destroy();
    await new Promise<void>((resolveHold) => hold.close(() => resolveHold()));
  }
});

test("broker revocation closes only local upstreams; public connections and ledger history survive", async () => {
  const holdSockets: net.Socket[] = [];
  const hold = net.createServer((socket) => { holdSockets.push(socket); socket.on("error", () => undefined); });
  await new Promise<void>((resolveHold) => hold.listen(0, "127.0.0.1", resolveHold));
  const holdPort = (hold.address() as AddressInfo).port;
  try {
    const resolver = async (hostname: string) => {
      if (net.isIP(hostname)) return [hostname];
      if (hostname === "local.test") return ["192.168.7.7"];
      return [PUBLIC_IP];
    };
    const dials: string[] = [];
    const broker = new EgressBroker(
      resolver,
      (validated, port) => {
        dials.push(`${validated.hostname}:${port}`);
        return net.connect({ host: "127.0.0.1", port: holdPort });
      },
      { ...DEFAULT_EGRESS_BUDGETS, mode: "interactive", maxTotalMs: null, allowLocalNetworks: true },
    );
    const port = await broker.start();

    const connect = async (authority: string) => {
      const client = net.connect({ host: "127.0.0.1", port });
      await new Promise<void>((resolveConnect, rejectConnect) => {
        client.once("connect", resolveConnect);
        client.once("error", rejectConnect);
      });
      client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`);
      const head = await new Promise<string>((resolveHead, rejectHead) => {
        let buffer = "";
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("latin1");
          const end = buffer.indexOf("\r\n\r\n");
          if (end !== -1) { client.off("data", onData); resolveHead(buffer.slice(0, end + 4)); }
        };
        client.on("data", onData);
        client.once("error", rejectHead);
      });
      return { client, head };
    };

    // Establish a local CONNECT tunnel while the opt-in is on.
    const local = await connect("local.test:80");
    assert.match(local.head, /HTTP\/1\.1 200 Connection Established/);
    assert.ok(dials.some((dial) => dial === "local.test:80"));

    // Live revocation: only the local upstream goes away.
    const closedCount = broker.setLocalNetworksAllowed(false);
    assert.equal(closedCount, 1);
    await new Promise<void>((resolveClose) => local.client.once("close", resolveClose));

    // Public egress keeps working on the same live broker.
    const publicTunnel = await connect("public.test:443");
    assert.match(publicTunnel.head, /HTTP\/1\.1 200 Connection Established/);
    publicTunnel.client.destroy();

    // The ledger retains both historical entries with their admitted
    // addresses; the ever-allowed flag is what teardown audits must use.
    const summary = broker.summary();
    assert.equal(summary.ledger.length, 2);
    assert.deepEqual(
      summary.ledger.map((entry) => [entry.hostname, entry.address, entry.kind]),
      [["local.test", "192.168.7.7", "connect"], ["public.test", PUBLIC_IP, "connect"]],
    );
    assert.equal(broker.localNetworksEverAllowed, true);
    const closed = await broker.close();
    assert.equal(closed.ledger.length, 2);
  } finally {
    for (const socket of holdSockets) socket.destroy();
    await new Promise<void>((resolveHold) => hold.close(() => resolveHold()));
  }
});

test("a dial completing after live local-network revocation is closed before it is established", async () => {
  const holdSockets: net.Socket[] = [];
  const hold = net.createServer((socket) => { holdSockets.push(socket); socket.on("error", () => undefined); });
  await new Promise<void>((resolveHold) => hold.listen(0, "127.0.0.1", resolveHold));
  const holdPort = (hold.address() as AddressInfo).port;
  try {
    const resolver = async (hostname: string) => {
      if (net.isIP(hostname)) return [hostname];
      if (hostname === "local.test") return ["192.168.7.7"];
      return [PUBLIC_IP];
    };
    // The dial seam returns a held socket whose real connect the test
    // releases AFTER the revocation, so the handshake completes late. A fresh
    // net.Socket already reports readyState "open" (which the broker treats as
    // connected), so the state is shadowed until release.
    const pendingDials: Array<{ socket: net.Socket; release: () => void }> = [];
    const failures: Array<{ reason: "refusal" | "budget_abort"; context?: EgressPolicyFailureContext }> = [];
    const broker = new EgressBroker(
      resolver,
      (_validated, _port) => {
        const socket = new net.Socket();
        let released = false;
        Object.defineProperty(socket, "readyState", {
          get: () => (released ? "open" : "opening"),
          set: () => undefined,
          configurable: true,
        });
        socket.on("error", () => undefined);
        pendingDials.push({
          socket,
          release: () => {
            if (released) return;
            released = true;
            socket.connect(holdPort, "127.0.0.1");
          },
        });
        return socket;
      },
      { ...DEFAULT_EGRESS_BUDGETS, mode: "interactive", maxTotalMs: null, allowLocalNetworks: true },
      undefined,
      { policyFailure: (reason, _diagnostic, context) => { failures.push({ reason, context }); } },
    );
    const port = await broker.start();

    const client = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });
    client.on("error", () => undefined);
    const dropped = new Promise<void>((resolveDropped) => { client.once("close", () => resolveDropped()); });
    client.write(`CONNECT local.test:80 HTTP/1.1\r\nHost: local.test:80\r\nConnection: keep-alive\r\n\r\n`);

    // Let the admission validate and dial, then revoke while the connect is
    // still in flight: nothing established exists yet to close.
    await new Promise<void>((resolveDial) => {
      const check = () => (pendingDials.length === 1 ? resolveDial() : setTimeout(check, 5));
      check();
    });
    assert.equal(broker.setLocalNetworksAllowed(false), 0, "no established connection yet");

    // Complete the dial: the broker must re-check the CURRENT policy before
    // publishing the entry and tear both sides down without a 200.
    pendingDials[0]!.release();
    await dropped;
    assert.equal(pendingDials[0]!.socket.destroyed, true, "the late-connecting local upstream was destroyed");

    const summary = broker.summary();
    assert.equal(summary.ledger.length, 0, "no established local entry survived the race");
    assert.equal(failures.length, 0, "a revocation race is a narrow teardown, not a policy failure");
    await broker.close();
  } finally {
    for (const socket of holdSockets) socket.destroy();
    await new Promise<void>((resolveHold) => hold.close(() => resolveHold()));
  }
});

test("a settings save that lands while a session is opening applies to its broker", async () => {
  const origin = await createOrigin();
  try {
    let launchStarted: (() => void) | undefined;
    const launchReached = new Promise<void>((resolveReached) => { launchStarted = resolveReached; });
    let releaseLaunch: (() => void) | undefined;
    const launchRelease = new Promise<void>((resolveRelease) => { releaseLaunch = resolveRelease; });
    const dials: string[] = [];
    const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
      resolveHostname: localResolver(),
      brokerDial: (validated, port) => {
        dials.push(`${validated.hostname}:${port}:${validated.addresses.join(",")}`);
        return net.connect({ host: "127.0.0.1", port: origin.port });
      },
      // Hold the launch open so a settings save can land in the window between
      // broker construction and session registration.
      launch: (options) => {
        launchStarted?.();
        const real = chromium.launch(options);
        return launchRelease.then(() => real);
      },
    });
    try {
      setPolicy(manager, localPermissions("localNetworks"));
      const opening = manager.open(`http://public.test:${origin.port}/fetch-page`);
      await launchReached;
      // Disable while the session is still opening (before registration):
      // the new broker must run the CURRENT boundary, not its construction
      // snapshot.
      setPolicy(manager, DEFAULT_BROWSER_PERMISSIONS);
      releaseLaunch?.();
      // The page's inline fetch targets a local destination: the broker must
      // refuse it (session-fatal by design) instead of dialing loopback.
      // Depending on the race with the initial navigation, open() either
      // rejects with the structured policy failure or resolves and the
      // refusal then tears the session down; both prove the current boundary.
      const opened = await opening.catch((error): Error => (error instanceof Error ? error : new Error(String(error))));
      if (opened instanceof Error) {
        assert.match(opened.message, /non-public|egress policy/i);
      } else {
        assert.equal(opened.url, `http://public.test:${origin.port}/fetch-page`);
      }
      await waitForSessionGone(manager);
      assert.equal(dials.some((dial) => dial.startsWith("local.test:")), false, "no local destination was dialed");
    } finally {
      releaseLaunch?.();
      await manager.shutdown().catch(() => undefined);
    }
  } finally {
    await origin.close();
  }
});
