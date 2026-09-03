import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Agent, request, type Dispatcher } from "undici";
import {
  createPinnedAgent,
  createPinnedLookup,
  downloadText,
  validatePublicUrl,
  type HostResolver,
  type NetworkOptions,
  type ValidatedUrl,
} from "../src/web/network";

// Deterministic coverage for finding 6 (DNS validation/connect TOCTOU):
// validation answers are injected, sockets dial only pinned addresses, and the
// browser route policy fails closed without any DNS resolution.

const publicResolverAnswer = "203.0.114.1"; // adjacent to TEST-NET-3, not blocked
const secondPublicAnswer = "198.20.0.5";

function testOptions(overrides: Partial<NetworkOptions> = {}): NetworkOptions {
  return { timeoutMs: 2_000, maxBytes: 65_536, userAgent: "pi-review-gate-test", ...overrides };
}

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (address as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
}

interface TrackedDispatcher extends Dispatcher {
  readonly destroyCalls: number;
}

// ---------------------------------------------------------------------------
// validatePublicUrl: canonical href, hostname, and every validated address.
// ---------------------------------------------------------------------------

test("validatePublicUrl returns the canonical href, hostname, and all validated public addresses", async () => {
  const seen: string[] = [];
  const resolver: HostResolver = (hostname) => {
    seen.push(hostname);
    return Promise.resolve([publicResolverAnswer, "2606:4700:4700::1111"]);
  };
  const validated = await validatePublicUrl("HTTP://Example.test:8080/path?a=1#fragment", resolver);
  assert.equal(validated.href, "http://example.test:8080/path?a=1");
  assert.equal(validated.hostname, "example.test");
  assert.deepEqual(validated.addresses, [publicResolverAnswer, "2606:4700:4700::1111"]);
  assert.deepEqual(seen, ["example.test"]);
});

test("validatePublicUrl re-resolves on every call so a changed DNS answer is re-checked", async () => {
  // Simulates rebinding: the first validation answer is public, the next is
  // private. Nothing is cached, so the second hop (or second validation of the
  // same hostname) fails closed.
  const answers: string[][] = [[publicResolverAnswer], ["127.0.0.1"]];
  const resolver: HostResolver = () => Promise.resolve(answers.shift() ?? ["127.0.0.1"]);
  await assert.doesNotReject(validatePublicUrl("http://rebind.test/", resolver));
  await assert.rejects(validatePublicUrl("http://rebind.test/", resolver), /non-public address/);
  await assert.rejects(validatePublicUrl("http://rebind.test/", () => Promise.resolve([])), /did not resolve/);
});

