import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { DeferredToolManager } from "../src/deferred-tools";
import { isRecord as evidenceIsRecord } from "../src/execution/evidence/parsers";
import { isRecord } from "../src/record-guard";
import { redactBrowserToolInput, redactSensitiveValue } from "../src/redaction";
import { normalizeReviewResult } from "../src/schema";
import { parseHello, PROTOCOL_VERSION } from "../src/session-host/protocol";
import { registerReviewSettings } from "../src/settings/command";
import { scopedModelChoices } from "../src/settings/models";

// Issue #241: the strict unknown-valued record guard is one shared helper. These
// tests pin its truth table and characterize representative production callers
// (strict adopters and the intentionally untouched permissive guards) so the
// consolidation stays behavior-preserving.

class Plain {
  readonly field = "value";
}

/** An array that also carries record-looking own properties. */
function propertyArray<T extends Record<string, unknown>>(properties: T): unknown[] & T {
  return Object.assign([] as unknown[], properties);
}

function nullPrototype<T extends Record<string, unknown>>(properties: T): T {
  return Object.assign(Object.create(null) as T, properties);
}

test("record-guard rejects only non-objects, null, and arrays (#241)", () => {
  const rejected: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["string", "text"],
    ["number", 1],
    ["bigint", 1n],
    ["boolean", true],
    ["symbol", Symbol("record")],
    ["function", () => undefined],
    ["empty array", []],
    ["array of records", [{ key: "value" }]],
    ["property-carrying array", propertyArray({ version: 1, type: "hello" })],
  ];
  for (const [label, value] of rejected) {
    assert.equal(isRecord(value), false, `${label} is not a record`);
  }

  const accepted: Array<[string, unknown]> = [
    ["plain object", { key: "value" }],
    ["empty plain object", {}],
    ["null-prototype object", nullPrototype({ key: "value" })],
    ["Date", new Date(0)],
    ["Buffer", Buffer.from("ab")],
    ["Map", new Map([["key", "value"]])],
    ["class instance", new Plain()],
    ["Error", new Error("boom")],
    ["boxed string", Object("text")],
  ];
  for (const [label, value] of accepted) {
    assert.equal(isRecord(value), true, `${label} is accepted as a record`);
  }
});

test("the exported evidence isRecord remains the shared implementation (#241)", () => {
  assert.equal(evidenceIsRecord, isRecord);
});

test("redaction keeps strict record traversal for null, arrays, and non-plain objects (#241)", () => {
  assert.deepEqual(
    redactSensitiveValue(nullPrototype({ password: "hunter2", note: "ok" })),
    { password: "[REDACTED]", note: "ok" },
  );
  // Non-plain objects are records: only their own enumerable entries survive.
  assert.deepEqual(redactSensitiveValue(new Date(0)), {});
  assert.deepEqual(redactSensitiveValue(Buffer.from("ab")), { 0: 97, 1: 98 });
  assert.equal(redactSensitiveValue(null), null);

  // Browser fill input: a record has its secret field redacted; a
  // property-carrying array is not a record and is mapped as an array.
  assert.deepEqual(
    redactBrowserToolInput("BrowserFill", { selector: "#pw", value: "hunter2" }),
    { selector: "#pw", value: "[REDACTED]" },
  );
  const arrayInput = propertyArray({ value: "hunter2" });
  arrayInput.push("visible");
  assert.deepEqual(redactBrowserToolInput("BrowserFill", arrayInput), ["visible"]);
  assert.deepEqual(
    redactBrowserToolInput("BrowserFill", nullPrototype({ value: "hunter2" })),
    { value: "[REDACTED]" },
  );
});

test("reviewer result validation keeps its strict object answers (#241)", () => {
  const valid = { verdict: "pass", summary: "Looks good.", findings: [] };
  assert.equal(normalizeReviewResult("r", valid).verdict, "pass");
  assert.equal(normalizeReviewResult("r", nullPrototype(valid)).verdict, "pass");

  const notObject = "Reviewer JSON must be an object.";
  for (const value of [null, [], propertyArray(valid), "pass"]) {
    const result = normalizeReviewResult("r", value);
    assert.equal(result.error, "schema_error");
    assert.equal(result.summary, notObject);
  }
  // A non-plain object passes the shape guard and is judged on its fields.
  const dated = normalizeReviewResult("r", new Date(0));
  assert.equal(dated.error, "schema_error");
  assert.equal(dated.summary, "Reviewer JSON contains missing or unsupported fields.");

  const findingArray = normalizeReviewResult("r", { ...valid, verdict: "needs_changes", findings: [propertyArray({ severity: "blocking" })] });
  assert.equal(findingArray.summary, "Each finding must be an object.");
});

test("config normalization keeps its strict top-level object requirement (#241)", () => {
  assert.throws(() => normalizeConfig(null), /review gate config must be a JSON object/);
  assert.throws(() => normalizeConfig(propertyArray({ enabled: true })), /review gate config must be a JSON object/);
  assert.equal(normalizeConfig(nullPrototype({ enabled: false })).enabled, false);
});

