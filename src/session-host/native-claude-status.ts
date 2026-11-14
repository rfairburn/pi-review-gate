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
 * - Nothing here fabricates a Ready/idle claim from process startup, missing
 *   data, quiet output, or the arrival of this observer's own `Stop` hook. A
 *   `Stop` or `StopFailure` boundary makes the foreground unverifiable; only
 *   {@link NativeClaudeStatusReducer.confirmTurnEnd}, driven by a terminal
 *   record the source actually read, can establish `busy: false` and `Ready`.
 *   {@link NativeClaudeTurnEndConfirmation} states the source-grounded
 *   rootness, sufficiency, and binding rules the acquisition layer must satisfy;
 *   this module never tails a transcript, reconstructs a census, or ranks source
 *   records against each other.
 * - A definitive question census yields `pendingInput: false` only for a scope a
 *   genuine root `SessionStart` with a readable identity established as fully
 *   observed: that same boundary vouches the census EMPTY (no request can have
 *   opened before this scope began), and it stays false while this reducer can
 *   vouch that no observed request remains open. A scope adopted mid-stream or
 *   released by invalidation keeps that claim unknown.
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
  | "question-census-capacity";

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
  /** Prompt correlation of the root turn this reducer last positively observed. */
  #rootPromptId: string | null = null;
  /** Root foreground busy; null means unknown, never a silent idle claim. */
  #busy: boolean | null = null;
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
      busy: this.#busy,
      pendingInput: this.#pendingInput(),
      activity: [...this.#activity],
    };
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
    this.#withdrawUnresolvedRootRequests();
    this.#clearTurnToolState();
    this.#busy = false;
    this.#activity = [READY_ACTIVITY];
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

    if (hookEventName === "SessionStart") return this.#reduceSessionStart(sessionId, scope);

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
   * subagent SessionStart never rebinds.
   */
  #reduceSessionStart(sessionId: string | null, scope: ObservedScope): NativeClaudeReduceResult {
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    this.#resetScope(sessionId);
    this.#scopeFullyObserved = sessionId !== null;
    // A root SessionStart with a readable identity shows the question census
    // from its beginning, so nothing can have opened unobserved before it: the
    // census is positively EMPTY here, which is the only pre-question source of
    // a `pendingInput: false` claim. An adopted, invalidated, or unidentified
    // scope never gets this baseline, so it stays unknown as before.
    this.#closureVouched = sessionId !== null;
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
    return { outcome: "applied", reason: "turn-end-candidate", snapshot: this.snapshot() };
  }

  /** `StopFailure` is an unsuccessful or unverifiable boundary: never idle. */
  #reduceStopFailure(scope: ObservedScope): NativeClaudeReduceResult {
    if (scope === "subagent") return { outcome: "ignored", reason: "subagent-scope" };
    this.#clearTurnToolState();
    this.#busy = null;
    this.#activity = [];
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
    if (requestId !== this.#lastToolId) {
      // A close for an older request must not overwrite newer tool state.
      return { outcome: "ignored", reason: "stale-tool-close" };
    }
    // The tool TYPE stays as the last observed one; only a confirmed turn end
    // yields Ready.
    this.#toolRequests.set(requestId, "closed");
    this.#activity = [toolType];
    return { outcome: "applied", reason: "tool-completed", snapshot: this.snapshot() };
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
    this.#openQuestions.set(key, { scope, promptId: readToken(event.prompt_id) });
    if (scope === "root") {
      // An accepted root question request is positively observed root tool work:
      // the foreground is running even when this is the first observed tool or a
      // blocked Stop continued straight into it. An existing running or
      // last-tool label is preserved; only a missing or stale Ready claim is
      // replaced by the generic running label.
      this.#busy = true;
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
   * Drop unresolved root-scope requests as unverifiable. Subagent-scoped
   * requests are untouched: their own definitive close edges own them.
   */
  #withdrawUnresolvedRootRequests(): void {
    let withdrew = false;
    for (const [key, request] of this.#openQuestions) {
      if (request.scope !== "root") continue;
      this.#openQuestions.delete(key);
      this.#rememberClosed(key);
      withdrew = true;
    }
    // A request that ended without a definitive close was never observed
    // closing, so no definitive "none remain" claim survives it.
    if (withdrew) this.#markCensusIncomplete();
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
