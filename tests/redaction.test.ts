import assert from "node:assert/strict";
import test from "node:test";
import { redactBrowserToolInput, redactSensitiveText, redactSensitiveValue } from "../src/redaction";

test("redactSensitiveText removes common credentials while retaining context", () => {
  const text = "Authorization: Bearer abcdefghijklmnop api_key=sk-abcdefghijklmnop";
  const redacted = redactSensitiveText(text);
  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.match(redacted, /Authorization:/);
  assert.match(redacted, /api_key=/);
  assert.equal(redactSensitiveText("Authorization: Bearer abcdefghijklmnop"), "Authorization: [REDACTED]");
});

test("redactSensitiveText redacts multiline PEM private-key variants and keeps context", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA7examplekeymaterial7examplekeymaterial7examplekey",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const text = `tool output before\n${pem}\ntool output after`;

  assert.equal(
    redactSensitiveText(text),
    "tool output before\n[REDACTED]\ntool output after",
  );
});

test("redactSensitiveText redacts PEM private-key label variants and CRLF bodies", () => {
  const labels = ["OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PRIVATE KEY"];
  for (const label of labels) {
    const pem = [
      `-----BEGIN ${label}-----`,
      "AAAAExampleKeyMaterialAAAAExampleKeyMaterialAAAAExample",
      `-----END ${label}-----`,
    ].join("\n");
    assert.equal(
      redactSensitiveText(`before ${pem} after`),
      "before [REDACTED] after",
      `expected redaction for label: ${label}`,
    );
  }

  const crlfPem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA7examplekeymaterial7examplekeymaterial7examplekey",
    "-----END RSA PRIVATE KEY-----",
  ].join("\r\n");
  assert.equal(
    redactSensitiveText(`before\r\n${crlfPem}\r\nafter`),
    "before\r\n[REDACTED]\r\nafter",
  );
});

test("redactSensitiveText redacts PEM blocks with JSON-escaped newlines", () => {
  const escapedPem = [
    "-----BEGIN RSA PRIVATE KEY-----\\n",
    "MIIEowIBAAKCAQEA7examplekeymaterial7examplekeymaterial7examplekey\\n",
    "-----END RSA PRIVATE KEY-----\\n",
  ].join("");
  assert.equal(
    redactSensitiveText(`config dump: ${escapedPem} end of dump`),
    "config dump: [REDACTED]\\n end of dump",
  );
});

test("redactSensitiveText leaves PEM blocks with mismatched END labels intact", () => {
  const mismatched = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA7examplekeymaterial7examplekeymaterial7examplekey",
    "-----END EC PRIVATE KEY-----",
  ].join("\n");
  assert.equal(redactSensitiveText(mismatched), mismatched);
});

test("redactSensitiveText redacts raw JWTs embedded in tool text", () => {
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");
  const text = `tool result before ${jwt} after`;

  assert.equal(redactSensitiveText(text), "tool result before [REDACTED] after");
});

test("redactSensitiveText redacts a JWT with an empty claims object", () => {
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "e30",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");

  assert.equal(redactSensitiveText(`before ${jwt} after`), "before [REDACTED] after");
});

