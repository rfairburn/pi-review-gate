/**
 * Issue #620: real Chromium coverage for the shared `web.urlBlocklist`.
 *
 * The redirect hops here are Chromium's own: the owned fixture origin answers
 * with real 302 responses, and the existing resolver and dial seams keep every
 * destination socket on the loopback fixture. Blocked endpoints are asserted
 * to receive zero requests — both at the origin and in the broker dial log —
 * while page subresources and the existing safety controls stay unchanged.
 *
 * Every judgment here is against one COMPLETE URL — the URL as supplied, or a
 * Chromium navigation destination with its own or inherited fragment — so the
 * regex semantics match the plain HTTP route in `web-url-blocklist.test.ts`.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config";
import { renderWithChromium } from "../src/web/browser";
import { WebPageCache } from "../src/web/cache";
import type { BrokerDial } from "../src/web/egress-broker";
import type { HostResolver, NetworkOptions } from "../src/web/network";
import { compileUrlBlocklist, UrlBlocklistDeniedError } from "../src/web/url-blocklist";

const chromiumInstalled = (() => {
  try {
    return chromium.executablePath().length > 0;
  } catch {
    return false;
  }
})();

const publicAnswer = "203.0.114.1"; // adjacent to TEST-NET-3, not blocked

interface FixtureOrigin {
  port: number;
  hits: string[];
  url(path: string, hostname?: string): string;
  /** Runs just before a recorded request is answered, at most once per host+path. */
  before(hostname: string, path: string, action: () => void): void;
  close(): Promise<void>;
}

/**
 * Owned synthetic origin. `/start` answers 302 → `hop.test/hop`, which answers
 * 302 → `blocked.test/blocked`; `/open-start` answers 302 → `final.test/final`;
 * `/frag-start` answers 302 → `final.test/frag-target#deny`; `/frag-chain-start`
 * answers 302 → `hop2.test/hop2#keep`, which answers 302 → `final.test/final`
 * naming no fragment; `/page` embeds a
 * script from `blocked.test`; `/frame-host` embeds an iframe on `blocked.test`;
 * `/hash-page` renders the page's own `location.hash` so a test can prove which
 * URL the navigation actually used. Bodies stay long enough to count as a
 * useful render.
 */
