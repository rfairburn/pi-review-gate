/**
 * Owner-private, retained ordinary-fresh (or exact restored) Codex root facts.
 *
 * This module is a PURE closed-metadata state machine over the private TUI
 * relay's existing event union. It performs no I/O, starts no timer, opens no
 * socket, and retains no wire frame, payload, prompt, command, output, error
 * message, or event history. Its complete retained state is bounded: one
 * connection generation, one candidate/bound root id, one current root turn id,
 * one current rooted tool fact, one bounded provisional tool fact, one
 * withdrawal reason, the optional expected restored thread id fixed at
 * construction, and the closed identities of the CURRENT async question
 * queue (see below), which a live terminal retires, each tagged with this
 * source's own ingestion position so one held provisional terminal witness can
 * be applied to exactly the knowledge that preceded it.
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
 * Step 4 is required for a BOUND root: a start response alone is never treated
 * as a root selection. Steps 1–3 together form the owner-private FRESH
 * CANDIDATE binding: the `candidate` snapshot names candidate thread A only once
 * the empty-backend witness, the genuine connection, and exactly one initial
 * primary start are all positively known. It lets the owner start its read-only
 * status observation of A before the first prompt; it is not a root adoption
 * from history, a loaded list, a last success, prose, or the UI, and every
 * strict binding and withdrawal fence below still applies to it. A later bound
 * snapshot names the SAME thread A and connection, or the source withdraws. The
 * source publishes the CURRENT closed state only — never a replay of the events
 * that produced it — so a consumer that attaches during root execution still
 * sees the positively known current tool, and a consumer that attaches later
 * sees the same current state without reconstructing history.
 *
 * ## Fail-closed invalidation
 *
 * Withdrawal is sticky and never rebinds: a second genuine TUI connection, any
 * closed generation, any metadata loss (message or connection scope), a native
 * non-helper `thread/resume` or `thread/fork` (for restore mode's mirrored
 * fences see "Exact restored root" below), a second native primary
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
 * The legacy server-request input request/response events are deliberately
 * ignored: the RPC lane's provider status remains their authority, and this
 * source adds no request map, reply, or control surface for them.
 *
 * ## Asynchronous question queue
 *
 * Asynchronous questions are not server requests, so no provider status flag
 * reports them. This source therefore keeps the candidate/root thread's
 * CURRENT async question queue as closed identities only: per asking item id,
 * its envelope turn id, the indices positively unanswered, the indices whose
 * proof a finite known cause made uncertain, and whether the item's own
 * question list was unreadable. No title, option, question, answer, or text is
 * ever retained. `asyncInput` states it:
 *
 * - `pending` while any own question is positively unanswered, even while
 *   other knowledge is uncertain. Collapsing or backgrounding the native
 *   queue, focus, tool completion, root idleness, new work, a backend
 *   user-message echo, and helper or foreign-thread prompts never clear it.
 * - An answered question leaves the queue only on the backend's committed
 *   native reply envelope naming its exact key (or its whole item), on this
 *   connection and this root thread; other questions stay pending. The TUI's
 *   own reply-envelope submission (and its acknowledgement or error) is not
 *   that commit and changes nothing.
 * - The native UI clears its unanswered queue when it submits an ORDINARY
 *   model prompt. On this connection's own non-helper `ordinary-input` for the
 *   root, every question held before that submission becomes UNCERTAIN, not
 *   none: a question still in flight toward the UI was not cleared, so which
 *   ones were dropped is unprovable. Its acknowledgement changes nothing, a
 *   question published afterwards is fresh pending proof, and with nothing
 *   held the knowledge (normally `none` for a first prompt) is unchanged.
 * - An unreadable committed user item, or a matching reply whose thread is
 *   unknown, likewise makes the questions it could have answered uncertain.
 * - Uncertainty is finite and RECOVERABLE: it names exact item indices, and a
 *   later committed reply on this root naming them (or their whole item)
 *   resolves them as soon as it arrives. With nothing else unresolved, input
 *   is `none` again before any terminal.
 * - A question item whose list could not be read in full is a PUBLICATION gap
 *   (its questions are unseen, so no reply to another question can prove
 *   none). A gap naming its item is resolved by that item's whole-item reply,
 *   or repaired by a later full read of the same item on its still-current
 *   turn (pending, or uncertain if something since could have cleared it). A
 *   gap that names no item stays on its turn, and an unattributed one on the
 *   root, until a live terminal: no unrelated item, reply, or idleness is
 *   treated as completeness. A gap for an already registered item is a replay
 *   the native UI ignores and changes nothing; the affected turn's other
 *   pending witnesses become uncertain. Gaps change no other fact.
 * - The native UI clears its WHOLE queue on its thread's LIVE turn terminal.
 *   A held confirmed turn's terminal retires that turn's questions (and any
 *   gap on that turn), while a turn-only gap alone never authenticates a
 *   non-current terminal. The current root turn's terminal is a complete
 *   queue boundary that retires every held question, uncertainty, and gap. A
 *   terminal for the unconfirmed provisional turn is not retirement proof: its
 *   held questions only become uncertain, and the slot keeps one bounded
 *   witness of where that terminal was observed. When that exact turn's own
 *   successful start is later confirmed, the stored terminal WAS the current
 *   turn's live terminal: everything held from before it retires at once,
 *   with no second terminal needed, while questions, gaps, and uncertainty
 *   first observed after it keep their own knowledge. The slot may hold no
 *   question at all: a turn-only publication gap on an unconfirmed turn takes
 *   the free slot only to carry this same witness, never inventing a question
 *   or count, and that terminal alone still leaves input unknown. Another
 *   turn's confirmation, slot replacement, or withdrawal drops the witness
 *   unused.
 *   A retirement is never an answer, and the terminal is one recovery path,
 *   not the only one.
 * - Only the first or the confirmed CURRENT root turn's questions are pending
 *   proof. Another turn's questions (the next own turn before its start
 *   projection, or an old turn's replay) occupy one provisional slot that makes
 *   input unknown until that exact turn is confirmed. A bounded window of
 *   recently retired turns rejects late replays outright, and a terminal for a
 *   turn this source neither holds nor knows as current retires nothing, so
 *   duplicates and late items never resurrect and stale terminals never rewind.
 * - Helper and foreign threads can neither add nor clear a question.
 *
 * ## Exact restored root (restore mode)
 *
 * A binder created with `resumeConversationId` B proves an EXACT restored
 * root instead of a fresh one. Absent that option the binder is exactly the
 * fresh-only binder above. Knowing B selects and publishes nothing by itself:
 * the candidate binding is named only when ALL of the following were
 * positively observed:
 *
 * 1. the same EMPTY owned-backend pre-attach witness;
 * 2. the same one genuine native `codex-tui` initialize;
 * 3. the first successful non-helper `thread/resume` whose request's own
 *    `params.threadId` (the relay's `requestedThreadId`), the response's
 *    `thread.id`, and the expected B are all the same id, with a parentless,
 *    non-ephemeral shape.
 *
 * It then publishes `candidateThreadId` B in the same candidate snapshot shape
 * as a fresh candidate, so the owner can save the identity and start its
 * read-only observation before any prompt. The first own successful
 * `turn/start` on B binds it exactly as a fresh A is bound. Every fresh fence
 * still applies, mirrored for the mode: a primary `thread/start`, any
 * `thread/fork`, a second non-helper resume (of B or of any other thread, such
 * as an attached child), a requested/response/expected mismatch or a child or
 * ephemeral resume shape, work on another thread, a second connection, metadata
 * loss, and a closed generation each withdraw permanently. Native helper
 * traffic stays ignored. Nothing is adopted from a read, a list, history, the
 * newest thread, or the UI. This module validates only that B is a bounded
 * opaque id; whether B is a well-formed provider id and belongs to the saved
 * workspace is the launcher's and owner's admission, not this binder's.
 *
 * The restored native UI starts a NEW, empty question queue and its history
 * replay never queues a question, so with no contrary live evidence a restored
 * candidate starts at `none`. Live questions on B can still precede the
 * candidate response (buffered live notifications, or a restored active goal
 * running a turn with no own `turn/start`). Because B is known in advance, once
 * the empty-backend witness and the genuine generation are known this source
 * PRIVATELY applies B's question, reply, gap, ordinary-input, and live terminal
 * metadata to the SAME bounded queue it uses for a candidate, publishing
 * nothing until the candidate proof is complete. A B question metadata gap seen
 * while that witness is still missing cannot be attributed exactly and becomes
 * the existing unattributed publication gap (unknown), never pending or none.
 * There is no second queue, history, timer, or ordering of its own.
 *
 * ## Closed generation evidence
 *
 * When this source's own generation ends, the withdrawal also carries the
 * relay's own closed `closeReason` for it (for example `client-closed` when the
 * TUI ended its connection). It is lifecycle EVIDENCE only, never a claim that
 * the native session ended normally, and it changes nothing about the sticky
 * status withdrawal: no root or status is ever rebound. It is retained only
 * until this source ingests ANY later metadata event (a later connection, a
 * stray event, or a loss), which drops it and republishes, so an identity-only
 * consumer can tell "nothing has happened since the generation closed" from
 * "something did".
 *
 * ## Callback root facts (#682)
 *
 * `callbackFacts()` is a separate, synchronous, owner-private read for the
 * callback composer ({@linkcode NativeCodexCallbackRootFacts}). It is NOT part
 * of the published snapshot: it never changes `current()`, never triggers a
 * `watch` delivery, and adds nothing to sidebar telemetry. It is `null` unless
 * this source is BOUND (the exact first own root above) and not withdrawn, so a
 * withdrawn generation can never be revived. `threadId` is the bound root and
 * `runId` is this source's own connection generation id.
 *
 * It is derived only from closed relay lifecycle projections attributed to the
 * candidate/root thread (or, in restore mode, the expected B once its witness
 * and generation are known). Sibling, helper, and child threads are ignored. A
 * projection with no readable thread may be the root's, so it counts against
 * the root (fail closed). Before any root thread is known, evidence naming a
 * readable thread is held per thread in a small bounded map; when the root
 * thread becomes known only that thread's entry is kept, and an entry evicted
 * on overflow is folded into the root's evidence instead of being lost.
 * Retained state is bounded and closed: one activity value, a window of ended
 * turn ids with their terminal status, two stop sequences per scope, and one
 * own-work request position. No payload or content is retained.
 *
 * - Activity `busy(turnId)` on a live `turn/started` for the root, or on this
 *   connection's own successful root `turn/start` whose REQUEST is positively
 *   newer than both the latest root lifecycle evidence and the latest own
 *   request. A reply for an older or unordered request, or one after which
 *   newer lifecycle evidence intervened, does not prove which turn is active
 *   now: unless it names the turn already busy, activity becomes `unknown`
 *   rather than a stale steer target or stale idle. It becomes
 *   `idle(lastTurnId)` only on a readable live terminal for EXACTLY that busy
 *   turn. A terminal for a turn this source never saw active while not busy,
 *   or an unreadable root lifecycle notification, makes it `unknown` until the
 *   next positively observed start or genuinely later own request. An ended
 *   turn never becomes busy again. Terminal replay identity is the exact
 *   (thread, turn) pair, so another thread's terminal never masks the root's.
 * - Stop knowledge is ORDERED by the relay's own strictly increasing per-
 *   generation `sequence`. Stop evidence is recorded at its event's sequence:
 *   `stopped` for this connection's own `turn/interrupt` naming the root
 *   (observed at its client frame, before it is forwarded) and for a root
 *   `interrupted` terminal; `unknown` for a `failed` terminal, an unreadable
 *   root `turn/completed` (it may have hidden a stop), an interrupt naming no
 *   readable thread, and a terminal for an already ended turn whose status
 *   conflicts with the one recorded (an identical replay changes nothing).
 * - Own work is this connection's own successful root `turn/start`, positioned
 *   at its REQUEST frame by the relay's `requestAfterSequence`, never at its
 *   reply. `userStop` is `none` only when every stop evidence sequence is at or
 *   before the latest own work request position: a reply that arrives after a
 *   stop, for a request sent before it, never clears the stop. A work target
 *   without request-order evidence proves no order and clears nothing, and a
 *   turn started by anyone else (for example a host queue start) never clears
 *   a stop. An evidence sequence that is not a safe non-negative integer is
 *   treated as never cleared. Missing evidence is never `none`.
 *
 * ## Backend version proof (#682)
 *
 * `callbackBackendVersion()` is a second owner-private read beside
 * `callbackFacts()`, equally unpublished. It carries the stable version triple
 * the owned backend reported in its own response to THIS source's genuine TUI
 * `initialize` (the relay's `backend-initialize` projection, correlated by that
 * request's id on the same connection generation), paired with the exact
 * `runId` and bound root `threadId` `callbackFacts()` names at the moment of
 * the read. It is `null` whenever `callbackFacts()` is `null` (unbound,
 * withdrawn, a displaced or closed generation), when the response was an error
 * or carried no readable stable version, and for good once a second response
 * was projected for the same generation. It never decides whether a version is
 * supported; the owner does. No raw user agent is retained.
 *
 * `discoveryBackendVersion()` is the same recorded version paired with the
 * genuine connection generation only, and is the one read that needs no bound
 * root: it is non-null from the moment the backend's answer to this source's
 * genuine `initialize` was ingested (the relay ingests it before it forwards
 * that answer to the TUI) until a withdrawal, and `null` before that, after a
 * second answer, and whenever `callbackBackendVersion()` would be `null` for
 * any reason other than a still-unbound root. It names no thread, so it can
 * only ever gate discovery METADATA; it proves no conversation and admits no
 * call or delivery, which keep requiring `callbackBackendVersion()`.
 */

