/**
 * Viewer side of the authenticated roster metadata channel (issue #478).
 *
 * This module projects an owner's roster into display-ready rows for a remote
 * sidebar over one already-authenticated {@link PeerByteChannel}. It is
 * constructed explicitly by the client process: importing it creates no socket,
 * listener, timer, or store, and nothing is sent until `attach` is called. It
 * never becomes a second roster — the owner's manager is authoritative and this
 * projection is explicitly non-authoritative, so a remote sidebar can render the
 * same facts it renders locally while every action still belongs to the owner.
 *
 * Ordering is fixed: the message handler is installed before the hello is sent,
 * so a prompt acknowledgement cannot be missed; the viewer subscribes only after
 * `hello_ack`; and the owner sends nothing eagerly. The handler is registered
 * first because the transport preserves message boundaries, not because any
 * polling would notice a missed frame.
 *
 * Rows are published atomically and only from a complete, validated
 * `snapshot_begin`/`snapshot_page`/`snapshot_end` sequence: identifiers, page
 * indices, row counts, aggregate size, and duplicate row ids are all checked,
 * and a partial or invalid transfer never becomes current. Unknown and absent
 * owner facts stay unknown — a lost channel, an unavailable source, or a refused
 * request marks the observations not current and never manufactures an empty,
 * idle, or zero-count roster.
 *
 * The projection distinguishes three states: `empty` (no snapshot has ever
 * completed), `current` (the live subscription's last complete snapshot is
 * authoritative now), and `stale` (the rows are last-observed only). A complete
 * snapshot with zero rows is `current` with no rows, which is a real fact and not
 * the same thing as knowing nothing.
 *
 * Explicit resync retires the old subscription, waits for its stop
 * acknowledgement, and starts a fresh subscription identifier that is accepted
 * even when the owner's current revision is unchanged: freshness is recovered by
 * re-subscribing, never by requiring an owner mutation. Retirement is one shared
 * operation: overlapping resyncs and a stop racing a resync join the outstanding
 * retirement instead of replacing its acknowledgement, stop records its intent
 * synchronously so no waiting continuation can start another subscription, frames
 * already admitted for the retiring identifier are discarded as noise rather than
 * failing the channel, and a subscription this side abandoned on its own is still
 * named to the owner before any replacement — if the owner never confirms, the
 * channel is closed instead of reused. The owner run is pinned per subscription, so
 * another run is adoptable only across a fresh subscription boundary. There is no
 * reconnect, retry, backoff, or heartbeat policy here, and no claim that a resolved
 * send means the peer received anything. Every asynchronous send owns its rejection,
 * because the transport only catches synchronous handler throws.
 *
 * The same channel also carries the optional owner Close exchange, only when the
 * owner's acknowledgement retained {@link ROSTER_BRIDGE_CLOSE_CAPABILITY}.
 * {@link RosterBridgeViewer.closeSession} generates its own fresh request id and
 * answers with one fixed result union: an owner-reported fact set, a positively
 * not-sent refusal (no bytes ever handed to the transport), or `unknown`. A
 * resolved send is never an exit, a lost reply is never "never happened", and
 * nothing is queued, replayed, or optimistically removed from the projection: only
 * a later complete snapshot can change the rows.
 */

import { randomUUID } from "node:crypto";
import type { PeerByteChannel } from "./channel";
import type { PeerKey } from "./identity";
import type { OwnerCloseRequest, PeerCloseResult } from "./peer-close";
import type { RemoteSessionMetadata } from "./roster-metadata";
import {
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  isRosterBridgeIdentifier,
  resolveRosterBridgeBounds,
  reviewRosterBridgeHelloAck,
  type RosterBridgeBounds,
  type RosterBridgeCloseResultFrame,
  type RosterBridgeErrorCode,
  type RosterBridgeFrame,
} from "./roster-bridge-protocol";

/** Whether the projected rows are authoritative now, known to be absent, or merely last seen. */
export type RosterBridgeProjectionState = "empty" | "current" | "stale";

/** Why the projection is not current. Local diagnostic only; never carries owner content. */
export type RosterBridgeStalenessReason =
  | "subscribing"
  | "handshake-refused"
  | "handshake-timeout"
  | "source-unavailable"
  | "authorization-refused"
  | "run-changed"
  | "transfer-failed"
  | "revision-regression"
  | "protocol-violation"
  | "channel-closed"
  | "stopped"
  | "owner-error";

export interface RosterBridgeProjection {
  readonly state: RosterBridgeProjectionState;
  /**
   * Rows of the last complete snapshot. In `stale` these are last-observed rows
   * and must not be presented as current; in `empty` no snapshot has ever
   * completed, which is distinct from a complete snapshot that had zero rows.
   */
  readonly rows: readonly RemoteSessionMetadata[];
  /** Owner run identity of the published snapshot, or null when none was published. */
  readonly hostRunId: string | null;
  /** Revision of the published snapshot, or null when none was published. */
  readonly revision: number | null;
  /** Subscription that produced the published snapshot. */
  readonly subscriptionId: string | null;
  readonly reason: RosterBridgeStalenessReason | null;
}

/** Fixed local failure codes. Never a frame, row, path, or exception detail. */
export type RosterBridgeViewerErrorCode =
  | "stopped"
  | "refused"
  | "timeout"
  | "send-failed"
  | "transfer-failed"
  | "protocol-violation"
  | "channel-closed"
  | "already-subscribed"
  | "not-ready";

const VIEWER_ERROR_MESSAGES: Record<RosterBridgeViewerErrorCode, string> = {
  stopped: "roster metadata viewer was stopped",
  refused: "roster metadata owner refused the request",
  timeout: "roster metadata transfer did not complete in time",
  "send-failed": "roster metadata send failed",
  "transfer-failed": "roster metadata transfer failed",
  "protocol-violation": "roster metadata protocol violation",
  "channel-closed": "roster metadata channel closed",
  "already-subscribed": "roster metadata viewer already has a subscription",
  "not-ready": "roster metadata viewer handshake is not ready",
};

export class RosterBridgeViewerError extends Error {
  readonly code: RosterBridgeViewerErrorCode;

  constructor(code: RosterBridgeViewerErrorCode) {
    super(VIEWER_ERROR_MESSAGES[code]);
    this.name = "RosterBridgeViewerError";
    this.code = code;
  }
}

export function isRosterBridgeViewerError(value: unknown): value is RosterBridgeViewerError {
  return value instanceof RosterBridgeViewerError;
}

