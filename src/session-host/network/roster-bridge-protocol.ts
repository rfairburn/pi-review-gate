/**
 * Bounded roster metadata wire protocol (issue #478).
 *
 * This module is a pure contract: frame shapes, fixed codes, finite bounds,
 * negotiation, page packing, and encode/decode. It performs no IO, reads no
 * ambient configuration, opens no socket, starts no timer, and is not imported
 * by the extension entry point, session host, sidebar, instances, or owning-host
 * service. Importing it allocates nothing that outlives the call.
 *
 * The metadata channel rides an already-authenticated {@link PeerByteChannel},
 * which preserves each binary WebSocket message. One binary message therefore
 * carries exactly one complete UTF-8 JSON protocol frame: there is no
 * newline-delimited stream, no partial-frame assembler, and no custom framing
 * layer. A frame that cannot be decoded or encoded within its bound fails
 * closed; it is never split, trimmed, or partially applied.
 *
 * Versioning is deliberately separate from the child IPC protocol: this service
 * has its own name and major/minor pair (major 1, minor 0). The required
 * baseline capability `roster-v1` must be offered by the viewer; a different
 * service name, a different major version, or a missing required capability is
 * refused outright. Optional capability identifiers are bounded, deduplicated,
 * and ignored unless both sides know them, and nothing is enabled by a minor
 * version alone.
 *
 * Every transfer is a complete authoritative snapshot of the owner's roster,
 * never a delta: `snapshot_begin` announces one transfer, sequential
 * `snapshot_page` frames carry the rows, and `snapshot_end` completes it. A
 * revision may jump; only a regression against the same run is invalid. Rows
 * are the display-safe {@link RemoteSessionMetadata} boundary only — no agent
 * directory, current file, prompt, transcript, question, environment,
 * configuration, token, or output byte can be expressed in this schema, and an
 * unknown key is refused rather than passed through.
 *
 * The same lane, direction, and authentication also carry the optional owner
 * Close exchange (`close_request` / `close_result`) when and only when both sides
 * acknowledged {@link ROSTER_BRIDGE_CLOSE_CAPABILITY}. A close frame is a fixed
 * request for exactly one owner run and row plus one fixed fact set in reply; it
 * carries no payload, error, signal, path, or native conversation tuple, and it
 * adds no listener, manager, grant, or persisted state. Metadata semantics —
 * pages, revisions, runs, subscriptions — are completely unaffected by it.
 *
 * The optional ROWLESS owner-create exchange (`create_request` / `create_result`)
 * rides that same lane under the same rules and only when both sides
 * acknowledged {@link ROSTER_BRIDGE_CREATE_CAPABILITY}. One request names this
 * owner's exact run, one canonical workspace, and a per-channel monotonic
 * sequence; nothing in it is a row id, a native conversation tuple, a display
 * fact, or a path decision. It adds no listener, manager, grant, queue, replay
 * cache, or persisted state, and metadata semantics are untouched by it.
 *
 * The optional Saved catalog exchange rides that same lane under the same rules
 * and only when both sides acknowledged {@link ROSTER_BRIDGE_SAVED_CAPABILITY}.
 * Requests are closed-key frames naming one exact owner run, opaque owner-minted
 * catalog/result/entry ids, an exact query, a bounded window, and the shared
 * per-channel monotonic sequence. A successful window is one bounded
 * `saved_window_begin` / page / `saved_window_end` transfer that always states
 * the FULL result total, the actual offset, and the honest number of rows
 * returned: it carries the longest contiguous prefix that fits the existing
 * per-transfer bounds and never silently omits a row. Entries carry the owner's
 * exact native Saved display strings; one legal entry too large for a single
 * frame is carried whole as consecutive `saved_window_fragment` frames inside
 * the same window budget, never clipped or dropped. The roster snapshot codec
 * and packer are untouched by any of it, so a roster that does not fit is still
 * refused whole. `saved_policy` describes the owner's live delete exposure and is
 * never authority. Nothing here adds a listener, manager, grant, queue, replay
 * cache, history, or persisted state.
 */

import { isRecord } from "../../record-guard";
import { isOwnerCloseFacts, type OwnerCloseFacts } from "./peer-close";
import {
  isOwnerCreateFacts,
  isOwnerCreateWorkspace,
  type OwnerCreateFacts,
} from "./peer-create";
import {
  OWNER_SAVED_ENTRY_KEYS,
  isOwnerSavedDeleteFacts,
  isOwnerSavedQuery,
  isOwnerSavedText,
  isWellFormedUnicode,
  isOwnerSavedResumeFacts,
  isOwnerSavedWindowOutcome,
  type OwnerSavedDeleteFacts,
  type OwnerSavedEntry,
  type OwnerSavedResumeFacts,
  type OwnerSavedWindowOutcome,
} from "./peer-saved";
import { parseRemoteSessionMetadata, type RemoteSessionMetadata } from "./roster-metadata";

/** Service identity of the metadata channel; distinct from the child IPC protocol. */
export const ROSTER_BRIDGE_SERVICE = "pi-peer-roster-v1";
/** Incompatible-change version. A mismatch is refused, never adapted. */
export const ROSTER_BRIDGE_MAJOR = 1;
/** Additive-change version. Grants no capability and enables no behavior. */
export const ROSTER_BRIDGE_MINOR = 0;
/** Every viewer must offer this; a hello without it is refused. */
export const ROSTER_BRIDGE_REQUIRED_CAPABILITY = "roster-v1";
/**
 * Optional capability for the owner Close exchange. It means protocol support
 * only, never authority: the owner acknowledges it solely when it really holds
 * its own close provider, and every request is still authorized and preflighted
 * by that owner. A peer that does not offer it is never sent a close frame.
 */
export const ROSTER_BRIDGE_CLOSE_CAPABILITY = "roster-close-v1";
/**
 * Optional capability for the rowless owner-create exchange. Like Close, it means
 * protocol support only, never authority: the owner acknowledges it solely when
 * it really holds its own create provider, and every request is still authorized
 * and re-proved by that owner before its provider is invoked. It is known here but
 * is never offered by default, so nothing about the existing lane activates by
 * this declaration alone.
 */
export const ROSTER_BRIDGE_CREATE_CAPABILITY = "roster-create-v1";
/**
 * Optional capability for the Saved catalog exchange. It states that the owner
 * really holds a Saved catalog view factory AND a live delete-policy callback;
 * it is implementation support only, never authority and never delete
 * permission. Every request is still reauthorized, run-checked, and (for delete)
 * re-checked against the owner's live delete policy. It is never offered by
 * default.
 */
export const ROSTER_BRIDGE_SAVED_CAPABILITY = "roster-saved-v1";
/**
 * Optional capabilities this implementation knows. An identifier offered by a
 * peer is recorded only when it appears here and is otherwise ignored; an
 * acknowledgement additionally narrows to what the owner can really honour.
 */
export const ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES: readonly string[] = Object.freeze([
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_SAVED_CAPABILITY,
]);

/** One metadata subscription per channel; not configurable. */
export const ROSTER_BRIDGE_MAX_SUBSCRIPTIONS_PER_CHANNEL = 1;
/** One snapshot transfer in flight per channel; not configurable. */
export const ROSTER_BRIDGE_MAX_IN_FLIGHT_TRANSFERS = 1;
/** One newest-wins pending snapshot per channel; not configurable. */
export const ROSTER_BRIDGE_MAX_PENDING_SNAPSHOTS = 1;

/** Explicit, finite metadata bounds. Overrides are validated, and 0 never means unlimited. */
export interface RosterBridgeBounds {
  /** Complete encoded frame; compatible with the transport message bound. */
  readonly maxFrameBytes: number;
  /** Rows in one page frame. */
  readonly maxRowsPerPage: number;
  /** Encoded page-frame budget; pages are packed by actual encoded bytes. */
  readonly maxPageBytes: number;
  /** Rows in one complete snapshot. */
  readonly maxSnapshotRows: number;
  /** Encoded row bytes across one complete snapshot. */
  readonly maxSnapshotBytes: number;
  /** Capability identifiers in one hello. */
  readonly maxCapabilities: number;
  /** Bytes in one capability identifier. */
  readonly maxCapabilityIdBytes: number;
  /** Bytes in one subscription, transfer, or host-run identifier. */
  readonly maxIdentifierBytes: number;
  /** How long the owner waits for the viewer's hello before refusing the channel. */
  readonly helloTimeoutMs: number;
  /** How long the viewer waits for `hello_ack`. */
  readonly handshakeTimeoutMs: number;
  /** How long the viewer waits for `snapshot_begin` after subscribing. */
  readonly snapshotStartTimeoutMs: number;
  /** How long the viewer waits for the next frame of an in-flight transfer. */
  readonly transferIdleTimeoutMs: number;
  /** How long the viewer waits for `unsubscribed` before completing a stop. */
  readonly stopAckTimeoutMs: number;
  /**
   * How long a requester waits for one `close_result` after the close frame was
   * handed to the transport. Exceeding it is `unknown`, never a retry. It is
   * deliberately longer than the owner's own bounded stop ladder grace: it bounds
   * this side's patience, not the owner's operation.
   */
  readonly closeResultTimeoutMs: number;
  /**
   * How long a requester waits for one `create_result` after the create frame was
   * handed to the transport. Exceeding it is `unknown`, never a retry, a cancel,
   * or a replay. It reuses the same patience class as Close (`closeResultTimeoutMs`)
   * because it bounds this side's patience with one owner-answered request, and it
   * never bounds the owner's own operation.
   */
  readonly createResultTimeoutMs: number;
}

