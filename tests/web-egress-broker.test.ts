import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import * as dgram from "node:dgram";
import { Agent as NodeHttpAgent, createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright";
import {
  auditEgressLedger,
  browserFinalUrl,
  browserRouteDecision,
  chromiumEgressArgs,
  CHROMIUM_DEFAULT_DENY_RESOLVER_RULES,
  CLEANUP_DEADLINE_MS,
  egressBudgetsFor,
  finalizeBrowserRender,
  hasUsefulRenderedContent,
  MAX_MAIN_DOCUMENT_REDIRECTS,
  renderWithChromium,
  waitForMainDocument,
} from "../src/web/browser";
import {
  DEFAULT_EGRESS_BUDGETS,
  EgressBroker,
  isLoopbackRemote,
  parseConnectAuthority,
  preferredPinnedAddress,
  type BrokerDial,
  type BrokerAuth,
  type BrokerLedgerEntry,
  type EgressBudgets,
} from "../src/web/egress-broker";
import type { HostResolver, NetworkOptions, ValidatedUrl } from "../src/web/network";

// Deterministic coverage for finding 16 (BrowserExtract cross-host
// compatibility through a preventive loopback egress broker): injected
// resolvers, dial seams, and loopback listeners prove cross-host passive
// zero-connect success, cross-host active/redirect success, zero connections
// for rebinding/private-literal/bypass attempts, bounded budgets, and cleanup.

const publicAnswer = "203.0.114.1"; // adjacent to TEST-NET-3, not blocked
const secondPublicAnswer = "198.20.0.5";

function testOptions(overrides: Partial<NetworkOptions> = {}): NetworkOptions {
  return { timeoutMs: 15_000, maxBytes: 65_536, userAgent: "pi-review-gate-test", ...overrides };
}

type AnyServer = Server | net.Server;
type ClosableServer = AnyServer & { closeAllConnections?: () => void };

async function listen(server: AnyServer, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (address as AddressInfo).port;
}

async function close(server: AnyServer): Promise<void> {
  // Origins that never read their socket's EOF (paused streams) can linger in
  // CLOSE_WAIT after the broker destroyed its side; force-close any remaining
  // connections so the server's close callback fires.
  const closable = server as ClosableServer;
  closable.closeAllConnections?.();
  await new Promise<void>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      // Last resort: force-close again and stop waiting; the test servers
      // are done writing by the time close() is called.
      closable.closeAllConnections?.();
      resolveClose();
    }, 5_000);
    timer.unref?.();
    server.close((error) => {
      clearTimeout(timer);
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function countingServer(handler?: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Server & { connectionCount: number } {
  const server = handler
    ? createServer(handler)
    : createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("origin-ok");
    });
  const tracked = server as Server & { connectionCount: number };
  tracked.connectionCount = 0;
  server.on("connection", () => {
    tracked.connectionCount += 1;
  });
  return tracked;
}

/** Test dial seam: every validated public address stands in for a loopback listener. */
function loopbackDial(dials: Array<{ hostname: string; port: number; address: string }> = []): BrokerDial {
  return (validated, port) => {
    dials.push({ hostname: validated.hostname, port, address: validated.addresses[0] ?? "" });
    return net.connect({ host: "127.0.0.1", port });
  };
}

interface BrokerHarness {
  broker: EgressBroker;
  port: number;
  dials: Array<{ hostname: string; port: number; address: string }>;
  stop(): Promise<void>;
}

async function startBroker(resolver: HostResolver, budgets?: Partial<EgressBudgets>): Promise<BrokerHarness> {
  const dials: Array<{ hostname: string; port: number; address: string }> = [];
  const broker = new EgressBroker(
    resolver,
    loopbackDial(dials),
    budgets ? { ...DEFAULT_EGRESS_BUDGETS, ...budgets } : DEFAULT_EGRESS_BUDGETS,
  );
  const port = await broker.start();
  return {
    broker,
    port,
    dials,
    stop: async () => {
      await broker.close();
    },
  };
}

function proxyGet(brokerPort: number, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolveProxy, rejectProxy) => {
    const request = httpRequest({ host: "127.0.0.1", port: brokerPort, path: target, headers: { host: new URL(target).host, ...headers } }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () => resolveProxy({ status: response.statusCode ?? 0, body }));
      response.on("aborted", () => rejectProxy(new Error("response aborted (connection destroyed)")));
    });
    request.on("error", rejectProxy);
    request.end();
  });
}

interface ConnectResult {
  status: number;
  socket: net.Socket;
  head: Buffer;
}

function proxyConnect(brokerPort: number, authority: string, headers: Record<string, string> = {}): Promise<ConnectResult> {
  return new Promise((resolveConnect, rejectConnect) => {
    const request = httpRequest({ host: "127.0.0.1", port: brokerPort, method: "CONNECT", path: authority, headers });
    request.on("connect", (response, socket, head) => resolveConnect({ status: response.statusCode ?? 0, socket, head }));
    request.on("error", rejectConnect);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Broker helpers: loopback-only binding, authority parsing, address choice.
// ---------------------------------------------------------------------------

test("egress broker binds loopback only and validates clients", async () => {
  const harness = await startBroker(() => Promise.resolve([publicAnswer]));
  try {
    assert.equal(harness.broker.boundAddress, "127.0.0.1");
    assert.ok(harness.port > 0);
  } finally {
    await harness.stop();
  }
  assert.equal(isLoopbackRemote("127.0.0.1"), true);
  assert.equal(isLoopbackRemote("::1"), true);
  assert.equal(isLoopbackRemote("[::1]"), true);
  assert.equal(isLoopbackRemote("::ffff:127.0.0.1"), false, "non-canonical spellings fail closed");
  assert.equal(isLoopbackRemote(undefined), false);
  assert.equal(isLoopbackRemote("10.0.0.1"), false);
});

test("parseConnectAuthority rejects userinfo, bad ports, and malformed IPv6", () => {
  assert.deepEqual(parseConnectAuthority("example.test:443"), { host: "example.test", port: 443 });
  assert.deepEqual(parseConnectAuthority("[2606:4700:4700::1111]:8443"), { host: "2606:4700:4700::1111", port: 8443 });
  assert.equal(parseConnectAuthority("user@example.test:443"), undefined);
  assert.equal(parseConnectAuthority("example.test:0"), undefined);
  assert.equal(parseConnectAuthority("example.test:99999"), undefined);
  assert.equal(parseConnectAuthority("example.test:notaport"), undefined);
  assert.equal(parseConnectAuthority("[bad:ipv6"), undefined);
  assert.equal(parseConnectAuthority(""), undefined);
  assert.equal(preferredPinnedAddress(["2606:4700:4700::1111", publicAnswer]), publicAnswer);
  assert.equal(preferredPinnedAddress(["2606:4700:4700::1111"]), "2606:4700:4700::1111");
});

// ---------------------------------------------------------------------------
// Plain HTTP proxying: validated dial, hostname-based Host semantics.
// ---------------------------------------------------------------------------

test("broker forwards plain proxy requests to the validated destination with a hostname-based Host header", async () => {
  const hosts: string[] = [];
  const origin = countingServer((_request, response) => {
    hosts.push(String(_request.headers.host));
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("origin-ok");
  });
  const originPort = await listen(origin);
  const harness = await startBroker((hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]));
  try {
    const result = await proxyGet(harness.port, `http://example.test:${originPort}/path?a=1`);
    assert.equal(result.status, 200);
    assert.equal(result.body, "origin-ok");
    assert.deepEqual(hosts, [`example.test:${originPort}`], "the Host header must stay hostname-based");
    // One validated dial with the chosen public address recorded in the ledger.
    assert.deepEqual(harness.dials.map((dial) => dial.hostname), ["example.test"]);
    assert.deepEqual(harness.dials.map((dial) => dial.address), [publicAnswer]);
    const summary = harness.broker.summary();
    assert.equal(summary.ledger.length, 1);
    assert.equal(summary.ledger[0]!.hostname, "example.test");
    assert.equal(summary.ledger[0]!.kind, "http");
    assert.equal(summary.ledger[0]!.completed, true);
    assert.equal(summary.refusals, 0);
  } finally {
    await harness.stop();
    await close(origin);
  }
});

test("broker CONNECT tunnels raw bytes without terminating or inspecting the payload", async () => {
  // A plain echoing TCP server stands in for a TLS origin: the broker must
  // move bytes opaquely, so SNI/TLS semantics remain with the endpoints.
  const echo = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const echoPort = await listen(echo);
  const harness = await startBroker((hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]));
  try {
    const connect = await proxyConnect(harness.port, `example.test:${echoPort}`);
    assert.equal(connect.status, 200);
    connect.socket.write("TUNNEL-PROBE-BYTES");
    const roundTrip = await new Promise<string>((resolveEcho) => {
      let received = "";
      const timer = setTimeout(() => resolveEcho(received), 2_000);
      timer.unref?.();
      connect.socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes("TUNNEL-PROBE-BYTES")) {
          clearTimeout(timer);
          resolveEcho(received);
        }
      });
    });
    assert.ok(roundTrip.includes("TUNNEL-PROBE-BYTES"), "the tunnel must carry bytes opaquely in both directions");
    connect.socket.destroy();
    const summary = harness.broker.summary();
    assert.equal(summary.ledger.length, 1);
    assert.equal(summary.ledger[0]!.kind, "connect");
    assert.equal(summary.ledger[0]!.hostname, "example.test");
    assert.equal(summary.ledger[0]!.address, publicAnswer);
  } finally {
    await harness.stop();
    await close(echo);
  }
});