test("validatePublicUrl fails closed for private or unparseable injected answers", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "not-an-address"]) {
    await assert.rejects(
      validatePublicUrl("http://injected.test/", () => Promise.resolve([address])),
      /non-public address/,
      `expected ${address} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// createPinnedLookup: the socket lookup answers only from the validated pins.
// ---------------------------------------------------------------------------

type LookupCallback = (err: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;

function callLookup(lookup: ReturnType<typeof createPinnedLookup>, hostname: string, options: { family?: number; all?: boolean } = {}) {
  return new Promise<{ address?: string | Array<{ address: string; family: number }>; family?: number; error?: Error }>((resolveCall) => {
    (lookup as unknown as (host: string, opts: { family?: number; all?: boolean }, cb: LookupCallback) => void)(
      hostname,
      options,
      (error, address, family) => resolveCall(error ? { error } : { address, family }),
    );
  });
}

test("pinned lookup answers only with validated addresses and honors the requested family", async () => {
  const lookup = createPinnedLookup(new Map([
    ["example.test", ["203.0.114.1", "2606:4700:4700::1111"]],
  ]));
  const all = await callLookup(lookup, "example.test", { all: true });
  assert.deepEqual(all.address, [
    { address: "203.0.114.1", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const v4 = await callLookup(lookup, "example.test", { family: 4, all: true });
  assert.deepEqual(v4.address, [{ address: "203.0.114.1", family: 4 }]);
  const v6 = await callLookup(lookup, "example.test", { family: 6, all: true });
  assert.deepEqual(v6.address, [{ address: "2606:4700:4700::1111", family: 6 }]);
  const single = await callLookup(lookup, "example.test", {});
  assert.equal(single.address, "203.0.114.1");
  assert.equal(single.family, 4);
});

test("pinned lookup fails closed for any hostname outside the validated pin set", async () => {
  // No fallback to the operating system resolver: a second resolution of the
  // same hostname through real DNS (the rebinding vector) and a different
  // hostname both refuse, deterministically, without touching DNS.
  const lookup = createPinnedLookup(new Map([["example.test", [publicResolverAnswer]]]));
  for (const hostname of ["rebound.test", "localhost", "127.0.0.1", "example.test."]) {
    const result = await callLookup(lookup, hostname, {});
    assert.ok(result.error, `expected ${hostname} to be refused`);
    assert.match(result.error!.message, /DNS pinning blocked resolution/);
  }
  // Uppercase spelling of the pinned hostname still matches the pin.
  const upper = await callLookup(lookup, "EXAMPLE.TEST", {});
  assert.equal(upper.error, undefined);
});

test("pinned lookup refuses a family it has no validated address for", async () => {
  const v4Only = createPinnedLookup(new Map([["example.test", [publicResolverAnswer]]]));
  const result = await callLookup(v4Only, "example.test", { family: 6 });
  assert.ok(result.error);
  assert.match(result.error.message, /No validated IPv6 address is pinned/);
  const v6Only = createPinnedLookup(new Map([["example.test", ["2606:4700:4700::1111"]]]));
  const reverse = await callLookup(v6Only, "example.test", { family: 4 });
  assert.ok(reverse.error);
  assert.match(reverse.error.message, /No validated IPv4 address is pinned/);
});

// ---------------------------------------------------------------------------
// Real sockets: the pinned agent dials only pinned addresses with
// hostname-based Host/SNI semantics.
// ---------------------------------------------------------------------------

test("pinned agent dials the pinned address while the Host header stays hostname-based", async () => {
  const hosts: string[] = [];
  const server = createServer((_request, response) => {
    hosts.push(String(_request.headers.host));
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pinned-ok");
  });
  const port = await listen(server);
  try {
    // Test-only pin: stands in for a validated public address that routes to
    // the local test server. Production pins always come from
    // validatePublicUrl, which never returns a loopback address.
    const agent = createPinnedAgent({ href: `http://example.test:${port}/`, hostname: "example.test", addresses: ["127.0.0.1"] });
    try {
      const response = await request(`http://example.test:${port}/probe`, { dispatcher: agent });
      assert.equal(response.statusCode, 200);
      assert.equal(await response.body.text(), "pinned-ok");
    } finally {
      await agent.destroy();
    }
    assert.deepEqual(hosts, [`example.test:${port}`], "the Host header must be hostname-based, not the pinned address");
  } finally {
    await close(server);
  }
});