export const DEFAULT_ROSTER_BRIDGE_BOUNDS: RosterBridgeBounds = Object.freeze({
  maxFrameBytes: 65_536,
  maxRowsPerPage: 32,
  maxPageBytes: 65_536,
  maxSnapshotRows: 4_096,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxCapabilities: 16,
  maxCapabilityIdBytes: 64,
  maxIdentifierBytes: 64,
  helloTimeoutMs: 10_000,
  handshakeTimeoutMs: 5_000,
  snapshotStartTimeoutMs: 15_000,
  transferIdleTimeoutMs: 30_000,
  stopAckTimeoutMs: 2_000,
  closeResultTimeoutMs: 15_000,
  createResultTimeoutMs: 15_000,
});

const BOUND_KEYS = Object.keys(DEFAULT_ROSTER_BRIDGE_BOUNDS) as ReadonlyArray<keyof RosterBridgeBounds>;

/**
 * Resolve explicit overrides against the fixed defaults. Every value must be a
 * finite positive integer, page bytes must fit inside a frame, and a snapshot
 * must be able to hold at least one full page. There is no unbounded
 * "0 means disabled" mode, and no override can raise the fixed one-subscription
 * / one-in-flight / one-pending ceilings.
 */
export function resolveRosterBridgeBounds(overrides: Partial<RosterBridgeBounds> = {}): RosterBridgeBounds {
  if (overrides !== undefined && !isRecord(overrides)) fail("invalid_bounds");
  const resolved: Record<keyof RosterBridgeBounds, number> = { ...DEFAULT_ROSTER_BRIDGE_BOUNDS };
  for (const key of BOUND_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail("invalid_bounds");
    resolved[key] = value;
  }
  if (resolved.maxPageBytes > resolved.maxFrameBytes) fail("invalid_bounds");
  if (resolved.maxSnapshotRows < resolved.maxRowsPerPage) fail("invalid_bounds");
  if (resolved.maxSnapshotBytes < resolved.maxPageBytes) fail("invalid_bounds");
  return Object.freeze(resolved);
}

/** Fixed wire failure codes. No raw frame, path, peer text, or exception detail. */
export type RosterBridgeErrorCode =
  | "bad_frame"
  | "unsupported_version"
  | "missing_capability"
  | "not_authorized"
  | "unavailable"
  | "row_unrepresentable"
  | "snapshot_too_large"
  | "run_changed"
  | "protocol_violation"
  | "too_many_subscriptions"
  | "send_failed";

const WIRE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "bad_frame",
  "unsupported_version",
  "missing_capability",
  "not_authorized",
  "unavailable",
  "row_unrepresentable",
  "snapshot_too_large",
  "run_changed",
  "protocol_violation",
  "too_many_subscriptions",
  "send_failed",
]);

export function isRosterBridgeErrorCode(value: unknown): value is RosterBridgeErrorCode {
  return typeof value === "string" && WIRE_ERROR_CODES.has(value);
}

/** Local failure codes for decode, encode, and packing. Never carries peer data. */
export type RosterBridgeFailureCode =
  | "invalid_bounds"
  | "invalid_frame"
  | "frame_too_large"
  | "bad_frame"
  | "row_unrepresentable"
  | "snapshot_too_large";

const FAILURE_MESSAGES: Record<RosterBridgeFailureCode, string> = {
  invalid_bounds: "roster metadata bounds are invalid",
  invalid_frame: "roster metadata frame is invalid",
  frame_too_large: "roster metadata frame exceeds its bound",
  bad_frame: "roster metadata frame could not be decoded",
  row_unrepresentable: "a roster metadata row cannot be represented on the wire",
  snapshot_too_large: "roster metadata snapshot exceeds a bounded limit",
};

/** Fixed-code failure for anything this protocol cannot represent. */
export class RosterBridgeProtocolError extends Error {
  readonly code: RosterBridgeFailureCode;

  constructor(code: RosterBridgeFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "RosterBridgeProtocolError";
    this.code = code;
  }
}

export function isRosterBridgeProtocolError(value: unknown): value is RosterBridgeProtocolError {
  return value instanceof RosterBridgeProtocolError;
}

function fail(code: RosterBridgeFailureCode): never {
  throw new RosterBridgeProtocolError(code);
}

/** Map a local failure onto the fixed wire code sent to the peer. */
export function rosterBridgeWireCodeForFailure(code: RosterBridgeFailureCode): RosterBridgeErrorCode {
  if (code === "row_unrepresentable") return "row_unrepresentable";
  if (code === "snapshot_too_large") return "snapshot_too_large";
  if (code === "invalid_bounds") return "protocol_violation";
  return "bad_frame";
}

export interface RosterBridgeHelloFrame {
  readonly type: "hello";
  readonly service: string;
  readonly major: number;
  readonly minor: number;
  readonly capabilities: readonly string[];
}

export interface RosterBridgeHelloAckFrame {
  readonly type: "hello_ack";
  readonly service: string;
  readonly major: number;
  readonly minor: number;
  readonly capabilities: readonly string[];
}

export interface RosterBridgeSubscribeFrame {
  readonly type: "subscribe";
  readonly subscriptionId: string;
}

export interface RosterBridgeSnapshotBeginFrame {
  readonly type: "snapshot_begin";
  readonly subscriptionId: string;
  readonly transferId: string;
  readonly hostRunId: string;
  readonly revision: number;
  readonly totalRows: number;
  readonly pageCount: number;
}

export interface RosterBridgeSnapshotPageFrame {
  readonly type: "snapshot_page";
  readonly subscriptionId: string;
  readonly transferId: string;
  readonly pageIndex: number;
  readonly rows: readonly RemoteSessionMetadata[];
}

export interface RosterBridgeSnapshotEndFrame {
  readonly type: "snapshot_end";
  readonly subscriptionId: string;
  readonly transferId: string;
  readonly revision: number;
  readonly totalRows: number;
}

export interface RosterBridgeUnsubscribeFrame {
  readonly type: "unsubscribe";
  readonly subscriptionId: string;
}

export interface RosterBridgeUnsubscribedFrame {
  readonly type: "unsubscribed";
  readonly subscriptionId: string;
}

export interface RosterBridgeErrorFrame {
  readonly type: "error";
  readonly code: RosterBridgeErrorCode;
  /** Present only when the failure belongs to one subscription. */
  readonly subscriptionId?: string;
}

/**
 * One owner-routed Close request. Every identifier is opaque and bounded, the
 * confirmation is a strict boolean, and nothing else is expressible: no payload,
 * error, signal, path, native tuple, or owner text can ride along.
 */
export interface RosterBridgeCloseRequestFrame {
  readonly type: "close_request";
  /** This requester's fresh, unpredictable correlation id. */
  readonly requestId: string;
  /** Exact owner run id the request names. */
  readonly hostRunId: string;
  /** Exact owner row id within that run. */
  readonly rowId: string;
  /** True only when the operator deliberately confirmed a busy or unknown row. */
  readonly confirmed: boolean;
}

/** One fixed owner answer for exactly one request id. */
export interface RosterBridgeCloseResultFrame {
  readonly type: "close_result";
  readonly requestId: string;
  readonly outcome: OwnerCloseFacts;
}

/**
 * One rowless owner-create request. Every identifier is opaque and bounded, the
 * workspace is canonical single-line text inside the New form's own bound, and
 * `sequence` is this channel's strictly increasing attempt number. Nothing else
 * is expressible: no row id, no payload, no path decision, no error, no native
 * tuple, and no display or selection fact can ride along.
 */
export interface RosterBridgeCreateRequestFrame {
  readonly type: "create_request";
  /** This requester's fresh, unpredictable correlation id. */
  readonly requestId: string;
  /** Exact owner run id the request names and the result must still belong to. */
  readonly hostRunId: string;
  /** Canonical workspace text exactly as the requester's form held it. */
  readonly workspace: string;
  /** Strictly increasing, positive per-channel attempt number. */
  readonly sequence: number;
}