import type {
  NativeCodexCallbackRootActivity,
  NativeCodexCallbackRootFacts,
} from "./native-codex-callback-composition";
import {
  NATIVE_CODEX_TUI_RELAY_MAX_ID_CHARS,
  type NativeCodexTuiRelayGenerationCloseReason,
  type NativeCodexTuiRelayMetadataEvent,
  type NativeCodexTuiRelayToolCategory,
} from "./native-codex-tui-relay";

/** Closed reasons a retained fresh-root observation becomes permanently unusable. */
export type NativeCodexTuiRootWithdrawalReason =
  | "backend-attestation-unavailable"
  | "backend-not-empty"
  | "generation-closed"
  | "metadata-unavailable"
  | "restored-thread-mismatch"
  | "second-connection"
  | "second-primary-thread-start"
  | "thread-selection-advanced"
  | "work-on-another-thread"
  | "work-without-fresh-thread";

/**
 * Closed current state of the candidate/root's async question queue: positively
 * pending, positively none, or unknown after an input-metadata gap.
 */
export type NativeCodexTuiRootAsyncInput = "none" | "pending" | "unknown";

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
  /**
   * Owner-private fresh candidate thread A, present only in the `candidate`
   * phase and only once the empty-backend witness, the genuine connection, and
   * exactly one initial primary start are positively known. Not a root.
   */
  readonly candidateThreadId?: string;
  /** Current async question queue state; present with a candidate or bound root. */
  readonly asyncInput?: NativeCodexTuiRootAsyncInput;
  /** Present only while bound. */
  readonly rootThreadId?: string;
  /** Latest own successful turn on the bound root. */
  readonly rootTurnId?: string;
  /** Current rooted tool state, present only while bound and positively known. */
  readonly tool?: NativeCodexTuiRootToolFact;
  /** Present only after a permanent withdrawal. */
  readonly withdrawal?: NativeCodexTuiRootWithdrawalReason;
  /**
   * Present only on a `generation-closed` withdrawal: the relay's own closed
   * reason for this source's generation, and only until any later metadata
   * event is ingested. Evidence of how the connection ended, never of intent.
   */
  readonly closeReason?: NativeCodexTuiRelayGenerationCloseReason;
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
 * Owner-private synchronous read of the bound root's callback facts (see
 * "Callback root facts"). Separate from the published snapshot so existing
 * status consumers are unchanged.
 */
