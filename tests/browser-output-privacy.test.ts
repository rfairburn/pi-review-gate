import assert from "node:assert/strict";
import test from "node:test";
import { BrowserOutputPrivacy } from "../src/web/browser-output-privacy";

test("literal privacy protection is bounded, non-evicting and preserves useful capabilities", () => {
  const privacy = new BrowserOutputPrivacy();
  privacy.remember(["customer-marker-742", "Customer Label 915"]);
  const result = privacy.output({
    session: "opaque", tab: "opaque-tab", title: "customer-marker-742", url: "https://example.com/customer-marker-742",
    snapshot: '- textbox "Customer Label 915" [ref=opaque-ref]: customer-marker-742\n- paragraph: Still useful',
    events: [{ text: "later customer-marker-742", failure: "Customer Label 915" }],
  });
  assert.doesNotMatch(JSON.stringify(result), /customer-marker-742|Customer Label 915/);
  assert.match(result.snapshot, /Still useful/);
  assert.match(result.snapshot, /\[ref=opaque-ref\]/);
  assert.equal(result.session, "opaque");
  assert.equal(privacy.output(result).title, result.title, "redaction is idempotent");
  const separate = new BrowserOutputPrivacy();
  assert.equal(separate.text("customer-marker-742"), "customer-marker-742", "registries are not global");
  assert.throws(() => privacy.remember(["x".repeat(BrowserOutputPrivacy.maxChars)]), /capacity exhausted/);
  assert.doesNotMatch(privacy.text("customer-marker-742"), /customer-marker-742/, "overflow never evicts prior values");
  const full = new BrowserOutputPrivacy();
  full.remember(Array.from({ length: BrowserOutputPrivacy.maxValues }, (_, i) => `value-${i}`));
  assert.throws(() => full.remember(["extra"]), /capacity exhausted/);
});

test("short values redact literal text without corrupting snapshot roles or opaque refs", () => {
  const privacy = new BrowserOutputPrivacy();
  privacy.remember(["b"]);
  const snapshot = privacy.output({ snapshot: '- textbox "b" [ref=browser_b]: b\n- paragraph: Fine' }).snapshot;
  assert.match(snapshot, /^- textbox/);
  assert.match(snapshot, /\[ref=browser_b\]/);
  assert.match(snapshot, /paragraph: Fine/);
  assert.doesNotMatch(snapshot, /"b"|: b/);
});