/** One fixed owner answer for exactly one request id. */
export interface RosterBridgeCreateResultFrame {
  readonly type: "create_result";
  readonly requestId: string;
  readonly outcome: OwnerCreateFacts;
}

/**
 * Fresh Saved catalog listing request. `query` is exact well-formed Unicode and
 * is bounded only by this frame fitting the lane; `count` is 1..maxSnapshotRows;
 * `sequence` is the channel's shared strictly increasing Saved attempt number.
 */
export interface RosterBridgeSavedListRequestFrame {
  readonly type: "saved_list_request";
  readonly requestId: string;
  readonly hostRunId: string;
  readonly query: string;
  readonly offset: number;
  readonly count: number;
  readonly sequence: number;
}

/** Search within one exact owner catalog; replaces the owner's result only. */
export interface RosterBridgeSavedSearchRequestFrame {
  readonly type: "saved_search_request";
  readonly requestId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly query: string;
  readonly offset: number;
  readonly count: number;
  readonly sequence: number;
}

/** Another bounded window of one exact owner result. Never relists. */
export interface RosterBridgeSavedWindowRequestFrame {
  readonly type: "saved_window_request";
  readonly requestId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly offset: number;
  readonly count: number;
  readonly sequence: number;
}

/** Resume one entry of one exact owner result. */
export interface RosterBridgeSavedResumeRequestFrame {
  readonly type: "saved_resume_request";
  readonly requestId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly entryId: string;
  readonly sequence: number;
}

/** Prepare (`confirmed: false`) or confirm deletion of one exact entry. */
export interface RosterBridgeSavedDeleteRequestFrame {
  readonly type: "saved_delete_request";
  readonly requestId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly entryId: string;
  readonly confirmed: boolean;
  readonly sequence: number;
}

/** One fixed non-data answer to a list, search, or window request. */
export interface RosterBridgeSavedWindowResultFrame {
  readonly type: "saved_window_result";
  readonly requestId: string;
  readonly outcome: OwnerSavedWindowOutcome;
}

/**
 * Announces one successful window transfer: the exact run, catalog, and result,
 * the FULL result total, the actual offset, the honest number of rows this
 * transfer carries, its page count, and the owner's issue scalar.
 */
export interface RosterBridgeSavedWindowBeginFrame {
  readonly type: "saved_window_begin";
  readonly requestId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly total: number;
  readonly issueCount: number;
  readonly offset: number;
  readonly rows: number;
  readonly pageCount: number;
}

export interface RosterBridgeSavedWindowPageFrame {
  readonly type: "saved_window_page";
  readonly requestId: string;
  readonly pageIndex: number;
  readonly entries: readonly OwnerSavedEntry[];
}

/**
 * One part of ONE entry too large for a single page frame. The concatenated
 * `text` of parts `0..parts-1`, sent as consecutive frames, is exactly the
 * canonical JSON encoding of one entry. Each fragment occupies one page index.
 */
export interface RosterBridgeSavedWindowFragmentFrame {
  readonly type: "saved_window_fragment";
  readonly requestId: string;
  readonly pageIndex: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
}

export interface RosterBridgeSavedWindowEndFrame {
  readonly type: "saved_window_end";
  readonly requestId: string;
  readonly rows: number;
  readonly pageCount: number;
}

export interface RosterBridgeSavedResumeResultFrame {
  readonly type: "saved_resume_result";
  readonly requestId: string;
  readonly outcome: OwnerSavedResumeFacts;
}

export interface RosterBridgeSavedDeleteResultFrame {
  readonly type: "saved_delete_result";
  readonly requestId: string;
  readonly outcome: OwnerSavedDeleteFacts;
}

/** Descriptive owner delete exposure for one exact run. Never authority. */
export interface RosterBridgeSavedPolicyFrame {
  readonly type: "saved_policy";
  readonly hostRunId: string;
  readonly deleteExposed: boolean;
}

export type RosterBridgeSavedRequestFrame =
  | RosterBridgeSavedListRequestFrame
  | RosterBridgeSavedSearchRequestFrame
  | RosterBridgeSavedWindowRequestFrame
  | RosterBridgeSavedResumeRequestFrame
  | RosterBridgeSavedDeleteRequestFrame;

export type RosterBridgeSavedFrame =
  | RosterBridgeSavedRequestFrame
  | RosterBridgeSavedWindowResultFrame
  | RosterBridgeSavedWindowBeginFrame
  | RosterBridgeSavedWindowPageFrame
  | RosterBridgeSavedWindowFragmentFrame
  | RosterBridgeSavedWindowEndFrame
  | RosterBridgeSavedResumeResultFrame
  | RosterBridgeSavedDeleteResultFrame
  | RosterBridgeSavedPolicyFrame;

export type RosterBridgeFrame =
  | RosterBridgeHelloFrame
  | RosterBridgeHelloAckFrame
  | RosterBridgeSubscribeFrame
  | RosterBridgeSnapshotBeginFrame
  | RosterBridgeSnapshotPageFrame
  | RosterBridgeSnapshotEndFrame
  | RosterBridgeUnsubscribeFrame
  | RosterBridgeUnsubscribedFrame
  | RosterBridgeCloseRequestFrame
  | RosterBridgeCloseResultFrame
  | RosterBridgeCreateRequestFrame
  | RosterBridgeCreateResultFrame
  | RosterBridgeSavedFrame
  | RosterBridgeErrorFrame;

const FRAME_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  hello: new Set(["type", "service", "major", "minor", "capabilities"]),
  hello_ack: new Set(["type", "service", "major", "minor", "capabilities"]),
  subscribe: new Set(["type", "subscriptionId"]),
  snapshot_begin: new Set(["type", "subscriptionId", "transferId", "hostRunId", "revision", "totalRows", "pageCount"]),
  snapshot_page: new Set(["type", "subscriptionId", "transferId", "pageIndex", "rows"]),
  snapshot_end: new Set(["type", "subscriptionId", "transferId", "revision", "totalRows"]),
  unsubscribe: new Set(["type", "subscriptionId"]),
  unsubscribed: new Set(["type", "subscriptionId"]),
  close_request: new Set(["type", "requestId", "hostRunId", "rowId", "confirmed"]),
  close_result: new Set(["type", "requestId", "outcome"]),
  create_request: new Set(["type", "requestId", "hostRunId", "workspace", "sequence"]),
  create_result: new Set(["type", "requestId", "outcome"]),
  saved_list_request: new Set(["type", "requestId", "hostRunId", "query", "offset", "count", "sequence"]),
  saved_search_request: new Set(["type", "requestId", "hostRunId", "catalogId", "query", "offset", "count", "sequence"]),
  saved_window_request: new Set(["type", "requestId", "hostRunId", "catalogId", "resultId", "offset", "count", "sequence"]),
  saved_resume_request: new Set(["type", "requestId", "hostRunId", "catalogId", "resultId", "entryId", "sequence"]),
  saved_delete_request: new Set(["type", "requestId", "hostRunId", "catalogId", "resultId", "entryId", "confirmed", "sequence"]),
  saved_window_result: new Set(["type", "requestId", "outcome"]),
  saved_window_begin: new Set([
    "type", "requestId", "hostRunId", "catalogId", "resultId", "total", "issueCount", "offset", "rows", "pageCount",
  ]),
  saved_window_page: new Set(["type", "requestId", "pageIndex", "entries"]),
  saved_window_fragment: new Set(["type", "requestId", "pageIndex", "part", "parts", "text"]),
  saved_window_end: new Set(["type", "requestId", "rows", "pageCount"]),
  saved_resume_result: new Set(["type", "requestId", "outcome"]),
  saved_delete_result: new Set(["type", "requestId", "outcome"]),
  saved_policy: new Set(["type", "hostRunId", "deleteExposed"]),
  error: new Set(["type", "code", "subscriptionId"]),
});

