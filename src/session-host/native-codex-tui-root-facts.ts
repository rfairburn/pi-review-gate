/**
 * Owner-private, retained ordinary-fresh Codex root facts.
 *
 * This module is a PURE closed-metadata state machine over the private TUI
 * relay's existing event union. It performs no I/O, starts no timer, opens no
 * socket, and retains no wire frame, payload, prompt, command, output, error
 * message, or event history. Its complete retained state is bounded: one
 * connection generation, one candidate/bound root id, one current root turn id,
 * one current rooted tool fact, one bounded provisional tool fact, and one
 * withdrawal reason.
 *
 * ## What "fresh root" means here
 *
 * A root is bound only when ALL of the following were positively observed:
 *
 * 1. the owned backend returned an EMPTY pre-attach loaded-thread census
 *    (`attestEmptyBackend`), the composite lease's own pre-TUI witness;
 * 2. one genuine native `codex-tui` initialize with
 *    `requiredHumanApproval === true` established the connection generation;
 * 3. exactly one initial non-helper, parentless, non-ephemeral
 *    `thread/start` response named candidate thread A;
 * 4. this same connection's FIRST own successful `turn/start` response named
 *    thread A (the relay's `turn-work-target`).
 *
 * Step 4 is required for publication: a start response alone is never treated
 * as a root selection. Before step 4 the candidate is private and no root
 * observation is published. After it, the source publishes the CURRENT closed
 * state only — never a replay of the events that produced it — so a consumer
 * that attaches during root execution still sees the positively known current
 * tool, and a consumer that attaches later sees the same current state without
 * reconstructing history.
 *
 * ## Fail-closed invalidation
 *
 * Withdrawal is sticky and never rebinds: a second genuine TUI connection, any
 * closed generation, any metadata loss (message or connection scope), a native
 * non-helper `thread/resume` or `thread/fork`, a second native primary
 * `thread/start`, or work on a thread other than A. Positive native helper
 * traffic (the relay's own `native-helper` request-id classifier plus a
 * parentless/non-ephemeral start shape) is ignored and never withdraws an
 * ordinary root, because helpers are concurrent internals, not a selection.
 *
 * Withdrawal discards every retained root fact, so a withdrawn source can never
 * carry stale root state. It never stops the native relay, detaches its tap, or
 * touches the backend: observation loss is not transport authority.
 *
 * ## Attribution
 *
 * A root tool fact requires BOTH the current root/candidate thread id and a
 * canonical relay `toolCategory`. A missing or unrelated `threadId` is never
 * attributed, and a helper/child thread is therefore never labelled from the
 * root. The current tool is one scalar (the newest rooted start) with its turn
 * identity when the relay supplied it; a new root turn clears it, and a
 * completion from a different turn is rejected. This is current state, not an
 * activity log. One additional bounded provisional fact covers the provider's
 * ordering where a rooted item notification for the next turn arrives before
 * that turn's own `turn/start` response projection: it stays private until the
 * exact turn is confirmed, then becomes the current tool instead of being lost.
 * It is still one scalar and is never event history.
 *
 * The input request/response events are deliberately ignored: this source adds
 * no shadow input axis, no reply/control surface, and no request map. The RPC
 * lane remains the input authority for a later consumer.
 */

import type {
  NativeCodexTuiRelayMetadataEvent,
  NativeCodexTuiRelayToolCategory,
} from "./native-codex-tui-relay";

/** Closed reasons a retained fresh-root observation becomes permanently unusable. */
export type NativeCodexTuiRootWithdrawalReason =
  | "backend-attestation-unavailable"
  | "backend-not-empty"
  | "generation-closed"
  | "metadata-unavailable"
  | "second-connection"
  | "second-primary-thread-start"
  | "thread-selection-advanced"
  | "work-on-another-thread"
  | "work-without-fresh-thread";

/** Closed lifecycle of the retained source. */
export type NativeCodexTuiRootPhase =
  | "empty"
  | "connected"
  | "candidate"
  | "bound"
  | "withdrawn";

/**
 * The current rooted tool fact. `turnId` is the relay-supplied turn identity
 * when the provider named one; it is used to clear stale state and to reject an
 * old turn's completion, never as a root selector.
 */
export interface NativeCodexTuiRootToolFact {
  readonly itemId: string;
  readonly category: NativeCodexTuiRelayToolCategory;
  readonly phase: "started" | "completed";
  readonly turnId?: string;
}

/**
 * One immutable CURRENT snapshot. `rootThreadId`, `rootTurnId`, and `tool` are
 * present only after a strict fresh-root binding; before that they are absent,
 * never null or zero placeholders.
 */
