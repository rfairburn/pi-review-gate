/**
 * Owner side of the authenticated roster metadata channel (issue #478).
 *
 * This module turns one already-authenticated {@link PeerByteChannel} into a
 * metadata-only view of the host's authoritative inventory. It is constructed
 * explicitly by the host process and is never imported by the extension entry
 * point, the session host, the sidebar, instances, or the owning-host service:
 * importing this file creates no socket, listener, timer, store, or subscription,
 * and an idle host stays idle.
 *
 * Authority stays exactly where it was. The only owner capability used here is
 * the injected service's read-only inventory watch over the one manager, so this
 * module holds no rows of its own, is never a second roster, and never starts,
 * stops, writes, resizes, or closes a session from that watch. The optional
 * close provider is a SEPARATE injected callback supplied by the owner's Main
 * process, which already owns the only manager, roster, and row-removal path:
 * this bridge only forwards one request to it and reports its fixed facts back.
 * The optional create provider is the same kind of separate injected callback:
 * it is handed one exact owner run and one canonical workspace plus a minimal
 * re-proof, and this bridge only forwards the request and reports the fixed facts
 * back. Neither provider is wrapped or emulated here, and neither needs a selected
 * or displayed row, a viewer, a native conversation tuple, or a local prompt.
 * Stopping a subscription, fencing a channel, or losing the transport changes
 * metadata delivery only; it never cancels, rolls back, or reports an exit for a
 * close or a create the owner already accepted, and it never claims such an
 * operation exited because this binding is gone.
 *
 * Identity is the exact `channel.peerKey` proved by the live TLS handshake. A
 * friendly label and any key claimed in a frame are display data, never
 * identity, and are never compared as authority. The owner authorizer is a
 * trusted synchronous callback over that exact key and is evaluated when a
 * request is handled and again immediately before every protected write,
 * including a page or end frame queued earlier. `false` and a thrown exception
 * both mean authorization is unavailable. Refusal fences further metadata on
 * that channel and ends its subscription; it does not add a new
 * channel-revocation policy, and the transport's existing revoke behavior is
 * unchanged.
 *
 * Every update is one complete authoritative snapshot, never a delta, so a
 * revision jump is normal and only a same-run regression is invalid. One
 * transfer is in flight per channel and at most one newer snapshot is retained
 * as pending newest-wins work, which bounds change pressure without claiming to
 * replicate an event history. A source change that lands while the watch is
 * being installed is retained and delivered after the install snapshot instead
 * of overwriting it.
 *
 * A resolved `send()` means the bytes were admitted to the socket, not that the
 * peer received them, and a write admitted before a stop cannot be recalled.
 * Nothing here claims remote receipt. Every asynchronous send is owned, because
 * the transport only catches synchronous handler throws. A write belonging to a
 * cancelled transfer still resumes the work that replaced it once it settles,
 * because that write is what was holding the channel's single send slot. A control
 * write that fails outright is treated as an abort the peer never saw: the binding
 * retires its inventory watch, stops answering the channel, and closes it through the
 * channel's own bounded API, so a viewer can never be left presenting a retired
 * snapshot as current because its terminal frame was unwritable.
 */

import { randomUUID } from "node:crypto";
import type {
  OwningHostInventorySnapshot,
  OwningHostInventoryWatch,
  OwningHostService,
} from "../owning-host-service";
import type { PeerByteChannel } from "./channel";
import type { PeerKey } from "./identity";
import {
  isOwnerCloseFacts,
  type OwnerCloseFacts,
  type OwnerCloseHandler,
  type OwnerCloseRequest,
} from "./peer-close";
import {
  isOwnerCreateFacts,
  type OwnerCreateFacts,
  type OwnerCreateHandler,
  type OwnerCreateRequest,
} from "./peer-create";
import { isRemoteSessionMetadataError, toRemoteSessionMetadata, type RemoteSessionMetadata } from "./roster-metadata";
import {
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  buildRosterBridgeTransfer,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  isRosterBridgeProtocolError,
  negotiateRosterBridgeHello,
  resolveRosterBridgeBounds,
  rosterBridgeWireCodeForFailure,
  type RosterBridgeBounds,
  type RosterBridgeCloseRequestFrame,
  type RosterBridgeCreateRequestFrame,
  type RosterBridgeErrorCode,
  type RosterBridgeFrame,
  type RosterBridgeHelloFrame,
} from "./roster-bridge-protocol";

/**
 * The only owner capability this bridge needs: the one manager's read-only live
 * inventory watch, which also carries the snapshot captured at installation.
 * No read loop, no polling, and no second listing path is ever used here.
 */
export type RosterBridgeInventorySource = Pick<OwningHostService, "watchInventory">;

/**
 * Trusted synchronous authorization decision for one exact verified peer key.
 * Return `true` to allow metadata; `false` or a thrown exception means no
 * metadata may be written. It is called on each request and before each
 * protected write, so a revocation takes effect before the next frame.
 */
export type RosterBridgeAuthorizer = (peerKey: PeerKey) => boolean;

/** Fixed diagnostic codes. Never a row, path, label, key, frame, or exception. */
export type RosterBridgeOwnerDiagnosticCode =
  | "hello_accepted"
  | "hello_refused"
  | "subscribed"
  | "unsubscribed"
  | "snapshot_published"
  | "snapshot_pending_replaced"
  | "snapshot_failed"
  | "authorization_refused"
  | "source_unavailable"
  | "run_changed"
  | "protocol_violation"
  | "send_failed"
  | "channel_closed"
  | "binding_stopped"
  | "close_accepted"
  | "close_refused"
  | "close_reply_dropped"
  | "create_accepted"
  | "create_refused"
  | "create_reply_dropped";

