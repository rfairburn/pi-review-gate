import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BrowserFailureError, InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";

// #35 regressions. A content-rich public homepage can legitimately exceed the
// former 16-distinct-host extraction budget mid-navigation. Interactive
// sessions must continue, while real policy failures retain safe diagnostics.

const PUBLIC_ANSWER = "203.0.114.1"; // TEST-NET-3 documentation range, not blocked

/** Local origin: "/" serves a page referencing 20 distinct subresource hosts;
 * every host's "/s.js" succeeds so only the budget can refuse. */
function localOrigin(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const port = (server.address() as AddressInfo).port;
    if ((request.url ?? "/") === "/s.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("0");
      return;
    }
    const scripts = Array.from({ length: 20 }, (_, index) =>
      `<script src="http://sub-${index + 1}.test:${port}/s.js"></script>`,
    ).join("");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><title>main</title></head><body>main${scripts}</body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

test("interactive navigation exceeds former host, request, navigation and action quotas", async () => {
  const origin = await localOrigin();
  const dials: string[] = [];
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => [PUBLIC_ANSWER],
    brokerDial: (validated) => {
      dials.push(validated.hostname);
      return net.connect({ host: "127.0.0.1", port: origin.port });
    },
  });
  try {
    const opened = await manager.open(`http://main.test:${origin.port}/`);
    for (let index = 0; index < 33; index++) {
      await manager.navigate(opened.session, opened.tab, `http://main.test:${origin.port}/?page=${index}`);
      await manager.snapshot(opened.session, opened.tab, 1000);
    }
    const distinct = new Set(dials);
    assert.equal(distinct.size, 21);
    assert.ok(dials.length > 256, `actual transfers must exceed old connection/request quotas: ${dials.length}`);
    assert.equal(manager.activeSessionCount(), 1);
    assert.match((await manager.snapshot(opened.session, opened.tab, 1000)).snapshot, /main/);
    const closed = await manager.close(opened.session);
    assert.ok(closed.broker!.connections > 256);
    assert.ok(closed.broker!.ledgerDropped > 0);
  } finally {
    await manager.shutdown();
    await origin.close();
  }
  assert.equal(manager.activeSessionCount(), 0);
});

test("URL validation DNS failure is structured before browser launch", async () => {
  let launches = 0;
  const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND missing.test"), { code: "ENOTFOUND" });
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async (hostname) => {
      if (hostname === "missing.test") throw dnsError;
      return [PUBLIC_ANSWER];
    },
    launch: async () => {
      launches += 1;
      throw new Error("launch must not be reached for a validation failure");
    },
  });
  try {
    await assert.rejects(
      manager.open("https://missing.test/"),
      (error: unknown) => error instanceof BrowserFailureError
        && error.phase === "url_validation"
        && error.category === "dns_resolution_failed",
    );
  } finally {
    await manager.shutdown();
  }
  assert.equal(launches, 0);
  assert.equal(manager.activeSessionCount(), 0);
});

test("BrowserOpen tool text reports phase and category with fixed bounded text", async () => {
  const marker = "secret-marker-907";
  const dnsError = Object.assign(new Error(`getaddrinfo ENOTFOUND missing.test ${marker}`), { code: "ENOTFOUND" });
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => {
      throw dnsError;
    },
  });
  const tools: Array<{ name: string; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }> = [];
  const webTools = new WebToolManager(
    { registerTool: (tool) => tools.push(tool as never) },
    normalizeConfig({}),
    undefined,
    undefined,
    manager,
  );
  webTools.register();
  try {
    const open = tools.find((tool) => tool.name === "BrowserOpen");
    assert.ok(open, "BrowserOpen must be registered");
    await assert.rejects(
      open.execute("call-1", { url: "https://missing.test/" }),
      (error: unknown) => error instanceof Error
        && /phase=url_validation; category=dns_resolution_failed/.test(error.message)
        && /No rollback is claimed/.test(error.message)
        && error.message.length < 512
        && !error.message.includes(marker),
    );
  } finally {
    await webTools.cleanup();
  }
});

test("malformed URL input with denial-like text reports invalid_url and never claims SSRF denial", async () => {
  // The input embeds the exact SSRF-denial phrase plus DNS error tokens. It
  // must be classified invalid_url at the validation site, not by searching
  // this text, and it must not reach the tool result.
  const hostile = "resolves to a non-public address ENOTFOUND getaddrinfo";
  let resolutions = 0;
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => {
      resolutions += 1;
      return [PUBLIC_ANSWER];
    },
  });
  const tools: Array<{ name: string; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }> = [];
  const webTools = new WebToolManager(
    { registerTool: (tool) => tools.push(tool as never) },
    normalizeConfig({}),
    undefined,
    undefined,
    manager,
  );
  webTools.register();
  try {
    const open = tools.find((tool) => tool.name === "BrowserOpen");
    assert.ok(open, "BrowserOpen must be registered");
    await assert.rejects(
      open.execute("call-1", { url: hostile }),
      (error: unknown) => error instanceof Error
        && /phase=url_validation; category=invalid_url/.test(error.message)
        && !/SSRF|non_public_address_denied/.test(error.message)
        && !error.message.includes(hostile)
        && error.message.length < 512,
    );
  } finally {
    await webTools.cleanup();
  }
  assert.equal(resolutions, 0, "a malformed URL must fail before any DNS resolution");
});

test("untyped failure text is not claimed as a proven authorization denial", async () => {
  const marker = "secret-marker-908";
  const fake = {
    shutdown: async () => undefined,
    updateConfig: () => undefined,
    open: async () => {
      throw new Error(`custom policy note ${marker}`);
    },
  };
  const tools: Array<{ name: string; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }> = [];
  const webTools = new WebToolManager(
    { registerTool: (tool) => tools.push(tool as never) },
    normalizeConfig({}),
    undefined,
    undefined,
    fake as unknown as InteractiveBrowserManager,
  );
  webTools.register();
  try {
    const open = tools.find((tool) => tool.name === "BrowserOpen");
    assert.ok(open, "BrowserOpen must be registered");
    await assert.rejects(
      open.execute("call-1", { url: "https://example.com/" }),
      (error: unknown) => error instanceof Error
        && !/authorization policy rejected/.test(error.message)
        && /not confirmed by structured diagnostics/.test(error.message)
        && !error.message.includes(marker),
    );
  } finally {
    await webTools.cleanup();
  }
});
