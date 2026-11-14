/**
 * Native Codex foreground and tool-activity reducer.
 *
 * This module is the pure decision core for one hosted Codex row's foreground
 * state. It maps two already-acquired native evidence streams to a running /
 * Ready / unknown foreground claim plus a bounded tool-TYPE activity line:
 *
 * 1. metadata from hooks the extension itself configured and authenticated for
 *    that exact owned Codex run (the run-scoped hook observation), and
 * 2. rollout records the caller has already positively bound to the ROOT
 *    Codex thread it is hosting.
 *
 * Nothing here performs IO. There is no file tailer, no process or PTY
 * inspection, no clock, no timer, no polling, no thread/subagent census, and no
 * launch, transport, question, or permission code. Acquisition stays outside;
 * this reducer only folds what acquisition hands it.
 *
 * Fail-closed contract, derived from the pinned Codex source (`rust-v0.167.2`):
 *
 * - Foreground starts `unknown`. `busy = true` only from real, turn-scoped
 *   native evidence that work is happening: a durable `task_started`, a root
 *   `UserPromptSubmit`, a root `PreToolUse`/`PostToolUse`, or a persisted root
 *   tool item.
 * - `busy = false` (Ready) only from a durable `task_complete` or
 *   `turn_aborted` record whose `turn_id` is the currently held root turn, whose
 *   terminal has not already been consumed, AND whose evidence item carries the
 *   caller's verified current-root-turn provenance
 *   ({@link NativeCodexEvidenceScope.currentRootTurnId}). Without that
 *   attestation the row degrades and the terminal is left unconsumed, so an
 *   attested delivery can still land. A terminal for any other turn never marks
 *   this row Ready.
 * - A hook `Stop` (or `SubagentStop`) is never a turn-end witness. Native Stop
 *   hooks can block and continue the same turn, so the durable terminal in the
 *   rollout is the only Ready witness.
 * - Descendant authority is refused before anything else: any hook event that
 *   carries `agent_id` belongs to a sub-agent (root and children share the
 *   lineage `session_id`, and `SubagentStop` can even carry the parent's
 *   transcript path), and any turn record whose `root_turn_id` differs from its
 *   own `turn_id` is a nested turn (`root_turn_id` equals `turn_id` for root
 *   turns). Neither can start, stop, or refresh the root row.
 * - Delayed, replayed, or reversed records cannot clobber newer state. Turn ids
 *   that already reached a durable root terminal are tombstoned, and a consumed
 *   terminal can never grant Ready a second time: after a gap or an
 *   invalidation, replaying the same durable record is not fresh evidence.
 *   While a live, unterminated turn is held, a processing witness for a
 *   different, never-matched turn cannot take over on arrival order alone — a
 *   rollout replay, a stale hook, and an evicted tombstone are
 *   indistinguishable — so the held turn keeps its correlation, the newcomer
 *   gains no Ready authority, and the row degrades. Only the caller's verified
 *   current-root-turn provenance can move the row off a live turn.
 * - A recognized status record whose required scope is missing or unusable
 *   (a `task_started` without a `turn_id`, a root `UserPromptSubmit`/
 *   `PreToolUse`/`PostToolUse` without a usable one) degrades the row rather
 *   than being ignored, because it may describe real processing whose scope was
 *   lost. Positively identified descendants and unrelated payloads stay
 *   ignored.
 * - Scope changes (`SessionStart` with source `startup`, `clear`, `fork`, or
 *   `resume`), a root rebind, and any source failure, ordinal/history gap, or
 *   invalid/oversized candidate record degrade the affected state to `unknown`.
 *   Compaction never means a new thread or a new idle turn.
 * - Activity carries a tool TYPE only. Command arguments, prompts, tool input
 *   and responses, model text, reasoning, transcripts, and paths are never
 *   read, retained, or rendered, and no background/foreground counts are
 *   produced. A question or permission tool hook has its activity line
 *   suppressed so nothing can imply pending input, but the scoped attempt still
 *   counts as processing evidence for the foreground.
 *
 * Deliberately out of scope here (separate acquisition work, not declared
 * permanently unsupported): the actual hook installer, the rollout tail
 * reader/transport, question/approval detection, and native background counts.
 * `pendingInput` is therefore only an optional caller passthrough; this reducer
 * derives nothing from it. `inputSurface` is not produced at all, because no
 * native witness for an open input surface exists in these streams.
 *
 * Cross-stream ordering has no native clock, and neither history boundaries nor
 *   an invalidation can be re-derived from a record's own fields, so the caller
 *   supplies two bounded pieces of provenance instead:
 *
 *   - `generation`: any item tagged with a generation other than the state's is
 *     dropped as out-of-scope rather than adopted; `rebind` resets and
 *     optionally adopts a new generation.
 *   - `currentRootTurnId`: the caller's verified current root turn, after it
 *     has accounted for cross-stream ordering, history boundaries, and any
 *     invalidation. It is the only thing that can authorize a new Ready claim or
 *     move the row off a live held turn. It must never be a copy of the
 *     terminal record's own `turn_id` — that proves nothing about currentness.
 *
 * Producing that verification (reader positioning, ordinal continuity, hook
 * versus rollout ordering) is acquisition work outside this module; absent it,
 * the affected state stays `unknown`.
 */

