import assert from "node:assert/strict";
import test from "node:test";
import {
  measureToolSchemaBaseline,
  TOOL_SCHEMA_CATEGORIES,
} from "./tool-schema-baseline-helper";

test("test-only tool schema baseline is counts-only, conservative, and category-bounded", () => {
  const secretMarker = "must-never-be-recorded";
  const baseline = measureToolSchemaBaseline(
    ["read", "WebFetch", "SubtasksStart", "read", "private_extension"],
    [
      { name: "read", description: `read ${secretMarker}`, parameters: { path: { type: "string" } } },
      { name: "WebFetch", description: "fetch", parameters: { url: { type: "string" } } },
      { name: "SubtasksStart", description: "delegate", parameters: { task: { type: "string" } } },
      { name: "private_extension", description: secretMarker, parameters: { secret: { const: secretMarker } } },
    ],
  );

  assert.equal(baseline.activeToolCount, 4);
  assert.ok(baseline.serializedSchemaBytes > 0);
  assert.equal(baseline.estimatedSchemaTokens, Math.ceil(baseline.serializedSchemaBytes / 3));
  assert.deepEqual(Object.keys(baseline.categories), [...TOOL_SCHEMA_CATEGORIES]);
  assert.equal(baseline.categories.core.count, 1);
  assert.equal(baseline.categories.web_research.count, 1);
  assert.equal(baseline.categories.delegated_execution.count, 1);
  assert.equal(baseline.categories.other.count, 1);

  // The helper's return value is safe to inspect in test output: schema text,
  // descriptions, arguments, and names never leave the local measurement.
  assert.equal(JSON.stringify(baseline).includes(secretMarker), false);
  assert.equal(JSON.stringify(baseline).includes("private_extension"), false);
});