// ---------------------------------------------------------------------------
// Fail-closed refusals: zero destination connections for every bypass class.
// ---------------------------------------------------------------------------

test("broker refuses loopback, private, and unresolvable destinations with zero destination connections", async () => {
  const loopbackTarget = countingServer();
  const loopbackPort = await listen(loopbackTarget);
  let dialCalls = 0;
  const dials: Array<{ hostname: string; port: number; address: string }> = [];
  const broker = new EgressBroker(
    (hostname) => {
      if (hostname === "example.test") return Promise.resolve([publicAnswer]);
      if (hostname === "unresolved.test") return Promise.resolve([]);
      return Promise.resolve([hostname]); // literal or loopback name answers itself
    },
    (validated, port) => {
      dialCalls += 1;
      dials.push({ hostname: validated.hostname, port, address: validated.addresses[0] ?? "" });
      return net.connect({ host: "127.0.0.1", port });
    },
  );
  const brokerPort = await broker.start();
  try {
    // Plain-HTTP loopback and private literal requests must be refused through
    // the broker (never bypassed) and never dial the destination.
    const loopbackGet = await proxyGet(brokerPort, `http://127.0.0.1:${loopbackPort}/secret`);
    assert.equal(loopbackGet.status, 403);
    const privateGet = await proxyGet(brokerPort, "http://10.0.0.5:8080/admin");
    assert.equal(privateGet.status, 403);
    // CONNECT refusals: loopback authority, private authority, unvalidated
    // hostname, websocket upgrade, and credentials.
    for (const authority of [`127.0.0.1:${loopbackPort}`, "10.0.0.5:443", "unresolved.test:443"]) {
      const refused = await proxyConnect(brokerPort, authority);
      assert.equal(refused.status, 403, `expected ${authority} to be refused`);
      refused.socket.destroy();
    }
    const websocket = await proxyConnect(brokerPort, `example.test:${loopbackPort}`, { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" });
    assert.equal(websocket.status, 403);
    websocket.socket.destroy();
    // A credential-bearing authority is unparseable and refused as invalid.
    const credentials = await proxyConnect(brokerPort, "user@example.test:443");
    assert.equal(credentials.status, 400);
    credentials.socket.destroy();
    // Non-HTTP proxy scheme is refused outright.
    const ftp = await proxyGet(brokerPort, "ftp://example.test/file");
    assert.equal(ftp.status, 400);
    assert.equal(dialCalls, 0, "no refused destination may ever be dialed");
    assert.equal(loopbackTarget.connectionCount, 0, "loopback targets must receive zero connections");
    const summary = broker.summary();
    assert.ok(summary.refusals >= 8);
    assert.equal(summary.ledger.length, 0);
    assert.ok(summary.omissions.length >= 8, "every refusal must be disclosed as a bounded omission");
  } finally {
    await broker.close();
    await close(loopbackTarget);
  }
});

test("broker re-resolves per connection: a host public at first dial and private at the next is refused", async () => {
  const privateTarget = countingServer();
  await listen(privateTarget);
  const answers: string[][] = [[publicAnswer], ["127.0.0.1"]];
  const harness = await startBroker(() => Promise.resolve(answers.shift() ?? ["127.0.0.1"]));
  try {
    // First request dials through the seam (loopback stand-in for the public pin).
    const first = await proxyGet(harness.port, "http://rebind.test:9/");
    assert.equal(first.status, 502, "the dial target is unreachable; the refusal is a network error, not a policy one");
    const second = await proxyGet(harness.port, "http://rebind.test:9/");
    assert.equal(second.status, 403, "the second resolution answered private and must be refused");
    assert.equal(privateTarget.connectionCount, 0);
    assert.equal(harness.broker.summary().ledger.length, 0);
  } finally {
    await harness.stop();
    await close(privateTarget);
  }
});


// ---------------------------------------------------------------------------
// Client authentication, IPv6 authorities, and strict request-level budgets.
// ---------------------------------------------------------------------------

test("broker challenges unauthenticated clients with 407 and admits only the render's credentials", async () => {
  const origin = countingServer();
  const originPort = await listen(origin);
  // Production-shape credential: "pi-review-gate:" + 32-char base64url secret
  // yields a 70-character `Basic …` header, exercising full-value comparison.
  const auth: BrokerAuth = { username: "pi-review-gate", password: randomBytes(24).toString("base64url") };
  const broker = new EgressBroker(
    (hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]),
    loopbackDial(),
    DEFAULT_EGRESS_BUDGETS,
    auth,
  );
  const brokerPort = await broker.start();
  const credentials = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
  try {
    // Missing credentials are challenged, never processed.
    assert.equal((await proxyGet(brokerPort, `http://example.test:${originPort}/`)).status, 407);
    // Wrong credentials are challenged.
    const wrong = await proxyGet(brokerPort, `http://example.test:${originPort}/`, {
      "proxy-authorization": `Basic ${Buffer.from("render:wrong", "utf8").toString("base64")}`,
    });
    assert.equal(wrong.status, 407);
    // A credential differing only in its final character must be refused:
    // the comparison covers the FULL header, never a fixed-length prefix.
    assert.ok(credentials.length > 64, "production-length credentials must exceed 64 characters");
    const tail = credentials.at(-2) === "A" ? "B" : "A";
    const tamperedTail = `${credentials.slice(0, -2)}${tail}${credentials.slice(-1)}`;
    assert.equal((await proxyGet(brokerPort, `http://example.test:${originPort}/`, { "proxy-authorization": tamperedTail })).status, 407, "a credential differing only after character 64 must be refused");
    assert.equal((await proxyGet(brokerPort, `http://example.test:9/`, { "proxy-authorization": `${credentials}junk` })).status, 407, "trailing junk must be refused");
    assert.equal((await proxyGet(brokerPort, `http://example.test:9/`, { "proxy-authorization": credentials.slice(0, 64) })).status, 407, "a 64-char prefix must be refused");
    // The render's own credentials are admitted (plain and CONNECT).
    const ok = await proxyGet(brokerPort, `http://example.test:${originPort}/`, { "proxy-authorization": credentials });
    assert.equal(ok.status, 200);
    const connect = await proxyConnect(brokerPort, `example.test:${originPort}`, { "proxy-authorization": credentials });
    assert.equal(connect.status, 200);
    connect.socket.destroy();
    // 407 challenges are not policy refusals; the admitted requests succeeded.
    assert.equal(broker.summary().refusals, 0);
    assert.equal(broker.summary().ledger.length, 2);
  } finally {
    await broker.close();
    await close(origin);
  }
});

test("broker accepts IPv6 literal CONNECT authorities", async () => {
  const echo = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const echoPort = await listen(echo);
  const harness = await startBroker((hostname) => Promise.resolve([hostname === "2606:4700:4700::1111" ? "2606:4700:4700::1111" : "127.0.0.1"]));
  try {
    const connect = await proxyConnect(harness.port, `[2606:4700:4700::1111]:${echoPort}`);
    assert.equal(connect.status, 200, "an IPv6 literal authority must parse and tunnel");
    connect.socket.write("V6-PROBE");
    const roundTrip = await new Promise<string>((resolveEcho) => {
      let received = "";
      const timer = setTimeout(() => resolveEcho(received), 2_000);
      timer.unref?.();
      connect.socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes("V6-PROBE")) {
          clearTimeout(timer);
          resolveEcho(received);
        }
      });
    });
    assert.ok(roundTrip.includes("V6-PROBE"));
    connect.socket.destroy();
    assert.equal(harness.broker.summary().ledger[0]!.hostname, "2606:4700:4700::1111");
  } finally {
    await harness.stop();
    await close(echo);
  }
});

