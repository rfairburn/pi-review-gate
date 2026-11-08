/**
 * Issue #620: one shared `web.urlBlocklist` denies `WebFetch` and
 * `BrowserExtract` with identical semantics — the supplied URL and every
 * redirect destination, each judged as one COMPLETE URL (fragment included)
 * and denied before any request or render.
 *
 * Coverage here is the shared configuration, the compiled matcher, the real
 * HTTP transport (`downloadText`) redirect chains through the existing
 * resolver/dispatcher seams, the page cache, and the two acquisition tools.
 * Real Chromium navigation coverage lives in `web-url-blocklist-browser.test.ts`.
 *
 * Every destination is an owned synthetic `.test` hostname answered by an
 * injected resolver; the dial seam keeps the socket on the loopback fixture,
 * so no real or unwanted domain is ever contacted.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Dispatcher } from "undici";
import { DEFAULT_CONFIG, normalizeConfig, recoverConfig, type ReviewGateConfig } from "../src/config";
import type { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { registerReviewSettings } from "../src/settings/command";
import { selectWebSettings } from "../src/settings/web";
import { WebPageCache } from "../src/web/cache";
import {
  createPinnedAgent,
  downloadText,
  type DownloadedText,
  type HostResolver,
  type NetworkOptions,
  type ValidatedUrl,
} from "../src/web/network";
import { WebToolManager } from "../src/web/tools";
import {
  compileUrlBlocklist,
  EMPTY_URL_BLOCKLIST,
  urlBlocklistsEqual,
  UrlBlocklistDeniedError,
} from "../src/web/url-blocklist";

// ---------------------------------------------------------------------------
// Shared configuration
// ---------------------------------------------------------------------------

test("web.urlBlocklist is one shared list that defaults to empty", () => {
  assert.deepEqual(DEFAULT_CONFIG.web!.urlBlocklist, []);
  const defaults = normalizeConfig({}).web!;
  assert.deepEqual(defaults.urlBlocklist, []);
  // An explicit empty list is preserved as empty, not defaulted elsewhere.
  assert.deepEqual(normalizeConfig({ web: { urlBlocklist: [] } }).web!.urlBlocklist, []);
  // One list only: there is no per-tool blocklist key.
  const web = normalizeConfig({ web: { urlBlocklist: ["aliyuncs"] } }).web! as unknown as Record<string, unknown>;
  assert.deepEqual(web.urlBlocklist, ["aliyuncs"]);
  assert.equal(web.webFetchUrlBlocklist, undefined);
  assert.equal(web.browserExtractUrlBlocklist, undefined);
});

test("web.urlBlocklist trims each entry and keeps every configured source", () => {
  const configured = normalizeConfig({ web: { urlBlocklist: ["  aliyuncs  ", "^https://docs\\.example\\.test/private"] } }).web!;
  assert.deepEqual(configured.urlBlocklist, ["aliyuncs", "^https://docs\\.example\\.test/private"]);
});

test("invalid web.urlBlocklist values reject configuration loading", () => {
  assert.throws(() => normalizeConfig({ web: { urlBlocklist: "aliyuncs" } }), /web\.urlBlocklist must be an array/);
  assert.throws(() => normalizeConfig({ web: { urlBlocklist: [42] } }), /web\.urlBlocklist\[0\] must be a regular-expression string/);
  assert.throws(() => normalizeConfig({ web: { urlBlocklist: ["   "] } }), /web\.urlBlocklist\[0\] must be a non-empty regular-expression source/);
  assert.throws(
    () => normalizeConfig({ web: { urlBlocklist: ["aliyuncs", "https://(unbalanced"] } }),
    /web\.urlBlocklist\[1\] is not a valid JavaScript regular expression/,
  );
});

test("startup recovery omits only the invalid blocklist entry, with a warning", () => {
  const recovered = recoverConfig({ web: { urlBlocklist: ["aliyuncs", "https://(unbalanced"] } });
  assert.deepEqual(recovered.config.web!.urlBlocklist, ["aliyuncs"]);
  assert.ok(
    recovered.warnings!.some((warning) => warning.includes("web.urlBlocklist[1]") && warning.includes("entry omitted")),
    `expected an array-entry recovery warning, got ${JSON.stringify(recovered.warnings)}`,
  );
});

// ---------------------------------------------------------------------------
// Shared matcher semantics
// ---------------------------------------------------------------------------

test("the shared matcher searches anywhere, honors anchors, and never strips /.../ delimiters", () => {
  const blocklist = compileUrlBlocklist(["aliyuncs", "^https://private\\.test/"]);
  assert.equal(blocklist.empty, false);
  // Search-anywhere: a bare substring entry matches the issue's example URL.
  assert.equal(blocklist.match("https://bucket.example.aliyuncs.com/object"), "aliyuncs");
  // Anchoring is only what the configured source expresses.
  assert.equal(blocklist.match("https://docs.example.test/aliyuncs"), "aliyuncs");
  assert.equal(blocklist.match("https://private.test/secret"), "^https://private\\.test/");
  assert.equal(blocklist.match("https://mirror.private.test/secret"), undefined);
  // Delimiters are ordinary characters: "/aliyuncs/" requires literal slashes.
  const delimited = compileUrlBlocklist(["/aliyuncs/"]);
  assert.equal(delimited.match("https://bucket.example.aliyuncs.com/object"), undefined);
  assert.equal(delimited.match("https://example.test/aliyuncs/object"), "/aliyuncs/");
  // No flags: matching stays case-sensitive.
  assert.equal(compileUrlBlocklist(["aliyuncs"]).match("https://bucket.example.ALIYUNCS.com/object"), undefined);
});

test("the matcher throws one typed denial carrying the URL, pattern, and stage", () => {
  const blocklist = compileUrlBlocklist(["aliyuncs"]);
  assert.throws(
    () => blocklist.assertAllowed("https://bucket.example.aliyuncs.com/object", "initial"),
    (error: unknown) => {
      assert.ok(error instanceof UrlBlocklistDeniedError);
      const denial = error as UrlBlocklistDeniedError;
      assert.equal(denial.pattern, "aliyuncs");
      assert.equal(denial.stage, "initial");
      assert.equal(denial.deniedUrl, "https://bucket.example.aliyuncs.com/object");
      assert.match(denial.message, /denied by the configured web\.urlBlocklist/);
      assert.match(denial.message, /requested URL/);
      return true;
    },
  );
  assert.throws(
    () => blocklist.assertAllowed("https://aliyuncs.test/final", "redirect"),
    /redirect destination https:\/\/aliyuncs\.test\/final/,
  );
});

test("a trimmed source is what gets compiled, and a literal space is written as regex syntax", () => {
  // Trimming is the only normalization an entry gets (see `normalizeConfig`):
  // what survives it is matched with ordinary regex semantics, so a space meant
  // literally is written as regex syntax rather than typed into the entry, where
  // surrounding whitespace would be trimmed away.
  const configured = normalizeConfig({ web: { urlBlocklist: ["  /final  "] } }).web!.urlBlocklist;
  assert.deepEqual(configured, ["/final"]);
  const blocklist = compileUrlBlocklist(configured);
  assert.equal(blocklist.match("http://x.test/final"), "/final");
  assert.equal(blocklist.match("http://x.test/other"), undefined);
  const literalSpace = compileUrlBlocklist(["final\\x20test", "final[ ]test"]);
  assert.equal(literalSpace.match("http://x.test/final test"), "final\\x20test");
  assert.equal(literalSpace.match("http://x.test/finaltest"), undefined);
});

test("an empty blocklist denies nothing", () => {
  assert.equal(EMPTY_URL_BLOCKLIST.empty, true);
  assert.equal(EMPTY_URL_BLOCKLIST.match("https://anything.test/"), undefined);
  EMPTY_URL_BLOCKLIST.assertAllowed("https://anything.test/", "initial");
  assert.equal(compileUrlBlocklist([]), EMPTY_URL_BLOCKLIST);
  assert.equal(urlBlocklistsEqual(compileUrlBlocklist(["a", "b"]), compileUrlBlocklist(["a", "b"])), true);
  assert.equal(urlBlocklistsEqual(compileUrlBlocklist(["a"]), compileUrlBlocklist(["a", "b"])), false);
  assert.equal(urlBlocklistsEqual(compileUrlBlocklist(["a", "b"]), compileUrlBlocklist(["b", "a"])), false);
});

// ---------------------------------------------------------------------------
// Owned synthetic origin and the transport seams.
// ---------------------------------------------------------------------------

const PUBLIC_ANSWER = "203.0.114.1";

interface FixtureOrigin {
  port: number;
  hits: string[];
  url(path: string, hostname?: string): string;
  /** Runs just before a recorded request is answered, at most once per path. */
  before(hostname: string, path: string, action: () => void): void;
  close(): Promise<void>;
}