/** Fixed diagnostic codes. Never a row, label, key, frame, or exception. */
export type RosterBridgeViewerDiagnosticCode =
  | "hello_accepted"
  | "hello_refused"
  | "subscribed"
  | "unsubscribed"
  | "snapshot_published"
  | "snapshot_rejected"
  | "owner_error"
  | "protocol_violation"
  | "send_failed"
  | "channel_closed"
  | "viewer_stopped";

export interface RosterBridgeViewerDiagnostic {
  readonly code: RosterBridgeViewerDiagnosticCode;
  readonly role: "viewer";
  readonly rowCount?: number;
}

export type RosterBridgeViewerDiagnosticSink = (event: RosterBridgeViewerDiagnostic) => void;

export interface RosterBridgeViewerOptions {
  /** An authenticated channel to a peer running the roster metadata owner. */
  readonly channel: PeerByteChannel;
  readonly bounds?: Partial<RosterBridgeBounds>;
  /** Optional capability identifiers to offer; unknown ones grant nothing. */
  readonly capabilities?: readonly string[];
  readonly onProjection?: (projection: RosterBridgeProjection) => void;
  readonly onDiagnostic?: RosterBridgeViewerDiagnosticSink;
}

export interface RosterBridgeViewer {
  /** Exact verified identity of the owner this projection came from. */
  readonly peerKey: PeerKey;
  /** Current projection. Never a live view of owner state. */
  readonly projection: RosterBridgeProjection;
  readonly subscriptionId: string | null;
  /**
   * Optional capabilities this owner acknowledged for this channel. Read-only:
   * an acknowledgement states what the owner can honour, and never grants this
   * side any authority of its own.
   */
  readonly capabilities: readonly string[];
  /** True only when this owner acknowledged the optional Close capability. */
  readonly supportsClose: boolean;
  /** Resolves on `hello_ack`; rejects on refusal, protocol failure, or channel loss. */
  readonly hello: Promise<void>;
  /** Subscribes and resolves with that subscription's first complete snapshot. */
  subscribe(): Promise<RosterBridgeProjection>;
  /**
   * Stops the current subscription, waits for its acknowledgement, and starts a
   * fresh subscription identifier. Works even when the owner's current revision
   * equals the last published one.
   */
  resync(): Promise<RosterBridgeProjection>;
  /**
   * Ask this owner to close exactly one of its rows through the shared owner
   * provider. Never throws and never surfaces a raw error: the fixed result says
   * what is actually known, and only a later complete snapshot can change the
   * projected rows.
   *
   * `options.stillCurrent` is this caller's own last-instant fence over the
   * destination, pin, and epoch its request was authorized against. It is
   * evaluated synchronously immediately before the bytes are handed to the
   * transport, so a queued request whose destination changed in the meantime is
   * never submitted.
   */
  closeSession(
    request: OwnerCloseRequest,
    options?: { readonly stillCurrent?: () => boolean },
  ): Promise<PeerCloseResult>;
  /** Idempotent: unsubscribes, discards any partial transfer, and detaches. */
  stop(): Promise<void>;
  onProjection(listener: (projection: RosterBridgeProjection) => void): () => void;
}

/** Queued viewer control sends. Control traffic is hello, subscribe, unsubscribe, close, and errors. */
const MAX_QUEUED_VIEWER_SENDS = 4;

/**
 * Optional capabilities this viewer knows and offers. Offering one grants
 * nothing: it only makes the owner's acknowledgement possible, and the owner
 * narrows it further to what it can really honour.
 */
const DEFAULT_OFFERED_CAPABILITIES: readonly string[] = Object.freeze([
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
]);

/** One outstanding close: its own deadline, and the one settlement it may have. */
interface PendingClose {
  readonly requestId: string;
  readonly rowId: string;
  readonly settle: (result: PeerCloseResult) => void;
  timer: NodeJS.Timeout | null;
}

/** Why a write was refused before it was handed to the transport. */
type ViewerSendRefusal = "not-ready" | "target-unavailable";

type ViewerSendOutcome =
  | { readonly ok: true }
  /** No bytes were handed to the transport: nothing was submitted. */
  | { readonly ok: false; readonly sent: false; readonly reason: ViewerSendRefusal }
  /** The transport write was invoked, so acceptance can no longer be excluded. */
  | { readonly ok: false; readonly sent: true };

/**
 * One last-instant decision, evaluated synchronously inside the write that is
 * about to call `channel.send`. Refusing here is positive proof of a
 * pre-submission lifetime end: the transport was never invoked.
 */
type ViewerSendGate = () => { readonly allow: true } | { readonly allow: false; readonly reason: ViewerSendRefusal };

type ViewerState = "awaiting_ack" | "ready" | "subscribed" | "failed" | "detached";

interface PartialTransfer {
  readonly transferId: string;
  readonly hostRunId: string;
  readonly revision: number;
  readonly totalRows: number;
  readonly pageCount: number;
  rows: RemoteSessionMetadata[];
  ids: Set<string>;
  pageIndex: number;
  bytes: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody is waiting on yet must never surface as an unhandled
  // rejection: the caller learns the outcome through the projection regardless.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function wireCodeToReason(code: RosterBridgeErrorCode): RosterBridgeStalenessReason {
  switch (code) {
    case "unavailable":
      return "source-unavailable";
    case "not_authorized":
      return "authorization-refused";
    case "run_changed":
      return "run-changed";
    case "protocol_violation":
    case "bad_frame":
      return "protocol-violation";
    default:
      return "transfer-failed";
  }
}

function wireCodeToViewerError(code: RosterBridgeErrorCode): RosterBridgeViewerErrorCode {
  switch (code) {
    case "unavailable":
    case "not_authorized":
      return "refused";
    case "protocol_violation":
    case "bad_frame":
      return "protocol-violation";
    default:
      return "transfer-failed";
  }
}

/**
 * Strict local validation of one close request before anything is encoded. Both
 * owner identifiers must be carryable opaque identifiers and the confirmation
 * must be a real boolean: nothing else is ever submitted.
 */
function isCloseRequest(value: unknown, bounds: RosterBridgeBounds): value is OwnerCloseRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isRosterBridgeIdentifier(record.hostRunId, bounds)) return false;
  if (!isRosterBridgeIdentifier(record.rowId, bounds)) return false;
  return typeof record.confirmed === "boolean";
}

class ViewerBinding implements RosterBridgeViewer {
  readonly peerKey: PeerKey;

