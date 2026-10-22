import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  NATIVE_INPUT_MAX_ENVELOPE_BYTES,
  NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS,
  NATIVE_INPUT_RAW_FRAGMENT_BYTES,
  createNativeInputDecoder,
  createNativeInputEncoder,
  frameNativeInputBody,
  isValidNativeInputOrigin,
  type NativeInputDecoder,
  type NativeInputFailureCode,
  type NativeInputFragment,
  type NativeInputOrigin,
} from "../src/session-host/native-input-origin";
import type { SessionHostBootstrap } from "../src/session-host/protocol";

const bootstrap: SessionHostBootstrap = {
  version: 1,
  instanceId: "11111111-1111-1111-1111-111111111111",
  generation: "22222222-2222-2222-2222-222222222222",
  token: "ab".repeat(32),
  socketPath: "/synthetic/broker.sock",
};

function fragmentsOf(framed: string): string[] {
  return framed.split("\n").filter((frame) => frame.length > 0).map((frame) => `${frame}\n`);
}

function reassemble(fragments: readonly NativeInputFragment[]): Buffer {
  return Buffer.concat(fragments.map((fragment) => fragment.payload));
}

function flipBase64Url(value: string, index: number): string {
  const current = value[index]!;
  return `${value.slice(0, index)}${current === "A" ? "B" : "A"}${value.slice(index + 1)}`;
}

function flipHex(value: string, index: number): string {
  const current = value[index]!;
  return `${value.slice(0, index)}${current === "0" ? "1" : "0"}${value.slice(index + 1)}`;
}

function bodyText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    sequence: 1,
    dispatchId: 1,
    part: 0,
    final: true,
    origin: { kind: "local" },
    encoded: "",
    ...overrides,
  });
}

function frameText(text: string): string {
  return frameNativeInputBody(bootstrap, Buffer.from(text, "utf8").toString("base64url"));
}

function frameBody(overrides: Record<string, unknown> = {}): string {
  return frameText(bodyText(overrides));
}

function expectRefused(input: string, code: NativeInputFailureCode): void {
  const decoder = createNativeInputDecoder(bootstrap);
  const result = decoder.feed(input);
  if (result.ok) assert.fail(`expected ${code}, decoded ${result.fragments.length} fragment(s)`);
  assert.equal(result.code, code);
  assert.deepEqual(result.fragments, []);
  assert.equal(decoder.failureCode, code);
  assert.equal(decoder.bufferedBytes, 0);
  const finished = decoder.finish();
  assert.equal(finished.ok, false);
  assert.equal(decoder.feed(input).fragments.length, 0);
}

test("every origin carries exact payload bytes once, including NUL, controls and framing decoys", () => {
  const payloads: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from("plain ASCII text", "utf8"),
    Buffer.from("snow 雪 e\u0301 🧪 bidi \u202e\u202c done", "utf8"),
    Buffer.from([0x00, 0x01, 0x1b, 0x07, 0x9b, 0x7f, 0x80, 0xff, 0x0a, 0x0d]),
    Buffer.from("\x1b]52;c;QQ==\x07 prg-ni-v1; prg-ni-v1; embedded \x1b[200~paste\x1b[201~", "latin1"),
  ];
  const origins: NativeInputOrigin[] = [
    { kind: "local" },
    { kind: "none" },
    { kind: "viewer", token: "viewer-7f3a9c20" },
    { kind: "viewer", token: "t".repeat(NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS) },
  ];
  for (const origin of origins) {
    for (const payload of payloads) {
      const framed = createNativeInputEncoder(bootstrap).encode(payload, origin);
      const decoder = createNativeInputDecoder(bootstrap);
      const result = decoder.feed(framed);
      assert.equal(result.ok, true);
      assert.equal(result.fragments.length, 1);
      const fragment = result.fragments[0]!;
      assert.deepEqual(fragment.payload, payload);
      assert.deepEqual({ ...fragment.origin }, { ...origin });
      assert.equal(fragment.origin.kind, origin.kind);
      assert.deepEqual(Object.keys(fragment.origin), origin.kind === "viewer" ? ["kind", "token"] : ["kind"]);
      assert.equal(fragment.origin.kind === "viewer", origin.kind === "viewer", "only an explicit viewer origin is viewer");
      assert.equal(fragment.dispatchId, 1);
      assert.equal(fragment.part, 0);
      assert.equal(fragment.start, true);
      assert.equal(fragment.end, true);
      assert.ok(Object.isFrozen(fragment));
      assert.ok(Object.isFrozen(fragment.origin));
      assert.equal(decoder.bufferedBytes, 0);
      assert.equal(decoder.finish().ok, true);
      assert.ok(Buffer.byteLength(framed, "latin1") <= NATIVE_INPUT_MAX_ENVELOPE_BYTES);
    }
  }
});