/**
 * One loopback fixture origin standing in for every synthetic destination.
 * `/start` redirects to `/hop`, which redirects to `/blocked`; `/open-start`
 * redirects to `/final`; `/frag-start` redirects to `/frag-target#deny`;
 * `/clear-start` redirects to `/final#`, an explicitly empty fragment;
 * `/frag-chain-start` redirects to `/hop2#keep`, which redirects on to `/final`
 * naming no fragment at all — the chain that shows what becomes of a fragment a
 * redirect introduced. Every hop is recorded so a test can prove a denied
 * destination was never requested, and `before()` lets a test land a policy
 * change while an acquisition is still in flight.
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
    if (path === "/clear-start") {
      // Naming a fragment component at all — even the empty one — is exactly
      // what the destination carries; nothing is added to a Location from the
      // URL being redirected from.
      response.writeHead(302, { location: `http://final.test:${port}/final#` });
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
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>${hostname}${path}</title></head><body><main><p>${hostname}${path} body content for the fixture.</p></main></body></html>`);
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
      (server as ReturnType<typeof createServer> & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** Test resolver: every synthetic hostname answers with a public placeholder. */
const syntheticResolver: HostResolver = () => Promise.resolve([PUBLIC_ANSWER]);

/** Test dial seam: the validated public address stands in for the fixture. */
function dialFixture(validated: ValidatedUrl): Dispatcher {
  return createPinnedAgent({ ...validated, addresses: ["127.0.0.1"] });
}

/** The real transport with only the DNS/dial seams redirected to the fixture. */
function fixtureTransport(url: string, options: NetworkOptions): Promise<DownloadedText> {
  return downloadText(url, { ...options, resolveHostname: syntheticResolver, createDispatcher: dialFixture });
}

function guardFor(sources: readonly string[]): NetworkOptions["urlGuard"] {
  const blocklist = compileUrlBlocklist(sources);
  return (url, stage) => blocklist.assertAllowed(url, stage);
}

