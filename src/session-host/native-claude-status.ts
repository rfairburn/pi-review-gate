/**
 * Pure Claude Code native foreground/question/activity reducer (native Claude
 * sidebar status source phase).
 *
 * This module turns already-parsed, already-owned Claude Code hook lifecycle
 * payloads into the sidebar foreground slice a host may publish: root-foreground
 * busy, pending-input presence for actual observed question requests, and the
 * current/last tool TYPE label. It performs no IO of any kind: no transport, no
 * hook registration, no process, filesystem, config, or provider work. The
 * owning hook-source adapter (a separate phase) binds each payload to the exact
 * owned PTY incarnation and decides which capability it can declare; this
 * reducer only reduces what a payload positively states.
 *
 * Source basis (installed Claude Code 2.1.325 hook envelope, read from the
 * shipped binary): every hook payload carries `session_id`, `cwd`,
 * `hook_event_name`, and optional `agent_id`/`prompt_id`; `UserPromptSubmit` is
 * a real accepted turn, `Stop`/`StopFailure` are turn-end BOUNDARIES THIS
 * OBSERVER CANNOT PROVE FINAL (another operator `Stop` hook may block and
 * continue the same turn, and this observer registering its own hook with
 * `onFailure: "continue"` does not change that), `PreToolUse`/`PostToolUse`/
 * `PostToolUseFailure` share one `tool_use_id` request identity, and
 * `SessionStart`/`SessionEnd` bound a native session scope. `PreToolUse` for
 * `AskUserQuestion` is a pending QUESTION REQUEST, not proof that a
 * human-visible dialog was painted (a classifier can gate it), and the matching
 * `Post*` closes the request irrespective of whether any answer is present.
 *
 * Honesty rules this module enforces:
 * - Unknown is the initial state. A recognized payload whose own fields cannot
 *   be read withdraws exactly the observations that payload would have
 *   supported (foreground, or the pending-request census) instead of leaving a
 *   stale Ready, running, or "none remain" claim in place.
 * - Nothing here fabricates a Ready/idle claim from a process that merely looks
 *   quiet, from missing data, from quiet output, or from the arrival of this
 *   observer's own `Stop` hook. A `Stop` or `StopFailure` boundary makes the
 *   foreground unverifiable; {@link NativeClaudeStatusReducer.confirmTurnEnd},
 *   driven by a terminal record the source actually read, establishes
 *   `busy: false` and `Ready` for a turn that ran. The only idle claim made
 *   BEFORE any prompt is the one the run's own owner is entitled to make about a
 *   process it launched itself
 *   ({@link NativeClaudeStatusReducer.observeOwnedStartup}) or restates from a
 *   `startup`/`clear` boundary once it has read that source and found nothing
 *   recorded in it ({@link NativeClaudeStatusReducer.confirmFreshStart}).
 *   {@link NativeClaudeTurnEndConfirmation} states the source-grounded
 *   rootness, sufficiency, and binding rules the acquisition layer must satisfy;
 *   this module never tails a transcript, reconstructs a census, or ranks source
 *   records against each other.
 * - A definitive question census yields `pendingInput: false` only for a scope a
 *   genuine root `SessionStart` with a readable identity established as fully
 *   observed: that same boundary vouches the census EMPTY (no request can have
 *   opened before this scope began), and it stays false while this reducer can
 *   vouch that no observed request remains open. A scope adopted mid-stream or
 *   released by invalidation keeps that claim unknown. A root request that was
 *   still open when a CONFIRMED root turn end was read ended with that turn: the
 *   provider stated the turn over, so nothing is awaiting input any more, and the
 *   census stays definitive instead of being stranded as unknown forever.
 * - A brand-new scope can also be shown IDLE before its first prompt, but only on
 *   two facts the caller actually has: the provider's own `SessionStart` said
 *   `source` is `startup` or `clear` (the closed values for a new owned startup
 *   and `/clear`, never `resume`, `compact`, `fork`, or an unreadable value), and
 *   the caller then positively read the bound source and found NO prerecorded
 *   work. {@link NativeClaudeStatusReducer.confirmFreshStart} is that second
 *   half; without it the fresh scope keeps an unknown foreground exactly as before.
 *   A host that launched the process itself needs no such read: it states the
 *   empty baseline from its own spawn, and that vouch is what lets the provider's
 *   later `SessionStart` rebind the scope without blinking the row through
 *   unknown. Either way the claim dies the moment real work is observed.
 * - A question request also terminates when the source shows its OWN persisted
 *   `tool_result` for that exact `tool_use_id` — the shape a declined or
 *   cancelled question leaves behind when no `Post*` hook ever arrived. That
 *   closure reads the request identity only: no answer, annotation, error text,
 *   or result content is ever read, retained, or compared.
 * - A root question request that is still open is the provider stopped on input:
 *   the PUBLISHED foreground is `busy: false` beside `pendingInput: true`, the same
 *   stopped-on-input foreground the host uses for any session waiting on a human,
 *   while the observed turn underneath it is kept — so closing the request returns
 *   the running foreground instead of a stale `Ready` or a turn end this source
 *   never saw. The claim is qualified to that ONE request and the prompt it stands
 *   in: it is never armed while another root tool request is still open (that is
 *   work demonstrably in flight), it ends with its own request, and a request from
 *   an earlier prompt that stays open cannot keep the row looking paused. Newer
 *   root work or a turn-end boundary ends it at once, and a subagent's question
 *   never blocks the root foreground. A stopped-on-input foreground is not an IDLE
 *   claim: `idleForegroundPublished()` is the only answer to "can newer root work
 *   contradict this?", and newer root work withdraws the foreground while keeping
 *   every open request's identity for its own close edge.
 * - Only the tool TYPE is retained. Tool arguments, commands, results, question
 *   text, answers, annotations, and transcripts are never read into state, and
 *   the fixed labels reuse the existing `Working`/`Ready` convention.
 * - Subagent-scoped events never mark the root foreground Ready, never rebind
 *   or bind the root scope, and never replace root tool activity — including an
 *   accepted subagent question request, which stays foreground-neutral. An
 *   accepted root question request IS positively observed root tool work, so it
 *   establishes running without replacing an existing last-tool label. A question
 *   request observed in an actual subagent context stays pending on its own
 *   edges, including across a root turn end.
 * - The snapshot carries no ownership or activity counts: this reducer never
 *   synthesizes a task/shell count from lifecycle transitions, and it declares
 *   no capability. The future source adapter declares capability from what its
 *   actual source supports.
 * - Session and prompt correlation here is reduction hygiene only. It is not
 *   proof of a Pi conversation identity, and no global event ordering or
 *   sequence proof is invented or implied: an event that conflicts with the
 *   session or prompt this reducer positively observed is rejected rather than
 *   ranked against it. A question closure is correlated against its own recorded
 *   request, so a request observed during an earlier prompt still closes
 *   correctly once a newer prompt is the current foreground.
 */

import { isRecord } from "../record-guard";
import type { InstanceStatusUpdate } from "./instances";
import { sanitizeActivityLine } from "./protocol";

/**
 * The foreground slice this provider observation covers. It is a structural
 * Pick of the existing status update rather than a parallel all-fields shape,
 * so the host sink accepts it unchanged and any count, capability, or surface
 * field stays owned by the source adapter that can actually support it.
 */
export type NativeClaudeForegroundObservation = Pick<
  InstanceStatusUpdate,
  "busy" | "pendingInput" | "activity"
