/**
 * Inert authenticated input-origin codec for the existing host stdin bridge.
 *
 * This is a pure, source-only utility: it has no production caller, no timers, no
 * environment or capture toggles, and zero observable behavior until a later,
 * explicit bridge integration feeds it. It is NOT a network-input capability, a
 * trusted-viewer receipt, a provenance claim, a physical-clipboard coverage
 * statement, or an input permission. Nothing here enables remote input; current
 * network input and copy behavior remain unchanged and disabled.
 *
 * The codec carries one already-admitted logical dispatch (payload bytes that the
 * caller already holds) as ordered, bounded, ASCII-only fragments. Each fragment
 * is authenticated, together with its payload, before delivery:
 *
 *   "prg-ni-v1;" <magic:16 hex> ";" <body chars:decimal> ";" <base64url body> ";"
 *   <mac:64 lowercase hex> "\n"
 *
 * - <magic> is HMAC-SHA256(key, domain | "frame-magic" | instanceId | NUL |
 *   generation)[0..16]. It is private to one registration, so a foreign identity
 *   cannot even reach body parsing.
 * - <body> is unpadded canonical base64url of the canonical JSON envelope
 *   {"v":1,"instanceId","generation","sequence","dispatchId","part","final",
 *    "origin","encoded"} where "encoded" is the unpadded canonical base64url of
 *   the raw payload bytes.
 * - <mac> is HMAC-SHA256(key, domain | "body-mac" | exact base64url body). The
 *   signature covers the complete body, never a header alone, and therefore the
 *   payload. The key is the existing registration token (hex64); this module does
 *   not define a new identity or a broader authority.
 *
 * Frames are ASCII only so an existing Node stdin UTF-8 decoder cannot corrupt
 * split Unicode before the later bridge integration. Payload bytes are never
 * decoded to text here; the future bridge owns a per-dispatch string decoder.
 *
 * A decoder is strict: on any malformed, unauthenticated, foreign, replayed,
 * out-of-order, oversized, or truncated input it reports one fixed code and is
 * poisoned for the rest of its lifetime. It never falls back to raw/legacy
 * keystroke passthrough, never retargets, never replays, and never delivers a
 * payload that was not fully authenticated. Previously delivered input may
 * already have executed; this module makes no rollback or cancellation claim.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionHostBootstrap } from "./protocol";

/**
 * Explicit origin of one logical dispatch. `none` is host query/reply and other
 * non-user input; `local` is local user input and never remote input; `viewer`
 * carries only an opaque host-allocated token (no peer key, path, or payload
 * metadata). This is an internal classification, not an authority grant.
 */
export type NativeInputOrigin =
  | { readonly kind: "local" }
  | { readonly kind: "none" }
  | { readonly kind: "viewer"; readonly token: string };

/** Fixed failure codes; never carry payload, token, or secret material. */
export type NativeInputFailureCode =
  | "malformed-frame"
  | "unauthenticated-frame"
  | "unknown-identity"
  | "invalid-sequence"
  | "invalid-dispatch"
  | "invalid-origin"
  | "oversized-frame"
  | "truncated-frame";

/** One authenticated payload fragment with immutable dispatch context. */
export interface NativeInputFragment {
  /** Frozen origin object; the same instance for every part of a dispatch. */
  readonly origin: NativeInputOrigin;
  /** Monotonic logical dispatch id chosen by the encoder. */
  readonly dispatchId: number;
  /** Contiguous part index inside the dispatch, starting at 0. */
  readonly part: number;
  /** True only for part 0. */
  readonly start: boolean;
  /** True only for the dispatch's final part. */
  readonly end: boolean;
  /** Owned payload bytes, exact and independent of the parser's state. */
  readonly payload: Buffer;
}

/**
 * Feed result. On failure, `fragments` contains only frames that were fully
 * verified before the failing byte, never a partial one, and the decoder is
 * poisoned: later feeds deliver nothing.
 */
export type NativeInputFeedResult =
  | { readonly ok: true; readonly fragments: readonly NativeInputFragment[] }
  | { readonly ok: false; readonly code: NativeInputFailureCode; readonly fragments: readonly NativeInputFragment[] };