function transportOptions(overrides: Partial<NetworkOptions> = {}): NetworkOptions {
  return { timeoutMs: 5_000, maxBytes: 64 * 1024, userAgent: "pi-review-gate-test", ...overrides };
}

// ---------------------------------------------------------------------------
// Real HTTP transport: direct URLs and actual redirect chains.
// ---------------------------------------------------------------------------

test("downloadText denies a blocklisted URL before any request is made", async () => {
  const origin = await startFixtureOrigin();
  try {
    await assert.rejects(
      downloadText(origin.url("/blocked", "blocked.test"), transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["blocked\\.test"]),
      })),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        assert.equal((error as UrlBlocklistDeniedError).stage, "initial");
        return true;
      },
    );
    assert.deepEqual(origin.hits, [], "a denied URL is never dialed, resolved, or requested");
  } finally {
    await origin.close();
  }
});

test("downloadText denies an actual redirect chain before the blocked hop is requested", async () => {
  const origin = await startFixtureOrigin();
  try {
    await assert.rejects(
      downloadText(origin.url("/start"), transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["blocked\\.test"]),
      })),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        const denial = error as UrlBlocklistDeniedError;
        assert.equal(denial.stage, "redirect");
        assert.equal(denial.pattern, "blocked\\.test");
        assert.match(denial.deniedUrl, /\/blocked$/);
        return true;
      },
    );
    assert.deepEqual(
      origin.hits,
      ["start.test/start", "hop.test/hop"],
      "the allowed hops are fetched and the blocked destination is never requested",
    );
  } finally {
    await origin.close();
  }
});

test("downloadText denies a chain at a blocked intermediate hop too", async () => {
  const origin = await startFixtureOrigin();
  try {
    await assert.rejects(
      downloadText(origin.url("/start"), transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["^http://hop\\.test:"]),
      })),
      UrlBlocklistDeniedError,
    );
    assert.deepEqual(origin.hits, ["start.test/start"], "the blocked intermediate is never requested");
  } finally {
    await origin.close();
  }
});

test("an allowed chain and an allowed direct URL keep their existing behavior", async () => {
  const origin = await startFixtureOrigin();
  try {
    const redirected = await downloadText(origin.url("/open-start"), transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["blocked\\.test"]),
    }));
    assert.equal(redirected.finalUrl, origin.url("/final", "final.test"));
    assert.match(redirected.text, /final\.test\/final body content/);

    const direct = await downloadText(origin.url("/final", "final.test"), transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["blocked\\.test"]),
    }));
    assert.equal(direct.finalUrl, origin.url("/final", "final.test"));
    assert.deepEqual(
      origin.hits,
      ["start.test/open-start", "final.test/final", "final.test/final"],
    );
  } finally {
    await origin.close();
  }
});

test("the complete supplied URL is the only regex input: #deny$ denies, /final$ does not", async () => {
  const origin = await startFixtureOrigin();
  // Regex rules are the whole contract: an entry is judged against the URL
  // exactly as supplied, and nothing ever rechecks the fragmentless form that
  // goes on the wire.
  try {
    await assert.rejects(
      downloadText(`${origin.url("/final", "final.test")}#deny`, transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["#deny$"]),
      })),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        const denial = error as UrlBlocklistDeniedError;
        assert.equal(denial.stage, "initial");
        assert.equal(denial.pattern, "#deny$");
        assert.equal(denial.deniedUrl, `${origin.url("/final", "final.test")}#deny`);
        return true;
      },
    );
    assert.deepEqual(origin.hits, [], "a fragment-only match denies the supplied URL before any request");

    // `/final$` cannot match `…/final#frag`, so the acquisition proceeds. Only
    // the fragmentless wire request reaches the origin, and no stripped second
    // look turns this permitted URL into a denial.
    const permitted = await downloadText(`${origin.url("/final", "final.test")}#frag`, transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["/final$"]),
    }));
    assert.equal(permitted.finalUrl, origin.url("/final", "final.test"));
    assert.match(permitted.text, /final\.test\/final body content/);
    assert.deepEqual(origin.hits, ["final.test/final"], "the permitted URL is requested once, fragmentless");

    // Unanchored, the same text matches the complete URL and denies it.
    await assert.rejects(
      downloadText(`${origin.url("/final", "final.test")}#frag`, transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["/final"]),
      })),
      UrlBlocklistDeniedError,
    );
    assert.deepEqual(origin.hits, ["final.test/final"], "the denied supplied URL is never requested");
  } finally {
    await origin.close();
  }
});

test("the complete destination is the only regex input: #deny$ denies, /frag-target$ permits", async () => {
  const origin = await startFixtureOrigin();
  // `/frag-start` answers 302 → `…/frag-target#deny`, so the destination's
  // complete URL — fragment included — is what every entry here is judged
  // against, before the hop is validated, resolved, or dialed.
  try {
    await assert.rejects(
      downloadText(origin.url("/frag-start"), transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["#deny$"]),
      })),
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

    // The same chain judged by a trailing path anchor: `…/frag-target#deny`
    // does not end in `/frag-target`, so there is no match and the hop is
    // followed normally.
    const permitted = await downloadText(origin.url("/frag-start"), transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["/frag-target$"]),
    }));
    assert.equal(permitted.finalUrl, origin.url("/frag-target", "final.test"));
    assert.match(permitted.text, /final\.test\/frag-target body content/);
    assert.deepEqual(
      origin.hits,
      ["start.test/frag-start", "start.test/frag-start", "final.test/frag-target"],
      "the permitted destination is requested once, fragmentless on the wire",
    );
  } finally {
    await origin.close();
  }
});