export interface NativeCodexTuiRootCallbackFactsReader {
  /** `null` unless bound and not withdrawn. Never blocks and never throws. */
  callbackFacts(): NativeCodexCallbackRootFacts | null;
  /**
   * #682: the owned backend's own handshake version for the CURRENT bound
   * generation (see "Backend version proof"); `null` otherwise. Optional: a
   * reader without it proves nothing. Never blocks and never throws.
   */
  callbackBackendVersion?(): NativeCodexBackendVersionProof | null;
  /**
   * #682: the owned backend's own handshake version for the CURRENT genuine
   * connection generation, with no root required (see "Backend version
   * proof"); `null` otherwise. Discovery metadata only. Optional: a reader
   * without it proves nothing. Never blocks and never throws.
   */
  discoveryBackendVersion?(): NativeCodexBackendDiscoveryProof | null;
}

/**
 * #682: the root-free half of {@linkcode NativeCodexBackendVersionProof}: the
 * version the exact owned backend reported to the genuine TUI's own
 * `initialize`, bound only to that relay generation (`runId`). It names no
 * thread and therefore proves no conversation; an owner may use it to decide
 * discovery metadata only.
 */
export interface NativeCodexBackendDiscoveryProof {
  readonly version: string;
  readonly runId: string;
}

/**
 * #682: one owner-private read of the version the exact owned backend reported
 * in its response to the genuine TUI's own `initialize`, bound to the relay
 * generation (`runId`) and root thread `callbackFacts()` named at that read. A
 * stable numeric triple only; whether it is supported is the owner's decision.
 */
export interface NativeCodexBackendVersionProof {
  readonly version: string;
  readonly runId: string;
  readonly threadId: string;
}

/** The relay's own stable-triple shape, re-checked so an injected event proves nothing. */
const STABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u;

/**
 * The composite lease's private ingest surface. Only the composite calls these;
 * a consumer receives {@linkcode NativeCodexTuiRootFactsSource} instead, so it
 * cannot attest, withdraw, or inject facts.
 */
export interface NativeCodexTuiRootFactsBinder extends NativeCodexTuiRootFactsSource, NativeCodexTuiRootCallbackFactsReader {
  /** #682: always present on the binder itself (see "Backend version proof"). */
  callbackBackendVersion(): NativeCodexBackendVersionProof | null;
  /** #682: always present on the binder itself (see "Backend version proof"). */
  discoveryBackendVersion(): NativeCodexBackendDiscoveryProof | null;
  /** One-shot witness that the owned backend's pre-attach census was empty. */
  attestEmptyBackend(): void;
  /** Sticky withdrawal; later events can never rebind. Idempotent. */
  withdraw(reason: NativeCodexTuiRootWithdrawalReason): void;
  /** Consume one closed relay metadata event. */
  observe(event: NativeCodexTuiRelayMetadataEvent): void;
}

type InitializeEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "genuine-tui-initialize" }>;
type BackendInitializeEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "backend-initialize" }>;
type ThreadCandidateEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "thread-candidate" }>;
type TurnWorkTargetEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "turn-work-target" }>;
type ItemPhaseEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "item-phase" }>;
type AsyncQuestionsEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "async-questions" }>;
type AsyncReplyEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "async-question-reply" }>;
type AsyncUnreadableEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "async-input-unreadable" }>;
type OrdinaryInputEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "ordinary-input" }>;
type TurnTerminalEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "turn-terminal" }>;
type TurnStartedEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "turn-started" }>;
type TurnInterruptRequestEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "turn-interrupt-request" }>;
type TurnLifecycleUnreadableEvent = Extract<NativeCodexTuiRelayMetadataEvent, { readonly kind: "turn-lifecycle-unreadable" }>;

type TurnTerminalStatus = TurnTerminalEvent["status"];

/** Exact terminal replay identity: a turn id is only meaningful on its own thread. */
function terminalKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

/**
 * Latest relay sequences of stop evidence for one scope, by level. Negative
 * infinity means none; positive infinity means evidence that can never be
 * ordered before own work.
 */
interface CallbackStopEvidence {
  stopped: number;
  unknown: number;
}

const UNKNOWN_ACTIVITY: NativeCodexCallbackRootActivity = Object.freeze({ state: "unknown" as const });

/** Bound for ended turn ids and for pre-root per-thread stop evidence. */
const CALLBACK_EVIDENCE_FENCE = 16;

function noStopEvidence(): CallbackStopEvidence {
  return { stopped: Number.NEGATIVE_INFINITY, unknown: Number.NEGATIVE_INFINITY };
}

/** An event's relay order; anything but a safe non-negative integer is never cleared. */
function evidenceSequence(event: { readonly sequence: number }): number {
  const sequence = event.sequence;
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : Number.POSITIVE_INFINITY;
}

/**
 * One asking item's closed question knowledge, keyed by its item id. Indices
 * and flags only — never a title, option, question, or answer. Every set is
 * bounded by the item's own question count.
 */
interface QuestionItem {
  readonly turnId: string;
  /** Ingestion position at which this source first registered the item. */
  readonly since: number;
  /** Indices positively published and still unanswered. */
  readonly pending: Set<number>;
  /**
   * Indices whose pending proof was lost to a FINITE, known cause (a possible
   * local cancellation or a possible answer). A matching committed reply
   * resolves them; they never hide an unseen question.
   */
  readonly uncertain: Set<number>;
  /**
   * Present while this item's question list could not be read in full: a
   * publication gap whose question set is unknown. A whole-item reply resolves
   * it; a later full read of this same item on its turn repairs it.
   */
  gap: QuestionItemGap | undefined;
}

/** What is known about an unreadable item while its question set is unknown. */
interface QuestionItemGap {
  /** Indices a committed reply on this root positively answered meanwhile. */
  readonly answered: Set<number>;
  /** Whether anything since could have cleared or answered its questions. */
  mayBeCleared: boolean;
}

