import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserConfirmationPermits,
  BrowserConsequencePolicy,
  isCredentialFieldTarget,
  modelActionRequiresCredentialEntry,
  modelActionSubmitsCredentialForm,
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

// Issue #27 model credential capability predicates: structural, value-free,
// and scoped to entry/activation so ordinary forms stay unaffected.
test("credential field detection is structural and never reads values", () => {
  const editable: BrowserTargetStructure = {
    ...baseTarget, tagName: "input", role: "textbox", inputType: "text",
    formAssociated: true, autocomplete: null,
  };
  assert.equal(isCredentialFieldTarget({ ...editable, inputType: "password" }), true);
  assert.equal(isCredentialFieldTarget({ ...editable, autocomplete: "current-password" }), true);
  assert.equal(isCredentialFieldTarget({ ...editable, autocomplete: "new-password" }), true);
  // Tokens are matched case-insensitively within space-separated lists.
  assert.equal(isCredentialFieldTarget({ ...editable, autocomplete: "  NEW-PASSWORD username " }), true);
  assert.equal(isCredentialFieldTarget({ ...editable, autocomplete: "username" }), false);
  assert.equal(isCredentialFieldTarget({ ...editable, autocomplete: "one-time-code" }), false);
  assert.equal(isCredentialFieldTarget({ ...editable, autocomplete: null }), false);
});

test("credential entry gate covers value entry only, never activation", () => {
  const password: BrowserTargetStructure = {
    ...baseTarget, tagName: "input", role: "textbox", inputType: "password",
    formAssociated: true, autocomplete: null, formHasCredentialField: true,
  };
  assert.equal(modelActionRequiresCredentialEntry("fill", undefined, password), true);
  assert.equal(modelActionRequiresCredentialEntry("type", undefined, password), true);
  // Non-activation keys type characters into the credential field.
  assert.equal(modelActionRequiresCredentialEntry("press", "a", password), true);
  assert.equal(modelActionRequiresCredentialEntry("press", "ArrowDown", password), true);
  assert.equal(modelActionRequiresCredentialEntry("press", "Space", password), true, "space in a text control types a character");
  // Activation keys are the submission gate's domain.
  assert.equal(modelActionRequiresCredentialEntry("press", "Enter", password), false);
  const submit: BrowserTargetStructure = {
    ...baseTarget, tagName: "button", role: "button", inputType: "submit",
    formAssociated: true, autocomplete: null, formHasCredentialField: true,
  };
  assert.equal(modelActionRequiresCredentialEntry("press", "Space", submit), false);
  // Click and select never enter field values.
  assert.equal(modelActionRequiresCredentialEntry("click", undefined, password), false);
  assert.equal(modelActionRequiresCredentialEntry("select", undefined, password), false);
  // Ordinary fields are outside the entry gate even in credential forms.
  const ordinary: BrowserTargetStructure = {
    ...baseTarget, tagName: "input", role: "textbox", inputType: "text",
    formAssociated: true, autocomplete: null, formHasCredentialField: true,
  };
  assert.equal(modelActionRequiresCredentialEntry("fill", undefined, ordinary), false);
  assert.equal(modelActionRequiresCredentialEntry("press", "a", ordinary), false);
});

test("credential submission gate covers real activations of credential forms only", () => {
  const submit: BrowserTargetStructure = {
    ...baseTarget, tagName: "button", role: "button", inputType: "submit",
    formAssociated: true, autocomplete: null, formHasCredentialField: true,
  };
  assert.equal(modelActionSubmitsCredentialForm("click", undefined, submit), true);
  assert.equal(modelActionSubmitsCredentialForm("press", "Enter", submit), true);
  assert.equal(modelActionSubmitsCredentialForm("press", "Space", submit), true);
  // Non-credential forms are never gated: the toggle cannot deny ordinary forms.
  const plainSubmit = { ...submit, formHasCredentialField: false };
  assert.equal(modelActionSubmitsCredentialForm("click", undefined, plainSubmit), false);
  assert.equal(modelActionSubmitsCredentialForm("press", "Enter", plainSubmit), false);
  // type=button is not a submit control.
  const cancelButton = { ...submit, inputType: "button" };
  assert.equal(modelActionSubmitsCredentialForm("click", undefined, cancelButton), false);
  // Invalid button type values are still submit buttons in browsers.
  assert.equal(modelActionSubmitsCredentialForm("click", undefined, { ...submit, inputType: "foo" }), true);
  // Activation press in a credential form context (implicit submission).
  const field: BrowserTargetStructure = {
    ...baseTarget, tagName: "input", role: "textbox", inputType: "text",
    formAssociated: true, autocomplete: null, formHasCredentialField: true,
  };
  assert.equal(modelActionSubmitsCredentialForm("press", "Enter", field), true);
  assert.equal(modelActionSubmitsCredentialForm("press", "a", field), false);
  // A non-form control never submits a form.
  const link: BrowserTargetStructure = {
    ...baseTarget, tagName: "a", role: "link", href: "https://example.com/",
    inputType: null, formAssociated: false, formHasCredentialField: true,
  };
  assert.equal(modelActionSubmitsCredentialForm("click", undefined, link), false);
  // Activation on a proven credential control is gated even when the owning
  // form's credential membership was not proven from descendant structure.
  const orphanPassword = { ...field, inputType: "password", formHasCredentialField: false };
  assert.equal(modelActionSubmitsCredentialForm("press", "Enter", orphanPassword), true);
  // Filling and selecting never submit.
  assert.equal(modelActionSubmitsCredentialForm("fill", undefined, field), false);
  assert.equal(modelActionSubmitsCredentialForm("select", undefined, field), false);
});
