/**
 * Authenticated input-origin codec for the existing host stdin bridge.
 *
 * This is a pure framing utility: no timers, no environment or capture toggles,
 * and no behavior of its own — it only frames and verifies bytes for the one host
 * encoder and the one child bridge that explicitly opt in. It is NOT a
 * network-input capability, a trusted-viewer receipt, a provenance claim, a
 * physical-clipboard coverage statement, or an input permission. Nothing here
 * enables remote input; current network input and copy behavior remain unchanged
 * and disabled, and the default unframed bridge stays byte-for-byte unchanged.
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
 *    "origin",["expectedNativeTuple"],"encoded"} where "encoded" is the unpadded
 *   canonical base64url of the raw payload bytes. The optional
 *   "expectedNativeTuple" is {"sessionId","epoch"} and is present exactly for
 *   `viewer` dispatches: it names the native conversation the child must still be
 *   in before ANY fragment of this dispatch may reach a native input listener, and
 *   the signature covers it together with the payload. `local` and `none` bodies
 *   are encoded exactly as before and never carry it.
 * - <mac> is HMAC-SHA256(key, domain | "body-mac" | exact base64url body). The
 *   signature covers the complete body, never a header alone, and therefore the
 *   payload. The key is the existing registration token (hex64); this module does
 *   not define a new identity or a broader authority.
 *
 * Frames are ASCII only so an existing Node stdin UTF-8 decoder cannot corrupt
 * split Unicode before the bridge integration. Payload bytes are never decoded to
 * text here; the bridge owns a per-dispatch string decoder.
 *
 * A stale `expectedNativeTuple` is an ordinary input REFUSAL, not protocol
 * corruption: the bridge consumes the authenticated frames, delivers none of that
 * dispatch's payload, and stays usable for the next dispatch. Only malformed,
 * unauthenticated, foreign, replayed, out-of-order, oversized, or truncated
 * framing is a decoder failure.
 *
 * A decoder is strict: on any malformed, unauthenticated, foreign, replayed,
 * out-of-order, oversized, or truncated input it reports one fixed code and is
 * poisoned for the rest of its lifetime. It never falls back to raw/legacy
 * keystroke passthrough, never retargets, never replays, and never delivers a
 * payload that was not fully authenticated. Previously delivered input may
 * already have executed; this module makes no rollback or cancellation claim.
 *
 * The same module mints, parses, and verifies the host-minted opaque viewer scope
 * token carried by a `viewer` origin ({@linkcode mintNativeViewerScopeToken},
 * {@linkcode parseNativeViewerScopeToken}, {@linkcode verifyNativeViewerScopeToken}).
 * That token is a bounded commitment to the immutable facts of one viewer's input
 * scope under one registration, so a native copy observed on a child's stdout can
 * be returned to exactly the viewer whose input caused it. It is descriptive and
 * echoable, never a grant: authority stays with the host's own live-record, mode,
 * and current-fact checks, and a token can never choose a target on its own.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidNativeSessionId, type SessionHostBootstrap } from "./protocol";

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

/**
 * The native conversation one `viewer` dispatch was admitted against. The child
 * compares it with its own current conversation before delivering any fragment of
 * that dispatch, so a session change cannot receive bytes meant for an older one.
 * It is an expected-value fence inside an already-authenticated frame: the child
 * never trusts it as an identifier and no caller chooses it from unqualified
 * bytes.
 */
export interface NativeInputExpectedTuple {
  readonly sessionId: string;
  readonly epoch: number;
}

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
  /**
   * Frozen expected native tuple, present exactly for `viewer` dispatches and
   * identical for every part of one dispatch. `undefined` for `local` and `none`,
   * whose existing per-dispatch tuple capture and semantics are unchanged.
   */
  readonly expectedNativeTuple: NativeInputExpectedTuple | undefined;
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
   *
   * `expectedNativeTuple` is required exactly for a `viewer` origin and forbidden
   * for `local` and `none`, so the closed shape keeps the fence from being claimed
   * by a dispatch that never admitted one. A malformed tuple, a viewer dispatch
   * without one, or a non-viewer dispatch carrying one is a caller error that
   * throws a fixed message never echoing the payload, token, or tuple.
   */
  encode(
    payload: Buffer,
    origin: NativeInputOrigin,
    expectedNativeTuple?: NativeInputExpectedTuple,
  ): string;
}