>;

/** Stable, payload-free reason code for one reduce outcome. */
export type NativeClaudeReduceReason =
  | "scope-rebound"
  | "scope-rebound-unidentified"
  | "scope-ended"
  | "turn-submitted"
  | "turn-end-candidate"
  | "turn-ended-confirmed"
  | "turn-failed"
  | "non-root-terminal-record"
  | "terminal-record-inconclusive"
  | "duplicate-terminal-record"
  | "unbound-terminal-record"
  | "question-request-open"
  | "question-request-closed"
  | "tool-type-observed"
  | "tool-completed"
  | "question-block-resumed"
  | "subagent-scope"
  | "stale-session"
  | "stale-prompt"
  | "unbound-session"
  | "scope-closed"
  | "unsupported-event"
  | "duplicate-question-open"
  | "duplicate-question-close"
  | "duplicate-tool-close"
  | "stale-tool-close"
  | "tool-close-unobserved"
  | "malformed-envelope"
  | "malformed-scope"
  | "tool-name-unavailable"
  | "tool-close-unidentified"
  | "question-request-unidentified"
  | "question-close-unidentified"
  | "question-close-unobserved"
  | "question-close-prompt-mismatch"
  | "question-census-capacity"
  | "question-tool-result-unobserved"
  | "fresh-start-confirmed"
  | "fresh-start-superseded"
  | "startup-baseline"
  | "startup-baseline-superseded"
  | "duplicate-session-start";

/**
 * Explicit reduce outcome, so a caller never republishes a stale ignored event
 * as a fresh observation:
 * - `applied`: the event positively changed state; `snapshot` is the new value.
 * - `ignored`: nothing was claimed from it (unrelated kind, stale session or
 *   prompt correlation, or a duplicate edge); NO snapshot is returned and none
 *   must be submitted.
 * - `invalid`: a recognized event kind arrived with unusable payload, so the
 *   observations that payload would have supported are withdrawn as
 *   unverifiable; `snapshot` is the degraded value (never a fabricated zero,
 *   none, or Ready).
 */
export type NativeClaudeReduceResult =
  | {
      readonly outcome: "applied";
      readonly reason: NativeClaudeReduceReason;
      readonly snapshot: NativeClaudeForegroundObservation;
    }
  | { readonly outcome: "ignored"; readonly reason: NativeClaudeReduceReason }
  | {
      readonly outcome: "invalid";
      readonly reason: NativeClaudeReduceReason;
      readonly snapshot: NativeClaudeForegroundObservation;
    };

/**
 * The persisted root stop-hook summary fields a source actually read, in the
 * camelCase shape the native record stores them in. Only emptiness and the
 * boolean outcome are observed: hook error and additional-context CONTENT is
 * never read, retained, or copied into any observation.
 */
export interface NativeClaudeTerminalRecord {
  /** `hook_event_name` of the summary record, when the source read one. */
  readonly hookEventName?: string | null;
  /** `hookLabel` of the summary record; absent or `Stop` may identify root completion. */
  readonly hookLabel?: string | null;
  /** `isSidechain`: a sidechain summary never closes the root foreground. */
  readonly isSidechain?: boolean | null;
  /** `agentId`: an agent-scoped summary never closes the root foreground. */
  readonly agentId?: string | null;
  /** `preventedContinuation`: true means the root turn actually ENDS. */
  readonly preventedContinuation?: boolean | null;
  /** `hookErrors`: nonempty is genuinely undecidable, never terminal. */
  readonly hookErrors?: readonly unknown[] | null;
  /** `hookAdditionalContext`: nonempty can continue the same turn. */
  readonly hookAdditionalContext?: readonly unknown[] | null;
}

/**
 * The caller's corroboration that the fresh root `SessionStart` this scope came
 * from really began a brand-new conversation. This reducer cannot look at a
 * transcript, so the adapter that owns the source read states the fact here;
 * nothing in this type carries record text, paths, or provider content.
 */
export interface NativeClaudeFreshStartConfirmation {
  /** Native session identity the corroborated start belongs to, when read. */
  readonly sessionId?: string | null;
  /** Caller-attested identity of the read that corroborated this start. */
  readonly sourceToken?: string | null;
}

/**
 * A persisted `tool_result` the caller positively read for one exact native tool
 * request identity, in this run's own ROOT conversation. Only the identity
 * travels: an answer, an error message, a result body, and any other record
 * field stay in the source, and a decline is never distinguished from an answer
 * because this reducer makes no outcome claim from either.
 */
export interface NativeClaudeQuestionToolResult {
  /** The `tool_use_id` of the persisted tool_result row. */
  readonly requestId: string;
  /** Native session identity the row was read from, when the row carried one. */
  readonly sessionId?: string | null;
}

/**
 * A source-confirmed terminal record for the root turn. The caller supplies it
 * only from actual terminal metadata it read, never from the arrival of this
 * observer's own `Stop` hook, and only with the correlation it actually read.
 *
 * Exact binding requirements for acquisition (this reducer cannot verify them,
 * it only refuses what conflicts with what it observed):
 * 1. Read the persisted root `stop_hook_summary` record, which is emitted AFTER
 *    all hook decisions for that turn. Never treat this observer's own `Stop`
 *    hook delivery as terminal: another operator's hook can block and continue
 *    the same turn.
 * 2. Only the root summary qualifies: filter out sidechain, `agentId`-scoped,
 *    and records labelled other than `Stop`, so a `SubagentStop` or `PreToolUse`
 *    summary can never close the root foreground. An absent `hookLabel` or
 *    exactly `"Stop"` identifies the root turn-end summary.
 * 3. Sufficiency is `preventedContinuation === true`, OR
 *    `preventedContinuation === false` together with an empty `hookErrors`
 *    array and an absent or empty `hookAdditionalContext`. Nonempty
 *    `hookErrors` mixes blocking and nonblocking outcomes and is genuinely
 *    undecidable; a bare `false` is not terminal, and missing fields are not
 *    treated as empty. `hasOutput` is never a continuation signal and is not
 *    part of this contract. A persisted block-cap informational warning row that
 *    the provider used to force the turn closed is an equally valid terminal
 *    witness on the caller-attestation path (omit `summary` and pass the
 *    binding), because the reducer only judges a summary it is handed.
 * 4. Bind the claim. Pass the record's own `promptId` plus the caller's
 *    attested `sourceToken` — the identity of the source read this reducer's
 *    state belongs to (for example the owned child/incarnation plus the
 *    transcript read position or observer epoch). A late persisted summary from
 *    an older root prompt must never overwrite newer hook work; only real
 *    prompt/turn binding or a caller-attested source token can prevent that, so
 *    a confirmation that carries neither is refused while root work is live. A
 *    timestamp is never native conversation attestation and is not accepted as
 *    a binding here.
 * 5. `turn_duration` and other runner-end records are LATER confirmations that
 *    may be deferred for background work and are absent on abort. Terminality is
 *    never inferred from their absence.
 */
export interface NativeClaudeTurnEndConfirmation {
  /** Native session identity the terminal record belongs to, when read. */
  readonly sessionId?: string | null;
  /** Prompt correlation of the terminal record, when read. */
  readonly promptId?: string | null;
  /** Caller-attested identity of the source read this confirmation belongs to. */
  readonly sourceToken?: string | null;
  /**
   * The persisted summary fields actually read. Omitting it is the explicit
   * caller attestation path: the caller states it has already applied the
   * rootness and sufficiency rules above for the current root turn.
   */
  readonly summary?: NativeClaudeTerminalRecord | null;
}