const REQUIRED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  hello: new Set(["service", "major", "minor", "capabilities"]),
  hello_ack: new Set(["service", "major", "minor", "capabilities"]),
  subscribe: new Set(["subscriptionId"]),
  snapshot_begin: new Set(["subscriptionId", "transferId", "hostRunId", "revision", "totalRows", "pageCount"]),
  snapshot_page: new Set(["subscriptionId", "transferId", "pageIndex", "rows"]),
  snapshot_end: new Set(["subscriptionId", "transferId", "revision", "totalRows"]),
  unsubscribe: new Set(["subscriptionId"]),
  unsubscribed: new Set(["subscriptionId"]),
  close_request: new Set(["requestId", "hostRunId", "rowId", "confirmed"]),
  close_result: new Set(["requestId", "outcome"]),
  create_request: new Set(["requestId", "hostRunId", "workspace", "sequence"]),
  create_result: new Set(["requestId", "outcome"]),
  saved_list_request: new Set(["requestId", "hostRunId", "query", "offset", "count", "sequence"]),
  saved_search_request: new Set(["requestId", "hostRunId", "catalogId", "query", "offset", "count", "sequence"]),
  saved_window_request: new Set(["requestId", "hostRunId", "catalogId", "resultId", "offset", "count", "sequence"]),
  saved_resume_request: new Set(["requestId", "hostRunId", "catalogId", "resultId", "entryId", "sequence"]),
  saved_delete_request: new Set(["requestId", "hostRunId", "catalogId", "resultId", "entryId", "confirmed", "sequence"]),
  saved_window_result: new Set(["requestId", "outcome"]),
  saved_window_begin: new Set([
    "requestId", "hostRunId", "catalogId", "resultId", "total", "issueCount", "offset", "rows", "pageCount",
  ]),
  saved_window_page: new Set(["requestId", "pageIndex", "entries"]),
  saved_window_fragment: new Set(["requestId", "pageIndex", "part", "parts", "text"]),
  saved_window_end: new Set(["requestId", "rows", "pageCount"]),
  saved_resume_result: new Set(["requestId", "outcome"]),
  saved_delete_result: new Set(["requestId", "outcome"]),
  saved_policy: new Set(["hostRunId", "deleteExposed"]),
  error: new Set(["code"]),
});

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function readIdentifier(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) fail("bad_frame");
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail("bad_frame");
  if (!IDENTIFIER_RE.test(value)) fail("bad_frame");
  return value;
}

/**
 * True only for a value this protocol can carry as one opaque identifier: a
 * bounded, non-empty, unremarkable token. This is a type predicate so a caller
 * that validates its own request before encoding gets a narrowed `string`, not a
 * boolean it would have to re-check with `typeof`.
 */
export function isRosterBridgeIdentifier(
  value: unknown,
  bounds: RosterBridgeBounds = DEFAULT_ROSTER_BRIDGE_BOUNDS,
): value is string {
  try {
    readIdentifier(value, bounds.maxIdentifierBytes);
    return true;
  } catch {
    return false;
  }
}

function readService(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("bad_frame");
  if (Buffer.byteLength(value, "utf8") > 128) fail("bad_frame");
  if (UNSAFE_TEXT_RE.test(value)) fail("bad_frame");
  return value;
}

function readInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("bad_frame");
  if (value < min || value > max) fail("bad_frame");
  return value;
}

function readCapabilities(value: unknown, bounds: RosterBridgeBounds): readonly string[] {
  if (!Array.isArray(value)) fail("bad_frame");
  if (value.length > bounds.maxCapabilities) fail("bad_frame");
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") fail("bad_frame");
    if (Buffer.byteLength(entry, "utf8") > bounds.maxCapabilityIdBytes) fail("bad_frame");
    if (!IDENTIFIER_RE.test(entry)) fail("bad_frame");
    if (seen.has(entry)) fail("bad_frame");
    seen.add(entry);
    capabilities.push(entry);
  }
  return Object.freeze(capabilities);
}

/**
 * One canonical workspace. The field rule itself lives in the pure create
 * contract, so the wire acceptance and the requester's local acceptance can
 * never disagree; nothing is trimmed, resolved, rewritten, or truncated here.
 */
function readWorkspace(value: unknown): string {
  if (!isOwnerCreateWorkspace(value)) fail("bad_frame");
  return value;
}

function readRows(value: unknown, bounds: RosterBridgeBounds): readonly RemoteSessionMetadata[] {
  if (!Array.isArray(value)) fail("bad_frame");
  if (value.length > bounds.maxRowsPerPage) fail("bad_frame");
  return Object.freeze(value.map((row) => {
    // The row boundary owns every field rule; a null here means an invalid,
    // private-field-bearing, or oversized row, and the whole frame is refused.
    const parsed = parseRemoteSessionMetadata(row);
    if (parsed === null) fail("bad_frame");
    return parsed;
  }));
}

// ------------------------------------------------------------------ saved

/** A window size: at least one row and never more than one transfer may hold. */
function readSavedCount(value: unknown, bounds: RosterBridgeBounds): number {
  return readInteger(value, 1, bounds.maxSnapshotRows);
}

/** A safe non-negative scalar. Nothing is ever allocated from it. */
function readSavedScalar(value: unknown): number {
  return readInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

/** The shared per-channel anti-replay scalar: a positive safe integer. */
function readSavedSequence(value: unknown): number {
  return readInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

/** Exact query text: well-formed Unicode, never trimmed, normalized, or capped here. */
function readSavedQuery(value: unknown): string {
  if (!isOwnerSavedQuery(value)) fail("bad_frame");
  return value;
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("bad_frame");
  return value;
}

const SAVED_ENTRY_KEYS: ReadonlySet<string> = new Set(OWNER_SAVED_ENTRY_KEYS);

/**
 * One closed entry, copied field by field in the canonical order. The owner's
 * native session id, saved file path, caption, and working directory are carried
 * whole and exactly: the only rule is that each is a well-formed string, so no
 * legal row is clipped, hidden, or refused here. Anything outside the closed key
 * set is refused.
 */
function readSavedEntry(value: unknown, bounds: RosterBridgeBounds): OwnerSavedEntry {
  if (!isPlainRecord(value)) fail("bad_frame");
  const keys = Object.keys(value);
  if (keys.length !== SAVED_ENTRY_KEYS.size) fail("bad_frame");
  for (const key of keys) {
    if (!SAVED_ENTRY_KEYS.has(key)) fail("bad_frame");
  }
  const entryId = readIdentifier(ownField(value, "entryId"), bounds.maxIdentifierBytes);
  const sessionId = ownField(value, "sessionId");
  const file = ownField(value, "file");
  const caption = ownField(value, "caption");
  const cwd = ownField(value, "cwd");
  if (!isOwnerSavedText(sessionId)
    || !isOwnerSavedText(file)
    || !isOwnerSavedText(caption)
    || !isOwnerSavedText(cwd)) fail("bad_frame");
  return Object.freeze({ entryId, sessionId, file, caption, cwd });
}

/**
 * Upper bound on frames (pages plus fragments) in ONE Saved window. It is a
 * sanity cap derived from the existing per-transfer bounds — every row a page,
 * plus room for fragments of the window byte budget — and is never used to size
 * an allocation. The packer never exceeds it and the receiver refuses beyond it.
 */
export function rosterBridgeSavedWindowMaxFrames(bounds: RosterBridgeBounds = DEFAULT_ROSTER_BRIDGE_BOUNDS): number {
  return bounds.maxSnapshotRows + Math.ceil((2 * bounds.maxSnapshotBytes) / 1024);
}

/**
 * Reassemble one fragmented entry. The concatenated fragment text must be
 * EXACTLY the canonical encoding of one valid entry; anything else (invalid
 * JSON, another shape, a non-canonical encoding) fails closed with `bad_frame`.
 */
export function decodeRosterBridgeSavedEntryText(
  text: string,
  bounds: RosterBridgeBounds = DEFAULT_ROSTER_BRIDGE_BOUNDS,
): OwnerSavedEntry {
  if (typeof text !== "string" || !isWellFormedUnicode(text)) fail("bad_frame");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("bad_frame");
  }
  const entry = readSavedEntry(value, bounds);
  if (JSON.stringify(entry) !== text) fail("bad_frame");
  return entry;
}

/** One page of entries: bounded by the page row bound, ids unique within it. */
function readSavedEntries(value: unknown, bounds: RosterBridgeBounds): readonly OwnerSavedEntry[] {
  if (!Array.isArray(value)) fail("bad_frame");
  if (value.length > bounds.maxRowsPerPage) fail("bad_frame");
  const seen = new Set<string>();
  const entries: OwnerSavedEntry[] = [];
  for (const raw of value) {
    const entry = readSavedEntry(raw, bounds);
    if (seen.has(entry.entryId)) fail("bad_frame");
    seen.add(entry.entryId);
    entries.push(entry);
  }
  return Object.freeze(entries);
}

/**
 * Frame count (pages plus fragments) coherent with the honest row count: none for
 * an empty window, at least enough pages for the rows, and never beyond the
 * derived Saved frame cap.
 */
function readSavedPageCount(value: unknown, rows: number, bounds: RosterBridgeBounds): number {
  const pageCount = readInteger(value, 0, rosterBridgeSavedWindowMaxFrames(bounds));
  if (rows === 0) {
    if (pageCount !== 0) fail("bad_frame");
    return pageCount;
  }
  if (pageCount < Math.ceil(rows / bounds.maxRowsPerPage)) fail("bad_frame");
  return pageCount;
}

/** Fragment text: one non-empty, well-formed slice of a canonical entry encoding. */
function readSavedFragmentText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value)) fail("bad_frame");
  return value;
}