export interface NativeInputDecoder {
  /** Consume a Buffer or an ASCII string chunk; never throws on bad input. */
  feed(chunk: Buffer | string): NativeInputFeedResult;
  /**
   * Finalize the stream. Succeeds only with no partial frame, no partial logical
   * dispatch, and no prior failure; otherwise it reports one fixed code and
   * poisons the decoder.
   */
  finish(): NativeInputFeedResult;
  /** First fixed failure code, or undefined while healthy. */
  readonly failureCode: NativeInputFailureCode | undefined;
  /** Bounded retained parser bytes (header/body/signature of one frame at most). */
  readonly bufferedBytes: number;
}

export interface NativeInputEncoder {
  /**
   * Encode one already-admitted logical dispatch into ordered fragments and
   * return the complete framing string. A caller writes it as one unit so another
   * dispatch cannot interleave. Payload bytes are preserved exactly, including
   * NUL, controls, embedded framing text, OSC 52 decoys, and bracketed paste.
   */
  encode(payload: Buffer, origin: NativeInputOrigin): string;
}

/** Technical fragment transport bound; this is not a paste or product limit. */
export const NATIVE_INPUT_RAW_FRAGMENT_BYTES = 32 * 1024;
/** Bound for the opaque viewer token carried inside an origin. */
export const NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS = 128;

const FRAME_TAG = "prg-ni-v1;";
const MAGIC_CHARS = 16;
const MAC_CHARS = 64;
const KEY_DOMAIN = "pi-review-gate/native-input/v1\0";
const MAGIC_DOMAIN = "frame-magic\0";
const BODY_MAC_DOMAIN = "body-mac\0";

const PAYLOAD_B64_MAX = Math.ceil(NATIVE_INPUT_RAW_FRAGMENT_BYTES / 3) * 4;
const BODY_OVERHEAD_BYTES = 2048;
const MAX_BODY_JSON_BYTES = PAYLOAD_B64_MAX + BODY_OVERHEAD_BYTES;
const MAX_BODY_B64_CHARS = Math.ceil(MAX_BODY_JSON_BYTES / 3) * 4;
const MAX_LENGTH_DIGITS = String(MAX_BODY_B64_CHARS).length;

/**
 * Largest single frame. Derived solely from the technical fragment bound plus
 * fixed envelope overhead, so retained decoder state is independent of total
 * paste length.
 */
export const NATIVE_INPUT_MAX_ENVELOPE_BYTES = FRAME_TAG.length + MAGIC_CHARS + 1 + MAX_LENGTH_DIGITS + 1
  + MAX_BODY_B64_CHARS + 1 + MAC_CHARS + 1;

const BODY_KEYS = ["v", "instanceId", "generation", "sequence", "dispatchId", "part", "final", "origin", "encoded"] as const;
const MAGIC_PATTERN = /^[0-9a-f]{16}$/;
/** Mirrors the existing descriptor's UUID-like bounded identity shape. */
const IDENTITY_PATTERN = /^[0-9a-f-]{1,128}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const HEX_RUN = /^[0-9a-f]*$/;
const BASE64URL_RUN = /^[A-Za-z0-9_-]+$/;
const ASCII_RUN = /^[\x00-\x7f]*$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** Bounded window used only to convert an ASCII string chunk; it never limits a dispatch. */
const ASCII_WINDOW_CHARS = 64 * 1024;

type Step = "tag" | "magic" | "length" | "body" | "bodyTerminator" | "mac" | "terminator";

interface Registration {
  readonly key: Buffer;
  readonly magic: string;
  readonly instanceId: string;
  readonly generation: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalBase64Url(value: unknown, max: number, allowEmpty: boolean): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return allowEmpty;
  if (value.length > max || value.length % 4 === 1) return false;
  if (!BASE64URL_RUN.test(value)) return false;
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

function isViewerToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS
    && PRINTABLE_ASCII.test(value);
}