/** Technical fragment transport bound; this is not a paste or product limit. */
export const NATIVE_INPUT_RAW_FRAGMENT_BYTES = 32 * 1024;
/** Bound for the opaque viewer token carried inside an origin. */
export const NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS = 128;
/** Bound for one host-minted viewer scope token; identical to the origin bound. */
export const NATIVE_INPUT_VIEWER_SCOPE_TOKEN_CHARS = NATIVE_INPUT_MAX_VIEWER_TOKEN_CHARS;

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
const BODY_KEYS_WITH_TUPLE = ["v", "instanceId", "generation", "sequence", "dispatchId", "part", "final",
  "origin", "expectedNativeTuple", "encoded"] as const;
const MAGIC_PATTERN = /^[0-9a-f]{16}$/;
/** Mirrors the existing descriptor's UUID-like bounded identity shape. */
const IDENTITY_PATTERN = /^[0-9a-f-]{1,128}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const HEX_RUN = /^[0-9a-f]*$/;
const BASE64URL_RUN = /^[A-Za-z0-9_-]+$/;
const ASCII_RUN = /^[\x00-\x7f]*$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** One canonical viewer scope token: tag, opaque single-label handle, commitment. */
const SCOPE_PATTERN = /^nvs1\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([0-9a-f]{32})$/;
const SCOPE_DOMAIN = "pi-review-gate/native-input-viewer-scope/v1\0";
/** Separate commitment key per registration identity, derived below {@linkcode KEY_DOMAIN}. */
const SCOPE_KEY_DOMAIN = "viewer-scope-key\0";
const SCOPE_COMMITMENT_CHARS = 32;
const SCOPE_FIELD_MAX_CHARS = 128;
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

function freezeExpectedTuple(tuple: NativeInputExpectedTuple): NativeInputExpectedTuple {
  return Object.freeze({ sessionId: tuple.sessionId, epoch: tuple.epoch });
}

function sameExpectedTuple(
  left: NativeInputExpectedTuple | undefined,
  right: NativeInputExpectedTuple | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.sessionId === right.sessionId && left.epoch === right.epoch;
}