function readSavedWindowOutcome(value: unknown): OwnerSavedWindowOutcome {
  if (!isOwnerSavedWindowOutcome(value)) fail("bad_frame");
  if (value.kind === "refused") {
    return value.reason === undefined
      ? Object.freeze({ kind: "refused" as const })
      : Object.freeze({ kind: "refused" as const, reason: value.reason });
  }
  return Object.freeze({ kind: value.kind });
}

function readSavedResumeOutcome(value: unknown, bounds: RosterBridgeBounds): OwnerSavedResumeFacts {
  if (!isOwnerSavedResumeFacts(value)) fail("bad_frame");
  switch (value.kind) {
    case "started":
      return Object.freeze({
        kind: "started" as const,
        hostRunId: readIdentifier(value.hostRunId, bounds.maxIdentifierBytes),
        rowId: readIdentifier(value.rowId, bounds.maxIdentifierBytes),
      });
    case "refused":
      return Object.freeze({ kind: "refused" as const, reason: value.reason });
    default:
      return Object.freeze({ kind: value.kind });
  }
}

function readSavedDeleteOutcome(value: unknown): OwnerSavedDeleteFacts {
  if (!isOwnerSavedDeleteFacts(value)) fail("bad_frame");
  switch (value.kind) {
    case "deleted":
      return Object.freeze({ kind: "deleted" as const, method: value.method });
    case "refused":
      return Object.freeze({ kind: "refused" as const, reason: value.reason });
    default:
      return Object.freeze({ kind: value.kind });
  }
}

/**
 * Build (decode) or re-prove (encode) one Saved frame from a closed-key record.
 * Every field is read through its own rule and the result is a fresh frozen
 * frame; nothing outside the schema survives.
 */
function buildSavedFrame(type: string, record: Record<string, unknown>, bounds: RosterBridgeBounds): RosterBridgeSavedFrame {
  const id = (key: string): string => readIdentifier(ownField(record, key), bounds.maxIdentifierBytes);
  switch (type) {
    case "saved_list_request":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        hostRunId: id("hostRunId"),
        query: readSavedQuery(ownField(record, "query")),
        offset: readSavedScalar(ownField(record, "offset")),
        count: readSavedCount(ownField(record, "count"), bounds),
        sequence: readSavedSequence(ownField(record, "sequence")),
      });
    case "saved_search_request":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        hostRunId: id("hostRunId"),
        catalogId: id("catalogId"),
        query: readSavedQuery(ownField(record, "query")),
        offset: readSavedScalar(ownField(record, "offset")),
        count: readSavedCount(ownField(record, "count"), bounds),
        sequence: readSavedSequence(ownField(record, "sequence")),
      });
    case "saved_window_request":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        hostRunId: id("hostRunId"),
        catalogId: id("catalogId"),
        resultId: id("resultId"),
        offset: readSavedScalar(ownField(record, "offset")),
        count: readSavedCount(ownField(record, "count"), bounds),
        sequence: readSavedSequence(ownField(record, "sequence")),
      });
    case "saved_resume_request":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        hostRunId: id("hostRunId"),
        catalogId: id("catalogId"),
        resultId: id("resultId"),
        entryId: id("entryId"),
        sequence: readSavedSequence(ownField(record, "sequence")),
      });
    case "saved_delete_request":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        hostRunId: id("hostRunId"),
        catalogId: id("catalogId"),
        resultId: id("resultId"),
        entryId: id("entryId"),
        confirmed: readBoolean(ownField(record, "confirmed")),
        sequence: readSavedSequence(ownField(record, "sequence")),
      });
    case "saved_window_result":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        outcome: readSavedWindowOutcome(ownField(record, "outcome")),
      });
    case "saved_window_begin": {
      const total = readSavedScalar(ownField(record, "total"));
      const offset = readSavedScalar(ownField(record, "offset"));
      if (offset > total) fail("bad_frame");
      const rows = readInteger(ownField(record, "rows"), 0, bounds.maxSnapshotRows);
      // The window can never run past the full total it states.
      if (rows > total - offset) fail("bad_frame");
      return Object.freeze({
        type,
        requestId: id("requestId"),
        hostRunId: id("hostRunId"),
        catalogId: id("catalogId"),
        resultId: id("resultId"),
        total,
        issueCount: readSavedScalar(ownField(record, "issueCount")),
        offset,
        rows,
        pageCount: readSavedPageCount(ownField(record, "pageCount"), rows, bounds),
      });
    }
    case "saved_window_page":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        pageIndex: readInteger(ownField(record, "pageIndex"), 0, rosterBridgeSavedWindowMaxFrames(bounds)),
        entries: readSavedEntries(ownField(record, "entries"), bounds),
      });
    case "saved_window_fragment": {
      const cap = rosterBridgeSavedWindowMaxFrames(bounds);
      const parts = readInteger(ownField(record, "parts"), 1, cap);
      const part = readInteger(ownField(record, "part"), 0, cap);
      if (part >= parts) fail("bad_frame");
      return Object.freeze({
        type,
        requestId: id("requestId"),
        pageIndex: readInteger(ownField(record, "pageIndex"), 0, cap),
        part,
        parts,
        text: readSavedFragmentText(ownField(record, "text")),
      });
    }
    case "saved_window_end": {
      const rows = readInteger(ownField(record, "rows"), 0, bounds.maxSnapshotRows);
      return Object.freeze({
        type,
        requestId: id("requestId"),
        rows,
        pageCount: readSavedPageCount(ownField(record, "pageCount"), rows, bounds),
      });
    }
    case "saved_resume_result":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        outcome: readSavedResumeOutcome(ownField(record, "outcome"), bounds),
      });
    case "saved_delete_result":
      return Object.freeze({
        type,
        requestId: id("requestId"),
        outcome: readSavedDeleteOutcome(ownField(record, "outcome")),
      });
    case "saved_policy":
      return Object.freeze({
        type,
        hostRunId: id("hostRunId"),
        deleteExposed: readBoolean(ownField(record, "deleteExposed")),
      });
    default:
      fail("bad_frame");
  }
}

function validateFrame(frame: RosterBridgeFrame, bounds: RosterBridgeBounds): RosterBridgeFrame {
  switch (frame.type) {
    case "hello":
    case "hello_ack": {
      readService(frame.service);
      if (!Number.isSafeInteger(frame.major) || frame.major < 0 || frame.major > 4_294_967_295) fail("invalid_frame");
      if (!Number.isSafeInteger(frame.minor) || frame.minor < 0 || frame.minor > 4_294_967_295) fail("invalid_frame");
      if (!Array.isArray(frame.capabilities)) fail("invalid_frame");
      readCapabilities(frame.capabilities, bounds);
      return frame;
    }
    case "subscribe":
    case "unsubscribe":
    case "unsubscribed": {
      readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
      return frame;
    }
    case "snapshot_begin": {
      readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
      readIdentifier(frame.transferId, bounds.maxIdentifierBytes);
      readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
      if (!Number.isSafeInteger(frame.revision) || frame.revision < 1) fail("invalid_frame");
      if (!Number.isSafeInteger(frame.totalRows) || frame.totalRows < 0 || frame.totalRows > bounds.maxSnapshotRows) {
        fail("invalid_frame");
      }
      const minimumPages = frame.totalRows === 0 ? 0 : Math.ceil(frame.totalRows / bounds.maxRowsPerPage);
      if (!Number.isSafeInteger(frame.pageCount)
        || frame.pageCount < minimumPages
        || frame.pageCount > Math.max(frame.totalRows, 0)) fail("invalid_frame");
      return frame;
    }
    case "snapshot_page": {
      readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
      readIdentifier(frame.transferId, bounds.maxIdentifierBytes);
      if (!Number.isSafeInteger(frame.pageIndex) || frame.pageIndex < 0) fail("invalid_frame");
      if (!Array.isArray(frame.rows)) fail("invalid_frame");
      readRows(frame.rows, bounds);
      return frame;
    }
    case "snapshot_end": {
      readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
      readIdentifier(frame.transferId, bounds.maxIdentifierBytes);
      if (!Number.isSafeInteger(frame.revision) || frame.revision < 1) fail("invalid_frame");
      if (!Number.isSafeInteger(frame.totalRows) || frame.totalRows < 0 || frame.totalRows > bounds.maxSnapshotRows) {
        fail("invalid_frame");
      }
      return frame;
    }
    case "close_request": {
      readIdentifier(frame.requestId, bounds.maxIdentifierBytes);
      readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
      readIdentifier(frame.rowId, bounds.maxIdentifierBytes);
      if (typeof frame.confirmed !== "boolean") fail("invalid_frame");
      return frame;
    }
    case "close_result": {
      readIdentifier(frame.requestId, bounds.maxIdentifierBytes);
      if (!isOwnerCloseFacts(frame.outcome)) fail("invalid_frame");
      return frame;
    }
    case "create_request": {
      readIdentifier(frame.requestId, bounds.maxIdentifierBytes);
      readIdentifier(frame.hostRunId, bounds.maxIdentifierBytes);
      readWorkspace(frame.workspace);
      // The anti-replay scalar must be a positive safe integer; the per-channel
      // high-water comparison itself belongs to the two endpoints.
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1) fail("invalid_frame");
      return frame;
    }
    case "create_result": {
      readIdentifier(frame.requestId, bounds.maxIdentifierBytes);
      if (!isOwnerCreateFacts(frame.outcome)) fail("invalid_frame");
      // A `started` fact names one owner run and one row, so both must be
      // carryable identifiers on this side too; otherwise the peer could never
      // decode what this side built.
      if (frame.outcome.kind === "started") {
        readIdentifier(frame.outcome.hostRunId, bounds.maxIdentifierBytes);
        readIdentifier(frame.outcome.rowId, bounds.maxIdentifierBytes);
      }
      return frame;
    }
    case "saved_list_request":
    case "saved_search_request":
    case "saved_window_request":
    case "saved_resume_request":
    case "saved_delete_request":
    case "saved_window_result":
    case "saved_window_begin":
    case "saved_window_page":
    case "saved_window_fragment":
    case "saved_window_end":
    case "saved_resume_result":
    case "saved_delete_result":
    case "saved_policy": {
      // The same closed reader the decoder uses, so this side can never encode a
      // Saved frame its peer would refuse.
      buildSavedFrame(frame.type, frame as unknown as Record<string, unknown>, bounds);
      return frame;
    }
    case "error": {
      if (!isRosterBridgeErrorCode(frame.code)) fail("invalid_frame");
      if (frame.subscriptionId !== undefined) readIdentifier(frame.subscriptionId, bounds.maxIdentifierBytes);
      return frame;
    }
    default:
      fail("invalid_frame");
  }
}