test("pinned agent never falls back to system DNS for a second resolution", async () => {
  let connections = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end("probe-ok");
  });
  server.on("connection", () => {
    connections += 1;
  });
  const port = await listen(server);
  try {
    const agent = createPinnedAgent({ href: `http://example.test:${port}/`, hostname: "example.test", addresses: ["127.0.0.1"] });
    try {
      // `localhost` resolves on this machine via the OS resolver; the pinned
      // agent must refuse instead of resolving and dialing it.
      await assert.rejects(
        request(`http://localhost:${port}/probe`, { dispatcher: agent }),
        /DNS pinning blocked resolution/,
      );
      const rebound = createPinnedLookup(new Map([["example.test", [publicResolverAnswer]]]));
      const refused = await callLookup(rebound, "localhost");
      assert.ok(refused.error, "a re-resolution attempt must be refused, not re-resolved");
      assert.equal(connections, 0, "no connection may be opened for an unpinned hostname");
    } finally {
      await agent.destroy();
    }
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// downloadText: per-hop validation and pinning, including redirects.
// ---------------------------------------------------------------------------

/**
 * Test dispatcher factory: dials every hop at the local server while keeping
 * the production pinning lookup. This simulates a validated public address
 * routing to the local test server; production callers never inject this and
 * the default `createPinnedAgent` dials the validated addresses themselves.
 */
function localDialFactory(calls: ValidatedUrl[]): { factory: (validated: ValidatedUrl) => Dispatcher; agents: TrackedDispatcher[] } {
  const agents: TrackedDispatcher[] = [];
  return {
    agents,
    factory: (validated) => {
      calls.push(validated);
      const agent = new Agent({
        connect: { lookup: createPinnedLookup(new Map([[validated.hostname, ["127.0.0.1"]]])) },
      });
      let destroyCalls = 0;
      const originalDestroy = agent.destroy.bind(agent) as (...args: unknown[]) => unknown;
      // Count only the promise-form call (downloadText's teardown); undici's
      // promise implementation re-enters destroy(err, callback) internally and
      // must reach the original method uncounted.
      (agent as unknown as { destroy: (...args: unknown[]) => unknown }).destroy = (...args: unknown[]) => {
        if (args.length === 0) destroyCalls += 1;
        return originalDestroy(...(args as Parameters<typeof originalDestroy>));
      };
      const tracked = agent as unknown as Dispatcher & { destroyCalls: number };
      Object.defineProperty(tracked, "destroyCalls", { get: () => destroyCalls });
      agents.push(tracked);
      return tracked;
    },
  };
}

test("downloadText validates and pins every redirect hop and preserves hostname semantics", async () => {
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    hosts.push(String(request.headers.host));
    if (request.url === "/start") {
      response.writeHead(302, { location: `http://hop2.test:${port}/redir-target` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("final-body");
  });
  const port = await listen(server);
  const recorded: ValidatedUrl[] = [];
  const { factory, agents } = { ...localDialFactory(recorded) };
  try {
    const result = await downloadText(`http://hop1.test:${port}/start`, testOptions({
      resolveHostname: (hostname) =>
        Promise.resolve(hostname === "hop1.test" ? [publicResolverAnswer] : hostname === "hop2.test" ? ["198.20.0.5"] : []),
      createDispatcher: factory,
    }));
    assert.equal(result.text, "final-body");
    assert.equal(result.finalUrl, `http://hop2.test:${port}/redir-target`);
    assert.equal(result.requestedUrl, `http://hop1.test:${port}/start`);
    // One validation and one pinned dispatcher per hop, with the exact
    // validated addresses for that hop.
    assert.deepEqual(recorded.map((validated) => validated.hostname), ["hop1.test", "hop2.test"]);
    assert.deepEqual(recorded.map((validated) => validated.addresses), [[publicResolverAnswer], ["198.20.0.5"]]);
    // Host headers stay hostname-based across hops.
    assert.deepEqual(hosts, [`hop1.test:${port}`, `hop2.test:${port}`]);
    // Every per-hop dispatcher is destroyed reliably.
    assert.deepEqual(agents.map((agent) => agent.destroyCalls), [1, 1]);
  } finally {
    await close(server);
    await Promise.allSettled(agents.map((agent) => agent.destroy()));
  }
});

test("downloadText refuses a redirect whose hop fails revalidation before any dial", async () => {
  let connections = 0;
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: `http://hop2.test:${port}/next` });
    response.end();
  });
  server.on("connection", () => {
    connections += 1;
  });
  const port = await listen(server);
  const recorded: ValidatedUrl[] = [];
  const { factory, agents } = { ...localDialFactory(recorded) };
  try {
    await assert.rejects(
      downloadText(`http://hop1.test:${port}/start`, testOptions({
        resolveHostname: (hostname) =>
          Promise.resolve(hostname === "hop1.test" ? [publicResolverAnswer] : ["127.0.0.1"]),
        createDispatcher: factory,
      })),
      /non-public address: 127\.0\.0\.1/,
    );
    // Only the first hop was ever validated and pinned; the rebinding second
    // hop never produced a dispatcher or a connection.
    assert.deepEqual(recorded.map((validated) => validated.hostname), ["hop1.test"]);
    assert.equal(agents.length, 1);
    assert.equal(connections, 1, "only the first hop's connection may exist");
  } finally {
    await close(server);
    await Promise.allSettled(agents.map((agent) => agent.destroy()));
  }
});