function isValidExpectedTuple(value: unknown): value is NativeInputExpectedTuple {
  return isRecord(value) && exactKeys(value, ["sessionId", "epoch"])
    && isValidNativeSessionId(value.sessionId)
    && Number.isSafeInteger(value.epoch) && (value.epoch as number) >= 1;
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

/**
 * Canonical envelope JSON: `JSON.stringify` plus ASCII escaping of every
 * non-ASCII character. The envelope itself stays pure ASCII bytes — the existing
 * "no byte above 0x7f" envelope rule and the exact re-serialization check are
 * unchanged — while a field whose own domain permits non-ASCII text (a native
 * conversation identity) still round-trips exactly. Local and protocol-reply
 * bodies contain no non-ASCII character, so their bytes are unaffected.
 */
function canonicalBodyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
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
    encode(
      payload: Buffer,
      origin: NativeInputOrigin,
      expectedNativeTuple?: NativeInputExpectedTuple,
    ): string {
      if (!Buffer.isBuffer(payload)) throw new Error("Invalid native input payload");
      if (!isValidNativeInputOrigin(origin)) throw new Error("Invalid native input origin");
      // Closed expected-tuple shape: exactly one viewer dispatch may carry one.
      if (expectedNativeTuple !== undefined && !isValidExpectedTuple(expectedNativeTuple)) {
        throw new Error("Invalid native input expected tuple");
      }
      if ((origin.kind === "viewer") !== (expectedNativeTuple !== undefined)) {
        throw new Error("Invalid native input expected tuple");
      }
      if (dispatchId >= Number.MAX_SAFE_INTEGER) throw new Error("Native input dispatch ids exhausted");
      const parts = Math.max(1, Math.ceil(payload.length / NATIVE_INPUT_RAW_FRAGMENT_BYTES));
      if (sequence + parts > Number.MAX_SAFE_INTEGER) throw new Error("Native input sequence exhausted");
      const frozen = freezeOrigin(origin);
      const frozenTuple = expectedNativeTuple === undefined ? undefined : freezeExpectedTuple(expectedNativeTuple);
      const nextDispatch = dispatchId + 1;
      let framed = "";
      for (let part = 0; part < parts; part += 1) {
        const start = part * NATIVE_INPUT_RAW_FRAGMENT_BYTES;
        const end = Math.min(start + NATIVE_INPUT_RAW_FRAGMENT_BYTES, payload.length);
        const body = canonicalBodyJson({
          v: 1,
          instanceId: registration.instanceId,
          generation: registration.generation,
          sequence: sequence + part + 1,
          dispatchId: nextDispatch,
          part,
          final: part === parts - 1,
          origin: frozen,
          ...(frozenTuple === undefined ? {} : { expectedNativeTuple: frozenTuple }),
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
  readonly expectedNativeTuple: NativeInputExpectedTuple | undefined;
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
    // non-canonical numbers, and any other non-canonical envelope encoding. The
    // expected native tuple is an optional key, so a body without it keeps its
    // original canonical shape exactly.
    if (!isRecord(parsed)) return { code: "malformed-frame" };
    const hasExpectedTuple = Object.hasOwn(parsed, "expectedNativeTuple");
    if (!exactKeys(parsed, BODY_KEYS) && !exactKeys(parsed, BODY_KEYS_WITH_TUPLE)) {
      return { code: "malformed-frame" };
    }
    // Canonical means canonical ORDER as well as canonical content: the key set is
    // exact and the keys appear in the encoder's fixed order, so one authenticated
    // fact set has exactly one byte representation. A body that reorders otherwise
    // perfect fields is a different envelope, not an equivalent spelling.
    const canonicalOrder = hasExpectedTuple ? BODY_KEYS_WITH_TUPLE : BODY_KEYS;
    if (!Object.keys(parsed).every((key, index) => key === canonicalOrder[index])) {
      return { code: "malformed-frame" };
    }
    let canonical: string;
    try {
      canonical = canonicalBodyJson(parsed);
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
    // The expected native tuple is authenticated framing, so a bad shape is a
    // malformed frame. Its VALUE is never validated here: a stale expectation is
    // an ordinary refusal the bridge makes per fragment, not protocol corruption.
    let expectedValue: NativeInputExpectedTuple | undefined;
    if (hasExpectedTuple) {
      if (!isValidExpectedTuple(parsed.expectedNativeTuple)) return { code: "malformed-frame" };
      expectedValue = freezeExpectedTuple(parsed.expectedNativeTuple);
    }
    // Closed classification: a viewer dispatch without its fence is an incomplete
    // origin, and a non-viewer dispatch claiming one is a mislabeled origin.
    if ((origin.kind === "viewer") !== (expectedValue !== undefined)) return { code: "invalid-origin" };
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
      // The native-conversation fence is one immutable fact per logical dispatch.
      if (!sameExpectedTuple(open.expectedNativeTuple, expectedValue)) return { code: "invalid-dispatch" };
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
      expectedNativeTuple: open === undefined ? expectedValue : open.expectedNativeTuple,
    });
    this.#nextSequence = sequence + 1;
    this.#lastDispatchId = dispatchId;
    this.#open = final
      ? undefined
      : { id: dispatchId, part, origin: context.origin, expectedNativeTuple: context.expectedNativeTuple };
    return { fragment: context };
  }
}

/** Create a streaming decoder bound to one registration; it retains at most one frame. */
export function createNativeInputDecoder(bootstrap: SessionHostBootstrap): NativeInputDecoder {
  return new Decoder(registrationOf(bootstrap));
}

/**
 * The immutable facts one viewer scope token commits to. Every field is a fact the
 * host already owns — the host run that registered the viewer, the viewer's own
 * identity and revision, the row it displays, the exact registration, the current
 * native conversation tuple, and the row's canonical geometry and its revision —
 * and none of them is chosen by the caller of a write. Terminal TEXT changes are
 * deliberately absent: new output on an unchanged conversation never moves the
 * input owner.
 */
export interface NativeViewerScopeFacts {
  readonly hostRunId: string;
  readonly viewerId: string;
  readonly viewerRevision: number;
  readonly rowId: string;
  readonly registrationIdentity: string;
  readonly registrationGeneration: string;
  readonly nativeSessionId: string;
  readonly nativeSessionEpoch: number;
  readonly cols: number;
  readonly rows: number;
  readonly geometryRevision: number;
}

/** The only thing a scope token exposes to a parser: its opaque viewer handle. */
export interface NativeViewerScopeHandle {
  readonly viewerId: string;
}

const SCOPE_TAG = "nvs1.";
/** The handle label shape is the same one {@linkcode SCOPE_PATTERN} parses. */
const SCOPE_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SCOPE_COMMITMENT_PATTERN = /^[0-9a-f]{32}$/;

function scopeField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SCOPE_FIELD_MAX_CHARS
    && PRINTABLE_ASCII.test(value);
}

function scopeOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Closed, strictly bounded fact shape; anything else mints and verifies nothing. */
function isValidScopeFacts(value: unknown): value is NativeViewerScopeFacts {
  if (!isRecord(value) || !exactKeys(value, [
    "hostRunId", "viewerId", "viewerRevision", "rowId", "registrationIdentity", "registrationGeneration",
    "nativeSessionId", "nativeSessionEpoch", "cols", "rows", "geometryRevision",
  ])) {
    return false;
  }
  const viewerId: unknown = value.viewerId;
  const epoch: unknown = value.nativeSessionEpoch;
  const cols: unknown = value.cols;
  const rows: unknown = value.rows;
  return scopeField(value.hostRunId)
    && typeof viewerId === "string" && SCOPE_HANDLE_PATTERN.test(viewerId)
    && scopeOrdinal(value.viewerRevision)
    && scopeField(value.rowId)
    && scopeField(value.registrationIdentity)
    && scopeField(value.registrationGeneration)
    // The native conversation identity keeps the protocol's own domain: opaque,
    // bounded in UTF-8 bytes, path-free and control-free, and it may be non-ASCII.
    && isValidNativeSessionId(value.nativeSessionId)
    && scopeOrdinal(epoch) && epoch >= 1
    && scopeOrdinal(cols) && cols >= 1
    && scopeOrdinal(rows) && rows >= 1
    && scopeOrdinal(value.geometryRevision);
}

/**
 * Domain-separated commitment under THIS registration's existing bootstrap key.
 * No new secret, no new state, and no reusable digest: a different registration,
 * run, row, registration identity/generation, native tuple, geometry revision, or
 * viewer revision produces a different commitment.
 */
function scopeCommitment(key: Buffer, facts: NativeViewerScopeFacts): string {
  // Every validated field excludes NUL (the printable-ASCII fields by shape, the
  // native conversation identity by the protocol's own control-free rule), so the
  // separators cannot appear inside a value and the encoding cannot be re-associated.
  return createHmac("sha256", key)
    .update(SCOPE_DOMAIN)
    .update(facts.hostRunId).update("\0")
    .update(facts.viewerId).update("\0")
    .update(String(facts.viewerRevision)).update("\0")
    .update(facts.rowId).update("\0")
    .update(facts.registrationIdentity).update("\0")
    .update(facts.registrationGeneration).update("\0")
    .update(facts.nativeSessionId).update("\0")
    .update(String(facts.nativeSessionEpoch)).update("\0")
    .update(String(facts.cols)).update("\0")
    .update(String(facts.rows)).update("\0")
    .update(String(facts.geometryRevision))
    .digest("hex").slice(0, SCOPE_COMMITMENT_CHARS);
}

/**
 * The commitment key one fact set is bound to, or undefined when it is bound to
 * nothing. The key is derived from this registration's own identity and generation
 * rather than used as raw key bytes, and the facts must name that same
 * registration: a foreign instance, a rotated generation, or facts describing
 * another registration produces a different key or no key at all, and never a
 * coincidence of shared key material.
 */
function scopeKey(bootstrap: SessionHostBootstrap, facts: NativeViewerScopeFacts): Buffer | undefined {
  if (!isValidScopeFacts(facts)) return undefined;
  let registration: Registration;
  try {
    registration = registrationOf(bootstrap);
  } catch {
    // A malformed registration mints nothing; it never throws into a caller's
    // input path and never falls back to another key.
    return undefined;
  }
  if (facts.registrationIdentity !== registration.instanceId
    || facts.registrationGeneration !== registration.generation) return undefined;
  return createHmac("sha256", registration.key)
    .update(KEY_DOMAIN).update(SCOPE_KEY_DOMAIN)
    .update(registration.instanceId).update("\0").update(registration.generation)
    .digest();
}

/**
 * Mint one host-side viewer scope token: `<handle>.<commitment>` inside the
 * existing opaque-origin bound. Returns undefined when the facts are incomplete or
 * the token would not fit the bound — the caller then has no input source, which is
 * a refusal, never a partially described one.
 */
export function mintNativeViewerScopeToken(
  bootstrap: SessionHostBootstrap, facts: NativeViewerScopeFacts,
): string | undefined {
  if (!isValidScopeFacts(facts)) return undefined;
  const key = scopeKey(bootstrap, facts);
  if (key === undefined) return undefined;
  const token = `${SCOPE_TAG}${facts.viewerId}.${scopeCommitment(key, facts)}`;
  return token.length <= NATIVE_INPUT_VIEWER_SCOPE_TOKEN_CHARS ? token : undefined;
}

/**
 * Canonical parse of one scope token: tag, single opaque handle, 32-hex
 * commitment, nothing else. Parsing is only a lookup aid — it authenticates
 * nothing, and an unparseable token never reaches a viewer.
 */
export function parseNativeViewerScopeToken(token: unknown): NativeViewerScopeHandle | undefined {
  if (typeof token !== "string") return undefined;
  const match = SCOPE_PATTERN.exec(token);
  if (match === null) return undefined;
  return Object.freeze({ viewerId: match[1]! });
}

/**
 * Verify a received scope token against the CURRENT facts and THIS registration's
 * key: the handle must name the same viewer the facts describe, and the commitment
 * must match the one recomputed now, in constant time. A token is only ever
 * evidence that these facts were the facts; it grants nothing by itself, and a
 * retired viewer, replaced row, new run, new registration, new native epoch, ABA
 * geometry change, or newer viewer revision verifies to false.
 */
export function verifyNativeViewerScopeToken(
  bootstrap: SessionHostBootstrap, token: unknown, facts: NativeViewerScopeFacts,
): boolean {
  // Facts are validated before anything touches them: a hostile caller cannot make
  // verification throw on a malformed fact set.
  if (!isValidScopeFacts(facts)) return false;
  const handle = parseNativeViewerScopeToken(token);
  if (handle === undefined || handle.viewerId !== facts.viewerId) return false;
  const key = scopeKey(bootstrap, facts);
  if (key === undefined) return false;
  const received = (token as string).slice(SCOPE_TAG.length + handle.viewerId.length + 1);
  if (!SCOPE_COMMITMENT_PATTERN.test(received)) return false;
  const expected = Buffer.from(scopeCommitment(key, facts), "latin1");
  const actual = Buffer.from(received, "latin1");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