test("broker reserves budget slots synchronously: concurrent requests cannot exceed small limits", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker(
    async (hostname) => {
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 50).unref?.());
      return [publicAnswer];
    },
    { maxConnections: 2, maxRequests: 16 },
  );
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        proxyGet(harness.port, `http://host${index}.test:${targetPort}/`).catch((error: Error) => ({ status: 0, message: error.message })),
      ),
    );
    const statuses = responses.map((response) => (response as { status: number }).status);
    const admitted = statuses.filter((status) => status === 200).length;
    const refused = statuses.filter((status) => status === 403).length;
    assert.equal(admitted, 2, "only the synchronously reserved slots may dial");
    assert.equal(refused, 6);
    assert.ok(harness.dials.length <= 2, `concurrent admissions must not exceed the connection budget (dials: ${harness.dials.length})`);
    assert.equal(harness.broker.summary().ledger.length <= 2, true);
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker refuses requests beyond the request-attempt budget, including refusals", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker(
    (hostname) => Promise.resolve([hostname === "unresolved.test" ? [] : [publicAnswer]][0] ?? []),
    { maxRequests: 3 },
  );
  try {
    // Three requests (any outcome) consume the request budget.
    await proxyGet(harness.port, `http://unresolved.test:9/a`); // refused, consumes budget
    await proxyGet(harness.port, `http://example.test:${targetPort}/b`);
    await proxyGet(harness.port, `http://example.test:${targetPort}/c`);
    const fourth = await proxyGet(harness.port, `http://example.test:${targetPort}/d`);
    assert.equal(fourth.status, 502, "the request-attempt budget must bound even valid requests");
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("request budget")));
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker refuses requests beyond the total-time budget", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker(
    async () => {
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 150).unref?.());
      return [publicAnswer];
    },
    { maxTotalMs: 120 },
  );
  try {
    // The first request is admitted before any time has elapsed.
    assert.equal((await proxyGet(harness.port, `http://slow.test:${targetPort}/first`)).status, 200);
    // Once the budget window has elapsed, later requests are refused.
    const refused = await proxyGet(harness.port, `http://slow.test:${targetPort}/second`);
    assert.equal(refused.status, 403);
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("total-time budget")));
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker caps CONNECT header blocks", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker(
    (hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]),
    { maxHeaderChars: 64 },
  );
  try {
    const refused = await proxyConnect(harness.port, `example.test:${targetPort}`, { "x-blob": "z".repeat(200) });
    assert.equal(refused.status, 400);
    refused.socket.destroy();
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("header block")));
    // A small header block still tunnels.
    const ok = await proxyConnect(harness.port, `example.test:${targetPort}`);
    assert.equal(ok.status, 200);
    ok.socket.destroy();
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("hasUsefulRenderedContent applies the bounded usefulness floor", () => {
  assert.equal(hasUsefulRenderedContent("<html><body></body></html>"), false);
  assert.equal(hasUsefulRenderedContent("<html><body><div>hi</div></body></html>"), false);
  assert.equal(hasUsefulRenderedContent("<html><body><script>var a=1;".padEnd(200, "x") + "</script></body></html>"), false);
  assert.equal(hasUsefulRenderedContent(`<html><body><p>${"meaningful text ".repeat(10)}</p></body></html>`), true);
  assert.equal(hasUsefulRenderedContent(""), false);
});

test("finalizeBrowserRender enforces a fail-closed cleanup deadline", async () => {
  await assert.rejects(
    finalizeBrowserRender(
      async () => undefined,
      { close: () => new Promise(() => undefined) },
      undefined,
      50,
    ),
    /cleanup deadline \(50ms\) exceeded/,
  );
  assert.equal(CLEANUP_DEADLINE_MS > 0, true);
  assert.ok(MAX_MAIN_DOCUMENT_REDIRECTS > 0);
  // A hanging browser-network close must never skip broker shutdown.
  let brokerClosed = false;
  await assert.rejects(
    finalizeBrowserRender(
      () => new Promise(() => undefined),
      { close: async () => {
        brokerClosed = true;
        return { ledger: [], omissions: [], omissionsDropped: 0, budgetAborts: 0, refusals: 0 };
      } },
      undefined,
      50,
    ),
    /cleanup deadline \(50ms\) exceeded during browser network close/,
  );
  assert.equal(brokerClosed, true, "broker shutdown must be attempted even when network closure fails");
});

test("broker survives many requests over one keep-alive client connection", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker((hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]));
  try {
    const agent = new NodeHttpAgent({ keepAlive: true, maxSockets: 1 });
    for (let index = 0; index < 30; index += 1) {
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const request = httpRequest(
          { host: "127.0.0.1", port: harness.port, path: `http://example.test:${targetPort}/r${index}`, agent },
          (response: IncomingMessage) => {
            response.resume();
            response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
          },
        );
        request.on("error", reject);
        request.end();
      });
      assert.equal(result.status, 200);
    }
    agent.destroy();
    assert.equal(harness.broker.summary().ledger.length, 30);
  } finally {
    await harness.stop();
    await close(target);
  }
});