  readonly #channel: PeerByteChannel;
  readonly #bounds: RosterBridgeBounds;
  readonly #offeredCapabilities: readonly string[];
  readonly #listeners = new Set<(projection: RosterBridgeProjection) => void>();
  readonly #diagnostic: (code: RosterBridgeViewerDiagnosticCode, rowCount?: number) => void;
  readonly #helloDeferred = deferred<void>();
  #projection: RosterBridgeProjection;
  #detach: (() => void) | null = null;
  #state: ViewerState = "awaiting_ack";
  #subscriptionId: string | null = null;
  #transfer: PartialTransfer | null = null;
  #firstSnapshot: Deferred<RosterBridgeProjection> | null = null;
  /**
   * Subscription whose `unsubscribe` is outstanding. Its identifier is remembered
   * until the owner confirms, so frames the owner had already admitted are
   * discarded as retirement noise rather than mistaken for a protocol violation,
   * and so a locally forced retirement can be confirmed before any replacement.
   */
  #retiringId: string | null = null;
  /** Shared barrier for the outstanding retirement; concurrent callers join it. */
  #retirement: Promise<void> | null = null;
  #retirementAck: Deferred<void> | null = null;
  #retirementTimer: NodeJS.Timeout | null = null;
  /**
   * Every unconfirmed retirement fails closed. An owner that never acknowledges may
   * still hold that subscription, so the channel is closed instead of being reused
   * for a second subscription it would refuse, whether the retirement began as an
   * explicit stop, a resync, or a transfer this side gave up on.
   */
  #retirementFailClosed = false;
  /** Terminal stop intent, recorded synchronously so no continuation can resubscribe. */
  #stopRequested = false;
  /**
   * Owner run pinned for the live subscription. Another run is adoptable only on a
   * fresh subscription, never as a mid-subscription surprise.
   */
  #subscriptionRun: string | null = null;
  /** Optional capabilities the owner acknowledged for this channel. Read-only. */
  #capabilities: readonly string[] = Object.freeze([]);
  /** Outstanding closes by this side's own request id, and the per-row fence. */
  readonly #pendingCloses = new Map<string, PendingClose>();
  readonly #pendingCloseRows = new Map<string, string>();
  #helloSettled = false;
  #lastComplete: { readonly hostRunId: string; readonly revision: number; readonly subscriptionId: string } | null = null;
  #startTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #handshakeTimer: NodeJS.Timeout | null = null;
  #sendTail: Promise<void> = Promise.resolve();
  #queuedSends = 0;
  #stopPromise: Promise<void> | null = null;