export interface NativeCodexTuiRootFactsSnapshot {
  readonly phase: NativeCodexTuiRootPhase;
  /** First genuine TUI connection generation; the consumer's opaque fence. */
  readonly connectionId?: string;
  /** Present only while bound. */
  readonly rootThreadId?: string;
  /** Latest own successful turn on the bound root. */
  readonly rootTurnId?: string;
  /** Current rooted tool state, present only while bound and positively known. */
  readonly tool?: NativeCodexTuiRootToolFact;
  /** Present only after a permanent withdrawal. */
  readonly withdrawal?: NativeCodexTuiRootWithdrawalReason;
}

/**
 * Owner-only attach seam exposed on a composite lease's ready value.
 *
 * `watch` synchronously delivers the CURRENT snapshot exactly once, then every
 * future change. It never replays stored wire events, and a second concurrent
 * watcher is refused (a no-op unsubscribe) because this source serves one
 * consumer generation. Unsubscribing removes only that watcher: it never stops
 * the relay, detaches the metadata tap, or touches the backend.
 */
export interface NativeCodexTuiRootFactsSource {
  current(): NativeCodexTuiRootFactsSnapshot;
  watch(listener: (snapshot: NativeCodexTuiRootFactsSnapshot) => void): () => void;
}

/**
 * The composite lease's private ingest surface. Only the composite calls these;
 * a consumer receives {@linkcode NativeCodexTuiRootFactsSource} instead, so it
 * cannot attest, withdraw, or inject facts.
 */
export interface NativeCodexTuiRootFactsBinder extends NativeCodexTuiRootFactsSource {
  /** One-shot witness that the owned backend's pre-attach census was empty. */
  attestEmptyBackend(): void;
  /** Sticky withdrawal; later events can never rebind. Idempotent. */
  withdraw(reason: NativeCodexTuiRootWithdrawalReason): void;
  /** Consume one closed relay metadata event. */
  observe(event: NativeCodexTuiRelayMetadataEvent): void;
}

type InitializeEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "genuine-tui-initialize" }>;
type ThreadCandidateEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "thread-candidate" }>;
type TurnWorkTargetEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "turn-work-target" }>;
type ItemPhaseEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "item-phase" }>;

const EMPTY_SNAPSHOT: NativeCodexTuiRootFactsSnapshot = Object.freeze({ phase: "empty" as const });

/** Create one bounded, pure fresh-root facts binder. */
export function createNativeCodexTuiRootFactsBinder(): NativeCodexTuiRootFactsBinder {
  return new NativeCodexTuiRootFactsBinderImpl();
}

class NativeCodexTuiRootFactsBinderImpl implements NativeCodexTuiRootFactsBinder {
  #attestedEmpty = false;
  #withdrawn: NativeCodexTuiRootWithdrawalReason | undefined;
  #connectionId: string | undefined;
  #candidateThreadId: string | undefined;
  #rootThreadId: string | undefined;
  #rootTurnId: string | undefined;
  #tool: NativeCodexTuiRootToolFact | undefined;
  #pendingTool: NativeCodexTuiRootToolFact | undefined;
  #snapshot: NativeCodexTuiRootFactsSnapshot = EMPTY_SNAPSHOT;
  #watcher: ((snapshot: NativeCodexTuiRootFactsSnapshot) => void) | undefined;

  current(): NativeCodexTuiRootFactsSnapshot {
    return this.#snapshot;
  }

