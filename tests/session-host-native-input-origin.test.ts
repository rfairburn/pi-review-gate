import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  NATIVE_INPUT_MAX_ENVELOPE_BYTES,
  NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS,
  NATIVE_INPUT_RAW_FRAGMENT_BYTES,
  NATIVE_INPUT_VIEWER_SCOPE_TOKEN_CHARS,
  createNativeInputDecoder,
  createNativeInputEncoder,
  frameNativeInputBody,
  isValidNativeInputOrigin,
  mintNativeViewerScopeToken,
  parseNativeViewerScopeToken,
  verifyNativeViewerScopeToken,
  type NativeInputDecoder,
  type NativeInputExpectedFence,
  type NativeInputExpectedTuple,
  type NativeInputFailureCode,
  type NativeInputFragment,
  type NativeInputOrigin,
  type NativeViewerScopeFacts,
} from "../src/session-host/native-input-origin";
import type { SessionHostBootstrap } from "../src/session-host/protocol";

const bootstrap: SessionHostBootstrap = {
  version: 1,
  instanceId: "11111111-1111-1111-1111-111111111111",
  generation: "22222222-2222-2222-2222-222222222222",
  token: "ab".repeat(32),
  socketPath: "/synthetic/broker.sock",
};

/**
 * One complete v2 frame: tag, magic, decimal body length, base64url body, MAC and
 * exactly one printable `;` terminator. Sticky so a whole write can be walked.
 */
const CANONICAL_FRAME = /prg-ni-v2;[0-9a-f]{16};[1-9][0-9]*;[A-Za-z0-9_-]+;[0-9a-f]{64};/gy;

/**
 * Split one encoder output into its complete frames at their printable terminators.
 * Anything that is not a contiguous run of exact v2 frames — a control terminator, a
 * stray byte between frames, or a truncated tail — fails here rather than being
 * silently tolerated, so every caller asserts the real wire shape.
 */
function fragmentsOf(framed: string): string[] {
  const frames: string[] = [];
  CANONICAL_FRAME.lastIndex = 0;
  let offset = 0;
  for (let match = CANONICAL_FRAME.exec(framed); match !== null; match = CANONICAL_FRAME.exec(framed)) {
    assert.equal(match.index, offset, "frames are contiguous with no byte between them");
    offset = match.index + match[0].length;
    frames.push(match[0]);
  }
  assert.equal(offset, framed.length, "the write is nothing but complete printable v2 frames");
  return frames;
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
  // Hand-built bodies are built in the encoder's canonical key order, including the
  // optional fence, which sits between `origin` and `encoded`. An unknown key still
  // lands last, exactly where it always did.
  const { expectedNativeTuple, ...rest } = overrides;
  return JSON.stringify({
    v: 1,
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    sequence: 1,
    dispatchId: 1,
    part: 0,
    final: true,
    origin: { kind: "local" },
    ...(expectedNativeTuple === undefined ? {} : { expectedNativeTuple }),
    encoded: "",
    ...rest,
  });
}

function frameText(text: string): string {
  return frameNativeInputBody(bootstrap, Buffer.from(text, "utf8").toString("base64url"));
}

function frameBody(overrides: Record<string, unknown> = {}): string {
  return frameText(bodyText(overrides));
}

/** One authenticated native-conversation fence carried by a `viewer` dispatch. */
const nativeTuple = (sessionId: string, epoch: number): NativeInputExpectedTuple => ({ sessionId, epoch });
/** The fence a viewer origin must carry; absent for every other origin. */
const tupleFor = (origin: NativeInputOrigin): NativeInputExpectedTuple | undefined =>
  origin.kind === "viewer" ? nativeTuple("conversation-scope", 4) : undefined;

