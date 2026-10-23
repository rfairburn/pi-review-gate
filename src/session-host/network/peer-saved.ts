/**
 * Pure owner-side Saved catalog contracts (optional Saved window phase).
 *
 * Importing this file allocates nothing, starts nothing, reads nothing, and
 * grants nothing. It declares the request shapes an owner's Saved catalog view
 * answers, the fixed facts it may report back, the fixed result a requester may
 * observe, the one entry shape that may cross the wire, and the provider shapes
 * a later owner integration supplies. There is no frame, codec, timer, store,
 * queue, retry, cache, history, or permission type here: the transport is the
 * existing roster metadata lane, which owns its own optional capability,
 * framing, bounds, and authorization.
 *
 * Boundaries these contracts encode:
 *
 * - An {@link OwnerSavedEntry} carries exactly the native Saved display data the
 *   LOCAL Saved picker row holds (`id`, `file`, `caption`, `cwd`), so a remote
 *   picker can match the local one for the selected host. Those strings are the
 *   owner's own values, preserved exactly: this contract adds no clipping,
 *   hiding, or path rule of its own, and presentation stays with the existing
 *   UI formatter. They are never request authority: the requester never sends,
 *   resolves, opens, or interprets them, and every Resume/Delete names only the
 *   opaque owner-minted catalog/result/entry ids plus the exact owner run. The
 *   owner alone maps an entry id back to its own branded row and file identity
 *   under its own live guards. No transcript, file content, search index,
 *   project/agent directory, or live child's current file is part of an entry.
 * - Browsing is windowed: a full catalog or search result of ANY size is reached
 *   through bounded windows over ONE immutable owner result. A window states the
 *   full result total and the actual offset; nothing here caps the catalog at a
 *   per-transfer bound, refines it implicitly, or truncates it silently.
 * - A query is exact: well-formed Unicode text forwarded verbatim. Nothing trims,
 *   normalizes, lowercases, or bounds it beyond what one existing lane frame can
 *   represent.
 * - Every fact set is only what the owner could positively observe, and none of
 *   them is a retry, reconnect, or replay instruction. No raw error, payload, or
 *   exception text is representable.
 * - The view is ONE ephemeral object per existing channel binding, created lazily
 *   after an authorized request and disposed with that binding. `dispose()`
 *   releases read state only and never cancels, rolls back, or claims to stop an
 *   accepted resume or delete.
 * - Delete exposure is a live owner/server policy, read at every decision point.
 *   A negotiated capability, a requester's confirmation, or a viewer-side policy
 *   description is never delete permission.
 */

import type { PeerCoordinator } from "../peer-ui-protocol";

/**
 * One Saved catalog entry: the opaque operation handle plus exactly the native
 * Saved display data of the owner's local row (`SidebarSavedRow`: id, file,
 * caption, cwd).
 *
 * - `entryId` is opaque, minted by the owner's catalog view for one result, and
 *   is the ONLY entry handle a request may name.
 * - `sessionId` is the owner row's native session id, `file` its saved
 *   conversation file path, `caption` its canonical display caption, and `cwd`
 *   its recorded working directory (empty when the catalog had none), each
 *   exactly as the owner's local row holds it. Owner display data, never
 *   interpreted here.
 */
export interface OwnerSavedEntry {
  readonly entryId: string;
  readonly sessionId: string;
  readonly file: string;
  readonly caption: string;
  readonly cwd: string;
}

/** Fresh catalog listing (replaces the view's catalog AND result). */
export interface OwnerSavedListRequest {
  /** Exact owner run the request names. */
  readonly hostRunId: string;
  /** Exact query text; empty means unfiltered. Never trimmed or normalized. */
  readonly query: string;
  /** First result position wanted. */
  readonly offset: number;
  /** Positive bounded window size. */
  readonly count: number;
}

/** Search within the current catalog (replaces the view's result only). */
export interface OwnerSavedSearchRequest extends OwnerSavedListRequest {
  readonly catalogId: string;
}

/** Another window of the SAME result. Never relists and never remints ids. */
export interface OwnerSavedWindowRequest {
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly offset: number;
  readonly count: number;
}