/**
 * Encode one frame as the complete payload of one binary channel message.
 * The frame is validated first and the encoded bytes must fit the frame bound;
 * an oversized frame is an error, never a truncated or split message.
 */
export function encodeRosterBridgeFrame(frame: RosterBridgeFrame, bounds: RosterBridgeBounds = DEFAULT_ROSTER_BRIDGE_BOUNDS): Buffer {
  if (!isPlainRecord(frame)) fail("invalid_frame");
  const allowed = FRAME_KEYS[frame.type];
  if (allowed === undefined) fail("invalid_frame");
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) fail("invalid_frame");
  }
  try {
    validateFrame(frame, bounds);
  } catch (error) {
    // A frame this side built wrongly is a programming failure, not a peer one.
    if (isRosterBridgeProtocolError(error) && error.code === "bad_frame") fail("invalid_frame");
    throw error;
  }
  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch {
    fail("invalid_frame");
  }
  if (typeof text !== "string") fail("invalid_frame");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > bounds.maxFrameBytes) fail("frame_too_large");
  return bytes;
}

function buildFrame(record: Record<string, unknown>, bounds: RosterBridgeBounds): RosterBridgeFrame {
  const type = record.type;
  if (typeof type !== "string") fail("bad_frame");
  const allowed = FRAME_KEYS[type];
  if (allowed === undefined) fail("bad_frame");
  // Unknown keys (including any private owner field) are refused, so nothing
  // outside this schema can ride along on a metadata frame.
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail("bad_frame");
  }
  for (const key of REQUIRED_KEYS[type] ?? []) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) fail("bad_frame");
  }
  switch (type) {
    case "hello":
    case "hello_ack": {
      return Object.freeze({
        type,
        service: readService(ownField(record, "service")),
        major: readInteger(ownField(record, "major"), 0, 4_294_967_295),
        minor: readInteger(ownField(record, "minor"), 0, 4_294_967_295),
        capabilities: readCapabilities(ownField(record, "capabilities"), bounds),
      });
    }
    case "subscribe":
    case "unsubscribe":
    case "unsubscribed": {
      return Object.freeze({
        type,
        subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
      });
    }
    case "snapshot_begin": {
      return Object.freeze({
        type,
        subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
        transferId: readIdentifier(ownField(record, "transferId"), bounds.maxIdentifierBytes),
        hostRunId: readIdentifier(ownField(record, "hostRunId"), bounds.maxIdentifierBytes),
        revision: readInteger(ownField(record, "revision"), 1, Number.MAX_SAFE_INTEGER),
        totalRows: readInteger(ownField(record, "totalRows"), 0, bounds.maxSnapshotRows),
        pageCount: readInteger(ownField(record, "pageCount"), 0, bounds.maxSnapshotRows),
      });
    }
    case "snapshot_page": {
      return Object.freeze({
        type,
        subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
        transferId: readIdentifier(ownField(record, "transferId"), bounds.maxIdentifierBytes),
        pageIndex: readInteger(ownField(record, "pageIndex"), 0, bounds.maxSnapshotRows),
        rows: readRows(ownField(record, "rows"), bounds),
      });
    }
    case "snapshot_end": {
      return Object.freeze({
        type,
        subscriptionId: readIdentifier(ownField(record, "subscriptionId"), bounds.maxIdentifierBytes),
        transferId: readIdentifier(ownField(record, "transferId"), bounds.maxIdentifierBytes),
        revision: readInteger(ownField(record, "revision"), 1, Number.MAX_SAFE_INTEGER),
        totalRows: readInteger(ownField(record, "totalRows"), 0, bounds.maxSnapshotRows),
      });
    }
    case "close_request": {
      const confirmed = ownField(record, "confirmed");
      if (typeof confirmed !== "boolean") fail("bad_frame");
      return Object.freeze({
        type,
        requestId: readIdentifier(ownField(record, "requestId"), bounds.maxIdentifierBytes),
        hostRunId: readIdentifier(ownField(record, "hostRunId"), bounds.maxIdentifierBytes),
        rowId: readIdentifier(ownField(record, "rowId"), bounds.maxIdentifierBytes),
        confirmed,
      });
    }
    case "close_result": {
      const outcome = ownField(record, "outcome");
      // The fact boundary is closed: exactly one fixed kind, nothing else.
      if (!isOwnerCloseFacts(outcome)) fail("bad_frame");
      return Object.freeze({
        type,
        requestId: readIdentifier(ownField(record, "requestId"), bounds.maxIdentifierBytes),
        outcome: Object.freeze({ kind: outcome.kind }),
      });
    }
    case "create_request": {
      return Object.freeze({
        type,
        requestId: readIdentifier(ownField(record, "requestId"), bounds.maxIdentifierBytes),
        hostRunId: readIdentifier(ownField(record, "hostRunId"), bounds.maxIdentifierBytes),
        workspace: readWorkspace(ownField(record, "workspace")),
        sequence: readInteger(ownField(record, "sequence"), 1, Number.MAX_SAFE_INTEGER),
      });
    }
    case "create_result": {
      const outcome = ownField(record, "outcome");
      // The fact boundary is closed: one fixed kind, and for `started` exactly the
      // owner run and row it names. Nothing else is carried.
      if (!isOwnerCreateFacts(outcome)) fail("bad_frame");
      return Object.freeze({
        type,
        requestId: readIdentifier(ownField(record, "requestId"), bounds.maxIdentifierBytes),
        outcome: outcome.kind === "started"
          ? Object.freeze({
            kind: "started" as const,
            hostRunId: readIdentifier(outcome.hostRunId, bounds.maxIdentifierBytes),
            rowId: readIdentifier(outcome.rowId, bounds.maxIdentifierBytes),
          })
          : Object.freeze({ kind: outcome.kind }),
      });
    }
    case "saved_list_request":
    case "saved_search_request":
    case "saved_window_request":
    case "saved_resume_request":
    case "saved_delete_request":
    case "saved_window_result":
    case "saved_window_begin":
    case "saved_window_page":
    case "saved_window_fragment":
    case "saved_window_end":
    case "saved_resume_result":
    case "saved_delete_result":
    case "saved_policy":
      return buildSavedFrame(type, record, bounds);
    case "error": {
      const code = ownField(record, "code");
      if (!isRosterBridgeErrorCode(code)) fail("bad_frame");
      const subscriptionId = ownField(record, "subscriptionId");
      return Object.freeze({
        type,
        code,
        ...(subscriptionId === undefined
          ? {}
          : { subscriptionId: readIdentifier(subscriptionId, bounds.maxIdentifierBytes) }),
      });
    }
    default:
      fail("bad_frame");
  }
}

