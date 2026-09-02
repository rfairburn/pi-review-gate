import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { isBlockedAddress, parseIp } from "../src/web/ip";
import { downloadText, validatedPublicUrl, type NetworkOptions } from "../src/web/network";

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