/** Resume one entry of one exact result through the owner's native path. */
export interface OwnerSavedResumeRequest {
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly entryId: string;
}

/** Delete one entry; `confirmed: false` asks the owner to prepare only. */
export interface OwnerSavedDeleteRequest extends OwnerSavedResumeRequest {
  readonly confirmed: boolean;
}

/** Fixed reasons a window request was refused before any data was produced. */
export type OwnerSavedWindowRefusalReason =
  | "admission"
  | "duplicate"
  | "stale"
  | "busy"
  | "range"
  | "unrepresentable";

/** Fixed reasons a resume was refused before any native resume was invoked. */
export type OwnerSavedResumeRefusalReason =
  | "admission"
  | "duplicate"
  | "stale"
  | "policy"
  | "busy";

/** Fixed reasons a delete was refused before anything was trashed or unlinked. */
export type OwnerSavedDeleteRefusalReason =
  | "admission"
  | "duplicate"
  | "stale"
  | "policy"
  | "busy"
  | "active";

export const OWNER_SAVED_WINDOW_REFUSAL_REASONS: readonly OwnerSavedWindowRefusalReason[] = Object.freeze([
  "admission",
  "duplicate",
  "stale",
  "busy",
  "range",
  "unrepresentable",
]);

export const OWNER_SAVED_RESUME_REFUSAL_REASONS: readonly OwnerSavedResumeRefusalReason[] = Object.freeze([
  "admission",
  "duplicate",
  "stale",
  "policy",
  "busy",
]);

export const OWNER_SAVED_DELETE_REFUSAL_REASONS: readonly OwnerSavedDeleteRefusalReason[] = Object.freeze([
  "admission",
  "duplicate",
  "stale",
  "policy",
  "busy",
  "active",
]);

/**
 * One window over one immutable owner result, or a fixed non-data answer.
 *
 * `window` always states the FULL result `total` (which may exceed any
 * per-transfer bound), the actual `offset`, and the honest entries returned
 * from that offset. Entry ids are unique within the window. `issueCount` is an
 * owner scalar (for example, unreadable saved items) and never a list.
 */
export type OwnerSavedWindowFacts =
  | {
    readonly kind: "window";
    readonly hostRunId: string;
    readonly catalogId: string;
    readonly resultId: string;
    readonly total: number;
    readonly issueCount: number;
    readonly offset: number;
    readonly entries: readonly OwnerSavedEntry[];
  }
  | { readonly kind: "refused"; readonly reason?: OwnerSavedWindowRefusalReason }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown" };

/** The non-data window answers carried by one fixed result frame. */
export type OwnerSavedWindowOutcome = Exclude<OwnerSavedWindowFacts, { readonly kind: "window" }>;

/**
 * Fixed resume facts. `started` names the exact owner run and the row the
 * owner's native resume path created; `refused` is reserved for a positive
 * pre-invocation decision; `unconfirmed` means a resume was addressed and
 * nothing usable came up; `unknown` claims nothing either way.
 */
export type OwnerSavedResumeFacts =
  | { readonly kind: "started"; readonly hostRunId: string; readonly rowId: string }
  | { readonly kind: "refused"; readonly reason: OwnerSavedResumeRefusalReason }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "unknown" };

/** How the owner removed one saved item. */
export type OwnerSavedDeleteMethod = "trash" | "unlink";

/**
 * Fixed delete facts. `confirmation-required` answers a prepare (or an
 * unconfirmed request) and removes nothing; `deleted` names the method the
 * owner used; `refused` is a positive pre-removal decision; `unconfirmed` means
 * a removal was addressed and its outcome could not be confirmed; `unknown`
 * claims nothing either way.
 */
export type OwnerSavedDeleteFacts =
  | { readonly kind: "confirmation-required" }
  | { readonly kind: "deleted"; readonly method: OwnerSavedDeleteMethod }
  | { readonly kind: "refused"; readonly reason: OwnerSavedDeleteRefusalReason }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "unknown" };

