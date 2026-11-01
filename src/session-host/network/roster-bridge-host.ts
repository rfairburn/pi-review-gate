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
 * Rows may additionally carry the owner's already-durable roster slot as
 * optional presentation metadata (#477). This bridge neither stores nor derives
 * that slot: it comes from the source snapshot's own rows, which the owning-host
 * service reads live from the host's roster authority, and it is projected only
 * on a channel that acknowledged the roster-slot capability. Nothing about it
 * changes row identity, selection, subscription, or action routing.
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
 *
 * The optional Saved catalog exchange is a THIRD injected owner capability: a
 * view factory plus a live delete-exposure policy callback, supplied together or
 * not at all. This binding creates at most ONE ephemeral view, lazily, after the
 * first authorized Saved request, and disposes it when the binding finishes; it
 * keeps no catalog registry, history, or queue of its own. Every Saved request is
 * admitted only on the exact proved peer key with the current receiving grant,
 * for the EXACT owner run of this binding's live subscription (an empty roster is
 * fine; no row, selection, focus, or native tuple is needed), and with a fresh
 * value of the channel's shared monotonic Saved sequence. One Saved operation is
 * pending per channel: a newer read may supersede an older read, while a resume
 * or delete is never superseded, cancelled, or replayed. EVERY Saved write —
 * window frames, the accepted operation's fixed result, refusals, and policy
 * publications — takes the roster's single send slot, and the Saved family
 * alternates fairly with roster frames. While the slot is held, Saved control
 * work is bounded: one accepted result, one waiting refusal (further refusals are
 * dropped), and one coalesced policy publication read live at dispatch. Delete is
 * admitted only while the live policy says it is exposed. The provider's guard
 * repeats independent authorization, not that preference decision; completed
 * deletion is reported truthfully under the still-current transport and run
 * authorization.
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
import {
  isOwnerSavedCatalogView,
  isOwnerSavedDeleteFacts,
  isOwnerSavedResumeFacts,
  isOwnerSavedWindowFacts,
  type OwnerRemoteHistoryDeletePolicy,
  type OwnerSavedAuthorizationGuard,
  type OwnerSavedCatalogView,
  type OwnerSavedCatalogViewFactory,
  type OwnerSavedDeleteFacts,
  type OwnerSavedEntry,
  type OwnerSavedResumeFacts,
  type OwnerSavedWindowFacts,
  type OwnerSavedWindowOutcome,
} from "./peer-saved";
import { isRemoteSessionMetadataError, toRemoteSessionMetadata, type RemoteSessionMetadata } from "./roster-metadata";
import {
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY,
  ROSTER_BRIDGE_SAVED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  buildRosterBridgeSavedWindowTransfer,
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
  type RosterBridgeSavedRequestFrame,
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
  | "create_reply_dropped"
  | "saved_accepted"
  | "saved_refused"
  | "saved_reply_dropped"
  | "saved_window_sent"
  | "saved_policy_sent";

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
  /**
   * The owner's Saved catalog view factory, supplied by Main together with
   * {@link RosterBridgeHostOptions.remoteHistoryDeleteExposed}. Supplying exactly
   * one of the two is refused at construction; supplying neither keeps this host
   * byte-for-byte a metadata/close/create host that never acknowledges Saved.
   * The factory is called at most once per channel binding, lazily, after an
   * authorized Saved request.
   */
  readonly savedCatalogView?: OwnerSavedCatalogViewFactory;
  /**
   * The owner/server's LIVE remote-history delete exposure. It is read once at
   * admission of each delete/prepare, and for policy publication; `false`, a throw,
   * or any non-`true` value means no delete exposure or acceptance. There is no
   * permissive default here.
   */
  readonly remoteHistoryDeleteExposed?: OwnerRemoteHistoryDeletePolicy;
  readonly bounds?: Partial<RosterBridgeBounds>;
  readonly onDiagnostic?: RosterBridgeOwnerDiagnosticSink;
}

/** The validated Saved provider pair, captured once at host construction. */
interface SavedProviders {
  readonly createView: OwnerSavedCatalogViewFactory;
  readonly deleteExposed: OwnerRemoteHistoryDeletePolicy;
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
  /**
   * Re-read the live delete policy and publish it to every existing binding that
   * negotiated Saved and has a current owner run. Description only: each new
   * delete/prepare is independently gated at owner admission. Optional so hosts
   * and test doubles without Saved remain representable.
   */
  notifySavedPolicy?(): void;
}

/** What the one pending Saved operation on a channel is. */
type SavedOpKind = "read" | "resume" | "delete";

interface SavedOp {
  readonly kind: SavedOpKind;
  readonly frame: RosterBridgeSavedRequestFrame;
  /** Fires only when a newer read supersedes this read or the binding goes away. */
  readonly controller: AbortController | null;
}