test("the supplied fragment is never copied onto a redirect destination", async () => {
  const origin = await startFixtureOrigin();
  // `/open-start` answers 302 → `…/final` naming no fragment of its own, so the
  // complete destination is `…/final`. The supplied `#keep` was judged against
  // the supplied URL and stops there: no phantom `…/final#keep` is ever judged,
  // which is what native Chromium does for this same chain (see
  // `web-url-blocklist-browser.test.ts`).
  try {
    await assert.rejects(
      downloadText(`${origin.url("/open-start")}#keep`, transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["/final$"]),
      })),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        const denial = error as UrlBlocklistDeniedError;
        assert.equal(denial.stage, "redirect");
        assert.equal(denial.pattern, "/final$");
        assert.equal(denial.deniedUrl, origin.url("/final", "final.test"));
        return true;
      },
    );
    assert.deepEqual(origin.hits, ["start.test/open-start"], "the destination is denied before it is requested");

    // An entry that requires the fragment the Location never named cannot match
    // the destination, and nothing guesses around it: the same chain runs end to
    // end.
    const permitted = await downloadText(`${origin.url("/open-start")}#keep`, transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["/final#keep$"]),
    }));
    assert.equal(permitted.finalUrl, origin.url("/final", "final.test"));
    assert.deepEqual(
      origin.hits,
      ["start.test/open-start", "start.test/open-start", "final.test/final"],
      "the permitted chain ends at the fragmentless wire request",
    );
  } finally {
    await origin.close();
  }
});

test("a fragment a redirect introduces is judged on the next hop, as Chromium forms it", async () => {
  const origin = await startFixtureOrigin();
  // `/frag-chain-start` answers 302 → `…/hop2#keep`, which answers 302 →
  // `…/final` naming no fragment. The real acquisition route shows native
  // Chromium requesting that second hop with the introduced `#keep` still
  // attached to the navigation — CDP reports it as the hop's own `urlFragment`
  // — so the HTTP route judges the same complete destination, `…/final#keep`.
  // A fragment of the caller's supplied URL never joins a destination; only a
  // fragment the chain itself carries does.
  try {
    await assert.rejects(
      downloadText(origin.url("/frag-chain-start"), transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["/hop2#keep$"]),
      })),
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

    // The introduced fragment is still on the navigation when the next Location
    // names none, so an entry anchored on it denies that last hop before it is
    // requested — the denial a bare `…/final` judgment would have missed.
    await assert.rejects(
      downloadText(origin.url("/frag-chain-start"), transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["/final#keep$"]),
      })),
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
      "the carried-fragment destination is denied before it is requested",
    );

    // Regex rules still decide everything: the destination ends in `#keep`, so a
    // trailing anchor on the path alone matches nothing and the chain runs end to
    // end.
    const permitted = await downloadText(origin.url("/frag-chain-start"), transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["/final$"]),
    }));
    assert.equal(permitted.finalUrl, origin.url("/final", "final.test"));
    assert.match(permitted.text, /final\.test\/final body content/);
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
      "the permitted chain requests every hop once, fragmentless on the wire",
    );
  } finally {
    await origin.close();
  }
});

test("an explicitly empty supplied fragment is judged as supplied, not carried onto a hop", async () => {
  const origin = await startFixtureOrigin();
  // `/open-start` answers 302 → `…/final` naming no fragment at all. The
  // supplied `…#` is judged as the complete supplied URL, and the destination
  // stays `…/final`: an entry anchored on an empty fragment matches the supplied
  // form and does not match the destination.
  try {
    const permitted = await downloadText(`${origin.url("/open-start")}#`, transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["/final#$"]),
    }));
    assert.equal(permitted.finalUrl, origin.url("/final", "final.test"));
    assert.deepEqual(
      origin.hits,
      ["start.test/open-start", "final.test/final"],
      "the empty supplied fragment does not reappear on the destination",
    );

    await assert.rejects(
      downloadText(`${origin.url("/open-start")}#`, transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["/open-start#$"]),
      })),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        const denial = error as UrlBlocklistDeniedError;
        assert.equal(denial.stage, "initial");
        assert.equal(denial.deniedUrl, `${origin.url("/open-start")}#`);
        return true;
      },
    );
    assert.deepEqual(
      origin.hits,
      ["start.test/open-start", "final.test/final"],
      "the denied supplied URL is never requested",
    );
  } finally {
    await origin.close();
  }
});

test("a Location naming an empty fragment judges that empty fragment", async () => {
  const origin = await startFixtureOrigin();
  // `/clear-start` answers 302 → `…/final#`. The Location names a fragment
  // component (the empty one), so that is exactly what the complete destination
  // carries, whatever fragment the supplied URL had.
  try {
    await assert.rejects(
      downloadText(`${origin.url("/clear-start")}#keep`, transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["/final#$"]),
      })),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        const denial = error as UrlBlocklistDeniedError;
        assert.equal(denial.stage, "redirect");
        assert.equal(denial.pattern, "/final#$");
        assert.equal(denial.deniedUrl, `${origin.url("/final", "final.test")}#`);
        return true;
      },
    );
    assert.deepEqual(origin.hits, ["start.test/clear-start"], "the cleared-fragment destination is never requested");

    // Nothing carried the `#keep` forward, so an entry that would have matched
    // `…/final#keep` permits the hop.
    const permitted = await downloadText(`${origin.url("/clear-start")}#keep`, transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["final#keep"]),
    }));
    assert.equal(permitted.finalUrl, origin.url("/final", "final.test"));
    assert.deepEqual(
      origin.hits,
      ["start.test/clear-start", "start.test/clear-start", "final.test/final"],
      "the permitted chain reaches the fragmentless wire request",
    );
  } finally {
    await origin.close();
  }
});