test("empty dispatches deliver an empty owned payload without inventing input or losing context", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const framed = encoder.encode(Buffer.alloc(0), { kind: "none" });
  const decoder = createNativeInputDecoder(bootstrap);
  const result = decoder.feed(framed);
  assert.equal(result.ok, true);
  assert.equal(result.fragments.length, 1);
  const fragment = result.fragments[0]!;
  assert.equal(fragment.payload.length, 0);
  assert.equal(fragment.start, true);
  assert.equal(fragment.end, true);
  assert.equal(fragment.origin.kind, "none");
  // A later non-empty dispatch keeps the same decoder and monotonic context.
  const next = decoder.feed(encoder.encode(Buffer.from("x", "utf8"), { kind: "local" }));
  assert.equal(next.ok, true);
  assert.equal(next.fragments[0]!.dispatchId, 2);
  assert.equal(next.fragments[0]!.payload.toString("utf8"), "x");
  assert.equal(decoder.finish().ok, true);
});

test("every split boundary and one-byte feeds decode without early or partial delivery", () => {
  const payload = Buffer.from("boundary 雪 🙂 payload", "utf8");
  const framed = createNativeInputEncoder(bootstrap).encode(payload, { kind: "viewer", token: "viewer-boundary" });

  for (const asBuffer of [false, true]) {
    for (let split = 0; split <= framed.length; split += 1) {
      const decoder = createNativeInputDecoder(bootstrap);
      const piece = (value: string): Buffer | string => (asBuffer ? Buffer.from(value, "latin1") : value);
      const first = decoder.feed(piece(framed.slice(0, split)));
      const second = decoder.feed(piece(framed.slice(split)));
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.fragments.length, split === framed.length ? 1 : 0);
      assert.deepEqual(reassemble([...first.fragments, ...second.fragments]), payload);
      assert.equal(decoder.finish().ok, true);
    }
  }

  const decoder = createNativeInputDecoder(bootstrap);
  const collected: NativeInputFragment[] = [];
  for (const character of framed) {
    const result = decoder.feed(character);
    assert.equal(result.ok, true);
    collected.push(...result.fragments);
  }
  assert.deepEqual(reassemble(collected), payload);
});

test("coalesced dispatches keep ordered context and interleaving is rejected", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const first = encoder.encode(Buffer.from("first", "utf8"), { kind: "local" });
  const second = encoder.encode(Buffer.alloc(0), { kind: "none" });
  const third = encoder.encode(Buffer.from("third", "utf8"), { kind: "viewer", token: "viewer-three" });
  const decoder = createNativeInputDecoder(bootstrap);
  const result = decoder.feed(first + second + third);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.fragments.map((fragment) => [
      fragment.dispatchId, fragment.part, fragment.start, fragment.end, fragment.origin.kind,
      fragment.payload.toString("utf8"),
    ]),
    [[1, 0, true, true, "local", "first"], [2, 0, true, true, "none", ""], [3, 0, true, true, "viewer", "third"]],
  );
  assert.equal(result.fragments[2]!.origin.kind, "viewer");
  const viewerFragment = result.fragments[2]!;
  assert.equal(viewerFragment.origin.kind === "viewer" ? viewerFragment.origin.token : "", "viewer-three");

  const opener = createNativeInputEncoder(bootstrap);
  const left = fragmentsOf(opener.encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 8, 1), { kind: "local" }));
  assert.equal(left.length, 2);
  const blocked = createNativeInputDecoder(bootstrap);
  const opened = blocked.feed(left[0]!);
  assert.equal(opened.ok, true);
  assert.equal(opened.fragments.length, 1);
  assert.equal(opened.fragments[0]!.start, true);
  assert.equal(opened.fragments[0]!.end, false);
  // Authentic next sequence, but a second dispatch opens while the first is unfinished.
  const interleaved = blocked.feed(frameBody({ sequence: 2, dispatchId: 2, part: 0, final: true }));
  assert.equal(interleaved.ok, false);
  if (interleaved.ok) assert.fail("interleaved dispatch must be rejected");
  assert.equal(interleaved.code, "invalid-dispatch");
  assert.deepEqual(interleaved.fragments, []);
});