export interface RosterBridgeOwnerDiagnostic {
  readonly code: RosterBridgeOwnerDiagnosticCode;
  readonly role: "owner";
  readonly rows?: number;
  readonly pages?: number;
}

export type RosterBridgeOwnerDiagnosticSink = (event: RosterBridgeOwnerDiagnostic) => void;

export interface RosterBridgeHostOptions {
  /** The host's one authoritative inventory source (the owning-host service). */
  readonly inventory: RosterBridgeInventorySource;
  /** Required explicit policy: no authorizer means no metadata is ever written. */
  readonly authorizePeer: RosterBridgeAuthorizer;
  /**
   * The owner's ONE close provider, supplied by Main, which already owns the only
   * manager, roster, and row-removal path. Absent means this host never
   * acknowledges or accepts the Close capability and behaves exactly as a
   * metadata-only host does. Supplying it grants nothing by itself: every request
   * is reauthorized against the current proved peer key and directional
   * receiving grant before this handler can be reached.
   */
  readonly closeOwnedSession?: OwnerCloseHandler;
  /**
   * The owner's ONE rowless create provider, supplied by Main, which already owns
   * the only manager, run identity, and launch path. Absent means this host never
   * acknowledges or accepts the create capability and behaves exactly as a
   * metadata-and-close host does. Supplying it grants nothing by itself: every
   * request is reauthorized against the current proved peer key and directional
   * receiving grant immediately before this handler is reached, and the handler is
   * handed a minimal re-proof for its own last-instant check.
   */
  readonly createOwnedSession?: OwnerCreateHandler;
  readonly bounds?: Partial<RosterBridgeBounds>;
  readonly onDiagnostic?: RosterBridgeOwnerDiagnosticSink;
}

/** One attached channel. Stopping it ends metadata delivery and nothing else. */
export interface RosterBridgeChannelBinding {
  /** Exact verified peer identity of this channel. */
  readonly peerKey: PeerKey;
  /** Bounded display label from the certificate; never identity or authority. */
  readonly label: string | null;
  readonly subscriptionId: string | null;
  readonly subscribed: boolean;
  /** Cancel transfers, retire the source watch, and detach. Idempotent. */
  stop(): Promise<void>;
  /** Resolves once this binding is finished (stopped, fenced, or channel closed). */
  readonly closed: Promise<void>;
}

export interface RosterBridgeHost {
  /**
   * Attach one admitted application channel. Call this synchronously from
   * `onAppChannel`: the message handler is installed before this function
   * returns and the owner sends nothing until the viewer says hello.
   */
  attach(channel: PeerByteChannel): RosterBridgeChannelBinding;
  readonly activeBindingCount: number;
  readonly activeSubscriptionCount: number;
  /** Stop every binding's metadata delivery. Never closes a session. */
  stopAll(): Promise<void>;
}

type OwnerState = "awaiting_hello" | "ready" | "subscribed" | "finished";

interface InFlightTransfer {
  readonly frames: readonly Buffer[];
  readonly transferId: string;
  readonly hostRunId: string;
  readonly revision: number;
  readonly totalRows: number;
  readonly pageCount: number;
  index: number;
}

class OwnerBinding implements RosterBridgeChannelBinding {
  readonly peerKey: PeerKey;
  readonly label: string | null;

  readonly #channel: PeerByteChannel;
  readonly #options: RosterBridgeHostOptions;
  readonly #bounds: RosterBridgeBounds;
  readonly #diagnostic: (code: RosterBridgeOwnerDiagnosticCode, extra?: { rows?: number; pages?: number }) => void;
  readonly #closed: Promise<void>;
  #resolveClosed: () => void = () => undefined;
  #detach: (() => void) | null = null;
  #helloTimer: NodeJS.Timeout | null = null;
  #state: OwnerState = "awaiting_hello";
  #fenced = false;
  #fenceCode: RosterBridgeErrorCode = "bad_frame";
  /**
   * Optional capabilities acknowledged for this channel. The Close capability is
   * included only when the peer offered it AND this owner really holds its close
   * provider, and the create capability only when it really holds its create
   * provider, so a provider-less owner never widens anything.
   */
  #capabilities: readonly string[] = Object.freeze([]);
  /**
   * In-flight close requests by request id, plus the per-row fence that makes a
   * duplicate answerable without a second ladder. Both are bounded by the
   * existing roster row bound and are never an execution queue.
   */
  readonly #inflightCloses = new Set<string>();
  readonly #closeRows = new Set<string>();
  /**
   * The ONE in-flight create on this channel, plus this channel's monotonic
   * anti-replay high-water. They are two scalars, not a request history, replay
   * cache, queue, or authority registry: a sequence at or below the high-water is
   * refused before any provider is invoked, whether its request is still in flight
   * or already completed, and a second create while one is in flight is refused
   * rather than queued, evicted, or retargeted.
   *
   * The high-water is an ADMISSION fence only. It never invalidates an operation
   * this binding already accepted: a later request that advances or is refused on
   * that scalar neither cancels the earlier child nor drops its fixed result.
   */
  #inflightCreate: { readonly requestId: string; readonly hostRunId: string } | null = null;
  #createSequence = 0;
  #installing = false;
  #installUnavailable = false;
  #subscriptionRun: string | null = null;
  #subscriptionId: string | null = null;
  #watch: OwningHostInventoryWatch | null = null;
  #transfer: InFlightTransfer | null = null;
  #pending: OwningHostInventorySnapshot | null = null;
  #sending = false;
  #publishedRun: string | null = null;
  #publishedRevision = 0;
  #stopPromise: Promise<void> | null = null;
  #closeRequested = false;