test("the raw supplied string is judged, never a parser-normalized form", async () => {
  const origin = await startFixtureOrigin();
  // The URL parser lowercases the host and drops the fragment. A check against
  // its output would deny an input that no configured entry matches as supplied.
  try {
    const permitted = await downloadText(`http://FINAL.test:${origin.port}/final#frag`, transportOptions({
      resolveHostname: syntheticResolver,
      createDispatcher: dialFixture,
      urlGuard: guardFor(["^http://final\\.test"]),
    }));
    assert.equal(permitted.finalUrl, origin.url("/final", "final.test"));
    assert.deepEqual(origin.hits, ["final.test/final"], "only the normalized host ever goes on the wire");

    await assert.rejects(
      downloadText(`http://FINAL.test:${origin.port}/final#frag`, transportOptions({
        resolveHostname: syntheticResolver,
        createDispatcher: dialFixture,
        urlGuard: guardFor(["#frag$"]),
      })),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        const denial = error as UrlBlocklistDeniedError;
        assert.equal(denial.stage, "initial");
        assert.equal(denial.pattern, "#frag$");
        assert.equal(denial.deniedUrl, `http://FINAL.test:${origin.port}/final#frag`);
        return true;
      },
    );
    assert.deepEqual(origin.hits, ["final.test/final"], "the denied raw input is never requested");
  } finally {
    await origin.close();
  }
});

// ---------------------------------------------------------------------------
// Page cache: the supplied URL is checked before any lookup, and a changed
// shared list cannot be evaded by an entry cached earlier.
// ---------------------------------------------------------------------------

test("the page cache denies the supplied URL before any lookup or download", async () => {
  const config = normalizeConfig({ web: { urlBlocklist: ["aliyuncs"] } });
  let downloads = 0;
  const cache = new WebPageCache(config.web!.fetch, async (url, options) => {
    downloads += 1;
    options.urlGuard?.(url, "initial");
    return {
      requestedUrl: url,
      finalUrl: url,
      contentType: "text/html; charset=utf-8",
      text: "<html><body><p>never reached.</p></body></html>",
      bytes: 40,
      fetchedAt: "2026-08-23T00:00:00.000Z",
    };
  }, compileUrlBlocklist(config.web!.urlBlocklist));
  for (const refresh of [false, true]) {
    await assert.rejects(
      cache.fetch({ url: "https://bucket.example.aliyuncs.com/object", refresh }),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        assert.equal((error as UrlBlocklistDeniedError).stage, "initial");
        return true;
      },
    );
  }
  assert.equal(downloads, 0, "a denied URL never reaches the acquisition route, cached or not");
  await cache.cleanup();
});

test("a changed shared list invalidates cached acquisitions; an unchanged one does not", async () => {
  const origin = await startFixtureOrigin();
  const config = normalizeConfig({});
  const cache = new WebPageCache(config.web!.fetch, fixtureTransport);
  try {
    const first = await cache.fetch({ url: origin.url("/open-start") });
    assert.equal(first.cacheHit, false);
    assert.equal(first.finalUrl, origin.url("/final", "final.test"));
    const hitsAfterFirst = origin.hits.length;

    // Same list again: the cached document stays and no request happens.
    cache.updateConfig(config.web!.fetch, compileUrlBlocklist([]));
    const cached = await cache.fetch({ url: origin.url("/open-start") });
    assert.equal(cached.cacheHit, true);
    assert.equal(origin.hits.length, hitsAfterFirst, "an unchanged blocklist keeps the cache intact");

    // The new list denies the cached chain's destination. The cached document
    // must be discarded, and the re-acquisition must be denied at the hop
    // without ever requesting that destination again.
    cache.updateConfig(config.web!.fetch, compileUrlBlocklist(["final\\.test"]));
    await assert.rejects(cache.fetch({ url: origin.url("/open-start") }), UrlBlocklistDeniedError);
    const newHits = origin.hits.slice(hitsAfterFirst);
    assert.deepEqual(newHits, ["start.test/open-start"], "the cached document is refetched and the denied hop is not requested");
  } finally {
    await cache.cleanup();
    await origin.close();
  }
});