test("broker keeps first-seen host reservations across concurrent validation failures", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  // First call for a.test fails (rebinding-style answer), the second succeeds.
  let call = 0;
  const harness = await startBroker(
    (hostname) => {
      if (hostname === "a.test") {
        call += 1;
        return call === 1 ? Promise.resolve(["127.0.0.1"]) : Promise.resolve([publicAnswer]);
      }
      return Promise.resolve([publicAnswer]);
    },
    { maxDistinctHosts: 1 },
  );
  try {
    const [failed, succeeded] = await Promise.all([
      proxyGet(harness.port, `http://a.test:${targetPort}/fail`),
      proxyGet(harness.port, `http://a.test:${targetPort}/ok`),
    ]);
    // Either concurrent ordering is valid; the successful request dials.
    assert.ok(
      (failed.status === 403 && succeeded.status === 200) || (failed.status === 200 && succeeded.status === 403),
      `one concurrent a.test request must succeed (${failed.status}/${succeeded.status})`,
    );
    // a.test stays reserved for the render even though one validation failed:
    // b.test is a second distinct host and must be refused.
    const next = await proxyGet(harness.port, `http://b.test:${targetPort}/next`);
    assert.equal(next.status, 403);
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("distinct-host budget")));
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker 407 challenges do not consume the request-attempt budget", async () => {
  const auth: BrokerAuth = { username: "pi-review-gate", password: randomBytes(24).toString("base64url") };
  const broker = new EgressBroker(
    () => Promise.resolve([publicAnswer]),
    loopbackDial(),
    { ...DEFAULT_EGRESS_BUDGETS, maxRequests: 2 },
    auth,
  );
  const brokerPort = await broker.start();
  const credentials = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
  try {
    // Flood with unauthenticated requests; none may consume the budget.
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await proxyGet(brokerPort, "http://example.test:9/")).status, 407);
    }
    assert.equal(broker.summary().refusals, 0, "407 challenges are not policy refusals");
    // The authorized client still has its full request budget: two requests
    // fail to dial (port 9 refuses) and consume the budget, the third is
    // refused by the budget itself.
    assert.equal((await proxyGet(brokerPort, "http://example.test:9/", { "proxy-authorization": credentials })).status, 502);
    assert.equal((await proxyGet(brokerPort, "http://example.test:9/", { "proxy-authorization": credentials })).status, 502);
    const third = await proxyGet(brokerPort, "http://example.test:9/", { "proxy-authorization": credentials });
    assert.equal(third.status, 502);
    assert.ok(broker.summary().omissions.some((omission) => omission.includes("request budget")), "the third authorized request must be refused by the request budget, not the dial");
  } finally {
    await broker.close();
  }
});

// ---------------------------------------------------------------------------
// Budgets: explicit, bounded, fail closed, disclosed.
// ---------------------------------------------------------------------------

test("broker enforces distinct-host and connection budgets", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker(
    (hostname) => Promise.resolve([hostname.endsWith(".test") ? publicAnswer : "127.0.0.1"]),
    { maxDistinctHosts: 2, maxConnections: 2 },
  );
  try {
    assert.equal((await proxyGet(harness.port, `http://a.test:${targetPort}/`)).status, 200);
    assert.equal((await proxyGet(harness.port, `http://b.test:${targetPort}/`)).status, 200);
    const third = await proxyGet(harness.port, `http://c.test:${targetPort}/`);
    assert.equal(third.status, 403, "a third distinct host must be refused");
    assert.equal((await proxyGet(harness.port, `http://a.test:${targetPort}/`)).status, 403, "the connection budget (2) is now exhausted");
    assert.equal(harness.dials.length, 2);
    const summary = harness.broker.summary();
    assert.equal(summary.ledger.length, 2);
    assert.ok(summary.omissions.some((omission) => omission.includes("distinct-host budget")));
    assert.ok(summary.omissions.some((omission) => omission.includes("connection budget")));
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker destroys a connection and records a budget abort when its byte cap is exceeded", async () => {
  const big = Buffer.alloc(512 * 1024, "x");
  const target = countingServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(big);
  });
  const targetPort = await listen(target);
  const harness = await startBroker(
    () => Promise.resolve([publicAnswer]),
    { maxConnectionBytes: 4096, maxTotalBytes: 8 * 1024 * 1024 },
  );
  try {
    await assert.rejects(
      proxyGet(harness.port, `http://big.test:${targetPort}/blob`),
      /socket hang up|ECONNRESET|aborted/,
      "an over-budget transfer must be destroyed mid-flight",
    );
    const summary = harness.broker.summary();
    assert.equal(summary.budgetAborts, 1);
    assert.ok(summary.omissions.some((omission) => omission.includes("byte budget exceeded")));
    assert.equal(summary.ledger[0]!.completed, false);
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker refuses new connections once the aggregate byte budget is exhausted", async () => {
  const target = countingServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.alloc(64 * 1024, "y"));
  });
  const targetPort = await listen(target);
  const harness = await startBroker(
    () => Promise.resolve([publicAnswer]),
    { maxConnectionBytes: 1024 * 1024, maxTotalBytes: 32 * 1024 },
  );
  try {
    await assert.rejects(
      proxyGet(harness.port, `http://bulk.test:${targetPort}/a`),
      /socket hang up|ECONNRESET|aborted/,
      "the aggregate byte budget must abort the in-flight transfer",
    );
    const next = await proxyGet(harness.port, `http://bulk.test:${targetPort}/b`);
    assert.equal(next.status, 403, "connections above the aggregate byte budget must be refused");
    const summary = harness.broker.summary();
    assert.ok(summary.omissions.some((omission) => omission.includes("byte budget exceeded")));
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker caps authority and header sizes and bounds its diagnostics", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker(
    (hostname) => Promise.resolve([hostname.endsWith(".test") ? publicAnswer : "127.0.0.1"]),
    { maxAuthorityChars: 64, maxHeaderChars: 64, maxDiagnostics: 3 },
  );
  try {
    const longUrl = await proxyGet(harness.port, `http://a.test:${targetPort}/${"x".repeat(200)}`);
    assert.equal(longUrl.status, 400, "an over-long authority must be refused");
    const longHeader = await proxyGet(harness.port, `http://a.test:${targetPort}/`, { "x-blob": "z".repeat(200) });
    assert.equal(longHeader.status, 400, "an over-long header block must be refused");
    for (let index = 0; index < 6; index += 1) {
      await proxyGet(harness.port, `http://a.test:${targetPort}/${"x".repeat(200)}`);
    }
    const summary = harness.broker.summary();
    assert.equal(summary.omissions.length, 3, "only the bounded diagnostic cap is retained");
    assert.equal(summary.omissionsDropped, 5, "the excess is counted, never retained");
  } finally {
    await harness.stop();
    await close(target);
  }
});

test("broker destroys idle connections after the idle budget", async () => {
  const silent = net.createServer(() => undefined); // never responds
  const silentPort = await listen(silent);
  const harness = await startBroker(
    (hostname) => Promise.resolve([hostname === "slow.test" ? publicAnswer : "127.0.0.1"]),
    { idleSocketMs: 100 },
  );
  try {
    const connect = await proxyConnect(harness.port, `slow.test:${silentPort}`);
    assert.equal(connect.status, 200);
    const closed = await new Promise<boolean>((resolveClosed) => {
      const timer = setTimeout(() => resolveClosed(false), 5_000);
      timer.unref?.();
      connect.socket.once("close", () => {
        clearTimeout(timer);
        resolveClosed(true);
      });
    });
    assert.equal(closed, true, "an idle connection must be destroyed at the idle budget");
    assert.ok(harness.broker.summary().omissions.some((omission) => omission.includes("idle timeout")));
  } finally {
    await harness.stop();
    await close(silent);
  }
});

test("broker close destroys sockets, stops listening, and is idempotent", async () => {
  const target = countingServer();
  const targetPort = await listen(target);
  const harness = await startBroker((hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]));
  const connect = await proxyConnect(harness.port, `example.test:${targetPort}`);
  assert.equal(connect.status, 200);
  const peerClosed = new Promise<boolean>((resolveClosed) => {
    const timer = setTimeout(() => resolveClosed(false), 5_000);
    timer.unref?.();
    connect.socket.once("close", () => {
      clearTimeout(timer);
      resolveClosed(true);
    });
  });
  await harness.stop();
  assert.equal(await peerClosed, true, "tunnel sockets must be destroyed on close");
  await assert.rejects(
    new Promise<void>((resolveProbe, rejectProbe) => {
      const probe = net.connect({ host: "127.0.0.1", port: harness.port });
      probe.once("error", (error) => {
        rejectProbe(error);
      });
      probe.once("connect", () => {
        probe.destroy();
        resolveProbe();
      });
    }),
    /ECONNREFUSED/,
    "the broker must stop accepting connections",
  );
  await assert.doesNotReject(harness.stop(), "close must be idempotent");
  await close(target);
});