test("payloads beyond 64 KiB use ordered technical fragments with bounded state", () => {
  const payload = Buffer.alloc(200_000);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 37 + 11) % 256;
  const framed = createNativeInputEncoder(bootstrap).encode(payload, { kind: "local" });
  const decoder = createNativeInputDecoder(bootstrap);
  const collected: NativeInputFragment[] = [];
  let maximumBuffered = 0;
  let offset = 0;
  let step = 1;
  while (offset < framed.length) {
    const size = Math.min(framed.length - offset, step);
    const result = decoder.feed(Buffer.from(framed.slice(offset, offset + size), "latin1"));
    assert.equal(result.ok, true);
    collected.push(...result.fragments);
    maximumBuffered = Math.max(maximumBuffered, decoder.bufferedBytes);
    offset += size;
    step = Math.min(step * 3, 4096);
  }
  const expectedParts = Math.ceil(payload.length / NATIVE_INPUT_RAW_FRAGMENT_BYTES);
  assert.equal(expectedParts, 7);
  assert.equal(collected.length, expectedParts);
  assert.deepEqual(collected.map((fragment) => fragment.part), Array.from({ length: expectedParts }, (_, index) => index));
  assert.deepEqual(collected.map((fragment) => fragment.start), collected.map((_, index) => index === 0));
  assert.deepEqual(collected.map((fragment) => fragment.end), collected.map((_, index) => index === expectedParts - 1));
  assert.ok(collected.slice(0, -1).every((fragment) => fragment.payload.length === NATIVE_INPUT_RAW_FRAGMENT_BYTES));
  assert.ok(collected.every((fragment) => fragment.origin === collected[0]!.origin));
  assert.ok(collected.every((fragment) => Object.isFrozen(fragment.origin)));
  assert.deepEqual(reassemble(collected), payload);
  assert.ok(maximumBuffered > 0);
  assert.ok(maximumBuffered <= NATIVE_INPUT_MAX_ENVELOPE_BYTES);
  assert.equal(decoder.bufferedBytes, 0);
  assert.equal(decoder.finish().ok, true);
});

test("fragments may split multibyte characters while reassembled bytes stay exact", () => {
  const payload = Buffer.concat([
    Buffer.from("x".repeat(NATIVE_INPUT_RAW_FRAGMENT_BYTES - 1), "utf8"),
    Buffer.from("🙂🙂", "utf8"),
  ]);
  const decoder = createNativeInputDecoder(bootstrap);
  const result = decoder.feed(createNativeInputEncoder(bootstrap).encode(payload, { kind: "local" }));
  assert.equal(result.ok, true);
  assert.equal(result.fragments.length, 2);
  const first = result.fragments[0]!.payload;
  assert.equal(first[first.length - 1], 0xf0, "first fragment ends inside an astral code point");
  assert.notEqual(Buffer.from(first.toString("utf8"), "utf8").length, first.length);
  assert.deepEqual(reassemble(result.fragments), payload);
  assert.deepEqual(Buffer.from(reassemble(result.fragments).toString("utf8"), "utf8"), payload);
  assert.equal(decoder.finish().ok, true);
});

test("a full technical fragment still fits one bounded envelope", () => {
  const framed = createNativeInputEncoder(bootstrap).encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES), { kind: "local" });
  const frames = fragmentsOf(framed);
  assert.equal(frames.length, 1);
  assert.ok(Buffer.byteLength(frames[0]!, "latin1") <= NATIVE_INPUT_MAX_ENVELOPE_BYTES);
  assert.equal(createNativeInputDecoder(bootstrap).feed(framed).fragments.length, 1);
});

