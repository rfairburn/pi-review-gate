/**
 * Issue #577: review-policy entries use the same non-negative safe-integer
 * boundary as strict configuration normalization.
 *
 * These cases drive the actual selectReviewPolicy loop through its public
 * non-TUI select/editor seam, not a copied predicate or a whole menu mock.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { selectReviewPolicy } from "../src/settings/controls";
import type { UiContext } from "../src/settings/ui";

const INITIAL_POLICY = { maxCorrectionCycles: 3, guidanceThreshold: 2 };
const INVALID_NOTICE = "Enter a non-negative whole number.";

interface PolicyField {
  readonly row: string;
  readonly title: string;
  readonly property: keyof typeof INITIAL_POLICY;
}

const POLICY_FIELDS: readonly PolicyField[] = [
  {
    row: "Automatic correction attempts",
    title: "Automatic correction attempts",
    property: "maxCorrectionCycles",
  },
  {
    row: "Concrete guidance after",
    title: "Concrete guidance after correction attempts",
    property: "guidanceThreshold",
  },
];

interface ReviewPolicyHarness {
  ui: UiContext;
  selectSteps: readonly (string | undefined)[];
  editorSteps: readonly (string | undefined)[];
  selectIndex: number;
  editorIndex: number;
  selectCalls: Array<{ title: string; options: string[] }>;
  editorCalls: Array<{ title: string; prefill?: string }>;
  notices: Array<{ message: string; type?: "info" | "warning" | "error" }>;
}

function makeHarness(
  selectSteps: readonly (string | undefined)[],
  editorSteps: readonly (string | undefined)[],
): ReviewPolicyHarness {
  const harness: ReviewPolicyHarness = {
    ui: undefined as unknown as UiContext,
    selectSteps,
    editorSteps,
    selectIndex: 0,
    editorIndex: 0,
    selectCalls: [],
    editorCalls: [],
    notices: [],
  };
  harness.ui = {
    async select(title, options) {
      harness.selectCalls.push({ title, options });
      const step = selectSteps[harness.selectIndex++];
      if (step === undefined) return undefined;
      const selected = options.find((option) => option === step || option.startsWith(step));
      assert.ok(selected, `scripted selection ${JSON.stringify(step)} not found in ${options.join(" | ")}`);
      return selected;
    },
    async editor(title, prefill) {
      harness.editorCalls.push({ title, prefill });
      return editorSteps[harness.editorIndex++];
    },
    notify(message, type) {
      harness.notices.push({ message, type });
    },
  };
  return harness;
}

async function runPolicy(
  selectSteps: readonly (string | undefined)[],
  editorSteps: readonly (string | undefined)[],
): Promise<{ result: typeof INITIAL_POLICY; harness: ReviewPolicyHarness }> {
  const harness = makeHarness(selectSteps, editorSteps);
  const result = await selectReviewPolicy(
    harness.ui,
    INITIAL_POLICY.maxCorrectionCycles,
    INITIAL_POLICY.guidanceThreshold,
  );
  assert.equal(harness.selectIndex, selectSteps.length, "every scripted selection was consumed");
  assert.equal(harness.editorIndex, editorSteps.length, "every scripted editor result was consumed");
  return { result, harness };
}

function expectedPolicy(field: PolicyField, value: number): typeof INITIAL_POLICY {
  return { ...INITIAL_POLICY, [field.property]: value };
}

function oldEditorCall(field: PolicyField): { title: string; prefill: string } {
  return { title: field.title, prefill: String(INITIAL_POLICY[field.property]) };
}

for (const field of POLICY_FIELDS) {
  for (const unsafe of [1e20, 2 ** 53]) {
    test(`review policy ${field.row} refuses unsafe ${String(unsafe)} and later accepts a safe edit`, async () => {
      const { result, harness } = await runPolicy(
        [field.row, field.row, "Back"],
        [String(unsafe), "5"],
      );

      assert.deepEqual(result, expectedPolicy(field, 5));
      assert.deepEqual(harness.notices, [{ message: INVALID_NOTICE, type: "error" }]);
      assert.deepEqual(
        harness.editorCalls,
        [oldEditorCall(field), oldEditorCall(field)],
        "both edits prefilled the unchanged old value; only the later safe edit was staged",
      );
    });
  }
}

const ACCEPTED_ENTRIES = [
  { label: "zero", entered: "0", expected: 0 },
  { label: "an ordinary safe integer", entered: "7", expected: 7 },
  { label: "MAX_SAFE_INTEGER", entered: String(Number.MAX_SAFE_INTEGER), expected: Number.MAX_SAFE_INTEGER },
  { label: "the existing hexadecimal grammar", entered: "0x10", expected: 16 },
  { label: "the existing exponent grammar", entered: "1e3", expected: 1000 },
];

for (const field of POLICY_FIELDS) {
  for (const accepted of ACCEPTED_ENTRIES) {
    test(`review policy ${field.row} accepts ${accepted.label}`, async () => {
      const { result, harness } = await runPolicy([field.row, "Back"], [accepted.entered]);

      assert.deepEqual(result, expectedPolicy(field, accepted.expected));
      assert.deepEqual(harness.notices, []);
      assert.deepEqual(harness.editorCalls, [oldEditorCall(field)]);
    });
  }
}

for (const field of POLICY_FIELDS) {
  for (const invalid of [-1, 1.5]) {
    test(`review policy ${field.row} refuses ${String(invalid)} and keeps the old value`, async () => {
      const { result, harness } = await runPolicy([field.row, "Back"], [String(invalid)]);

      assert.deepEqual(result, INITIAL_POLICY);
      assert.deepEqual(harness.notices, [{ message: INVALID_NOTICE, type: "error" }]);
      assert.deepEqual(harness.editorCalls, [oldEditorCall(field)]);
    });
  }
}

for (const field of POLICY_FIELDS) {
  test(`review policy ${field.row} keeps the old value when its editor cancels`, async () => {
    const { result, harness } = await runPolicy([field.row, "Back"], [undefined]);

    assert.deepEqual(result, INITIAL_POLICY);
    assert.deepEqual(harness.notices, []);
    assert.deepEqual(harness.editorCalls, [oldEditorCall(field)]);
  });

  for (const blank of ["", " \t\n"]) {
    test(`review policy ${field.row} accepts blank/whitespace ${JSON.stringify(blank)} as zero`, async () => {
      const { result, harness } = await runPolicy([field.row, "Back"], [blank]);

      assert.deepEqual(result, expectedPolicy(field, 0));
      assert.deepEqual(harness.notices, []);
      assert.deepEqual(harness.editorCalls, [oldEditorCall(field)]);
    });
  }
}

test("review policy menu cancellation returns both staged values unchanged", async () => {
  const { result, harness } = await runPolicy([undefined], []);

  assert.deepEqual(result, INITIAL_POLICY);
  assert.deepEqual(harness.notices, []);
  assert.deepEqual(harness.editorCalls, []);
});