/** Existing sidebar running label (no tool type claimed). */
const WORKING_ACTIVITY = "Working";
/** Existing sidebar idle label, emitted only for a confirmed root turn end. */
const READY_ACTIVITY = "Ready";
/** Lowercased native question-tool type; matches the shipped AskUserQuestion tool name. */
const QUESTION_TOOL_TYPE = "askuserquestion";

/**
 * The closed `SessionStart.source` values that positively state a brand-new
 * scope. `resume`, `compact`, and `fork` all continue a conversation that
 * already has history, and an absent or unreadable source states nothing, so
 * none of them may idle a row or zero its counts.
 */
const FRESH_START_SOURCES: ReadonlySet<string> = new Set(["startup", "clear"]);

/**
 * Whether one `SessionStart.source` value positively names a new owned startup
 * or a `/clear`. Exported so the adapter that corroborates the claim in the
 * bound source and this reducer judge the same closed value once.
 */
export function isNativeClaudeFreshStartSource(value: unknown): boolean {
  const token = readToken(value);
  return token !== null && FRESH_START_SOURCES.has(token);
}

/** A tool TYPE is a short identifier; anything longer is not claimed as one. */
const MAX_TOOL_TYPE_CHARS = 64;
/**
 * Generic identifier shape for a claimable tool TYPE. This is an allowlist for
 * the one field this module retains, not a provider denylist: a name carrying
 * whitespace, a path, or command text simply gets no label.
 */
const TOOL_TYPE_PATTERN = /^[a-z][a-z0-9_.$:-]*$/;

/** Bounded question census; overflow degrades the census, it never drops silently. */
const MAX_TRACKED_QUESTION_REQUESTS = 32;
/** Bounded memory for "this request already closed" so duplicates read as duplicates. */
const MAX_REMEMBERED_CLOSED_REQUESTS = 32;
/** Bounded per-turn tool request ledger; eviction only ever degrades to unknown. */
const MAX_TRACKED_TOOL_REQUESTS = 64;

/**
 * Event kinds that can carry a root foreground or question observation, and so
 * may establish the root session binding. `SessionEnd` is known but never
 * adoptable: ending a session this reducer never bound says nothing about it.
 */