async function startFixtureOrigin(): Promise<FixtureOrigin> {
  const hits: string[] = [];
  const armed = new Map<string, () => void>();
  const server = createServer((request, response) => {
    const hostname = String(request.headers.host ?? "").split(":")[0];
    const path = request.url ?? "/";
    hits.push(`${hostname}${path}`);
    const action = armed.get(`${hostname}${path}`);
    if (action !== undefined) {
      armed.delete(`${hostname}${path}`);
      action();
    }
    const port = (server.address() as AddressInfo).port;
    if (path === "/start") {
      response.writeHead(302, { location: `http://hop.test:${port}/hop` });
      response.end();
      return;
    }
    if (path === "/hop") {
      response.writeHead(302, { location: `http://blocked.test:${port}/blocked` });
      response.end();
      return;
    }
    if (path === "/open-start") {
      response.writeHead(302, { location: `http://final.test:${port}/final` });
      response.end();
      return;
    }
    if (path === "/frag-start") {
      response.writeHead(302, { location: `http://final.test:${port}/frag-target#deny` });
      response.end();
      return;
    }
    if (path === "/frag-chain-start") {
      response.writeHead(302, { location: `http://hop2.test:${port}/hop2#keep` });
      response.end();
      return;
    }
    if (path === "/hop2") {
      // This Location names no fragment, so the `#keep` the previous hop
      // introduced stays attached to the navigation and joins the destination —
      // the behavior native Chromium shows for the same chain.
      response.writeHead(302, { location: `http://final.test:${port}/final` });
      response.end();
      return;
    }
    if (path === "/sub.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end('document.body.insertAdjacentHTML("beforeend", "<p>subresource-loaded-from-blocked-host</p>");');
      return;
    }
    if (path === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>page</title></head><body><main><p>navigation document body for the fixture.</p></main><script src="http://blocked.test:${port}/sub.js"></script></body></html>`);
      return;
    }
    if (path === "/hash-page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>hash page</title></head><body><main><p>hash host body for the fixture.</p><script>document.body.insertAdjacentHTML("beforeend", "<p>location-hash-is:" + (location.hash || "none") + "</p>");</script></main></body></html>`);
      return;
    }
    if (path === "/frame-host") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>frame host</title></head><body><main><p>frame host body for the fixture.</p></main><iframe src="http://blocked.test:${port}/blocked"></iframe></body></html>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>${hostname}${path}</title></head><body><main><p>${hostname}${path} rendered body content for the fixture.</p></main></body></html>`);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    url: (path: string, hostname = "start.test") => `http://${hostname}:${port}${path}`,
    before: (hostname: string, path: string, action: () => void) => {
      armed.set(`${hostname}${path}`, action);
    },
    close: async () => {
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** Every synthetic hostname answers with the public placeholder address. */
function syntheticResolver(): HostResolver {
  const hosts = new Set(["start.test", "hop.test", "hop2.test", "blocked.test", "final.test"]);
  return (hostname) => (hosts.has(hostname) ? Promise.resolve([publicAnswer]) : Promise.resolve([]));
}

/** Existing dial seam: the validated public address stands in for the fixture. */
function dialFixture(dials: Array<{ hostname: string; port: number }>): BrokerDial {
  return (validated, port) => {
    dials.push({ hostname: validated.hostname, port });
    return net.connect({ host: "127.0.0.1", port });
  };
}

function browserOptions(
  dials: Array<{ hostname: string; port: number }>,
  sources: readonly string[],
  /** When given, every URL the shared guard judges is recorded here, in order. */
  policy?: Array<{ url: string; stage: string }>,
): NetworkOptions {
  const blocklist = compileUrlBlocklist(sources);
  return {
    timeoutMs: 15_000,
    maxBytes: 65_536,
    userAgent: "pi-review-gate-test",
    resolveHostname: syntheticResolver(),
    brokerDial: dialFixture(dials),
    urlGuard: (url, stage) => {
      policy?.push({ url, stage });
      blocklist.assertAllowed(url, stage);
    },
  };
}

/**
 * The real BrowserExtract route: a page cache whose downloader is Chromium, so
 * the cache's own acquisition guard — installed for the whole render, empty
 * list or not — is what enforces the blocklist here.
 */
function renderCache(dials: Array<{ hostname: string; port: number }>): WebPageCache {
  const config = normalizeConfig({});
  return new WebPageCache(config.web!.fetch, (url, options) => renderWithChromium(url, {
    ...options,
    timeoutMs: 15_000,
    maxBytes: 65_536,
    resolveHostname: syntheticResolver(),
    brokerDial: dialFixture(dials),
  }));
}

test(
  "BrowserExtract denies a blocklisted URL before Chromium or the broker touches it",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      await assert.rejects(
        renderWithChromium(origin.url("/blocked", "blocked.test"), browserOptions(dials, ["blocked\\.test"])),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          assert.equal((error as UrlBlocklistDeniedError).stage, "initial");
          assert.equal((error as UrlBlocklistDeniedError).pattern, "blocked\\.test");
          return true;
        },
      );
      assert.deepEqual(origin.hits, [], "the denied URL is never requested by Chromium");
      assert.deepEqual(dials, [], "the broker never dials the denied destination");
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract denies an actual Chromium redirect destination before requesting it",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      await assert.rejects(
        renderWithChromium(origin.url("/start"), browserOptions(dials, ["blocked\\.test"])),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          const denial = error as UrlBlocklistDeniedError;
          assert.equal(denial.stage, "redirect");
          assert.equal(denial.pattern, "blocked\\.test");
          assert.match(denial.deniedUrl, /\/blocked$/);
          return true;
        },
      );
      assert.deepEqual(origin.hits, ["start.test/start", "hop.test/hop"], "the blocked hop is never requested");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test", "hop.test"], "the broker never dials the blocked hop");
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract denies a Chromium redirect chain at a blocked intermediate hop",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      await assert.rejects(
        renderWithChromium(origin.url("/start"), browserOptions(dials, ["^http://hop\\.test:"])),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          assert.equal((error as UrlBlocklistDeniedError).stage, "redirect");
          return true;
        },
      );
      assert.deepEqual(origin.hits, ["start.test/start"], "the blocked intermediate is never requested");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test"]);
    } finally {
      await origin.close();
    }
  },
);