test("broker close contains a listener whose startup is still settling", async () => {
  const broker = new EgressBroker(async () => [publicAnswer]);
  const starting = broker.start();
  const closing = broker.close();
  await assert.rejects(starting, /closed during startup|closing/);
  await closing;
  assert.equal(broker.isQuiescent(), true);
  await assert.rejects(broker.start(), /closing/);
});

test("ledger audit accepts validated public entries and rejects non-public ones", () => {
  const entry: BrokerLedgerEntry = { hostname: "example.test", port: 443, address: publicAnswer, kind: "connect", bytesSent: 1, bytesReceived: 1, completed: true };
  assert.doesNotThrow(() => auditEgressLedger([entry]));
  assert.throws(() => auditEgressLedger([{ ...entry, address: "" }]), /without a validated destination/);
  assert.throws(() => auditEgressLedger([{ ...entry, hostname: "" }]), /without a validated destination/);
  assert.throws(() => auditEgressLedger([{ ...entry, address: "10.0.0.1" }]), /non-public address/);
});

test("finalizeBrowserRender quiesces the network before honoring the result", async () => {
  const harness = await startBroker(() => Promise.resolve([publicAnswer]));
  const order: string[] = [];
  const summary = await finalizeBrowserRender(
    async () => {
      order.push("network-closed");
    },
    {
      close: async () => {
        order.push("broker-closed");
        return harness.broker.close();
      },
    },
  );
  assert.deepEqual(order, ["network-closed", "broker-closed"]);
  assert.equal(summary.ledger.length, 0);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Route policy and render-level units (no Chromium required).
// ---------------------------------------------------------------------------

test("browser route policy aborts passive resources before connection and admits HTTP(S) through the broker", () => {
  // Passive resources are intentional omissions regardless of hostname and
  // never taint the render.
  assert.deepEqual(browserRouteDecision("image", "https://cdn.other.test/a.png"), { allowed: false, omittedPassive: true });
  assert.deepEqual(browserRouteDecision("image", "https://same.test/a.png"), { allowed: false, omittedPassive: true });
  assert.deepEqual(browserRouteDecision("font", "https://same.test:8443/f.woff2"), { allowed: false, omittedPassive: true });
  assert.deepEqual(browserRouteDecision("media", "http://same.test/v.mp4"), { allowed: false, omittedPassive: true });
  // Cross-host active resources and redirects are admitted (the broker
  // validates and pins each destination).
  assert.deepEqual(browserRouteDecision("document", "https://other.test/page"), { allowed: true });
  assert.deepEqual(browserRouteDecision("script", "https://cdn.other.test/s.js"), { allowed: true });
  assert.deepEqual(browserRouteDecision("stylesheet", "https://cdn.other.test/s.css"), { allowed: true });
  assert.deepEqual(browserRouteDecision("xhr", "https://api.other.test:443/v1"), { allowed: true });
  assert.deepEqual(browserRouteDecision("fetch", "http://other.test/insecure"), { allowed: true });
  // Local browser protocols stay narrowly allowed.
  assert.deepEqual(browserRouteDecision("document", "about:blank"), { allowed: true });
  assert.deepEqual(browserRouteDecision("document", "data:text/html,hi"), { allowed: true });
  assert.deepEqual(browserRouteDecision("document", "blob:https://example.com/uuid"), { allowed: true });
  // Unsupported protocols and unparseable URLs fail closed as omissions.
  const javascript = browserRouteDecision("document", "javascript:alert(1)");
  assert.equal(javascript.allowed, false);
  assert.match(javascript.omission ?? "", /unsupported protocol/);
  assert.equal(browserRouteDecision("xhr", "not a url").allowed, false);
});

test("browser final URL admits cross-host redirects and strips fragments", () => {
  assert.equal(browserFinalUrl("https://final.test/path?a=1#frag"), "https://final.test/path?a=1");
  assert.equal(browserFinalUrl("http://other.test:8080/"), "http://other.test:8080/");
  assert.equal(browserFinalUrl("about:blank"), "about:blank");
  assert.throws(() => browserFinalUrl("ftp://example.test/"), /unsupported URL/);
  assert.throws(() => browserFinalUrl("not a url"), /invalid URL/);
});

test("chromium egress launch arguments force the broker and block every direct path", () => {
  assert.deepEqual(chromiumEgressArgs(41234), [
    "--proxy-server=http://127.0.0.1:41234",
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--host-resolver-rules=${CHROMIUM_DEFAULT_DENY_RESOLVER_RULES}`,
  ]);
  // Only the exact broker endpoint is excluded from the default-deny resolver.
  assert.equal(CHROMIUM_DEFAULT_DENY_RESOLVER_RULES, "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
});

test("egress budgets scale with the download byte cap and stay bounded", () => {
  const budgets = egressBudgetsFor(65_536, 30_000);
  assert.equal(budgets.maxDistinctHosts, DEFAULT_EGRESS_BUDGETS.maxDistinctHosts);
  assert.equal(budgets.maxConnections, DEFAULT_EGRESS_BUDGETS.maxConnections);
  assert.equal(budgets.maxRequests, DEFAULT_EGRESS_BUDGETS.maxRequests);
  assert.equal(budgets.maxConnectionBytes, DEFAULT_EGRESS_BUDGETS.maxConnectionBytes);
  assert.equal(budgets.maxTotalBytes, DEFAULT_EGRESS_BUDGETS.maxTotalBytes);
  assert.ok(budgets.idleSocketMs > 0 && budgets.maxDiagnostics > 0);
  assert.equal(budgets.maxTotalMs, 30_000);
  assert.ok(budgets.maxCleanupMs > 0);
  const large = egressBudgetsFor(512 * 1024 * 1024, 120_000);
  assert.ok(large.maxConnectionBytes > DEFAULT_EGRESS_BUDGETS.maxConnectionBytes);
  assert.ok(large.maxTotalBytes > DEFAULT_EGRESS_BUDGETS.maxTotalBytes);
  assert.equal(large.maxTotalMs, 120_000);
});

test("BrowserExtract fails closed before any browser launch for invalid destinations", async () => {
  await assert.rejects(
    renderWithChromium("http://private.test/", testOptions({ resolveHostname: () => Promise.resolve(["127.0.0.1"]) })),
    /non-public address/,
  );
  await assert.rejects(
    renderWithChromium("http://unresolved.test/", testOptions({ resolveHostname: () => Promise.resolve([]) })),
    /did not resolve/,
  );
});

// ---------------------------------------------------------------------------
// Chromium-backed connection controls (skipped when Chromium is not installed).
// The resolver seam maps validated public addresses to loopback listeners; the
// dial seam stands in for the production pinned dial. Production callers never
// inject these seams.
// ---------------------------------------------------------------------------

const chromiumInstalled = (() => {
  try {
    return chromium.executablePath().length > 0;
  } catch {
    return false;
  }
})();

function browserResolverFor(map: Record<string, string[]>): HostResolver {
  return (hostname) => {
    if (map[hostname]) return Promise.resolve(map[hostname]);
    return Promise.resolve([]);
  };
}

test("broker leaves destination-truncated transfers incomplete and marks client cancels complete", async () => {
  const truncating = net.createServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npartial");
    const timer = setTimeout(() => socket.destroy(), 50);
    timer.unref?.();
  });
  const truncatingPort = await listen(truncating);
  const holding = net.createServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n");
    socket.on("error", () => undefined);
  });
  const holdingPort = await listen(holding);
  const harness = await startBroker(() => Promise.resolve([publicAnswer]));
  try {
    await assert.rejects(
      proxyGet(harness.port, `http://cut.test:${truncatingPort}/`),
      /aborted|ECONNRESET|socket hang up/,
      "a truncated origin body must be cut short toward the client",
    );
    const client = httpRequest({ host: "127.0.0.1", port: harness.port, path: `http://hold.test:${holdingPort}/`, headers: { host: `hold.test:${holdingPort}` } });
    client.on("error", () => undefined);
    await new Promise<void>((resolveHeaders) => {
      client.on("response", (response: IncomingMessage) => {
        response.once("data", () => {
          client.destroy();
          resolveHeaders();
        });
      });
      client.end();
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100).unref?.());
    const summary = harness.broker.summary();
    assert.equal(summary.ledger.length, 2);
    assert.equal(summary.ledger[0]!.completed, false, "destination truncation stays incomplete");
    assert.equal(summary.ledger[1]!.completed, true, "a client-driven cancel counts complete");
    assert.equal(summary.budgetAborts, 0);
  } finally {
    await harness.stop();
    (truncating as ClosableServer).closeAllConnections?.();
    (holding as ClosableServer).closeAllConnections?.();
    await Promise.all([close(truncating), close(holding)]);
  }
});

test("broker bounds client connections, destroys idle unauthenticated sockets, and keeps authorized service", async () => {
  const harness = await startBroker(
    (hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]),
    { maxClientConnections: 4, preAuthSocketMs: 250 },
  );
  const idleSockets: net.Socket[] = [];
  try {
    // Open 4 capped + 3 excess idle sockets that never send anything.
    for (let index = 0; index < 7; index += 1) {
      const socket = net.connect({ host: "127.0.0.1", port: harness.port });
      socket.on("error", () => undefined);
      idleSockets.push(socket);
    }
    // After the quick window the excess sockets (client budget) and the capped
    // sockets (pre-authentication idle deadline) are all destroyed.
    await new Promise<void>((resolveSettle) => {
      const timer = setTimeout(resolveSettle, 1_000);
      timer.unref?.();
    });
    const summary = harness.broker.summary();
    const allIdleClosed = idleSockets.every((socket) => socket.destroyed || socket.readyState === "closed");
    assert.equal(allIdleClosed, true, "idle unauthenticated sockets beyond the budget and at the pre-auth deadline must be destroyed");
    assert.ok(summary.refusals >= 3, `the client-connection budget must refuse the excess sockets (refusals: ${summary.refusals})`);
    assert.ok(summary.omissions.some((omission) => omission.includes("client-connection budget")), "the refusal must be disclosed");
    assert.ok(summary.omissions.some((omission) => omission.includes("pre-authentication idle deadline")), "the pre-auth idle deadline must be disclosed");
    // The broker keeps serving authorized requests after the flood.
    const origin = countingServer();
    const originPort = await listen(origin);
    try {
      const result = await proxyGet(harness.port, `http://example.test:${originPort}/`);
      assert.equal(result.status, 200);
    } finally {
      await close(origin);
    }
  } finally {
    await harness.stop();
  }
});

test("an authorized plain-HTTP transfer outlives the pre-authentication deadline", async () => {
  // The origin answers only after the pre-auth deadline has elapsed; an
  // authorized client socket must not be destroyed by that timer (http.Server
  // destroys sockets on an unhandled 'timeout' event).
  const slowOrigin = countingServer((_request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("slow-origin-ok");
    }, 600);
    timer.unref?.();
  });
  const originPort = await listen(slowOrigin);
  const harness = await startBroker(
    (hostname) => Promise.resolve([hostname === "example.test" ? publicAnswer : "127.0.0.1"]),
    { preAuthSocketMs: 200 },
  );
  try {
    const result = await proxyGet(harness.port, `http://example.test:${originPort}/slow`);
    assert.equal(result.status, 200);
    assert.equal(result.body, "slow-origin-ok");
    const summary = harness.broker.summary();
    assert.equal(summary.ledger.length, 1);
    assert.equal(summary.ledger[0]!.completed, true);
    assert.equal(summary.budgetAborts, 0);
    assert.equal(
      summary.omissions.some((omission) => omission.includes("pre-authentication idle deadline")),
      false,
      "an authorized socket must not be reported as a pre-auth idle victim",
    );
  } finally {
    await harness.stop();
    await close(slowOrigin);
  }
});

