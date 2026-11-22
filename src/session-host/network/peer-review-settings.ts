/**
 * Optional owner Review-settings exchange contracts (issue #716 transport slice).
 *
 * This module is a pure contract and bounded-codec helper boundary: it performs
 * no IO, reads no ambient configuration, opens no socket, starts no timer, and
 * interprets no settings field. The exchange rides the existing authenticated
 * roster lane, which owns the optional capability, framing, authorization, and
 * the one send slot. Here an envelope is only a bounded, encoded UTF-8 JSON
 * payload (`Uint8Array`) plus the owner facts and requester result unions that
 * carry it. There is deliberately no generic RPC: no method name, command,
 * path, environment, credential, or arbitrary request/response bag can be
 * expressed.
 *
 * The owner's provider receives one closed request: the operation (`load` or
 * `save`), the exact owner run the requester named, the authenticated peer from
 * the bound channel (never a frame field), and — for a save only — the exact
 * payload bytes. It returns one closed fact set. A reusable
 * {@link OwnerReviewSettingsGuard} lets owner code re-prove the live grant, the
 * exact run, and the live opt-in at a later publication point; it is a check,
 * never a lease and never persisted state.
 *
 * Payload transfer is bounded in both directions: 16 KiB fragments, at most
 * {@link REVIEW_SETTINGS_MAX_CHUNKS} fragments, and an explicit
 * {@link REVIEW_SETTINGS_MAX_BYTES} envelope ceiling (4 MiB, above the native
 * 1 MiB configuration ceiling and not an editor limit). A transfer is only
 * complete when the announced byte count and SHA-256 match exactly; incomplete,
 * duplicated, reordered, or oversized transfer data never becomes a payload.
 */

import { createHash } from "node:crypto";
import { isRecord } from "../../record-guard";
import type { PeerKey } from "./identity";

/** Raw payload bytes carried by one fragment frame. */
export const REVIEW_SETTINGS_FRAGMENT_BYTES = 16 * 1024;
/**
 * Explicit ceiling for one complete envelope. It comfortably carries ordinary
 * native settings plus their model/catalog data (the native configuration file
 * limit is 1 MiB) and is not a UI or editor limit.
 */
export const REVIEW_SETTINGS_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Finite fragment-count ceiling. It keeps assembly bookkeeping bounded even
 * under a tiny negotiated frame size; a payload that cannot be represented in
 * this many 16 KiB-maximum fragments is refused rather than partially held.
 */
export const REVIEW_SETTINGS_MAX_CHUNKS = 4_096;
/** SHA-256 of the empty byte string, the only digest a load request announces. */
export const REVIEW_SETTINGS_EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The two operations this lane can express. Never a generic method name. */
export type ReviewSettingsOperation = "load" | "save";

/**
 * Ceiling on one auto-disabled scheduled-task identity in a save receipt,
 * measured in UTF-16 code units. A longer identity is never truncated into a
 * different id: it is counted in the receipt's exact remainder instead.
 */
export const REVIEW_SETTINGS_MAX_RECEIPT_TASK_ID = 128;
/**
 * Ceiling on listed auto-disabled identities per receipt. The list plus the
 * exact remainder count is what keeps one result frame inside every negotiated
 * frame bound without dropping or truncating a warning.
 */
export const REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS = 64;
/**
 * Ceiling on the exact auto-disabled total one receipt may report. It is
 * derived from the bounded save envelope itself: every staged scheduled entry
 * occupies far more than 64 bytes of that envelope (its id, name, cron,
 * enabled/kind flags, instructions, and workspace), so no accepted Save intent
 * within {@link REVIEW_SETTINGS_MAX_BYTES} can stage more than this many
 * entries. It therefore covers every representable Save, including entries
 * added after the opening load.
 */
export const REVIEW_SETTINGS_MAX_RECEIPT_TASKS = Math.floor(REVIEW_SETTINGS_MAX_BYTES / 64);

/**
 * The bounded, closed facts one positively confirmed Save may carry home. It
 * carries scheduled-task IDENTITIES only: never a message, task name, worker
 * resource, path, configuration value, or diagnostic. The requester renders
 * its own fixed notice and reads any display name from its own staged draft.
 */
