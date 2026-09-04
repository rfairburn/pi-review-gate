import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserConfirmationPermits,
  BrowserConsequencePolicy,
  type BrowserConfirmationBinding,
  type BrowserTargetStructure,
} from "../src/web/browser-interaction-policy";

const baseTarget: BrowserTargetStructure = {
  tagName: "button",
  role: "button",
  href: null,
  target: null,
  download: false,
  inputType: "button",
  formAssociated: false,
  formAction: null,
  formMethod: null,
  ariaHasPopup: null,
  contentEditable: false,
  disabled: false,
  inlineEventHandler: false,
  summaryForDetails: false,
  domPath: "html:nth-of-type(1)> body:nth-of-type(1)> button:nth-of-type(1)",
};

test("structural consequence policy permits only proven navigation and native disclosure", () => {
  const policy = new BrowserConsequencePolicy();
  assert.deepEqual(policy.classify({
    ...baseTarget,
    tagName: "a",
    role: "link",
    href: "https://example.com/next?secret=internal",
    inputType: null,
  }), {
    consequence: "ordinary_navigation",
    consequential: false,
    destination: "https://example.com/next?secret=internal",
  });
  assert.equal(policy.classify({
    ...baseTarget,
    tagName: "summary",
    role: null,
    inputType: null,
    summaryForDetails: true,
  }).consequence, "local_disclosure");

  assert.equal(policy.classify(baseTarget).consequence, "unknown_or_mixed", "an ordinary-looking button is unknown");
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com", inputType: null, inlineEventHandler: true }).consequential, true);
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/logout", inputType: null }).consequence, "authentication");
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/delete", inputType: null }).consequence, "destructive");
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/new", target: "_blank", inputType: null }).consequential, true);
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/file", inputType: null, download: true }).consequence, "download");
  assert.equal(policy.classify({ ...baseTarget, inputType: "submit", formAssociated: true, formAction: "https://example.com/checkout" }).consequence, "purchase");
  assert.equal(policy.classify({ ...baseTarget, inputType: "submit", formAssociated: true, formAction: "https://example.com/delete" }).consequence, "destructive");
});

test("confirmation permits bind every action field, expire absolutely, and cannot replay", () => {
  let now = 1_000;
  let serial = 0;
  const permits = new BrowserConfirmationPermits(() => now, () => `permit-${++serial}`, 500);
  const binding: BrowserConfirmationBinding = {
    session: "session",
    tab: "tab",
    generation: "generation",
    operation: "click",
    ref: "ref",
    origin: "https://example.com/private?token=one",
    destination: null,
    targetFingerprint: "fingerprint",
    consequence: "unknown_or_mixed",
  };

  const mismatch = permits.issue(binding);
  assert.equal(permits.consume(mismatch, { ...binding, generation: "changed" }), false);
  assert.equal(permits.consume(mismatch, binding), false, "a mismatch consumes the permit");

  const success = permits.issue(binding);
  assert.equal(permits.consume(success, binding), true);
  assert.equal(permits.consume(success, binding), false, "successful permits are single-use");

  const expired = permits.issue(binding);
  now = expired.expiresAt;
  assert.equal(permits.consume(expired, binding), false);
});