test(
  "an unblocked Chromium redirect chain keeps rendering normally",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      const result = await renderWithChromium(origin.url("/open-start"), browserOptions(dials, ["blocked\\.test"]));
      assert.equal(result.finalUrl, origin.url("/final", "final.test"));
      assert.match(result.text, /final\.test\/final rendered body content/);
      assert.deepEqual(origin.hits, ["start.test/open-start", "final.test/final"]);
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test", "final.test"]);
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract denies a Chromium redirect whose fragment alone matches the blocklist",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // Chromium reports a navigation URL WITHOUT its fragment, so matching the
      // fragmentless URL alone would let a `#deny` destination through.
      await assert.rejects(
        renderWithChromium(origin.url("/frag-start"), browserOptions(dials, ["#deny$"])),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          const denial = error as UrlBlocklistDeniedError;
          assert.equal(denial.stage, "redirect");
          assert.equal(denial.pattern, "#deny$");
          assert.equal(denial.deniedUrl, `${origin.url("/frag-target", "final.test")}#deny`);
          return true;
        },
      );
      assert.deepEqual(origin.hits, ["start.test/frag-start"], "the fragment-matched destination is never requested");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test"], "the broker never dials the fragment-matched hop");
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract follows a Chromium redirect an anchored path entry cannot match",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // `/frag-start` answers 302 → `…/frag-target#deny`. The complete Chromium
      // destination is `…/frag-target#deny`, which `/frag-target$` cannot match,
      // so the hop is followed and rendered — regex rules decide the complete
      // URL, and no fragmentless second look denies it.
      const result = await renderWithChromium(origin.url("/frag-start"), browserOptions(dials, ["/frag-target$"]));
      assert.equal(result.finalUrl, origin.url("/frag-target", "final.test"));
      assert.match(result.text, /final\.test\/frag-target rendered body content/);
      assert.deepEqual(origin.hits, ["start.test/frag-start", "final.test/frag-target"], "the permitted destination is requested once");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test", "final.test"], "the permitted chain dials both hops");
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract never invents the supplied fragment on a Chromium redirect destination",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // `/open-start` answers 302 → `…/final` naming no fragment, and Chromium's
      // own pre-request interception reports that hop with no `urlFragment`. The
      // supplied `#keep` was judged on the supplied URL and stops there, so the
      // destination is judged bare — and denied by an entry the phantom
      // `…/final#keep` would have evaded.
      const deniedPolicy: Array<{ url: string; stage: string }> = [];
      await assert.rejects(
        renderWithChromium(`${origin.url("/open-start")}#keep`, browserOptions(dials, ["/final$"], deniedPolicy)),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          const denial = error as UrlBlocklistDeniedError;
          assert.equal(denial.stage, "redirect");
          assert.equal(denial.pattern, "/final$");
          assert.equal(denial.deniedUrl, origin.url("/final", "final.test"));
          return true;
        },
      );
      assert.deepEqual(origin.hits, ["start.test/open-start"], "the destination is denied before Chromium requests it");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test"], "the broker never dials the denied destination");
      assert.deepEqual(
        deniedPolicy.filter((entry) => entry.stage === "redirect"),
        [{ url: origin.url("/final", "final.test"), stage: "redirect" }],
        "the judged destination is the complete URL Chromium itself formed",
      );

      // The same chain judged by an entry that requires a fragment no Location
      // ever named: nothing matches, nothing guesses around it, and it renders.
      const permittedPolicy: Array<{ url: string; stage: string }> = [];
      const result = await renderWithChromium(
        `${origin.url("/open-start")}#keep`,
        browserOptions(dials, ["/final#keep$"], permittedPolicy),
      );
      assert.equal(result.finalUrl, origin.url("/final", "final.test"));
      assert.match(result.text, /final\.test\/final rendered body content/);
      assert.deepEqual(
        origin.hits,
        ["start.test/open-start", "start.test/open-start", "final.test/final"],
        "the permitted chain requests both hops",
      );
      assert.ok(
        permittedPolicy.every((entry) => !entry.url.includes("#keep") || entry.stage === "initial"),
        `no redirect destination carries the supplied fragment: ${JSON.stringify(permittedPolicy)}`,
      );
    } finally {
      await origin.close();
    }
  },
);