test("tampered, foreign and replayed frames fail closed with fixed codes", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const framed = encoder.encode(Buffer.from("authentic payload", "utf8"), { kind: "local" });
  const fields = framed.slice(0, -1).split(";");
  assert.equal(fields.length, 5);
  const rebuild = (mutate: (copy: string[]) => void): string => {
    const copy = [...fields];
    mutate(copy);
    return `${copy.join(";")}\n`;
  };

  expectRefused(rebuild((copy) => { copy[0] = flipBase64Url(copy[0]!, 0); }), "malformed-frame");
  expectRefused(rebuild((copy) => { copy[1] = flipHex(copy[1]!, 3); }), "unknown-identity");
  expectRefused(rebuild((copy) => { copy[2] = "0"; }), "malformed-frame");
  expectRefused(rebuild((copy) => { copy[2] = "9".repeat(6); }), "oversized-frame");
  expectRefused(rebuild((copy) => { copy[2] = "99999"; }), "oversized-frame");
  expectRefused(rebuild((copy) => { copy[3] = flipBase64Url(copy[3]!, 5); }), "unauthenticated-frame");
  expectRefused(rebuild((copy) => { copy[4] = flipHex(copy[4]!, 0); }), "unauthenticated-frame");
  expectRefused(rebuild((copy) => { copy[4] = copy[4]!.slice(0, -1); }), "malformed-frame");
  expectRefused(rebuild((copy) => { copy[2] = String(Number(copy[2]) + 1); }), "malformed-frame");

  expectRefused(
    createNativeInputEncoder({ ...bootstrap, token: "cd".repeat(32) }).encode(Buffer.from("x"), { kind: "local" }),
    "unknown-identity",
  );
  expectRefused(
    createNativeInputEncoder({ ...bootstrap, instanceId: "33333333-3333-3333-3333-333333333333" })
      .encode(Buffer.from("x"), { kind: "local" }),
    "unknown-identity",
  );
  expectRefused(
    createNativeInputEncoder({ ...bootstrap, generation: "44444444-4444-4444-4444-444444444444" })
      .encode(Buffer.from("x"), { kind: "local" }),
    "unknown-identity",
  );

  const replay = createNativeInputDecoder(bootstrap);
  assert.equal(replay.feed(framed).ok, true);
  const replayed = replay.feed(framed);
  assert.equal(replayed.ok, false);
  if (replayed.ok) assert.fail("replay must be rejected");
  assert.equal(replayed.code, "invalid-sequence");
  assert.deepEqual(replayed.fragments, []);

  const gap = createNativeInputDecoder(bootstrap);
  const secondFrame = fragmentsOf(encoder.encode(Buffer.from("second", "utf8"), { kind: "none" }))[0]!;
  const skipped = gap.feed(secondFrame);
  assert.equal(skipped.ok, false);
  if (skipped.ok) assert.fail("sequence gap must be rejected");
  assert.equal(skipped.code, "invalid-sequence");
});

test("body identity, sequence, dispatch and origin semantics are enforced after authentication", () => {
  expectRefused(frameBody({ instanceId: "55555555-5555-5555-5555-555555555555" }), "unknown-identity");
  expectRefused(frameBody({ generation: "66666666-6666-6666-6666-666666666666" }), "unknown-identity");
  expectRefused(frameBody({ sequence: 2 }), "invalid-sequence");
  expectRefused(frameBody({ dispatchId: 0 }), "invalid-dispatch");
  expectRefused(frameBody({ part: 1 }), "invalid-dispatch");
  expectRefused(frameBody({ part: -1 }), "invalid-dispatch");
  expectRefused(frameBody({ origin: { kind: "local", token: "x" } }), "invalid-origin");
  expectRefused(frameBody({ origin: { kind: "viewer", token: "" } }), "invalid-origin");
  expectRefused(frameBody({ origin: { kind: "viewer", token: "has space" } }), "invalid-origin");
  expectRefused(frameBody({ origin: { kind: "viewer", token: "t".repeat(NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS + 1) } }),
    "invalid-origin");
  expectRefused(frameBody({ origin: { kind: "remote" } }), "invalid-origin");
  expectRefused(frameBody({ origin: { kind: "viewer", token: "viewer", extra: 1 } }), "invalid-origin");
  expectRefused(frameBody({ extra: 1 }), "malformed-frame");
  expectRefused(frameBody({ final: "yes" }), "malformed-frame");
  expectRefused(frameBody({ part: 1.5 }), "malformed-frame");
  expectRefused(frameBody({ sequence: 9_007_199_254_740_993 }), "malformed-frame");
  expectRefused(frameText(bodyText().replace('"sequence":1', '"sequence":9007199254740993')), "malformed-frame");
  expectRefused(frameBody({ v: 2 }), "malformed-frame");
  expectRefused(frameText(bodyText().replace('"v":1', '"v":1,"v":1')), "malformed-frame");
  expectRefused(frameText(bodyText().replace('{"v":1', '{ "v":1')), "malformed-frame");
  expectRefused(frameNativeInputBody(bootstrap, "AB"), "malformed-frame");
  expectRefused(frameNativeInputBody(bootstrap, Buffer.from([0xff, 0xfe]).toString("base64url")), "malformed-frame");
  expectRefused(frameBody({ origin: { kind: "viewer", token: "é" } }), "malformed-frame");

  const changedOrigin = createNativeInputDecoder(bootstrap);
  const openedFrame = fragmentsOf(
    createNativeInputEncoder(bootstrap).encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 4, 1), { kind: "local" }),
  )[0]!;
  const opened = changedOrigin.feed(openedFrame);
  assert.equal(opened.ok, true);
  assert.equal(opened.fragments.length, 1);
  assert.equal(opened.fragments[0]!.end, false);
  const switched = changedOrigin.feed(frameBody({
    sequence: 2, dispatchId: 1, part: 1, final: true, origin: { kind: "viewer", token: "v" },
  }));
  assert.equal(switched.ok, false);
  if (switched.ok) assert.fail("origin change inside one dispatch must be rejected");
  assert.equal(switched.code, "invalid-origin");
});