  constructor(
    options: RosterBridgeViewerOptions,
    bounds: RosterBridgeBounds,
    diagnostic: (code: RosterBridgeViewerDiagnosticCode, rowCount?: number) => void,
  ) {
    this.#channel = options.channel;
    this.#bounds = bounds;
    this.#diagnostic = diagnostic;
    this.peerKey = options.channel.peerKey;
    const extra = options.capabilities === undefined ? [] : [...new Set(options.capabilities)];
    // The required baseline and every capability this implementation knows are
    // offered first, and the list is deduplicated: a caller that repeats one must
    // not produce a frame the encoder refuses.
    this.#offeredCapabilities = Object.freeze([
      ...new Set([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ...DEFAULT_OFFERED_CAPABILITIES, ...extra]),
    ]);
    this.#projection = Object.freeze({
      state: "empty" as RosterBridgeProjectionState,
      rows: Object.freeze([]) as readonly RemoteSessionMetadata[],
      hostRunId: null,
      revision: null,
      subscriptionId: null,
      reason: null,
    });
    if (typeof options.onProjection === "function") this.#listeners.add(options.onProjection);
    // Handler first, hello second: an acknowledgement that arrives immediately
    // must not be missed. Nothing else is sent until the owner acknowledges.
    this.#detach = options.channel.onMessage((bytes) => this.#onMessage(bytes));
    void options.channel.closed.then(() => {
      this.#diagnostic("channel_closed");
      this.#onChannelClosed();
    }, () => {
      this.#onChannelClosed();
    });
    this.#handshakeTimer = this.#arm(null, bounds.handshakeTimeoutMs, () => {
      this.#handshakeTimer = null;
      if (this.#state !== "awaiting_ack") return;
      this.#diagnostic("hello_refused");
      this.#state = "failed";
      this.#setProjection({ state: "stale", reason: "handshake-timeout" });
      this.#rejectHello(new RosterBridgeViewerError("timeout"));
    });
    this.#sendControl({
      type: "hello",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: this.#offeredCapabilities,
    }).catch(() => {
      if (this.#state !== "awaiting_ack") return;
      this.#state = "failed";
      this.#setProjection({ state: "stale", reason: "handshake-refused" });
      this.#rejectHello(new RosterBridgeViewerError("send-failed"));
    });
  }

  get projection(): RosterBridgeProjection {
    return this.#projection;
  }

  get subscriptionId(): string | null {
    return this.#subscriptionId;
  }

  get capabilities(): readonly string[] {
    return this.#capabilities;
  }

  get supportsClose(): boolean {
    return this.#capabilities.includes(ROSTER_BRIDGE_CLOSE_CAPABILITY);
  }

  get hello(): Promise<void> {
    return this.#helloDeferred.promise;
  }

  onProjection(listener: (projection: RosterBridgeProjection) => void): () => void {
    if (typeof listener !== "function") return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribe(): Promise<RosterBridgeProjection> {
    const refusal = this.#refusal();
    if (refusal !== null) return Promise.reject(refusal);
    if (this.#state === "subscribed") return Promise.reject(new RosterBridgeViewerError("already-subscribed"));
    return this.#awaitRetirement().then(() => {
      const late = this.#refusal();
      if (late !== null) throw late;
      if (this.#state === "subscribed") throw new RosterBridgeViewerError("already-subscribed");
      return this.#helloDeferred.promise.then(() => this.#startSubscription());
    });
  }

  resync(): Promise<RosterBridgeProjection> {
    const refusal = this.#refusal();
    if (refusal !== null) return Promise.reject(refusal);
    // Overlapping resyncs join the same retirement instead of replacing its
    // acknowledgement, so every caller settles on one unsubscribe.
    return this.#beginRetirement("graceful", undefined, "stopped").then(() => {
      const late = this.#refusal();
      if (late !== null) throw late;
      if (this.#state === "awaiting_ack") return this.#helloDeferred.promise.then(() => this.#startSubscription());
      if (this.#state !== "ready") throw new RosterBridgeViewerError("not-ready");
      return this.#startSubscription();
    });
  }

  /**
   * Ask the owner to close exactly one of its rows through its own provider.
   *
   * Every refusal before the transport write is positively `not-sent`; once
   * `send` has been invoked the only honest answers are the owner's own facts or
   * `unknown`. Each call uses its own fresh request id, and the pending entry is
   * settled exactly once by a matching result, the finite deadline, or channel
   * loss — never by an unsolicited, stale, or duplicated reply, and never by a
   * replay. Rows are not touched here: only a later complete snapshot can change
   * the projection.
   *
   * A write that is still queued when this request's lifetime ends (deadline,
   * stop, channel loss, or a failed caller fence) is invalidated at the dispatch
   * boundary and never reaches the transport, so a delayed drain can never
   * deliver a destructive request after its own lifetime.
   */
  closeSession(
    request: OwnerCloseRequest,
    options: { readonly stillCurrent?: () => boolean } = {},
  ): Promise<PeerCloseResult> {
    const refusal = this.#closeRefusal();
    if (refusal !== null) return Promise.resolve(refusal);
    // The owner acknowledged no Close support for this channel, so no close frame
    // exists to send at all.
    if (!this.supportsClose) return Promise.resolve({ kind: "not-sent", reason: "capability-unsupported" });
    if (!isCloseRequest(request, this.#bounds)) {
      return Promise.resolve({ kind: "not-sent", reason: "invalid-request" });
    }
    // One in-flight close per row, and a bounded pending map: a duplicate or an
    // overflow is refused here rather than queued behind live work.
    if (this.#pendingCloseRows.has(request.rowId)) return Promise.resolve({ kind: "not-sent", reason: "busy" });
    if (this.#pendingCloses.size >= this.#bounds.maxSnapshotRows) {
      return Promise.resolve({ kind: "not-sent", reason: "row-limit" });
    }
    const requestId = randomUUID();
    const outcome = deferred<PeerCloseResult>();
    const pending: PendingClose = {
      requestId,
      rowId: request.rowId,
      settle: (result) => outcome.resolve(result),
      timer: null,
    };
    this.#pendingCloses.set(requestId, pending);
    this.#pendingCloseRows.set(request.rowId, requestId);
    pending.timer = this.#arm(null, this.#bounds.closeResultTimeoutMs, () => {
      pending.timer = null;
      // A silent owner is unobservable, not "never happened": the row may already
      // be stopping, and nothing is re-sent on its behalf.
      this.#settleClose(requestId, { kind: "unknown" });
    });
    const stillCurrent = options.stillCurrent;
    // The lifetime latch: this exact request must still be outstanding, this
    // viewer must not have stopped or failed, and the caller's own destination /
    // pin / epoch fence must still hold — all checked synchronously inside the
    // write that is about to call `channel.send`.
    const gate: ViewerSendGate = () => {
      if (this.#stopRequested || this.#state === "detached" || this.#state === "failed") {
        return { allow: false, reason: "not-ready" };
      }
      if (this.#pendingCloses.get(requestId) !== pending) {
        return { allow: false, reason: "not-ready" };
      }
      if (stillCurrent !== undefined) {
        try {
          if (stillCurrent() !== true) return { allow: false, reason: "target-unavailable" };
        } catch {
          // An unavailable fence decision is no decision at all.
          return { allow: false, reason: "target-unavailable" };
        }
      }
      return { allow: true };
    };
    void this.#queueSend({
      type: "close_request",
      requestId,
      hostRunId: request.hostRunId,
      rowId: request.rowId,
      confirmed: request.confirmed,
    }, gate).then((written) => {
      if (written.ok) return;
      if (!written.sent) {
        // Positive proof this request never reached the transport.
        this.#settleClose(requestId, { kind: "not-sent", reason: written.reason });
        return;
      }
      // The write was invoked and then rejected: the owner may still have accepted
      // it, so no outcome is established either way.
      this.#settleClose(requestId, { kind: "unknown" });
    });
    return outcome.promise;
  }

  /** The single reason this viewer cannot submit a close now, or null. */
  #closeRefusal(): PeerCloseResult | null {
    if (this.#stopRequested || this.#state === "detached") return { kind: "not-sent", reason: "not-ready" };
    if (this.#state === "failed") return { kind: "not-sent", reason: "not-ready" };
    // Before the acknowledgement there is no negotiated capability at all, so
    // nothing may be submitted: this is the pre-handshake "no eligible channel".
    if (this.#state === "awaiting_ack") return { kind: "not-sent", reason: "not-ready" };
    return null;
  }

  /**
   * One owner answer, matched only by the request id THIS side generated. An
   * unsolicited, duplicated, foreign, or already-timed-out reply resolves nothing
   * and is dropped: it can never settle another operation or fail the channel.
   */
  #onCloseResult(frame: RosterBridgeCloseResultFrame): void {
    if (!this.#pendingCloses.has(frame.requestId)) return;
    this.#settleClose(frame.requestId, { kind: "owner-result", facts: frame.outcome });
  }

  /** Settle one pending close exactly once and release its timer and fences. */
  #settleClose(requestId: string, result: PeerCloseResult): void {
    const pending = this.#pendingCloses.get(requestId);
    if (pending === undefined) return;
    this.#pendingCloses.delete(requestId);
    if (this.#pendingCloseRows.get(pending.rowId) === requestId) this.#pendingCloseRows.delete(pending.rowId);
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.settle(result);
  }

  /** Every outstanding close becomes unknown: lost channels are never replayed. */
  #settleAllCloses(): void {
    for (const requestId of [...this.#pendingCloses.keys()]) {
      this.#settleClose(requestId, { kind: "unknown" });
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    // Recorded synchronously: a resync already waiting on a retirement cannot
    // start another subscription once stop has been requested.
    this.#stopRequested = true;
    // Every outstanding close settles honestly as unknown before any await: a
    // stopped viewer cannot observe an owner's answer, and nothing is replayed.
    this.#settleAllCloses();
    const wasAwaitingAck = this.#state === "awaiting_ack";
    this.#stopPromise = this.#awaitRetirement()
      .then(() => this.#beginRetirement("graceful", undefined, "stopped"))
      .then(() => {
        // Evaluated after the retirement settles: transport loss or a fail-closed
        // close can happen while stop is waiting, and that terminal reason survives.
        // A later stop is local bookkeeping, not a clean unsubscribe.
        const alreadyDetached = this.#state === "detached";
        this.#detachNow();
        this.#state = "detached";
        this.#diagnostic("viewer_stopped");
        // Last-observed rows stay visible as explicitly not current. Stopping ends
        // metadata delivery; it never clears the roster to empty or idle.
        if (!alreadyDetached) {
          if (this.#projection.revision !== null) this.#setProjection({ state: "stale", reason: "stopped" });
          else this.#setProjection({ state: "empty", reason: "stopped" });
        }
        const pending = this.#firstSnapshot;
        this.#firstSnapshot = null;
        pending?.reject(new RosterBridgeViewerError("stopped"));
        // A hello that never received its acknowledgement has to settle here: the
        // handler is detached, so nothing else will ever resolve or reject it, and
        // every operation chained to it would wait forever on a stopped viewer.
        if (wasAwaitingAck) this.#rejectHello(new RosterBridgeViewerError("stopped"));
      });
    return this.#stopPromise;
  }

  /** The single reason this viewer cannot start a subscription, or null. */
  #refusal(): RosterBridgeViewerError | null {
    if (this.#stopRequested || this.#state === "detached") return new RosterBridgeViewerError("stopped");
    if (this.#state === "failed") return new RosterBridgeViewerError("refused");
    return null;
  }

  /** Join the outstanding retirement, if any. Never rejects. */
  #awaitRetirement(): Promise<void> {
    return this.#retirement ?? Promise.resolve();
  }

  /** The hello settles exactly once: ack, refusal, timeout, loss, and stop share it. */
  #resolveHello(): void {
    if (this.#helloSettled) return;
    this.#helloSettled = true;
    this.#helloDeferred.resolve();
  }

  #rejectHello(error: RosterBridgeViewerError): void {
    if (this.#helloSettled) return;
    this.#helloSettled = true;
    this.#helloDeferred.reject(error);
  }

  #startSubscription(): Promise<RosterBridgeProjection> {
    const refusal = this.#refusal();
    if (refusal !== null) return Promise.reject(refusal);
    if (this.#state !== "ready") return Promise.reject(new RosterBridgeViewerError("not-ready"));
    const subscriptionId = randomUUID();
    this.#subscriptionId = subscriptionId;
    // A fresh subscription is the only boundary at which another owner run may be
    // adopted; the pin is set by the first accepted snapshot of this subscription.
    this.#subscriptionRun = null;
    this.#transfer = null;
    this.#state = "subscribed";
    const outcome = deferred<RosterBridgeProjection>();
    this.#firstSnapshot = outcome;
    if (this.#projection.revision === null) this.#setProjection({ state: "empty", reason: "subscribing", subscriptionId });
    this.#armStartTimer();
    this.#diagnostic("subscribed");
    void this.#sendControl({ type: "subscribe", subscriptionId }).catch(() => {
      if (this.#subscriptionId !== subscriptionId) return;
      this.#abandonSubscription("transfer-failed", new RosterBridgeViewerError("send-failed"));
    });
    return outcome.promise;
  }

  /**
   * Retire the live subscription: discard any staged transfer, tell the owner
   * which subscription to release, and wait (bounded) for its confirmation.
   *
   * Concurrent callers join the one outstanding retirement rather than replacing
   * its acknowledgement or timer, and the retiring identifier stays remembered
   * until then, so snapshot frames the owner had already admitted before the
   * unsubscribe are discarded as noise instead of failing the channel.
   *
   * `graceful` is an explicit stop or resync. `local-failure` is a transfer this
   * side gave up on: the owner is told, and if it never confirms, the channel is
   * closed rather than reused for a subscription it would refuse. A
   * `owner-confirmed` end needs no notice at all.
   */
  #beginRetirement(
    kind: "graceful" | "local-failure" | "owner-confirmed",
    failure?: RosterBridgeViewerError,
    reason?: RosterBridgeStalenessReason,
  ): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    if (this.#state !== "subscribed" || this.#subscriptionId === null) {
      this.#transfer = null;
      this.#clearTransferTimers();
      if (reason !== undefined && this.#state !== "detached") this.#markNotCurrent(reason);
      return Promise.resolve();
    }
    const subscriptionId = this.#subscriptionId;
    this.#subscriptionId = null;
    this.#subscriptionRun = null;
    this.#transfer = null;
    this.#clearTransferTimers();
    this.#state = "ready";
    // The snapshot of a subscription being retired stops being authoritative the
    // moment the retirement starts, not when its acknowledgement arrives: the
    // window in between must never be presented as current.
    if (reason !== undefined) this.#markNotCurrent(reason);
    const pending = this.#firstSnapshot;
    this.#firstSnapshot = null;
    pending?.reject(failure ?? new RosterBridgeViewerError("stopped"));
    if (kind === "owner-confirmed") {
      // The owner ended this subscription itself: nothing to notify and nothing to
      // wait for, so a later explicit resync may start immediately.
      this.#diagnostic("unsubscribed");
      return Promise.resolve();
    }
    this.#retiringId = subscriptionId;
    // No retirement is trusted without the owner's confirmation, whichever path
    // started it: an unacknowledged one ends the channel rather than being reused.
    this.#retirementFailClosed = true;
    const ack = deferred<void>();
    this.#retirement = ack.promise;
    this.#retirementAck = ack;
    this.#retirementTimer = this.#arm(null, this.#bounds.stopAckTimeoutMs, () => {
      this.#retirementTimer = null;
      this.#completeRetirement(false);
    });
    void this.#sendControl({ type: "unsubscribe", subscriptionId }).catch(() => {
      this.#completeRetirement(false);
    });
    return ack.promise;
  }

  #completeRetirement(acknowledged: boolean): void {
    if (this.#retirement === null) return;
    const failClosed = this.#retirementFailClosed;
    this.#retiringId = null;
    this.#retirementFailClosed = false;
    this.#clearRetirementTimer();
    const ack = this.#retirementAck;
    this.#retirementAck = null;
    this.#retirement = null;
    if (acknowledged) this.#diagnostic("unsubscribed");
    // The barrier settles before anything else so no waiter can be stranded by a
    // later teardown or fail-closed close.
    ack?.resolve();
    if (this.#state === "ready" && this.#subscriptionId === null && !acknowledged) {
      // Without a confirmation this side cannot claim a clean stop: report the loss
      // of certainty rather than a stop the owner never acknowledged, and never an
      // empty roster.
      this.#markNotCurrent("channel-closed");
    }
    if (!acknowledged && failClosed) {
      // The owner was never told this subscription is gone, so reusing the channel
      // could collide with a watch it still considers live. End the metadata
      // session through the channel's bounded API instead of resuming, and let the
      // projection report transport loss rather than a clean stop it never saw.
      this.#detachHandler();
      if (this.#state === "ready" || this.#state === "subscribed") this.#state = "detached";
      void this.#channel.close().catch(() => undefined);
    }
  }

  #onMessage(bytes: Buffer): void {
    if (this.#state === "detached") return;
    let frame: RosterBridgeFrame;
    try {
      frame = decodeRosterBridgeFrame(bytes, this.#bounds);
    } catch {
      this.#protocolFailure();
      return;
    }
    try {
      this.#handle(frame);
    } catch {
      this.#protocolFailure();
    }
  }

  #handle(frame: RosterBridgeFrame): void {
    switch (frame.type) {
      case "hello_ack":
        this.#onHelloAck(frame);
        return;
      case "snapshot_begin":
        this.#onSnapshotBegin(frame);
        return;
      case "snapshot_page":
        this.#onSnapshotPage(frame);
        return;
      case "snapshot_end":
        this.#onSnapshotEnd(frame);
        return;
      case "unsubscribed":
        if (this.#retiringId !== null && frame.subscriptionId === this.#retiringId) {
          this.#completeRetirement(true);
        }
        return;
      case "error":
        this.#onOwnerError(frame.code, frame.subscriptionId);
        return;
      case "close_result":
        this.#onCloseResult(frame);
        return;
      default:
        // The viewer sends hello, subscribe, unsubscribe, close, and errors;
        // receiving one of those (or any other frame) means the peer is not
        // speaking this protocol.
        this.#protocolFailure();
    }
  }

  #onHelloAck(frame: Extract<RosterBridgeFrame, { type: "hello_ack" }>): void {
    if (this.#state !== "awaiting_ack") {
      this.#protocolFailure();
      return;
    }
    this.#clearHandshakeTimer();
    const verdict = reviewRosterBridgeHelloAck(frame, { capabilities: this.#offeredCapabilities });
    if (!verdict.ok) {
      this.#diagnostic("hello_refused");
      this.#state = "failed";
      this.#setProjection({ state: "stale", reason: "handshake-refused" });
      this.#helloDeferred.reject(new RosterBridgeViewerError("refused"));
      return;
    }
    this.#state = "ready";
    this.#diagnostic("hello_accepted");
    // The acknowledgement's capability set is what this channel may ever assume.
    // Nothing is enabled by it beyond protocol support, and it is never widened.
    this.#capabilities = Object.freeze([...verdict.capabilities]);
    this.#resolveHello();
  }

  /**
   * Frames for a subscription being retired are retirement noise: the owner may
   * have admitted them before its unsubscribe arrived. They are discarded, never
   * treated as a protocol violation, and never published.
   */
  #isRetiringNoise(subscriptionId: string): boolean {
    return this.#retiringId !== null && subscriptionId === this.#retiringId;
  }

  #onSnapshotBegin(frame: Extract<RosterBridgeFrame, { type: "snapshot_begin" }>): void {
    if (this.#isRetiringNoise(frame.subscriptionId)) return;
    if (this.#state !== "subscribed" || frame.subscriptionId !== this.#subscriptionId) return;
    if (this.#transfer !== null) {
      this.#protocolFailure();
      return;
    }
    const verdict = this.#acceptsCandidate(frame.hostRunId, frame.revision);
    if (!verdict.ok) {
      this.#diagnostic("snapshot_rejected");
      this.#abandonSubscription(verdict.reason, new RosterBridgeViewerError("transfer-failed"));
      return;
    }
    this.#subscriptionRun = frame.hostRunId;
    this.#transfer = {
      transferId: frame.transferId,
      hostRunId: frame.hostRunId,
      revision: frame.revision,
      totalRows: frame.totalRows,
      pageCount: frame.pageCount,
      rows: [],
      ids: new Set<string>(),
      pageIndex: 0,
      bytes: 0,
    };
    this.#armIdleTimer();
  }

  #onSnapshotPage(frame: Extract<RosterBridgeFrame, { type: "snapshot_page" }>): void {
    const transfer = this.#transfer;
    if (this.#isRetiringNoise(frame.subscriptionId)) return;
    if (this.#state !== "subscribed" || frame.subscriptionId !== this.#subscriptionId) return;
    if (transfer === null
      || frame.transferId !== transfer.transferId
      || frame.pageIndex !== transfer.pageIndex
      || frame.pageIndex >= transfer.pageCount) {
      // Out-of-order, duplicated, or foreign-transfer pages cannot be applied to
      // an atomic snapshot, so the whole transfer fails instead of landing
      // partially.
      this.#protocolFailure();
      return;
    }
    let bytes = transfer.bytes;
    const rows = [...transfer.rows];
    const ids = new Set(transfer.ids);
    for (const row of frame.rows) {
      if (rows.length >= transfer.totalRows || ids.has(row.id)) {
        this.#protocolFailure();
        return;
      }
      ids.add(row.id);
      bytes += Buffer.byteLength(JSON.stringify(row), "utf8");
      if (bytes > this.#bounds.maxSnapshotBytes) {
        this.#abandonSubscription("transfer-failed", new RosterBridgeViewerError("transfer-failed"));
        return;
      }
      rows.push(row);
    }
    transfer.rows = rows;
    transfer.ids = ids;
    transfer.bytes = bytes;
    transfer.pageIndex += 1;
    this.#armIdleTimer();
  }

  #onSnapshotEnd(frame: Extract<RosterBridgeFrame, { type: "snapshot_end" }>): void {
    const transfer = this.#transfer;
    if (this.#isRetiringNoise(frame.subscriptionId)) return;
    if (this.#state !== "subscribed" || frame.subscriptionId !== this.#subscriptionId) return;
    if (transfer === null || frame.transferId !== transfer.transferId) {
      this.#protocolFailure();
      return;
    }
    if (frame.revision !== transfer.revision
      || frame.totalRows !== transfer.totalRows
      || transfer.pageIndex !== transfer.pageCount
      || transfer.rows.length !== transfer.totalRows) {
      // An incomplete or inconsistent transfer never becomes current: the staged
      // rows are discarded rather than published as a partial roster.
      this.#diagnostic("snapshot_rejected");
      this.#abandonSubscription("transfer-failed", new RosterBridgeViewerError("transfer-failed"));
      return;
    }
    const subscriptionId = this.#subscriptionId;
    const rows = Object.freeze([...transfer.rows]);
    this.#transfer = null;
    this.#clearTransferTimers();
    this.#lastComplete = { hostRunId: transfer.hostRunId, revision: transfer.revision, subscriptionId };
    this.#setProjection({
      state: "current",
      rows,
      hostRunId: transfer.hostRunId,
      revision: transfer.revision,
      subscriptionId,
      reason: null,
    });
    this.#diagnostic("snapshot_published", rows.length);
    const pending = this.#firstSnapshot;
    this.#firstSnapshot = null;
    pending?.resolve(this.#projection);
  }

  #onOwnerError(code: RosterBridgeErrorCode, subscriptionId: string | undefined): void {
    if (this.#retiringId !== null && subscriptionId === this.#retiringId) {
      // The owner answered about the subscription being retired. That is its
      // confirmation, and it must not be dropped for no longer matching a live
      // subscription the viewer has already given up.
      this.#diagnostic("owner_error");
      this.#completeRetirement(true);
      return;
    }
    if (subscriptionId !== undefined && subscriptionId !== this.#subscriptionId) return;
    const reason = wireCodeToReason(code);
    this.#diagnostic("owner_error");
    if (this.#state === "awaiting_ack") {
      this.#clearHandshakeTimer();
      this.#state = "failed";
      this.#setProjection({ state: "stale", reason: "handshake-refused" });
      this.#rejectHello(new RosterBridgeViewerError("refused"));
      return;
    }
    if (this.#state === "subscribed") {
      // The owner ended the subscription on its own side and retired its watch, so
      // no unsubscribe is owed for it and no barrier blocks a later resync.
      this.#abandonSubscription(reason, new RosterBridgeViewerError(wireCodeToViewerError(code)), "owner-confirmed");
      return;
    }
    if (this.#projection.revision !== null) this.#setProjection({ state: "stale", reason });
  }

  /**
   * End the live subscription locally, discarding any partial transfer. Metadata
   * only: sessions are never stopped. A locally forced end still names the
   * subscription to the owner and gates any replacement on that confirmation,
   * because forgetting the identifier would leave the owner's watch running and
   * make the next subscription a second one it must refuse.
   */
  #abandonSubscription(
    reason: RosterBridgeStalenessReason,
    error: RosterBridgeViewerError,
    kind: "local-failure" | "owner-confirmed" = "local-failure",
  ): void {
    void this.#beginRetirement(kind, error, reason);
    if (this.#state === "subscribed") this.#state = "ready";
  }

  /** Keep the last rows and say plainly that they are no longer authoritative. */
  #markNotCurrent(reason: RosterBridgeStalenessReason): void {
    if (this.#projection.revision === null) this.#setProjection({ state: "empty", reason, subscriptionId: null });
    else this.#setProjection({ state: "stale", reason, subscriptionId: null });
  }

  #protocolFailure(): void {
    if (this.#state === "detached") return;
    this.#diagnostic("protocol_violation");
    void this.#sendControl({ type: "error", code: "bad_frame" }).catch(() => undefined);
    this.#abandonSubscription("protocol-violation", new RosterBridgeViewerError("protocol-violation"));
    if (this.#state === "awaiting_ack") {
      this.#clearHandshakeTimer();
      this.#state = "failed";
      this.#setProjection({ state: "stale", reason: "protocol-violation" });
      this.#rejectHello(new RosterBridgeViewerError("protocol-violation"));
    }
    // Closing the channel through its existing bounded API is what makes an
    // unfixable protocol failure observable even when the error frame above
    // could not be written.
    void this.#channel.close().catch(() => undefined);
  }

  #onChannelClosed(): void {
    if (this.#state === "detached") return;
    this.#clearTransferTimers();
    this.#clearHandshakeTimer();
    // Transport loss is the owner's answer for any retirement still outstanding:
    // the barrier settles so every waiting subscribe, resync, or stop settles too.
    this.#settleRetirement();
    // A lost channel never answers an outstanding close: no outcome is
    // established, and nothing is replayed or guessed at.
    this.#settleAllCloses();
    this.#transfer = null;
    this.#subscriptionId = null;
    this.#subscriptionRun = null;
    this.#detachHandler();
    // Rows are retained as explicitly not current: a lost channel is never an
    // empty roster.
    if (this.#projection.revision === null) this.#setProjection({ state: "empty", reason: "channel-closed" });
    else this.#setProjection({ state: "stale", reason: "channel-closed" });
    this.#state = "detached";
    const pending = this.#firstSnapshot;
    this.#firstSnapshot = null;
    pending?.reject(new RosterBridgeViewerError("channel-closed"));
    this.#rejectHello(new RosterBridgeViewerError("channel-closed"));
  }

  /** Release any outstanding retirement barrier without implying confirmation. */
  #settleRetirement(): void {
    this.#clearRetirementTimer();
    const ack = this.#retirementAck;
    this.#retirementAck = null;
    this.#retirement = null;
    this.#retiringId = null;
    this.#retirementFailClosed = false;
    ack?.resolve();
  }

  #setProjection(update: {
    readonly state: RosterBridgeProjectionState;
    readonly reason: RosterBridgeStalenessReason | null;
    readonly rows?: readonly RemoteSessionMetadata[];
    readonly hostRunId?: string | null;
    readonly revision?: number | null;
    readonly subscriptionId?: string | null;
  }): void {
    const previous = this.#projection;
    const next = Object.freeze({
      state: update.state,
      rows: update.rows ?? previous.rows,
      hostRunId: update.hostRunId ?? previous.hostRunId,
      revision: update.revision ?? previous.revision,
      subscriptionId: update.subscriptionId === undefined ? previous.subscriptionId : update.subscriptionId,
      reason: update.reason,
    });
    this.#projection = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch {
        // A presentation callback is never load-bearing for the projection.
      }
    }
  }

  /**
   * Freshness rule for a candidate snapshot.
   *
   * The owner run is pinned for the lifetime of one subscription: another run
   * arriving mid-subscription is refused rather than adopted, because accepting it
   * would let a peer present a stale run as current and step around the regression
   * guard below. Only a fresh subscription adopts another run, which is exactly the
   * boundary an explicit resync creates.
   *
   * Within one run, a later snapshot of the same subscription must be strictly
   * newer, while a snapshot published to a fresh subscription may carry the same
   * revision: an explicit resync recovers freshness without requiring an owner
   * mutation. A lower revision is a regression and is refused.
   */
  #acceptsCandidate(
    hostRunId: string,
    revision: number,
  ): { readonly ok: true; readonly reason: null } | { readonly ok: false; readonly reason: RosterBridgeStalenessReason } {
    if (this.#subscriptionRun !== null && hostRunId !== this.#subscriptionRun) {
      return { ok: false, reason: "run-changed" };
    }
    const last = this.#lastComplete;
    if (last === null) return { ok: true, reason: null };
    if (hostRunId !== last.hostRunId) {
      // Reachable only on a subscription that has not pinned a run yet, that is,
      // after a fresh subscribe or resync.
      return { ok: true, reason: null };
    }
    if (this.#subscriptionId !== last.subscriptionId) {
      return revision >= last.revision
        ? { ok: true, reason: null }
        : { ok: false, reason: "revision-regression" };
    }
    return revision > last.revision
      ? { ok: true, reason: null }
      : { ok: false, reason: "revision-regression" };
  }

  #sendControl(frame: RosterBridgeFrame): Promise<void> {
    return this.#queueSend(frame).then((outcome) => {
      if (outcome.ok) return;
      throw new RosterBridgeViewerError("send-failed");
    });
  }

  /**
   * One ordered control write, reported honestly: `ok` means the bytes were
   * admitted to the socket (never that the peer acted on them), and a failure says
   * whether `channel.send` was actually invoked, because that is the boundary
   * between "positively not submitted" and "acceptance cannot be excluded".
   *
   * `gate` is evaluated inside the write that is about to call `channel.send`, so
   * a request whose own lifetime ended while it was queued is discarded instead
   * of being delivered late.
   */
  #queueSend(frame: RosterBridgeFrame, gate?: ViewerSendGate): Promise<ViewerSendOutcome> {
    if (this.#state === "detached") {
      return Promise.resolve<ViewerSendOutcome>({ ok: false, sent: false, reason: "not-ready" });
    }
    if (this.#queuedSends >= MAX_QUEUED_VIEWER_SENDS) {
      // Control traffic is tiny and sequential by design; a backlog means the
      // channel is not draining, so nothing further is queued.
      this.#diagnostic("send_failed");
      return Promise.resolve<ViewerSendOutcome>({ ok: false, sent: false, reason: "not-ready" });
    }
    this.#queuedSends += 1;
    const write = (): Promise<ViewerSendOutcome> => {
      if (this.#state === "detached") {
        // A write that has not started by the time this viewer detached is never
        // submitted, so its caller can honestly report a pre-submission refusal.
        return Promise.resolve<ViewerSendOutcome>({ ok: false, sent: false, reason: "not-ready" });
      }
      if (gate !== undefined) {
        const decision = gate();
        if (!decision.allow) {
          this.#diagnostic("send_failed");
          return Promise.resolve<ViewerSendOutcome>({ ok: false, sent: false, reason: decision.reason });
        }
      }
      let bytes: Buffer;
      try {
        bytes = encodeRosterBridgeFrame(frame, this.#bounds);
      } catch {
        this.#diagnostic("send_failed");
        return Promise.resolve<ViewerSendOutcome>({ ok: false, sent: false, reason: "not-ready" });
      }
      let written: Promise<void>;
      try {
        written = this.#channel.send(bytes);
      } catch {
        // The write was invoked even though it refused immediately; a conservative
        // caller must not claim the bytes were never offered to the transport.
        this.#diagnostic("send_failed");
        return Promise.resolve<ViewerSendOutcome>({ ok: false, sent: true });
      }
      // Resolution means the bytes were admitted to the socket, nothing more.
      return written.then<ViewerSendOutcome, ViewerSendOutcome>(
        () => ({ ok: true }),
        () => {
          this.#diagnostic("send_failed");
          return { ok: false, sent: true };
        },
      );
    };
    const result = this.#sendTail.then(write, write);
    this.#sendTail = result.then(() => undefined, () => undefined);
    const release = (): void => {
      this.#queuedSends = Math.max(0, this.#queuedSends - 1);
    };
    void result.then(release, release);
    return result;
  }

  #arm(current: NodeJS.Timeout | null, ms: number, onElapsed: () => void): NodeJS.Timeout {
    if (current !== null) clearTimeout(current);
    const timer = setTimeout(onElapsed, ms);
    timer.unref?.();
    return timer;
  }

  #armStartTimer(): void {
    this.#startTimer = this.#arm(this.#startTimer, this.#bounds.snapshotStartTimeoutMs, () => {
      this.#startTimer = null;
      if (this.#state !== "subscribed" || this.#transfer !== null) return;
      this.#diagnostic("snapshot_rejected");
      this.#abandonSubscription("transfer-failed", new RosterBridgeViewerError("timeout"));
    });
  }

  #armIdleTimer(): void {
    this.#idleTimer = this.#arm(this.#idleTimer, this.#bounds.transferIdleTimeoutMs, () => {
      this.#idleTimer = null;
      if (this.#state !== "subscribed" || this.#transfer === null) return;
      this.#diagnostic("snapshot_rejected");
      // A stalled partial transfer is discarded whole; rows staged so far are
      // never published.
      this.#abandonSubscription("transfer-failed", new RosterBridgeViewerError("timeout"));
    });
  }

  #clearTransferTimers(): void {
    if (this.#startTimer !== null) {
      clearTimeout(this.#startTimer);
      this.#startTimer = null;
    }
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer === null) return;
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
  }

  #clearRetirementTimer(): void {
    if (this.#retirementTimer === null) return;
    clearTimeout(this.#retirementTimer);
    this.#retirementTimer = null;
  }

  #detachHandler(): void {
    const detach = this.#detach;
    this.#detach = null;
    if (detach === null) return;
    try {
      detach();
    } catch {
      // Detaching is best effort.
    }
  }

  #detachNow(): void {
    this.#clearTransferTimers();
    this.#clearHandshakeTimer();
    // No barrier may outlive the handler: whoever is waiting has to settle.
    this.#settleRetirement();
    // Nor may a close: a detached viewer observes no owner answer.
    this.#settleAllCloses();
    this.#detachHandler();
  }
}