/** The decoded canonical body of one complete single-frame dispatch. */
function bodyOf(framed: string): Record<string, unknown> {
  const fields = framed.slice(0, -1).split(";");
  assert.equal(fields.length, 5);
  return JSON.parse(Buffer.from(fields[3]!, "base64url").toString("utf8")) as Record<string, unknown>;
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
    // Old and current framing text as pure payload data: neither is ever re-parsed.
    Buffer.from("\x1b]52;c;QQ==\x07 prg-ni-v1; prg-ni-v1; prg-ni-v2; embedded \x1b[200~paste\x1b[201~", "latin1"),
  ];
  const origins: NativeInputOrigin[] = [
    { kind: "local" },
    { kind: "none" },
    { kind: "viewer", token: "viewer-7f3a9c20" },
    { kind: "viewer", token: "t".repeat(NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS) },
  ];
  for (const origin of origins) {
    for (const payload of payloads) {
      const expected = tupleFor(origin);
      const framed = createNativeInputEncoder(bootstrap).encode(payload, origin, expected);
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
      // The fence is part of the closed fragment shape: always present, only ever
      // valued for a viewer dispatch, and owned rather than shared with the caller.
      assert.equal(Object.hasOwn(fragment, "expectedNativeTuple"), true);
      if (origin.kind === "viewer") {
        assert.deepEqual({ ...fragment.expectedNativeTuple }, expected);
        assert.ok(Object.isFrozen(fragment.expectedNativeTuple));
        assert.notEqual(fragment.expectedNativeTuple, expected, "the decoder owns its own fence object");
      } else {
        assert.equal(fragment.expectedNativeTuple, undefined, "local and none dispatches never carry a viewer fence");
      }
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
  const framed = createNativeInputEncoder(bootstrap)
    .encode(payload, { kind: "viewer", token: "viewer-boundary" }, nativeTuple("conversation-boundary", 1));

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
  const third = encoder.encode(Buffer.from("third", "utf8"), { kind: "viewer", token: "viewer-three" }, nativeTuple("conversation-three", 2));
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
  assert.deepEqual({ ...viewerFragment.expectedNativeTuple }, nativeTuple("conversation-three", 2),
    "each dispatch carries only its own fence");
  assert.equal(result.fragments[0]!.expectedNativeTuple, undefined);
  assert.equal(result.fragments[1]!.expectedNativeTuple, undefined);

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
    return `${copy.join(";")};`;
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

test("every emitted frame is printable ASCII v2 framing ending in one semicolon", () => {
  const dispatches: readonly (readonly [NativeInputOrigin, NativeInputExpectedFence | undefined])[] = [
    [{ kind: "local" }, undefined],
    [{ kind: "none" }, undefined],
    [{ kind: "viewer", token: "viewer-wire" }, nativeTuple("conversation-wire", 2)],
    [{ kind: "viewer", token: "nvst1.viewer-1.0123456789abcdef0123456789abcdef" }, { phase: "startup" }],
  ];
  const payloads: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from("plain keys", "utf8"),
    // Payload controls remain binary data inside the printable envelope:
    // NUL, LF, CR, ESC, DEL and high-bit bytes must survive unchanged.
    Buffer.from("\x00\x0a\x0d\x1b\x7f\x80\xff", "latin1"),
    Buffer.from("\x1b[200~paste\nwith\x00NUL\r\nand \x1b]52;c;QQ==\x07", "latin1"),
    Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES * 2 + 5, 0x0a),
  ];
  for (const [origin, fence] of dispatches) {
    for (const payload of payloads) {
      const framed = createNativeInputEncoder(bootstrap).encode(payload, origin, fence);
      assert.match(framed, /^[\x20-\x7e]+$/, "the whole wire is printable ASCII with no control byte");
      assert.equal(framed.includes("\n") || framed.includes("\r"), false,
        "no LF and no CRLF appears anywhere in an emitted dispatch");
      const frames = fragmentsOf(framed);
      assert.equal(frames.length, Math.max(1, Math.ceil(payload.length / NATIVE_INPUT_RAW_FRAGMENT_BYTES)),
        "one dispatch travels as contiguous complete frames");
      assert.ok(frames.every((frame) => frame.startsWith("prg-ni-v2;") && frame.endsWith(";")),
        "every frame carries the v2 tag and exactly one printable terminator");
      assert.ok(frames.every((frame) => Buffer.byteLength(frame, "latin1") <= NATIVE_INPUT_MAX_ENVELOPE_BYTES));
      const decoder = createNativeInputDecoder(bootstrap);
      const result = decoder.feed(framed);
      assert.equal(result.ok, true, "the exact current wire is accepted");
      assert.deepEqual(reassemble(result.fragments), payload,
        "payload bytes — LF, CR, NUL, ESC and high-bit included — survive the decode exactly");
      assert.equal(decoder.finish().ok, true);
    }
  }
});