test("a policy change while an acquisition is in flight cannot leave its document cached", async () => {
  const origin = await startFixtureOrigin();
  const config = normalizeConfig({});
  const cache = new WebPageCache(config.web!.fetch, fixtureTransport);
  // The list changes after the allowed hops are already underway, so the
  // in-flight chain was validated against the earlier policy only. Its
  // intermediate hop cannot be rechecked later from the cached document.
  origin.before("final.test", "/final", () => {
    cache.updateConfig(config.web!.fetch, compileUrlBlocklist(["final\\.test"]));
  });
  try {
    // The completed acquisition is discarded and reported as a policy change.
    // It is not re-requested automatically — that is the caller's call — and it
    // is not dressed up as a blocklist denial, because nothing matched.
    await assert.rejects(cache.fetch({ url: origin.url("/open-start") }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof UrlBlocklistDeniedError), "a policy change is not reported as a match");
      assert.match((error as Error).message, /web\.urlBlocklist changed while/);
      assert.match((error as Error).message, /No further request was made\. Retry the request\./);
      return true;
    });
    assert.deepEqual(
      origin.hits,
      ["start.test/open-start", "final.test/final"],
      "the discarded acquisition is the only request the change caused",
    );
    assert.deepEqual(await readdir(cache.cacheRoot()!), [], "the discarded acquisition leaves no cached document behind");

    // A later fetch runs under the current policy and is denied at the hop.
    await assert.rejects(cache.fetch({ url: origin.url("/open-start") }), UrlBlocklistDeniedError);
    assert.deepEqual(
      origin.hits.slice(2),
      ["start.test/open-start"],
      "the denied hop is never requested by the retried acquisition",
    );
  } finally {
    await cache.cleanup();
    await origin.close();
  }
});

test("the next call after a discarded acquisition rechecks the supplied URL, fragment and all", async () => {
  const origin = await startFixtureOrigin();
  const config = normalizeConfig({});
  const cache = new WebPageCache(config.web!.fetch, fixtureTransport);
  // The supplied URL carries a fragment the normalized request URL loses, so a
  // later call that rechecked only the normalized URL would happily acquire it.
  origin.before("final.test", "/final", () => {
    cache.updateConfig(config.web!.fetch, compileUrlBlocklist(["#deny$"]));
  });
  try {
    await assert.rejects(cache.fetch({ url: `${origin.url("/open-start")}#deny` }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof UrlBlocklistDeniedError), "a policy change is not reported as a match");
      assert.match((error as Error).message, /web\.urlBlocklist changed while/);
      return true;
    });
    assert.deepEqual(
      origin.hits,
      ["start.test/open-start", "final.test/final"],
      "the discarded acquisition is not replaced by a second acquisition of the now-denied URL",
    );
    assert.deepEqual(await readdir(cache.cacheRoot()!), [], "the discarded document is not retained");

    // The caller's own retry judges the supplied URL complete: the fragment the
    // new entry matches denies it before any request at all.
    await assert.rejects(
      cache.fetch({ url: `${origin.url("/open-start")}#deny` }),
      (error: unknown) => {
        assert.ok(error instanceof UrlBlocklistDeniedError);
        const denial = error as UrlBlocklistDeniedError;
        assert.equal(denial.stage, "initial");
        assert.equal(denial.pattern, "#deny$");
        return true;
      },
    );
    assert.deepEqual(
      origin.hits,
      ["start.test/open-start", "final.test/final"],
      "the denied supplied URL is never requested again",
    );
  } finally {
    await cache.cleanup();
    await origin.close();
  }
});