const ADOPTABLE_EVENTS: ReadonlySet<string> = new Set([
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);
const KNOWN_EVENTS: ReadonlySet<string> = new Set([...ADOPTABLE_EVENTS, "SessionEnd"]);

type ObservedScope = "root" | "subagent";

interface ObservedQuestionRequest {
  readonly scope: ObservedScope;
  /** The request identity this reducer holds open, as the provider named it. */
  readonly requestId: string;
  /** Prompt id positively carried by the open edge, when any. */
  readonly promptId: string | null;
}

/**
 * Reduces observed Claude Code hook payloads into the foreground slice.
 *
 * State is per observed native session scope. One instance observes exactly one
 * owned row; the caller owns binding, and this class owns only the honest
 * interpretation of what it is handed.
 */
export class NativeClaudeStatusReducer {
  /** Observed root native session id, or null when no scope is established. */
  #scope: string | null = null;
  /**
   * True only when a genuine root `SessionStart` with a readable identity
   * established the current scope, which is the only boundary that can show the
   * question census was observed from its beginning. An adopted or invalidated
   * scope never claims a definitive "none remain".
   */
  #scopeFullyObserved = false;
  /** True after an observed root SessionEnd: only a new SessionStart rebinds. */
  #scopeClosed = false;
  /**
   * Which lane last established the current foreground claim. `observed` means
   * this run's own lifecycle lane or the host's own launch of it (including a
   * corroborated fresh start); `transcript` means a terminal record read out of
   * the bound transcript file. A lane that fails may only withdraw a claim its
   * own lane supported, which is what keeps an unrelated transcript loss from
   * destroying hook-derived state.
   */
  #foregroundOrigin: "observed" | "transcript" | null = null;
  /**
   * True while a genuine fresh root `SessionStart` (a `startup` or `clear` with a
   * readable identity) awaits the caller's corroboration that the bound source
   * shows no prerecorded work. Any observed root work clears it, so a start that
   * arrives late can never idle a live turn.
   */
  #freshStartPending = false;
  /**
   * True while the host's own launch of this run vouches that nothing has run in
   * it yet. It is what lets a later `SessionStart` — the provider's own start
   * notice, or a `/clear` or `/resume` typed into an idle row — rebind its scope
   * without blinking the row through unknown, and any observed work ends the
   * vouch immediately.
   */
  #startupVouched = false;
  /** Prompt correlation of the root turn this reducer last positively observed. */
  #rootPromptId: string | null = null;
  /** Root foreground busy; null means unknown, never a silent idle claim. */
  #busy: boolean | null = null;
  /**
   * The request this run is currently stopped on, if any: its identity and the
   * prompt it was opened in. Qualified rather than global, because "waiting" is a
   * claim about ONE request being the provider's current block — not about the
   * conversation having asked something at some point. It is never armed while a
   * non-question root tool request is still open (that is root work demonstrably
   * in flight), and it is dropped the moment its own request closes, a newer root
   * prompt or root tool arrives, or any turn-end or withdrawal boundary lands.
   * An OLDER request that stays open after this one closed therefore cannot keep
   * the row looking paused.
   */
  #blockingQuestion: { readonly key: string; readonly promptId: string | null } | null = null;
  /**
   * The most recently accepted ROOT question request, remembered while it stays
   * open. A root request that opened over in-flight tool work cannot block the
   * foreground then, but the close of that work can be the fact that leaves the
   * provider waiting on it, so the request is kept here for that moment. It is
   * dropped when the request itself closes and at every boundary that ends the
   * stopped-on-input claim, so an older turn's request never arms a later pause.
   */
  #waitingQuestionKey: string | null = null;
  /** Bounded activity lines: a tool TYPE, `Working`, `Ready`, or empty. */
  #activity: readonly string[] = [];
  /** Request identity of the most recent root tool request in this turn. */
  #lastToolId: string | null = null;
  /** Root tool requests seen in this turn, so an older or repeat close is not news. */
  #toolRequests = new Map<string, "open" | "closed">();
  /** Open question requests, keyed by scope plus request identity. */
  #openQuestions = new Map<string, ObservedQuestionRequest>();
  /** Recently closed request keys, bounded, so a repeat close is not news. */
  #closedRequests: string[] = [];
  /**
   * True once the question census for this scope has an unobservable hole
   * (untrackable edge, unobserved or conflicting close, capacity overflow, or a
   * request that ended without a definitive close). While set, `pendingInput`
   * never claims a definitive false for this scope.
   */
  #censusIncomplete = false;
  /**
   * True only while every question request this scope could have opened is
   * positively known not to be open: either a genuine root `SessionStart`
   * established the census empty at its beginning, or a definitive close left
   * every observed request closed.
   */
  #closureVouched = false;
  /**
   * Caller-attested identity of the last accepted terminal read, so re-reading
   * the same persisted summary is idempotent. It carries no ordering meaning:
   * this reducer never ranks tokens against each other.
   */
  #terminalToken: string | null = null;

  /**
   * Current observation. Always a complete snapshot: unknown fields are the
   * explicit nulls the host sink normalizes, never an omitted "nothing".
   */
  snapshot(): NativeClaudeForegroundObservation {
    return {
      busy: this.#publishedBusy(),
      pendingInput: this.#pendingInput(),
      activity: [...this.#activity],
    };
  }

  /**
   * The foreground the host is told about: the observed turn, except that the one
   * question request this run is stopped on is reported as stopped-on-input rather
   * than running. Only the published value changes, so closing that request
   * returns exactly the foreground observed underneath it — never a stale `Ready`,
   * and never a turn end or an idle claim this source did not see.
   */
  #publishedBusy(): boolean | null {
    return this.questionBlocksForeground() ? false : this.#busy;
  }

  /**
   * True while the published foreground is the stopped-on-input projection: one
   * accepted root request, in the prompt it stands in, is what the provider is
   * waiting on. A caller that has to decide what newer ROOT work can contradict
   * needs this distinct from `idleForegroundPublished()` — a paused turn and an
   * idle conversation are different claims, and a new root row proves only that
   * the pause is over.
   */
  questionBlocksForeground(): boolean {
    const blocking = this.#blockingQuestion;
    if (blocking === null || !this.#openQuestions.has(blocking.key)) return false;
    return blocking.promptId === null || this.#rootPromptId === blocking.promptId;
  }

  /**
   * True only while the published `busy: false` is a genuine IDLE claim: a
   * source-read terminal record, a corroborated fresh start, or the host's own
   * launch baseline. A `false` published because a question request stands is a
   * turn paused on a human, not a conversation at rest, and a caller watching for
   * what can contradict an idle claim must not treat it as one.
   */
  idleForegroundPublished(): boolean {
    return this.#busy === false;
  }

  /**
   * Newer ROOT work this run's own source positively shows, with nothing from the
   * hook lane to describe it. Every foreground claim made for the previous state
   * is withdrawn as unverifiable, along with any stopped-on-input projection —
   * the provider is doing something else. The scope and its open question
   * requests SURVIVE: a newer turn says nothing about whether an earlier request
   * closed, so that request stays pending until its own close edge lands.
   */
  noteRootWorkBeyondClaims(): NativeClaudeForegroundObservation {
    this.#busy = null;
    this.#activity = [];
    this.#blockingQuestion = null;
    this.#waitingQuestionKey = null;
    this.#foregroundOrigin = null;
    this.#freshStartPending = false;
    this.#startupVouched = false;
    // The prompt this reducer last observed is no longer the conversation's
    // current one: the file shows work that started without this run's hook lane
    // saying a word, and the prompt it started with was never seen. Holding the
    // old correlation would refuse the new turn's own boundary as stale.
    this.#rootPromptId = null;
    this.#clearTurnToolState();
    return this.snapshot();
  }

  /**
   * Withdraw every supported observation as unverifiable — for a confirmed
   * hook-stream gap, a lost child, or caller-side invalidation. Scope is
   * released so a genuinely new session is adopted on its next eligible event;
   * nothing is relabeled idle, clear, or zero.
   */
  invalidate(): NativeClaudeForegroundObservation {
    this.#resetScope(null);
    return this.snapshot();
  }

  /**
   * The host's own baseline for a native run it launched itself and has given no
   * input: this process exists, nothing has run in it, so its foreground is idle
   * and its question census begins here empty. This is the ONE idle claim not
   * built from a provider payload or a record — its evidence is that the caller
   * owns the spawn, and it is therefore refused the moment anything has been
   * observed (an accepted prompt, a tool request, an open question, a prompt
   * correlation, or an ended scope), so a baseline that arrives late over real
   * work changes nothing. It never invents a session identity, and a later
   * `SessionStart`, prompt, or count source replaces it with provider evidence.
   */
  observeOwnedStartup(): NativeClaudeReduceResult {
    if (this.#scopeClosed) return { outcome: "ignored", reason: "scope-closed" };
    if (this.#workObserved()) return { outcome: "ignored", reason: "startup-baseline-superseded" };
    this.#startupVouched = true;
    // The census genuinely begins with this process: no request can have opened
    // before it. An observation hole this reducer already reported survives.
    this.#scopeFullyObserved = true;
    this.#closureVouched = !this.#censusIncomplete;
    this.#freshStartPending = false;
    this.#busy = false;
    this.#activity = [READY_ACTIVITY];
    this.#foregroundOrigin = "observed";
    return { outcome: "applied", reason: "startup-baseline", snapshot: this.snapshot() };
  }

  /**
   * Whether this reducer has positively observed anything run in this scope: the
   * only state a startup baseline may still overwrite is a scope that has shown
   * nothing at all.
   */
  #workObserved(): boolean {
    return this.#busy === true
      || this.#rootPromptId !== null
      || this.#openQuestions.size > 0
      || this.#toolRequests.size > 0;
  }

  /**
   * Withdraw ONLY the foreground claim a source-confirmed turn end established,
   * for a loss of the lane that supported it (a bound transcript this adapter can
   * no longer read). A hook-payload claim — running, a tool TYPE, a corroborated
   * fresh-start idle — is not contradicted by a file this observer cannot read,
   * so it stays; the scope binding, prompt correlation, tool ledger, and question
   * census are hook-lane observations and are never released here. That is what
   * keeps a transcript gap from costing the pending-input census until the next
   * `SessionStart`.
   */
  withdrawTranscriptForeground(): NativeClaudeForegroundObservation {
    if (this.#foregroundOrigin === "transcript") {
      this.#busy = null;
      this.#activity = [];
      this.#foregroundOrigin = null;
    }
    return this.snapshot();
  }

  /**
   * Corroborate a fresh root `SessionStart` this scope is still holding: the
   * caller read its own bound source and found no prerecorded work, so the
   * brand-new conversation is positively idle before its first prompt. This is
   * the only input that can establish `busy: false` with no observed turn: a
   * start whose source is not `startup`/`clear`, a scope adopted mid-stream, a
   * closed scope, another native conversation, or a scope where root work was
   * already observed are all refused, and a refusal changes nothing.
   */
  confirmFreshStart(confirmation: NativeClaudeFreshStartConfirmation = {}): NativeClaudeReduceResult {
    const sessionId = readToken(confirmation.sessionId);
    if (this.#scopeClosed) return { outcome: "ignored", reason: "scope-closed" };
    if (sessionId !== null && this.#scope !== null && sessionId !== this.#scope) {
      return { outcome: "ignored", reason: "stale-session" };
    }
    if (!this.#freshStartPending || this.#busy === true) {
      return { outcome: "ignored", reason: "fresh-start-superseded" };
    }
    this.#freshStartPending = false;
    this.#busy = false;
    this.#activity = [READY_ACTIVITY];
    // The idle claim is the provider's own `SessionStart` statement, corroborated
    // by one read of its source: a later transcript gap does not contradict it.
    this.#foregroundOrigin = "observed";
    return { outcome: "applied", reason: "fresh-start-confirmed", snapshot: this.snapshot() };
  }

  /**
   * The ROOT-scoped question request identities this reducer currently holds
   * open, so a source adapter can tell whether a persisted `tool_result` row it
   * just read can terminate one of them. Identities only: no question text,
   * answer, prompt correlation, or scope detail crosses.
   */
  openQuestionRequestIds(): readonly string[] {
    const ids: string[] = [];
    for (const request of this.#openQuestions.values()) {
      if (request.scope === "root") ids.push(request.requestId);
    }
    return ids;
  }

  /**
   * Close an open ROOT question request on the source's own persisted
   * `tool_result` for that exact request identity — the terminal evidence a
   * declined, cancelled, or answered question leaves when no `PostToolUse` or
   * `PostToolUseFailure` edge ever reached this observer. The closure is the
   * identity match alone: nothing about the result is read, so no answered
   * outcome is fabricated and no English phrase is matched. A `tool_result` for
   * an identity this reducer never opened as a root question is some other tool's
   * result and is refused without degrading the census; a subagent-scoped request
   * is never closed from the root conversation.
   */
  observeQuestionToolResult(observation: NativeClaudeQuestionToolResult): NativeClaudeReduceResult {
    const requestId = readToken(observation?.requestId);
    if (requestId === null) return { outcome: "ignored", reason: "question-close-unidentified" };
    if (this.#scopeClosed) return { outcome: "ignored", reason: "scope-closed" };
    const sessionId = readToken(observation.sessionId);
    if (sessionId !== null && this.#scope !== null && sessionId !== this.#scope) {
      return { outcome: "ignored", reason: "stale-session" };
    }
    const key = requestKey("root", requestId);
    if (!this.#openQuestions.has(key)) {
      if (this.#closedRequests.includes(key)) return { outcome: "ignored", reason: "duplicate-question-close" };
      return { outcome: "ignored", reason: "question-tool-result-unobserved" };
    }
    this.#openQuestions.delete(key);
    this.#rememberClosed(key);
    if (this.#blockingQuestion?.key === key) this.#blockingQuestion = null;
    if (this.#waitingQuestionKey === key) this.#waitingQuestionKey = null;
    this.#closureVouched = this.#openQuestions.size === 0 && !this.#censusIncomplete;
    return { outcome: "applied", reason: "question-request-closed", snapshot: this.snapshot() };
  }

  /**
   * Apply a source-confirmed terminal record for the root turn. This is the only
   * input that establishes `busy: false` and `Ready`: an operator `Stop` hook
   * can block and continue the same turn, so this observer's own `Stop` hook
   * arrival is never sufficient. The record must satisfy the rootness,
   * sufficiency, and binding rules on {@link NativeClaudeTurnEndConfirmation};
   * a summary that is not the root's own is refused, an undecidable summary
   * withdraws the foreground claim instead of inventing either outcome, and a
   * confirmation that conflicts with the session or prompt this reducer
   * positively observed — or that carries no binding at all while root work is
   * live — is rejected rather than allowed to overwrite newer work.
   */
  confirmTurnEnd(confirmation: NativeClaudeTurnEndConfirmation = {}): NativeClaudeReduceResult {
    const sessionId = readToken(confirmation.sessionId);
    const promptId = readToken(confirmation.promptId);
    const sourceToken = readToken(confirmation.sourceToken);
    if (this.#scopeClosed) return { outcome: "ignored", reason: "scope-closed" };
    if (sessionId !== null && this.#scope !== null && sessionId !== this.#scope) {
      return { outcome: "ignored", reason: "stale-session" };
    }
    if (promptId !== null && this.#rootPromptId !== null && promptId !== this.#rootPromptId) {
      return { outcome: "ignored", reason: "stale-prompt" };
    }
    if (confirmation.summary !== undefined && confirmation.summary !== null) {
      const record = confirmation.summary;
      // Sidechain, agent-scoped, and non-Stop-labelled summaries never close root.
      if (!isRootTerminalRecord(record)) return { outcome: "ignored", reason: "non-root-terminal-record" };
      // An undecidable summary proves nothing, and it also cannot leave a live
      // running claim standing: the foreground becomes unverifiable.
      if (!terminalRecordEndsTurn(record)) return this.#invalid("terminal-record-inconclusive", true);
    }
    if (sourceToken !== null && sourceToken === this.#terminalToken) {
      return { outcome: "ignored", reason: "duplicate-terminal-record" };
    }
    if (this.#busy === true && promptId === null && sourceToken === null) {
      // Live root work with nothing to bind this claim to: it could be an older
      // record surfacing late, so it cannot overwrite the current turn.
      return { outcome: "ignored", reason: "unbound-terminal-record" };
    }
    if (this.#scope === null && sessionId !== null) this.#scope = sessionId;
    if (this.#rootPromptId === null) this.#rootPromptId = promptId;
    if (sourceToken !== null) this.#terminalToken = sourceToken;
    this.#retireRootRequestsWithTurnEnd();
    this.#clearTurnToolState();
    this.#busy = false;
    this.#activity = [READY_ACTIVITY];
    this.#blockingQuestion = null;
    this.#waitingQuestionKey = null;
    this.#foregroundOrigin = "transcript";
    this.#freshStartPending = false;
    this.#startupVouched = false;
    return { outcome: "applied", reason: "turn-ended-confirmed", snapshot: this.snapshot() };
  }

  /** Reduce one already-parsed hook payload. */
  reduce(event: unknown): NativeClaudeReduceResult {
    if (!isRecord(event)) return this.#invalid("malformed-envelope", true);
    const hookEventName = readToken(event.hook_event_name);
    if (hookEventName === null) return this.#invalid("malformed-envelope", true);

    const sessionId = readToken(event.session_id);
    const scope = readScope(event.agent_id);
    if (scope === "unusable") return this.#invalid("malformed-scope", true);

    if (hookEventName === "SessionStart") {
      return this.#reduceSessionStart(sessionId, scope, event.source);
    }

    // Every other event is only interpretable against the scope it belongs to.
    if (sessionId === null) return this.#invalid("malformed-envelope", true);
    if (this.#scopeClosed) return { outcome: "ignored", reason: "scope-closed" };

    // Classify BEFORE any root-scope adoption: an event this reducer will not
    // apply must never be the event that binds the root session.
    if (!KNOWN_EVENTS.has(hookEventName)) return { outcome: "ignored", reason: "unsupported-event" };
    if (scope === "subagent" && this.#scope === null) return { outcome: "ignored", reason: "subagent-scope" };
    if (this.#scope === null) {
      if (!ADOPTABLE_EVENTS.has(hookEventName)) return { outcome: "ignored", reason: "unbound-session" };
      this.#scope = sessionId;
    } else if (this.#scope !== sessionId) {
      return { outcome: "ignored", reason: "stale-session" };
    }

    // A question close is correlated against the request it names, never
    // against the foreground prompt: a request opened during an earlier prompt
    // stays observed when a new prompt starts, and its own matching closure
    // still closes it without touching the newer foreground.
    const isQuestionClose = (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure")
      && normalizeToolType(event.tool_name) === QUESTION_TOOL_TYPE;
    const promptId = readToken(event.prompt_id);
    // A root event whose prompt correlation conflicts with the turn this
    // reducer positively observed is a known-older edge: it can neither move
    // the foreground nor open a request. `UserPromptSubmit` is the prompt
    // boundary itself, so it always re-establishes the correlation.
    if (
      scope === "root"
      && hookEventName !== "UserPromptSubmit"
      && !isQuestionClose
      && promptId !== null
      && this.#rootPromptId !== null
      && promptId !== this.#rootPromptId
    ) {
      return { outcome: "ignored", reason: "stale-prompt" };
    }
    if (scope === "root" && !isQuestionClose && this.#rootPromptId === null) this.#rootPromptId = promptId;

    switch (hookEventName) {
      case "SessionEnd":
        return this.#reduceSessionEnd(scope);
      case "UserPromptSubmit":
        return this.#reduceUserPromptSubmit(scope, promptId);
      case "Stop":
        return this.#reduceStop(scope);
      case "StopFailure":
        return this.#reduceStopFailure(scope);
      case "PreToolUse":
        return this.#reducePreToolUse(scope, event);
      case "PostToolUse":
      case "PostToolUseFailure":
        return this.#reducePostToolUse(scope, event);
      default:
        return { outcome: "ignored", reason: "unsupported-event" };
    }
  }

  /**
   * A genuine root SessionStart is the only rebind: the new scope inherits no
   * Ready, pending, tool, question, or session claim, and only this boundary can
   * mark the scope fully observed and vouch its question census empty. A
   * subagent SessionStart never rebinds. A `startup` or `clear` additionally
   * states a brand-new conversation, but the IDLE claim it would support is held
   * until the caller corroborates that the bound source shows no prerecorded
   * work, so a start that arrives over live work or over an unreadable source
   * still publishes nothing but the boundary itself: a start that arrives after
   * THIS conversation observed work is never armed for corroboration, so no later
   * read of an empty or not-yet-created source can idle it — and a `startup`
   * notice for a conversation already bound is refused outright, so it cannot
   * even clear the work. Work belonging to an earlier conversation never
   * disqualifies a genuinely new session from its own corroborated baseline.
   */
  #reduceSessionStart(
    sessionId: string | null,
    scope: ObservedScope,
    source: unknown,
  ): NativeClaudeReduceResult {
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    const sameScope = sessionId !== null && sessionId === this.#scope;
    // A `startup` notice cannot restart a conversation this reducer already
    // bound. A late or repeated delivery of it is not a new boundary: resetting
    // on it would delete a live question with no closure evidence and hand the
    // next empty-source read a cleared scope to idle. Only another conversation,
    // or a source that positively describes one (`clear`, `compact`, `fork`), or
    // a resumed history (`resume`), rebinds a bound scope.
    if (sameScope && readToken(source) === "startup") {
      return { outcome: "ignored", reason: "duplicate-session-start" };
    }
    // Work observed in THIS session, read BEFORE any reset releases it. A start
    // that arrives after real work in the conversation it names is a boundary in
    // the middle of a stream, not the beginning of an empty conversation, so it
    // may rebind as always but may never be corroborated into an idle row with an
    // empty census and zero counts. Work in some PREVIOUS conversation is none of
    // a genuinely new session's business: it never blocks that session's own
    // corroborated empty baseline.
    const hadWork = sameScope && this.#workObserved();
    // The host launched this run and nothing has run in it, so its boundary is
    // the same fact the provider's own `SessionStart` restates: this process is
    // idle and nothing is pending. The idle claim therefore survives this
    // rebind — for any source, including `resume`, which describes the
    // conversation's history and not this process's foreground — instead of
    // blinking the row through unknown between the host's baseline and the
    // provider's notice. Once ANY work has been observed the vouch is gone, so
    // this never preserves a live or ended turn across a boundary.
    const preserve = this.#startupVouched && !this.#workObserved();
    const preservedBusy = preserve ? this.#busy : null;
    const preservedActivity = preserve ? this.#activity : [];
    this.#resetScope(sessionId);
    this.#scopeFullyObserved = sessionId !== null || preserve;
    // A root SessionStart with a readable identity shows the question census
    // from its beginning, so nothing can have opened unobserved before it: the
    // census is positively EMPTY here, which is the only pre-question source of
    // a `pendingInput: false` claim. An adopted, invalidated, or unidentified
    // scope never gets this baseline, so it stays unknown as before.
    this.#closureVouched = (sessionId !== null || preserve) && !this.#censusIncomplete;
    this.#startupVouched = preserve;
    this.#freshStartPending = sessionId !== null
      && !preserve
      && !hadWork
      && isNativeClaudeFreshStartSource(source);
    if (preserve) {
      this.#busy = preservedBusy;
      this.#activity = preservedActivity;
      this.#foregroundOrigin = "observed";
    }
    // Without an identity the scope is genuinely new but uncorrelatable; the
    // next eligible event adopts it rather than a fabricated pairing.
    return sessionId === null
      ? this.#invalid("scope-rebound-unidentified", false)
      : { outcome: "applied", reason: "scope-rebound", snapshot: this.snapshot() };
  }

  /** An observed root SessionEnd invalidates everything it bounded. */
  #reduceSessionEnd(scope: ObservedScope): NativeClaudeReduceResult {
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    this.#clearObservations();
    this.#scopeClosed = true;
    return { outcome: "applied", reason: "scope-ended", snapshot: this.snapshot() };
  }

  /** `UserPromptSubmit` is a real accepted root turn and the prompt boundary. */
  #reduceUserPromptSubmit(scope: ObservedScope, promptId: string | null): NativeClaudeReduceResult {
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    this.#rootPromptId = promptId;
    this.#busy = true;
    this.#activity = [WORKING_ACTIVITY];
    this.#blockingQuestion = null;
    this.#waitingQuestionKey = null;
    this.#foregroundOrigin = "observed";
    this.#freshStartPending = false;
    this.#startupVouched = false;
    this.#clearTurnToolState();
    return { outcome: "applied", reason: "turn-submitted", snapshot: this.snapshot() };
  }

  /**
   * A root `Stop` is a turn-end boundary this observer cannot prove final: a
   * different operator's `Stop` hook may block and continue the same turn, so
   * the foreground becomes unverifiable rather than Ready, and the turn's tool
   * ledger is dropped so a late close cannot relabel it. An unresolved root
   * question request is NOT cleared here: it was never observed closing, and a
   * continuation may still be waiting on it. Only
   * {@link NativeClaudeStatusReducer.confirmTurnEnd} or a scope boundary owns
   * it.
   */
  #reduceStop(scope: ObservedScope): NativeClaudeReduceResult {
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    this.#clearTurnToolState();
    this.#busy = null;
    this.#activity = [];
    this.#blockingQuestion = null;
    this.#waitingQuestionKey = null;
    this.#foregroundOrigin = null;
    return { outcome: "applied", reason: "turn-end-candidate", snapshot: this.snapshot() };
  }

  /** `StopFailure` is an unsuccessful or unverifiable boundary: never idle. */
  #reduceStopFailure(scope: ObservedScope): NativeClaudeReduceResult {
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    this.#clearTurnToolState();
    this.#busy = null;
    this.#activity = [];
    this.#blockingQuestion = null;
    this.#waitingQuestionKey = null;
    this.#foregroundOrigin = null;
    return { outcome: "applied", reason: "turn-failed", snapshot: this.snapshot() };
  }

  /**
   * `PreToolUse` either opens an observed question request or claims the root
   * current tool TYPE. A payload whose tool name cannot be read claims nothing:
   * it is unknown whether that call was a question request, so both the
   * foreground claim and the pending census are withdrawn.
   */
  #reducePreToolUse(scope: ObservedScope, event: Record<string, unknown>): NativeClaudeReduceResult {
    const toolType = normalizeToolType(event.tool_name);
    const requestId = readToken(event.tool_use_id);
    if (toolType === null) {
      return this.#invalid("tool-name-unavailable", scope === "root");
    }
    if (toolType === QUESTION_TOOL_TYPE) {
      return this.#openQuestionRequest(scope, requestId, event);
    }
    // Subagent tool work is not root foreground activity: it must not replace
    // the root's current tool TYPE or claim a root running edge.
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    this.#busy = true;
    this.#activity = [toolType];
    // Real root tool work is running: it outranks a question request that is
    // still open, so the row is never made to look paused while the provider is
    // doing something else.
    this.#blockingQuestion = null;
    this.#foregroundOrigin = "observed";
    this.#freshStartPending = false;
    this.#startupVouched = false;
    if (requestId === null) {
      this.#lastToolId = null;
    } else {
      this.#rememberTool(requestId, "open");
      this.#lastToolId = requestId;
    }
    return { outcome: "applied", reason: "tool-type-observed", snapshot: this.snapshot() };
  }

  /**
   * A matching `Post*` closes a question request definitively, whether or not
   * any answer is present — this module never reads a response body, so no
   * answered outcome can be fabricated and a dismissed request cannot strand
   * the row. The close is validated against the correlation the open edge
   * recorded, across prompt boundaries, before the request is consumed. A close
   * for a request this reducer never opened shows an observation gap, so the
   * census degrades instead of claiming none remain.
   */
  #reducePostToolUse(scope: ObservedScope, event: Record<string, unknown>): NativeClaudeReduceResult {
    const toolType = normalizeToolType(event.tool_name);
    const requestId = readToken(event.tool_use_id);
    if (toolType === null) {
      // The request type is unreadable, so it cannot be ruled out as a question
      // request and no tool TYPE may be claimed from it.
      return this.#invalid("tool-name-unavailable", scope === "root");
    }
    if (toolType === QUESTION_TOOL_TYPE) return this.#closeQuestionRequest(scope, requestId, event);

    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    if (requestId === null) return this.#invalid("tool-close-unidentified", true);

    const state = this.#toolRequests.get(requestId);
    if (state === undefined) {
      // Never observed opening in this turn: it cannot relabel current state.
      return { outcome: "ignored", reason: "tool-close-unobserved" };
    }
    if (state === "closed") return { outcome: "ignored", reason: "duplicate-tool-close" };
    // The close is recorded whichever request it names: the ledger has to say what
    // is still running, and an older request that finished must not keep looking
    // like work in flight. Only the CURRENT request's close may relabel activity —
    // an older one says nothing about what the provider is doing now.
    this.#toolRequests.set(requestId, "closed");
    // The close of the last other root request can be exactly what leaves the
    // provider with nothing to do but wait, so the standing question request is
    // re-armed here rather than dismissed along with the tool that finished.
    const rearmed = this.#rearmQuestionBlock();
    if (requestId !== this.#lastToolId) {
      // A close for an older request must not overwrite newer tool state — but
      // where it is the close that empties the field, the stopped-on-input
      // projection is a real published fact about this row, and it is not
      // withheld behind a label this older request cannot restate.
      if (rearmed) return { outcome: "applied", reason: "question-block-resumed", snapshot: this.snapshot() };
      return { outcome: "ignored", reason: "stale-tool-close" };
    }
    // The tool TYPE stays as the last observed one; only a confirmed turn end
    // yields Ready.
    this.#activity = [toolType];
    if (!rearmed) this.#blockingQuestion = null;
    return { outcome: "applied", reason: "tool-completed", snapshot: this.snapshot() };
  }

  /**
   * Arm the stopped-on-input projection for the standing root question request
   * once nothing else is demonstrably in flight. Qualified the same way the open
   * edge arms it: one request identity, in the prompt it stands in, over a turn
   * this source observed running, and only when EVERY tracked root request has a
   * matching close.
   */
  #rearmQuestionBlock(): boolean {
    if (this.#busy !== true) return false;
    const key = this.#waitingQuestionKey;
    if (key === null) return false;
    const request = this.#openQuestions.get(key);
    if (request === undefined) {
      this.#waitingQuestionKey = null;
      return false;
    }
    if (request.promptId !== null && this.#rootPromptId !== request.promptId) return false;
    for (const state of this.#toolRequests.values()) {
      if (state === "open") return false;
    }
    this.#blockingQuestion = { key, promptId: request.promptId };
    return true;
  }

  #openQuestionRequest(
    scope: ObservedScope,
    requestId: string | null,
    event: Record<string, unknown>,
  ): NativeClaudeReduceResult {
    if (requestId === null) {
      // An unidentifiable request can never be matched to a definitive close.
      // For root work this is freshly observed foreground that cannot be
      // tracked, so the current running/Ready claim is withdrawn too.
      return this.#invalid("question-request-unidentified", scope === "root");
    }
    const key = requestKey(scope, requestId);
    // A request this reducer already saw close definitively must not be
    // resurrected by a replayed open edge.
    if (this.#closedRequests.includes(key)) return { outcome: "ignored", reason: "duplicate-question-open" };
    if (this.#openQuestions.has(key)) return { outcome: "ignored", reason: "duplicate-question-open" };
    if (this.#openQuestions.size >= MAX_TRACKED_QUESTION_REQUESTS) {
      return this.#invalid("question-census-capacity", scope === "root");
    }
    this.#openQuestions.set(key, { scope, requestId, promptId: readToken(event.prompt_id) });
    if (scope === "root") {
      // An accepted root question request is positively observed root tool work:
      // the turn is live and its foreground claim is preserved, so an existing
      // running or last-tool label survives and a first observed tool still
      // proves a turn. What the request adds is the block: while it stands, the
      // published foreground reports stopped-on-input. An existing missing or
      // stale Ready claim is replaced by the generic running label.
      this.#busy = true;
      // The block is armed for THIS request, and only when nothing else is
      // demonstrably running: EVERY tracked root request that opened without a
      // matching close is work in flight — the most recent one is not the only
      // candidate — and a question must not make that row look paused.
      let toolInFlight = false;
      for (const state of this.#toolRequests.values()) {
        if (state === "open") {
          toolInFlight = true;
          break;
        }
      }
      this.#blockingQuestion = toolInFlight
        ? null
        : { key, promptId: readToken(event.prompt_id) };
      // Remembered whichever way the block landed, so the close of the work this
      // request opened over can arm the pause it could not arm itself.
      this.#waitingQuestionKey = key;
      this.#foregroundOrigin = "observed";
      this.#freshStartPending = false;
      this.#startupVouched = false;
      if (this.#activity.every((line) => line === READY_ACTIVITY)) {
        this.#activity = [WORKING_ACTIVITY];
      }
    }
    return { outcome: "applied", reason: "question-request-open", snapshot: this.snapshot() };
  }

  #closeQuestionRequest(
    scope: ObservedScope,
    requestId: string | null,
    event: Record<string, unknown>,
  ): NativeClaudeReduceResult {
    if (requestId === null) return this.#invalid("question-close-unidentified", false);
    const key = requestKey(scope, requestId);
    const open = this.#openQuestions.get(key);
    if (open === undefined) {
      if (this.#closedRequests.includes(key)) return { outcome: "ignored", reason: "duplicate-question-close" };
      return this.#invalid("question-close-unobserved", false);
    }
    const promptId = readToken(event.prompt_id);
    if (open.promptId !== null && promptId !== null && open.promptId !== promptId) {
      // A conflicting prompt correlation cannot consume the open request: it
      // stays pending until a properly correlated close arrives, and the root
      // foreground is untouched either way.
      if (scope === "root") return { outcome: "ignored", reason: "stale-prompt" };
      return this.#invalid("question-close-prompt-mismatch", false);
    }
    this.#openQuestions.delete(key);
    this.#rememberClosed(key);
    if (this.#blockingQuestion?.key === key) this.#blockingQuestion = null;
    if (this.#waitingQuestionKey === key) this.#waitingQuestionKey = null;
    this.#closureVouched = this.#openQuestions.size === 0 && !this.#censusIncomplete;
    return { outcome: "applied", reason: "question-request-closed", snapshot: this.snapshot() };
  }

  /**
   * `true` for any positively observed open request; `false` only for a fully
   * observed scope whose census is vouched empty — either by its own root
   * `SessionStart` or by a definitive close of every observed request — and
   * which has suffered no observation hole since; otherwise unknown.
   */
  #pendingInput(): boolean | null {
    if (this.#openQuestions.size > 0) return true;
    if (!this.#scopeFullyObserved || this.#censusIncomplete || !this.#closureVouched) return null;
    return false;
  }

  /**
   * Withdraw the root foreground claim as unverifiable: a payload this reducer
   * recognized but could not read says nothing trustworthy about what is
   * running, so a stale `Ready`, `Working`, or tool TYPE must not survive it.
   */
  #withdrawForeground(): void {
    this.#busy = null;
    this.#activity = [];
    // The unreadable payload could itself be the standing request's own close, so
    // a stopped-on-input claim is withdrawn with the rest of the foreground rather
    // than left standing on evidence this payload may already have contradicted.
    this.#blockingQuestion = null;
    this.#waitingQuestionKey = null;
    this.#foregroundOrigin = null;
    this.#clearTurnToolState();
  }

  #clearTurnToolState(): void {
    this.#toolRequests.clear();
    this.#lastToolId = null;
  }

  #rememberTool(requestId: string, state: "open" | "closed"): void {
    if (!this.#toolRequests.has(requestId) && this.#toolRequests.size >= MAX_TRACKED_TOOL_REQUESTS) {
      const oldest = this.#toolRequests.keys().next();
      if (!oldest.done) this.#toolRequests.delete(oldest.value);
    }
    this.#toolRequests.set(requestId, state);
  }

  /**
   * A confirmed root turn end ENDS the root requests still open in it: the
   * source positively stated the turn is over, so nothing can still be awaiting
   * input, and holding those requests as a permanent unknown would strand the
   * row's pending census for the rest of the scope. They are recorded as closed
   * (never as answered: no outcome is claimed), so a replayed close edge still
   * reads as a duplicate. Subagent-scoped requests are untouched: their own
   * definitive close edges, or their own subagent transcript, own them, and an
   * unrelated root completion says nothing about them.
   */
  #retireRootRequestsWithTurnEnd(): void {
    for (const [key, request] of [...this.#openQuestions]) {
      if (request.scope !== "root") continue;
      this.#openQuestions.delete(key);
      this.#rememberClosed(key);
    }
    this.#closureVouched = this.#openQuestions.size === 0 && !this.#censusIncomplete;
  }

  #rememberClosed(key: string): void {
    if (this.#closedRequests.includes(key)) return;
    this.#closedRequests.push(key);
    if (this.#closedRequests.length > MAX_REMEMBERED_CLOSED_REQUESTS) this.#closedRequests.shift();
  }

  #markCensusIncomplete(): void {
    this.#censusIncomplete = true;
    this.#closureVouched = false;
  }

  #clearObservations(): void {
    this.#rootPromptId = null;
    this.#busy = null;
    this.#activity = [];
    this.#blockingQuestion = null;
    this.#waitingQuestionKey = null;
    this.#foregroundOrigin = null;
    this.#freshStartPending = false;
    this.#startupVouched = false;
    this.#clearTurnToolState();
    this.#openQuestions.clear();
    this.#closedRequests = [];
    this.#censusIncomplete = false;
    this.#closureVouched = false;
    this.#terminalToken = null;
  }

  #resetScope(scope: string | null): void {
    this.#clearObservations();
    this.#scope = scope;
    this.#scopeFullyObserved = false;
    this.#scopeClosed = false;
  }

  /**
   * Degrade what the unreadable payload would have supported: the root
   * foreground claim when the payload is root-scoped or cannot be attributed at
   * all, and always the pending-request census.
   */
  #invalid(reason: NativeClaudeReduceReason, affectsRootForeground: boolean): NativeClaudeReduceResult {
    if (affectsRootForeground) this.#withdrawForeground();
    this.#markCensusIncomplete();
    return { outcome: "invalid", reason, snapshot: this.snapshot() };
  }
}

function requestKey(scope: ObservedScope, requestId: string): string {
  return `${scope}\u0000${requestId}`;
}

/**
 * Whether the record is the root turn's own stop-hook summary. A sidechain or
 * `agentId`-scoped summary, or a non-`Stop` `hookLabel` summary — and a summary
 * labelled for any event other than `Stop` — can never close the root
 * foreground. An absent `hookLabel` is the root turn-end path the 2.1.325 turn
 * leaves unlabelled, and `"Stop"` is the same root summary explicitly labelled.
 */
function isRootTerminalRecord(record: NativeClaudeTerminalRecord): boolean {
  if (record.isSidechain === true) return false;
  if (readToken(record.agentId) !== null) return false;
  const hookLabel = readToken(record.hookLabel);
  if (hookLabel !== null && hookLabel !== "Stop") return false;
  const label = readToken(record.hookEventName);
  return label === null || label === "Stop";
}

/**
 * Whether the summary proves the root turn actually ended. `preventedContinuation`
 * true means the turn ENDS; false ends it only with an empty `hookErrors` array
 * and an absent or empty `hookAdditionalContext`. Anything else — a nonempty
 * `hookErrors` array (which mixes blocking and nonblocking outcomes), a missing
 * field, or a shape that cannot be read — is genuinely undecidable and never
 * terminal here. Only emptiness is observed; no field content is read or kept.
 */
function terminalRecordEndsTurn(record: NativeClaudeTerminalRecord): boolean {
  if (record.preventedContinuation === true) return true;
  if (record.preventedContinuation !== false) return false;
  return isEmptyArray(record.hookErrors)
    && (record.hookAdditionalContext === undefined || isEmptyArray(record.hookAdditionalContext));
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/**
 * A present, non-empty `agent_id` is the only positive evidence of an actual
 * observed subagent context; its absence is read as root scope for reduction
 * purposes and is never treated as proof about a Pi conversation.
 */
function readScope(value: unknown): ObservedScope | "unusable" {
  if (value === undefined || value === null) return "root";
  return typeof value === "string" && value.trim() !== "" ? "subagent" : "unusable";
}

/** Trimmed non-empty string, or null when the field is absent or unusable. */
function readToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Normalize a hook `tool_name` into the single retained field: a bounded,
 * sanitized, lowercased tool TYPE in the existing sidebar convention. Anything
 * that does not read as an identifier (whitespace, paths, command text,
 * controls) earns no label claim, so no argument, command, or transcript text
 * can reach an activity line through this field.
 */
function normalizeToolType(value: unknown): string | null {
  const token = readToken(value);
  if (token === null) return null;
  const lowered = token.replace(/\s+/g, " ").toLowerCase();
  if (lowered.length > MAX_TOOL_TYPE_CHARS || !TOOL_TYPE_PATTERN.test(lowered)) return null;
  return sanitizeActivityLine(lowered);
}