test("main-document completion grace stops at the render deadline", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(new Error("render deadline reached")), 50);
  timer.unref?.();
  try {
    await assert.rejects(
      waitForMainDocument(() => false, controller.signal),
      /render deadline reached/,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.ok(Date.now() - startedAt < 500, "the 5-second grace must not outlive the render deadline");
});

test("broker counts pipelined CONNECT head bytes before forwarding", async () => {
  let destinationBytes = 0;
  const destination = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      destinationBytes += chunk.length;
    });
  });
  const destinationPort = await listen(destination);
  const harness = await startBroker(
    () => Promise.resolve([publicAnswer]),
    { maxConnectionBytes: 8, maxTotalBytes: 1024 },
  );
  try {
    const client = net.connect({ host: "127.0.0.1", port: harness.port });
    await new Promise<void>((resolveSocket, rejectSocket) => {
      client.once("connect", () => resolveSocket());
      client.once("error", rejectSocket);
    });
    client.on("error", () => undefined);
    const closed = new Promise<void>((resolveClosed) => client.once("close", () => resolveClosed()));
    client.write(
      `CONNECT example.test:${destinationPort} HTTP/1.1\r\nHost: example.test:${destinationPort}\r\n\r\n`
      + "x".repeat(64),
    );
    await closed;
    assert.equal(destinationBytes, 0, "over-budget CONNECT head bytes must not reach the destination");
    assert.equal(harness.broker.summary().budgetAborts, 1);
    assert.equal(harness.broker.summary().ledger[0]?.completed, false);
  } finally {
    await harness.stop();
    await close(destination);
  }
});

test(
  "BrowserExtract renders a script redirect that supersedes a still-streaming main document",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((request, response) => {
      if ((request.url ?? "/") === "/final") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<html><body><p id="probe">replaced-final-ok</p></body></html>');
        return;
      }
      // A chunked main document whose first chunk runs a script redirect while
      // the body is still streaming; the superseded main-frame request fails
      // with net::ERR_ABORTED and must not fail the render.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "transfer-encoding": "chunked" });
      response.write('<html><body><script>location.replace("/final")</script>');
      const timer = setTimeout(() => response.end("</body></html>"), 300);
      timer.unref?.();
    });
    const mainPort = await listen(main);
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/stream`, testOptions({
        resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
        brokerDial: loopbackDial(),
      }));
      assert.equal(result.finalUrl, `http://main.test:${mainPort}/final`);
      assert.ok(result.text.includes("replaced-final-ok"), "the replacement document must render");
    } finally {
      await main.close();
    }
  },
);

test("BrowserExtract bounds initial validation under the render deadline", async () => {
  // A resolver that never settles must hit the render timeout before any
  // browser launch; the deadline is honored even before Chromium exists.
  await assert.rejects(
    renderWithChromium("http://stalled.test/", testOptions({
      timeoutMs: 150,
      resolveHostname: () => new Promise(() => undefined),
    })),
    /Browser rendering timed out after 150ms/,
  );
});