export interface ReviewSettingsSaveReceipt {
  /** Stable identities of auto-disabled entries, in the owner's catalogue order. */
  readonly disabledTaskIds: readonly string[];
  /**
   * Auto-disabled entries beyond the bounded identity list. This is an exact
   * count from the owner's shared disable rule, never an estimate.
   */
  readonly additionalDisabledCount: number;
}

/**
 * The only identity spelling a receipt may carry, matching the canonical
 * configured-id grammar for a scheduled-task key. It is deliberately exact: an
 * identity is embedded in a fixed notice, so a quote, newline, or other
 * punctuation could never be displayed without altering that notice.
 */
const RECEIPT_TASK_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/u;

/** True only for one bounded, safely displayable receipt task identity. */
function isReceiptTaskId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= REVIEW_SETTINGS_MAX_RECEIPT_TASK_ID
    && value !== "."
    && value !== ".."
    && RECEIPT_TASK_ID_PATTERN.test(value);
}

/**
 * True only for one closed, bounded receipt: at most
 * {@link REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS} distinct identities within
 * {@link REVIEW_SETTINGS_MAX_RECEIPT_TASK_ID} and the canonical configured-id
 * grammar, and an exact remainder count that together accounts for at least
 * one and at most {@link REVIEW_SETTINGS_MAX_RECEIPT_TASKS} auto-disabled
 * entries.
 */
export function isReviewSettingsSaveReceipt(value: unknown): value is ReviewSettingsSaveReceipt {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("disabledTaskIds") || !keys.includes("additionalDisabledCount")) {
    return false;
  }
  const ids = value.disabledTaskIds;
  if (!Array.isArray(ids) || ids.length > REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS) return false;
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isReceiptTaskId(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  const additional = value.additionalDisabledCount;
  if (typeof additional !== "number" || !Number.isSafeInteger(additional)
    || additional < 0 || additional > REVIEW_SETTINGS_MAX_RECEIPT_TASKS) {
    return false;
  }
  const total = ids.length + additional;
  return total >= 1 && total <= REVIEW_SETTINGS_MAX_RECEIPT_TASKS;
}

/**
 * Compose one valid receipt from the shared disable rule's structured
 * identities, or `undefined` when nothing was auto-disabled. Identities that
 * cannot be represented within the receipt's bounds are counted in
 * {@link ReviewSettingsSaveReceipt.additionalDisabledCount} instead of being
 * truncated or dropped, and a repeated identity is the same task, never a
 * second disable. The count is never clamped: the total ceiling already covers
 * every accepted Save envelope, so an over-ceiling total would be a genuine
 * fault for the transport's closed validation to refuse, not something to
 * understate.
 */