test("the retired v1 tag, the LF terminator and a terminal-re-encoded ending are refused and stay poisoned", () => {
  const framed = createNativeInputEncoder(bootstrap).encode(Buffer.from("printable", "utf8"), { kind: "local" });
  assert.equal(framed.endsWith(";"), true, "the current frame ends in one printable terminator");
  const prefix = framed.slice(0, -1);
  const retiredTag = framed.replace(/^prg-ni-v2;/, "prg-ni-v1;");
  // The retired wire itself: the same authenticated fields closed by a control byte.
  const retiredWire = `${prefix}\n`;
  // The observed incompatibility: a real terminal replaced that trailing LF with a
  // Kitty keyboard-protocol key event, so the child received this same prefix plus an
  // 19-byte key-report tail in place of the single terminator byte.
  const kittyEnding = `${prefix}\x1b[13;5u\x1b[57442;1:3u`;
  for (const wire of [
    retiredWire,
    `${prefix}\r`,
    retiredTag,
    `${retiredTag.slice(0, -1)}\n`,
    kittyEnding,
    kittyEnding + framed,
  ]) expectRefused(wire, "malformed-frame");

  // A correctly terminated frame ahead of a retired ending keeps its own delivery —
  // the refusal starts at the failing frame, and everything after it is refused.
  const trailing = createNativeInputDecoder(bootstrap);
  const mixed = trailing.feed(framed + retiredWire);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, "malformed-frame");
  assert.equal(mixed.fragments.length, 1,
    "only the frame that fully authenticated before the bad terminator is delivered");
  assert.equal(trailing.feed(framed).fragments.length, 0, "nothing after the refusal is ever delivered");

  // Fail closed for the rest of this decoder's lifetime: the substituted ending
  // poisons it, and the next authentic, correctly terminated frame delivers nothing.
  const decoder = createNativeInputDecoder(bootstrap);
  const poisoned = decoder.feed(kittyEnding);
  assert.equal(poisoned.ok, false);
  assert.equal(poisoned.code, "malformed-frame");
  assert.deepEqual(poisoned.fragments, []);
  const later = decoder.feed(framed);
  assert.equal(later.ok, false);
  assert.equal(later.code, "malformed-frame");
  assert.deepEqual(later.fragments, [], "a poisoned decoder never delivers a later valid frame");
  assert.equal(decoder.failureCode, "malformed-frame");
  assert.equal(decoder.finish().ok, false);
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

test("hasPartialFrame reports every in-flight parser state, including the byte after the tag", () => {
  const framed = createNativeInputEncoder(bootstrap).encode(Buffer.from("partial states", "utf8"), { kind: "local" });
  const idle = createNativeInputDecoder(bootstrap);
  assert.equal(idle.hasPartialFrame, false, "an untouched decoder holds nothing");
  for (let cut = 1; cut <= framed.length; cut += 1) {
    const probe = createNativeInputDecoder(bootstrap);
    assert.equal(probe.feed(framed.slice(0, cut)).ok, true, `cut ${cut} is accepted so far`);
    // Read the live state BEFORE `finish()`, which poisons and resets on truncation.
    const partial = probe.hasPartialFrame;
    const buffered = probe.bufferedBytes;
    const finished = probe.finish();
    // The predicate must agree with the verdict `finish()` reaches on that state.
    assert.equal(partial, !finished.ok && finished.code === "truncated-frame", `cut ${cut}`);
    if (cut === "prg-ni-v2;".length) {
      // The state a retained-byte count cannot see: the tag is consumed and nothing
      // else is buffered, yet a frame is unmistakably in flight.
      assert.equal(buffered, 0, "nothing is retained immediately after the tag");
      assert.equal(partial, true, "but the frame is partial");
    }
  }
  const whole = createNativeInputDecoder(bootstrap);
  assert.equal(whole.feed(framed).ok, true);
  assert.equal(whole.hasPartialFrame, false, "an authenticated terminator closes the frame");
  assert.equal(whole.finish().ok, true);
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

test("a viewer dispatch requires exactly one authenticated native-conversation fence", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const tuple = nativeTuple("conversation-a", 3);
  const viewerOrigin: NativeInputOrigin = { kind: "viewer", token: "viewer-1" };

  // A viewer dispatch without its fence, and a non-viewer dispatch claiming one,
  // are both caller errors: the closed shape cannot be skipped or borrowed.
  assert.throws(() => encoder.encode(Buffer.from("x"), viewerOrigin), /expected tuple/);
  for (const origin of [{ kind: "local" }, { kind: "none" }] as NativeInputOrigin[]) {
    assert.throws(() => encoder.encode(Buffer.from("x"), origin, tuple), /expected tuple/);
  }

  for (const bad of [
    { sessionId: "conversation-a" },
    { epoch: 3 },
    { sessionId: "conversation-a", epoch: 0 },
    { sessionId: "conversation-a", epoch: -1 },
    { sessionId: "conversation-a", epoch: 1.5 },
    { sessionId: "conversation-a", epoch: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: "conversation-a", epoch: 3, extra: 1 },
    { sessionId: "", epoch: 3 },
    { sessionId: "conversation\u0000a", epoch: 3 },
    { sessionId: "conversation\na", epoch: 3 },
    { sessionId: "a/b", epoch: 3 },
    { sessionId: "a".repeat(4096), epoch: 3 },
    { sessionId: 7, epoch: 3 },
    null,
    "conversation-a",
    3,
  ]) {
    assert.throws(
      () => encoder.encode(Buffer.from("x"), viewerOrigin, bad as unknown as NativeInputExpectedTuple),
      /expected tuple/, `${JSON.stringify(bad)} is not a bounded native conversation tuple`,
    );
  }

  // A refusal never echoes the payload, the token, or the conversation identity.
  const secretToken = "opaque-viewer-token-with-secret-shape";
  assert.throws(
    () => encoder.encode(Buffer.from("secret-payload-bytes"), { kind: "viewer", token: secretToken },
      { sessionId: "secret-conversation", epoch: 0 }),
    (error: unknown) => error instanceof Error
      && !error.message.includes(secretToken)
      && !error.message.includes("secret-payload-bytes")
      && !error.message.includes("secret-conversation"),
  );

  // The VALUE is never validated by the codec: an expectation the child has
  // already outgrown is authenticated framing, and refusing it is the bridge's
  // ordinary per-fragment decision, not protocol corruption.
  const stale = nativeTuple("conversation-long-gone", 99);
  const framed = encoder.encode(Buffer.from("stale keys"), viewerOrigin, stale);
  const decoder = createNativeInputDecoder(bootstrap);
  const result = decoder.feed(framed);
  assert.equal(result.ok, true, "a stale fence is not a decoder failure");
  assert.deepEqual({ ...result.fragments[0]!.expectedNativeTuple }, stale);
  assert.equal(decoder.finish().ok, true, "the decoder stays usable for the next dispatch");
});

test("the fence is canonical authenticated framing while local and none bodies stay byte-for-byte unchanged", () => {
  // Each byte comparison gets its own encoder at sequence 1, so it is compared
  // against the first frame a registration ever produces, never a continuation.
  assert.equal(createNativeInputEncoder(bootstrap).encode(Buffer.alloc(0), { kind: "local" }), frameBody(),
    "the unchanged canonical body is exactly what a local dispatch produced before this fence existed");
  assert.equal(createNativeInputEncoder(bootstrap).encode(Buffer.alloc(0), { kind: "none" }),
    frameBody({ origin: { kind: "none" } }),
    "no new key, no reordering, no new bytes");

  const tuple = nativeTuple("conversation-canonical", 2);
  const framed = createNativeInputEncoder(bootstrap)
    .encode(Buffer.from("v"), { kind: "viewer", token: "viewer-1" }, tuple);
  assert.deepEqual(bodyOf(framed).expectedNativeTuple, tuple);
  assert.deepEqual(Object.keys(bodyOf(framed)), [
    "v", "instanceId", "generation", "sequence", "dispatchId", "part", "final",
    "origin", "expectedNativeTuple", "encoded",
  ], "the fence travels in its own canonical position, inside the signed body");
  assert.equal(createNativeInputDecoder(bootstrap).feed(framed).ok, true);

  // Any other key order is non-canonical authenticated framing, even when every
  // field is otherwise perfect and correctly signed.
  const handBuilt = {
    v: 1, instanceId: bootstrap.instanceId, generation: bootstrap.generation,
    sequence: 1, dispatchId: 1, part: 0, final: true,
    origin: { kind: "viewer", token: "viewer-1" },
    expectedNativeTuple: { sessionId: "conversation-canonical", epoch: 2 },
    encoded: Buffer.from("v", "utf8").toString("base64url"),
  };
  const canonicalText = JSON.stringify(handBuilt);
  assert.equal(createNativeInputDecoder(bootstrap).feed(frameText(canonicalText)).ok, true,
    "a hand-built canonical body with the fence is exactly what the encoder produces");
  const swapped = canonicalText.replace(
    '"origin":{"kind":"viewer","token":"viewer-1"},"expectedNativeTuple":{"sessionId":"conversation-canonical","epoch":2},',
    '"expectedNativeTuple":{"sessionId":"conversation-canonical","epoch":2},"origin":{"kind":"viewer","token":"viewer-1"},',
  );
  assert.notEqual(swapped, canonicalText, "the swap really moved the fence");
  expectRefused(frameText(swapped), "malformed-frame");

  // A viewer dispatch cannot drop its fence mid-dispatch or move it to another origin.
  expectRefused(frameBody({ origin: { kind: "viewer", token: "v" } }), "invalid-origin");
  expectRefused(frameBody({
    origin: { kind: "viewer", token: "v" },
    expectedNativeTuple: { sessionId: "conversation-a", epoch: 0 },
  }), "malformed-frame");
  expectRefused(frameBody({ expectedNativeTuple: { sessionId: "conversation-a", epoch: 1 } }), "invalid-origin");
  expectRefused(frameBody({ expectedNativeTuple: null }), "malformed-frame");

  // One logical dispatch carries exactly one immutable fence.
  const opener = createNativeInputEncoder(bootstrap);
  const parts = fragmentsOf(opener.encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 4, 1),
    { kind: "viewer", token: "viewer-open" }, nativeTuple("conversation-open", 5)));
  assert.equal(parts.length, 2);
  const decoder = createNativeInputDecoder(bootstrap);
  const opened = decoder.feed(parts[0]!);
  assert.equal(opened.ok, true);
  assert.deepEqual({ ...opened.fragments[0]!.expectedNativeTuple }, nativeTuple("conversation-open", 5));
  const moved = decoder.feed(frameBody({
    sequence: 2, dispatchId: 1, part: 1, final: true,
    origin: { kind: "viewer", token: "viewer-open" },
    expectedNativeTuple: { sessionId: "conversation-open", epoch: 6 },
  }));
  assert.equal(moved.ok, false);
  if (moved.ok) assert.fail("a fence change inside one dispatch must be rejected");
  assert.equal(moved.code, "invalid-dispatch");
  assert.deepEqual(moved.fragments, [], "nothing of the tampered dispatch is delivered");
});

