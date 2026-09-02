import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isBlockedAddress, parseIp } from "../src/web/ip";
import { decodeResponseText, downloadText, resolveDdgsHelperPath, runDdgsSearch, validatedPublicUrl, type NetworkOptions } from "../src/web/network";

// Unit table tests for the canonical, fail-closed SSRF range check.

const blockedAddresses = [
  // IPv4 specials.
  "0.0.0.0",
  "0.1.2.3",
  "10.0.0.1",
  "100.64.0.1",
  "100.127.255.255",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.0.1",
  "198.18.0.1",
  "198.19.255.255",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  // IPv6 basics.
  "::",
  "::1",
  "fe80::1",
  "febf::ffff:ffff:ffff:ffff:ffff:ffff",
  "fc00::1",
  "fd12:3456::1",
  "fec0::1",
  "feff::1",
  "ff02::1",
  "2001:db8::1",
  "2001:db8:abcd::1",
  "100::1",
  "100::ffff:ffff:ffff:ffff",
  "2001::1",
  // IPv4-mapped IPv6 (hex and dotted spellings; WHATWG URL normalization
  // rewrites dotted mapped literals to hex, so both must be rejected).
  "::ffff:7f00:1",
  "::ffff:7f00:0001",
  "::FFFF:7F00:1",
  "::ffff:127.0.0.1",
  "::ffff:a9fe:a9fe",
  "::ffff:0a00:0001",
  "::ffff:c0a8:0101",
  "::ffff:ac1f:0001",
  "::ffff:192.0.2.1",
  "::ffff:0.0.0.0",
  // IPv4-compatible IPv6.
  "::7f00:1",
  "::127.0.0.1",
  "::a9fe:a9fe",
  "::2:1",
  // NAT64 well-known prefix 64:ff9b::/96 (hex and dotted) and local-use /48.
  "64:ff9b::7f00:1",
  "64:ff9b::127.0.0.1",
  "64:ff9b:0:0:0:0:7f00:1",
  "64:ff9b::c0a8:0101",
  "64:ff9b:1::7f00:1",
  "64:ff9b:1:0:0:0:0:0",
  // 6to4 2002::/16.
  "2002:7f00:1::",
  "2002:7f00:1::1",
  "2002:7f00:0001:0000:0000:0000:0000:0000",
  "2002:c0a8:0101::",
  // Unparseable input is fail-closed.
  "not-an-address",
  "1.2.3",
  "1.2.3.4.5",
  "256.1.1.1",
  "01.2.3.4",
  "1:2:3:4:5:6:7:8:9",
  "12345::",
  "::ffff:1.2.3.256",
  "fe80::1%eth0",
  "",
  "0",
];

test("isBlockedAddress rejects special-purpose and embedded-IPv4 forms", () => {
  for (const address of blockedAddresses) {
    assert.equal(isBlockedAddress(address), true, `expected ${JSON.stringify(address)} to be blocked`);
  }
});

test("isBlockedAddress accepts public literals (positive controls and boundaries)", () => {
  const publicAddresses = [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "192.0.3.1",
    "192.167.0.1",
    "198.20.0.1",
    "198.51.101.1",
    "203.0.114.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2606:4700:4700::ffff:ffff",
    "2a00:1450:4001:81b::200e",
    // Just outside the discard-only 100::/64 prefix.
    "100:0:0:1::",
    // Public IPv4 embedded in mapped / NAT64 / 6to4 wrappers is extracted and
    // allowed through the same IPv4 blocklist.
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:808:808::",
  ];
  for (const address of publicAddresses) {
    assert.equal(isBlockedAddress(address), false, `expected ${JSON.stringify(address)} to be allowed`);
  }
});

test("canonical parser expands compressed IPv6 forms consistently", () => {
  const loopbackForms = ["::1", "0:0:0:0:0:0:0:1", "::0.0.0.1"];
  for (const form of loopbackForms) {
    assert.equal(isBlockedAddress(form), true, `expected ${form} to be blocked`);
  }
  const metadataForms = ["::ffff:169.254.169.254", "::a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::"];
  for (const form of metadataForms) {
    assert.equal(isBlockedAddress(form), true, `expected ${form} (cloud metadata) to be blocked`);
  }
  assert.equal(parseIp("fe80::1%eth0")?.version, 6);
  assert.equal(parseIp("::ffff:127.0.0.1")?.version, 6);
  assert.equal(parseIp("8.8.8.8")?.version, 4);
  assert.equal(parseIp("not-an-address"), undefined);
});

test("validatedPublicUrl rejects WHATWG-normalized mapped literals without DNS or network", async () => {
  // The WHATWG URL parser serializes IPv6 literals in hex, so dotted input is
  // normalized before validation; both spellings must be rejected.
  assert.equal(new URL("http://[::ffff:127.0.0.1]/").hostname, "[::ffff:7f00:1]");
  for (const url of [
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::7f00:1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://[fec0::1]/",
    "http://127.0.0.1/",
    "http://198.18.0.1/",
  ]) {
    await assert.rejects(validatedPublicUrl(url), /non-public address/, `expected ${url} to be rejected`);
  }
  await assert.doesNotReject(validatedPublicUrl("http://[2606:4700:4700::1111]/"));
});