/**
 * Decode one complete binary message into one frame. Bytes that are not valid
 * UTF-8, not a single JSON object, structurally invalid, oversized, or carrying
 * any key outside this schema are refused with a fixed code; nothing partial is
 * ever returned and no peer content is included in the failure.
 */
export function decodeRosterBridgeFrame(bytes: Uint8Array, bounds: RosterBridgeBounds = DEFAULT_ROSTER_BRIDGE_BOUNDS): RosterBridgeFrame {
  if (!(bytes instanceof Uint8Array)) fail("bad_frame");
  if (bytes.length === 0 || bytes.length > bounds.maxFrameBytes) fail("frame_too_large");
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    fail("bad_frame");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("bad_frame");
  }
  if (!isPlainRecord(value)) fail("bad_frame");
  return buildFrame(value, bounds);
}

export type RosterBridgeNegotiation =
  | {
    readonly ok: true;
    readonly major: number;
    readonly minor: number;
    readonly capabilities: readonly string[];
  }
  | { readonly ok: false; readonly code: "unsupported_version" | "missing_capability" };

/**
 * Owner-side decision on one hello. A different service or major version is
 * refused, and a hello without the required baseline capability is refused.
 * Unknown optional capabilities are ignored rather than trusted, and the
 * negotiated minor is the lower of the two so a newer peer cannot imply
 * behavior this implementation does not have.
 */
export function negotiateRosterBridgeHello(hello: RosterBridgeHelloFrame): RosterBridgeNegotiation {
  if (hello.service !== ROSTER_BRIDGE_SERVICE || hello.major !== ROSTER_BRIDGE_MAJOR) {
    return { ok: false, code: "unsupported_version" };
  }
  if (!hello.capabilities.includes(ROSTER_BRIDGE_REQUIRED_CAPABILITY)) {
    return { ok: false, code: "missing_capability" };
  }
  const negotiated = hello.capabilities.filter((capability) =>
    capability !== ROSTER_BRIDGE_REQUIRED_CAPABILITY
    && ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES.includes(capability));
  return Object.freeze({
    ok: true,
    major: ROSTER_BRIDGE_MAJOR,
    minor: Math.min(hello.minor, ROSTER_BRIDGE_MINOR),
    capabilities: Object.freeze(negotiated),
  });
}

export type RosterBridgeAckVerdict =
  | { readonly ok: true; readonly minor: number; readonly capabilities: readonly string[] }
  | { readonly ok: false; readonly code: "unsupported_version" | "missing_capability" | "protocol_violation" };

/**
 * Viewer-side decision on one `hello_ack`. The owner must confirm this side's
 * service and major version and must acknowledge the required capability. An
 * acknowledgement that claims a capability this side never offered, or a minor
 * above the one offered, is a protocol violation: negotiation can only narrow
 * what either side may assume, never widen it.
 */
export function reviewRosterBridgeHelloAck(
  ack: RosterBridgeHelloAckFrame,
  offered: { readonly capabilities: readonly string[] },
): RosterBridgeAckVerdict {
  if (ack.service !== ROSTER_BRIDGE_SERVICE || ack.major !== ROSTER_BRIDGE_MAJOR) {
    return { ok: false, code: "unsupported_version" };
  }
  if (!ack.capabilities.includes(ROSTER_BRIDGE_REQUIRED_CAPABILITY)) {
    return { ok: false, code: "missing_capability" };
  }
  if (ack.minor > ROSTER_BRIDGE_MINOR) return { ok: false, code: "protocol_violation" };
  for (const capability of ack.capabilities) {
    if (!offered.capabilities.includes(capability)) return { ok: false, code: "protocol_violation" };
  }
  return Object.freeze({ ok: true, minor: ack.minor, capabilities: Object.freeze([...ack.capabilities]) });
}

export interface RosterBridgePackedPage {
  readonly rows: readonly RemoteSessionMetadata[];
  readonly frame: RosterBridgeSnapshotPageFrame;
  readonly bytes: number;
}

function pageFrame(
  subscriptionId: string,
  transferId: string,
  pageIndex: number,
  rows: readonly RemoteSessionMetadata[],
): RosterBridgeSnapshotPageFrame {
  return Object.freeze({ type: "snapshot_page", subscriptionId, transferId, pageIndex, rows });
}

/**
 * Pack rows into sequential pages by actual encoded byte size, then bound.
 *
 * A row that cannot fit a page on its own is refused as unrepresentable rather
 * than truncated, split, or dropped, and a snapshot whose encoded rows exceed
 * the aggregate bound is refused rather than clipped. Empty input packs to zero
 * pages, which is a real "no rows" snapshot and not an unknown one.
 */
export function packRosterBridgePages(options: {
  readonly subscriptionId: string;
  readonly transferId: string;
  readonly rows: readonly RemoteSessionMetadata[];
  readonly bounds?: RosterBridgeBounds;
}): readonly RosterBridgePackedPage[] {
  const bounds = options.bounds ?? DEFAULT_ROSTER_BRIDGE_BOUNDS;
  const rows = options.rows;
  if (!Array.isArray(rows)) fail("invalid_frame");
  if (rows.length > bounds.maxSnapshotRows) fail("snapshot_too_large");
  const pages: RemoteSessionMetadata[][] = [];
  let current: RemoteSessionMetadata[] = [];
  let totalBytes = 0;
  const packPage = (): void => {
    if (current.length === 0) return;
    pages.push(current);
    current = [];
  };
  for (const row of rows) {
    const parsed = parseRemoteSessionMetadata(row);
    if (parsed === null) fail("row_unrepresentable");
    totalBytes += Buffer.byteLength(JSON.stringify(parsed), "utf8");
    if (totalBytes > bounds.maxSnapshotBytes) fail("snapshot_too_large");
    if (current.length > 0
      && (current.length + 1 > bounds.maxRowsPerPage
        || encodedPageBytes(options.subscriptionId, options.transferId, pages.length, [...current, parsed]) > bounds.maxPageBytes)) {
      packPage();
    }
    current = [...current, parsed];
    if (current.length === 1
      && encodedPageBytes(options.subscriptionId, options.transferId, pages.length, current) > bounds.maxPageBytes) {
      fail("row_unrepresentable");
    }
  }
  packPage();
  return Object.freeze(pages.map((page, index) => {
    const frame = pageFrame(options.subscriptionId, options.transferId, index, Object.freeze(page));
    const bytes = encodedPageFrameBytes(frame);
    if (bytes > bounds.maxPageBytes || bytes > bounds.maxFrameBytes) fail("row_unrepresentable");
    return Object.freeze({ rows: Object.freeze(page), frame, bytes });
  }));
}

function encodedPageBytes(
  subscriptionId: string,
  transferId: string,
  pageIndex: number,
  rows: readonly RemoteSessionMetadata[],
): number {
  return Buffer.byteLength(JSON.stringify(pageFrame(subscriptionId, transferId, pageIndex, rows)), "utf8");
}

function encodedPageFrameBytes(frame: RosterBridgeSnapshotPageFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

export interface RosterBridgeBuiltTransfer {
  /** `snapshot_begin`, every `snapshot_page`, then `snapshot_end`, in order. */
  readonly frames: readonly Buffer[];
  readonly transferId: string;
  readonly hostRunId: string;
  readonly revision: number;
  readonly totalRows: number;
  readonly pageCount: number;
  readonly totalBytes: number;
}

/**
 * Build one complete authoritative snapshot transfer. Every frame is encoded up
 * front so the sender can re-check its guards immediately before each write,
 * and the whole transfer is refused (never trimmed) when it cannot be
 * represented inside the agreed bounds.
 */
export function buildRosterBridgeTransfer(options: {
  readonly subscriptionId: string;
  readonly transferId: string;
  readonly hostRunId: string;
  readonly revision: number;
  readonly rows: readonly RemoteSessionMetadata[];
  readonly bounds?: RosterBridgeBounds;
}): RosterBridgeBuiltTransfer {
  const bounds = options.bounds ?? DEFAULT_ROSTER_BRIDGE_BOUNDS;
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) fail("invalid_frame");
  const pages = packRosterBridgePages({
    subscriptionId: options.subscriptionId,
    transferId: options.transferId,
    rows: options.rows,
    bounds,
  });
  const totalRows = pages.reduce((total, page) => total + page.rows.length, 0);
  const totalBytes = pages.reduce((total, page) => total + page.bytes, 0);
  const begin: RosterBridgeSnapshotBeginFrame = Object.freeze({
    type: "snapshot_begin",
    subscriptionId: options.subscriptionId,
    transferId: options.transferId,
    hostRunId: options.hostRunId,
    revision: options.revision,
    totalRows,
    pageCount: pages.length,
  });
  const end: RosterBridgeSnapshotEndFrame = Object.freeze({
    type: "snapshot_end",
    subscriptionId: options.subscriptionId,
    transferId: options.transferId,
    revision: options.revision,
    totalRows,
  });
  const frames: Buffer[] = [encodeRosterBridgeFrame(begin, bounds)];
  for (const page of pages) {
    frames.push(encodeRosterBridgeFrame(page.frame, bounds));
  }
  frames.push(encodeRosterBridgeFrame(end, bounds));
  return Object.freeze({
    frames: Object.freeze(frames),
    transferId: options.transferId,
    hostRunId: options.hostRunId,
    revision: options.revision,
    totalRows,
    pageCount: pages.length,
    totalBytes,
  });
}