test("downloadText re-validates the same hostname on every hop when DNS answers change", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: "/same-host-final" });
    response.end();
  });
  const port = await listen(server);
  const answers: string[][] = [[publicResolverAnswer], ["10.0.0.7"]];
  const recorded: ValidatedUrl[] = [];
  const { factory, agents } = { ...localDialFactory(recorded) };
  try {
    await assert.rejects(
      downloadText(`http://flipping.test:${port}/start`, testOptions({
        resolveHostname: () => Promise.resolve(answers.shift() ?? ["127.0.0.1"]),
        createDispatcher: factory,
      })),
      /non-public address: 10\.0\.0\.7/,
    );
    // The second resolution of the SAME hostname answered private and was
    // rejected: no dispatcher was ever created for the redirected hop.
    assert.deepEqual(recorded.map((validated) => validated.hostname), ["flipping.test"]);
    assert.equal(agents.length, 1);
  } finally {
    await close(server);
    await Promise.allSettled(agents.map((agent) => agent.destroy()));
  }
});

test("downloadText destroys its pinned dispatcher even when the request fails", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  const port = await listen(server);
  const recorded: ValidatedUrl[] = [];
  const { factory, agents } = { ...localDialFactory(recorded) };
  try {
    await assert.rejects(
      downloadText(`http://failing.test:${port}/`, testOptions({
        resolveHostname: () => Promise.resolve([publicResolverAnswer]),
        createDispatcher: factory,
      })),
      /HTTP 500/,
    );
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.destroyCalls, 1);
  } finally {
    await close(server);
    await Promise.allSettled(agents.map((agent) => agent.destroy()));
  }
});

// ---------------------------------------------------------------------------
// No-loopback connection controls.
// ---------------------------------------------------------------------------

test("downloadText refuses loopback destinations without dialing them", async () => {
  let connections = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end("probe-ok");
  });
  server.on("connection", () => {
    connections += 1;
  });
  const port = await listen(server);
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`]) {
      await assert.rejects(downloadText(url, testOptions()), (error: Error) => /non-public address|Only http and https/.test(error.message) || /non-public address/.test(error.message), `expected ${url} to be rejected`);
    }
    assert.equal(connections, 0, "loopback destinations must be rejected before any connection");
  } finally {
    await close(server);
  }
});

test("downloadText never dials a private address returned by the resolver", async () => {
  let connections = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end("probe-ok");
  });
  server.on("connection", () => {
    connections += 1;
  });
  const port = await listen(server);
  const recorded: ValidatedUrl[] = [];
  const { factory, agents } = { ...localDialFactory(recorded) };
  try {
    await assert.rejects(
      downloadText(`http://private.test/`, testOptions({
        resolveHostname: () => Promise.resolve(["127.0.0.1"]),
        createDispatcher: factory,
      })),
      /non-public address: 127\.0\.0\.1/,
    );
    assert.equal(recorded.length, 0, "no dispatcher is created for a rejected answer");
    assert.equal(connections, 0);
  } finally {
    await close(server);
    await Promise.allSettled(agents.map((agent) => agent.destroy()));
  }
});