/**
 * One reusable synchronous re-proof handed to every provider operation: `true`
 * only while the exact proved peer key, the current receiving grant, the live
 * binding, the exact current owner run, and (for delete) the live server delete
 * policy all still hold. It is a check, never a lease; `false` or a throw means
 * the operation must not proceed past that point.
 */
export type OwnerSavedAuthorizationGuard = () => boolean;

/**
 * The owner's ONE ephemeral catalog view for one channel binding. A later owner
 * integration owns private native rows, scoped freshness, and one immutable
 * current catalog/result. `list` replaces catalog and result, `search` replaces
 * the result only, and `window` slices the SAME result without relisting or
 * reminting ids. Reads receive an abort signal that fires only when a newer read
 * supersedes them or the binding goes away.
 */
export interface OwnerSavedCatalogView {
  list(
    request: OwnerSavedListRequest,
    signal: AbortSignal,
    stillAuthorized: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedWindowFacts>;
  search(
    request: OwnerSavedSearchRequest,
    signal: AbortSignal,
    stillAuthorized: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedWindowFacts>;
  window(
    request: OwnerSavedWindowRequest,
    signal: AbortSignal,
    stillAuthorized: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedWindowFacts>;
  resume(
    request: OwnerSavedResumeRequest,
    stillAuthorized: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedResumeFacts>;
  remove(
    request: OwnerSavedDeleteRequest,
    stillAuthorized: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedDeleteFacts>;
  /** Release resource/read state only. Never cancels accepted resume/delete work. */
  dispose(): void;
}

/** Creates ONE view for one channel binding, lazily, after an authorized request. */
export type OwnerSavedCatalogViewFactory = () => OwnerSavedCatalogView;

/**
 * The owner/server's live remote-history delete exposure. `true` only means the
 * owner currently exposes remote delete; anything else, including a throw,
 * means no delete exposure and no delete acceptance.
 */
export type OwnerRemoteHistoryDeletePolicy = () => boolean;

/** Descriptive viewer-side policy state for one owner run. Never authority. */
export interface OwnerSavedPolicy {
  readonly hostRunId: string;
  readonly deleteExposed: boolean;
}

/**
 * Fixed reasons a Saved request was positively NEVER submitted to the transport.
 * Same meanings as the create exchange's reasons.
 */
export type PeerSavedNotSentReason =
  | "capability-unsupported"
  | "not-ready"
  | "invalid-request"
  | "target-unavailable"
  | "busy"
  | "limit";

/**
 * The one fixed result a requester may observe for a Saved request.
 * `owner-result` carries the owner's own fixed outcome; `not-sent` is returned
 * only with positive proof that no bytes reached the transport; `unknown`
 * establishes nothing and is never replayed, retried, or cancelled.
 */
export type PeerSavedResult<Outcome> =
  | { readonly kind: "owner-result"; readonly outcome: Outcome }
  | { readonly kind: "not-sent"; readonly reason: PeerSavedNotSentReason }
  | { readonly kind: "unknown" };

/** The caller's own optional last-instant fence, evaluated at the write boundary. */
export interface PeerSavedSendOptions {
  readonly stillCurrent?: () => boolean;
}

// ------------------------------------------------------- requester controller

/**
 * One requester-side Saved request: this side's local saved-destination handle
 * plus exactly the owner request it names. `hostId` is a local action handle and
 * never crosses the wire; every other field is copied verbatim onto a closed,
 * frozen request (unknown extra fields — UI intent ids, paths, bodies — are never
 * forwarded). `hostRunId` is REQUIRED input naming the exact owner run and is
 * never rewritten to a newer one.
 */
export type PeerSavedTarget<Request> = { readonly hostId: string } & Request;

export type PeerSavedListTarget = PeerSavedTarget<OwnerSavedListRequest>;
export type PeerSavedSearchTarget = PeerSavedTarget<OwnerSavedSearchRequest>;
export type PeerSavedWindowTarget = PeerSavedTarget<OwnerSavedWindowRequest>;
export type PeerSavedResumeTarget = PeerSavedTarget<OwnerSavedResumeRequest>;
export type PeerSavedDeleteTarget = PeerSavedTarget<OwnerSavedDeleteRequest>;

/**
 * The caller's own proof, REQUIRED for every controller request: `true` only
 * while the caller still owns this exact logical read (or the actually written
 * mutation frame) it built the request from. It is evaluated at admission and
 * again synchronously inside the ordered write that is about to call the
 * transport, with this side's own destination facts re-proved after it returns.
 * A missing, non-function, `false`, or throwing proof refuses before any write.
 */
export interface PeerSavedControllerOptions {
  readonly stillCurrent: () => boolean;
}

/**
 * The one requester-side Saved controller owned by the existing peer
 * coordinator. It exists from construction and needs no selection, displayed
 * row, native tuple, focus, controller lease, or on-demand connection: it rides
 * the destination's existing connected metadata channel under the same verified
 * pin, destination epoch, and exact owner run as every other owner request.
 *
 * Every method never throws and never surfaces a raw error. `not-sent` is
 * returned only with positive proof that no bytes were handed to the transport;
 * an `owner-result` is exactly what the captured request observed for its own
 * exact owner run; anything else is `unknown`, which is never retried, replayed,
 * or cancelled. There is no queue, retry, cache, or timer here: one Saved
 * operation is pending per channel, a newer read supersedes an older read, and a
 * resume or delete is never superseded.
 */
export interface PeerSavedController {
  list(target: PeerSavedListTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedWindowFacts>>;
  search(target: PeerSavedSearchTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedWindowFacts>>;
  window(target: PeerSavedWindowTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedWindowFacts>>;
  resume(target: PeerSavedResumeTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedResumeFacts>>;
  remove(target: PeerSavedDeleteTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedDeleteFacts>>;
}

/**
 * The production coordinator interface for a host that also carries Saved:
 * every existing promise, plus the one Saved controller. A coordinator built
 * without the requester opt-in keeps the controller inert (every request is
 * `not-sent` with `capability-unsupported`) and offers nothing new on the wire.
 */
export interface PeerCoordinatorWithSaved extends PeerCoordinator {
  readonly ownerSaved: PeerSavedController;
}

// ---------------------------------------------------------------- guards

/**
 * The metadata lane's fixed opaque-identifier shape, mirrored so this module
 * never imports the wire module (which imports this one). The wire still applies
 * its negotiated `maxIdentifierBytes`; this is the same rule at the default.
 */
const SAVED_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAVED_IDENTIFIER_MAX_BYTES = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  if (own.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

/** True for a bounded, non-empty opaque identifier the lane can carry. */
export function isOwnerSavedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= SAVED_IDENTIFIER_MAX_BYTES
    && SAVED_IDENTIFIER_RE.test(value);
}

/** True when every surrogate is paired: the text is representable UTF-8. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * True for an exact query: any well-formed Unicode string, including the empty
 * (unfiltered) query and text with spaces. There is deliberately no length rule
 * here: the only size bound is that one encoded request frame must fit the lane.
 */
export function isOwnerSavedQuery(value: unknown): value is string {
  return typeof value === "string" && isWellFormedUnicode(value);
}

/**
 * True for one native Saved display string (session id, file, caption, cwd):
 * any well-formed Unicode string, so it survives the JSON wire exactly. This
 * contract deliberately adds NO length, character-class, or path-shape rule of
 * its own: the values are the owner's native row data, a legal row is never
 * refused or clipped here, and the existing UI formatter owns presentation.
 * Size is bounded only by the existing per-window transfer budget.
 */
export function isOwnerSavedText(value: unknown): value is string {
  return typeof value === "string" && isWellFormedUnicode(value);
}

/** A safe, non-negative scalar (offset, total, issue count). */
export function isOwnerSavedScalar(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The closed entry key set, in canonical wire order. */
export const OWNER_SAVED_ENTRY_KEYS: readonly (keyof OwnerSavedEntry)[] = Object.freeze([
  "entryId",
  "sessionId",
  "file",
  "caption",
  "cwd",
]);

/** Exactly one entry: the closed key set, an opaque id, and exact native text. */
export function isOwnerSavedEntry(value: unknown): value is OwnerSavedEntry {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, OWNER_SAVED_ENTRY_KEYS)) return false;
  return isOwnerSavedIdentifier(value.entryId)
    && isOwnerSavedText(value.sessionId)
    && isOwnerSavedText(value.file)
    && isOwnerSavedText(value.caption)
    && isOwnerSavedText(value.cwd);
}

function isReason<Reason extends string>(value: unknown, reasons: readonly Reason[]): value is Reason {
  return typeof value === "string" && (reasons as readonly string[]).includes(value);
}

/** One fixed non-data window answer and nothing else. */
export function isOwnerSavedWindowOutcome(value: unknown): value is OwnerSavedWindowOutcome {
  if (!isPlainObject(value)) return false;
  const kind = value.kind;
  if (kind === "unavailable" || kind === "unknown") return hasExactKeys(value, ["kind"]);
  if (kind !== "refused") return false;
  if (hasExactKeys(value, ["kind"])) return true;
  return hasExactKeys(value, ["kind", "reason"]) && isReason(value.reason, OWNER_SAVED_WINDOW_REFUSAL_REASONS);
}

/**
 * One coherent window or one fixed non-data answer. A window's offset never
 * exceeds its total, its entries never run past the total, and its entry ids are
 * unique. Nothing is allocated from `total`.
 */
export function isOwnerSavedWindowFacts(value: unknown): value is OwnerSavedWindowFacts {
  if (!isPlainObject(value)) return false;
  if (value.kind !== "window") return isOwnerSavedWindowOutcome(value);
  if (!hasExactKeys(value, ["kind", "hostRunId", "catalogId", "resultId", "total", "issueCount", "offset", "entries"])) {
    return false;
  }
  if (!isOwnerSavedIdentifier(value.hostRunId)
    || !isOwnerSavedIdentifier(value.catalogId)
    || !isOwnerSavedIdentifier(value.resultId)) return false;
  if (!isOwnerSavedScalar(value.total) || !isOwnerSavedScalar(value.issueCount) || !isOwnerSavedScalar(value.offset)) {
    return false;
  }
  if (value.offset > value.total) return false;
  const entries = value.entries;
  if (!Array.isArray(entries)) return false;
  if (entries.length > value.total - value.offset) return false;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isOwnerSavedEntry(entry)) return false;
    if (seen.has(entry.entryId)) return false;
    seen.add(entry.entryId);
  }
  return true;
}

/** One fixed resume fact set and nothing else. */
export function isOwnerSavedResumeFacts(value: unknown): value is OwnerSavedResumeFacts {
  if (!isPlainObject(value)) return false;
  const kind = value.kind;
  if (kind === "unconfirmed" || kind === "unknown") return hasExactKeys(value, ["kind"]);
  if (kind === "refused") {
    return hasExactKeys(value, ["kind", "reason"]) && isReason(value.reason, OWNER_SAVED_RESUME_REFUSAL_REASONS);
  }
  if (kind !== "started") return false;
  return hasExactKeys(value, ["kind", "hostRunId", "rowId"])
    && isOwnerSavedIdentifier(value.hostRunId)
    && isOwnerSavedIdentifier(value.rowId);
}

/** One fixed delete fact set and nothing else. */
export function isOwnerSavedDeleteFacts(value: unknown): value is OwnerSavedDeleteFacts {
  if (!isPlainObject(value)) return false;
  const kind = value.kind;
  if (kind === "confirmation-required" || kind === "unconfirmed" || kind === "unknown") {
    return hasExactKeys(value, ["kind"]);
  }
  if (kind === "refused") {
    return hasExactKeys(value, ["kind", "reason"]) && isReason(value.reason, OWNER_SAVED_DELETE_REFUSAL_REASONS);
  }
  if (kind !== "deleted") return false;
  return hasExactKeys(value, ["kind", "method"]) && (value.method === "trash" || value.method === "unlink");
}

/** True only for an object that really implements every view operation. */
export function isOwnerSavedCatalogView(value: unknown): value is OwnerSavedCatalogView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.list === "function"
    && typeof record.search === "function"
    && typeof record.window === "function"
    && typeof record.resume === "function"
    && typeof record.remove === "function"
    && typeof record.dispose === "function";
}