export function buildReviewSettingsSaveReceipt(
  disabledTaskIds: readonly string[],
): ReviewSettingsSaveReceipt | undefined {
  const ids: string[] = [];
  const seen = new Set<string>();
  let additional = 0;
  for (const id of disabledTaskIds) {
    if (typeof id !== "string" || id.length === 0) {
      additional += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (!isReceiptTaskId(id) || ids.length >= REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS) {
      additional += 1;
      continue;
    }
    ids.push(id);
  }
  const total = ids.length + additional;
  if (total === 0) return undefined;
  return { disabledTaskIds: ids, additionalDisabledCount: additional };
}

/**
 * Fixed reasons one request can be refused with. The first group is refused
 * before owner work is used; `invalid-draft` and `conflict` are the owner's own
 * closed save refusals (nothing was published in either case).
 */
export const REVIEW_SETTINGS_REFUSAL_REASONS: readonly ReviewSettingsRefusalReason[] = Object.freeze([
  "admission",
  "duplicate",
  "stale",
  "policy",
  "busy",
  "limit",
  "unavailable",
  "invalid-draft",
  "conflict",
]);

export type ReviewSettingsRefusalReason =
  | "admission"
  | "duplicate"
  | "stale"
  | "policy"
  | "busy"
  | "limit"
  | "unavailable"
  /** The owner rejected the editable draft itself (malformed intent or failed owner validation). */
  | "invalid-draft"
  /** The owner positively recognized a pre-write external-worker guard: nothing was published. */
  | "conflict";

export function isReviewSettingsRefusalReason(value: unknown): value is ReviewSettingsRefusalReason {
  return typeof value === "string"
    && (REVIEW_SETTINGS_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * One closed owner observation carried by a fixed result frame. It never
 * contains a payload: a successful load is carried only by its bounded payload
 * transfer, never by an ACK that could be mistaken for delivered data.
 */
export type ReviewSettingsOutcome =
  | { readonly kind: "accepted"; readonly receipt?: ReviewSettingsSaveReceipt }
  | { readonly kind: "refused"; readonly reason: ReviewSettingsRefusalReason }
  | { readonly kind: "unknown" };

/** Closed-key validation of one result outcome, including any save receipt. */
export function isReviewSettingsOutcome(value: unknown): value is ReviewSettingsOutcome {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (value.kind === "accepted") {
    if (keys.length === 1) return keys[0] === "kind";
    return keys.length === 2 && keys.includes("kind") && keys.includes("receipt")
      && isReviewSettingsSaveReceipt(value.receipt);
  }
  if (value.kind === "unknown") {
    return keys.length === 1 && keys[0] === "kind";
  }
  if (value.kind === "refused") {
    return keys.length === 2 && keys.includes("kind") && keys.includes("reason")
      && isReviewSettingsRefusalReason(value.reason);
  }
  return false;
}

/**
 * One closed owner request. `peerKey` is the exact authenticated identity of the
 * bound channel and is never read from any frame. `payload` exists only for a
 * save, and is a private copy of exactly the bytes the requester sent.
 */
export interface OwnerReviewSettingsRequest {
  readonly kind: ReviewSettingsOperation;
  readonly hostRunId: string;
  readonly peerKey: PeerKey;
  readonly payload?: Uint8Array;
}

/**
 * One reusable live proof handed to owner code. `true` only while the exact
 * proved peer key still carries the current receiving grant, this channel's live
 * subscription still names the exact run, and the owner's live opt-in is still
 * enabled. It can be retained and called at a later publication point. A
 * `false`, a throw, or an unavailable callback means the operation must not
 * proceed; it is never a lease and never a reason to persist anything here.
 */
export type OwnerReviewSettingsGuard = () => boolean;

/** The owner's closed fact set for one load or save. */
export type OwnerReviewSettingsFacts =
  | {
    readonly kind: "accepted";
    /** A load's one bounded envelope; never present for a save. */
    readonly payload?: Uint8Array;
    /**
     * A save's bounded receipt of exactly what the owner's shared rule
     * auto-disabled. Never present for a load, never with a payload, and
     * absent when nothing was auto-disabled.
     */
    readonly receipt?: ReviewSettingsSaveReceipt;
  }
  | { readonly kind: "refused"; readonly reason: ReviewSettingsRefusalReason }
  | { readonly kind: "unknown" };

/**
 * The owner's ONE provider for this lane. It is called only after the bridge
 * has proved the live grant, the exact run, and live opt-in, and it is handed
 * the same reusable guard for its own later re-proof. A load accepts with one
 * bounded envelope; a save accepts without a payload.
 */
export type OwnerReviewSettingsHandler = (
  request: OwnerReviewSettingsRequest,
  stillAuthorized: OwnerReviewSettingsGuard,
) => OwnerReviewSettingsFacts | Promise<OwnerReviewSettingsFacts>;

/**
 * The owner's LIVE remote-configuration opt-in. `true` only means the owner
 * currently allows remote Review-settings load/save for an eligible run; any
 * other value, a throw, or an absent callback means disabled. It is read fresh
 * for every request, for every payload/publication re-proof, and for the
 * descriptive policy publication — never cached by the bridge.
 */
export type OwnerReviewSettingsPolicy = () => boolean;

/** Descriptive per-run state published to the viewer. Never authority. */
export interface OwnerReviewSettingsPolicyState {
  readonly hostRunId: string;
  readonly enabled: boolean;
}

/** Fixed reasons a requester positively never handed bytes to the transport. */
export type PeerReviewSettingsNotSentReason =
  | "capability-unsupported"
  | "not-ready"
  | "invalid-request"
  | "target-unavailable"
  | "busy"
  | "limit";

/**
 * The one fixed result a requester may observe. `owner-result` carries the
 * owner's own closed outcome; `not-sent` is returned only with positive proof
 * that no bytes reached the transport; `unknown` establishes nothing and is
 * never replayed, retried, or reconnected here.
 */
export type PeerReviewSettingsResult<Outcome> =
  | { readonly kind: "owner-result"; readonly outcome: Outcome }
  | { readonly kind: "not-sent"; readonly reason: PeerReviewSettingsNotSentReason }
  | { readonly kind: "unknown" };

/** A successful load is exactly the bounded payload the owner returned. */
export type PeerReviewSettingsLoadOutcome =
  | { readonly kind: "loaded"; readonly payload: Uint8Array }
  | { readonly kind: "refused"; readonly reason: ReviewSettingsRefusalReason }
  | { readonly kind: "unknown" };

/** A successful save is exactly the owner's acceptance, plus its bounded receipt. */
export type PeerReviewSettingsSaveOutcome =
  | { readonly kind: "accepted"; readonly receipt?: ReviewSettingsSaveReceipt }
  | { readonly kind: "refused"; readonly reason: ReviewSettingsRefusalReason }
  | { readonly kind: "unknown" };

/** The caller's own last-instant fence, evaluated at each transport write. */
export interface PeerReviewSettingsSendOptions {
  readonly stillCurrent?: () => boolean;
}

export interface PeerReviewSettingsLoadRequest {
  readonly hostRunId: string;
}

export interface PeerReviewSettingsSaveRequest {
  readonly hostRunId: string;
  readonly payload: Uint8Array;
}

/**
 * True only for one non-empty, in-bound, well-formed UTF-8 payload that parses
 * as JSON. Nothing is interpreted beyond JSON syntax; no field of the envelope
 * is read, projected, logged, or stored here.
 */
export function isReviewSettingsJsonPayload(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array)) return false;
  if (value.length === 0 || value.length > REVIEW_SETTINGS_MAX_BYTES) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return false;
  }
  try {
    JSON.parse(text);
  } catch {
    return false;
  }
  return true;
}