test("a deeply nested authenticated envelope fails with a fixed code instead of throwing", () => {
  const depth = 20_000;
  const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
  const text = `{"v":1,"instanceId":"${bootstrap.instanceId}","generation":"${bootstrap.generation}",`
    + `"sequence":1,"dispatchId":1,"part":0,"final":true,"origin":{"kind":"local"},"encoded":${nested}}`;
  const framed = frameNativeInputBody(bootstrap, Buffer.from(text, "utf8").toString("base64url"));
  assert.ok(Buffer.byteLength(framed, "latin1") <= NATIVE_INPUT_MAX_ENVELOPE_BYTES);
  const decoder = createNativeInputDecoder(bootstrap);
  // Parsing, canonical re-serialization and field checks must never escape as an exception.
  const result = decoder.feed(framed);
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("nested envelope must fail closed");
  assert.equal(result.code, "malformed-frame");
  assert.deepEqual(result.fragments, []);
  assert.equal(decoder.failureCode, "malformed-frame");
  assert.equal(decoder.bufferedBytes, 0);
  const later = decoder.feed(framed);
  assert.equal(later.ok, false);
  assert.deepEqual(later.fragments, []);
  assert.equal(decoder.finish().ok, false);
});

test("corruption poisons the decoder and never falls back to raw or legacy input", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const decoder = createNativeInputDecoder(bootstrap);
  const first = decoder.feed(encoder.encode(Buffer.from("first", "utf8"), { kind: "local" }));
  assert.equal(first.ok, true);
  assert.equal(first.fragments.length, 1);

  const corrupted = decoder.feed("\x1b[200~raw paste\x1b[201~");
  assert.equal(corrupted.ok, false);
  if (corrupted.ok) assert.fail("raw text must be rejected");
  assert.equal(corrupted.code, "malformed-frame");
  assert.deepEqual(corrupted.fragments, []);

  const later = encoder.encode(Buffer.from("second", "utf8"), { kind: "none" });
  for (const input of [later, "ls\r", "snow 雪", encoder.encode(Buffer.alloc(0), { kind: "local" })]) {
    const result = decoder.feed(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.fragments, []);
  }
  assert.equal(decoder.bufferedBytes, 0);
  assert.equal(decoder.failureCode, "malformed-frame");
  assert.equal(decoder.finish().ok, false);
});

test("ownership: delivered payloads survive caller mutation of the encoder and fed buffers", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const payload = Buffer.from("owned payload bytes", "utf8");
  const framed = encoder.encode(payload, { kind: "local" });
  payload.fill(0);
  const bytes = Buffer.from(framed, "latin1");
  const decoder = createNativeInputDecoder(bootstrap);
  const result = decoder.feed(bytes);
  bytes.fill(0);
  assert.equal(result.ok, true);
  const delivered = result.fragments[0]!.payload;
  assert.equal(delivered.toString("utf8"), "owned payload bytes");
  delivered.fill(0x41);
  const following = decoder.feed(encoder.encode(Buffer.from("next", "utf8"), { kind: "local" }));
  assert.equal(following.ok, true);
  assert.equal(following.fragments[0]!.payload.toString("utf8"), "next");
  assert.equal(decoder.finish().ok, true);
});

