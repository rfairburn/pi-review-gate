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

test("structural consequence policy permits proven navigation but authorizes eventful disclosure", () => {
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
  assert.equal(policy.classify({ ...baseTarget, tagName: "summary", role: null, inputType: null, summaryForDetails: true }).consequential, true,
    "native toggle events are not proof of effect-free disclosure");

  assert.equal(policy.classify(baseTarget).consequence, "unknown_or_mixed", "an ordinary-looking button is unknown");
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com", inputType: null, inlineEventHandler: true }).consequential, true);
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/logout", inputType: null }).consequence, "authentication");
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/delete", inputType: null }).consequence, "destructive");
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/new", target: "_blank", inputType: null }).consequential, true);
  assert.equal(policy.classify({ ...baseTarget, tagName: "a", role: "link", href: "https://example.com/file", inputType: null, download: true }).consequence, "download");
  assert.equal(policy.classify({ ...baseTarget, inputType: "submit", formAssociated: true, formAction: "https://example.com/checkout" }).consequence, "purchase");
  assert.equal(policy.classify({ ...baseTarget, inputType: "submit", formAssociated: true, formAction: "https://example.com/delete" }).consequence, "destructive");
});

test("form consequence policy proves only ordinary local editing and fails risky structure closed", () => {
  const policy = new BrowserConsequencePolicy();
  const editable: BrowserTargetStructure = {
    ...baseTarget,
    tagName: "input",
    role: "textbox",
    inputType: "text",
    formAssociated: true,
    autocomplete: null,
    readOnly: false,
    multiple: false,
    explicitChangeHandler: false,
    explicitSubmitHandler: false,
    pageControlledEventsAbsent: true,
  };
  assert.deepEqual(policy.classifyForm(editable, { operation: "fill" }), {
    consequence: "local_editing", consequential: false, destination: null,
  });
  assert.equal(policy.classifyForm({ ...editable, autocomplete: "email" }, { operation: "type" }).consequence, "sensitive_input");
  assert.equal(policy.classifyForm({ ...editable, autocomplete: "current-password" }, { operation: "fill" }).consequence, "authentication");
  assert.equal(policy.classifyForm({ ...editable, explicitChangeHandler: true }, { operation: "fill" }).consequence, "autosave_or_change");
  assert.equal(policy.classifyForm(editable, { operation: "press", key: "Enter" }).consequence, "form_submission");
  assert.equal(policy.classifyForm({ ...editable, pageControlledEventsAbsent: false }, { operation: "fill" }).consequence, "unknown_or_mixed");
  assert.equal(policy.classifyForm({ ...editable, tagName: "div" }, { operation: "fill" }).consequence, "unknown_or_mixed");
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
    valueDigest: null,
    valueLengths: [],
    key: null,
    button: "left",
  };

  const mismatch = permits.issue(binding);
  assert.equal(permits.consume(mismatch, { ...binding, generation: "changed" }), false);
  assert.equal(permits.consume(mismatch, binding), false, "a mismatch consumes the permit");

  const valueMismatch = permits.issue({
    ...binding, operation: "fill", valueDigest: "first", valueLengths: [5],
  });
  assert.equal(permits.consume(valueMismatch, {
    ...binding, operation: "fill", valueDigest: "second", valueLengths: [6],
  }), false, "exact action value identity is bound without retaining the value");

  const success = permits.issue(binding);
  assert.equal(permits.consume(success, binding), true);
  assert.equal(permits.consume(success, binding), false, "successful permits are single-use");

  const expired = permits.issue(binding);
  now = expired.expiresAt;
  assert.equal(permits.consume(expired, binding), false);
});