/** One viewer scope fact set for the pure commitment helpers. */
function scopeFacts(overrides: Partial<NativeViewerScopeFacts> = {}): NativeViewerScopeFacts {
  return {
    hostRunId: "host-run-1",
    viewerId: "viewer-1",
    viewerRevision: 1,
    rowId: "row-1",
    registrationIdentity: bootstrap.instanceId,
    registrationGeneration: bootstrap.generation,
    nativeSessionId: "conversation-a",
    nativeSessionEpoch: 1,
    cols: 80,
    rows: 24,
    geometryRevision: 0,
    ...overrides,
  };
}

test("a viewer scope token commits to the host's own facts and fits the existing origin bound", () => {
  const minted = mintNativeViewerScopeToken(bootstrap, scopeFacts());
  assert.ok(typeof minted === "string");
  const token = minted as string;
  assert.match(token, /^nvs1\.viewer-1\.[0-9a-f]{32}$/);
  assert.ok(token.length <= NATIVE_INPUT_VIEWER_SCOPE_TOKEN_CHARS, "a minted token is a legal origin token");
  assert.equal(NATIVE_INPUT_VIEWER_SCOPE_TOKEN_CHARS, NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS);
  assert.equal(token.split(".").length, 3, "tag, one opaque handle, one commitment, nothing else");
  assert.equal(isValidNativeInputOrigin({ kind: "viewer", token }), true);
  assert.equal(token.includes(bootstrap.token), false, "the registration secret never appears in a token");
  assert.equal(token.includes(bootstrap.generation), false);
  assert.deepEqual(parseNativeViewerScopeToken(token), { viewerId: "viewer-1" });
  assert.equal(Object.isFrozen(parseNativeViewerScopeToken(token)), true);
  assert.equal(verifyNativeViewerScopeToken(bootstrap, token, scopeFacts()), true);
  assert.equal(verifyNativeViewerScopeToken(bootstrap, token, scopeFacts({ hostRunId: "host-run-2" })), false,
    "another host run's viewer cannot spend this scope");
});