test(
  "BrowserExtract refuses an empty shell whose HTTPS script tunnel resets after admission",
  { skip: !chromiumInstalled },
  async () => {
    // A TCP peer that accepts the CONNECT tunnel and immediately resets it:
    // the TLS handshake never completes, so the admitted active request fails
    // even though a destination connection existed.
    const hostile = net.createServer((socket) => {
      socket.destroy();
    });
    const securePort = await listen(hostile);
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<html><body><script src="https://secure.other.test:${securePort}/app.js"></script></body></html>`);
    });
    const mainPort = await listen(main);
    try {
      await assert.rejects(
        renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
          resolveHostname: browserResolverFor({ "main.test": [publicAnswer], "secure.other.test": ["198.20.0.7"] }),
          brokerDial: loopbackDial(),
        })),
        /no useful text|refusing the unusable result/i,
      );
    } finally {
      await Promise.all([main.close(), close(hostile)]);
    }
  },
);

test(
  "BrowserExtract keeps a useful render whose HTTPS script tunnel resets, disclosing the failure",
  { skip: !chromiumInstalled },
  async () => {
    const hostile = net.createServer((socket) => {
      socket.destroy();
    });
    const securePort = await listen(hostile);
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><body><p>${"tunnel reset page documentation. ".repeat(12)}</p>`
        + `<script src="https://secure.other.test:${securePort}/app.js"></script></body></html>`,
      );
    });
    const mainPort = await listen(main);
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
        resolveHostname: browserResolverFor({ "main.test": [publicAnswer], "secure.other.test": ["198.20.0.7"] }),
        brokerDial: loopbackDial(),
      }));
      assert.ok(result.text.includes("tunnel reset page documentation"));
      assert.ok(result.browserOmissions, "the post-admission failure must be disclosed");
      assert.ok(result.browserOmissions!.entries.some((entry) => entry.includes("active request failed after admission")));
    } finally {
      await Promise.all([main.close(), close(hostile)]);
    }
  },
);


test(
  "BrowserExtract renders cross-host pages with zero connections for cross-host passive resources",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><head><style>@font-face{font-family:t;src:url(http://fonts.other.test:${fontsPort}/f.woff)}</style></head>`
        + `<body><p id="probe" style="font-family:t">cross-host-passive-ok</p>`
        + `<img src="http://cdn.other.test:${cdnPort}/x.png"><img src="http://media.other.test:${mediaPort}/y.png"></body></html>`,
      );
    });
    const cdn = countingServer();
    const media = countingServer();
    const fonts = countingServer();
    const mainPort = await listen(main);
    const cdnPort = await listen(cdn);
    const mediaPort = await listen(media);
    const fontsPort = await listen(fonts);
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
        resolveHostname: browserResolverFor({
          "main.test": [publicAnswer],
          "cdn.other.test": [secondPublicAnswer],
          "media.other.test": [secondPublicAnswer],
          "fonts.other.test": [secondPublicAnswer],
        }),
        brokerDial: loopbackDial(),
      }));
      assert.ok(result.text.includes("cross-host-passive-ok"), "the useful rendered content must remain");
      // Zero destination connections for the cross-host passive resources.
      assert.equal(cdn.connectionCount, 0, "cross-host images must be aborted before any connection");
      assert.equal(media.connectionCount, 0, "cross-host images must be aborted before any connection");
      assert.equal(fonts.connectionCount, 0, "cross-host fonts must be aborted before any connection");
      // Omissions are disclosed and bounded.
      assert.ok(result.browserOmissions, "passive omissions must be disclosed");
      assert.ok(result.browserOmissions!.count >= 2);
      assert.equal(result.browserOmissions!.truncated, false);
      assert.ok(result.browserOmissions!.entries.some((entry) => entry.includes("cdn.other.test")));
      assert.ok(result.browserOmissions!.entries.every((entry) => entry.length <= 301));
      assert.ok(result.browserOmissions!.entries.length <= 32, "omission diagnostics stay bounded");
    } finally {
      await Promise.all([main.close(), cdn.close(), media.close(), fonts.close()]);
    }
  },
);

test(
  "BrowserExtract loads cross-host active resources and follows cross-host redirects through pinned dials",
  { skip: !chromiumInstalled },
  async () => {
    const hostsSeen: string[] = [];
    const main = countingServer((request, response) => {
      hostsSeen.push(String(request.headers.host));
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `http://final.test:${finalPort}/final` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><body><p id="probe">main-ok</p><script src="http://scripts.other.test:${scriptsPort}/s.js"></script></body></html>`,
      );
    });
    const scripts = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("document.getElementById('probe').textContent = 'script-applied'");
    });
    const final = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><p id=\"probe\">final-ok</p></body></html>");
    });
    const mainPort = await listen(main);
    const scriptsPort = await listen(scripts);
    const finalPort = await listen(final);
    const resolver = browserResolverFor({
      "main.test": [publicAnswer],
      "scripts.other.test": [secondPublicAnswer],
      "final.test": ["198.20.0.6"],
    });
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({ resolveHostname: resolver, brokerDial: loopbackDial() }));
      assert.ok(result.text.includes("script-applied"), "cross-host scripts must execute");
      // Active cross-host request Host semantics stay hostname-based.
      assert.ok(hostsSeen.some((host) => host === `main.test:${mainPort}`));
      assert.ok(result.text.includes('id="probe"'));
      // Cross-host main-document redirect renders the destination page.
      const redirected = await renderWithChromium(`http://main.test:${mainPort}/redirect`, testOptions({ resolveHostname: resolver, brokerDial: loopbackDial() }));
      assert.equal(redirected.finalUrl, `http://final.test:${finalPort}/final`);
      assert.ok(redirected.text.includes("final-ok"));
      assert.ok(redirected.text.includes('id="probe"'));
    } finally {
      await Promise.all([main.close(), scripts.close(), final.close()]);
    }
  },
);

test(
  "BrowserExtract fails closed when a redirect leaves the validated egress path and keeps private peers unreachable",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(302, { location: `http://private.test:${privatePort}/next` });
      response.end();
    });
    const privatePeer = countingServer();
    const mainPort = await listen(main);
    const privatePort = await listen(privatePeer);
    try {
      await assert.rejects(
        renderWithChromium(`http://main.test:${mainPort}/redirect`, testOptions({
          resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
          brokerDial: loopbackDial(),
        })),
        /HTTP 403|ERR_TUNNEL_CONNECTION_FAILED|ERR_ABORTED|navigation failed|net::ERR/i,
      );
      assert.equal(privatePeer.connectionCount, 0, "a private redirect hop must receive zero connections");
    } finally {
      await Promise.all([main.close(), privatePeer.close()]);
    }
  },
);