test("redactSensitiveText redacts a JWT whose header has leading JSON whitespace", () => {
  const jwt = [
    Buffer.from(' {"alg":"HS256","typ":"JWT"}').toString("base64url"),
    "e30",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");

  assert.equal(redactSensitiveText(`before ${jwt} after`), "before [REDACTED] after");
});

test("redactSensitiveText re-redacts assignment values that merely start with the marker", () => {
  assert.equal(redactSensitiveText('password="[REDACTED]hunter2"'), 'password="[REDACTED]"');
  assert.equal(
    redactSensitiveText("password=[REDACTED]-hunter2 status=ok"),
    "password=[REDACTED] status=ok",
  );
});

test("redactSensitiveText is idempotent for exact generated markers", () => {
  const text = 'password="[REDACTED]" token=[REDACTED] Authorization: [REDACTED]';
  assert.equal(redactSensitiveText(text), text);
});

test("redactSensitiveText leaves near-miss non-secrets intact", () => {
  const text = [
    "version 1.2.3 remains useful",
    "-----BEGIN PUBLIC KEY-----",
    "public-key-material",
    "-----END PUBLIC KEY-----",
    "eyJub3Qtand0IjoiZGF0YSJ9.eyJub3Qtand0IjoiZGF0YSJ9.not-a-jwt",
    "eyJub3Qtand0IjoiZGF0YSJ9.eyJub3Qtand0IjoiZGF0YSJ9.abcdefghijklmnopqrstuvwxyz",
  ].join("\n");

  assert.equal(redactSensitiveText(text), text);
});

test("redactSensitiveText preserves GitHub Actions id-token permission declarations (#55)", () => {
  const workflow = [
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "      id-token: write",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ].join("\n");

  assert.equal(redactSensitiveText(workflow), workflow);
});

test("redactSensitiveText preserves only the bare id-token write under a permissions mapping (#55)", () => {
  for (const text of [
    "permissions:\n  id-token: write",
    "permissions:\r\n  id-token: write\r\n",
    "permissions:\n  contents: read\n  id-token: write\n  checks: none",
  ]) {
    assert.equal(redactSensitiveText(text), text, `expected preserved: ${JSON.stringify(text)}`);
  }
});

test("redactSensitiveText redacts id-token write outside a permissions mapping (#55)", () => {
  // Top-level, and under unrelated mappings (a weak credential value).
  assert.equal(redactSensitiveText("id-token: write"), "id-token: [REDACTED]");
  assert.equal(
    redactSensitiveText("env:\n  id-token: write"),
    "env:\n  id-token: [REDACTED]",
  );
  // Same indentation as the permissions key is a sibling, not a child.
  assert.equal(
    redactSensitiveText("permissions:\nid-token: write"),
    "permissions:\nid-token: [REDACTED]",
  );
  // A stale earlier permissions block must not extend over a later mapping.
  const stale = "permissions:\n  contents: read\nenv:\n  id-token: write";
  assert.equal(
    redactSensitiveText(stale),
    "permissions:\n  contents: read\nenv:\n  id-token: [REDACTED]",
  );
  // Under a nested key of the permissions mapping, not directly under it.
  const nested = "permissions:\n  nested:\n    id-token: write";
  assert.equal(
    redactSensitiveText(nested),
    "permissions:\n  nested:\n    id-token: [REDACTED]",
  );
});

test("redactSensitiveText redacts non-bare id-token permission forms (#55)", () => {
  // `read` was never approved for preservation.
  assert.equal(
    redactSensitiveText("permissions:\n  id-token: read"),
    "permissions:\n  id-token: [REDACTED]",
  );
  // Quoted values are not bare.
  assert.equal(
    redactSensitiveText('permissions:\n  id-token: "write"'),
    'permissions:\n  id-token: "[REDACTED]"',
  );
  assert.equal(
    redactSensitiveText("permissions:\n  id-token: 'write'"),
    "permissions:\n  id-token: '[REDACTED]'",
  );
  // Inline/flow mappings and list items are not bare block-YAML lines.
  assert.equal(
    redactSensitiveText("permissions: { id-token: write }"),
    "permissions: { id-token: [REDACTED] }",
  );
  assert.equal(
    redactSensitiveText("permissions:\n  - id-token: write"),
    "permissions:\n  - id-token: [REDACTED]",
  );
  // Case is exact: only lowercase `write` is the permission level.
  assert.equal(
    redactSensitiveText("permissions:\n  id-token: Write"),
    "permissions:\n  id-token: [REDACTED]",
  );
  // A same-line scalar continuation is not the bare permission level.
  assert.equal(
    redactSensitiveText("permissions:\n  id-token: write extra"),
    "permissions:\n  id-token: [REDACTED] extra",
  );
  // Key case is exact too: only lowercase `id-token` is the documented form.
  assert.equal(
    redactSensitiveText("permissions:\n  ID-TOKEN: write"),
    "permissions:\n  ID-TOKEN: [REDACTED]",
  );
});

test("redactSensitiveText still redacts credential-bearing id-token and token assignments (#55 controls)", () => {
  // A real provider token assigned to id-token.
  assert.equal(
    redactSensitiveText("id-token: ghp_abcdefghijklmnopqrstuvwxyz1234567890"),
    "id-token: [REDACTED]",
  );
  // An opaque non-permission-level value under id-token (e.g. a raw credential).
  assert.equal(
    redactSensitiveText("id-token: 4f8a2b9c1d3e5f7a8b0c2d4e6f8a0b1c"),
    "id-token: [REDACTED]",
  );
  // A JWT assigned to id-token.
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");
  assert.equal(redactSensitiveText(`id-token: ${jwt}`), "id-token: [REDACTED]");
  // No general `write` bypass for other sensitive keys.
  assert.equal(redactSensitiveText("token: write"), "token: [REDACTED]");
  assert.equal(redactSensitiveText("password=write"), "password=[REDACTED]");
  assert.equal(redactSensitiveText("access_token=write"), "access_token=[REDACTED]");
  // No broad id-token exemption: longer keys containing the run still redact.
  assert.equal(redactSensitiveText("my-id-token: write"), "my-id-token: [REDACTED]");
  // Value suffixes are not bare permission levels.
  assert.equal(redactSensitiveText("id-token: write-secret"), "id-token: [REDACTED]");
  // List-form values are not bare permission levels and remain redacted
  // (residual false positive; the trailing bracket is pre-existing value-shape behavior).
  assert.equal(redactSensitiveText("id-token: [read]"), "id-token: [REDACTED]]");
});

test("redactSensitiveText keeps the id-token context scan bounded on large text (#55)", () => {
  // Hundreds of sibling lines above a candidate: no enclosing permissions
  // mapping, so the value still redacts (and the scan stays bounded).
  const decoyLines = ["env:"];
  for (let i = 0; i < 400; i++) decoyLines.push(`    filler${i}: value-${i}`);
  decoyLines.push("    id-token: write");
  assert.equal(
    redactSensitiveText(decoyLines.join("\n")),
    decoyLines.map((line) => (line === "    id-token: write" ? "    id-token: [REDACTED]" : line)).join("\n"),
  );
});

test("redactSensitiveText idempotence holds across the id-token exception (#55)", () => {
  const preserved = "permissions:\n  id-token: write";
  assert.equal(redactSensitiveText(redactSensitiveText(preserved)), preserved);
  const redacted = redactSensitiveText("id-token: 4f8a2b9c1d3e5f7a8b0c2d4e6f8a0b1c");
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("browser form values are structurally redacted regardless of content", () => {
  for (const [tool, field, value] of [
    ["BrowserFill", "value", "ordinary prose"],
    ["BrowserType", "text", "password=hunter2"],
    ["BrowserType", "text", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
    ["BrowserSelect", "values", ["private selection", "token-value"]],
  ] as const) {
    const redacted = redactBrowserToolInput(tool, { session: "safe", [field]: value, failure: "bounded" });
    const encoded = JSON.stringify(redacted);
    for (const raw of Array.isArray(value) ? value : [value]) assert.equal(encoded.includes(raw), false);
    assert.match(encoded, /\[REDACTED\]/);
    assert.match(encoded, /bounded/);
  }
});

test("redactSensitiveValue redacts sensitive keys recursively", () => {
  assert.deepEqual(redactSensitiveValue({ env: { TOKEN: "value", safe: "visible" } }), {
    env: { TOKEN: "[REDACTED]", safe: "visible" },
  });
});