test("scope verification refuses every stale fact, foreign registration and uncanonical token", () => {
  const token = mintNativeViewerScopeToken(bootstrap, scopeFacts()) as string;

  // Every committed fact is load-bearing: changing any one of them (including an
  // ABA geometry change that lands back on the same size) verifies to false.
  for (const stale of [
    scopeFacts({ viewerId: "viewer-2" }),
    scopeFacts({ viewerRevision: 2 }),
    scopeFacts({ hostRunId: "host-run-2" }),
    scopeFacts({ rowId: "row-2" }),
    scopeFacts({ registrationIdentity: "99999999-9999-9999-9999-999999999999" }),
    scopeFacts({ registrationGeneration: "88888888-8888-8888-8888-888888888888" }),
    scopeFacts({ nativeSessionId: "conversation-b" }),
    scopeFacts({ nativeSessionEpoch: 2 }),
    scopeFacts({ cols: 81 }),
    scopeFacts({ rows: 25 }),
    // Resized away and back to the identical size: still a newer geometry.
    scopeFacts({ geometryRevision: 1 }),
  ]) {
    assert.equal(verifyNativeViewerScopeToken(bootstrap, token, stale), false,
      `${JSON.stringify(stale)} is not the committed scope`);
  }

  // A different registration derives a different commitment for identical facts.
  for (const foreign of [
    { ...bootstrap, token: "cd".repeat(32) },
    { ...bootstrap, instanceId: "77777777-7777-7777-7777-777777777777" },
    { ...bootstrap, generation: "66666666-6666-6666-6666-666666666666" },
  ]) {
    assert.equal(verifyNativeViewerScopeToken(foreign, token, scopeFacts()), false);
    assert.notEqual(mintNativeViewerScopeToken(foreign, scopeFacts()), token);
  }

  // Parsing is only a lookup aid; a well-formed but unauthenticated token verifies
  // to false, and an uncanonical token never yields a handle at all.
  const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
  assert.equal(verifyNativeViewerScopeToken(bootstrap, flipped, scopeFacts()), false);
  assert.deepEqual(parseNativeViewerScopeToken(flipped), { viewerId: "viewer-1" });
  const forged = `nvs1.viewer-1.${"0".repeat(32)}`;
  assert.equal(verifyNativeViewerScopeToken(bootstrap, forged, scopeFacts()), false);
  for (const junk of [
    "", "nvs1.viewer-1", `nvs1.viewer-1.${"a".repeat(31)}`, `nvs1.viewer-1.${"a".repeat(33)}`,
    `nvs1.viewer-1.${"A".repeat(32)}`, "nvs1..".concat("a".repeat(32)), `nvs1.viewer-1.extra.${"a".repeat(32)}`,
    `nvs2.viewer-1.${"a".repeat(32)}`, `nvs1.vi ewer.${"a".repeat(32)}`, `nvs1.viewer-1.${"a".repeat(32)}\n`,
    `nvs1.viewer-1.${"g".repeat(32)}`, `${token}\n`, token.toUpperCase(),
    null, undefined, 7, { viewerId: "viewer-1" }, Symbol.iterator,
  ]) {
    assert.equal(parseNativeViewerScopeToken(junk), undefined);
    assert.equal(verifyNativeViewerScopeToken(bootstrap, junk, scopeFacts()), false);
  }

  // The handle itself is bounded, so a hostile identity can never widen the token.
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts({ viewerId: `${"v".repeat(64)}x` })), undefined);
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts({ viewerId: "" })), undefined);
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts({ viewerId: "has space" })), undefined);
});

