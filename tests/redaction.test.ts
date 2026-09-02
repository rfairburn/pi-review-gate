import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText, redactSensitiveValue } from "../src/redaction";

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

test("redactSensitiveValue redacts sensitive keys recursively", () => {
  assert.deepEqual(redactSensitiveValue({ env: { TOKEN: "value", safe: "visible" } }), {
    env: { TOKEN: "[REDACTED]", safe: "visible" },
  });
});