/** Closed-origin validation; `local` and `none` can never be misread as `viewer`. */
export function isValidNativeInputOrigin(value: unknown): value is NativeInputOrigin {
  if (!isRecord(value)) return false;
  if (value.kind === "local" || value.kind === "none") return exactKeys(value, ["kind"]);
  return value.kind === "viewer" && exactKeys(value, ["kind", "token"]) && isViewerToken(value.token);
}

function freezeOrigin(origin: NativeInputOrigin): NativeInputOrigin {
  if (origin.kind === "viewer") return Object.freeze({ kind: "viewer" as const, token: origin.token });
  return origin.kind === "local"
    ? Object.freeze({ kind: "local" as const })
    : Object.freeze({ kind: "none" as const });
}

function sameOrigin(left: NativeInputOrigin, right: NativeInputOrigin): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind !== "viewer" || right.kind !== "viewer" || left.token === right.token;
}

/** Derives the private per-registration key and frame magic from the existing descriptor. */
function registrationOf(bootstrap: SessionHostBootstrap): Registration {
  const candidate: unknown = bootstrap;
  if (!isRecord(candidate)
    || typeof candidate.token !== "string" || !TOKEN_PATTERN.test(candidate.token)
    || typeof candidate.instanceId !== "string" || !IDENTITY_PATTERN.test(candidate.instanceId)
    || typeof candidate.generation !== "string" || !IDENTITY_PATTERN.test(candidate.generation)) {
    throw new Error("Invalid native input registration");
  }
  const token = candidate.token as string;
  const instanceId = candidate.instanceId as string;
  const generation = candidate.generation as string;
  const key = Buffer.from(token, "hex");
  const magic = createHmac("sha256", key)
    .update(KEY_DOMAIN).update(MAGIC_DOMAIN)
    .update(instanceId).update("\0").update(generation)
    .digest("hex").slice(0, MAGIC_CHARS);
  return { key, magic, instanceId, generation };
}

function bodyMac(key: Buffer, bodyBase64Url: string): Buffer {
  return createHmac("sha256", key)
    .update(KEY_DOMAIN).update(BODY_MAC_DOMAIN).update(bodyBase64Url).digest();
}

function frameWithKey(key: Buffer, magic: string, bodyBase64Url: string): string {
  const mac = bodyMac(key, bodyBase64Url).toString("hex");
  return `${FRAME_TAG}${magic};${bodyBase64Url.length};${bodyBase64Url};${mac}\n`;
}

/**
 * Low-level framing primitive: authenticate and frame one already-encoded body.
 * `createNativeInputEncoder` is the normal path; this exists so the framing and
 * signature stay single-sourced (including for envelope-shape tests). The body is
 * bounded so the frame stays inside the technical envelope bound; body semantics
 * are validated by the decoder.
 */
export function frameNativeInputBody(bootstrap: SessionHostBootstrap, bodyBase64Url: string): string {
  const registration = registrationOf(bootstrap);
  if (typeof bodyBase64Url !== "string" || bodyBase64Url.length === 0
    || bodyBase64Url.length > MAX_BODY_B64_CHARS
    || !PRINTABLE_ASCII.test(bodyBase64Url)
    || bodyBase64Url.includes(";")) {
    throw new Error("Invalid native input body");
  }
  return frameWithKey(registration.key, registration.magic, bodyBase64Url);
}

/**
 * Create the encoder for one registration. Dispatch ids and the global sequence
 * are allocated internally and increase monotonically; fragments of one dispatch
 * are returned contiguously in a single string.
 */
