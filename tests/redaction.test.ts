import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText, redactSensitiveValue } from "../src/redaction";

test("redactSensitiveText removes common credentials while retaining context", () => {
  const text = "Authorization: Bearer abcdefghijklmnop api_key=sk-abcdefghijklmnop";
  const redacted = redactSensitiveText(text);
  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.match(redacted, /Authorization:/);
  assert.match(redacted, /api_key=/);
});

test("redactSensitiveValue redacts sensitive keys recursively", () => {
  assert.deepEqual(redactSensitiveValue({ env: { TOKEN: "value", safe: "visible" } }), {
    env: { TOKEN: "[REDACTED]", safe: "visible" },
  });
});