/** A private copy of one valid envelope, or null. Never aliases caller bytes. */
export function copyReviewSettingsPayload(value: unknown): Uint8Array | null {
  if (!isReviewSettingsJsonPayload(value)) return null;
  return Uint8Array.from(value);
}

/** Closed-key validation of the owner's fact set, including any accepted payload or receipt. */
export function isOwnerReviewSettingsFacts(value: unknown): value is OwnerReviewSettingsFacts {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "accepted": {
      const keys = Object.keys(value);
      if (keys.length === 1) return keys[0] === "kind";
      if (keys.length !== 2 || !keys.includes("kind")) return false;
      // Exactly one optional field: a load payload OR a save receipt, never both.
      if (keys.includes("payload")) return isReviewSettingsJsonPayload(value.payload);
      return keys.includes("receipt") && isReviewSettingsSaveReceipt(value.receipt);
    }
    case "refused": {
      const keys = Object.keys(value);
      return keys.length === 2 && keys.includes("kind") && isReviewSettingsRefusalReason(value.reason);
    }
    case "unknown":
      return Object.keys(value).length === 1;
    default:
      return false;
  }
}

/**
 * Bytes one fragment may carry under a negotiated complete-frame bound. The
 * fixed reserve is the same conservative envelope slack the prompted-spawn
 * transfer uses; every actual frame is still encoded and checked against the
 * bound before it is written. Zero means this lane cannot carry any payload at
 * this frame size and a transfer is refused instead of split forever.
 */
export function reviewSettingsChunkSize(maxFrameBytes: number): number {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) return 0;
  return Math.max(0, Math.min(REVIEW_SETTINGS_FRAGMENT_BYTES, Math.floor((maxFrameBytes - 512) * 3 / 4)));
}

/**
 * The largest envelope this lane can carry within the negotiated frame bound and
 * the fixed fragment-count ceiling. It is never larger than
 * {@link REVIEW_SETTINGS_MAX_BYTES}; a smaller frame bound can reduce it, and a
 * refusal is honest rather than truncation.
 */
export function reviewSettingsPayloadLimit(maxFrameBytes: number): number {
  return Math.min(REVIEW_SETTINGS_MAX_BYTES, reviewSettingsChunkSize(maxFrameBytes) * REVIEW_SETTINGS_MAX_CHUNKS);
}

export function reviewSettingsSha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** One ready-to-frame envelope: exact bytes, digest, and raw fragment parts. */
export interface ReviewSettingsEnvelopeParts {
  readonly bytes: number;
  readonly sha256: string;
  readonly chunks: readonly Buffer[];
}