  watch(listener: (snapshot: NativeCodexTuiRootFactsSnapshot) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("native Codex TUI root facts listener must be a function");
    }
    // One consumer generation. A second watcher is refused rather than
    // silently sharing or replacing the first, so a stale consumer can never
    // receive another run's current state.
    if (this.#watcher !== undefined) return () => undefined;
    this.#watcher = listener;
    this.#deliver(listener, this.#snapshot);
    return () => {
      if (this.#watcher === listener) this.#watcher = undefined;
    };
  }

  attestEmptyBackend(): void {
    if (this.#withdrawn !== undefined || this.#attestedEmpty) return;
    this.#attestedEmpty = true;
  }

  withdraw(reason: NativeCodexTuiRootWithdrawalReason): void {
    if (this.#withdrawn !== undefined) return;
    this.#withdrawn = reason;
    // A withdrawn source never carries stale root facts.
    this.#candidateThreadId = undefined;
    this.#rootThreadId = undefined;
    this.#rootTurnId = undefined;
    this.#tool = undefined;
    this.#pendingTool = undefined;
    this.#publish();
  }

  observe(event: NativeCodexTuiRelayMetadataEvent): void {
    if (this.#withdrawn !== undefined) return;

    if (event.kind === "genuine-tui-initialize") {
      this.#observeInitialize(event);
      return;
    }

    // Every other projection is meaningful only for the one generation whose
    // genuine initialize was observed. A mismatch means this source lost the
    // stream it was proving and can no longer distinguish later facts.
    if (this.#connectionId === undefined || event.connectionId !== this.#connectionId) {
      this.withdraw("metadata-unavailable");
      return;
    }

    switch (event.kind) {
      case "metadata-unavailable":
        // Both message and connection scope are a real coverage loss.
        this.withdraw("metadata-unavailable");
        return;
      case "generation-closed":
        this.withdraw("generation-closed");
        return;
      case "thread-candidate":
        this.#observeThreadCandidate(event);
        return;
      case "turn-work-target":
        this.#observeTurnWorkTarget(event);
        return;
      case "item-phase":
        this.#observeItemPhase(event);
        return;
      case "input-request":
      case "input-response":
        // Deliberately unretained: this source owns no input axis, no reply
        // surface, and no request map.
        return;
    }
  }

  #observeInitialize(event: InitializeEvent): void {
    // The relay only emits this for its genuine client name AND capability.
    // Re-checking the capability keeps a malformed injected event from
    // establishing a connection generation.
    if (event.humanApprovalRequired !== true) return;
    if (this.#connectionId === undefined) {
      this.#connectionId = event.connectionId;
      this.#publish();
      return;
    }
    if (event.connectionId !== this.#connectionId) {
      // A second TUI connection means the one-generation premise is gone.
      this.withdraw("second-connection");
    }
  }

  #observeThreadCandidate(event: ThreadCandidateEvent): void {
    // Helper traffic is labelled by its request id and is a concurrent
    // internal, never a root; it must not withdraw a healthy ordinary root.
    if (event.requestIdKind === "native-helper") return;

    if (event.origin !== "thread-start") {
      // A native resume/fork advances thread selection instead of proving a
      // fresh start. It is unsupported, not silently adopted.
      this.withdraw("thread-selection-advanced");
      return;
    }

    // A parented or ephemeral start is a child/helper structure, not a primary
    // thread-start candidate.
    if (event.parentThreadId !== undefined || event.ephemeral === true) return;

    if (this.#candidateThreadId !== undefined || this.#rootThreadId !== undefined) {
      this.withdraw("second-primary-thread-start");
      return;
    }

    this.#candidateThreadId = event.threadId;
    this.#publish();
  }

  #observeTurnWorkTarget(event: TurnWorkTargetEvent): void {
    if (event.requestIdKind === "native-helper") return;

    const candidate = this.#candidateThreadId;
    if (candidate === undefined) {
      // Work without this connection's own fresh start proves no fresh root.
      this.withdraw("work-without-fresh-thread");
      return;
    }
    if (event.threadId !== candidate) {
      this.withdraw("work-on-another-thread");
      return;
    }

    if (this.#rootThreadId === undefined) {
      if (!this.#attestedEmpty) {
        // The empty owned-backend witness is part of the fresh root proof.
        this.withdraw("backend-attestation-unavailable");
        return;
      }
      this.#rootThreadId = candidate;
      this.#rootTurnId = event.turnId;
      // A pre-bind private tool is published only if it can belong to this
      // first root turn. An explicit different turn means it is stale.
      if (this.#tool !== undefined && this.#tool.turnId !== undefined && this.#tool.turnId !== event.turnId) {
        this.#tool = undefined;
      }
      this.#pendingTool = undefined;
      this.#publish();
      return;
    }

    if (this.#rootTurnId === event.turnId) return;
    // A new root turn replaces the previous turn's current tool. A rooted tool
    // start already observed for THIS newly confirmed turn (its item notification
    // can precede the turn/start response projection) is preserved rather than
    // discarded, so a later attach still sees the positively running tool.
    this.#rootTurnId = event.turnId;
    const provisional = this.#pendingTool;
    this.#pendingTool = undefined;
    this.#tool = provisional !== undefined && provisional.turnId === event.turnId ? provisional : undefined;
    this.#publish();
  }

  #observeItemPhase(event: ItemPhaseEvent): void {
    const root = this.#rootThreadId ?? this.#candidateThreadId;
    // Missing and unrelated thread ids are never attributed.
    if (root === undefined || event.threadId === undefined || event.threadId !== root) return;
    // Only the relay's closed canonical tool categories are root activity.
    const category = event.toolCategory;
    if (category === undefined) return;

    if (event.phase === "started") {
      const turnId = event.turnId ?? this.#rootTurnId;
      const next: NativeCodexTuiRootToolFact = Object.freeze({
        itemId: event.itemId,
        category,
        phase: "started" as const,
        ...(turnId === undefined ? {} : { turnId }),
      });
      // A rooted start whose own turn has not yet been confirmed may precede the
      // turn/start response projection. Retain ONE bounded provisional fact and
      // publish it only when a later work target confirms that exact turn. This
      // is current closed state, not a per-turn event history.
      if (this.#rootTurnId !== undefined && event.turnId !== undefined && event.turnId !== this.#rootTurnId) {
        if (!sameTool(next, this.#pendingTool)) this.#pendingTool = next;
        return;
      }
      if (sameTool(next, this.#tool)) return;
      this.#tool = next;
      this.#publish();
      return;
    }

    const current = this.#tool;
    const oldTurn = this.#rootTurnId !== undefined
      && event.turnId !== undefined
      && event.turnId !== this.#rootTurnId;
    // A completion is a rooted fact only for the current tool; a completion
    // whose start this source never retained is not reconstructed.
    if (current === undefined || current.itemId !== event.itemId || oldTurn) {
      // A completion of the bounded provisional tool is retained privately so
      // its confirmed turn does not later publish a stale "started" phase. It
      // never affects the current root turn's label.
      const pending = this.#pendingTool;
      if (
        pending !== undefined
        && pending.itemId === event.itemId
        && pending.turnId !== undefined
        && (event.turnId === undefined || event.turnId === pending.turnId)
        && pending.phase === "started"
      ) {
        this.#pendingTool = Object.freeze({
          itemId: pending.itemId,
          category: pending.category,
          phase: "completed" as const,
          turnId: pending.turnId,
        });
      }
      return;
    }
    if (current.phase === "completed") return;
    this.#tool = Object.freeze({
      itemId: current.itemId,
      category: current.category,
      phase: "completed" as const,
      ...(current.turnId === undefined ? {} : { turnId: current.turnId }),
    });
    this.#publish();
  }

  #publish(): void {
    const next = this.#buildSnapshot();
    if (sameSnapshot(next, this.#snapshot)) return;
    this.#snapshot = next;
    const watcher = this.#watcher;
    if (watcher !== undefined) this.#deliver(watcher, next);
  }

  #deliver(listener: (snapshot: NativeCodexTuiRootFactsSnapshot) => void, snapshot: NativeCodexTuiRootFactsSnapshot): void {
    try {
      listener(snapshot);
    } catch {
      // A consumer throw is contained; it cannot corrupt relay forwarding.
    }
  }

  #buildSnapshot(): NativeCodexTuiRootFactsSnapshot {
    const connectionId = this.#connectionId;
    if (this.#withdrawn !== undefined) {
      return Object.freeze({
        phase: "withdrawn" as const,
        ...(connectionId === undefined ? {} : { connectionId }),
        withdrawal: this.#withdrawn,
      });
    }
    const rootThreadId = this.#rootThreadId;
    if (rootThreadId !== undefined) {
      const rootTurnId = this.#rootTurnId;
      const tool = this.#tool;
      return Object.freeze({
        phase: "bound" as const,
        ...(connectionId === undefined ? {} : { connectionId }),
        rootThreadId,
        ...(rootTurnId === undefined ? {} : { rootTurnId }),
        ...(tool === undefined ? {} : { tool }),
      });
    }
    if (this.#candidateThreadId !== undefined) {
      // The candidate is private: no root thread id or tool is published yet.
      return Object.freeze({
        phase: "candidate" as const,
        ...(connectionId === undefined ? {} : { connectionId }),
      });
    }
    if (connectionId !== undefined) return Object.freeze({ phase: "connected" as const, connectionId });
    return EMPTY_SNAPSHOT;
  }
}

function sameSnapshot(a: NativeCodexTuiRootFactsSnapshot, b: NativeCodexTuiRootFactsSnapshot): boolean {
  return a.phase === b.phase
    && a.connectionId === b.connectionId
    && a.rootThreadId === b.rootThreadId
    && a.rootTurnId === b.rootTurnId
    && a.withdrawal === b.withdrawal
    && sameTool(a.tool, b.tool);
}

function sameTool(a: NativeCodexTuiRootToolFact | undefined, b: NativeCodexTuiRootToolFact | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.itemId === b.itemId
    && a.category === b.category
    && a.phase === b.phase
    && a.turnId === b.turnId;
}
