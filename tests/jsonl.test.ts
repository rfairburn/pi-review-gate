import assert from "node:assert/strict";
import test from "node:test";
import { BoundedJsonlDecoder, BoundedTextAccumulator, utf8Prefix } from "../src/jsonl";

test("BoundedJsonlDecoder handles split CRLF records", () => {
  const records: string[] = [];
  const decoder = new BoundedJsonlDecoder((record) => records.push(record), 100);
  decoder.push('{"a":1}\r');
  decoder.push('\n{"b":');
  decoder.push('2}\n');
  assert.deepEqual(decoder.finish(), { oversizedRecords: 0 });
  assert.deepEqual(records, ['{"a":1}', '{"b":2}']);
});

test("BoundedJsonlDecoder drops an oversized unterminated record and resumes", () => {
  const records: string[] = [];
  const decoder = new BoundedJsonlDecoder((record) => records.push(record), 8);
  decoder.push("12345678");
  decoder.push("9 still oversized");
  decoder.push("\n{\"x\":1}\n");
  assert.deepEqual(decoder.finish(), { oversizedRecords: 1 });
  assert.deepEqual(records, ['{"x":1}']);
});

test("BoundedTextAccumulator caps repeated deltas on a UTF-8 boundary", () => {
  const accumulator = new BoundedTextAccumulator(6);
  accumulator.append("ab");
  accumulator.append("🙂🙂");
  accumulator.append("ignored");
  assert.equal(accumulator.value, "ab🙂");
  assert.equal(Buffer.byteLength(accumulator.value), 6);
  assert.equal(utf8Prefix("🙂x", 4), "🙂");
});