export function createNativeInputEncoder(bootstrap: SessionHostBootstrap): NativeInputEncoder {
  const registration = registrationOf(bootstrap);
  let sequence = 0;
  let dispatchId = 0;
  const encoder: NativeInputEncoder = {
    encode(payload: Buffer, origin: NativeInputOrigin): string {
      if (!Buffer.isBuffer(payload)) throw new Error("Invalid native input payload");
      if (!isValidNativeInputOrigin(origin)) throw new Error("Invalid native input origin");
      if (dispatchId >= Number.MAX_SAFE_INTEGER) throw new Error("Native input dispatch ids exhausted");
      const parts = Math.max(1, Math.ceil(payload.length / NATIVE_INPUT_RAW_FRAGMENT_BYTES));
      if (sequence + parts > Number.MAX_SAFE_INTEGER) throw new Error("Native input sequence exhausted");
      const frozen = freezeOrigin(origin);
      const nextDispatch = dispatchId + 1;
      let framed = "";
      for (let part = 0; part < parts; part += 1) {
        const start = part * NATIVE_INPUT_RAW_FRAGMENT_BYTES;
        const end = Math.min(start + NATIVE_INPUT_RAW_FRAGMENT_BYTES, payload.length);
        const body = JSON.stringify({
          v: 1,
          instanceId: registration.instanceId,
          generation: registration.generation,
          sequence: sequence + part + 1,
          dispatchId: nextDispatch,
          part,
          final: part === parts - 1,
          origin: frozen,
          encoded: payload.subarray(start, end).toString("base64url"),
        });
        if (Buffer.byteLength(body, "utf8") > MAX_BODY_JSON_BYTES) {
          throw new Error("Native input envelope exceeds its technical bound");
        }
        framed += frameWithKey(registration.key, registration.magic, Buffer.from(body, "utf8").toString("base64url"));
      }
      sequence += parts;
      dispatchId = nextDispatch;
      return framed;
    },
  };
  return Object.freeze(encoder);
}

interface OpenDispatch {
  readonly id: number;
  readonly part: number;
  readonly origin: NativeInputOrigin;
}

type SealResult = { readonly fragment: NativeInputFragment } | { readonly code: NativeInputFailureCode };

class Decoder implements NativeInputDecoder {
  #key: Buffer;
  #magic: string;
  #instanceId: string;
  #generation: string;

  #step: Step = "tag";
  #field = "";
  #body = "";
  #declaredLength = 0;
  #bodyRemaining = 0;
  #mac = "";
  #failure: NativeInputFailureCode | undefined;
  #nextSequence = 1;
  #lastDispatchId = 0;
  #open: OpenDispatch | undefined;

  constructor(registration: Registration) {
    this.#key = registration.key;
    this.#magic = registration.magic;
    this.#instanceId = registration.instanceId;
    this.#generation = registration.generation;
  }

  get failureCode(): NativeInputFailureCode | undefined {
    return this.#failure;
  }

  get bufferedBytes(): number {
    return this.#field.length + this.#body.length + this.#mac.length;
  }

  feed(chunk: Buffer | string): NativeInputFeedResult {
    const failed = this.#failure;
    if (failed !== undefined) return { ok: false, code: failed, fragments: [] };
    const fragments: NativeInputFragment[] = [];
    if (typeof chunk === "string") {
      // Frames are ASCII; anything else is corruption, never payload text.
      if (!ASCII_RUN.test(chunk)) return this.#poison("malformed-frame", fragments);
      for (let offset = 0; offset < chunk.length; offset += ASCII_WINDOW_CHARS) {
        const window = Buffer.from(chunk.slice(offset, offset + ASCII_WINDOW_CHARS), "latin1");
        const code = this.#consume(window, fragments);
        if (code !== undefined) return this.#poison(code, fragments);
      }
    } else if (Buffer.isBuffer(chunk)) {
      const code = this.#consume(chunk, fragments);
      if (code !== undefined) return this.#poison(code, fragments);
    } else {
      return this.#poison("malformed-frame", fragments);
    }
    return { ok: true, fragments };
  }

  finish(): NativeInputFeedResult {
    const failed = this.#failure;
    if (failed !== undefined) return { ok: false, code: failed, fragments: [] };
    if (this.#step !== "tag" || this.#field.length !== 0 || this.#body.length !== 0 || this.#mac.length !== 0) {
      return this.#poison("truncated-frame", []);
    }
    if (this.#open !== undefined) return this.#poison("invalid-dispatch", []);
    return { ok: true, fragments: [] };
  }

  #resetFrame(): void {
    this.#step = "tag";
    this.#field = "";
    this.#body = "";
    this.#mac = "";
    this.#declaredLength = 0;
    this.#bodyRemaining = 0;
  }