  constructor(
    channel: PeerByteChannel,
    options: RosterBridgeHostOptions,
    bounds: RosterBridgeBounds,
    diagnostic: (code: RosterBridgeOwnerDiagnosticCode, extra?: { rows?: number; pages?: number }) => void,
    onFinished: () => void,
  ) {
    this.#channel = channel;
    this.#options = options;
    this.#bounds = bounds;
    this.#diagnostic = diagnostic;
    this.peerKey = channel.peerKey;
    this.label = channel.label;
    this.#closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    // The handler goes on first so no early frame can be missed, and the hello
    // guard is a finite deadline rather than an unbounded wait.
    this.#detach = channel.onMessage((bytes) => this.#onMessage(bytes));
    this.#helloTimer = setTimeout(() => {
      this.#helloTimer = null;
      if (this.#state !== "awaiting_hello") return;
      this.#diagnostic("hello_refused");
      this.#sendControl({ type: "error", code: "protocol_violation" });
      void this.#finish("hello_timeout");
    }, bounds.helloTimeoutMs);
    this.#helloTimer.unref?.();
    void channel.closed.then(() => {
      this.#diagnostic("channel_closed");
      void this.#finish("channel_closed");
      onFinished();
    }, () => {
      void this.#finish("channel_closed");
      onFinished();
    });
  }

  get subscriptionId(): string | null {
    return this.#subscriptionId;
  }

  get subscribed(): boolean {
    return this.#state === "subscribed";
  }

  get closed(): Promise<void> {
    return this.#closed;
  }

  stop(): Promise<void> {
    return this.#finish("stopped");
  }

  #onMessage(bytes: Buffer): void {
    // Synchronous by contract: every asynchronous step owns its own rejection,
    // because the transport only contains a throw from this handler.
    if (this.#state === "finished") return;
    let frame: RosterBridgeFrame;
    try {
      frame = decodeRosterBridgeFrame(bytes, this.#bounds);
    } catch {
      this.#violation();
      return;
    }
    try {
      this.#handle(frame);
    } catch {
      this.#violation();
    }
  }

  #handle(frame: RosterBridgeFrame): void {
    switch (frame.type) {
      case "hello":
        this.#onHello(frame);
        return;
      case "subscribe":
        this.#onSubscribe(frame.subscriptionId);
        return;
      case "unsubscribe":
        if (this.#state === "awaiting_hello" || this.#fenced) this.#refuse();
        else this.#onUnsubscribe(frame.subscriptionId);
        return;
      case "close_request":
        this.#onCloseRequest(frame);
        return;
      case "create_request":
        this.#onCreateRequest(frame);
        return;
      default:
        // A frame this side did not ask for (its own ack, an unknown type, or a
        // second hello) is a protocol violation, answered once.
        this.#violation();
    }
  }

  #onHello(frame: RosterBridgeHelloFrame): void {
    if (this.#state !== "awaiting_hello") {
      this.#violation();
      return;
    }
    this.#clearHelloTimer();
    const decision = negotiateRosterBridgeHello(frame);
    if (!decision.ok) {
      this.#diagnostic("hello_refused");
      this.#sendControl({ type: "error", code: decision.code });
      this.#fence(decision.code);
      return;
    }
    if (!this.#authorized()) {
      this.#diagnostic("authorization_refused");
      this.#sendControl({ type: "error", code: "not_authorized" });
      this.#fence("not_authorized");
      return;
    }
    this.#state = "ready";
    this.#diagnostic("hello_accepted");
    // The acknowledgement carries no roster content. Nothing else is sent until
    // the viewer subscribes: the owner is never eager. It states the capability
    // set in force for this session: the required baseline this owner implements,
    // plus only the optional capabilities both sides offered AND this owner can
    // really honour. Negotiation can only narrow what either side assumes.
    this.#capabilities = Object.freeze(decision.capabilities.filter((capability) => {
      if (capability === ROSTER_BRIDGE_CLOSE_CAPABILITY) {
        return typeof this.#options.closeOwnedSession === "function";
      }
      if (capability === ROSTER_BRIDGE_CREATE_CAPABILITY) {
        return typeof this.#options.createOwnedSession === "function";
      }
      return false;
    }));
    this.#sendControl({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: Math.min(frame.minor, ROSTER_BRIDGE_MINOR),
      capabilities: Object.freeze([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ...this.#capabilities]),
    });
  }

  #onSubscribe(subscriptionId: string): void {
    if (this.#state === "finished") return;
    if (this.#fenced) {
      this.#refuse();
      return;
    }
    if (this.#state === "awaiting_hello") {
      this.#violation();
      return;
    }
    if (this.#state === "subscribed") {
      // One metadata subscription per channel; the viewer must stop the current
      // subscription before starting another.
      this.#sendControl({
        type: "error",
        code: "too_many_subscriptions",
        subscriptionId: this.#subscriptionId ?? undefined,
      });
      this.#diagnostic("protocol_violation");
      return;
    }
    if (!this.#authorized()) {
      this.#diagnostic("authorization_refused");
      this.#sendControl({ type: "error", code: "not_authorized" });
      this.#fence("not_authorized");
      return;
    }
    // The source can notify this listener before `watchInventory()` returns, with
    // a change newer than the snapshot it is about to hand back. That observation
    // is retained as pending work rather than dropped or allowed to overwrite the
    // install snapshot, which is delivered first.
    this.#installing = true;
    this.#installUnavailable = false;
    let watch: OwningHostInventoryWatch | undefined;
    try {
      watch = this.#options.inventory.watchInventory((snapshot) => this.#onInventory(snapshot));
    } catch {
      watch = undefined;
    } finally {
      this.#installing = false;
    }
    if (watch === undefined || this.#installUnavailable) {
      // Unobservable inventory is a terminal failure for this attempt, never an
      // empty or idle snapshot. A later explicit subscription may recover.
      if (watch !== undefined) {
        try {
          watch.unsubscribe();
        } catch {
          // Retirement is best effort.
        }
      }
      this.#pending = null;
      this.#diagnostic("source_unavailable");
      this.#sendControl({ type: "error", code: "unavailable" });
      return;
    }
    this.#watch = watch;
    this.#subscriptionId = subscriptionId;
    this.#subscriptionRun = watch.snapshot.hostRunId;
    this.#state = "subscribed";
    this.#publishedRun = null;
    this.#publishedRevision = 0;
    this.#diagnostic("subscribed");
    // The install snapshot goes first; anything retained during installation is
    // published afterwards as a newer complete snapshot.
    this.#beginTransfer(watch.snapshot);
    void this.#drain();
  }

  #onUnsubscribe(subscriptionId: string): void {
    if (this.#state === "subscribed" && subscriptionId === this.#subscriptionId) {
      this.#retireSubscription();
      this.#state = "ready";
      this.#diagnostic("unsubscribed");
    }
    // Idempotent acknowledgement: an already-retired or unknown subscription is
    // confirmed without touching anything else. No session is affected either
    // way, and the channel stays open for an explicit fresh subscription.
    this.#sendControl({ type: "unsubscribed", subscriptionId });
  }

  // -------------------------------------------------------------------- close

  /**
   * Answer one close request with the owner's ONE provider, or not at all.
   *
   * Admission is decided here and now: the capability must have been negotiated
   * for this channel (which already required a real provider), the channel must
   * not be fenced or pre-hello, and the EXACT proved peer key must still carry
   * this owner's current directional receiving grant. Only then is the provider
   * reached, with the exact owner run, row, and confirmation the request named.
   *
   * The provider is invoked from a detached continuation on purpose: a long
   * owner stop must never block the ordered metadata receive path, so other
   * rows' requests, acknowledgements, and snapshots keep flowing while Main owns
   * the operation. There is one in-flight close per row and per request id; a
   * duplicate is answered with a fixed fact instead of being queued.
   */
  #onCloseRequest(frame: RosterBridgeCloseRequestFrame): void {
    if (this.#state === "finished") return;
    const handler = this.#options.closeOwnedSession;
    if (handler === undefined || !this.#capabilities.includes(ROSTER_BRIDGE_CLOSE_CAPABILITY)) {
      // Nothing was acknowledged for this channel, so a close frame is outside the
      // negotiated protocol: it is refused exactly like any other unexpected frame
      // and never reaches an authority.
      this.#violation();
      return;
    }
    if (this.#fenced) {
      this.#refuse();
      return;
    }
    if (this.#state === "awaiting_hello") {
      this.#violation();
      return;
    }
    if (!this.#authorized()) {
      // No callback and no write: an unauthorized request establishes nothing, and
      // the requester learns `unknown` from its own finite deadline rather than a
      // fabricated refusal or stop.
      this.#diagnostic("close_refused");
      return;
    }
    if (this.#inflightCloses.has(frame.requestId) || this.#closeRows.has(frame.rowId)) {
      // Already being handled: answer the fixed fact, never a second ladder and
      // never an execution queue behind the live one.
      this.#writeCloseResult(frame.requestId, { kind: "busy" });
      return;
    }
    if (this.#inflightCloses.size >= this.#bounds.maxSnapshotRows) {
      // Bounded by the existing roster row bound. Overflow is refused rather than
      // queued, evicted, or retargeted, and nothing was stopped or signalled.
      this.#writeCloseResult(frame.requestId, { kind: "refused" });
      return;
    }
    const request: OwnerCloseRequest = Object.freeze({
      hostRunId: frame.hostRunId,
      rowId: frame.rowId,
      confirmed: frame.confirmed,
    });
    this.#inflightCloses.add(frame.requestId);
    this.#closeRows.add(frame.rowId);
    this.#diagnostic("close_accepted");
    // A rejected or throwing provider, and a value that is not one of the fixed
    // fact sets, are all honestly `unknown`: nothing here can invent an exit, a
    // removal, or a retention, and nothing is retried.
    void Promise.resolve()
      .then(() => handler(request))
      .then(
        (facts) => this.#completeClose(frame.requestId, frame.rowId, isOwnerCloseFacts(facts) ? facts : { kind: "unknown" }),
        () => this.#completeClose(frame.requestId, frame.rowId, { kind: "unknown" }),
      );
  }

  /**
   * Answer one completed close. Authorization is re-proved immediately before the
   * reply is written, so a Revoke, a closed channel, or a fenced binding that
   * happened while Main was working drops the reply truthfully. The operation
   * itself is never cancelled, rolled back, or reported as an exit: Main's own
   * row-stop lifecycle owns it, and this binding only ever owns network delivery.
   */
  #completeClose(requestId: string, rowId: string, facts: OwnerCloseFacts): void {
    // A request abandoned by teardown is no longer this binding's to answer.
    if (!this.#inflightCloses.delete(requestId)) return;
    this.#closeRows.delete(rowId);
    if (this.#state === "finished" || this.#fenced) {
      this.#diagnostic("close_reply_dropped");
      return;
    }
    if (!this.#authorized()) {
      this.#diagnostic("close_refused");
      return;
    }
    this.#writeCloseResult(requestId, facts);
  }

  /**
   * Write one fixed result. A result that cannot be written is simply dropped: it
   * never fences the metadata channel, never closes the transport, and never
   * claims the operation did not happen. A resolved write means the bytes were
   * admitted, never that any row stopped.
   */
  #writeCloseResult(requestId: string, facts: OwnerCloseFacts): void {
    this.#writeResult({ type: "close_result", requestId, outcome: facts }, "close_reply_dropped");
  }

  // ------------------------------------------------------------------- create

  /**
   * Answer one rowless create request with the owner's ONE provider, or not at all.
   *
   * Admission is decided here and now: the capability must have been negotiated
   * for this channel (which already required a real provider), the channel must
   * not be fenced or pre-hello, and the EXACT proved peer key must still carry this
   * owner's current directional receiving grant. The per-channel monotonic
   * sequence is then compared against the high-water and consumed, so a duplicated
   * or older request — whether still in flight or already completed — is answered
   * `refused` without ever reaching the provider, and a second create while one is
   * live is refused rather than queued.
   *
   * The provider is invoked from a detached continuation on purpose: a manager
   * create must never block the ordered metadata receive path, so other requests,
   * acknowledgements, and snapshots keep flowing while Main owns the operation.
   * Authorization is re-proved immediately before that invocation — not merely
   * before the queued continuation — and the provider is handed the same minimal
   * re-proof so it can check once more immediately before it starts anything.
   *
   * The sequence high-water decides ADMISSION only. It is never a newest-dispatch
   * fence for work already accepted, so a later request cannot cancel this child or
   * drop this request's result.
   */
  #onCreateRequest(frame: RosterBridgeCreateRequestFrame): void {
    if (this.#state === "finished") return;
    const handler = this.#options.createOwnedSession;
    if (handler === undefined || !this.#capabilities.includes(ROSTER_BRIDGE_CREATE_CAPABILITY)) {
      // Nothing was acknowledged for this channel, so a create frame is outside the
      // negotiated protocol: it is refused exactly like any other unexpected frame
      // and never reaches an authority.
      this.#violation();
      return;
    }
    if (this.#fenced) {
      this.#refuse();
      return;
    }
    if (this.#state === "awaiting_hello") {
      this.#violation();
      return;
    }
    if (!this.#createStillAuthorized()) {
      // No callback and no write: an unauthorized request establishes nothing, and
      // the requester learns `unknown` from its own finite deadline rather than a
      // fabricated refusal or a created child. The same check re-proves this
      // binding's lifecycle after the authorizer callout, so an authorizer that
      // retires it while returning `true` cannot reach any result write either.
      this.#diagnostic("create_refused");
      return;
    }
    if (frame.sequence <= this.#createSequence) {
      // A previous or duplicated attempt number. Refused before any provider call,
      // and the high-water is unchanged, so nothing can be replayed.
      this.#writeCreateResult(frame.requestId, { kind: "refused" });
      return;
    }
    // The attempt number is consumed now, whichever answer follows: it is a scalar
    // high-water, not a history, and a fresh higher number is a fresh attempt.
    this.#createSequence = frame.sequence;
    if (this.#inflightCreate !== null) {
      // One create per channel. A second is refused, never queued, evicted, or
      // retargeted, and nothing was started for it.
      this.#writeCreateResult(frame.requestId, { kind: "refused" });
      return;
    }
    const request: OwnerCreateRequest = Object.freeze({
      hostRunId: frame.hostRunId,
      workspace: frame.workspace,
    });
    const inflight = { requestId: frame.requestId, hostRunId: frame.hostRunId };
    this.#inflightCreate = inflight;
    this.#diagnostic("create_accepted");
    // The minimal re-proof handed to the provider: the current proved key, the
    // current receiving grant, and this live binding, checked again by the owner
    // immediately before it starts anything. It is a check, never a lease.
    //
    // The injected authorizer is arbitrary code and may itself retire this binding
    // (a Revoke that also drops the channel, a teardown, a replacement) while still
    // returning `true`. The lifecycle is therefore re-proved AFTER that callout as
    // well as before it, so a create never starts for a binding that retired during
    // its own final authorization.
    const stillAuthorized = (): boolean => this.#createStillAuthorized();
    void Promise.resolve()
      .then(() => {
        // Re-proved inside the detached continuation, immediately before the call:
        // a Revoke, a replacement, or a teardown that landed while this was queued
        // means the provider is never reached and nothing is claimed either way.
        if (!stillAuthorized()) {
          this.#completeCreate(inflight, { kind: "unknown" }, false);
          return;
        }
        // The provider is invoked directly in THIS continuation, immediately after
        // its authorization check, so no extra microtask can slip a revoke or a
        // binding retirement between the check and the call. A synchronous throw
        // from the provider still reaches the outer `.catch` below, which settles
        // the request honestly and releases the one-in-flight bookkeeping.
        return handler(request, stillAuthorized).then(
          (facts) => this.#completeCreate(inflight, isOwnerCreateFacts(facts) ? facts : { kind: "unknown" }, true),
          () => this.#completeCreate(inflight, { kind: "unknown" }, true),
        );
      })
      .catch(() => {
        // Nothing above may leave an accepted request stranded: an unexpected fault
        // still completes it honestly and releases the one-in-flight bookkeeping.
        this.#completeCreate(inflight, { kind: "unknown" }, false);
      });
  }

  /**
   * A fresh runtime read of this binding's lifecycle. It is a separate method so a
   * recheck after the injected authorizer still reads the CURRENT state: TypeScript
   * would otherwise keep the earlier narrowing and treat the comparison as
   * impossible.
   */
  #createBindingIsLive(): boolean {
    return this.#state !== "finished" && !this.#fenced;
  }

  /**
   * The create-side re-proof: this binding is live and unfenced BOTH before and
   * after the injected authorizer runs. The second check is what makes a Revoke,
   * teardown, or replacement that happens inside that callout fail closed.
   */
  #createStillAuthorized(): boolean {
    if (!this.#createBindingIsLive()) return false;
    if (!this.#authorized()) return false;
    return this.#createBindingIsLive();
  }

  /**
   * Answer one completed create. Authorization is re-proved immediately before the
   * reply is written, so a Revoke, a closed channel, or a fenced binding that
   * happened while Main was working drops the reply truthfully. The operation
   * itself is never cancelled, rolled back, retried, or reported as a stop: Main's
   * own launch lifecycle owns it, and this binding only ever owns network delivery.
   *
   * A `started` fact that does not name the EXACT owner run the request named is
   * never forwarded: this channel may not report another run's child.
   */
  #completeCreate(
    inflight: { readonly requestId: string; readonly hostRunId: string },
    facts: OwnerCreateFacts,
    providerReturned: boolean,
  ): void {
    // A request abandoned by teardown is no longer this binding's to answer.
    if (this.#inflightCreate !== inflight) return;
    this.#inflightCreate = null;
    if (this.#state === "finished" || this.#fenced) {
      this.#diagnostic("create_reply_dropped");
      return;
    }
    if (!this.#createStillAuthorized()) {
      // A binding that retired inside the authorizer's own callout can no longer
      // write a result at all; one that is merely unauthorized reports the refusal.
      this.#diagnostic(!this.#createBindingIsLive() ? "create_reply_dropped" : "create_refused");
      return;
    }
    if (facts.kind === "started" && facts.hostRunId !== inflight.hostRunId) {
      // The answer belongs to another run, so this request's outcome is
      // unobservable rather than a claimed child of the run it named.
      this.#writeCreateResult(inflight.requestId, { kind: "unknown" });
      return;
    }
    if (!providerReturned && facts.kind !== "unknown") {
      // A re-proof that failed before the provider was reached establishes nothing
      // about this owner's state.
      this.#writeCreateResult(inflight.requestId, { kind: "unknown" });
      return;
    }
    this.#writeCreateResult(inflight.requestId, facts);
  }

  /** Write one fixed create result, or drop it without touching the channel. */
  #writeCreateResult(requestId: string, facts: OwnerCreateFacts): void {
    this.#writeResult({ type: "create_result", requestId, outcome: facts }, "create_reply_dropped");
  }

  /**
   * Write one fixed result frame. A result that cannot be written is simply
   * dropped: it never fences the metadata channel, never closes the transport, and
   * never claims the operation did not happen. A resolved write means the bytes
   * were admitted, never that the peer acted on them.
   */
  #writeResult(frame: RosterBridgeFrame, droppedDiagnostic: RosterBridgeOwnerDiagnosticCode): void {
    let bytes: Buffer;
    try {
      bytes = encodeRosterBridgeFrame(frame, this.#bounds);
    } catch {
      this.#diagnostic(droppedDiagnostic);
      return;
    }
    let written: Promise<void>;
    try {
      written = this.#channel.send(bytes);
    } catch {
      this.#diagnostic(droppedDiagnostic);
      return;
    }
    void written.catch(() => {
      this.#diagnostic(droppedDiagnostic);
    });
  }

  #onInventory(snapshot: OwningHostInventorySnapshot | undefined): void {
    if (this.#installing) {
      // Nothing is published or sent yet: retain the newest observation (or the
      // unavailability) for the subscription that is about to be installed.
      if (snapshot === undefined) this.#installUnavailable = true;
      else if (this.#pending === null || snapshot.revision > this.#pending.revision) this.#pending = snapshot;
      return;
    }
    if (this.#state !== "subscribed") return;
    if (snapshot === undefined) {
      this.#terminateSubscription("unavailable", "source_unavailable");
      return;
    }
    if (this.#subscriptionRun !== null && snapshot.hostRunId !== this.#subscriptionRun) {
      // Rows from two manager runs can never be blended into one roster.
      this.#terminateSubscription("run_changed", "run_changed");
      return;
    }
    if (snapshot.hostRunId === this.#publishedRun && snapshot.revision <= this.#publishedRevision) return;
    if (this.#pending !== null && snapshot.revision <= this.#pending.revision) return;
    const replaced = this.#pending !== null;
    this.#pending = snapshot;
    if (replaced) this.#diagnostic("snapshot_pending_replaced");
    // With no transfer in flight this newer snapshot starts immediately; with one
    // in flight it waits as the single newest-wins pending snapshot.
    void this.#drain();
  }

  /**
   * Move work forward: start the newest retained snapshot when nothing is in
   * flight, then continue the in-flight transfer one guarded frame at a time.
   * A transfer that could not be built has already reported its terminal
   * failure, so this simply has nothing to send.
   */
  #drain(): void {
    if (this.#sending) return;
    if (this.#state !== "subscribed" || this.#fenced) return;
    if (this.#transfer === null) {
      const pending = this.#pending;
      if (pending === null) return;
      this.#pending = null;
      this.#beginTransfer(pending);
    }
    void this.#pump();
  }

  #beginTransfer(snapshot: OwningHostInventorySnapshot): void {
    if (this.#state !== "subscribed" || this.#transfer !== null) return;
    const subscriptionId = this.#subscriptionId;
    if (subscriptionId === null) return;
    let rows: RemoteSessionMetadata[];
    try {
      // The DTO allowlist is the only way onto the wire: no spread of the owner
      // view, so no agent directory, current file, or other private field.
      rows = snapshot.rows.map((row) => toRemoteSessionMetadata(row));
    } catch (error) {
      this.#terminateSubscription(isRemoteSessionMetadataError(error) ? "row_unrepresentable" : "bad_frame", "snapshot_failed");
      return;
    }
    try {
      const built = buildRosterBridgeTransfer({
        subscriptionId,
        transferId: randomUUID(),
        hostRunId: snapshot.hostRunId,
        revision: snapshot.revision,
        rows,
        bounds: this.#bounds,
      });
      this.#transfer = {
        frames: built.frames,
        transferId: built.transferId,
        hostRunId: built.hostRunId,
        revision: built.revision,
        totalRows: built.totalRows,
        pageCount: built.pageCount,
        index: 0,
      };
    } catch (error) {
      const code = isRosterBridgeProtocolError(error)
        ? rosterBridgeWireCodeForFailure(error.code)
        : "bad_frame";
      this.#terminateSubscription(code, "snapshot_failed");
    }
  }

  /** Send the next frame of the one in-flight transfer, guarded immediately before it. */
  #pump(): void {
    if (this.#sending) return;
    if (this.#state !== "subscribed" || this.#fenced) return;
    const transfer = this.#transfer;
    if (transfer === null) return;
    if (transfer.index >= transfer.frames.length) {
      this.#transfer = null;
      this.#publishedRun = transfer.hostRunId;
      this.#publishedRevision = transfer.revision;
      this.#diagnostic("snapshot_published", { rows: transfer.totalRows, pages: transfer.pageCount });
      const pending = this.#pending;
      this.#pending = null;
      if (pending !== null) this.#beginTransfer(pending);
      if (this.#transfer !== null) void this.#pump();
      return;
    }
    // Authorization is re-checked before every protected write, including a
    // page or end frame queued before a revocation.
    if (!this.#authorized()) {
      this.#diagnostic("authorization_refused");
      this.#terminateSubscription("not_authorized", "authorization_refused");
      return;
    }
    this.#sending = true;
    let written: Promise<void>;
    try {
      written = this.#channel.send(transfer.frames[transfer.index]);
    } catch {
      written = Promise.reject(new Error("send rejected"));
    }
    void written.then(() => {
      this.#sending = false;
      // A stop, unsubscribe, or replacement during the write cancels the rest
      // of this transfer; a write already admitted to the socket cannot be
      // recalled and is not claimed as delivered.
      if (this.#state !== "subscribed" || this.#transfer !== transfer) {
        // The flag that kept a replacement's first frame queued is only now free,
        // so the surviving work has to be picked up here rather than waiting for a
        // timeout on the other side.
        this.#drain();
        return;
      }
      transfer.index += 1;
      void this.#pump();
    }, () => {
      this.#sending = false;
      if (this.#transfer !== transfer) {
        // Same reason for the rejection path: this write belongs to a cancelled
        // transfer, but its completion is what unblocks whatever replaced it.
        this.#drain();
        return;
      }
      this.#transfer = null;
      this.#pending = null;
      this.#diagnostic("send_failed");
      this.#terminateSubscription("send_failed", "send_failed", { closeChannel: true });
    });
  }

  /** End the subscription, cancel queued transfers, and retire the source watch once. */
  #retireSubscription(): void {
    this.#transfer = null;
    this.#pending = null;
    this.#subscriptionRun = null;
    const watch = this.#watch;
    // Clearing the reference is what makes this once-only per watch: a later
    // explicit subscription installs a new watch with its own retirement.
    this.#watch = null;
    this.#subscriptionId = null;
    if (watch !== null) {
      try {
        watch.unsubscribe();
      } catch {
        // Retirement is best effort and never load-bearing for a session.
      }
    }
  }

  #terminateSubscription(
    code: RosterBridgeErrorCode,
    diagnostic: RosterBridgeOwnerDiagnosticCode,
    options: { readonly closeChannel?: boolean } = {},
  ): void {
    if (this.#state === "finished") return;
    const subscriptionId = this.#subscriptionId;
    this.#retireSubscription();
    this.#diagnostic(diagnostic);
    if (code === "not_authorized") this.#fenced = true;
    if (this.#state === "subscribed") this.#state = "ready";
    if (subscriptionId !== null) {
      this.#sendControl({ type: "error", code, subscriptionId });
    } else {
      this.#sendControl({ type: "error", code });
    }
    // A failed write is not proof the peer saw the abort, so a transport-level
    // failure also closes the protocol channel through its bounded API.
    if (options.closeChannel === true) void this.#closeChannel();
  }

  #violation(): void {
    if (this.#state === "finished") return;
    this.#diagnostic("protocol_violation");
    this.#sendControl({ type: "error", code: "bad_frame" });
    this.#fence("bad_frame", { closeChannel: true });
  }

  /** Answer a request on a fenced channel with the same fixed refusal, and nothing else. */
  #refuse(): void {
    if (this.#state === "finished") return;
    this.#sendControl({ type: "error", code: this.#fenceCode });
  }

  /** Stop answering this channel. Metadata only: sessions and the transport stay as they are. */
  #fence(code: RosterBridgeErrorCode, options: { readonly closeChannel?: boolean } = {}): void {
    this.#fenced = true;
    this.#fenceCode = code;
    this.#retireSubscription();
    void this.#finish("fenced", options);
  }

  #finish(reason: string, options: { readonly closeChannel?: boolean } = {}): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#stopPromise = (async () => {
      this.#clearHelloTimer();
      const subscriptionId = this.#subscriptionId;
      this.#retireSubscription();
      // Close bookkeeping is network-delivery bookkeeping only. Clearing it does
      // not cancel, roll back, or await the owner's operation: an accepted close
      // keeps running under Main's existing row-stop lifecycle, and its result is
      // dropped rather than claimed after this binding is gone.
      this.#inflightCloses.clear();
      this.#closeRows.clear();
      // Create bookkeeping is network-delivery bookkeeping only, for the same
      // reason: an accepted create keeps running under Main's launch lifecycle, and
      // its result is dropped rather than claimed after this binding is gone.
      this.#inflightCreate = null;
      if (this.#state !== "finished") {
        // An owner-initiated stop tells the viewer its observations are no
        // longer current; it never fabricates an empty roster.
        if (subscriptionId !== null && reason === "stopped") {
          this.#sendControl({ type: "error", code: "unavailable", subscriptionId });
        }
        this.#state = "finished";
        if (reason === "stopped") this.#diagnostic("binding_stopped");
      }
      const detach = this.#detach;
      this.#detach = null;
      if (detach !== null) {
        try {
          detach();
        } catch {
          // Detaching is best effort.
        }
      }
      this.#resolveClosed();
      if (options.closeChannel === true) await this.#closeChannel();
    })();
    return this.#stopPromise;
  }

  async #closeChannel(): Promise<void> {
    if (this.#closeRequested) return;
    // Closing is requested by several teardown paths (a failed data write, a failed
    // control write, an explicit stop) and is performed exactly once through the
    // channel's own bounded API.
    this.#closeRequested = true;
    try {
      await this.#channel.close();
    } catch {
      // The channel is already gone; the transport owns its own diagnostics.
    }
  }

  #authorized(): boolean {
    if (this.#fenced) return false;
    try {
      return this.#options.authorizePeer(this.#channel.peerKey) === true;
    } catch {
      // An unavailable authorization decision is no decision at all.
      return false;
    }
  }

  #sendControl(frame: RosterBridgeFrame): void {
    // Control frames carry no roster content. A failure to write one is recorded
    // and owned; it is never reported as a peer-visible notification.
    const writeFailed = (): void => {
      this.#diagnostic("send_failed");
      // A frame the peer never received is not a notification. If this binding has
      // already retired the subscription, silence would leave the viewer presenting
      // a retired snapshot as current with no transfer timer left to notice, so the
      // session ends here and the channel is closed through its bounded API: the
      // viewer then observes transport loss rather than indefinite false freshness.
      this.#fenced = true;
      this.#retireSubscription();
      void this.#finish("send_failed", { closeChannel: true });
      void this.#closeChannel();
    };
    let bytes: Buffer;
    try {
      bytes = encodeRosterBridgeFrame(frame, this.#bounds);
    } catch {
      writeFailed();
      return;
    }
    let written: Promise<void>;
    try {
      written = this.#channel.send(bytes);
    } catch {
      writeFailed();
      return;
    }
    void written.catch(writeFailed);
  }

  #clearHelloTimer(): void {
    if (this.#helloTimer === null) return;
    clearTimeout(this.#helloTimer);
    this.#helloTimer = null;
  }
}

/**
 * Create the owner side of the metadata bridge. Nothing happens until
 * {@link RosterBridgeHost.attach} is called with an admitted channel, and
 * nothing on that channel is readable until the viewer says hello, passes the
 * injected authorization, and subscribes.
 */
export function createRosterBridgeHost(options: RosterBridgeHostOptions): RosterBridgeHost {
  if (options === null || typeof options !== "object") throw new TypeError("roster metadata host requires options");
  if (typeof options.inventory?.watchInventory !== "function") {
    throw new TypeError("roster metadata host requires an inventory watch source");
  }
  if (typeof options.authorizePeer !== "function") {
    // No implicit policy: without an explicit authorizer no metadata is written.
    throw new TypeError("roster metadata host requires an explicit peer authorizer");
  }
  const bounds = resolveRosterBridgeBounds(options.bounds);
  const bindings = new Set<OwnerBinding>();
  let diagnosticsEnabled = true;
  const diagnostic = (code: RosterBridgeOwnerDiagnosticCode, extra?: { rows?: number; pages?: number }): void => {
    if (!diagnosticsEnabled || options.onDiagnostic === undefined) return;
    try {
      options.onDiagnostic({
        code,
        role: "owner",
        ...(extra?.rows === undefined ? {} : { rows: extra.rows }),
        ...(extra?.pages === undefined ? {} : { pages: extra.pages }),
      });
    } catch {
      diagnosticsEnabled = false;
    }
  };

  const host: RosterBridgeHost = {
    attach(channel: PeerByteChannel): RosterBridgeChannelBinding {
      if (channel === null || typeof channel !== "object" || typeof channel.onMessage !== "function") {
        throw new TypeError("roster metadata host requires a peer byte channel");
      }
      const binding = new OwnerBinding(channel, options, bounds, diagnostic, () => {
        bindings.delete(binding);
      });
      bindings.add(binding);
      void binding.closed.then(() => {
        bindings.delete(binding);
      });
      return binding;
    },
    get activeBindingCount() {
      return bindings.size;
    },
    get activeSubscriptionCount() {
      let count = 0;
      for (const binding of bindings) if (binding.subscribed) count += 1;
      return count;
    },
    async stopAll(): Promise<void> {
      const current = [...bindings];
      bindings.clear();
      await Promise.allSettled(current.map((binding) => binding.stop()));
    },
  };
  return host;
}