/**
 * Validate, copy, digest, and fragment one envelope for either direction. Null
 * means the value is not a valid bounded UTF-8 JSON payload or cannot be
 * represented under this frame bound; nothing is truncated or partially kept.
 */
export function encodeReviewSettingsEnvelope(
  payload: unknown,
  maxFrameBytes: number,
): ReviewSettingsEnvelopeParts | null {
  if (!(payload instanceof Uint8Array)) return null;
  const limit = reviewSettingsPayloadLimit(maxFrameBytes);
  // Refuse an over-limit value BEFORE copying or fragmenting it. At a tiny
  // negotiated frame size the fragment size can be one byte, so allocating
  // every fragment first would be an unbounded amount of work for data this
  // lane can never carry.
  if (limit <= 0 || payload.length === 0 || payload.length > limit) return null;
  const bytes = copyReviewSettingsPayload(payload);
  if (bytes === null) return null;
  const size = reviewSettingsChunkSize(maxFrameBytes);
  if (size <= 0) return null;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(Buffer.from(bytes.subarray(offset, Math.min(offset + size, bytes.length))));
  }
  if (chunks.length === 0 || chunks.length > REVIEW_SETTINGS_MAX_CHUNKS) return null;
  return Object.freeze({
    bytes: bytes.length,
    sha256: reviewSettingsSha256(bytes),
    chunks: Object.freeze(chunks),
  });
}

/**
 * Bounded assembler for one inbound payload transfer. It accepts fragments only
 * in order, each canonical base64 of at most 16 KiB, never beyond the announced
 * byte count, and completes only with the exact fragment count and SHA-256.
 * Nothing is dispatched before `complete` returns the whole copied payload.
 */
export class ReviewSettingsPayloadAssembler {
  readonly bytes: number;
  readonly sha256: string;
  readonly #hash: ReturnType<typeof createHash>;
  readonly #parts: Buffer[] = [];
  #received = 0;
  #chunks = 0;
  #sealed = false;

  private constructor(bytes: number, sha256: string) {
    this.bytes = bytes;
    this.sha256 = sha256;
    this.#hash = createHash("sha256");
  }

  /** Begin one assembly, or null for a byte/digest pair this lane cannot carry. */
  static begin(bytes: number, sha256: string): ReviewSettingsPayloadAssembler | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > REVIEW_SETTINGS_MAX_BYTES) return null;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return null;
    return new ReviewSettingsPayloadAssembler(bytes, sha256);
  }

  get received(): number {
    return this.#received;
  }

  get chunks(): number {
    return this.#chunks;
  }

  /**
   * Add one fragment. `false` is final for this assembly: the caller must not
   * dispatch anything and must not reuse the object.
   */
  add(index: number, data: string): boolean {
    if (this.#sealed) return false;
    if (!Number.isSafeInteger(index) || index !== this.#chunks || this.#chunks >= REVIEW_SETTINGS_MAX_CHUNKS) {
      this.#sealed = true;
      return false;
    }
    if (typeof data !== "string" || data.length === 0
      || data.length > Math.ceil(REVIEW_SETTINGS_FRAGMENT_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      this.#sealed = true;
      return false;
    }
    let part: Buffer;
    try {
      part = Buffer.from(data, "base64");
    } catch {
      this.#sealed = true;
      return false;
    }
    if (part.length === 0 || part.length > REVIEW_SETTINGS_FRAGMENT_BYTES
      || part.toString("base64") !== data
      || part.length > this.bytes - this.#received) {
      this.#sealed = true;
      return false;
    }
    this.#hash.update(part);
    this.#parts.push(part);
    this.#received += part.length;
    this.#chunks += 1;
    return true;
  }

  /**
   * Complete the assembly. The count, byte total, and digest must all match; a
   * partial or mismatched transfer yields null and is never dispatched.
   */
  complete(chunks: number): Uint8Array | null {
    if (this.#sealed) return null;
    this.#sealed = true;
    if (!Number.isSafeInteger(chunks) || chunks !== this.#chunks) return null;
    if (this.#received !== this.bytes) return null;
    if (this.#hash.digest("hex") !== this.sha256) return null;
    return Uint8Array.from(Buffer.concat(this.#parts));
  }
}