test(
  "a fragment a Chromium redirect introduces is judged on the next hop too",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // `/frag-chain-start` answers 302 → `…/hop2#keep`, which answers 302 →
      // `…/final` naming no fragment. Chromium's own pre-request reports show that
      // second hop arriving with the introduced `#keep` attached as its
      // `urlFragment`, so the destination judged here is `…/final#keep` — the same
      // complete URL the HTTP route judges.
      const introducedPolicy: Array<{ url: string; stage: string }> = [];
      await assert.rejects(
        renderWithChromium(origin.url("/frag-chain-start"), browserOptions(dials, ["/hop2#keep$"], introducedPolicy)),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          const denial = error as UrlBlocklistDeniedError;
          assert.equal(denial.stage, "redirect");
          assert.equal(denial.pattern, "/hop2#keep$");
          assert.equal(denial.deniedUrl, `${origin.url("/hop2", "hop2.test")}#keep`);
          return true;
        },
      );
      assert.deepEqual(origin.hits, ["start.test/frag-chain-start"], "the fragment-matched hop is never requested");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test"], "the broker never dials the fragment-matched hop");

      const carriedPolicy: Array<{ url: string; stage: string }> = [];
      await assert.rejects(
        renderWithChromium(origin.url("/frag-chain-start"), browserOptions(dials, ["/final#keep$"], carriedPolicy)),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          const denial = error as UrlBlocklistDeniedError;
          assert.equal(denial.stage, "redirect");
          assert.equal(denial.pattern, "/final#keep$");
          assert.equal(denial.deniedUrl, `${origin.url("/final", "final.test")}#keep`);
          return true;
        },
      );
      assert.deepEqual(
        origin.hits,
        ["start.test/frag-chain-start", "start.test/frag-chain-start", "hop2.test/hop2"],
        "the destination carrying the introduced fragment is denied before Chromium requests it",
      );
      assert.deepEqual(
        carriedPolicy.filter((entry) => entry.stage === "redirect"),
        [
          { url: `${origin.url("/hop2", "hop2.test")}#keep`, stage: "redirect" },
          { url: `${origin.url("/final", "final.test")}#keep`, stage: "redirect" },
        ],
        "each destination is judged exactly as the Chromium navigation formed it",
      );

      // Regex rules still decide everything: the destination ends in `#keep`, so a
      // trailing anchor on the path alone matches nothing and the chain renders.
      const permitted = await renderWithChromium(origin.url("/frag-chain-start"), browserOptions(dials, ["/final$"]));
      assert.equal(permitted.finalUrl, origin.url("/final", "final.test"));
      assert.match(permitted.text, /final\.test\/final rendered body content/);
      assert.deepEqual(
        origin.hits,
        [
          "start.test/frag-chain-start",
          "start.test/frag-chain-start",
          "hop2.test/hop2",
          "start.test/frag-chain-start",
          "hop2.test/hop2",
          "final.test/final",
        ],
        "the permitted chain requests every hop once",
      );
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract judges the complete supplied URL: /final$ permits a fragment, #frag$ denies",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    const supplied = `${origin.url("/final", "final.test")}#frag`;
    try {
      const result = await renderWithChromium(supplied, browserOptions(dials, ["/final$"]));
      assert.equal(result.finalUrl, origin.url("/final", "final.test"));
      assert.match(result.text, /final\.test\/final rendered body content/);
      assert.deepEqual(origin.hits, ["final.test/final"], "the permitted URL is requested once");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["final.test"]);

      // The same list shape judged against the same complete URL now matches,
      // and the denial lands before Chromium or the broker is involved at all.
      await assert.rejects(
        renderWithChromium(supplied, browserOptions(dials, ["#frag$"])),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          const denial = error as UrlBlocklistDeniedError;
          assert.equal(denial.stage, "initial");
          assert.equal(denial.pattern, "#frag$");
          assert.equal(denial.deniedUrl, supplied);
          return true;
        },
      );
      assert.deepEqual(origin.hits, ["final.test/final"], "the denied supplied URL never reaches Chromium");
      assert.deepEqual(dials.map((dial) => dial.hostname), ["final.test"], "the broker never dials the denied destination");
    } finally {
      await origin.close();
    }
  },
);

test(
  "an empty blocklist keeps the existing navigation target for a fragment-bearing URL",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // The acquisition canonicalizes the navigation exactly as it always did:
      // the blocklist alone never changes what Chromium navigates to, so the
      // page sees no fragment that was never navigated to.
      const result = await renderWithChromium(`${origin.url("/hash-page")}#keep`, browserOptions(dials, []));
      assert.match(result.text, /location-hash-is:none/);
      assert.ok(!result.text.includes("location-hash-is:#keep"), "the supplied fragment must not reach the page");
      assert.equal(result.finalUrl, origin.url("/hash-page"));
      assert.deepEqual(origin.hits, ["start.test/hash-page"]);
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test"]);
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract judges the raw supplied host so a normalized form cannot deny it",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // The URL parser lowercases the host, and CDP reports Chromium's
      // canonical request URL. Neither may replace the caller's string as the
      // initial hop's policy input, or BrowserExtract would deny what WebFetch
      // permits.
      const result = await renderWithChromium(
        `http://FINAL.test:${origin.port}/final`,
        browserOptions(dials, ["^http://final\\.test"]),
      );
      assert.match(result.text, /final\.test\/final rendered body content/);
      assert.equal(result.finalUrl, origin.url("/final", "final.test"));
      assert.deepEqual(origin.hits, ["final.test/final"]);
      assert.deepEqual(dials.map((dial) => dial.hostname), ["final.test"]);
    } finally {
      await origin.close();
    }
  },
);