/**
 * Questions for ONE root turn this source has not yet confirmed (its item can
 * precede the own `turn/start` response projection). They are never pending
 * proof until that exact turn is confirmed; until then any unresolved entry
 * makes input unknown. It may hold no item when that turn's only knowledge is
 * a turn-only publication gap (kept on the turn itself); the slot then only
 * carries the turn's early terminal witness.
 */
interface ProvisionalQuestionTurn {
  readonly turnId: string;
  readonly items: Map<string, QuestionItem>;
  /**
   * The ingestion position of the first live terminal observed for THIS turn
   * while it was unconfirmed. It has no authority on its own; only this exact
   * turn's own successful start confirmation makes it usable, and then only
   * for knowledge first observed before that position.
   */
  terminalAt: number | undefined;
}

function newQuestionItem(turnId: string, questionCount: number | undefined, since: number): QuestionItem {
  const pending = new Set<number>();
  if (questionCount !== undefined) for (let index = 0; index < questionCount; index += 1) pending.add(index);
  return {
    turnId,
    since,
    pending,
    uncertain: new Set<number>(),
    gap: questionCount === undefined ? { answered: new Set<number>(), mayBeCleared: false } : undefined,
  };
}

function isUnresolved(item: QuestionItem): boolean {
  return item.pending.size > 0 || item.uncertain.size > 0 || item.gap !== undefined;
}

/** Retire an item's whole native queue entry while keeping its identity. */
function retireQuestionItem(item: QuestionItem): void {
  item.pending.clear();
  item.uncertain.clear();
  item.gap = undefined;
}

/**
 * A possible local cancellation or possible answer: positive pending becomes
 * finite uncertainty, and a gap item may have lost what a repair would show.
 */
function invalidateQuestionItem(item: QuestionItem): void {
  for (const index of item.pending) item.uncertain.add(index);
  item.pending.clear();
  if (item.gap !== undefined) item.gap.mayBeCleared = true;
}

/**
 * How many recently retired root turns stay fenced against late replays. A
 * replay older than this window is not rejected outright, but it can only ever
 * reach the provisional slot (input unknown), never pending.
 */
const RETIRED_TURN_FENCE = 8;

const EMPTY_SNAPSHOT: NativeCodexTuiRootFactsSnapshot = Object.freeze({ phase: "empty" as const });

/** Construction options for {@linkcode createNativeCodexTuiRootFactsBinder}. */
export interface NativeCodexTuiRootFactsBinderOptions {
  /**
   * Expected provider thread B of an exact restored root. Absent: the binder
   * proves a fresh root only. Present: it proves only the exact restored B and
   * never a fresh root. A bounded opaque id; by itself it selects nothing.
   */
  readonly resumeConversationId?: string;
}

/** The binder's own bounded closed id rule, matching the relay's id bound. */
function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= NATIVE_CODEX_TUI_RELAY_MAX_ID_CHARS
    && !/[\u0000-\u001F\u007F]/.test(value);
}

/** Create one bounded, pure fresh-root (or exact restored-root) facts binder. */
export function createNativeCodexTuiRootFactsBinder(
  options?: NativeCodexTuiRootFactsBinderOptions,
): NativeCodexTuiRootFactsBinder {
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new TypeError("native Codex TUI root facts options must be an object");
  }
  const resumeConversationId = options?.resumeConversationId;
  if (resumeConversationId !== undefined && !isBoundedId(resumeConversationId)) {
    throw new TypeError("native Codex TUI root facts resumeConversationId must be a bounded id");
  }
  return new NativeCodexTuiRootFactsBinderImpl(resumeConversationId);
}

class NativeCodexTuiRootFactsBinderImpl implements NativeCodexTuiRootFactsBinder {
  /** Expected restored thread B; undefined for the fresh-only binder. */
  readonly #expectedThreadId: string | undefined;
  #attestedEmpty = false;
  #withdrawn: NativeCodexTuiRootWithdrawalReason | undefined;
  /** The relay's reason for this source's own generation close, until any later event. */
  #closeReason: NativeCodexTuiRelayGenerationCloseReason | undefined;
  #connectionId: string | undefined;
  #candidateThreadId: string | undefined;
  #rootThreadId: string | undefined;
  #rootTurnId: string | undefined;
  #tool: NativeCodexTuiRootToolFact | undefined;
  #pendingTool: NativeCodexTuiRootToolFact | undefined;
  /** Asking item id → closed question knowledge, for the current queue only. */
  readonly #questions = new Map<string, QuestionItem>();
  /** The one not-yet-confirmed turn's questions; never pending proof. */
  #provisional: ProvisionalQuestionTurn | undefined;
  /**
   * Turns with a question-publication gap no single item can name, each with
   * the ingestion position of its latest gap.
   */
  readonly #gapTurns = new Map<string, number>();
  /**
   * Ingestion position of the latest publication gap that could not be
   * attributed to one turn of the root, while one is unresolved.
   */
  #gapUnattributedAt: number | undefined;
  /**
   * Monotonic count of ingested metadata events: this source's own observed
   * order, never a provider id or wire sequence. It only orders retained
   * knowledge against a held provisional terminal.
   */
  #ingested = 0;
  /** The most recent root turns whose live terminal retired the native queue (bounded). */
  readonly #retiredTurns: string[] = [];
  #snapshot: NativeCodexTuiRootFactsSnapshot = EMPTY_SNAPSHOT;
  #watcher: ((snapshot: NativeCodexTuiRootFactsSnapshot) => void) | undefined;
  /** Callback facts only (never published): current root activity. */
  #activity: NativeCodexCallbackRootActivity = UNKNOWN_ACTIVITY;
  /** Callback facts only: relay sequence of the latest root lifecycle evidence. */
  #activityEvidenceAt = Number.NEGATIVE_INFINITY;
  /** Callback facts only: recently ended (thread, turn) keys and their terminal status (bounded). */
  readonly #endedTurns = new Map<string, TurnTerminalStatus>();
  /** Callback facts only: stop evidence for the root (and for unattributable traffic). */
  #rootStop: CallbackStopEvidence = noStopEvidence();
  /** Callback facts only: per-thread stop evidence before any root thread is known (bounded). */
  readonly #provisionalStop = new Map<string, CallbackStopEvidence>();
  /** Callback facts only: request position of the latest own root work. */
  #ownWorkAfter = Number.NEGATIVE_INFINITY;
  /**
   * Backend version proof only (#682): `undefined` until this generation's
   * backend answered its genuine initialize; `null` when that answer proved no
   * stable version, or once a second answer was projected (sticky).
   */
  #backendVersion: string | null | undefined;

  constructor(expectedThreadId: string | undefined) {
    this.#expectedThreadId = expectedThreadId;
  }

  current(): NativeCodexTuiRootFactsSnapshot {
    return this.#snapshot;
  }