test("scope minting and verification fail closed on malformed facts and registrations without throwing", () => {
  for (const bad of [
    undefined, null, 7, "facts", [],
    { ...scopeFacts(), extra: 1 },
    Object.fromEntries(Object.entries(scopeFacts()).filter(([key]) => key !== "hostRunId")),
    { ...scopeFacts(), hostRunId: "" },
    { ...scopeFacts(), hostRunId: "\u0000run" },
    { ...scopeFacts(), hostRunId: "r".repeat(200) },
    { ...scopeFacts(), viewerRevision: -1 },
    { ...scopeFacts(), viewerRevision: 1.5 },
    { ...scopeFacts(), nativeSessionEpoch: 0 },
    { ...scopeFacts(), nativeSessionEpoch: "1" },
    { ...scopeFacts(), cols: 0 },
    { ...scopeFacts(), rows: -1 },
    { ...scopeFacts(), geometryRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...scopeFacts(), registrationGeneration: "" },
  ]) {
    assert.equal(mintNativeViewerScopeToken(bootstrap, bad as unknown as NativeViewerScopeFacts), undefined);
    assert.equal(verifyNativeViewerScopeToken(bootstrap, "nvs1.viewer-1.".concat("a".repeat(32)),
      bad as unknown as NativeViewerScopeFacts), false);
  }

  // A malformed registration mints nothing and verifies nothing; it never throws
  // into an input path and never falls back to another key.
  const broken = { ...bootstrap, token: "not-hex" } as unknown as typeof bootstrap;
  assert.equal(mintNativeViewerScopeToken(broken, scopeFacts()), undefined);
  assert.equal(verifyNativeViewerScopeToken(broken, "nvs1.viewer-1.".concat("a".repeat(32)), scopeFacts()), false);

  // Minting is a pure derivation: no state, no nonce, no counter, and no reuse of
  // any other dispatch's sequence.
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts()), mintNativeViewerScopeToken(bootstrap, scopeFacts()));
});