test("downloadText cannot connect to a loopback server through mapped or compatible literals", async () => {
  let connections = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("probe-ok");
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const options: NetworkOptions = { timeoutMs: 2_000, maxBytes: 65_536, userAgent: "pi-review-gate-test" };
  try {
    // Positive control: the server is genuinely reachable over the loopback
    // IPv4 stack with a direct (unvalidated) fetch.
    const direct = await fetch(`http://127.0.0.1:${port}/probe`);
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), "probe-ok");
    const connectionsAfterControl = connections;
    assert.ok(connectionsAfterControl >= 1);

    // Blocked literal forms must be rejected before any connection is made.
    const blockedUrls = [
      `http://[::ffff:127.0.0.1]:${port}/probe`,
      `http://[::ffff:7f00:1]:${port}/probe`,
      `http://[::7f00:1]:${port}/probe`,
      `http://[64:ff9b::7f00:1]:${port}/probe`,
      `http://[2002:7f00:1::]:${port}/probe`,
    ];
    for (const url of blockedUrls) {
      await assert.rejects(downloadText(url, options), /non-public address/, `expected ${url} to be rejected`);
    }
    assert.equal(connections, connectionsAfterControl, "blocked forms must not open new connections");
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
  }
});

// L7: response decoding must fall back to UTF-8 when the declared charset is
// unknown or unsupported instead of letting a TextDecoder RangeError escape.
const utf8Hello = new TextEncoder().encode("héllo"); // "héllo" as UTF-8 bytes
const latin1Hello = new Uint8Array([0x68, 0xe9, 0x6c, 0x6c, 0x6f]); // same text in ISO-8859-1

test("decodeResponseText honors a supported declared charset", () => {
  const text = decodeResponseText("text/html; charset=iso-8859-1", latin1Hello);
  assert.equal(text, "héllo");
  // The same bytes decoded as UTF-8 would contain a replacement character, so
  // the equality above proves the declared label was actually used.
  assert.notEqual(new TextDecoder("utf-8").decode(latin1Hello), text);
});

test("decodeResponseText falls back to UTF-8 for unknown or unsupported charsets", () => {
  for (const contentType of ["text/plain; charset=x-not-a-real-charset", 'text/plain; charset="x-bogus"']) {
    assert.equal(decodeResponseText(contentType, utf8Hello), "héllo", `expected ${contentType} to fall back to UTF-8`);
  }
});

test("decodeResponseText treats malformed content-type headers as UTF-8", () => {
  for (const contentType of ["text/plain; charset=", "text/plain; charset=;", "", null]) {
    assert.equal(decodeResponseText(contentType, utf8Hello), "héllo", `expected ${JSON.stringify(contentType)} to decode as UTF-8`);
  }
});

test("decodeResponseText decodes absent charset declarations as UTF-8", () => {
  for (const contentType of ["text/html", "application/json; version=1"]) {
    assert.equal(decodeResponseText(contentType, utf8Hello), "héllo", `expected ${JSON.stringify(contentType)} to decode as UTF-8`);
  }
});

test("runDdgsSearch ignores helper overrides and invokes the packaged bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-ddgs-helper-"));
  const fakePython = join(root, "python");
  const injectedHelper = join(root, "injected-helper.py");
  const capturedHelper = join(root, "captured-helper");
  await writeFile(injectedHelper, "this helper must never execute\n", "utf8");
  await writeFile(fakePython, [
    "#!/usr/bin/env bash",
    // With -I, the packaged helper path is argv[2].
    "printf '%s' \"$2\" > \"$CAPTURED_HELPER\"",
    "cat >/dev/null",
    "printf '%s' '{\"ok\":true,\"results\":[]}'",
    "",
  ].join("\n"), "utf8");
  await chmod(fakePython, 0o755);

  const previousPython = process.env.PI_REVIEW_GATE_DDGS_PYTHON;
  const previousHelper = process.env.PI_REVIEW_GATE_DDGS_HELPER;
  const previousCapture = process.env.CAPTURED_HELPER;
  process.env.PI_REVIEW_GATE_DDGS_PYTHON = fakePython;
  process.env.PI_REVIEW_GATE_DDGS_HELPER = injectedHelper;
  process.env.CAPTURED_HELPER = capturedHelper;
  try {
    assert.deepEqual(
      await runDdgsSearch({ query: "trust boundary", maxResults: 1, timeoutMs: 2_000 }),
      { results: [] },
    );
  } finally {
    restoreEnvironment("PI_REVIEW_GATE_DDGS_PYTHON", previousPython);
    restoreEnvironment("PI_REVIEW_GATE_DDGS_HELPER", previousHelper);
    restoreEnvironment("CAPTURED_HELPER", previousCapture);
  }

  const helper = await readFile(capturedHelper, "utf8");
  assert.equal(helper, resolveDdgsHelperPath());
  // Anchored to the compiled test file (dist-test/tests/) so the expectation
  // does not depend on the test process working directory.
  assert.equal(helper, resolve(__dirname, "../../scripts/ddgs-search.py"));
  assert.notEqual(helper, injectedHelper);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