import { isRecord } from "../record-guard";
import { MAX_ACTIVITY_LINES, sanitizeActivityLine } from "./protocol";

/* ------------------------------------------------------------------ bounds */

/**
 * How many consumed terminals are remembered as tombstones, so a replayed
 * terminal or a delayed start of a finished turn cannot re-acquire authority.
 * Bounded so a long-lived row cannot grow its state with every turn; eviction
 * only removes that protection for the oldest ids, while the held-live-turn rule
 * and the current-turn attestation requirement keep working.
 */
export const NATIVE_CODEX_MAX_TRACKED_TURNS = 16;

/**
 * Upper bound for one candidate rollout line handed to
 * {@link classifyNativeCodexCandidate}. Persisted command output is capped far
 * below this by Codex itself, so a longer line is not a status record; it is
 * degraded, not parsed.
 */
export const NATIVE_CODEX_MAX_CANDIDATE_CHARS = 128 * 1024;

/** Turn ids are opaque native identifiers; an absurdly long one is malformed. */
export const NATIVE_CODEX_MAX_TURN_ID_CHARS = 256;

/** Tool names are short identifiers; an absurdly long one is malformed. */
export const NATIVE_CODEX_MAX_TOOL_NAME_CHARS = 128;

/** Caller binding generations are opaque labels, not content. */
export const NATIVE_CODEX_MAX_GENERATION_CHARS = 256;

/* ------------------------------------------------------------------- state */

/** Foreground phase of one hosted Codex row. `unknown` is the fail-closed default. */
export type NativeCodexForegroundPhase = "unknown" | "running" | "ready";

/**
 * Reducer state. `rootThreadId` is the caller's positively bound root thread
 * identity (the transcript/thread UUID, corroborated by `session_meta`); it is
 * carried only to reject records that visibly belong to another thread, and the
 * shared lineage `session_id` is deliberately absent because it is not thread
 * identity — root and every sub-agent share it.
 */
export interface NativeCodexStatusState {
  readonly phase: NativeCodexForegroundPhase;
  /** Root thread this state is bound to, or null when the caller binds nothing. */
  readonly rootThreadId: string | null;
  /** Caller binding generation, or null when the caller does not tag evidence. */
  readonly generation: string | null;
  /**
   * Turn currently held as this row's live turn, or null when unobserved. A
   * held, unterminated turn is the only turn whose terminal can grant Ready,
   * only once, and only with the caller's current-root-turn attestation; an
   * unfamiliar turn replaces it only after that turn's terminal or on the same
   * attestation.
   */
  readonly observedTurnId: string | null;
  /** Turn ids whose durable root terminal was already consumed (tombstones). */
  readonly terminatedTurnIds: readonly string[];
  /** Bounded tool-TYPE activity lines for the observed turn. */
  readonly activity: readonly string[];
}