  #poison(code: NativeInputFailureCode, fragments: NativeInputFragment[]): NativeInputFeedResult {
    this.#failure = code;
    this.#open = undefined;
    this.#resetFrame();
    return { ok: false, code, fragments };
  }

  #consume(bytes: Buffer, out: NativeInputFragment[]): NativeInputFailureCode | undefined {
    let pos = 0;
    while (pos < bytes.length) {
      switch (this.#step) {
        case "tag": {
          const take = Math.min(FRAME_TAG.length - this.#field.length, bytes.length - pos);
          const piece = bytes.toString("latin1", pos, pos + take);
          if (piece !== FRAME_TAG.slice(this.#field.length, this.#field.length + take)) return "malformed-frame";
          this.#field += piece;
          pos += take;
          if (this.#field.length === FRAME_TAG.length) {
            this.#field = "";
            this.#step = "magic";
          }
          break;
        }
        case "magic": {
          const take = Math.min(bytes.length - pos, MAGIC_CHARS - this.#field.length + 1);
          const piece = bytes.toString("latin1", pos, pos + take);
          const delimiter = piece.indexOf(";");
          if (delimiter < 0) {
            this.#field += piece;
            pos += take;
            if (this.#field.length > MAGIC_CHARS) return "unknown-identity";
            break;
          }
          this.#field += piece.slice(0, delimiter);
          pos += delimiter + 1;
          if (!MAGIC_PATTERN.test(this.#field) || this.#field !== this.#magic) return "unknown-identity";
          this.#field = "";
          this.#step = "length";
          break;
        }
        case "length": {
          const take = Math.min(bytes.length - pos, MAX_LENGTH_DIGITS - this.#field.length + 1);
          const piece = bytes.toString("latin1", pos, pos + take);
          const delimiter = piece.indexOf(";");
          if (delimiter < 0) {
            this.#field += piece;
            pos += take;
            if (this.#field.length > MAX_LENGTH_DIGITS) return "oversized-frame";
            break;
          }
          this.#field += piece.slice(0, delimiter);
          pos += delimiter + 1;
          const digits = this.#field;
          this.#field = "";
          if (!/^[1-9][0-9]*$/.test(digits)) return "malformed-frame";
          const length = Number(digits);
          if (!Number.isSafeInteger(length) || length > MAX_BODY_B64_CHARS) return "oversized-frame";
          this.#declaredLength = length;
          this.#bodyRemaining = length;
          this.#body = "";
          this.#step = "body";
          break;
        }
        case "body": {
          const take = Math.min(this.#bodyRemaining, bytes.length - pos);
          const piece = bytes.toString("latin1", pos, pos + take);
          if (!BASE64URL_RUN.test(piece)) return "malformed-frame";
          this.#body += piece;
          pos += take;
          this.#bodyRemaining -= take;
          if (this.#bodyRemaining === 0) this.#step = "bodyTerminator";
          break;
        }
        case "bodyTerminator": {
          if (bytes[pos] !== 0x3b) return "malformed-frame";
          pos += 1;
          this.#mac = "";
          this.#step = "mac";
          break;
        }
        case "mac": {
          const take = Math.min(MAC_CHARS - this.#mac.length, bytes.length - pos);
          const piece = bytes.toString("latin1", pos, pos + take);
          if (!HEX_RUN.test(piece)) return "malformed-frame";
          this.#mac += piece;
          pos += take;
          if (this.#mac.length === MAC_CHARS) this.#step = "terminator";
          break;
        }
        case "terminator": {
          if (bytes[pos] !== 0x0a) return "malformed-frame";
          pos += 1;
          const sealed = this.#seal();
          this.#resetFrame();
          if ("code" in sealed) return sealed.code;
          out.push(sealed.fragment);
          break;
        }
      }
    }
    return undefined;
  }

  #seal(): SealResult {
    const bodyBase64Url = this.#body;
    const macHex = this.#mac;
    if (bodyBase64Url.length !== this.#declaredLength) return { code: "malformed-frame" };
    if (!canonicalBase64Url(bodyBase64Url, MAX_BODY_B64_CHARS, false)) return { code: "malformed-frame" };
    if (!/^[0-9a-f]{64}$/.test(macHex)) return { code: "malformed-frame" };
    const expected = bodyMac(this.#key, bodyBase64Url);
    if (!timingSafeEqual(expected, Buffer.from(macHex, "hex"))) return { code: "unauthenticated-frame" };

    const jsonBytes = Buffer.from(bodyBase64Url, "base64url");
    if (jsonBytes.length > MAX_BODY_JSON_BYTES) return { code: "oversized-frame" };
    if (jsonBytes.some((byte) => byte > 0x7f)) return { code: "malformed-frame" };
    let text: string;
    let parsed: unknown;
    try {
      text = jsonBytes.toString("utf8");
      parsed = JSON.parse(text);
    } catch {
      return { code: "malformed-frame" };
    }
    // Exact re-serialization rejects duplicate keys, extra keys, whitespace,
    // non-canonical numbers, and any other non-canonical envelope encoding.
    if (!isRecord(parsed) || !exactKeys(parsed, BODY_KEYS)) return { code: "malformed-frame" };
    let canonical: string;
    try {
      canonical = JSON.stringify(parsed);
    } catch {
      // A hostile, deeply nested envelope can exhaust the engine's recursion
      // limit here. That is malformed authenticated input, never a throw: the
      // fixed-code, poisoned-error contract still holds.
      return { code: "malformed-frame" };
    }
    if (canonical !== text) return { code: "malformed-frame" };
    if (parsed.v !== 1) return { code: "malformed-frame" };
    if (parsed.instanceId !== this.#instanceId || parsed.generation !== this.#generation) {
      return { code: "unknown-identity" };
    }
    if (!Number.isSafeInteger(parsed.sequence) || !Number.isSafeInteger(parsed.dispatchId)
      || !Number.isSafeInteger(parsed.part) || typeof parsed.final !== "boolean") {
      return { code: "malformed-frame" };
    }
    const sequence = parsed.sequence as number;
    const dispatchId = parsed.dispatchId as number;
    const part = parsed.part as number;
    const final = parsed.final as boolean;
    if (sequence !== this.#nextSequence) return { code: "invalid-sequence" };
    if (dispatchId < 1 || part < 0) return { code: "invalid-dispatch" };
    const originValue: unknown = parsed.origin;
    if (!isValidNativeInputOrigin(originValue)) return { code: "invalid-origin" };
    const origin = freezeOrigin(originValue);
    const encodedValue: unknown = parsed.encoded;
    if (!canonicalBase64Url(encodedValue, PAYLOAD_B64_MAX, true)) return { code: "malformed-frame" };
    const payload = Buffer.from(encodedValue, "base64url");
    if (payload.length > NATIVE_INPUT_RAW_FRAGMENT_BYTES) return { code: "oversized-frame" };

    const open = this.#open;
    if (open !== undefined) {
      // Same dispatch, contiguous next part, unchanged origin; anything else is
      // interleaving, reordering, a gap, an identity swap, or a replay.
      if (dispatchId !== open.id) return { code: "invalid-dispatch" };
      if (part !== open.part + 1) return { code: "invalid-dispatch" };
      if (!sameOrigin(open.origin, origin)) return { code: "invalid-origin" };
    } else {
      if (dispatchId <= this.#lastDispatchId) return { code: "invalid-dispatch" };
      if (part !== 0) return { code: "invalid-dispatch" };
    }

    const context = Object.freeze({
      origin: open === undefined ? origin : open.origin,
      dispatchId,
      part,
      start: part === 0,
      end: final,
      payload,
    });
    this.#nextSequence = sequence + 1;
    this.#lastDispatchId = dispatchId;
    this.#open = final ? undefined : { id: dispatchId, part, origin: context.origin };
    return { fragment: context };
  }
}

/** Create a streaming decoder bound to one registration; it retains at most one frame. */
export function createNativeInputDecoder(bootstrap: SessionHostBootstrap): NativeInputDecoder {
  return new Decoder(registrationOf(bootstrap));
}
