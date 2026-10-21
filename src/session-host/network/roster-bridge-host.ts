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
 * stops, writes, resizes, or closes a session. Stopping a subscription, fencing
 * a channel, or losing the transport changes metadata delivery only.
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
import { isRemoteSessionMetadataError, toRemoteSessionMetadata, type RemoteSessionMetadata } from "./roster-metadata";
import {
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
  | "binding_stopped";

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
    // the viewer subscribes: the owner is never eager.
    this.#sendControl({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: Math.min(frame.minor, ROSTER_BRIDGE_MINOR),
      // The acknowledgement states the capability set in force for this session:
      // the required baseline this owner implements, plus any optional capability
      // both sides offered. Negotiation can only narrow what either side assumes.
      capabilities: Object.freeze([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ...decision.capabilities]),
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