test("payload containing a complete frame is never parsed recursively", () => {
  const inner = createNativeInputEncoder(bootstrap).encode(Buffer.from("inner", "utf8"), { kind: "local" });
  const encoder = createNativeInputEncoder(bootstrap);
  const outer = encoder.encode(Buffer.from(inner, "latin1"), { kind: "none" });
  const follow = encoder.encode(Buffer.from("after", "utf8"), { kind: "local" });
  const decoder = createNativeInputDecoder(bootstrap);
  const result = decoder.feed(outer + follow);
  assert.equal(result.ok, true);
  assert.equal(result.fragments.length, 2);
  assert.deepEqual(result.fragments[0]!.payload, Buffer.from(inner, "latin1"));
  assert.equal(result.fragments[1]!.payload.toString("utf8"), "after");
  assert.equal(result.fragments[0]!.origin.kind, "none");
  assert.equal(result.fragments[1]!.origin.kind, "local");
});

test("finish refuses partial frames and unfinished dispatches, then stays poisoned", () => {
  const framed = createNativeInputEncoder(bootstrap).encode(Buffer.from("truncate me", "utf8"), { kind: "local" });
  for (const cut of [1, Math.floor(framed.length / 2), framed.length - 1]) {
    const decoder = createNativeInputDecoder(bootstrap);
    const partial = decoder.feed(framed.slice(0, cut));
    assert.equal(partial.ok, true);
    assert.deepEqual(partial.fragments, []);
    assert.ok(decoder.bufferedBytes > 0);
    assert.ok(decoder.bufferedBytes <= NATIVE_INPUT_MAX_ENVELOPE_BYTES);
    const finished = decoder.finish();
    assert.equal(finished.ok, false);
    if (finished.ok) assert.fail("truncation must be reported");
    assert.equal(finished.code, "truncated-frame");
    assert.equal(decoder.bufferedBytes, 0);
    assert.equal(decoder.feed(framed).ok, false);
  }

  const openDecoder = createNativeInputDecoder(bootstrap);
  const opened = openDecoder.feed(frameBody({ final: false }));
  assert.equal(opened.ok, true);
  assert.equal(opened.fragments[0]!.end, false);
  const unfinished = openDecoder.finish();
  assert.equal(unfinished.ok, false);
  if (unfinished.ok) assert.fail("unfinished dispatch must be reported");
  assert.equal(unfinished.code, "invalid-dispatch");
  assert.equal(openDecoder.feed(frameBody({ sequence: 2, dispatchId: 1, part: 1, final: true })).ok, false);

  const clean = createNativeInputDecoder(bootstrap);
  assert.equal(clean.finish().ok, true);
  assert.equal(clean.finish().ok, true);
});

test("origin validation and encoder misuse never echo tokens or payloads", () => {
  for (const origin of [
    { kind: "local", token: "x" },
    { kind: "viewer", token: "" },
    { kind: "viewer", token: "has space" },
    { kind: "viewer", token: "t".repeat(NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS + 1) },
    { kind: "remote" },
    {},
    null,
    "local",
  ]) {
    assert.equal(isValidNativeInputOrigin(origin), false);
  }
  assert.equal(isValidNativeInputOrigin({ kind: "local" }), true);
  assert.equal(isValidNativeInputOrigin({ kind: "none" }), true);
  assert.equal(isValidNativeInputOrigin({ kind: "viewer", token: "opaque" }), true);

  const encoder = createNativeInputEncoder(bootstrap);
  const token = "bad token with spaces";
  assert.throws(
    () => encoder.encode(Buffer.from("secret payload", "utf8"), { kind: "viewer", token } as NativeInputOrigin),
    (error: unknown) => error instanceof Error && !error.message.includes(token) && !error.message.includes("secret payload"),
  );
  assert.throws(() => encoder.encode("not a buffer" as unknown as Buffer, { kind: "local" }),
    (error: unknown) => error instanceof Error && !error.message.includes("not a buffer"));
});