test("an entry added while an empty-policy acquisition is in flight denies the hop before it is sent", async () => {
  const origin = await startFixtureOrigin();
  const config = normalizeConfig({});
  // Nothing is blocked when the acquisition starts; the entry arrives while the
  // initial request is still underway.
  const cache = new WebPageCache(config.web!.fetch, fixtureTransport);
  try {
    origin.before("start.test", "/open-start", () => {
      cache.updateConfig(config.web!.fetch, compileUrlBlocklist(["final\\.test"]));
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
      "the destination blocked by the live update is never contacted, not even before the retry",
    );
  } finally {
    await cache.cleanup();
    await origin.close();
  }
});

// ---------------------------------------------------------------------------
// Both acquisition tools: one list, explicit denied outcomes.
// ---------------------------------------------------------------------------

interface ToolHarness {
  tools: Map<string, {
    execute(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  }>;
  manager: WebToolManager;
}

function toolHarness(config: ReviewGateConfig): ToolHarness {
  const tools = new Map<string, any>();
  const cache = new WebPageCache(config.web!.fetch, fixtureTransport);
  const browserCache = new WebPageCache(config.web!.fetch, fixtureTransport);
  const manager = new WebToolManager({
    registerTool: (tool: unknown) => tools.set((tool as { name: string }).name, tool),
  }, config, cache, browserCache);
  manager.register();
  return { tools: tools as ToolHarness["tools"], manager };
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((part) => part.text ?? "").join("\n");
}

test("WebFetch denies a direct match with an explicit outcome and no browser fallback", async () => {
  const config = normalizeConfig({ web: { urlBlocklist: ["aliyuncs"] } });
  const { tools, manager } = toolHarness(config);
  try {
    const result = await tools.get("WebFetch")!.execute("denied", { url: "https://bucket.example.aliyuncs.com/object" });
    const text = textOf(result);
    assert.equal(result.isError, true);
    assert.match(text, /^WebFetch denied: /);
    assert.match(text, /web\.urlBlocklist/);
    assert.match(text, /aliyuncs/);
    // The denial is the outcome: the ordinary BrowserExtract escalation is gone.
    assert.doesNotMatch(text, /Use BrowserExtract only if this failure plausibly requires/);
    assert.match(text, /retrying this URL with either tool is denied the same way/);
  } finally {
    await manager.cleanup();
  }
});

test("WebFetch surfaces the transport's redirect denial for an allowed initial URL", async () => {
  const origin = await startFixtureOrigin();
  const config = normalizeConfig({ web: { urlBlocklist: ["blocked\\.test"] } });
  const { tools, manager } = toolHarness(config);
  try {
    const result = await tools.get("WebFetch")!.execute("chain", { url: origin.url("/start") });
    const text = textOf(result);
    assert.equal(result.isError, true);
    assert.match(text, /^WebFetch denied: /);
    assert.match(text, /redirect destination/);
    assert.doesNotMatch(text, /Use BrowserExtract only if this failure plausibly requires/);
    assert.deepEqual(origin.hits, ["start.test/start", "hop.test/hop"], "the blocked destination was never requested");
  } finally {
    await manager.cleanup();
    await origin.close();
  }
});

test("BrowserExtract denies with the same list and never launches a render", async () => {
  const origin = await startFixtureOrigin();
  const config = normalizeConfig({ web: { urlBlocklist: ["blocked\\.test"] } });
  const { tools, manager } = toolHarness(config);
  try {
    const direct = await tools.get("BrowserExtract")!.execute("denied", { url: origin.url("/blocked", "blocked.test") });
    assert.equal(direct.isError, true);
    assert.match(textOf(direct), /^BrowserExtract denied: /);
    assert.match(textOf(direct), /retrying this URL with either tool is denied the same way/);

    const chained = await tools.get("BrowserExtract")!.execute("chain", { url: origin.url("/start") });
    assert.equal(chained.isError, true);
    assert.match(textOf(chained), /^BrowserExtract denied: /);
    assert.match(textOf(chained), /redirect destination/);
    assert.deepEqual(origin.hits, ["start.test/start", "hop.test/hop"], "the blocked destination was never rendered");
  } finally {
    await manager.cleanup();
    await origin.close();
  }
});

test("the registered tools judge the raw supplied URL complete: /final$ permits, #frag$ denies", async () => {
  const origin = await startFixtureOrigin();
  const supplied = `${origin.url("/final", "final.test")}#frag`;
  // Each harness carries its own list through the shared cache and the real
  // transport, so what is asserted here is the tools' actual policy input —
  // the caller's raw string, not a normalized or fragmentless derivative.
  const permitted = toolHarness(normalizeConfig({ web: { urlBlocklist: ["/final$"] } }));
  const denied = toolHarness(normalizeConfig({ web: { urlBlocklist: ["#frag$"] } }));
  try {
    for (const toolName of ["WebFetch", "BrowserExtract"] as const) {
      const allowed = await permitted.tools.get(toolName)!.execute("permit", { url: supplied });
      assert.equal(allowed.isError, false, `${toolName} must not deny a URL its complete form does not match`);

      const denial = await denied.tools.get(toolName)!.execute("deny", { url: supplied });
      assert.equal(denial.isError, true);
      assert.match(textOf(denial), new RegExp(`^${toolName} denied: `));
      assert.match(textOf(denial), /#frag\$/);
      assert.match(textOf(denial), /retrying this URL with either tool is denied the same way/);
    }
    assert.deepEqual(
      origin.hits,
      ["final.test/final", "final.test/final"],
      "only the two permitted acquisitions reached the origin, each fragmentless on the wire",
    );
  } finally {
    await permitted.manager.cleanup();
    await denied.manager.cleanup();
    await origin.close();
  }
});

test("one saved list change applies to both tools; an unchanged save keeps cached pages", async () => {
  const origin = await startFixtureOrigin();
  const config = normalizeConfig({});
  const { tools, manager } = toolHarness(config);
  try {
    const allowed = await tools.get("WebFetch")!.execute("allowed", { url: origin.url("/open-start") });
    assert.equal(allowed.isError, false);
    const hitsAfterAllowed = origin.hits.length;

    // Saving an unrelated Web value must not disturb the acquisition cache.
    await manager.sync(normalizeConfig({ web: { fetch: { maxOutputChars: 11_000 } } }));
    const cached = await tools.get("WebFetch")!.execute("cached", { url: origin.url("/open-start") });
    assert.match(textOf(cached), /session cache/);
    assert.equal(origin.hits.length, hitsAfterAllowed, "an unchanged blocklist never invalidates the cache");

    // One list now denies both tools for the same URL and the same chain.
    await manager.sync(normalizeConfig({ web: { urlBlocklist: ["blocked\\.test"] } }));
    const webFetch = await tools.get("WebFetch")!.execute("denied-fetch", { url: origin.url("/start") });
    assert.match(textOf(webFetch), /^WebFetch denied: /);
    const browserExtract = await tools.get("BrowserExtract")!.execute("denied-extract", { url: origin.url("/start") });
    assert.match(textOf(browserExtract), /^BrowserExtract denied: /);
    assert.deepEqual(
      origin.hits.slice(hitsAfterAllowed),
      ["start.test/start", "hop.test/hop", "start.test/start", "hop.test/hop"],
      "each acquisition path walks the allowed hops once, and neither requests the blocked destination",
    );
    assert.ok(
      !origin.hits.some((hit) => hit.includes("blocked.test")),
      "the blocked destination is never requested by either tool",
    );
  } finally {
    await manager.cleanup();
    await origin.close();
  }
});

// ---------------------------------------------------------------------------
// Settings: staged editing, validation, and persistence of the shared list.
// ---------------------------------------------------------------------------

interface SettingsUiHarness {
  ui: Record<string, unknown>;
  notices: Array<{ message: string; type?: string }>;
  editorCalls: Array<{ title: string; prefill?: string }>;
}

function settingsUi(selections: Array<string | undefined>, editorResults: Array<string | undefined>): SettingsUiHarness {
  const harness: SettingsUiHarness = { ui: {}, notices: [], editorCalls: [] };
  let selectIndex = 0;
  let editorIndex = 0;
  harness.ui = {
    async select(title: string, options: string[]) {
      const wanted = selections[selectIndex++];
      if (wanted === undefined) return undefined;
      const match = options.find((option) => option.includes(wanted));
      assert.ok(match, `no option containing "${wanted}" in ${title}: ${options.join(" | ")}`);
      return match;
    },
    async editor(title: string, prefill?: string) {
      harness.editorCalls.push({ title, prefill });
      return editorResults[editorIndex++];
    },
    notify(message: string, type?: "info" | "warning" | "error") {
      harness.notices.push({ message, type });
    },
  };
  return harness;
}

test("the interactive browser manager is never handed the acquisition blocklist", async () => {
  const applied: unknown[][] = [];
  const interactive = {
    updateConfig(...args: unknown[]) {
      applied.push(args);
    },
    async shutdown() {},
  } as unknown as InteractiveBrowserManager;
  const tools = new Map<string, any>();
  const manager = new WebToolManager(
    { registerTool: (tool: unknown) => tools.set((tool as { name: string }).name, tool) },
    normalizeConfig({ web: { urlBlocklist: ["aliyuncs"] } }),
    undefined,
    undefined,
    interactive,
  );
  try {
    await manager.sync(normalizeConfig({ web: { urlBlocklist: ["blocked\\.test"] } }));
    assert.ok(applied.length >= 2, "both initial registration and the live update configure the interactive browser");
    for (const args of applied) {
      for (const arg of args) {
        assert.notEqual(typeof arg, "function", "no blocklist guard is passed to the interactive browser");
        assert.ok(
          !(Array.isArray(arg) && arg.some((value) => typeof value === "string" && value.includes("blocked"))),
          "no blocklist sources are passed to the interactive browser",
        );
      }
    }
  } finally {
    await manager.cleanup();
  }
});

test("Web settings stage the shared list, reject an invalid expression, and cancel unchanged", async () => {
  const web = normalizeConfig({ web: { urlBlocklist: ["aliyuncs"] } }).web!;
  const base = [
    web.fetch.maxDownloadBytes,
    web.browserInteractionApproval,
    web.browserIdleExpiryMinutes,
    web.browserDownloadRetention,
    web.browserVisible,
    web.browserPermissions,
  ] as const;

  // Cancel leaves the staged list untouched.
  const cancelled = settingsUi(["URL blocklist", "Back"], [undefined]);
  const cancelledResult = await selectWebSettings(cancelled.ui as never, ...base, web.urlBlocklist);
  assert.deepEqual(cancelledResult.urlBlocklist, ["aliyuncs"]);

  // An invalid expression is reported actionably and nothing is staged; the
  // next valid submission then stages the whole edited list.
  const rejected = settingsUi(["URL blocklist", "URL blocklist", "Back"], ["https://(unbalanced", "blocked\\.test\n^https://private\\.test/"]);
  const rejectedResult = await selectWebSettings(rejected.ui as never, ...base, web.urlBlocklist);
  assert.ok(
    rejected.notices.some((notice) => notice.type === "error" && notice.message.includes("not a valid JavaScript regular expression") && notice.message.includes("was not changed")),
    `expected an actionable validation notice, got ${JSON.stringify(rejected.notices)}`,
  );
  assert.deepEqual(rejectedResult.urlBlocklist, ["blocked\\.test", "^https://private\\.test/"]);
  assert.deepEqual(
    rejected.editorCalls.map((call) => call.prefill),
    ["aliyuncs", "aliyuncs"],
    "the field prefills the current list so it can be edited line by line",
  );

  // Blank lines are ignored and surrounding whitespace is trimmed.
  const trimmed = settingsUi(["URL blocklist", "Back"], ["  aliyuncs  \n\n   \n^https://x\\.test/\n"]);
  const trimmedResult = await selectWebSettings(trimmed.ui as never, ...base, web.urlBlocklist);
  assert.deepEqual(trimmedResult.urlBlocklist, ["aliyuncs", "^https://x\\.test/"]);
});

test("settings Save persists the shared list and an empty list clears it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-url-blocklist-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ enabled: false, web: { search: { maxResults: 7 } } }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  let registered: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "review-settings") registered = options.handler;
      },
    },
    config,
    configPath,
  });
  assert.ok(registered);

  await registered!("", { scopedModels: [], ui: settingsUi(["Tools", "Web", "URL blocklist", "Back", "Back", "Save changes"], ["aliyuncs\n^https://internal\\.test/"]).ui });
  let saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.web.urlBlocklist, ["aliyuncs", "^https://internal\\.test/"]);
  assert.equal(saved.web.search.maxResults, 7, "unrelated Web settings survive");
  assert.deepEqual(config.web!.urlBlocklist, ["aliyuncs", "^https://internal\\.test/"], "the live config carries the saved list");

  // Cancel discards the staged edit instead of persisting it.
  await registered!("", { scopedModels: [], ui: settingsUi(["Tools", "Web", "URL blocklist", "Back", "Back", "Cancel"], ["dropped"]).ui });
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.web.urlBlocklist, ["aliyuncs", "^https://internal\\.test/"]);

  // Clearing every line persists an empty list, which denies nothing.
  await registered!("", { scopedModels: [], ui: settingsUi(["Tools", "Web", "URL blocklist", "Back", "Back", "Save changes"], [""]).ui });
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.web.urlBlocklist, []);
  assert.deepEqual(config.web!.urlBlocklist, []);
});