test(
  "BrowserExtract keeps loopback destinations unreachable from page content and discloses the omissions",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><body><p id="probe">${"main page documentation text. ".repeat(10)}</p>`
        + `<img src="http://127.0.0.1:${secretPort}/secret.png">`
        + `<script src="http://unresolved.test:8080/s.js"></script></body></html>`,
      );
    });
    const secret = countingServer();
    const mainPort = await listen(main);
    const secretPort = await listen(secret);
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
        resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
        brokerDial: loopbackDial(),
      }));
      assert.ok(result.text.includes('id="probe"') && result.text.includes("main page documentation text"), "the useful rendered content must remain");
      assert.equal(secret.connectionCount, 0, "loopback literal requests must be refused at the broker, never bypassed");
      assert.ok(result.browserOmissions, "broker refusals must be disclosed");
      assert.ok(result.browserOmissions!.entries.some((entry) => entry.includes("127.0.0.1") || entry.includes("unresolved.test")));
      assert.equal(result.browserOmissions!.truncated, false);
    } finally {
      await Promise.all([main.close(), secret.close()]);
    }
  },
);

test(
  "BrowserExtract positive control renders a page without external resources with no omissions",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><p id=\"probe\">positive-control-ok</p></body></html>");
    });
    const mainPort = await listen(main);
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
        resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
        brokerDial: loopbackDial(),
      }));
      assert.ok(result.text.includes("positive-control-ok"));
      assert.equal(result.browserOmissions, undefined, "a clean render must disclose no omissions");
      assert.equal(main.connectionCount >= 1, true, "the main document must be fetched through the broker");
      assert.equal(main.connectionCount <= 3, true, "resource use stays bounded for a simple page");
    } finally {
      await main.close();
    }
  },
);

test(
  "BrowserExtract quiesces browser and broker sockets before returning",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><p id=\"probe\">quiesce-ok</p></body></html>");
    });
    const mainPort = await listen(main);
    try {
      await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
        resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
        brokerDial: loopbackDial(),
      }));
      const drained = await new Promise<boolean>((resolveDrained) => {
        const check = (attempts: number) => {
          main.getConnections((error, count) => {
            if (!error && count === 0) {
              resolveDrained(true);
              return;
            }
            if (attempts <= 0) {
              resolveDrained(false);
              return;
            }
            setTimeout(() => check(attempts - 1), 50).unref?.();
          });
        };
        check(60);
      });
      assert.equal(drained, true, "all broker and browser sockets to the origin must be closed before returning");
    } finally {
      await main.close();
    }
  },
);


test(
  "BrowserExtract fails closed when the main document exceeds the redirect budget",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((request, response) => {
      const hop = Number(new URL(request.url ?? "/", "http://probe.test").searchParams.get("hop") ?? "0");
      if (hop >= MAX_MAIN_DOCUMENT_REDIRECTS + 5) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body><p id=\"probe\">unreachable</p></body></html>");
        return;
      }
      response.writeHead(302, { location: `/chain?hop=${hop + 1}` });
      response.end();
    });
    const mainPort = await listen(main);
    try {
      await assert.rejects(
        renderWithChromium(`http://main.test:${mainPort}/chain`, testOptions({
          resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
          brokerDial: loopbackDial(),
        })),
        /redirect hops/i,
      );
    } finally {
      await main.close();
    }
  },
);

test(
  "BrowserExtract refuses an empty application shell whose required script was refused",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<html><body><script src="http://unresolved.test:8080/app.js"></script></body></html>');
    });
    const mainPort = await listen(main);
    try {
      await assert.rejects(
        renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
          resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
          brokerDial: loopbackDial(),
        })),
        /no useful text|refusing the unusable result/i,
      );
    } finally {
      await main.close();
    }
  },
);

test(
  "BrowserExtract keeps a useful render whose nonessential script was refused, with disclosed omissions",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><body><p>${"substantial documentation text. ".repeat(12)}</p>`
        + '<script src="http://unresolved.test:8080/app.js"></script></body></html>',
      );
    });
    const mainPort = await listen(main);
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
        resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
        brokerDial: loopbackDial(),
      }));
      assert.ok(result.text.includes("substantial documentation text"));
      assert.ok(result.browserOmissions, "the refusal must be disclosed");
      assert.ok(result.browserOmissions!.count >= 1);
    } finally {
      await main.close();
    }
  },
);


test(
  "BrowserExtract refuses an empty shell that opens a WebSocket, with zero destination connections",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><body><script>const ws = new WebSocket("ws://ws.other.test:${wsPort}/socket"); void ws;</script></body></html>`,
      );
    });
    const wsPeer = countingServer();
    const mainPort = await listen(main);
    const wsPort = await listen(wsPeer);
    try {
      await assert.rejects(
        renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
          resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
          brokerDial: loopbackDial(),
        })),
        /no useful text|refusing the unusable result/i,
      );
      assert.equal(wsPeer.connectionCount, 0, "the WebSocket must be closed before any destination connection");
    } finally {
      await Promise.all([main.close(), wsPeer.close()]);
    }
  },
);

test(
  "BrowserExtract keeps a useful render that opens a WebSocket, disclosing the omission",
  { skip: !chromiumInstalled },
  async () => {
    const main = countingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><body><p>${"websocket page documentation. ".repeat(12)}</p>`
        + `<script>const ws = new WebSocket("ws://ws.other.test:8080/socket"); ws.onerror = () => undefined; void ws;</script></body></html>`,
      );
    });
    const mainPort = await listen(main);
    try {
      const result = await renderWithChromium(`http://main.test:${mainPort}/`, testOptions({
        resolveHostname: browserResolverFor({ "main.test": [publicAnswer] }),
        brokerDial: loopbackDial(),
      }));
      assert.ok(result.text.includes("websocket page documentation"));
      assert.ok(result.browserOmissions, "the WebSocket omission must be disclosed");
      assert.ok(result.browserOmissions!.entries.some((entry) => entry.includes("WebSocket omitted")));
    } finally {
      await main.close();
    }
  },
);

test(
  "Chromium WebRTC cannot send UDP packets to a loopback STUN endpoint",
  { skip: !chromiumInstalled },
  async () => {
    let packets = 0;
    const stun = dgram.createSocket("udp4");
    stun.on("message", () => {
      packets += 1;
    });
    await new Promise<void>((resolveBind) => stun.bind(0, "127.0.0.1", resolveBind));
    const stunPort = (stun.address() as import("node:net").AddressInfo).port;
    const broker = new EgressBroker(() => Promise.resolve([]), loopbackDial());
    const brokerPort = await broker.start();
    const browser = await chromium.launch({ headless: true, timeout: 20_000, args: chromiumEgressArgs(brokerPort) });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.evaluate(async (port) => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
        pc.createDataChannel("probe");
        await new Promise<void>((resolveGather) => {
          const timer = setTimeout(resolveGather, 4_000);
          timer.unref?.();
          pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timer);
              resolveGather();
            }
          });
        });
        await pc.close();
      }, stunPort);
      // Let any straggler UDP packet arrive before asserting.
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500).unref?.());
      assert.equal(packets, 0, "WebRTC must not send non-proxied UDP to a loopback STUN endpoint");
      assert.equal(broker.summary().ledger.length, 0, "no tunneled STUN traffic may reach the loopback listener either");
    } finally {
      await browser.close();
      await broker.close();
      stun.close();
    }
  },
);

test(
  "Chromium cannot bypass the broker: direct-IP loopback navigation is refused with zero connections",
  { skip: !chromiumInstalled },
  async () => {
    const target = countingServer();
    const targetPort = await listen(target);
    const dials: Array<{ hostname: string; port: number; address: string }> = [];
    const broker = new EgressBroker(() => Promise.resolve([]), loopbackDial(dials));
    const brokerPort = await broker.start();
    const browser = await chromium.launch({
      headless: true,
      timeout: 15_000,
      args: chromiumEgressArgs(brokerPort),
    });
    try {
      const page = await (await browser.newContext()).newPage();
      // The implicit loopback proxy bypass is disabled, so a direct-IP loopback
      // navigation must reach the broker (and be refused there, surfacing either
      // as a proxy error or as the broker's 403), never the target.
      try {
        const response = await page.goto(`http://127.0.0.1:${targetPort}/`, { timeout: 10_000 });
        assert.equal(response?.status(), 403, "the broker refusal surfaces as the navigation status");
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /ERR_TUNNEL_CONNECTION_FAILED|ERR_ABORTED|net::ERR/i);
      }
      assert.equal(target.connectionCount, 0, "a bypassing navigation must produce zero destination connections");
      assert.equal(dials.length, 0);
      assert.ok(broker.summary().refusals >= 1, "the bypass attempt must be refused at the broker and recorded");
    } finally {
      await browser.close();
      await broker.close();
      await close(target);
    }
  },
);

// Type-level helper kept adjacent to the suite that uses it.
export type { ValidatedUrl } from "../src/web/network";