test("viewer tuples and commitments preserve the protocol's native session ID domain", () => {
  // The protocol's own native identity domain is opaque text bounded in UTF-8
  // bytes, control-free and path-free — it is NOT ASCII-only. The framing envelope
  // stays ASCII bytes by escaping canonically, so a valid identity neither fails
  // its own decoder nor poisons anything that follows it.
  for (const sessionId of ["conversation-雪", "n".repeat(256)]) {
    const encoder = createNativeInputEncoder(bootstrap);
    const decoder = createNativeInputDecoder(bootstrap);
    const tuple = nativeTuple(sessionId, 1);
    const framed = encoder.encode(Buffer.from("x"), { kind: "viewer", token: "viewer-1" }, tuple);
    assert.equal(/[\u0080-\uffff]/.test(framed), false, "the envelope itself stays pure ASCII bytes");
    const result = decoder.feed(framed);
    assert.equal(result.ok, true, "a valid conversation identity is never a decoder failure");
    assert.deepEqual(result.fragments[0]!.expectedNativeTuple, tuple, "the identity round-trips exactly");
    assert.deepEqual(result.fragments[0]!.payload.toString("utf8"), "x");
    const next = decoder.feed(encoder.encode(Buffer.from("next"), { kind: "local" }));
    assert.equal(next.ok, true, "the next dispatch on this registration is delivered normally");
    assert.deepEqual(next.fragments[0]!.payload.toString("utf8"), "next");

    const facts = scopeFacts({ nativeSessionId: sessionId });
    const token = mintNativeViewerScopeToken(bootstrap, facts);
    assert.equal(typeof token, "string", "a valid identity still describes a scope");
    assert.equal(verifyNativeViewerScopeToken(bootstrap, token, facts), true);
    assert.equal(verifyNativeViewerScopeToken(bootstrap, token,
      scopeFacts({ nativeSessionId: `${sessionId}-other` })), false,
    "another conversation identity is a different scope");
  }

  // An identity the protocol itself rejects still mints nothing and frames nothing.
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts({ nativeSessionId: "" })), undefined);
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts({ nativeSessionId: "a/b" })), undefined);
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts({ nativeSessionId: "a\u0000b" })), undefined);
  assert.equal(mintNativeViewerScopeToken(bootstrap, scopeFacts({ nativeSessionId: "n".repeat(257) })), undefined);
  assert.throws(() => createNativeInputEncoder(bootstrap).encode(Buffer.from("x"),
    { kind: "viewer", token: "viewer-1" }, nativeTuple("a\u0000b", 1)), /expected tuple/);
});