test(
  "BrowserExtract never rejudges the initial hop as its fragmentless canonical URL",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // `…/final#` does not match `/final$`, while the canonical URL Chromium
      // navigates to does. Judging Chromium's form of the initial hop would deny
      // an input the complete URL permits.
      const result = await renderWithChromium(
        `${origin.url("/final", "final.test")}#`,
        browserOptions(dials, ["/final$"]),
      );
      assert.match(result.text, /final\.test\/final rendered body content/);
      assert.equal(result.finalUrl, origin.url("/final", "final.test"));
      assert.deepEqual(origin.hits, ["final.test/final"]);
      assert.deepEqual(dials.map((dial) => dial.hostname), ["final.test"]);
    } finally {
      await origin.close();
    }
  },
);

test(
  "page subresources stay outside the shared acquisition blocklist",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // The navigation document is allowed, its script host is not: the guard
      // covers the acquisition navigation and its redirects only, never the
      // page's own subresources.
      const result = await renderWithChromium(origin.url("/page"), browserOptions(dials, ["blocked\\.test"]));
      assert.match(result.text, /navigation document body for the fixture/);
      assert.match(result.text, /subresource-loaded-from-blocked-host/);
      assert.deepEqual(origin.hits, ["start.test/page", "blocked.test/sub.js"]);
    } finally {
      await origin.close();
    }
  },
);

test(
  "child-frame documents stay outside the shared acquisition blocklist",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    try {
      // Documented boundary, not a browser firewall (issue #620): only the
      // top-frame navigation and its redirect destinations are guarded, so a
      // child frame's own document is outside the guard's scope.
      const result = await renderWithChromium(origin.url("/frame-host"), browserOptions(dials, ["blocked\\.test"]));
      assert.match(result.text, /frame host body for the fixture/);
      assert.ok(origin.hits.includes("blocked.test/blocked"), "the child-frame document is outside the guard");
      assert.ok(!result.text.includes("blocked.test/blocked rendered body content"));
    } finally {
      await origin.close();
    }
  },
);

test(
  "an entry added while an empty-policy render is in flight denies the Chromium hop before it is sent",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    // Nothing is blocked when the render starts; the entry arrives while the
    // starting document is still answering, before its redirect is sent.
    const cache = renderCache(dials);
    try {
      origin.before("start.test", "/open-start", () => {
        cache.updateConfig(DEFAULT_CONFIG.web!.fetch, compileUrlBlocklist(["final\\.test"]));
      });
      await assert.rejects(
        cache.fetch({ url: origin.url("/open-start") }),
        (error: unknown) => {
          assert.ok(error instanceof UrlBlocklistDeniedError);
          const denial = error as UrlBlocklistDeniedError;
          assert.equal(denial.stage, "redirect");
          assert.equal(denial.pattern, "final\\.test");
          return true;
        },
      );
      assert.deepEqual(
        origin.hits,
        ["start.test/open-start"],
        "Chromium never requests the destination blocked by the live update",
      );
      assert.deepEqual(dials.map((dial) => dial.hostname), ["start.test"], "the broker never dials the newly blocked hop");
    } finally {
      await cache.cleanup();
      await origin.close();
    }
  },
);

test(
  "an empty blocklist renders normally through the always-installed acquisition guard",
  { skip: !chromiumInstalled },
  async () => {
    const origin = await startFixtureOrigin();
    const dials: Array<{ hostname: string; port: number }> = [];
    const cache = renderCache(dials);
    try {
      // Positive control for keeping the guard installed: redirects render, the
      // page's own subresources load, and the second read is a cache hit.
      const first = await cache.fetch({ url: origin.url("/open-start") });
      assert.equal(first.cacheHit, false);
      assert.equal(first.finalUrl, origin.url("/final", "final.test"));
      assert.match(first.content, /final\.test\/final rendered body content/);
      const page = await cache.fetch({ url: origin.url("/page") });
      assert.match(page.content, /subresource-loaded-from-blocked-host/);
      const cached = await cache.fetch({ url: origin.url("/open-start") });
      assert.equal(cached.cacheHit, true);
      assert.deepEqual(
        origin.hits,
        ["start.test/open-start", "final.test/final", "start.test/page", "blocked.test/sub.js"],
        "the guard alone adds no requests of its own",
      );
    } finally {
      await cache.cleanup();
      await origin.close();
    }
  },
);