  callbackFacts(): NativeCodexCallbackRootFacts | null {
    if (this.#withdrawn !== undefined) return null;
    const threadId = this.#rootThreadId;
    const runId = this.#connectionId;
    if (threadId === undefined || runId === undefined) return null;
    const after = this.#ownWorkAfter;
    const stop = this.#rootStop;
    const userStop = stop.stopped > after ? "stopped" as const : stop.unknown > after ? "unknown" as const : "none" as const;
    return Object.freeze({ threadId, runId, activity: this.#activity, userStop });
  }

  callbackBackendVersion(): NativeCodexBackendVersionProof | null {
    const version = this.#backendVersion;
    if (typeof version !== "string") return null;
    const facts = this.callbackFacts();
    if (facts === null) return null;
    return Object.freeze({ version, runId: facts.runId, threadId: facts.threadId });
  }

  discoveryBackendVersion(): NativeCodexBackendDiscoveryProof | null {
    if (this.#withdrawn !== undefined) return null;
    const version = this.#backendVersion;
    const runId = this.#connectionId;
    if (typeof version !== "string" || runId === undefined) return null;
    return Object.freeze({ version, runId });
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
    this.#publish();
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
    this.#questions.clear();
    this.#provisional = undefined;
    this.#gapTurns.clear();
    this.#gapUnattributedAt = undefined;
    this.#retiredTurns.length = 0;
    this.#activity = UNKNOWN_ACTIVITY;
    this.#activityEvidenceAt = Number.NEGATIVE_INFINITY;
    this.#endedTurns.clear();
    this.#rootStop = noStopEvidence();
    this.#provisionalStop.clear();
    this.#ownWorkAfter = Number.NEGATIVE_INFINITY;
    this.#backendVersion = null;
    this.#publish();
  }

  observe(event: NativeCodexTuiRelayMetadataEvent): void {
    if (this.#withdrawn !== undefined) {
      // Status stays withdrawn for good. The only thing a later event changes
      // is the closed-generation evidence: something happened after the close.
      if (this.#closeReason !== undefined) {
        this.#closeReason = undefined;
        this.#publish();
      }
      return;
    }
    this.#ingested += 1;

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
      case "backend-initialize":
        this.#observeBackendInitialize(event);
        return;
      case "generation-closed":
        this.#closeReason = isGenerationCloseReason(event.reason) ? event.reason : undefined;
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
      case "async-questions":
        this.#observeAsyncQuestions(event);
        return;
      case "async-question-reply":
        this.#observeAsyncReply(event);
        return;
      case "async-input-unreadable":
        this.#observeAsyncUnreadable(event);
        return;
      case "ordinary-input":
        this.#observeOrdinaryInput(event);
        return;
      case "turn-terminal":
        this.#trackTurnTerminal(event);
        this.#observeTurnTerminal(event);
        return;
      case "turn-started":
        this.#trackTurnStarted(event);
        return;
      case "turn-interrupt-request":
        this.#trackInterruptRequest(event);
        return;
      case "turn-lifecycle-unreadable":
        this.#trackLifecycleUnreadable(event);
        return;
      case "input-request":
      case "input-response":
        // Deliberately unretained: legacy server-request input stays with the
        // RPC lane's provider status; this source keeps no request map.
        return;
    }
  }

  /**
   * The candidate or bound root thread async questions are attributed to. In
   * restore mode, before the candidate response, it is the expected B once
   * the empty-backend witness and the genuine generation are known: the queue
   * is then kept PRIVATELY (the snapshot names no candidate and no input yet),
   * so live B evidence arriving before the response is not lost.
   */
  #queueThread(): string | undefined {
    return this.#rootThreadId ?? this.#candidateThreadId ?? this.#privateRestoreQueueThread();
  }

  #privateRestoreQueueThread(): string | undefined {
    if (this.#expectedThreadId === undefined || !this.#attestedEmpty || this.#connectionId === undefined) return undefined;
    return this.#expectedThreadId;
  }

  /**
   * Restore mode only, while no queue thread is known yet because the
   * empty-backend witness is still missing: a question-metadata event that is
   * or could be B's cannot be retained exactly, so it becomes the existing
   * unattributed publication gap (unknown) rather than being dropped into a
   * later false `none`. Nothing is published: no candidate is named yet.
   */
  #absorbUnprovableRestoreGap(threadId: string | undefined): void {
    const expected = this.#expectedThreadId;
    if (expected === undefined || this.#queueThread() !== undefined) return;
    if (threadId !== undefined && threadId !== expected) return;
    this.#gapUnattributedAt = this.#ingested;
  }

  /** The registered item (confirmed or provisional) with this id, if any. */
  #lookupItem(itemId: string): QuestionItem | undefined {
    return this.#questions.get(itemId) ?? this.#provisional?.items.get(itemId);
  }

  /** Every registered item, confirmed and provisional. */
  *#allItems(): IterableIterator<QuestionItem> {
    yield* this.#questions.values();
    if (this.#provisional !== undefined) yield* this.#provisional.items.values();
  }

  /**
   * Register a new item for its turn: the first or confirmed current root turn
   * holds it as current knowledge; any other turn takes the one provisional
   * slot. A competing turn cannot silently erase unresolved knowledge the slot
   * holds, so its questions become an unattributed publication gap; a slot
   * holding nothing unresolved (for example after a live terminal retired the
   * queue) is simply replaced, so past ambiguity never latches a later gap.
   */
  #registerItem(itemId: string, item: QuestionItem): void {
    const current = this.#rootTurnId;
    if (current === undefined || item.turnId === current) {
      this.#questions.set(itemId, item);
      return;
    }
    const provisional = this.#claimProvisional(item.turnId);
    if (provisional === undefined) {
      this.#gapUnattributedAt = this.#ingested;
      return;
    }
    provisional.items.set(itemId, item);
  }