test("session-host hello parsing keeps strict frame shape answers (#241)", () => {
  const frame = {
    version: PROTOCOL_VERSION,
    type: "hello",
    instanceId: "0123abcd",
    generation: "4567ef",
    token: "a".repeat(64),
  };
  assert.deepEqual(parseHello(frame), frame);
  assert.deepEqual(parseHello(nullPrototype(frame)), frame);
  assert.equal(parseHello(propertyArray(frame)), undefined);
  assert.equal(parseHello(null), undefined);
  // A non-plain carrier passes the shape guard; its fields decide validity.
  assert.deepEqual(parseHello(Object.assign(new Plain(), frame)), frame);
});

// ── Permissive guards stay permissive (left untouched by #241) ──────────────

function deferredHost(toolSearch: unknown) {
  const definitions: unknown[] = [{ name: "read", description: "Read a file.", parameters: { type: "object" } }, toolSearch];
  let active = ["read"];
  return {
    definitions,
    pi: {
      registerTool(definition: { name: string }) {
        const existing = definitions.findIndex((candidate) => (candidate as { name?: unknown }).name === definition.name);
        if (existing >= 0) definitions.splice(existing, 1, definition);
        else definitions.push(definition);
        if (!active.includes(definition.name)) active.push(definition.name);
      },
      getActiveTools: () => [...active],
      getAllTools: () => [...definitions],
      setActiveTools(names: string[]) { active = [...names]; },
    },
    descriptor: () => definitions.find((candidate) =>
      (candidate as { name?: unknown }).name === "tool_search" && (candidate as { description?: unknown }).description !== "native builtin",
    ) as { parameters?: unknown } | undefined,
  };
}

test("deferred native tool_search schema keeps array catalog choice and fall-through (#241)", async () => {
  // An array-valued registry parameters schema is still chosen by reference.
  const arrayParameters = propertyArray({ type: "object", properties: { query: { type: "string" } } });
  const arraySchema = deferredHost({ name: "tool_search", description: "native builtin", parameters: arrayParameters });
  assert.equal(await new DeferredToolManager(arraySchema.pi).registerWithNativeSchema(), true);
  assert.equal(arraySchema.descriptor()?.parameters, arrayParameters);

  // An array-valued registry entry is still a catalog entry.
  const entryParameters = { type: "object", properties: { query: { type: "string" } } };
  const arrayEntry = deferredHost(propertyArray({ name: "tool_search", description: "native builtin", parameters: entryParameters }));
  assert.equal(await new DeferredToolManager(arrayEntry.pi).registerWithNativeSchema(), true);
  assert.equal(arrayEntry.descriptor()?.parameters, entryParameters);

  // A non-object schema still falls through; no running host resolves here,
  // so the local fallback schema is registered.
  const primitive = deferredHost({ name: "tool_search", description: "native builtin", parameters: "not-a-schema" });
  assert.equal(await new DeferredToolManager(primitive.pi).registerWithNativeSchema(), true);
  const fallback = primitive.descriptor()?.parameters as { properties?: Record<string, unknown> } | undefined;
  assert.ok(fallback?.properties?.query, "the local fallback schema is registered");
});

test("/review-settings still recognizes an array-valued UI context (#241)", async () => {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  registerReviewSettings({
    pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      if (name === "review-settings") handler = options.handler;
    } },
    config: normalizeConfig({}),
  });
  assert.ok(handler);

  const notifications: Array<{ message: string; type?: string }> = [];
  let selectCalls = 0;
  const arrayUi = propertyArray({
    async select() { selectCalls += 1; return undefined; },
    notify(message: string, type?: string) { notifications.push({ message, type }); },
  });
  await handler("", propertyArray({ scopedModels: [], ui: arrayUi }));
  assert.equal(selectCalls, 0);
  assert.deepEqual(notifications, [{ message: "No persistent review-gate config file is loaded.", type: "error" }]);
});

test("settings scoped model choices keep array-valued contexts and thinking maps (#241)", () => {
  const model = propertyArray({
    provider: "acme",
    id: "deep",
    reasoning: true,
    thinkingLevelMap: propertyArray({ xhigh: "x-high", minimal: null }),
  });
  const ctx = propertyArray({ scopedModels: [propertyArray({ model, thinkingLevel: "high" })] });
  const choices = scopedModelChoices(ctx);
  assert.ok(choices);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.model, "acme/deep");
  assert.equal(choices[0]!.pinnedThinkingLevel, "high");
  assert.ok(choices[0]!.supportedThinkingLevels.includes("xhigh"), "array thinking map entries still count");
  assert.ok(!choices[0]!.supportedThinkingLevels.includes("minimal"), "array thinking map null entries still exclude");
  assert.equal(scopedModelChoices(null), undefined);
});