/**
 * Attach a roster metadata viewer to one authenticated channel. The owner's
 * exact verified identity is available on the returned viewer so a caller can key
 * its own display state by identity rather than by any name seen on the wire.
 * Nothing is sent beyond the hello until {@link RosterBridgeViewer.subscribe} or
 * {@link RosterBridgeViewer.resync} is called, and
 * {@link RosterBridgeViewer.stop} releases the handler, timers, and partial
 * transfer references.
 */
export function attachRosterBridgeViewer(options: RosterBridgeViewerOptions): RosterBridgeViewer {
  if (options === null || typeof options !== "object") throw new TypeError("roster metadata viewer requires options");
  if (options.channel === null || typeof options.channel !== "object" || typeof options.channel.onMessage !== "function") {
    throw new TypeError("roster metadata viewer requires a peer byte channel");
  }
  const bounds = resolveRosterBridgeBounds(options.bounds);
  let diagnosticsEnabled = true;
  const diagnostic = (code: RosterBridgeViewerDiagnosticCode, rowCount?: number): void => {
    if (!diagnosticsEnabled || options.onDiagnostic === undefined) return;
    try {
      options.onDiagnostic({
        code,
        role: "viewer",
        ...(rowCount === undefined ? {} : { rowCount }),
      });
    } catch {
      diagnosticsEnabled = false;
    }
  };
  return new ViewerBinding(options, bounds, diagnostic);
}
