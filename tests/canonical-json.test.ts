import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStableJson } from "../src/canonical-json";

// Golden byte vectors pin the exact shared serialization contract (sidecar
// integrity, config and reviewer-selection digests, reviewer and executor
// fingerprints, checkpoint
// descriptor identity). The expected values are hand-written literals, not
// the output of a serializer copy.

test("canonicalStableJson serializes empty containers", () => {
  assert.equal(canonicalStableJson({}), "{}");
  assert.equal(canonicalStableJson([]), "[]");
});

test("canonicalStableJson serializes primitives and unrepresentable values", () => {
  assert.equal(canonicalStableJson(null), "null");
  // JSON.stringify returns undefined for these; the serializer maps that to
  // "null" (existing contract, preserved).
  assert.equal(canonicalStableJson(undefined), "null");
  assert.equal(canonicalStableJson(true), "true");
  assert.equal(canonicalStableJson(false), "false");
  assert.equal(canonicalStableJson(42), "42");
  assert.equal(canonicalStableJson(-3.5), "-3.5");
  assert.equal(canonicalStableJson(-0), "0");
  assert.equal(canonicalStableJson(NaN), "null");
  assert.equal(canonicalStableJson(Infinity), "null");
  assert.equal(canonicalStableJson("text"), `"text"`);
  assert.throws(() => canonicalStableJson(1n), TypeError);
});

test("canonicalStableJson escapes strings exactly as JSON.stringify", () => {
  assert.equal(canonicalStableJson({ s: 'a"b\\c\nd' }), '{"s":"a\\"b\\\\c\\nd"}');
  // Non-ASCII characters pass through unescaped.
  assert.equal(canonicalStableJson({ u: "héllo" }), '{"u":"héllo"}');
});

test("canonicalStableJson sorts object keys by UTF-16 code units", () => {
  // Uppercase letters sort before lowercase under the default sort.
  assert.equal(canonicalStableJson({ a: 1, B: 2, Z: 3 }), '{"B":2,"Z":3,"a":1}');
  assert.equal(canonicalStableJson({ "2": "two", "10": "ten" }), '{"10":"ten","2":"two"}');
});

test("canonicalStableJson recurses into nested objects and preserves array order", () => {
  // undefined object properties and array elements serialize as explicit
  // "null" entries; they are not omitted.
  assert.equal(
    canonicalStableJson({ b: 1, a: [null, { d: "x", c: true }, undefined], z: undefined }),
    '{"a":[null,{"c":true,"d":"x"},null],"b":1,"z":null}',
  );
  assert.equal(canonicalStableJson([[1, 2], [3]]), "[[1,2],[3]]");
});

test("canonicalStableJson retains historical sparse-array bytes without filling holes", () => {
  const sparse = new Array<unknown>(3);
  sparse[1] = undefined;
  assert.equal(canonicalStableJson(sparse), "[,null,]");
});