/** Optional root binding for {@link createNativeCodexStatusState}. */
export interface NativeCodexStatusOptions {
  readonly rootThreadId?: string | null;
  readonly generation?: string | null;
}

/** One bounded degradation notice from the acquisition layer. */
export type NativeCodexSourceSignal =
  /** Sequence gap in the bound root stream (missing ordinal/records). */
  | "gap"
  /** A candidate status record that failed to decode or was not a record. */
  | "malformed"
  /** A candidate status record above {@link NATIVE_CODEX_MAX_CANDIDATE_CHARS}. */
  | "oversized"
  /** The bound stream could not be read. */
  | "source-failure"
  /** The root binding changed; every earlier observation is out of scope. */
  | "rebind";

/**
 * Caller-supplied provenance shared by every evidence item. Both fields are
 * optional; absence never grants authority.
 */
export interface NativeCodexEvidenceScope {
  /**
   * Caller binding generation. When both the state and the item carry one and
   * they differ, the item is out of scope and is dropped.
   */
  readonly generation?: string | null;
  /**
   * Caller-verified current root turn, accounting for cross-stream ordering,
   * history boundaries, and any invalidation. Never inferred from this record,
   * and never just a copy of a terminal's own `turn_id`. Supplying it alongside
   * a terminal authorizes a new Ready claim; supplying it alongside processing
   * evidence authorizes moving the row off a live held turn. Missing
   * provenance leaves the affected state `unknown`.
   */
  readonly currentRootTurnId?: string | null;
}

/**
 * One reducer input. `record` and `event` are untrusted, read defensively.
 */
export type NativeCodexEvidence = NativeCodexEvidenceScope & (
  | { readonly kind: "rollout"; readonly record: unknown }
  | { readonly kind: "hook"; readonly event: unknown }
  | { readonly kind: "source"; readonly signal: NativeCodexSourceSignal }
);

/**
 * Status fields this reducer can support. The shape is the subset of a
 * session-host status update the native Codex sources can justify: `busy` plus
 * the bounded activity lines. `pendingInput` is only an optional passthrough
 * for the separately owned question source — this reducer never derives it, and
 * `inputSurface`, native-session metadata, and every work count stay outside
 * this slice entirely.
 */
export interface NativeCodexStatusFields {
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly activity: readonly string[];
}

/* ---------------------------------------------------------- hook metadata */

/**
 * Allowlisted hook stdin metadata. Only these fields are ever read out of a
 * hook event object; `prompt`, `tool_input`, `tool_response`,
 * `last_assistant_message`, `cwd`, and `transcript_path` are dropped at this
 * edge so payload text cannot reach reducer state or presentation.
 */
export interface NativeCodexHookMetadata {
  /** `hook_event_name`, e.g. `UserPromptSubmit`, `PreToolUse`, `Stop`. */
  readonly event: string;
  /** Codex turn scope; null when the event carries none or an unusable one. */
  readonly turnId: string | null;
  /**
   * True when a scope field (`turn_id`, `agent_id`, `tool_name`) was present
   * but unusable. A recognized root processing event with an unusable scope is
   * a malformed status record and must degrade the row, not be ignored.
   */
  readonly scopeInvalid: boolean;
  /** Non-empty only for sub-agent events (never root authority). */
  readonly agentId: string | null;
  /** Canonical hook tool name for tool events; null otherwise. */
  readonly toolName: string | null;
  /** `SessionStart` source (`startup`, `clear`, `fork`, `resume`, `compact`). */
  readonly source: string | null;
}

/**
 * Extracts the allowlisted hook metadata from one raw hook stdin object.
 * Returns null only when the value is not a hook input at all (not an object,
 * or no usable `hook_event_name`); a recognized event with an unusable scope
 * field is returned with {@link NativeCodexHookMetadata.scopeInvalid} set so
 * the caller-side reducer can degrade instead of ignoring it.
 */