  /**
   * The one provisional slot for unconfirmed root turn `turnId`: the held slot
   * when it is that turn's, otherwise a new empty one replacing a slot that
   * holds nothing unresolved. Replacing a slot drops its turn's held terminal
   * witness. A slot holding another turn's unresolved questions is never
   * displaced, so there is no slot for `turnId` (undefined).
   */
  #claimProvisional(turnId: string): ProvisionalQuestionTurn | undefined {
    const provisional = this.#provisional;
    if (provisional !== undefined) {
      if (provisional.turnId === turnId) return provisional;
      if ([...provisional.items.values()].some(isUnresolved)) return undefined;
    }
    const claimed: ProvisionalQuestionTurn = { turnId, items: new Map(), terminalAt: undefined };
    this.#provisional = claimed;
    return claimed;
  }

  #observeAsyncQuestions(event: AsyncQuestionsEvent): void {
    const root = this.#queueThread();
    if (root === undefined) {
      this.#absorbUnprovableRestoreGap(event.threadId);
      return;
    }
    if (event.threadId !== undefined && event.threadId !== root) return; // Helper or foreign thread.
    const turnId = event.turnId;
    if (event.threadId === undefined || turnId === undefined) {
      // Questions this source cannot attribute to one root turn might be this
      // root's: never "none", and never retained as pending proof either.
      this.#invalidateForGap(undefined, undefined);
      this.#publish();
      return;
    }
    const existing = this.#lookupItem(event.itemId);
    // A retired turn's publication is a late replay. The one exception is a
    // confirmed gap item still held on that turn: retirement deletes every
    // confirmed item of the turn observed before its boundary, so such an item
    // was first observed AFTER it and kept its knowledge; its full read stays
    // repair proof below, under the same same-turn/current-turn rule.
    if (
      this.#retiredTurns.includes(turnId)
      && (existing?.gap === undefined || existing.turnId !== turnId || this.#questions.get(event.itemId) !== existing)
    ) return;
    const count = event.questionCount;
    if (!Number.isSafeInteger(count) || count < 0) {
      this.#invalidateForGap(turnId, event.itemId);
      this.#publish();
      return;
    }
    if (existing !== undefined) {
      // The native UI never registers an item id twice, so a replay is never
      // fresh proof. The one exception is this source's OWN missing knowledge:
      // a full read of an item it could not read before, on that item's same
      // turn while that turn is still current (or still the held provisional
      // turn), repairs that item's question set — a complete empty list
      // resolves it outright.
      const gap = existing.gap;
      if (gap === undefined || existing.turnId !== turnId) return;
      const current = this.#rootTurnId;
      const inProvisional = this.#provisional?.items.get(event.itemId) === existing;
      if (!inProvisional && current !== undefined && current !== turnId) return;
      existing.gap = undefined;
      const target = gap.mayBeCleared ? existing.uncertain : existing.pending;
      for (let index = 0; index < count; index += 1) {
        if (!gap.answered.has(index)) target.add(index);
      }
      this.#publish();
      return;
    }
    // The native queue ignores an empty list and does not register its id.
    if (count === 0) return;
    this.#registerItem(event.itemId, newQuestionItem(turnId, count, this.#ingested));
    this.#publish();
  }

  /**
   * A root turn was confirmed as current: promote or discard the provisional
   * slot. A terminal this exact turn already reported while unconfirmed was
   * then that turn's live terminal, and this confirmation is what makes it
   * usable: it is the native UI's complete queue boundary at the point it was
   * observed, so everything held from before it retires now, while anything
   * first observed after it keeps its own knowledge. Another turn's
   * confirmation discards the slot together with its terminal witness.
   */
  #confirmQueueTurn(turnId: string): void {
    const provisional = this.#provisional;
    if (provisional === undefined) return;
    this.#provisional = undefined;
    if (provisional.turnId !== turnId || this.#retiredTurns.includes(turnId)) return;
    for (const [itemId, item] of provisional.items) {
      if (!this.#questions.has(itemId)) this.#questions.set(itemId, item);
    }
    if (provisional.terminalAt !== undefined) this.#retireQueue(turnId, true, provisional.terminalAt);
  }

  #observeAsyncReply(event: AsyncReplyEvent): void {
    const root = this.#queueThread();
    if (root === undefined) return;
    if (event.threadId !== undefined && event.threadId !== root) return; // Foreign thread.
    let changed = false;
    for (const answer of event.answers) {
      const item = this.#lookupItem(answer.itemId);
      if (item === undefined) continue;
      changed = true;
      if (event.threadId === undefined) {
        // A committed reply naming this question whose thread is unknown may or
        // may not have answered it: its pending proof becomes finite
        // uncertainty that a later scoped reply can still resolve.
        if (answer.index === undefined) invalidateQuestionItem(item);
        else {
          if (item.pending.delete(answer.index)) item.uncertain.add(answer.index);
          if (item.gap !== undefined) item.gap.mayBeCleared = true;
        }
        continue;
      }
      if (answer.index === undefined) {
        // The older whole-item reply identity answers every question it asked,
        // including any this source could not read or was uncertain about.
        retireQuestionItem(item);
        continue;
      }
      item.pending.delete(answer.index);
      item.uncertain.delete(answer.index);
      item.gap?.answered.add(answer.index);
    }
    if (changed) this.#publish();
  }

  #observeAsyncUnreadable(event: AsyncUnreadableEvent): void {
    const root = this.#queueThread();
    if (root === undefined) {
      if (event.source === "questions") this.#absorbUnprovableRestoreGap(event.threadId);
      return;
    }
    if (event.threadId !== undefined && event.threadId !== root) return;
    if (event.source === "questions") {
      const turnId = event.threadId === undefined ? undefined : event.turnId;
      if (turnId !== undefined && this.#retiredTurns.includes(turnId)) return; // Late.
      this.#invalidateForGap(turnId, turnId === undefined ? undefined : event.itemId);
      this.#publish();
      return;
    }
    // An unreadable committed user item could have answered any held question:
    // each becomes finite uncertainty rather than staying stale pending.
    this.#invalidatePendingWitnesses();
    this.#publish();
  }

  /**
   * This connection's own ordinary model-input submission on the root (or an
   * unattributed one that could be the root's). The native UI clears its
   * unanswered queue on such a submission, but a question still in flight
   * toward it was not cleared, so which question was dropped is not provable:
   * every pre-submission witness becomes finite uncertainty — never none, and
   * a question published after this point is fresh pending proof. Helper and
   * foreign-thread submissions change nothing, and with nothing pending or
   * provisional the input knowledge (none or unknown) is unchanged.
   */
  #observeOrdinaryInput(event: OrdinaryInputEvent): void {
    if (event.requestIdKind === "native-helper") return;
    const root = this.#queueThread();
    if (root === undefined) return;
    if (event.threadId !== undefined && event.threadId !== root) return;
    this.#invalidatePendingWitnesses();
    this.#publish();
  }

  /**
   * Turn every held pending witness (confirmed and provisional) into finite
   * uncertainty. Identities stay registered so a replay cannot resurrect them;
   * a matching committed reply or the live terminal resolves them. Items with
   * nothing unanswered gain no uncertainty.
   */
  #invalidatePendingWitnesses(): void {
    for (const item of this.#allItems()) invalidateQuestionItem(item);
  }

  /**
   * A question-publication gap for one turn (or, unattributed, for any turn of
   * the root). The affected pre-gap pending witnesses become finite
   * uncertainty — a retained entry is no longer fresh proof — while their
   * identities stay registered so a replay cannot resurrect them. A gap that
   * names its item is held on that item, so a whole-item reply or a later full
   * read of that item resolves it; one that names none stays on its turn (or
   * the root) until a live terminal retires the native queue. A gap for an
   * item already registered is a replay the native UI ignores: it changes
   * nothing. A later fresh question may prove pending again.
   */
  #invalidateForGap(turnId: string | undefined, itemId: string | undefined): void {
    if (turnId !== undefined && itemId !== undefined && this.#lookupItem(itemId) !== undefined) return;
    for (const item of this.#allItems()) {
      if (turnId === undefined || item.turnId === turnId) invalidateQuestionItem(item);
    }
    if (turnId === undefined) this.#gapUnattributedAt = this.#ingested;
    else if (itemId !== undefined) this.#registerItem(itemId, newQuestionItem(turnId, undefined, this.#ingested));
    else {
      this.#gapTurns.set(turnId, this.#ingested);
      // A turn-only gap on a turn other than the confirmed current one also
      // takes the provisional slot when it is free (or already that turn's),
      // holding no item: only so that turn's early terminal can be witnessed
      // and later authenticated by its own exact confirmation. The gap itself
      // stays on its turn; the slot adds no question, count, or pending proof.
      const current = this.#rootTurnId;
      if (current !== undefined && turnId !== current) this.#claimProvisional(turnId);
    }
  }

  #observeTurnTerminal(event: TurnTerminalEvent): void {
    const root = this.#queueThread();
    if (root === undefined || event.threadId !== root) return;
    const turnId = event.turnId;
    // A repeated terminal never rewinds retirement state.
    if (this.#retiredTurns.includes(turnId)) return;
    const current = this.#rootTurnId;
    const isCurrent = current === undefined || turnId === current;
    const isProvisional = this.#provisional?.turnId === turnId;
    // Only a confirmed question record authenticates a non-current turn's
    // terminal as that turn's retirement. A turn-only gap may come from an
    // unconfirmed old-turn replay, so it waits for the current live boundary.
    let tracked = false;
    for (const item of this.#questions.values()) {
      if (item.turnId === turnId && isUnresolved(item)) tracked = true;
    }
    // A terminal for a turn this source neither holds nor knows as current is
    // stale: it retires nothing and clears no current input knowledge.
    if (!isCurrent && !isProvisional && !tracked) return;
    const provisional = this.#provisional;
    if (provisional !== undefined && isProvisional && !isCurrent) {
      // A terminal for the held, UNCONFIRMED provisional turn is no queue
      // boundary yet: it may be a stale copy of a long ended turn. It is not
      // retirement proof, so the slot is kept and nothing else is cleared. It
      // may equally be that turn's real end, so its held questions are no
      // longer pending proof either: they become finite uncertainty that a
      // scoped reply or the current turn's live terminal still resolves. Its
      // ingestion position is kept as this slot's one bounded witness (the
      // first such terminal, so a repeat never widens it); only this exact
      // turn's own successful confirmation can later make it a boundary.
      for (const item of provisional.items.values()) invalidateQuestionItem(item);
      provisional.terminalAt ??= this.#ingested;
      if (!tracked) {
        this.#publish();
        return;
      }
    }
    this.#retireQueue(turnId, isCurrent, Number.POSITIVE_INFINITY);
    this.#publish();
  }

  /**
   * Apply the native UI's live terminal for root turn `turnId`, observed at
   * ingestion position `cutoff` (unbounded for the terminal being ingested
   * now). Only knowledge first observed BEFORE that position is covered:
   * that turn's questions retire, and when it is the current root turn's
   * terminal (`whole`) the native UI cleared its WHOLE queue, so every other
   * held question, uncertainty, and publication gap from before it retires
   * too. Questions, gaps, and uncertainty first observed after the cutoff keep
   * their own knowledge. A retirement is never reported as an answer; other
   * turns' identities stay registered and the retired-turn fence rejects the
   * turn's late replays, so nothing retired can reopen. The caller publishes.
   */
  #retireQueue(turnId: string, whole: boolean, cutoff: number): void {
    for (const [itemId, item] of [...this.#questions]) {
      if (item.turnId === turnId && item.since < cutoff) this.#questions.delete(itemId);
    }
    for (const [gapTurn, at] of [...this.#gapTurns]) {
      if ((whole || gapTurn === turnId) && at < cutoff) this.#gapTurns.delete(gapTurn);
    }
    if (whole) {
      for (const item of this.#allItems()) {
        if (item.since < cutoff) retireQuestionItem(item);
      }
      if (this.#gapUnattributedAt !== undefined && this.#gapUnattributedAt < cutoff) {
        this.#gapUnattributedAt = undefined;
      }
    }
    this.#retiredTurns.push(turnId);
    if (this.#retiredTurns.length > RETIRED_TURN_FENCE) this.#retiredTurns.shift();
  }

  #asyncInput(): NativeCodexTuiRootAsyncInput {
    let unknown = this.#gapUnattributedAt !== undefined || this.#gapTurns.size > 0;
    for (const item of this.#questions.values()) {
      if (item.pending.size > 0) return "pending";
      if (item.uncertain.size > 0 || item.gap !== undefined) unknown = true;
    }
    // Provisional questions are never pending proof: unresolved ones are unknown.
    const provisional = this.#provisional;
    if (provisional !== undefined) {
      for (const item of provisional.items.values()) {
        if (isUnresolved(item)) unknown = true;
      }
    }
    return unknown ? "unknown" : "none";
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

  /**
   * #682: the backend's own response to this generation's genuine initialize
   * (the connection fence above already matched). Recorded once; it changes no
   * published fact. A second response for the same generation is not a
   * handshake the relay can attribute, so it permanently clears the proof.
   */
  #observeBackendInitialize(event: BackendInitializeEvent): void {
    if (this.#backendVersion !== undefined) {
      this.#backendVersion = null;
      return;
    }
    const version = event.backendVersion;
    this.#backendVersion = typeof version === "string" && STABLE_VERSION.test(version) ? version : null;
  }

  #observeThreadCandidate(event: ThreadCandidateEvent): void {
    // Helper traffic is labelled by its request id and is a concurrent
    // internal, never a root; it must not withdraw a healthy ordinary root.
    if (event.requestIdKind === "native-helper") return;

    if (this.#expectedThreadId !== undefined) {
      this.#observeRestoreThreadCandidate(event, this.#expectedThreadId);
      return;
    }

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

  /**
   * Restore mode's non-helper thread candidates. Only the first resume whose
   * requested id, response id, and expected id are all B, with a parentless,
   * non-ephemeral shape, names the candidate. The candidate's queue is the one
   * already kept privately for B, so held live knowledge carries over without
   * a duplicate event.
   */
  #observeRestoreThreadCandidate(event: ThreadCandidateEvent, expected: string): void {
    if (event.origin === "thread-start") {
      // A parented or ephemeral start is child/helper structure, ignored
      // exactly as in fresh mode. A primary start is a fresh selection, which
      // a restored root never adopts.
      if (event.parentThreadId !== undefined || event.ephemeral === true) return;
      this.withdraw(
        this.#candidateThreadId !== undefined || this.#rootThreadId !== undefined
          ? "second-primary-thread-start"
          : "thread-selection-advanced",
      );
      return;
    }
    if (event.origin === "thread-fork" || this.#candidateThreadId !== undefined || this.#rootThreadId !== undefined) {
      // A fork, or any later non-helper resume (of B again, a child, or any
      // other thread), advances selection beyond the one exact restore.
      this.withdraw("thread-selection-advanced");
      return;
    }
    if (
      event.requestedThreadId !== expected
      || event.threadId !== expected
      || event.parentThreadId !== undefined
      || event.ephemeral === true
    ) {
      this.withdraw("restored-thread-mismatch");
      return;
    }
    this.#candidateThreadId = expected;
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
      this.#confirmQueueTurn(event.turnId);
      this.#trackOwnWork(event);
      this.#publish();
      return;
    }

    if (this.#rootTurnId === event.turnId) return;
    this.#confirmQueueTurn(event.turnId);
    this.#trackOwnWork(event);
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

  /* ------------------------------------------- callback facts (never published) */

  /**
   * Once a root thread is known, keep only its own pre-root stop evidence and
   * drop every other thread's. Idempotent; called before any evidence is used.
   */
  #settleProvisionalStop(): void {
    if (this.#provisionalStop.size === 0) return;
    const thread = this.#queueThread();
    if (thread === undefined) return;
    const own = this.#provisionalStop.get(thread);
    if (own !== undefined) this.#foldStop(own);
    this.#provisionalStop.clear();
  }

  #foldStop(evidence: CallbackStopEvidence): void {
    this.#rootStop.stopped = Math.max(this.#rootStop.stopped, evidence.stopped);
    this.#rootStop.unknown = Math.max(this.#rootStop.unknown, evidence.unknown);
  }

  /**
   * The stop evidence scope for traffic naming `threadId`: the root's when it
   * names the known root thread or no readable thread at all (it may be the
   * root's), nothing for a sibling once the root thread is known, and a
   * bounded per-thread entry before then. An evicted entry is folded into the
   * root's evidence: overflow loses scoping, never a stop.
   */
  #stopScope(threadId: string | undefined): CallbackStopEvidence | undefined {
    const thread = this.#queueThread();
    if (thread !== undefined) return threadId === undefined || threadId === thread ? this.#rootStop : undefined;
    if (threadId === undefined) return this.#rootStop;
    let scope = this.#provisionalStop.get(threadId);
    if (scope === undefined) {
      scope = noStopEvidence();
      this.#provisionalStop.set(threadId, scope);
      if (this.#provisionalStop.size > CALLBACK_EVIDENCE_FENCE) {
        const [oldestThread, oldest] = this.#provisionalStop.entries().next().value as [string, CallbackStopEvidence];
        this.#provisionalStop.delete(oldestThread);
        this.#foldStop(oldest);
      }
    }
    return scope;
  }

  #addStop(scope: CallbackStopEvidence, level: "stopped" | "unknown", at: number): void {
    if (level === "stopped") scope.stopped = Math.max(scope.stopped, at);
    else scope.unknown = Math.max(scope.unknown, at);
  }

  #rememberEnded(key: string, status: TurnTerminalStatus): void {
    this.#endedTurns.delete(key);
    this.#endedTurns.set(key, status);
    if (this.#endedTurns.size > CALLBACK_EVIDENCE_FENCE) {
      const oldest = this.#endedTurns.keys().next();
      if (!oldest.done) this.#endedTurns.delete(oldest.value);
    }
  }

  /**
   * This connection's own successful root `turn/start` began own work. Stop
   * evidence is cleared only up to the request's own relay position; without
   * one, nothing is cleared. A turn that already ended is never made busy
   * again, and the reply names the CURRENT turn only when its request is newer
   * than the latest lifecycle evidence and the latest own request; otherwise,
   * unless it names the turn already busy, activity is unknown.
   */
  #trackOwnWork(event: TurnWorkTargetEvent): void {
    this.#settleProvisionalStop();
    const after = event.requestAfterSequence;
    const previousOwnWork = this.#ownWorkAfter;
    const ordered = typeof after === "number"
      && Number.isSafeInteger(after)
      && after >= 0
      && after < event.sequence;
    if (ordered) this.#ownWorkAfter = Math.max(previousOwnWork, after);
    if (this.#endedTurns.has(terminalKey(event.threadId, event.turnId))) return;
    const active = this.#activity;
    if (active.state === "busy" && active.turnId === event.turnId) return;
    if (!ordered || after < this.#activityEvidenceAt || after <= previousOwnWork) {
      this.#activity = UNKNOWN_ACTIVITY;
      this.#activityEvidenceAt = evidenceSequence(event);
      return;
    }
    this.#activity = Object.freeze({ state: "busy" as const, turnId: event.turnId });
  }

  #trackTurnStarted(event: TurnStartedEvent): void {
    this.#settleProvisionalStop();
    const thread = this.#queueThread();
    if (thread === undefined || event.threadId !== thread) return;
    if (this.#endedTurns.has(terminalKey(event.threadId, event.turnId))) return;
    this.#activityEvidenceAt = evidenceSequence(event);
    this.#activity = Object.freeze({ state: "busy" as const, turnId: event.turnId });
  }

  #trackTurnTerminal(event: TurnTerminalEvent): void {
    this.#settleProvisionalStop();
    const thread = this.#queueThread();
    const scope = this.#stopScope(event.threadId);
    if (scope === undefined) return; // Sibling, helper, or child.
    const turnId = event.turnId;
    const key = terminalKey(event.threadId, turnId);
    const prior = this.#endedTurns.get(key);
    // An exact replay is not new evidence and never re-stops or rewinds.
    if (prior === event.status) return;
    const at = evidenceSequence(event);
    if (thread !== undefined) this.#activityEvidenceAt = at;
    if (prior !== undefined) {
      // A conflicting terminal for an ended turn: contradictory evidence is
      // never "none". Activity already moved on this turn's first terminal.
      this.#addStop(scope, event.status === "interrupted" ? "stopped" : "unknown", at);
      this.#rememberEnded(key, event.status);
      return;
    }
    if (event.status === "interrupted") this.#addStop(scope, "stopped", at);
    else if (event.status === "failed") this.#addStop(scope, "unknown", at);
    if (thread !== undefined) {
      const active = this.#activity;
      if (active.state === "busy" && active.turnId === turnId) {
        this.#activity = Object.freeze({ state: "idle" as const, lastTurnId: turnId });
      } else if (active.state !== "busy") {
        // A root turn this source never saw active has ended: activity was missed.
        this.#activity = UNKNOWN_ACTIVITY;
      }
    }
    this.#rememberEnded(key, event.status);
  }

  #trackInterruptRequest(event: TurnInterruptRequestEvent): void {
    this.#settleProvisionalStop();
    const scope = this.#stopScope(event.threadId);
    if (scope === undefined) return; // A sibling's, helper's, or child's stop.
    // A stop naming a thread is that thread's stop (whichever turn it names);
    // one naming no readable thread only may be the root's.
    this.#addStop(scope, event.threadId === undefined ? "unknown" : "stopped", evidenceSequence(event));
  }

  #trackLifecycleUnreadable(event: TurnLifecycleUnreadableEvent): void {
    this.#settleProvisionalStop();
    const scope = this.#stopScope(event.threadId);
    if (scope === undefined) return;
    if (this.#queueThread() !== undefined) {
      this.#activity = UNKNOWN_ACTIVITY;
      this.#activityEvidenceAt = evidenceSequence(event);
    }
    // An unreadable completion may have hidden a stop.
    if (event.method === "turn/completed") this.#addStop(scope, "unknown", evidenceSequence(event));
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
      const closeReason = this.#closeReason;
      return Object.freeze({
        phase: "withdrawn" as const,
        ...(connectionId === undefined ? {} : { connectionId }),
        withdrawal: this.#withdrawn,
        ...(closeReason === undefined ? {} : { closeReason }),
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
        asyncInput: this.#asyncInput(),
      });
    }
    const candidateThreadId = this.#candidateThreadId;
    if (candidateThreadId !== undefined) {
      // No root thread id or tool is published for a candidate. Its owner-only
      // fresh binding is named only when the whole fresh proof short of the
      // first own turn is positively known.
      const fresh = this.#attestedEmpty && connectionId !== undefined;
      return Object.freeze({
        phase: "candidate" as const,
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(fresh ? { candidateThreadId, asyncInput: this.#asyncInput() } : {}),
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
    && a.candidateThreadId === b.candidateThreadId
    && a.asyncInput === b.asyncInput
    && a.withdrawal === b.withdrawal
    && a.closeReason === b.closeReason
    && sameTool(a.tool, b.tool);
}

const GENERATION_CLOSE_REASONS: ReadonlySet<string> = new Set<NativeCodexTuiRelayGenerationCloseReason>([
  "client-closed",
  "backend-closed",
  "backend-handshake-rejected",
  "handshake-timeout",
  "preflight-overflow",
  "relay-stopped",
]);

function isGenerationCloseReason(value: unknown): value is NativeCodexTuiRelayGenerationCloseReason {
  return typeof value === "string" && GENERATION_CLOSE_REASONS.has(value);
}

function sameTool(a: NativeCodexTuiRootToolFact | undefined, b: NativeCodexTuiRootToolFact | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.itemId === b.itemId
    && a.category === b.category
    && a.phase === b.phase
    && a.turnId === b.turnId;
}