// ------------------------------------------------------------ saved window

export interface RosterBridgeBuiltSavedWindow {
  /** `saved_window_begin`, every `saved_window_page`, then `saved_window_end`, in order. */
  readonly frames: readonly Buffer[];
  /** Honest number of entries this transfer carries (a contiguous prefix). */
  readonly rows: number;
  readonly pageCount: number;
  /** Encoded entry bytes across the transfer, measured like roster rows. */
  readonly totalBytes: number;
}

function savedPageBytes(requestId: string, pageIndex: number, entries: readonly OwnerSavedEntry[]): number {
  const frame: RosterBridgeSavedWindowPageFrame = { type: "saved_window_page", requestId, pageIndex, entries };
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

function copySavedEntry(value: unknown, bounds: RosterBridgeBounds): OwnerSavedEntry | null {
  try {
    return readSavedEntry(value, bounds);
  } catch {
    return null;
  }
}

/**
 * Build one bounded Saved window transfer.
 *
 * Unlike the roster snapshot, a window is not an all-or-nothing replica: it is
 * one slice of a larger owner result, so it carries the LONGEST CONTIGUOUS
 * PREFIX of `entries` that fits the existing per-transfer bounds (rows per page,
 * bytes per page, rows per transfer, bytes per transfer) and states exactly how
 * many rows it carries. Packing stops at the first entry that would not fit or
 * cannot be represented; nothing after it is skipped over, so no row is ever
 * silently omitted from the middle, and the requester continues at
 * `offset + rows`. An entry whose exact native data cannot fit one page frame
 * is carried whole as consecutive `saved_window_fragment` frames (each within
 * the page byte bound, cut only at code-point boundaries), still inside the
 * same per-window row, byte, and derived frame caps. If not even the first entry
 * fits the window budget, the whole window is refused as `row_unrepresentable`
 * rather than presented as empty.
 *
 * `total` is the full result size and may exceed every per-transfer bound; it is
 * only compared, never used to size anything. This function is independent of
 * {@link packRosterBridgePages}, whose all-or-nothing refusals are unchanged.
 */
export function buildRosterBridgeSavedWindowTransfer(options: {
  readonly requestId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly total: number;
  readonly issueCount: number;
  readonly offset: number;
  readonly entries: readonly OwnerSavedEntry[];
  readonly bounds?: RosterBridgeBounds;
}): RosterBridgeBuiltSavedWindow {
  const bounds = options.bounds ?? DEFAULT_ROSTER_BRIDGE_BOUNDS;
  const { requestId, total, offset } = options;
  const entries = options.entries;
  if (!Array.isArray(entries)) fail("invalid_frame");
  if (!Number.isSafeInteger(total) || total < 0) fail("invalid_frame");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) fail("invalid_frame");
  if (entries.length > total - offset) fail("invalid_frame");
  const limit = Math.min(entries.length, bounds.maxSnapshotRows);
  const cap = rosterBridgeSavedWindowMaxFrames(bounds);
  const units: SavedWindowUnit[] = [];
  const seen = new Set<string>();
  // The open page always sits at frame index `closedFrames`.
  let current: OwnerSavedEntry[] = [];
  let closedFrames = 0;
  let totalBytes = 0;
  let rows = 0;
  const closeCurrent = (): void => {
    if (current.length === 0) return;
    units.push({ kind: "page", entries: current });
    closedFrames += 1;
    current = [];
  };
  for (let index = 0; index < limit; index += 1) {
    const entry = copySavedEntry(entries[index], bounds);
    // An unrepresentable or duplicated entry ends the prefix here; it is never
    // skipped, so the honest row count always describes a contiguous slice.
    if (entry === null || seen.has(entry.entryId)) break;
    const text = JSON.stringify(entry);
    const entryBytes = Buffer.byteLength(text, "utf8");
    // The existing per-window byte budget, measured exactly like roster rows.
    if (totalBytes + entryBytes > bounds.maxSnapshotBytes) break;
    if (current.length > 0
      && current.length < bounds.maxRowsPerPage
      && savedPageBytes(requestId, closedFrames, [...current, entry]) <= bounds.maxPageBytes) {
      current.push(entry);
    } else {
      const nextIndex = closedFrames + (current.length > 0 ? 1 : 0);
      if (savedPageBytes(requestId, nextIndex, [entry]) <= bounds.maxPageBytes) {
        if (nextIndex + 1 > cap) break;
        closeCurrent();
        current = [entry];
      } else {
        // A legal row whose exact native data cannot fit one page frame is carried
        // whole as consecutive fragments, never clipped and never skipped.
        const parts = splitSavedEntryText(requestId, text, bounds, cap);
        if (parts === null || nextIndex + parts.length > cap) break;
        closeCurrent();
        units.push({ kind: "fragments", parts });
        closedFrames += parts.length;
      }
    }
    seen.add(entry.entryId);
    totalBytes += entryBytes;
    rows += 1;
  }
  closeCurrent();
  if (rows === 0 && entries.length > 0) fail("row_unrepresentable");
  const begin: RosterBridgeSavedWindowBeginFrame = Object.freeze({
    type: "saved_window_begin",
    requestId,
    hostRunId: options.hostRunId,
    catalogId: options.catalogId,
    resultId: options.resultId,
    total,
    issueCount: options.issueCount,
    offset,
    rows,
    pageCount: closedFrames,
  });
  const frames: Buffer[] = [encodeRosterBridgeFrame(begin, bounds)];
  let pageIndex = 0;
  for (const unit of units) {
    if (unit.kind === "page") {
      const frame: RosterBridgeSavedWindowPageFrame = Object.freeze({
        type: "saved_window_page",
        requestId,
        pageIndex,
        entries: Object.freeze(unit.entries),
      });
      frames.push(encodeRosterBridgeFrame(frame, bounds));
      pageIndex += 1;
      continue;
    }
    unit.parts.forEach((text, part) => {
      const frame: RosterBridgeSavedWindowFragmentFrame = Object.freeze({
        type: "saved_window_fragment",
        requestId,
        pageIndex,
        part,
        parts: unit.parts.length,
        text,
      });
      frames.push(encodeRosterBridgeFrame(frame, bounds));
      pageIndex += 1;
    });
  }
  const end: RosterBridgeSavedWindowEndFrame = Object.freeze({
    type: "saved_window_end",
    requestId,
    rows,
    pageCount: closedFrames,
  });
  frames.push(encodeRosterBridgeFrame(end, bounds));
  return Object.freeze({ frames: Object.freeze(frames), rows, pageCount: closedFrames, totalBytes });
}

type SavedWindowUnit =
  | { readonly kind: "page"; readonly entries: OwnerSavedEntry[] }
  | { readonly kind: "fragments"; readonly parts: readonly string[] };

/**
 * Bytes one code point of an entry's canonical text costs once that text is
 * itself JSON-encoded as a fragment string. The canonical text never contains a
 * raw control character (JSON escaped those), so only `"` and `\` grow.
 */
function savedFragmentCost(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x20) return 6;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Split one entry's canonical text into fragment texts, each of which fits one
 * fragment frame within the page byte bound, cutting only at code-point
 * boundaries. The fixed overhead is measured with the cap's own digit widths, so
 * no real fragment can exceed it. Null when even one code point cannot fit.
 */
function splitSavedEntryText(
  requestId: string,
  text: string,
  bounds: RosterBridgeBounds,
  cap: number,
): readonly string[] | null {
  const overhead = Buffer.byteLength(JSON.stringify({
    type: "saved_window_fragment",
    requestId,
    pageIndex: cap,
    part: cap,
    parts: cap,
    text: "",
  }), "utf8");
  const budget = bounds.maxPageBytes - overhead;
  if (budget < 6) return null;
  const parts: string[] = [];
  let start = 0;
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const cost = savedFragmentCost(codePoint);
    if (used + cost > budget && index > start) {
      parts.push(text.slice(start, index));
      start = index;
      used = 0;
    }
    used += cost;
    index += width;
  }
  if (index > start) parts.push(text.slice(start));
  return parts.length === 0 ? null : Object.freeze(parts);
}