export function parseNativeCodexHookMetadata(raw: unknown): NativeCodexHookMetadata | null {
  if (!isRecord(raw)) return null;
  const event = readBoundedString(raw.hook_event_name, NATIVE_CODEX_MAX_TOOL_NAME_CHARS);
  if (event.state !== "value") return null;
  const turnId = readBoundedString(raw.turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  const agentId = readBoundedString(raw.agent_id, NATIVE_CODEX_MAX_TOOL_NAME_CHARS);
  const toolName = readBoundedString(raw.tool_name, NATIVE_CODEX_MAX_TOOL_NAME_CHARS);
  const source = readBoundedString(raw.source, NATIVE_CODEX_MAX_TOOL_NAME_CHARS);
  return {
    event: event.value,
    turnId: turnId.state === "value" ? turnId.value : null,
    // An unusable scope field is never silently treated as "absent".
    scopeInvalid: turnId.state === "invalid" || agentId.state === "invalid" || toolName.state === "invalid",
    agentId: agentId.state === "value" ? agentId.value : null,
    toolName: toolName.state === "value" ? toolName.value : null,
    source: source.state === "value" ? source.value : null,
  };
}

/* ------------------------------------------------------- candidate lines */

/**
 * Classification of one raw rollout line before it becomes reducer input. The
 * reader owns line splitting; this only decides whether a line can be a status
 * candidate at all, so an oversized or undecodable line degrades state instead
 * of being guessed at.
 */
export type NativeCodexCandidateLine =
  | { readonly status: "record"; readonly record: unknown }
  /** Blank line: not a status record and not a failure. */
  | { readonly status: "blank" }
  | { readonly status: "oversized" }
  | { readonly status: "malformed" };

/** Classifies one candidate rollout line against the reducer's bounds. */
export function classifyNativeCodexCandidate(line: string): NativeCodexCandidateLine {
  if (line.trim().length === 0) return { status: "blank" };
  if (line.length > NATIVE_CODEX_MAX_CANDIDATE_CHARS) return { status: "oversized" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { status: "malformed" };
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return { status: "malformed" };
  return { status: "record", record: parsed };
}

/* ------------------------------------------------------------------- api */

/** Fresh unknown state. */
export function createNativeCodexStatusState(options: NativeCodexStatusOptions = {}): NativeCodexStatusState {
  const bound = readBoundedString(options.rootThreadId, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  const generation = readBoundedString(options.generation, NATIVE_CODEX_MAX_GENERATION_CHARS);
  return {
    phase: "unknown",
    rootThreadId: bound.state === "value" ? bound.value : null,
    generation: generation.state === "value" ? generation.value : null,
    observedTurnId: null,
    terminatedTurnIds: [],
    activity: [],
  };
}

/**
 * Folds one piece of native Codex evidence into the foreground state. Pure: the
 * input state is never mutated, and an unrecognized or irrelevant record is
 * returned unchanged with none of its contents retained. Ready is granted only
 * when the caller's `currentRootTurnId` provenance matches the held turn.
 */
export function reduceNativeCodexStatus(
  state: NativeCodexStatusState,
  evidence: NativeCodexEvidence,
): NativeCodexStatusState {
  const generation = readBoundedString(evidence.generation, NATIVE_CODEX_MAX_GENERATION_CHARS);
  const tagged = generation.state === "value" ? generation.value : null;
  if (tagged !== null && state.generation !== null && tagged !== state.generation
    && !(evidence.kind === "source" && evidence.signal === "rebind")) {
    // Evidence tagged to another binding generation describes a different scope:
    // dropped outright, never adopted, and its content is never retained.
    return state;
  }
  // The caller's verified current root turn, or null when the caller does not
  // attest currentness. Null never authorizes a Ready claim or a takeover.
  const current = readBoundedString(evidence.currentRootTurnId, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  const currentTurn = current.state === "value" ? current.value : null;
  switch (evidence.kind) {
    case "rollout":
      return reduceRolloutRecord(state, evidence.record, currentTurn);
    case "hook":
      return reduceHookEvent(state, evidence.event, currentTurn);
    case "source":
      return reduceSourceSignal(state, evidence.signal, tagged);
  }
}

/**
 * Projects the reducer state into the status fields it can support. `busy` is
 * null while the row's foreground is unknown; `pendingInput` is the caller's
 * own value (null = unknown) and is never inferred here.
 */
export function projectNativeCodexStatus(
  state: NativeCodexStatusState,
  passthrough: { readonly pendingInput?: boolean | null } = {},
): NativeCodexStatusFields {
  return {
    busy: state.phase === "running" ? true : state.phase === "ready" ? false : null,
    pendingInput: passthrough.pendingInput ?? null,
    activity: [...state.activity],
  };
}

/* ------------------------------------------------------- rollout records */

/**
 * Rollout wire records are flattened:
 * `{"timestamp":…,"ordinal":…,"type":"event_msg","payload":{…}}`, and the
 * payload's own `type` tag is snake_case (`task_started`, `task_complete`,
 * `turn_aborted`, `item_completed`, and, in legacy history mode,
 * `patch_apply_end`, `mcp_tool_call_end`, `web_search_end`).
 * `TurnItem` tags inside `item_completed` are the native variant names
 * (`CommandExecution`, `FileChange`, `McpToolCall`, …).
 */
function reduceRolloutRecord(
  state: NativeCodexStatusState,
  record: unknown,
  currentTurn: string | null,
): NativeCodexStatusState {
  if (!isRecord(record) || typeof record.type !== "string") return degrade(state);
  switch (record.type) {
    case "event_msg":
      return reduceEventMsg(state, isRecord(record.payload) ? record.payload : undefined, currentTurn);
    case "session_meta":
      // Identity binding and corroboration belong to the caller: a session_meta
      // never starts, ends, or refreshes a turn, and none of its content is
      // retained here. A record for another thread is simply irrelevant.
      return state;
    default:
      // response_item, compacted, turn_context, token_count, world_state,
      // inter-agent records, retained context, and any newer record kind carry
      // no root-turn foreground authority. Their text is never read.
      return state;
  }
}

function reduceEventMsg(
  state: NativeCodexStatusState,
  payload: Record<string, unknown> | undefined,
  currentTurn: string | null,
): NativeCodexStatusState {
  // An event_msg envelope without a payload object is a malformed candidate.
  if (!payload || typeof payload.type !== "string") return degrade(state);
  switch (payload.type) {
    case "task_started":
    case "turn_started": {
      // `turn_id` is required on the wire. A start without usable scope is a
      // malformed status record, not an irrelevant one: it may describe real
      // processing whose scope was lost, so the row degrades.
      const scope = readTurnScope(payload);
      if (scope.state === "descendant") return state;
      if (scope.state !== "bound") return degrade(state);
      return noteProcessing(state, scope.turnId, currentTurn);
    }
    // Both durable terminals end the turn; `turn_aborted` may carry a null
    // turn id, which simply fails to bind.
    case "task_complete":
    case "turn_complete":
    case "turn_aborted":
      return noteTerminal(state, payload, currentTurn);
    case "item_completed":
      return reduceItemCompleted(state, payload, currentTurn);
    case "patch_apply_end":
      return noteLegacyTool(state, payload, "Edit", currentTurn);
    case "mcp_tool_call_end":
      return noteLegacyTool(state, payload, "MCP tool", currentTurn);
    case "web_search_end":
      return noteLegacyTool(state, payload, "Web search", currentTurn);
    default:
      // user_message, agent_message, agent_reasoning, context_compacted,
      // token_count, plan_update, review-mode markers, and any newer event are
      // irrelevant to foreground state; their text is never surfaced.
      return state;
  }
}

/** Persisted tool items are the only `item_completed` foreground witnesses. */
function reduceItemCompleted(
  state: NativeCodexStatusState,
  payload: Record<string, unknown>,
  currentTurn: string | null,
): NativeCodexStatusState {
  if (!threadMatchesBinding(state, payload.thread_id)) return state;
  const item = isRecord(payload.item) ? payload.item : undefined;
  if (!item || typeof item.type !== "string") return degrade(state);
  const label = nativeCodexItemLabel(item.type);
  if (label === null) return state;
  // A persisted root tool item is processing evidence, so lost scope on one is
  // a malformed status record rather than an irrelevant payload.
  const scope = readTurnScope(payload);
  if (scope.state === "descendant") return state;
  if (scope.state !== "bound") return degrade(state);
  return noteProcessing(state, scope.turnId, currentTurn, label);
}

/**
 * Legacy-history tool witnesses. Their `turn_id` defaults to an empty string in
 * older records, so an absent id contributes activity without claiming a turn.
 */
function noteLegacyTool(
  state: NativeCodexStatusState,
  payload: Record<string, unknown>,
  label: string,
  currentTurn: string | null,
): NativeCodexStatusState {
  const scope = readTurnScope(payload);
  if (scope.state === "invalid") return degrade(state);
  if (scope.state !== "bound") return pushActivity(state, label);
  return noteProcessing(state, scope.turnId, currentTurn, label);
}

/* ----------------------------------------------------------- hook events */

function reduceHookEvent(
  state: NativeCodexStatusState,
  raw: unknown,
  currentTurn: string | null,
): NativeCodexStatusState {
  const meta = parseNativeCodexHookMetadata(raw);
  if (meta === null) return state;
  // agent_id-first routing: a sub-agent event is never root authority, even
  // when it carries the parent's transcript path and the shared lineage id.
  if (meta.agentId !== null) return state;
  switch (meta.event) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse": {
      // These events always carry a turn scope on the wire. A missing or
      // unusable one means the scope of real processing evidence was lost, so
      // the row cannot keep a supported foreground claim: degrade it.
      if (meta.scopeInvalid || meta.turnId === null) return degrade(state);
      const label = meta.event === "UserPromptSubmit" ? undefined : nativeCodexHookToolLabel(meta.toolName);
      // A null label suppresses the activity line only (question and permission
      // tools must not imply pending input). The scoped tool attempt itself is
      // still root processing evidence, so the foreground must not stay Ready.
      return noteProcessing(state, meta.turnId, currentTurn, label ?? undefined);
    }
    case "SessionStart":
      // Compaction keeps the same thread and the same turn scope; every other
      // session-start source (startup, clear, fork, resume, or an unrecognized
      // one) puts earlier observations out of scope.
      return meta.source === "compact" ? state : resetState(state);
    default:
      // Stop and SubagentStop are not turn terminals — a blocking Stop hook
      // continues the same turn. Interrupt, PreCompact/PostCompact, SessionEnd,
      // sub-agent lifecycle, model-request hooks, and PermissionRequest carry
      // no root-terminal and no input-surface witness.
      return state;
  }
}

/* ------------------------------------------------------- source signals */

function reduceSourceSignal(
  state: NativeCodexStatusState,
  signal: NativeCodexSourceSignal,
  generation: string | null,
): NativeCodexStatusState {
  // A rebind means the records that follow describe a different root thread, so
  // the whole turn correlation is out of scope, and the caller's current
  // generation (if tagged) replaces the previous one. Everything else only
  // removes the guarantee that the current claim is complete: the claim becomes
  // unknown, and only evidence not yet consumed can re-establish it.
  return signal === "rebind" ? resetState(state, generation ?? state.generation) : degrade(state);
}

/* ------------------------------------------------------------- internals */

/** Turn scope read out of one native record. */
type NativeCodexTurnScope =
  | { readonly state: "bound"; readonly turnId: string }
  /** A nested (for example sub-agent) turn: irrelevant to the root row. */
  | { readonly state: "descendant" }
  /** No usable turn id: this record cannot be correlated with a root turn. */
  | { readonly state: "missing" }
  /** Structurally invalid field: the candidate record is not trustworthy. */
  | { readonly state: "invalid" };

function readTurnScope(payload: Record<string, unknown>): NativeCodexTurnScope {
  const turn = readBoundedString(payload.turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  if (turn.state === "invalid") return { state: "invalid" };
  if (turn.state === "absent") return { state: "missing" };
  const root = readBoundedString(payload.root_turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  if (root.state === "invalid") return { state: "invalid" };
  // `root_turn_id` equals `turn_id` for root turns; a different id is a nested
  // (for example sub-agent) turn and can never drive the root row.
  if (root.state === "value" && root.value !== turn.value) return { state: "descendant" };
  return { state: "bound", turnId: turn.value };
}

/**
 * Positive processing evidence for one bound root turn.
 *
 * A different turn may take over the row only when no live, unterminated turn
 * is held (nothing to clobber, or the held turn already reached its durable
 * terminal) or when the caller attests that this turn is the current root turn.
 * Otherwise the newcomer is ambiguous — replay, stale hook, or an evicted
 * tombstone — and it gains no Ready authority while the row degrades.
 */
function noteProcessing(
  state: NativeCodexStatusState,
  turnId: string,
  currentTurn: string | null,
  toolLabel?: string,
): NativeCodexStatusState {
  // A terminal already consumed for this turn outranks any later-arriving start
  // or tool record for it.
  if (state.terminatedTurnIds.includes(turnId)) return state;
  const held = state.observedTurnId;
  if (held !== null && held !== turnId && !state.terminatedTurnIds.includes(held)
    && currentTurn !== turnId) {
    return degrade(state);
  }
  const changedTurn = held !== turnId;
  const base: NativeCodexStatusState = {
    ...state,
    phase: "running",
    observedTurnId: turnId,
    activity: changedTurn ? [] : state.activity,
  };
  return toolLabel === undefined ? base : pushActivity(base, toolLabel);
}

/**
 * Durable root terminal witness: Ready only when it is bound to the currently
 * observed root turn. Any other terminal is tombstoned and degrades the row,
 * because it proves the observed model of this row's turn is incomplete.
 */
function noteTerminal(
  state: NativeCodexStatusState,
  payload: Record<string, unknown>,
  currentTurn: string | null,
): NativeCodexStatusState {
  const scope = readTurnScope(payload);
  if (scope.state === "invalid") return degrade(state);
  // A descendant's own terminal says nothing about the root row: ignore it
  // rather than degrading a claim that is still correctly supported.
  if (scope.state === "descendant") return state;
  if (scope.state === "missing") {
    // `turn_aborted` legitimately carries a null turn id, so an unbindable
    // terminal is not proof of malformed input — but it is still not proof that
    // THIS row's turn ended, so the row degrades instead of claiming Ready.
    return degrade(state);
  }
  const turnId = scope.turnId;
  // A consumed terminal never grants Ready again. After a gap, an
  // invalidation, or any duplicate delivery, replaying the same durable record
  // is not fresh evidence, and the gap may have hidden a newer live turn.
  if (state.terminatedTurnIds.includes(turnId)) return state;
  if (state.observedTurnId === turnId) {
    // Matching the held turn is not enough once currentness is uncertain: a gap
    // can hide this turn's completion plus a newer turn's start, and a newer
    // processing witness already proved the hold may be stale. Only the caller's
    // verified current-root-turn provenance grants the Ready claim. Without it
    // the row degrades and the terminal stays unconsumed, so an attested
    // delivery can still land later.
    if (currentTurn !== turnId) return degrade(state);
    return {
      ...state,
      phase: "ready",
      terminatedTurnIds: trackedPush(state.terminatedTurnIds, turnId),
    };
  }
  // A terminal for a turn this row never held proves the view is incomplete.
  return { ...degrade(state), terminatedTurnIds: trackedPush(state.terminatedTurnIds, turnId) };
}

/** Unknown foreground, keeping the turn correlation so a later bound terminal can restore Ready. */
function degrade(state: NativeCodexStatusState): NativeCodexStatusState {
  if (state.phase === "unknown") return state;
  return { ...state, phase: "unknown" };
}

/** New scope: everything previously observed is out of scope. */
function resetState(state: NativeCodexStatusState, generation: string | null = state.generation): NativeCodexStatusState {
  if (state.phase === "unknown" && state.observedTurnId === null && state.activity.length === 0
    && state.terminatedTurnIds.length === 0 && state.generation === generation) {
    return state;
  }
  return { ...createNativeCodexStatusState({ rootThreadId: state.rootThreadId, generation }) };
}

function pushActivity(state: NativeCodexStatusState, label: string): NativeCodexStatusState {
  const line = sanitizeActivityLine(label);
  if (line.length === 0 || state.activity.at(-1) === line) return state;
  const activity = [...state.activity, line].slice(-MAX_ACTIVITY_LINES);
  return { ...state, activity };
}

function trackedPush(ids: readonly string[], turnId: string): string[] {
  if (ids.includes(turnId)) return [...ids];
  return [...ids, turnId].slice(-NATIVE_CODEX_MAX_TRACKED_TURNS);
}

/** True when a record's thread id cannot contradict the caller's root binding. */
function threadMatchesBinding(state: NativeCodexStatusState, threadId: unknown): boolean {
  if (state.rootThreadId === null) return true;
  const candidate = readBoundedString(threadId, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  // A missing or unusable thread id cannot contradict the binding; the caller
  // already owns the positive binding for this stream.
  if (candidate.state !== "value") return true;
  return candidate.value === state.rootThreadId;
}

type NativeCodexField =
  | { readonly state: "absent" }
  | { readonly state: "value"; readonly value: string }
  | { readonly state: "invalid" };

function readBoundedString(value: unknown, maxChars: number): NativeCodexField {
  if (value === undefined || value === null) return { state: "absent" };
  if (typeof value !== "string") return { state: "invalid" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { state: "absent" };
  if (trimmed.length > maxChars) return { state: "invalid" };
  return { state: "value", value: trimmed };
}

/**
 * Closed vocabulary of persisted `TurnItem` kinds that are tool activity. Text
 * and lifecycle items (`AgentMessage`, `Reasoning`, `Plan`, `UserMessage`,
 * `ContextCompaction`, review-mode markers, extension items) and the
 * sub-agent/collab items are excluded: the latter describe descendants, and the
 * rest are not tool activity.
 */
function nativeCodexItemLabel(itemType: string): string | null {
  switch (itemType) {
    case "CommandExecution":
      return "Exec";
    case "FileChange":
      return "Edit";
    case "McpToolCall":
      return "MCP tool";
    case "DynamicToolCall":
      return "Tool";
    case "FunctionCallOutput":
      return "Tool";
    case "WebSearch":
      return "Web search";
    case "ImageView":
      return "Image view";
    default:
      return null;
  }
}

/**
 * Hook `tool_name` to the same closed vocabulary. Canonical names come from the
 * pinned Codex hook tool identities (`Bash`, `apply_patch`, `spawn_agent`,
 * `mcp__<server>__<tool>`, dynamic names); the extra aliases are tolerated
 * because the value is only ever used to pick a label, never echoed.
 *
 * Approval and question tools (`request_permissions`, `request_user_input`) map
 * to null so no activity line can imply pending input. That is activity
 * suppression only: a scoped hook for one of them still counts as root
 * processing evidence and can move the row off a Ready claim.
 */
function nativeCodexHookToolLabel(toolName: string | null): string | null {
  if (toolName === null) return "Tool";
  const name = toolName.toLowerCase();
  if (name.startsWith("mcp__")) return "MCP tool";
  switch (name) {
    case "bash":
    case "shell":
    case "local_shell":
    case "unified_exec":
    case "exec":
    case "write_stdin":
      return "Exec";
    case "apply_patch":
    case "edit":
    case "write":
      return "Edit";
    case "web_search":
      return "Web search";
    case "view_image":
      return "Image view";
    case "read_file":
    case "read":
      return "Read";
    case "spawn_agent":
    case "agent":
      return "Sub-agent";
    case "request_permissions":
    case "request_user_input":
      return null;
    default:
      return "Tool";
  }
}