/** One in-flight Saved window transfer sharing the roster's single send slot. */
interface SavedTransfer {
  readonly op: SavedOp;
  readonly hostRunId: string;
  readonly frames: readonly Buffer[];
  readonly rows: number;
  readonly pageCount: number;
  index: number;
}

function isSavedRead(frame: RosterBridgeSavedRequestFrame): boolean {
  return frame.type === "saved_list_request"
    || frame.type === "saved_search_request"
    || frame.type === "saved_window_request";
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
  /** The validated Saved provider pair, or null when this host has none. */
  readonly #saved: SavedProviders | null;
  /**
   * The channel's shared Saved anti-replay high-water. An ADMISSION fence only:
   * advancing it never cancels or drops an operation already accepted.
   */
  #savedSequence = 0;
  /** The ONE pending Saved operation on this channel, if any. Never a queue. */
  #savedOp: SavedOp | null = null;
  /** The one in-flight Saved window transfer, if any. */
  #savedTransfer: SavedTransfer | null = null;
  /** Fair interleaving: true when the Saved transfer has the next send-slot turn. */
  #savedTurn = false;
  /** This binding's ONE lazily created catalog view, disposed when it finishes. */
  #savedView: OwnerSavedCatalogView | null = null;
  #savedViewDisposed = false;
  /**
   * The bounded Saved control outbox. Every Saved write takes the roster's ONE
   * send slot, so nothing here is written while another frame is outstanding:
   * - `#savedResult`: the accepted operation's own fixed result (at most one,
   *   because the operation keeps the channel's one Saved slot until its result
   *   is handed to the transport);
   * - `#savedRefusal`: at most one pre-invocation refusal; further refusals while
   *   it waits are dropped (the requester learns `unknown` from its own deadline);
   * - `#savedPolicyDirty`: a coalesced policy publication, read fresh at dispatch.
   */
  #savedResult: {
    readonly op: SavedOp;
    readonly hostRunId: string;
    readonly requireRun: boolean;
    readonly bytes: Buffer;
  } | null = null;
  #savedRefusal: Buffer | null = null;
  #savedPolicyDirty = false;
  /** Bumped by each policy dispatch so a stale reentrant read never wins. */
  #policyGeneration = 0;
  /** The last policy description handed to the transport for the current run. */
  #policySent: { readonly hostRunId: string; readonly deleteExposed: boolean } | null = null;
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
    saved: SavedProviders | null,
  ) {
    this.#channel = channel;
    this.#options = options;
    this.#saved = saved;
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
      case "saved_list_request":
      case "saved_search_request":
      case "saved_window_request":
      case "saved_resume_request":
      case "saved_delete_request":
        this.#onSavedRequest(frame);
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
      if (capability === ROSTER_BRIDGE_SAVED_CAPABILITY) {
        // Implementation support only: a real view factory AND a live policy
        // callback. Delete exposure itself is decided per request, live.
        return this.#saved !== null;
      }
      if (capability === ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY) {
        // Presentation metadata only. This owner honours it by projecting the
        // slot its own roster authority already holds for a row, and by
        // honestly omitting the field for a row with no slot. It is never
        // authority, never a second identity, and never a routing target.
        return true;
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

  // -------------------------------------------------------------------- saved

  /**
   * Re-read the live delete policy and publish it for this binding's current run.
   * Called by the owning host's `notifySavedPolicy()`; it is description only.
   * The publication is coalesced and dispatched through the shared send slot,
   * reading the live policy at the moment it is actually written.
   */
  notifySavedPolicy(): void {
    if (!this.#savedNegotiated()) return;
    this.#savedPolicyDirty = true;
    this.#drain();
  }

  #savedNegotiated(): boolean {
    return this.#saved !== null && this.#capabilities.includes(ROSTER_BRIDGE_SAVED_CAPABILITY);
  }

  /**
   * The exact owner run of this binding's LIVE subscription, read fresh. That run
   * comes from the owner's own inventory watch, so an empty roster qualifies and
   * no row, selection, focus, or native tuple is ever consulted.
   */
  #savedRunCurrent(hostRunId: string): boolean {
    return this.#state === "subscribed" && !this.#fenced && this.#subscriptionRun === hostRunId;
  }

  /** Binding live and authorized, re-proved after the injected authorizer callout. */
  #savedBindingAuthorized(): boolean {
    if (!this.#createBindingIsLive()) return false;
    if (!this.#authorized()) return false;
    return this.#createBindingIsLive();
  }

  /** Transport, binding, and exact current-run re-proof, repeated after the callout. */
  #savedStillAuthorized(hostRunId: string): boolean {
    if (!this.#savedRunCurrent(hostRunId)) return false;
    if (!this.#savedBindingAuthorized()) return false;
    return this.#savedRunCurrent(hostRunId);
  }

  /** The LIVE server delete exposure. Absent, non-`true`, or throwing means OFF. */
  #readDeleteExposed(): boolean {
    const saved = this.#saved;
    if (saved === null) return false;
    try {
      return saved.deleteExposed() === true;
    } catch {
      return false;
    }
  }

  /**
   * Admit one Saved request, answer it with a fixed refusal, or say nothing.
   *
   * Admission mirrors create: negotiated capability, unfenced post-hello channel,
   * and the EXACT proved key with the current receiving grant (an unauthorized
   * request gets no write at all). The shared sequence is then compared and
   * consumed, so a replay is refused before any provider work. One Saved
   * operation is pending per channel: a newer read supersedes an older read, and
   * anything else that collides is refused `busy` without touching the accepted
   * operation or its eventual result. The request must name the exact run of this
   * binding's live subscription. Each delete/prepare reads the owner's current
   * policy once at admission. Later preference changes do not revoke that
   * request; independent binding, run, and grant proofs remain live after callouts.
   */
  #onSavedRequest(frame: RosterBridgeSavedRequestFrame): void {
    if (this.#state === "finished") return;
    if (!this.#savedNegotiated()) {
      // Never acknowledged for this channel: outside the negotiated protocol.
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
    if (!this.#savedBindingAuthorized()) {
      this.#diagnostic("saved_refused");
      return;
    }
    if (frame.sequence <= this.#savedSequence) {
      // A previous or duplicated attempt number: refused before any provider call,
      // and the high-water is unchanged.
      this.#writeSavedRefusal(frame, "duplicate");
      return;
    }
    // Consumed now, whichever answer follows. Admission only: it never cancels or
    // drops an operation this binding already accepted.
    this.#savedSequence = frame.sequence;
    const read = isSavedRead(frame);
    const hostRunId = frame.hostRunId;
    if (this.#savedOp !== null && !(read && this.#savedOp.kind === "read")) {
      this.#writeSavedRefusal(frame, "busy");
      return;
    }
    if (!this.#savedRunCurrent(hostRunId)) {
      this.#writeSavedRefusal(frame, "stale");
      return;
    }
    if (frame.type === "saved_delete_request") {
      const exposed = this.#readDeleteExposed();
      // The policy and authorizer callbacks are arbitrary owner code: re-prove the
      // binding after them before any write, and report the run honestly.
      if (!this.#savedBindingAuthorized()) {
        this.#diagnostic("saved_refused");
        return;
      }
      if (!this.#savedRunCurrent(hostRunId)) {
        this.#writeSavedRefusal(frame, "stale");
        return;
      }
      if (!exposed) {
        // A capability, a stale viewer description, or a confirmation never
        // overrides the live server policy.
        this.#writeSavedRefusal(frame, "policy");
        return;
      }
    }
    const view = this.#ensureSavedView();
    // The factory is arbitrary owner code too.
    if (!this.#savedBindingAuthorized()) {
      this.#diagnostic("saved_refused");
      return;
    }
    if (view === null) {
      this.#writeSavedRefusal(frame, "admission");
      return;
    }
    if (this.#savedOp !== null) {
      if (!read || this.#savedOp.kind !== "read") {
        this.#writeSavedRefusal(frame, "busy");
        return;
      }
      // A newer read supersedes the older READ only: its signal fires and its
      // transfer is discarded. Abort listeners are owner code, so re-prove after.
      this.#abortSavedRead();
      if (!this.#savedBindingAuthorized()) {
        this.#diagnostic("saved_refused");
        return;
      }
      if (this.#savedOp !== null) {
        this.#writeSavedRefusal(frame, "busy");
        return;
      }
    }
    if (!this.#savedRunCurrent(hostRunId)) {
      this.#writeSavedRefusal(frame, "stale");
      return;
    }
    const kind: SavedOpKind = read ? "read" : frame.type === "saved_resume_request" ? "resume" : "delete";
    const op: SavedOp = Object.freeze({ kind, frame, controller: read ? new AbortController() : null });
    this.#savedOp = op;
    this.#diagnostic("saved_accepted");
    // Live independent authorization remains required before provider work and
    // protected effects, including trash/unlink. Delete preference was decided
    // once above, not leased or re-read here. A read must also not be superseded.
    const guard: OwnerSavedAuthorizationGuard = kind === "read"
      ? () => this.#savedOp === op && this.#savedStillAuthorized(hostRunId) && this.#savedOp === op
      : () => this.#savedStillAuthorized(hostRunId);
    void Promise.resolve()
      .then(() => {
        // Re-proved inside the detached continuation, immediately before the call.
        if (this.#savedOp !== op || !guard()) {
          this.#completeSaved(op, { kind: "unknown" }, false);
          return undefined;
        }
        return this.#invokeSaved(view, op, guard).then(
          (facts) => this.#completeSaved(op, facts, true),
          () => this.#completeSaved(op, { kind: "unknown" }, true),
        );
      })
      .catch(() => {
        // A synchronous provider throw or an unexpected fault still settles the
        // operation honestly and frees the channel's one Saved slot.
        this.#completeSaved(op, { kind: "unknown" }, false);
      });
  }

  /** Call exactly the provider operation the frame names, with exactly its fields. */
  #invokeSaved(view: OwnerSavedCatalogView, op: SavedOp, guard: OwnerSavedAuthorizationGuard): Promise<unknown> {
    const frame = op.frame;
    const signal = (op.controller ?? new AbortController()).signal;
    switch (frame.type) {
      case "saved_list_request":
        return Promise.resolve(view.list(Object.freeze({
          hostRunId: frame.hostRunId,
          query: frame.query,
          offset: frame.offset,
          count: frame.count,
        }), signal, guard));
      case "saved_search_request":
        return Promise.resolve(view.search(Object.freeze({
          hostRunId: frame.hostRunId,
          catalogId: frame.catalogId,
          query: frame.query,
          offset: frame.offset,
          count: frame.count,
        }), signal, guard));
      case "saved_window_request":
        return Promise.resolve(view.window(Object.freeze({
          hostRunId: frame.hostRunId,
          catalogId: frame.catalogId,
          resultId: frame.resultId,
          offset: frame.offset,
          count: frame.count,
        }), signal, guard));
      case "saved_resume_request":
        return Promise.resolve(view.resume(Object.freeze({
          hostRunId: frame.hostRunId,
          catalogId: frame.catalogId,
          resultId: frame.resultId,
          entryId: frame.entryId,
        }), guard));
      case "saved_delete_request":
        return Promise.resolve(view.remove(Object.freeze({
          hostRunId: frame.hostRunId,
          catalogId: frame.catalogId,
          resultId: frame.resultId,
          entryId: frame.entryId,
          confirmed: frame.confirmed,
        }), guard));
      default:
        return Promise.resolve({ kind: "unknown" });
    }
  }

  /** Lazily create this binding's ONE view. Null when unavailable or retired. */
  #ensureSavedView(): OwnerSavedCatalogView | null {
    if (this.#savedView !== null) return this.#savedView;
    const saved = this.#saved;
    // A provider callback can retire this binding reentrantly. Read afresh on
    // each call rather than carrying TypeScript's pre-callback state narrowing.
    const isFinished = (): boolean => this.#state === "finished";
    if (saved === null || this.#savedViewDisposed || isFinished()) return null;
    let created: unknown;
    try {
      created = saved.createView();
    } catch {
      return null;
    }
    if (!isOwnerSavedCatalogView(created)) return null;
    if (isFinished() || this.#savedViewDisposed || this.#savedView !== null) {
      // The binding retired (or a view was installed reentrantly) during the
      // factory call: this extra view is released and never used.
      try {
        created.dispose();
      } catch {
        // Disposal is best effort.
      }
      return this.#savedViewDisposed || isFinished() ? null : this.#savedView;
    }
    this.#savedView = created;
    return created;
  }

  /**
   * Supersede or abandon the pending READ, if any, and discard its transfer.
   * Never touches a pending resume or delete.
   */
  #abortSavedRead(): void {
    this.#savedTransfer = null;
    const op = this.#savedOp;
    if (op === null || op.kind !== "read") return;
    this.#savedOp = null;
    // A read's own queued answer is superseded with it; a write's never is.
    if (this.#savedResult !== null && this.#savedResult.op === op) this.#savedResult = null;
    try {
      op.controller?.abort();
    } catch {
      // An abort listener's failure changes nothing here.
    }
  }

  #completeSaved(op: SavedOp, facts: unknown, providerReturned: boolean): void {
    // Superseded, abandoned by teardown, or already answered: not this binding's.
    if (this.#savedOp !== op) return;
    if (op.kind === "read") this.#completeSavedRead(op, facts, providerReturned);
    else this.#completeSavedWrite(op, facts, providerReturned);
  }

  /**
   * Answer one completed read: a validated, coherent window becomes one bounded
   * transfer on the shared send slot; anything else becomes one fixed result.
   */
  #completeSavedRead(op: SavedOp, facts: unknown, providerReturned: boolean): void {
    const frame = op.frame;
    if (this.#state === "finished" || this.#fenced) {
      this.#savedOp = null;
      this.#diagnostic("saved_reply_dropped");
      return;
    }
    if (!this.#savedBindingAuthorized()) {
      if (this.#savedOp === op) this.#savedOp = null;
      this.#diagnostic(this.#createBindingIsLive() ? "saved_refused" : "saved_reply_dropped");
      return;
    }
    // The authorizer is owner code and may have superseded or retired this read.
    if (this.#savedOp !== op) return;
    if (!this.#savedRunCurrent(frame.hostRunId)) {
      this.#queueSavedWindowResult(op, { kind: "refused", reason: "stale" });
      return;
    }
    if (!providerReturned || !isOwnerSavedWindowFacts(facts)) {
      this.#queueSavedWindowResult(op, { kind: "unknown" });
      return;
    }
    if (facts.kind !== "window") {
      this.#queueSavedWindowResult(op, facts);
      return;
    }
    if (!this.#savedWindowCoherent(frame, facts)) {
      // A window for another run, catalog, result, or offset, or one that silently
      // returned fewer rows than it had, is never forwarded.
      this.#queueSavedWindowResult(op, { kind: "unknown" });
      return;
    }
    let built: ReturnType<typeof buildRosterBridgeSavedWindowTransfer>;
    try {
      built = buildRosterBridgeSavedWindowTransfer({
        requestId: frame.requestId,
        hostRunId: frame.hostRunId,
        catalogId: facts.catalogId,
        resultId: facts.resultId,
        total: facts.total,
        issueCount: facts.issueCount,
        offset: facts.offset,
        // Copied field by field: exactly the closed entry shape, nothing more.
        entries: facts.entries.map((entry): OwnerSavedEntry => ({
          entryId: entry.entryId,
          sessionId: entry.sessionId,
          file: entry.file,
          caption: entry.caption,
          cwd: entry.cwd,
        })),
        bounds: this.#bounds,
      });
    } catch (error) {
      this.#queueSavedWindowResult(op,
        isRosterBridgeProtocolError(error) && error.code === "row_unrepresentable"
          ? { kind: "refused", reason: "unrepresentable" }
          : { kind: "unknown" });
      return;
    }
    this.#savedTransfer = {
      op,
      hostRunId: frame.hostRunId,
      frames: built.frames,
      rows: built.rows,
      pageCount: built.pageCount,
      index: 0,
    };
    this.#drain();
  }

  /** The window must describe exactly what this request asked for. */
  #savedWindowCoherent(
    frame: RosterBridgeSavedRequestFrame,
    facts: Extract<OwnerSavedWindowFacts, { readonly kind: "window" }>,
  ): boolean {
    if (frame.type === "saved_resume_request" || frame.type === "saved_delete_request") return false;
    if (facts.hostRunId !== frame.hostRunId) return false;
    // A search keeps its catalog; a window keeps its catalog AND result.
    if (frame.type !== "saved_list_request" && facts.catalogId !== frame.catalogId) return false;
    if (frame.type === "saved_window_request" && facts.resultId !== frame.resultId) return false;
    if (facts.offset !== frame.offset) return false;
    return facts.entries.length === Math.min(frame.count, facts.total - facts.offset);
  }

  /**
   * Answer one completed resume or delete. Delivery (checked when the result is
   * actually written) needs the still-current transport, binding, and run
   * authorization — and NOT the current delete policy: an operation that already
   * completed is reported truthfully, and is never cancelled, rolled back,
   * retried, or re-run here.
   */
  #completeSavedWrite(op: SavedOp, facts: unknown, providerReturned: boolean): void {
    const frame = op.frame;
    if (this.#state === "finished" || this.#fenced) {
      this.#savedOp = null;
      this.#diagnostic("saved_reply_dropped");
      return;
    }
    if (frame.type === "saved_resume_request") {
      let outcome: OwnerSavedResumeFacts = isOwnerSavedResumeFacts(facts) ? facts : { kind: "unknown" };
      // A start in another run is never reported as this request's.
      if (outcome.kind === "started" && outcome.hostRunId !== frame.hostRunId) outcome = { kind: "unknown" };
      if (!providerReturned && outcome.kind !== "unknown") outcome = { kind: "unknown" };
      this.#queueSavedResult(op, { type: "saved_resume_result", requestId: frame.requestId, outcome });
      return;
    }
    if (frame.type === "saved_delete_request") {
      let outcome: OwnerSavedDeleteFacts = isOwnerSavedDeleteFacts(facts) ? facts : { kind: "unknown" };
      if (!providerReturned && outcome.kind !== "unknown") outcome = { kind: "unknown" };
      this.#queueSavedResult(op, { type: "saved_delete_result", requestId: frame.requestId, outcome });
      return;
    }
    this.#savedOp = null;
  }

  #queueSavedWindowResult(op: SavedOp, outcome: OwnerSavedWindowOutcome): void {
    this.#queueSavedResult(op, { type: "saved_window_result", requestId: op.frame.requestId, outcome });
  }

  /** Encode one Saved control frame, or null (with a diagnostic) when it cannot be. */
  #encodeSaved(frame: RosterBridgeFrame): Buffer | null {
    try {
      return encodeRosterBridgeFrame(frame, this.#bounds);
    } catch {
      this.#diagnostic("saved_reply_dropped");
      return null;
    }
  }

  /**
   * Queue the accepted operation's own fixed result for the shared send slot. The
   * operation keeps the channel's one Saved slot until this result is handed to
   * the transport, so at most one such result ever waits and a newer request in
   * the meantime is refused `busy` rather than accumulating writes.
   */
  #queueSavedResult(op: SavedOp, frame: RosterBridgeFrame): void {
    const bytes = this.#encodeSaved(frame);
    if (bytes === null) {
      if (this.#savedOp === op) this.#savedOp = null;
      this.#drain();
      return;
    }
    // Reads are answered under transport/binding authorization; a resume or
    // delete result additionally needs its exact run to still be current.
    this.#savedResult = { op, hostRunId: op.frame.hostRunId, requireRun: op.kind !== "read", bytes };
    this.#drain();
  }

  /**
   * Queue one fixed pre-invocation refusal for exactly this request id. At most
   * one refusal waits for the shared send slot; while it waits, any further
   * refusal is dropped (the requester then learns `unknown` from its own finite
   * deadline), so a flood of rejected requests can never accumulate writes.
   */
  #writeSavedRefusal(
    frame: RosterBridgeSavedRequestFrame,
    reason: "admission" | "duplicate" | "stale" | "busy" | "policy",
  ): void {
    this.#diagnostic("saved_refused");
    if (this.#savedRefusal !== null) {
      this.#diagnostic("saved_reply_dropped");
      return;
    }
    let refusal: RosterBridgeFrame;
    switch (frame.type) {
      case "saved_resume_request":
        refusal = { type: "saved_resume_result", requestId: frame.requestId, outcome: { kind: "refused", reason } };
        break;
      case "saved_delete_request":
        refusal = { type: "saved_delete_result", requestId: frame.requestId, outcome: { kind: "refused", reason } };
        break;
      default:
        // Delete policy never applies to a read.
        refusal = {
          type: "saved_window_result",
          requestId: frame.requestId,
          outcome: { kind: "refused", reason: reason === "policy" ? "admission" : reason },
        };
    }
    const bytes = this.#encodeSaved(refusal);
    if (bytes === null) return;
    this.#savedRefusal = bytes;
    this.#drain();
  }

  #savedControlPending(): boolean {
    return this.#savedResult !== null || this.#savedRefusal !== null || this.#savedPolicyDirty;
  }

  /**
   * Write the next Saved control frame through the shared send slot: the
   * accepted operation's result first, then the one waiting refusal, then a
   * coalesced policy publication. Authorization (and, for a resume/delete
   * result, the exact run) is re-proved at the actual write; because the
   * authorizer is owner code, an item that another reentrant pump claimed in the
   * meantime is left to it.
   */
  #pumpSavedControl(): void {
    const result = this.#savedResult;
    if (result !== null) {
      const deliverable = result.requireRun
        ? this.#savedStillAuthorized(result.hostRunId)
        : this.#savedBindingAuthorized();
      if (this.#sending || this.#savedResult !== result) return;
      this.#savedResult = null;
      // The operation's slot is released as its result is handed to the transport.
      if (this.#savedOp === result.op) this.#savedOp = null;
      if (!deliverable) {
        this.#diagnostic(this.#createBindingIsLive() ? "saved_refused" : "saved_reply_dropped");
        void this.#pump();
        return;
      }
      this.#sendSavedControl(result.bytes, () => this.#diagnostic("saved_reply_dropped"));
      return;
    }
    const refusal = this.#savedRefusal;
    if (refusal !== null) {
      const deliverable = this.#savedBindingAuthorized();
      if (this.#sending || this.#savedRefusal !== refusal) return;
      this.#savedRefusal = null;
      if (!deliverable) {
        this.#diagnostic(this.#createBindingIsLive() ? "saved_refused" : "saved_reply_dropped");
        void this.#pump();
        return;
      }
      this.#sendSavedControl(refusal, () => this.#diagnostic("saved_reply_dropped"));
      return;
    }
    if (this.#savedPolicyDirty) this.#dispatchSavedPolicy();
  }

  /**
   * One Saved control write holding the shared send slot. A failed write drops
   * that one answer — exactly as a Close or Create result write does — and never
   * claims the operation did not happen; the slot is released either way.
   */
  #sendSavedControl(bytes: Buffer, onFailed: () => void): void {
    this.#sending = true;
    this.#savedTurn = false;
    let written: Promise<void>;
    try {
      written = this.#channel.send(bytes);
    } catch {
      written = Promise.reject(new Error("send rejected"));
    }
    void written.then(() => {
      this.#sending = false;
      this.#drain();
    }, () => {
      this.#sending = false;
      onFailed();
      this.#drain();
    });
  }

  /**
   * Send the next frame of the one in-flight Saved window through the roster's
   * single send slot. The transport, binding, and exact run are re-proved
   * immediately before EVERY frame; a lost proof discards the rest of this window
   * silently (no frame is written), and the requester learns `unknown` from its
   * own finite deadline. The channel's one Saved slot is released once the final
   * frame is handed to the transport.
   */
  #pumpSaved(transfer: SavedTransfer): void {
    if (transfer.index >= transfer.frames.length) {
      if (this.#savedTransfer === transfer) this.#savedTransfer = null;
      void this.#pump();
      return;
    }
    if (!this.#savedStillAuthorized(transfer.hostRunId)) {
      if (this.#savedTransfer === transfer) {
        this.#savedTransfer = null;
        if (this.#savedOp === transfer.op) this.#savedOp = null;
      }
      this.#diagnostic("saved_reply_dropped");
      void this.#pump();
      return;
    }
    // The authorizer is owner code: it may have replaced this transfer or claimed
    // the send slot. Whoever holds the slot now resumes the work when it settles.
    if (this.#sending || this.#savedTransfer !== transfer) return;
    const bytes = transfer.frames[transfer.index];
    if (transfer.index === transfer.frames.length - 1 && this.#savedOp === transfer.op) this.#savedOp = null;
    this.#sending = true;
    this.#savedTurn = false;
    let written: Promise<void>;
    try {
      written = this.#channel.send(bytes);
    } catch {
      written = Promise.reject(new Error("send rejected"));
    }
    void written.then(() => {
      this.#sending = false;
      if (this.#savedTransfer !== transfer) {
        // Superseded or retired while writing; this write still frees the slot.
        this.#drain();
        return;
      }
      transfer.index += 1;
      if (transfer.index >= transfer.frames.length) {
        this.#savedTransfer = null;
        this.#diagnostic("saved_window_sent", { rows: transfer.rows, pages: transfer.pageCount });
      }
      this.#drain();
    }, () => {
      this.#sending = false;
      if (this.#savedTransfer !== transfer) {
        this.#drain();
        return;
      }
      this.#savedTransfer = null;
      if (this.#savedOp === transfer.op) this.#savedOp = null;
      this.#diagnostic("send_failed");
      // A failed write breaks ordering for every frame behind it, exactly as for a
      // roster frame: the channel is closed through its bounded API.
      this.#terminateSubscription("send_failed", "send_failed", { closeChannel: true });
    });
  }

  /**
   * Dispatch one coalesced policy publication for this binding's current run: only
   * when Saved was negotiated, the subscription is live, and its run has a
   * complete published snapshot. The live policy is read HERE, at the actual
   * write, under a fresh generation: a reentrant notification during that read or
   * the authorizer callout supersedes this dispatch (it never writes the older
   * value), and an unchanged value is not re-sent. Description only — the server
   * re-checks the live policy itself on every delete.
   */
  #dispatchSavedPolicy(): void {
    this.#savedPolicyDirty = false;
    const hostRunId = this.#subscriptionRun;
    if (!this.#savedNegotiated()
      || hostRunId === null
      || !this.#savedRunCurrent(hostRunId)
      || this.#publishedRun !== hostRunId) {
      void this.#pump();
      return;
    }
    this.#policyGeneration += 1;
    const generation = this.#policyGeneration;
    const deleteExposed = this.#readDeleteExposed();
    // A nested dispatch already handled a newer read: this one is obsolete.
    if (generation !== this.#policyGeneration) return;
    if (this.#sending) {
      // Still the current publication, but other work (for example a roster
      // transfer the policy callback triggered) took the slot meanwhile: keep the
      // publication queued so it is dispatched, read fresh, once the slot frees.
      this.#savedPolicyDirty = true;
      return;
    }
    const authorized = this.#savedStillAuthorized(hostRunId) && this.#publishedRun === hostRunId;
    if (generation !== this.#policyGeneration) return;
    if (this.#sending) {
      this.#savedPolicyDirty = true;
      return;
    }
    if (!authorized || this.#savedPolicyDirty) {
      // Unauthorized: nothing is described. Re-notified meanwhile: the pump
      // dispatches a fresh read instead of this possibly older one.
      void this.#pump();
      return;
    }
    const sent = this.#policySent;
    if (sent !== null && sent.hostRunId === hostRunId && sent.deleteExposed === deleteExposed) {
      void this.#pump();
      return;
    }
    const bytes = this.#encodeSaved({ type: "saved_policy", hostRunId, deleteExposed });
    if (bytes === null) {
      void this.#pump();
      return;
    }
    const record = Object.freeze({ hostRunId, deleteExposed });
    this.#policySent = record;
    this.#sendSavedControl(bytes, () => {
      if (this.#policySent === record) this.#policySent = null;
      this.#diagnostic("saved_reply_dropped");
    });
    this.#diagnostic("saved_policy_sent");
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
    if (this.#state === "finished" || this.#fenced) return;
    if (this.#state === "subscribed" && this.#transfer === null) {
      const pending = this.#pending;
      if (pending !== null) {
        this.#pending = null;
        this.#beginTransfer(pending);
      }
    }
    // Always reach the pump: Saved-only work (a window, a fixed result, a policy
    // publication) must progress even when no roster transfer or snapshot waits.
    // With no Saved work the pump finds nothing and the roster path is unchanged.
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
      // The owner's durable roster slot rides only on a channel that negotiated
      // it; every other peer receives the pre-#477 row shape unchanged.
      const carryRosterSlots = this.#capabilities.includes(ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY);
      rows = snapshot.rows.map((row) => toRemoteSessionMetadata(row, { rosterSlotId: carryRosterSlots }));
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

  /**
   * Send the next frame of the one in-flight transfer, guarded immediately before
   * it. The roster transfer and an optional Saved window share this ONE send slot;
   * when both have frames waiting they alternate one frame at a time, so neither
   * can starve the other and no second queue exists. With no Saved window the
   * roster path is exactly what it always was.
   */
  #pump(): void {
    if (this.#sending) return;
    if (this.#state === "finished" || this.#fenced) return;
    const subscribed = this.#state === "subscribed";
    const transfer = subscribed ? this.#transfer : null;
    if (transfer !== null && transfer.index >= transfer.frames.length) {
      this.#transfer = null;
      const firstPublication = this.#publishedRun === null;
      this.#publishedRun = transfer.hostRunId;
      this.#publishedRevision = transfer.revision;
      this.#diagnostic("snapshot_published", { rows: transfer.totalRows, pages: transfer.pageCount });
      const pending = this.#pending;
      this.#pending = null;
      if (pending !== null) this.#beginTransfer(pending);
      // The first complete snapshot of a subscription is when the viewer learns
      // the current run, so the Saved policy description for that run follows it
      // through this same slot. Later roster publications are never Saved
      // authority and publish nothing.
      if (firstPublication && this.#savedNegotiated()) this.#savedPolicyDirty = true;
      void this.#pump();
      return;
    }
    // The Saved family (its bounded control outbox, then its window transfer)
    // alternates with the roster transfer one frame at a time. Saved control
    // frames do not need a subscription (a refusal can answer a request made
    // before one); a Saved window does.
    const savedTransfer = subscribed ? this.#savedTransfer : null;
    const savedControl = this.#savedControlPending();
    if ((savedControl || savedTransfer !== null) && (transfer === null || this.#savedTurn)) {
      if (savedControl) this.#pumpSavedControl();
      else if (savedTransfer !== null) this.#pumpSaved(savedTransfer);
      return;
    }
    if (transfer === null) return;
    // Authorization is re-checked before every protected write, including a
    // page or end frame queued before a revocation.
    if (!this.#authorized()) {
      this.#diagnostic("authorization_refused");
      this.#terminateSubscription("not_authorized", "authorization_refused");
      return;
    }
    // The authorizer is owner code: it may reenter the pump (for example through
    // a Saved policy notification) and take the slot, or retire this transfer.
    // Whoever now owns the slot resumes this work when its write settles.
    if (this.#sending
      || this.#state !== "subscribed"
      || this.#fenced
      || this.#transfer !== transfer) return;
    this.#sending = true;
    this.#savedTurn = true;
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
    // Saved reads are tied to the live subscription's run, so they end with it.
    // An accepted resume or delete is NOT touched: it keeps running under the
    // owner's own lifecycle. The next subscription republishes its own policy.
    this.#policySent = null;
    this.#abortSavedRead();
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
      // Saved bookkeeping is network-delivery bookkeeping too: a pending resume or
      // delete keeps running under the owner's lifecycle and its result is dropped.
      this.#savedOp = null;
      this.#savedTransfer = null;
      this.#savedResult = null;
      this.#savedRefusal = null;
      this.#savedPolicyDirty = false;
      if (this.#state !== "finished") {
        // An owner-initiated stop tells the viewer its observations are no
        // longer current; it never fabricates an empty roster.
        if (subscriptionId !== null && reason === "stopped") {
          this.#sendControl({ type: "error", code: "unavailable", subscriptionId });
        }
        this.#state = "finished";
        if (reason === "stopped") this.#diagnostic("binding_stopped");
      }
      // The binding owns its one view and releases it here. Disposal releases
      // read/resource state only and never cancels accepted resume/delete work.
      const view = this.#savedView;
      this.#savedView = null;
      this.#savedViewDisposed = true;
      if (view !== null) {
        try {
          view.dispose();
        } catch {
          // Disposal is best effort.
        }
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
  // The Saved pair is all-or-nothing: a view without a live delete policy (or the
  // reverse) is a partial configuration and is refused rather than defaulted.
  const savedView = options.savedCatalogView;
  const savedPolicy = options.remoteHistoryDeleteExposed;
  let saved: SavedProviders | null = null;
  if (savedView !== undefined || savedPolicy !== undefined) {
    if (typeof savedView !== "function" || typeof savedPolicy !== "function") {
      throw new TypeError("roster metadata host requires a Saved view factory and a live delete policy together");
    }
    saved = Object.freeze({ createView: savedView, deleteExposed: savedPolicy });
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
      }, saved);
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
    notifySavedPolicy(): void {
      if (saved === null) return;
      // The EXISTING bindings only: no registry, observer list, or replay.
      for (const binding of [...bindings]) {
        try {
          binding.notifySavedPolicy();
        } catch {
          // One binding's failure never blocks another's publication.
        }
      }
    },
  };
  return host;
}
