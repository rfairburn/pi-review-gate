/**
 * Owned-run Claude native completion + count ACQUISITION controller
 * (native Claude sidebar status source phase).
 *
 * One controller observes exactly one owned native Claude run. It consumes the
 * already-authenticated, already-sanitized {@link NativeHookEvent} values the
 * landed native hook lane delivers for that run, reduces them through the landed
 * pure {@link NativeClaudeStatusReducer}, and — separately — reads the ONE
 * transcript file the provider itself named in that run's own hook payloads to
 * confirm a REAL root turn end from the persisted `stop_hook_summary` row, to
 * settle a question request the provider never closed on the hook lane, and to
 * keep the native count snapshot honest while it is published. The owner may also
 * hand this controller the one fact only the owner has — that it launched this
 * exact process and has given it no input — through
 * {@link NativeClaudeAcquisitionController.observeOwnedStartup}. Nothing here is
 * wired to the manager, launch, broker registration, PTY, or sidebar by itself;
 * the caller owns that.
 *
 * What "acquisition" means concretely, and its honest limits:
 *
 * 1. Ready is source-confirmed, never a Stop-hook shortcut. The landed reducer
 *    refuses to mark a turn ended from this observer's own `Stop` hook, and this
 *    controller never asks it to. It reads the persisted root
 *    `system/stop_hook_summary` row (written once, AFTER every Stop hook has
 *    answered) and hands the reducer only the booleans and array-emptiness it
 *    actually read. Two witnesses the source report describes are deliberately
 *    NOT used: the `system/informational` block-cap warning (recognizing it means
 *    matching provider English text) and `system/turn_duration` (the runner
 *    defers it while background work is outstanding, so a duration row that
 *    appears after a barrier cannot be shown to belong to the armed turn — the
 *    row carries no prompt or turn correlation). A turn whose only terminal
 *    evidence is one of those two stays unknown, which is reported as a concrete
 *    gap rather than closed with a guess.
 * 1b. The idle baseline of a run the host itself launched. `observeOwnedStartup()`
 *    is called by the owner in the same synchronous stretch that binds this run to
 *    its live PTY incarnation, BEFORE any input can reach the child, so the row is
 *    known idle, none-pending, and 0/0 from the moment it exists rather than after
 *    whichever hook happens to arrive first. The evidence is the spawn, which only
 *    the owner holds; a controller that already observed work refuses the claim, a
 *    second call changes nothing, and any accepted prompt, tool edge, provider
 *    count snapshot, session end, hook-lane loss, or newer observed root row ends
 *    the vouch. Independently, a root `SessionStart` whose own payload names
 *    `source` `startup` or `clear` can establish the same baseline, but only after
 *    ONE bounded read of the run's own transcript proves the file holds no
 *    conversation row — `resume`, `compact`, `fork`, an unreadable source, an
 *    unreadable or covered-only-partly transcript, and a start sitting on recorded
 *    work all publish nothing. A brand-new provider process states its own empty
 *    background set: those zeros are observed, never reconstructed, and every
 *    later membership fact replaces or withdraws them on its own evidence.
 * 1c. A question request the hook lane never closed. `PreToolUse` for
 *    `AskUserQuestion` opens a request, `Post*` closes it, but a DECLINED or
 *    cancelled question can bypass the Post hook entirely and strand the row as
 *    pending. The same file answers that: a persisted ROOT `user` row whose
 *    `message.content` carries a `tool_result` block naming an open request's
 *    `tool_use_id` is that request's own terminal evidence, and the closure
 *    compares identities only — no answer, error text, `is_error` outcome, or
 *    English phrase is read or matched, because this source makes no claim about
 *    whether a question was answered. A root turn whose terminal record was read
 *    also ends the root requests still open in it, while a subagent's still-open
 *    request in another conversation is never touched by either path.
 * 2. A read barrier, not a fake identity. Native JSONL rows carry no `promptId`,
 *    so this controller invents none. The barrier is a byte offset: the broker
 *    invokes a source callback BEFORE it writes the fixed ACK, the relay exits
 *    after that ACK, and the provider writes the summary only after the whole
 *    Stop pass completes — so a synchronous size read of the bound transcript
 *    inside the `Stop` callback is strictly earlier than that turn's summary
 *    append. Only records that START at or after that offset can witness the
 *    current turn (the tail reader verifies the byte before every window, so a
 *    record that began before the barrier is never adopted, and a record that
 *    begins exactly on it is never lost). The `prompt_id` this run's own hook
 *    payload carried for that boundary travels with the read, so a witness whose
 *    turn has been superseded is refused even if the read lands late.
 * 3. Session admission is checked before anything else happens. Acquisition keeps
 *    its own positively bound session even after the reducer's scope has been
 *    released by invalidation, so an event naming a different native conversation
 *    is refused before it can be reduced into this run's foreground state: a
 *    foreign `UserPromptSubmit` must never publish foreign running state and then
 *    make this run's own legitimate hooks `stale-session`. A genuine root
 *    `SessionStart` is the one exception — it rebinds. Then the reducer's verdict
 *    is taken: an edge refused as `stale-session`, `stale-prompt`, or
 *    `scope-closed` drives no acquisition effect whatsoever — no published count,
 *    no transcript rebind, no armed read, and no retirement of a live one. Only
 *    an admitted event can move acquisition state.
 * 4. New accepted root work retires the armed read. A newer `UserPromptSubmit`
 *    or a positively observed root `PreToolUse` retires the arm, its generation,
 *    and any in-flight result, independently of whether any prompt correlation
 *    was carried. Optional metadata is never the only fence.
 * 5. `sourceToken` is local hygiene. The token passed to the reducer identifies
 *    THIS controller's generation and read attempt, so a re-read is idempotent
 *    and a stale callback is fenceable. It is never presented as, and cannot
 *    become, proof of a native conversation identity.
 * 6. Counts are last-reported snapshots, not a census. The only native count
 *    this controller carries is the ROOT `Stop` hook's own `background_counts`
 *    projection: present (including 0/0) is a real observed snapshot, absent or
 *    unreadable is unknown (never a zero), and a `SubagentStop` snapshot is never
 *    used as root scope. A published snapshot is dropped only by what can
 *    actually contradict it — a newer ROOT `Stop` payload, a task transition the
 *    transcript positively shows, a scope change, or a loss of the authenticated
 *    hook lane — and never merely because some other event arrived. Ordinary new
 *    foreground work (a prompt, tool use, or a newer root model row in the
 *    transcript) says nothing about background membership, so the last reported
 *    numbers stay published as last-reported until one of those invalidators
 *    lands. Nothing reconstructs a count from activity, quietness, or a missing
 *    snapshot, and no published number is presented as a continuously live
 *    census: it is what this run's own root `Stop` last stated, for display.
 *    The live `system/background_tasks_changed` level is unreachable on this
 *    hook/PTY route by design, so it is never probed and never reported as a
 *    failed probe.
 * 7. Published state stays monitored. Terminal-witness arming and fixed-file
 *    validity/count monitoring are separate: while a count snapshot or a
 *    source-confirmed Ready is published, the watcher stays attached and reads
 *    continue, so a structured task transition in the transcript
 *    (`attachment/task_status`, a `queued_command` whose `origin.kind` is
 *    `task-notification` or whose `origin.producer` is `session-task`, or a
 *    `toolUseResult.status` of `async_launched`) invalidates the published counts,
 *    a positively observed NEW ROOT model row in that file withdraws the published
 *    foreground and activity to unknown, and a later replacement or truncation of
 *    the bound file withdraws the transcript-derived state. Rootness comes
 *    from closed structural metadata only — the persisted turn-record `type` plus
 *    an actual `message` object, refused for `isSidechain`, an agent id, or a row
 *    naming another native session — never from prompt text, model prose, tool
 *    markup, tool output, or quietness. This is what keeps a published state honest
 *    when the hook lane goes silent without an authenticated failure: a whole new
 *    root turn whose hooks never arrive still contradicts the previous turn's
 *    `Ready` from the transcript alone, and the retired arm and generation mean
 *    its own later rows cannot restore it. Position and closed row kind, not the
 *    batch, decide a witness. Inside one append-ordered window a root model row
 *    that STARTS AFTER that window's first ROOT-ELIGIBLE root-summary candidate is
 *    newer work, and there the withdrawal still wins over the witness; a child,
 *    sidechain, agent-scoped, or other-labelled summary never sets that boundary,
 *    because the reducer would refuse it on those same extracted fields. A root
 *    model row that starts BEFORE that candidate is judged by what the row is: a
 *    persisted `assistant` row, or a persisted `user` row carrying its own
 *    `toolUseResult`, is the closing turn's own trailing flush — those rows land
 *    after this controller's size barrier seconds before the provider appends the
 *    summary, so an intervening read must not spend the armed pass on them — while
 *    a persisted `user` row with a `message` and no `toolUseResult` is the shape of
 *    a NEW root prompt and still retires the pass wherever it sits. With no
 *    witness published yet, a row that is not a new root prompt publishes nothing
 *    either: the arm simply stays open for a summary that has not been appended
 *    yet, and an older turn's summary can never reach it, because records that
 *    start before the barrier are never read. What is published also decides what
 *    a root row can contradict: a root model row withdraws a source-confirmed
 *    `Ready`, but while only a last-reported count is published the same row
 *    withdraws nothing — the file is still read so a membership transition can
 *    still correct the numbers, and ordinary root rows must not erase a healthy
 *    hook-derived foreground or question census. Only discriminators are read; no
 *    content. A watcher that cannot be created, or that reports an error,
 *    withdraws the transcript-derived state too — a source-confirmed `Ready` with
 *    no monitoring is not a defensible observation.
 *    Watch callbacks are fenced on the generation AND the watcher identity that
 *    attached them, so a retired watcher can neither wake a current read nor
 *    invalidate a newer scope.
 * 8. One file, bounded, private. Only the positively bound transcript path is
 *    ever opened; there is no HOME or session-directory search, no adoption of
 *    another native conversation, no periodic poll (the only re-read triggers are
 *    the watcher on that one file and the run's own hook events), and no
 *    retention, logging, or broadcast of any record text. Every complete record in
 *    a scanned window is validated before anything is committed, so a malformed
 *    row after a sufficient summary withdraws rather than publishing Ready.
 *
 * Failures withdraw, per lane. A missing/unreadable/replaced/truncated
 * transcript, a malformed or oversized record inside the scanned window, a window
 * too small to cover the barrier, or a watcher error retires the in-flight
 * generation and withdraws every claim READ FROM THAT FILE — the armed terminal
 * read, the scan cursor, and a source-confirmed `Ready` — so a late read or watch
 * callback from that generation restores nothing. Only a loss of the
 * authenticated hook lane also withdraws the count snapshot, because that value
 * came from the lane that failed: a transcript this controller cannot read says
 * nothing about background membership, so it never silently nulls a count the
 * provider itself reported. The gap is still reported, and a retained count with
 * no live file behind it simply stays the last thing that was stated. Nothing
 * here collapses to zero, and nothing here keeps a stale Ready.
 */

import { lstatSync, watch, type Stats } from "node:fs";

import { isRecord } from "../record-guard";
import {
  isNativeClaudeFreshStartSource,
  NativeClaudeStatusReducer,
  type NativeClaudeReduceReason,
  type NativeClaudeTerminalRecord,
} from "./native-claude-status";
import {
  readNativeJsonlTail,
  type NativeJsonlFileIdentity,
  type NativeJsonlTailFailureReason,
} from "./native-jsonl-tail";
import type { NativeHookBackgroundCounts, NativeHookEvent, NativeHookFailure } from "./native-hook-protocol";
import type { NativeCliBackend } from "./session-backend";
import type { NativeStatusObservation, NativeStatusSupportMap } from "./native-status";

/**
 * What this source can literally state about its own categories. Every category
 * is supported through actual observations: the foreground and activity come from
 * the authenticated hook lane, pending input from actual question edges, and the
 * two counts from actual ROOT `Stop` snapshots. A temporarily unverifiable value
 * stays unknown, which is exactly why no category here is `unsupported`. The
 * future integration owns the shared support map and may decorate this.
 */
export const NATIVE_CLAUDE_ACQUISITION_SUPPORT: NativeStatusSupportMap = Object.freeze({
  agent: "supported",
  input: "supported",
  tasks: "supported",
  shells: "supported",
  activity: "supported",
});

/** One complete observation of everything this controller knows right now. */
export interface NativeClaudeAcquisitionSnapshot extends NativeStatusObservation {
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly activity: readonly string[];
  readonly activeTasks: number | null;
  readonly activeShells: number | null;
  readonly support: NativeStatusSupportMap;
}

/**
 * Closed codes for a loss of the source this controller depends on. They name the
 * kind of loss only: no path, provider field, record text, or reason string from a
 * provider crosses this boundary.
 */
export type NativeClaudeAcquisitionGapReason =
  /** The authenticated lane reported a closed failure for this run's own hook. */
  | "hook-failure"
  /** No transcript path was ever positively bound for this run's own scope. */
  | "unbound-transcript"
  | "unavailable"
  | "unreadable"
  | "not-a-regular-file"
  | "symlink"
  /** The bound path's device/inode changed: the file behind the barrier is gone. */
  | "replaced"
  | "truncated"
  /** A record inside the scanned window was not readable JSON. */
  | "malformed"
  /** A record inside the scanned window exceeded the per-record bound. */
  | "oversized"
  /** The bounded window could not cover the barrier: records in between went unread. */
  | "skipped-window"
  | "watch-error"
  | "watch-unavailable";

export interface NativeClaudeAcquisitionOptions {
  /**
   * Descriptive identity of the owned run this controller belongs to. Never used
   * as a lookup key and never published in an observation.
   */
  readonly rowId: string;
  /** Backend this controller accepts hook values for; anything else is ignored. */
  readonly backend: NativeCliBackend;
  /**
   * Emits one COMPLETE snapshot whenever what this controller knows changes. A
   * snapshot it omits a value from is an unknown, never a hold-over, and nothing
   * is emitted for a duplicate of what the host already has.
   */
  readonly onSnapshot: (snapshot: NativeClaudeAcquisitionSnapshot) => void;
  /** Optional host notice of a source loss, as a closed code only. */
  readonly onSourceGap?: (reason: NativeClaudeAcquisitionGapReason) => void;
  /** Transcript read-window cap; defaults to the tail module's bound. */
  readonly maxTailBytes?: number;
  /** Per-record cap inside that window; defaults to the tail module's bound. */
  readonly maxLineBytes?: number;
  /**
   * File-watch seam. It is only ever called with the one positively bound
   * transcript path, and a throw from it is treated as a source failure that
   * withdraws published state rather than leaving it unmonitored. Defaults to
   * {@link fs.watch} on that path.
   */
  readonly watchFile?: NativeClaudeWatchFactory;
}

/** One file watch this controller owns. `close` is idempotent by contract. */
export interface NativeClaudeFileWatch {
  close(): void;
}

/** Callbacks the supplied watcher invokes for the bound path. */
export interface NativeClaudeWatchHandlers {
  onChange(): void;
  onError(error: unknown): void;
}

/** Creates one watch on one already-bound path; throwing means "cannot monitor". */
export type NativeClaudeWatchFactory = (path: string, handlers: NativeClaudeWatchHandlers) => NativeClaudeFileWatch;

/** One armed terminal read: the barrier, the file identity, and the turn it belongs to. */
interface ArmedRead {
  readonly generation: number;
  readonly byteOffset: number;
  readonly identity: NativeJsonlFileIdentity;
  /**
   * The prompt correlation this run's own hook payload carried for the turn this
   * boundary belongs to, when it carried one. It is native hook metadata, never a
   * field invented in the transcript, and it lets the reducer refuse a witness
   * whose turn has already been superseded by newer observed work.
   */
  readonly promptId: string | null;
}

/** One whole-window classification pass. Nothing is applied until it completes. */
interface WindowScan {
  readonly malformed: number;
  /** True when the window carried a structured native task/launch transition. */
  readonly transition: boolean;
  /**
   * True when the window carried a positively observed ROOT FOREGROUND row: a
   * persisted human PROMPT row or a root `assistant` model row. This is the only
   * kind of row that can outrank whatever this controller last published about the
   * foreground, and then only UNLESS a terminal witness for it is still being
   * sought and the row is only that closing turn's own trailing flush.
   */
  readonly foregroundWork: boolean;
  /**
   * True when the window carried a persisted ROOT `user` PROMPT row (a `message`
   * with no `toolUseResult`): a new root turn started, which retires an armed
   * terminal pass and outranks any published claim wherever that row sits.
   */
  readonly newRootPromptWork: boolean;
  /** Root-summary candidates in file order, capped, for the armed read. */
  readonly candidates: readonly NativeClaudeTerminalRecord[];
  /**
   * Index in the window of the FIRST ROOT-ELIGIBLE root-summary candidate, or -1
   * when the window carried none. Position decides a witness against it: a root
   * model row that starts after it is newer work than the turn that candidate
   * closed. A child, sidechain, agent-scoped, or other-labelled summary never
   * establishes that boundary.
   */
  readonly firstCandidateIndex: number;
  /** True when a positively observed root model row starts AFTER that candidate. */
  readonly foregroundWorkAfterCandidate: boolean;
  /**
   * Identities of ROOT `tool_result` rows in this window that match a question
   * request the reducer held open when the read started. Identities only: no
   * result body, answer, error text, or role prose crosses.
   */
  readonly questionClosures: readonly string[];
}

/** One live watcher plus the generation that attached it. */
interface ActiveWatch {
  readonly generation: number;
  readonly handle: NativeClaudeFileWatch;
}

/**
 * One pending corroboration of a fresh root `SessionStart`: the ONE read of the
 * run's own bound transcript that can show the new scope really began with no
 * prerecorded conversation. It carries no record text and no path beyond the
 * single bound file this controller already holds.
 */
interface FreshStartProbe {
  readonly generation: number;
  readonly path: string;
  readonly sessionId: string | null;
  /** Identity of the file to read, or null when the bound path did not exist. */
  readonly identity: NativeJsonlFileIdentity | null;
  /** True when the bound path was absent: nothing could have been recorded in it. */
  readonly absent: boolean;
}

/** Hook kinds that may establish this run's own root scope, mirroring the reducer. */
const ADOPTABLE_EVENTS: ReadonlySet<string> = new Set([
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);

/** Hook kinds that are positively observed new root work, ending an armed pass. */
const NEW_ROOT_WORK_EVENTS: ReadonlySet<string> = new Set(["UserPromptSubmit", "PreToolUse"]);

/** Bounded terminal candidates per window: more than this is a source we cannot rank. */
const MAX_TERMINAL_CANDIDATES = 8;

/** Bounded `tool_result` identities extracted from one window. */
const MAX_QUESTION_CLOSURES_PER_WINDOW = 32;

/**
 * Reduction outcomes that mean the landed reducer refused this edge as belonging
 * to a session, prompt, or scope it positively observed is no longer current.
 * Such an event is not evidence for anything, so it drives no acquisition side
 * effect at all: no counts, no transcript rebind, no arm, and no retire.
 */
const STALE_REDUCTION_REASONS: ReadonlySet<NativeClaudeReduceReason> = new Set([
  "stale-session",
  "stale-prompt",
  "scope-closed",
  "duplicate-session-start",
]);

/**
 * The default file-watch seam: exactly one non-persistent `fs.watch` on the one
 * positively bound path.
 */
const defaultWatchFile: NativeClaudeWatchFactory = (path, handlers) => {
  const watcher = watch(path, { persistent: false }, () => handlers.onChange());
  watcher.on("error", (error) => handlers.onError(error));
  return { close: () => watcher.close() };
};

/**
 * Acquires source-confirmed root completion and real native count snapshots for
 * ONE owned native Claude run. Constructed per owned run; never shared, never a
 * registry, and never reachable from a wire frame or a child.
 */
export class NativeClaudeAcquisitionController {
  readonly rowId: string;

  readonly #backend: NativeCliBackend;
  readonly #onSnapshot: (snapshot: NativeClaudeAcquisitionSnapshot) => void;
  readonly #onSourceGap: ((reason: NativeClaudeAcquisitionGapReason) => void) | undefined;
  readonly #maxTailBytes: number | undefined;
  readonly #maxLineBytes: number | undefined;
  readonly #watchFile: NativeClaudeWatchFactory;

  readonly #reducer = new NativeClaudeStatusReducer();

  /**
   * Local generation fence. Bumped by a scope rebind, accepted new root work, an
   * invalidation, a source failure, and disposal, so a read that started earlier,
   * or a watch callback queued earlier, can never write anything.
   */
  #generation = 0;
  #disposed = false;

  /** Root native session identity positively bound from this run's own events. */
  #sessionId: string | null = null;
  /** The ONE transcript path the provider named for that scope. */
  #transcriptPath: string | null = null;
  /** Absolute offset through the last complete record positively scanned. */
  #cursor: number | null = null;
  /** Identity of the file the cursor belongs to; a change is a replacement. */
  #identity: NativeJsonlFileIdentity | null = null;
  #armed: ArmedRead | null = null;
  /** True once THIS pass' terminal witness was applied, so no second witness is sought. */
  #terminalAccepted = false;
  /** True while a Ready READ FROM THIS FILE is published and still defensible. */
  #readyPublished = false;
  /** One pending fresh-start corroboration read, or null. */
  #freshProbe: FreshStartProbe | null = null;
  /**
   * True while the host's own launch of THIS run vouches an empty baseline: the
   * process was started by this owner, nothing has run in it, and it has received
   * no input. Real work, a provider count snapshot, a session end, a hook-lane
   * loss, an explicit invalidation, or newer observed transcript work all end it.
   */
  #startupVouched = false;
  /**
   * True once this controller has had to withdraw: after an invalidation, a
   * hook-lane loss, or a withdrawal for observed newer work, the launch-time
   * baseline is no longer something it can restate for this run, and a later
   * call claiming it is refused.
   */
  #baselineRetired = false;
  /** Last positive ROOT Stop count snapshot; null is unknown, never zero. */
  #counts: NativeHookBackgroundCounts | null = null;

  #watcher: ActiveWatch | null = null;
  #reading = false;
  #readAgain = false;
  #readSeq = 0;
  #last: NativeClaudeAcquisitionSnapshot | null = null;

  constructor(options: NativeClaudeAcquisitionOptions) {
    if (typeof options?.rowId !== "string" || options.rowId.trim() === "") {
      throw new RangeError("native Claude acquisition requires a rowId");
    }
    if (options.backend !== "claude") {
      throw new RangeError("native Claude acquisition accepts the claude backend only");
    }
    if (typeof options.onSnapshot !== "function") {
      throw new RangeError("native Claude acquisition requires an onSnapshot callback");
    }
    this.rowId = options.rowId;
    this.#backend = options.backend;
    this.#onSnapshot = options.onSnapshot;
    this.#onSourceGap = options.onSourceGap;
    this.#maxTailBytes = options.maxTailBytes;
    this.#maxLineBytes = options.maxLineBytes;
    this.#watchFile = typeof options.watchFile === "function" ? options.watchFile : defaultWatchFile;
  }

  /**
   * Consume one already-authenticated hook event for this owned run. Events for
   * another backend, and every event after disposal, are ignored without effect.
   */
  acceptHook(event: NativeHookEvent): void {
    if (this.#disposed) return;
    if (!isRecord(event) || event.backend !== this.#backend) return;

    const hookEventName = typeof event.hook_event_name === "string" ? event.hook_event_name : "";
    const isRoot = readToken((event as { agent_id?: unknown }).agent_id) === null;
    const eventSession = readToken((event as { session_id?: unknown }).session_id);
    const nextPath = readToken((event as { transcript_path?: unknown }).transcript_path);

    // Reducer invalidation releases the reducer's scope, not this owned run's
    // positively bound conversation. Without this fence a foreign-session event
    // would be adopted by the freshly released reducer, publish foreign running
    // state here, and then poison this run's own legitimate hooks as stale.
    // A genuine root `SessionStart` is the one event allowed to rebind.
    if (!(isRoot && hookEventName === "SessionStart")
      && this.#sessionId !== null
      && eventSession !== null
      && eventSession !== this.#sessionId) return;


    // A same-session change of transcript file is a real clear/resume/fork/reset
    // boundary: it is applied, and this event is then judged again against the
    // freshly reset scope rather than the one it arrived during.
    const pathRebound = isRoot
      && hookEventName !== "SessionStart"
      && hookEventName !== "SessionEnd"
      && this.#transcriptPath !== null
      && nextPath !== null
      && nextPath !== this.#transcriptPath;

    // The landed reducer decides admission FIRST. An edge it refuses as stale for
    // the session, prompt, or scope it positively observed is not evidence for
    // anything, so it may not publish counts, rebind the transcript, retire an
    // armed terminal read, or arm a new one.
    let reduction = this.#reducer.reduce(event);
    if (reduction.outcome === "ignored" && STALE_REDUCTION_REASONS.has(reduction.reason)) return;

    this.#noteScope(event, isRoot, hookEventName);
    if (pathRebound) reduction = this.#reducer.reduce(event);
    if (reduction.outcome === "invalid") {
      // A recognized payload this observer cannot read is a hook-lane gap: what
      // that lane supported collapses to unknown instead of surviving it.
      this.#hookLaneFailure("hook-failure");
      return;
    }

    // Only this run's own scope may contribute counts: an event naming a different
    // native conversation never replaces this run's own snapshot.
    const sameScope = this.#sessionId === null || eventSession === null || eventSession === this.#sessionId;
    if (sameScope) this.#noteCounts(event, isRoot, hookEventName);

    const admitted = reduction.outcome === "applied";

    // Accepted new root work ends the armed pass outright, independently of any
    // prompt correlation: an arm whose turn has been superseded, and any read
    // still in flight for it, can no longer publish.
    if (admitted && sameScope && isRoot && NEW_ROOT_WORK_EVENTS.has(hookEventName)) {
      this.#startupVouched = false;
      this.#retire();
    }

    if (admitted && sameScope && isRoot && hookEventName === "Stop") {
      this.#armTerminalRead(readToken((event as { prompt_id?: unknown }).prompt_id));
    } else if (admitted && sameScope && isRoot && (hookEventName === "StopFailure" || hookEventName === "SessionEnd")) {
      // Neither path can produce a terminal witness for this pass.
      this.#armed = null;
    }

    // A root `SessionStart` whose own payload names a new owned startup or a
    // `/clear` is the only boundary that can show a row idle before its first
    // prompt, and only once this controller has actually read the run's own
    // source and found nothing recorded in it. `resume`, `compact`, `fork`, an
    // unreadable source, a child start, and a start with no bound path all get
    // no corroboration and therefore no idle claim.
    if (admitted && sameScope && isRoot && hookEventName === "SessionStart"
      && !this.#startupVouched
      && isNativeClaudeFreshStartSource((event as { source?: unknown }).source)) {
      this.#armFreshStartProbe();
    }

    this.#syncWatcher();
    if (this.#shouldRead()) void this.#readTail();

    this.#emit();
  }

  /**
   * Consume one authenticated closed failure from this run's hook lane. One lost
   * event is a real observation gap: the supported observations collapse to
   * unknown and the in-flight generation is retired. Nothing is replayed.
   */
  acceptFailure(failure: NativeHookFailure): void {
    if (this.#disposed) return;
    if (!isRecord(failure) || failure.backend !== this.#backend) return;
    this.#hookLaneFailure("hook-failure");
  }

  /**
   * State the baseline the run's OWN owner can state for a native process it
   * launched itself and has given no input: idle, nothing pending, no background
   * work. The evidence is the spawn itself, so this is called once by the host in
   * the same synchronous stretch that binds this run to its live PTY
   * incarnation — before any input can reach the child, and with no provider hook
   * having arrived yet. It is not a general "the process looks quiet" shortcut:
   * if this controller already observed work, or the run's scope ended, the
   * reducer refuses it and nothing changes, and every later provider observation
   * replaces or withdraws the baseline exactly like any other source.
   */
  observeOwnedStartup(): void {
    if (this.#disposed || this.#startupVouched || this.#baselineRetired) return;
    const baseline = this.#reducer.observeOwnedStartup();
    if (baseline.outcome !== "applied") return;
    this.#startupVouched = true;
    // A process this host started a moment ago has registered no background work
    // of its own: that is a positively observed zero for this run, not a
    // reconstruction, and any later ROOT `Stop` snapshot, task transition, scope
    // change, or lane loss replaces or withdraws it on its own evidence.
    this.#counts = { tasks: 0, shells: 0 };
    this.#syncWatcher();
    this.#emit();
  }

  /**
   * Stop vouching for everything this controller last reported. Values become
   * unknown (never zero, never a stale Ready), the transcript read is retired, and
   * the watcher is closed. The caller keeps ownership of its own capture seam and
   * of minting any fresh capture for recovery; this call neither mints nor retires
   * one, and no later callback from the retired generation restores anything.
   */
  invalidate(): void {
    if (this.#disposed) return;
    this.#startupVouched = false;
    this.#baselineRetired = true;
    this.#retire();
    // An explicit withdrawal is the caller taking back every claim, including the
    // hook-payload snapshot it last saw published.
    this.#counts = null;
    this.#reducer.invalidate();
    this.#emit();
  }

  /**
   * Final cleanup: closes this controller's own watcher and retires its
   * generation. It kills no process, deletes no provider history or transcript,
   * and is idempotent.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#startupVouched = false;
    this.#baselineRetired = true;
    this.#retire();
    this.#counts = null;
    this.#sessionId = null;
    this.#transcriptPath = null;
  }

  // --- scope binding -------------------------------------------------------

  /**
   * Bind the run's own ROOT scope and its ONE transcript path from the hook
   * payload the provider itself produced. A child event never binds or mutates
   * the binding. A root `SessionStart` always rebinds, including onto a brand-new
   * session id, because the landed reducer adopts that same event: acquisition
   * must never stay bound to the conversation it replaces. Any other event naming
   * a different native session never mutates it — that is another conversation.
   * The same session naming a DIFFERENT file is a real clear/resume/fork/reset
   * boundary, so the reducer's derived observations are invalidated with it and
   * an old Ready or question claim cannot survive even when the accompanying
   * event is one the reducer itself ignores.
   */
  #noteScope(event: NativeHookEvent, isRoot: boolean, hookEventName: string): void {
    if (!isRoot) return;
    const sessionId = readToken((event as { session_id?: unknown }).session_id);
    const transcriptPath = readToken((event as { transcript_path?: unknown }).transcript_path);

    // A root `SessionStart` always rebinds, even for a brand-new session id: the
    // landed reducer adopts it too, and acquisition must not stay bound to the
    // conversation it replaces. Every other event is checked against the scope.
    if (hookEventName === "SessionStart") {
      this.#resetScope(sessionId, transcriptPath);
      // The host's own launch vouches this process's empty baseline across its own
      // start notice, so the run does not blink through unknown while the provider
      // reports the boundary the host already knows. A scope this controller has
      // been observing work in never held the vouch and stays unknown.
      if (this.#startupVouched) this.#counts = { tasks: 0, shells: 0 };
      return;
    }
    if (this.#sessionId !== null && sessionId !== null && sessionId !== this.#sessionId) return;

    if (hookEventName === "SessionEnd") {
      this.#startupVouched = false;
      this.#resetScope(null, null);
      return;
    }
    if (this.#sessionId === null) {
      if (sessionId !== null && ADOPTABLE_EVENTS.has(hookEventName)) {
        this.#sessionId = sessionId;
        this.#transcriptPath = transcriptPath;
      }
      return;
    }
    if (transcriptPath === null) return;
    if (this.#transcriptPath === null) {
      this.#transcriptPath = transcriptPath;
      return;
    }
    if (transcriptPath !== this.#transcriptPath) {
      this.#reducer.invalidate();
      this.#resetScope(this.#sessionId, transcriptPath);
    }
  }

  /** Drop every derived fact: a new scope inherits no Ready, count, or cursor. */
  #resetScope(sessionId: string | null, transcriptPath: string | null): void {
    this.#retire();
    this.#counts = null;
    this.#sessionId = sessionId;
    this.#transcriptPath = transcriptPath;
  }

  /**
   * Retire the in-flight read: closes the watcher and clears every fact derived
   * from the transcript lane. The ROOT `Stop` count snapshot is deliberately NOT
   * cleared here — retiring a read cursor, a generation, or a published `Ready`
   * says nothing about background membership, and only the snapshot's own
   * invalidators (a newer root snapshot, a transcript transition that positively
   * shows membership change, a scope change, or a hook-lane loss) withdraw it.
   */
  #retire(): void {
    this.#generation += 1;
    this.#armed = null;
    this.#freshProbe = null;
    this.#closeWatcher();
    this.#cursor = null;
    this.#identity = null;
    this.#terminalAccepted = false;
    this.#readyPublished = false;
    this.#readAgain = false;
  }

  // --- native counts -------------------------------------------------------

  /**
   * The only native count source this controller carries: the ROOT `Stop` hook's
   * own validated snapshot. Present (including 0/0) is a real observation; absent
   * or unreadable is unknown, never zero, and a newer root `Stop` replaces the
   * last snapshot with its own. Every other event — including a `SubagentStop`
   * snapshot, which is that subagent's array and never root scope, and including
   * ordinary new foreground work — leaves the last snapshot alone: an unrelated
   * edge is not evidence that background membership changed, so the numbers this
   * run's own root `Stop` reported stay published as last-reported until a
   * membership-changing transition row, a scope change, or a hook-lane loss
   * withdraws them. Nothing here replaces a snapshot with a child subset or a
   * reconstruction.
   */
  #noteCounts(event: NativeHookEvent, isRoot: boolean, hookEventName: string): void {
    if (!isRoot || hookEventName !== "Stop") return;
    // The provider's own snapshot is now the authority on this run's membership:
    // the launch-time baseline vouch is spent, and the numbers come from here on.
    this.#startupVouched = false;
    this.#counts = readBackgroundCounts(event);
  }

  // --- reading: terminal witness and published-state monitoring -------------

  /**
   * True while there is anything worth reading the file for: an armed terminal
   * read, or published state (a count snapshot, or ANY idle foreground claim the
   * reducer is currently making — a witness-confirmed `Ready` or a corroborated
   * fresh-start idle) whose validity, task transitions, and any newer ROOT model
   * row still have to be watched, or a question request the hook lane opened and
   * has never seen close — its closure can live only in this file, so a declined
   * question must not wait for some other event to be resolved.
   */
  #shouldRead(): boolean {
    return this.#armed !== null
      || this.#counts !== null
      || this.#idlePublished()
      || this.#reducer.openQuestionRequestIds().length > 0;
  }

  /**
   * True while the reducer publishes an idle foreground. A fresh-start idle is
   * not a claim READ from this file, but this file is still the only thing that
   * can contradict it once the hook lane goes silent, so it stays monitored.
   */
  #idlePublished(): boolean {
    return this.#reducer.snapshot().busy === false;
  }

  /**
   * Arm one bounded terminal read for the turn this root `Stop` boundary belongs
   * to. The barrier is this file's size read SYNCHRONOUSLY here: the broker
   * invokes this callback before it writes the relay's ACK, and the provider
   * appends the summary only after the whole Stop pass has answered, so this
   * offset is strictly earlier than that turn's summary row.
   */
  #armTerminalRead(promptId: string | null): void {
    this.#terminalAccepted = false;
    this.#armed = null;
    const stat = this.#statBound();
    if ("gap" in stat) {
      // The terminal claim this Stop would have made is withdrawn: no witness can
      // be read. The count snapshot this Stop just published is NOT withdrawn with
      // it — it came from the hook payload, not from this file.
      this.#transcriptFailure(stat.gap);
      return;
    }
    const identity: NativeJsonlFileIdentity = { dev: stat.stats.dev, ino: stat.stats.ino };
    this.#armed = {
      generation: this.#generation,
      byteOffset: stat.stats.size,
      identity,
      promptId,
    };
    if (this.#identity === null) this.#identity = identity;
  }

  /**
   * Arm the one corroboration read for a fresh root `SessionStart`. The claim is
   * only ever made after the run's own bound transcript is positively read, so a
   * start that names a new conversation but sits on top of recorded work — or on
   * a file this controller cannot read at all — publishes nothing.
   */
  #armFreshStartProbe(): void {
    this.#freshProbe = null;
    const path = this.#transcriptPath;
    if (path === null) return;
    const stat = this.#statBound();
    if ("gap" in stat) {
      // A transcript that does not exist yet positively states that nothing has
      // been recorded in it. Every other gap — unreadable, a symlink, a
      // directory, an unbound path — leaves the answer unknown, so no idle claim.
      if (stat.gap !== "unavailable") return;
      this.#freshProbe = {
        generation: this.#generation,
        path,
        sessionId: this.#sessionId,
        identity: null,
        absent: true,
      };
    } else {
      this.#freshProbe = {
        generation: this.#generation,
        path,
        sessionId: this.#sessionId,
        identity: { dev: stat.stats.dev, ino: stat.stats.ino },
        absent: false,
      };
    }
    void this.#readFreshStart();
  }

  /**
   * Read the bound file from its very beginning and apply the fresh-start claim
   * only when the window covered the WHOLE file, every record in it was readable,
   * and none of them is a persisted conversation row. Anything else — history this
   * window could not cover, an unreadable or half-appended row, or a real
   * `user`/`assistant` row — leaves the scope exactly as the boundary alone left
   * it. The result is applied only while the generation and the probe that started
   * it are still current, so a newer scope, a retired start, or an intervening
   * invalidation cannot be idled by this read.
   */
  async #readFreshStart(): Promise<void> {
    const probe = this.#freshProbe;
    if (probe === null || this.#disposed) return;

    let corroborated = probe.absent;
    let scannedTo: number | null = null;
    let readIdentity: NativeJsonlFileIdentity | null = null;
    if (!probe.absent) {
      try {
        const result = await readNativeJsonlTail({
          path: probe.path,
          from: 0,
          maxBytes: this.#maxTailBytes,
          maxLineBytes: this.#maxLineBytes,
          expectIdentity: probe.identity ?? undefined,
        });
        // Coverage is the whole point: a window that started past byte 0, skipped
        // the floor, cut a record, or could not decode a row says nothing about
        // what came before this scope.
        if (result.ok
          && result.windowStart === 0
          && !result.skippedBefore
          && !result.droppedLeadingPartial
          && !result.trailingPartial
          && result.oversizedLines === 0) {
          const seen = scanForPrerecordedWork(result.records);
          corroborated = seen.malformed === 0 && seen.conversationRows === 0;
          scannedTo = result.scannedTo;
          readIdentity = result.identity;
        }
      } catch {
        corroborated = false;
      }
    }

    if (this.#disposed || this.#freshProbe !== probe || this.#generation !== probe.generation) return;
    this.#freshProbe = null;
    if (!corroborated) return;

    const confirmation = this.#reducer.confirmFreshStart({
      sessionId: probe.sessionId,
      sourceToken: `nca-fresh:${probe.generation}`,
    });
    if (confirmation.outcome !== "applied") return;
    // A brand-new provider process whose own transcript holds no conversation row
    // positively states that it has no background work yet: this is an observed
    // zero for this scope, not a reconstruction, and every later count source
    // (a newer ROOT `Stop` snapshot, a transition row, a scope change, a hook-lane
    // loss) replaces or withdraws it exactly like any other snapshot.
    this.#counts = { tasks: 0, shells: 0 };
    // This read consumed the entire file, so the monitor's floor starts here and
    // the first row of any later turn is still seen.
    if (scannedTo !== null && readIdentity !== null) {
      this.#cursor = scannedTo;
      this.#identity = readIdentity;
    }
    this.#syncWatcher();
    this.#emit();
  }

  /** One lstat of the positively bound path, with the closed failure codes. */
  #statBound(): { readonly stats: Stats } | { readonly gap: NativeClaudeAcquisitionGapReason } {
    const path = this.#transcriptPath;
    if (path === null) return { gap: "unbound-transcript" };
    let stats: Stats | undefined;
    try {
      stats = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      return { gap: "unreadable" };
    }
    if (stats === undefined) return { gap: "unavailable" };
    if (stats.isSymbolicLink()) return { gap: "symlink" };
    if (!stats.isFile()) return { gap: "not-a-regular-file" };
    return { stats };
  }

  /**
   * Establish a scan floor when monitoring starts with no cursor: prior history is
   * ignored rather than replayed, so an older turn's row can never close a newer
   * one. Without a floor nothing can be monitored, and published state is then
   * withdrawn instead of left unwatched.
   */
  #ensureScanFloor(): boolean {
    if (this.#cursor !== null) return true;
    const stat = this.#statBound();
    if ("gap" in stat) {
      // Only a Ready READ FROM THIS FILE is a claim this floor was supposed to
      // defend. A corroborated fresh-start idle is a statement about a brand-new
      // provider process, not about this file's contents, and a retained
      // last-reported count is not a transcript claim either, so neither is
      // escalated here; an armed read reports its own stat gap where that matters.
      if (this.#readyPublished) this.#transcriptFailure(stat.gap);
      return false;
    }
    this.#cursor = stat.stats.size;
    this.#identity = { dev: stat.stats.dev, ino: stat.stats.ino };
    return true;
  }

  /** Keep exactly one watcher on the one bound path, for exactly as long as needed. */
  #syncWatcher(): void {
    if (this.#disposed) {
      this.#closeWatcher();
      return;
    }
    if (this.#transcriptPath === null || !this.#shouldRead()) {
      this.#closeWatcher();
      return;
    }
    if (!this.#ensureScanFloor()) return;
    if (this.#watcher === null) this.#attachWatcher();
  }

  #attachWatcher(): void {
    if (this.#watcher !== null || this.#disposed) return;
    const path = this.#transcriptPath;
    if (path === null) return;
    const generation = this.#generation;
    try {
      // Exactly one watched file, no polling and no idle timer: an append to this
      // file is the only thing that wakes a read.
      const handle = this.#watchFile(path, {
        onChange: () => {
          // A callback queued by a retired watcher must never act on the current
          // generation's scope, and a closed handle is never current.
          if (this.#disposed || generation !== this.#generation || this.#watcher?.handle !== handle) return;
          void this.#readTail();
        },
        onError: () => {
          if (this.#disposed || generation !== this.#generation || this.#watcher?.handle !== handle) return;
          this.#closeWatcher();
          this.#transcriptFailure("watch-error");
        },
      });
      this.#watcher = { generation, handle };
    } catch {
      // Without monitoring, a source-confirmed Ready can no longer be defended
      // against the file changes it depends on: withdraw the transcript-derived
      // claim rather than leave it unmonitored. A last-reported hook count is not
      // a claim about this file, so it is not what this failure contradicts.
      this.#transcriptFailure("watch-unavailable");
    }
  }

  #closeWatcher(): void {
    const watcher = this.#watcher;
    this.#watcher = null;
    if (watcher === null) return;
    try {
      watcher.handle.close();
    } catch {
      // An already-closed watcher is the desired end state.
    }
  }

  /**
   * Scan one bounded window and only then commit anything. The whole window is
   * classified first, so a malformed or oversized record anywhere in it withdraws
   * the observation instead of being skipped because a witness appeared earlier.
   * The result is applied only while the arm and generation it started under are
   * still current, and a read queued behind this one is always drained.
   */
  async #readTail(): Promise<void> {
    if (this.#disposed || !this.#shouldRead()) return;
    const path = this.#transcriptPath;
    if (path === null) return;
    if (this.#reading) {
      this.#readAgain = true;
      return;
    }
    const generation = this.#generation;
    const armedFor = this.#armed;
    const sessionId = this.#sessionId;
    // The identities this reducer holds open NOW, captured before the await so a
    // window can only ever close a request that was open when it started reading.
    // An empty set means there is nothing to match, and no row is inspected for
    // an identity at all.
    const openQuestions = new Set(this.#reducer.openQuestionRequestIds());
    const from = Math.max(armedFor?.byteOffset ?? 0, this.#cursor ?? 0);
    const expectIdentity = armedFor?.identity ?? this.#identity ?? undefined;
    this.#reading = true;

    let gap: NativeClaudeAcquisitionGapReason | null = null;
    let scan: WindowScan | null = null;
    let scannedTo: number | null = null;
    let readIdentity: NativeJsonlFileIdentity | null = null;
    try {
      const result = await readNativeJsonlTail({
        path,
        from,
        maxBytes: this.#maxTailBytes,
        maxLineBytes: this.#maxLineBytes,
        expectIdentity,
      });
      if (!result.ok) {
        gap = mapTailFailure(result.reason);
      } else if (result.skippedBefore) {
        gap = "skipped-window";
      } else if (result.oversizedLines > 0) {
        gap = "oversized";
      } else {
        scan = this.#scanRecords(result.records, armedFor !== null, sessionId, openQuestions);
        if (scan.malformed > 0) gap = "malformed";
        else {
          scannedTo = result.scannedTo;
          readIdentity = result.identity;
        }
      }
    } catch {
      gap = "unreadable";
    } finally {
      this.#reading = false;
    }

    const stale = this.#disposed || generation !== this.#generation || this.#armed !== armedFor;
    if (!stale) {
      if (gap !== null) {
        this.#transcriptFailure(gap);
      } else if (scan !== null && scannedTo !== null && readIdentity !== null) {
        // A persisted `tool_result` for a request this reducer holds open is that
        // request's own terminal evidence — the shape a declined, cancelled, or
        // answered question leaves when no `Post*` hook ever arrived. It is
        // applied first, because it is an independent fact about one request and
        // neither a membership transition nor newer work makes it less true. Only
        // the identity crossed here; no answer, error text, or result content.
        for (const requestId of scan.questionClosures) {
          this.#reducer.observeQuestionToolResult({ requestId, sessionId });
        }
        // A structured native task/launch transition is proven membership change:
        // it makes the last snapshot unknown whichever way the window resolves.
        // It never replaces the snapshot with a reconstruction or a zero.
        if (scan.transition) this.#counts = null;
        // Position and closed row kind, not the batch, decide a witness. Only a
        // root model row that STARTS AFTER the window's first root-summary
        // candidate can contradict that witness. While a terminal pass is armed
        // and its summary has not been read yet, a closing turn's own trailing
        // rows (its final `assistant` row, its `user` tool-result row carrying
        // both `message` and `toolUseResult`) publish nothing either: they flush
        // seconds before the provider appends that summary, so an intervening
        // read must not spend the armed pass on them. A persisted root PROMPT
        // row, and any root model row once no witness pass is armed, still
        // withdraws, exactly as before.
        // What a root row can contradict depends on what is actually published.
        // An armed completion pass is contradicted by a new root prompt row, or by
        // a root prompt or model row that starts after this window's root-summary
        // candidate. ANY published idle foreground — a witness-confirmed `Ready`, a
        // corroborated fresh `SessionStart`, or the host's own launch baseline — is
        // contradicted by a newer root prompt or model row, because the file is the
        // only thing left that can say this idle claim stopped being true. With
        // only a last-reported count published there is no foreground claim to
        // contradict: the file is still read, so a membership transition can still
        // withdraw the numbers, but a plain root row must not erase a healthy
        // hook-derived foreground or question census. A signal row — a persisted
        // result or a provider notification — contradicts no foreground claim at
        // all, whichever of these is published.
        const contradicts = scan.foregroundWork && (armedFor !== null
          ? (scan.newRootPromptWork
            || (scan.firstCandidateIndex >= 0 && scan.foregroundWorkAfterCandidate))
          : this.#idlePublished());
        if (contradicts) {
          this.#withdrawForRootWork();
        } else {
          this.#cursor = scannedTo;
          this.#identity = readIdentity;
          if (armedFor !== null) this.#applyWitness(armedFor, sessionId, scan.candidates);
        }
      }
    }

    // A read queued while this one ran belongs to whatever is current now, so it
    // is drained whether or not this result turned out to be stale.
    if (this.#readAgain) {
      this.#readAgain = false;
      void this.#readTail();
    }
    if (stale || this.#disposed) return;
    this.#syncWatcher();
    this.#emit();
  }

  /**
   * Classify every complete record in the window. Only closed discriminators are
   * read — row `type`/`subtype`, `attachment.type`, `origin.kind`/`origin.producer`,
   * `toolUseResult.status`, the root-model markers (`isSidechain`, agent id,
   * session, and the presence of a `message` object), the block `type` of a
   * persisted `tool_result`, the provider-injection markers (`isMeta`,
   * `commandMode`, `origin.kind`), and the summary row's rootness/terminality
   * fields.
   * No content, command, description, path, question, answer, or error text.
   */
  #scanRecords(
    records: readonly string[],
    seekWitness: boolean,
    sessionId: string | null,
    openQuestionIds: ReadonlySet<string>,
  ): WindowScan {
    let malformed = 0;
    let transition = false;
    let foregroundWork = false;
    let newRootPromptWork = false;
    let firstCandidateIndex = -1;
    let foregroundWorkAfterCandidate = false;
    const candidates: NativeClaudeTerminalRecord[] = [];
    const questionClosures: string[] = [];
    for (const [index, record] of records.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record);
      } catch {
        malformed += 1;
        continue;
      }
      if (!isRecord(parsed)) {
        malformed += 1;
        continue;
      }
      if (seekWitness && candidates.length < MAX_TERMINAL_CANDIDATES) {
        const candidate = readTerminalCandidate(parsed);
        // Only a ROOT-eligible summary can stand as this window's positional
        // completion boundary, and only such candidates are worth handing to the
        // reducer: a child, sidechain, agent-scoped, or other-labelled summary is
        // refused by the reducer on these same extracted fields, and letting one
        // set the boundary — or fill the candidate cap — would let an unrelated
        // summary suppress this run's real witness. The reducer still makes the
        // authoritative rootness and sufficiency judgment on everything collected.
        if (candidate !== null && isRootSummaryCandidate(candidate)) {
          if (firstCandidateIndex < 0) firstCandidateIndex = index;
          candidates.push(candidate);
        }
      }
      if (isTaskTransitionRow(parsed)) transition = true;
      const rootRow = classifyRootTurnRow(parsed, sessionId);
      // Only a persisted human PROMPT row or a root `assistant` model row is
      // newer FOREGROUND work. A result-only row or a provider-injected
      // notification carries the conversation without starting a turn of its own,
      // so it outranks nothing: it must never cost a published Ready its
      // foreground, its question census, or a still-open child request.
      const foreground = rootRow === "prompt" || rootRow === "model";
      if (rootRow !== "none") {
        if (foreground) foregroundWork = true;
        if (rootRow === "prompt") newRootPromptWork = true;
        // Append order is the only ordering fact a JSONL window carries: a row
        // that starts after the closing turn's own summary is newer work, a row
        // that starts before it belongs to the turn that summary closed.
        if (foreground && firstCandidateIndex >= 0 && index > firstCandidateIndex) {
          foregroundWorkAfterCandidate = true;
        }
        // A persisted `tool_result` naming a request the reducer still holds open
        // is that request's own terminal evidence — the shape a declined or
        // cancelled question leaves when no `Post*` hook ever reached this
        // observer. Only identities are compared, and only against requests that
        // were open when this read began.
        if (openQuestionIds.size > 0
          && questionClosures.length < MAX_QUESTION_CLOSURES_PER_WINDOW
          && isRecord(parsed.message)) {
          for (const requestId of readToolResultRequestIds(parsed.message)) {
            if (openQuestionIds.has(requestId)
              && !questionClosures.includes(requestId)
              && questionClosures.length < MAX_QUESTION_CLOSURES_PER_WINDOW) {
              questionClosures.push(requestId);
            }
          }
        }
      }
    }
    return {
      malformed,
      transition,
      foregroundWork,
      newRootPromptWork,
      candidates,
      firstCandidateIndex,
      foregroundWorkAfterCandidate,
      questionClosures,
    };
  }

  /**
   * Let the landed reducer judge the rootness and terminal sufficiency of each
   * candidate, in file order, for the armed turn only. A non-root or superseded
   * candidate is refused by the reducer; an undecidable one withdraws the
   * foreground and decides this pass.
   */
  #applyWitness(
    armedFor: ArmedRead,
    sessionId: string | null,
    candidates: readonly NativeClaudeTerminalRecord[],
  ): void {
    if (this.#terminalAccepted || candidates.length === 0) return;
    this.#readSeq += 1;
    const sourceToken = `nca:${this.#generation}:${this.#readSeq}`;
    for (const summary of candidates) {
      const result = this.#reducer.confirmTurnEnd({
        sessionId,
        promptId: armedFor.promptId,
        sourceToken,
        summary,
      });
      if (result.outcome === "applied") {
        this.#terminalAccepted = true;
        this.#readyPublished = true;
        this.#armed = null;
        return;
      }
      if (result.outcome === "invalid") {
        // Undecidable: this pass is decided and stays unverifiable.
        this.#armed = null;
        return;
      }
    }
  }

  /**
   * Positively observed new ROOT work in the monitored transcript. Everything
   * this controller last published describes the turn that was current when that
   * snapshot or witness was taken, and the file now says the conversation moved
   * past it: the foreground and activity become unknown (never a stale `Ready`,
   * never a fabricated busy or zero, never an unsupported category), and the
   * armed or in-flight terminal pass for the old turn is retired with its
   * generation, so a late read from it restores nothing. This path is only taken
   * when there IS a published foreground claim — an armed pass or a
   * source-confirmed `Ready`. The last-reported count snapshot is never
   * contradicted by newer foreground work — that is not evidence about background
   * membership — so it stays published, and monitoring is re-established on the
   * same file so a later transition row can still withdraw it. No gap is
   * reported: the source was read and it said something. That is knowledge, not a
   * loss of it, and the next real boundary can publish again.
   */
  #withdrawForRootWork(): void {
    this.#startupVouched = false;
    this.#baselineRetired = true;
    this.#retire();
    // The conversation moved past whatever this controller published, and it did
    // so without this run's hook lane saying a word: the whole derived scope is
    // no longer trustworthy, so it is released as a unit and a genuinely new
    // boundary re-adopts it. A window that only carried a task transition, a
    // settlement, or a tool-result row never reaches this path — those rows
    // contradict nothing about the foreground.
    this.#reducer.invalidate();
    // A retained count is still a published value: keep watching the same file
    // from a fresh scan floor so membership change can still contradict it.
    this.#syncWatcher();
    this.#emit();
  }

  /**
   * A loss of the authenticated hook lane: what that lane supported — the
   * foreground and the count snapshot it last published — collapses to unknown,
   * never to zero.
   */
  #hookLaneFailure(reason: NativeClaudeAcquisitionGapReason): void {
    this.#startupVouched = false;
    this.#baselineRetired = true;
    this.#retire();
    this.#counts = null;
    this.#reportGap(reason);
    this.#reducer.invalidate();
    this.#emit();
  }

  /**
   * A loss of the transcript read lane: the armed read, the scan cursor, and any
   * source-confirmed `Ready` are withdrawn, because they are claims read from
   * that one file. The ROOT `Stop` count snapshot is not: it came from the
   * provider's own hook payload, and a file this controller cannot read says
   * nothing about background membership. The gap is still reported and the
   * foreground claim still goes unknown, so no transcript-derived claim survives
   * a lane that cannot support it.
   */
  #transcriptFailure(reason: NativeClaudeAcquisitionGapReason): void {
    this.#retire();
    this.#reportGap(reason);
    // Only the claim this lane supported goes unknown. The authenticated hook
    // lane still vouches the run's foreground, its question census, and its
    // scope, so a transcript this controller cannot read must not cost the row
    // its pending-input answer until the next `SessionStart`.
    this.#reducer.withdrawTranscriptForeground();
    this.#emit();
  }

  #reportGap(reason: NativeClaudeAcquisitionGapReason): void {
    if (this.#disposed) return;
    try {
      this.#onSourceGap?.(reason);
    } catch {
      // A host diagnostic can never break the observer.
    }
  }

  // --- emission ------------------------------------------------------------

  #emit(): void {
    if (this.#disposed) return;
    const foreground = this.#reducer.snapshot();
    const snapshot: NativeClaudeAcquisitionSnapshot = {
      busy: foreground.busy,
      pendingInput: foreground.pendingInput,
      activity: [...foreground.activity],
      activeTasks: this.#counts === null ? null : this.#counts.tasks,
      activeShells: this.#counts === null ? null : this.#counts.shells,
      support: NATIVE_CLAUDE_ACQUISITION_SUPPORT,
    };
    if (snapshotsEqual(this.#last, snapshot)) return;
    this.#last = snapshot;
    try {
      this.#onSnapshot(snapshot);
    } catch {
      // The host sink is contained: a throw cannot corrupt this controller.
    }
  }
}

function mapTailFailure(reason: NativeJsonlTailFailureReason): NativeClaudeAcquisitionGapReason {
  if (reason === "identity-changed") return "replaced";
  if (reason === "truncated") return "truncated";
  if (reason === "unavailable") return "unavailable";
  if (reason === "not-a-regular-file") return "not-a-regular-file";
  if (reason === "symlink") return "symlink";
  return "unreadable";
}

/**
 * The persisted root `stop_hook_summary` fields the reducer is allowed to judge,
 * read as discriminators only. Array CONTENT never crosses: a length-only
 * stand-in carries the same decidable emptiness fact.
 */
function readTerminalCandidate(parsed: Record<string, unknown>): NativeClaudeTerminalRecord | null {
  if (parsed.type !== "system") return null;
  if (parsed.subtype !== "stop_hook_summary") return null;
  return {
    hookEventName: readToken(parsed.hookEventName),
    hookLabel: readToken(parsed.hookLabel),
    isSidechain: typeof parsed.isSidechain === "boolean" ? parsed.isSidechain : null,
    agentId: readToken(parsed.agentId),
    preventedContinuation: typeof parsed.preventedContinuation === "boolean" ? parsed.preventedContinuation : null,
    hookErrors: Array.isArray(parsed.hookErrors) ? opaqueArray(parsed.hookErrors.length) : null,
    hookAdditionalContext: Array.isArray(parsed.hookAdditionalContext)
      ? opaqueArray(parsed.hookAdditionalContext.length)
      : parsed.hookAdditionalContext === undefined ? undefined : null,
  };
}

/**
 * A structured native task or launch transition, recognized from closed
 * discriminators only: a `task_status` attachment injection, a `queued_command`
 * attachment whose origin is a settled background run, or a tool result that
 * reports an asynchronous launch. Presence is all that matters; it invalidates
 * the last count snapshot, and no field content is read or retained.
 */
function isTaskTransitionRow(parsed: Record<string, unknown>): boolean {
  if (isRecord(parsed.attachment)) {
    const attachment = parsed.attachment;
    const kind = typeof attachment.type === "string" ? attachment.type : "";
    if (kind === "task_status") return true;
    if (kind === "queued_command" && isRecord(attachment.origin)) {
      const origin = attachment.origin;
      return origin.kind === "task-notification" || origin.producer === "session-task";
    }
    return false;
  }
  return isRecord(parsed.toolUseResult) && parsed.toolUseResult.status === "async_launched";
}

/**
 * The closed rootness discriminators a persisted `stop_hook_summary` must carry
 * before it can stand as this run's positional completion boundary: not a
 * sidechain, not agent-scoped, and labelled for `Stop` (or unlabelled, which is
 * the root turn-end path). These mirror the reducer's own refusal, applied to the
 * exact same extracted fields, so an unrelated child or non-`Stop` summary can
 * neither displace the real boundary nor consume the bounded candidate list. The
 * reducer remains the sole authority on rootness and terminal sufficiency.
 */
function isRootSummaryCandidate(record: NativeClaudeTerminalRecord): boolean {
  if (record.isSidechain === true) return false;
  if (record.agentId !== null) return false;
  if (record.hookLabel !== null && record.hookLabel !== "Stop") return false;
  return record.hookEventName === null || record.hookEventName === "Stop";
}

/**
 * What one persisted turn row positively says about this run's ROOT
 * conversation, judged from closed structural metadata only: the turn-record
 * `type` (`user` or `assistant`) with an actual `message` object, and whether a
 * `user` row carries its own `toolUseResult`. Nothing else is read — no prompt
 * text, model prose, XML-ish tool markup, tool output, or "the output went
 * quiet" timing decides anything, and no arbitrary JSON line counts as work.
 *
 * `"prompt"` is the persisted shape of a NEW root turn: a `user` row with a
 * `message` and neither its own `toolUseResult` object nor a persisted
 * `tool_result` block in its `message.content`. `"model"` is a root `assistant`
 * row: the model produced something new. A `"prompt"` and a `"model"` row are the
 * two kinds of newer FOREGROUND work. `"signal"` is a row the conversation
 * carries forward without starting a turn of its own — the result of a tool call
 * already made, or a provider task notification or meta injection.
 * A real tool-result row does not always carry the top-level `toolUseResult`
 * object, so the structured block inside `message.content` is what settles it:
 * without that check a completed tool call would be misread as a human typing a
 * new prompt, and a provider task notification or meta injection is likewise not
 * a human turn. Only closed markers decide this; no text is inspected.
 *
 * The distinction is not cosmetic. A signal can terminate one request's own
 * identity and can positively signal membership change, but it says nothing about
 * whether the foreground moved, so it must never be the reason a published idle
 * claim, a question census, or an unrelated still-open request is released.
 *
 * The markers that would make the row somebody else's turn are refused first, so
 * a child, a sidechain, or an unrelated native conversation can neither withdraw
 * this run's published state nor confirm it: `isSidechain`, a non-empty agent id,
 * or a row naming a different session than this run's bound one is not this run's
 * root work. A row carrying no session marker cannot be excluded that way and is
 * judged as this run's work, which errs toward withdrawing a published claim
 * rather than keeping one.
 *
 * Only rows actually inside a scanned window qualify, and a window never reaches
 * behind the read barrier or the scan floor, so an older turn's history can
 * neither invalidate the current state nor confirm a new one.
 */
function classifyRootTurnRow(
  parsed: Record<string, unknown>,
  sessionId: string | null,
): "none" | "prompt" | "model" | "signal" {
  const rowType = typeof parsed.type === "string" ? parsed.type : "";
  if (rowType !== "user" && rowType !== "assistant") return "none";
  if (parsed.isSidechain === true || parsed.is_sidechain === true) return "none";
  if (readToken(parsed.agentId) !== null || readToken(parsed.agent_id) !== null) return "none";
  const rowSession = readToken(parsed.sessionId) ?? readToken(parsed.session_id);
  if (rowSession !== null && sessionId !== null && rowSession !== sessionId) return "none";
  if (!isRecord(parsed.message)) return "none";
  if (rowType === "assistant") return "model";
  if (isRecord(parsed.toolUseResult)) return "signal";
  // The result of a call this conversation already made, in the shape that omits
  // the top-level `toolUseResult` object but keeps the structured `tool_result`
  // block: never a new human prompt.
  if (hasToolResultBlock(parsed.message)) return "signal";
  // A provider-injected user row — a background task notification, a meta notice —
  // carries the conversation forward without a human turn behind it.
  if (isProviderInjectedUserRow(parsed)) return "signal";
  return "prompt";
}

/**
 * Whether a persisted `message` carries structured `tool_result` content. Only
 * the block `type` discriminator is read; the result body stays in the row.
 */
function hasToolResultBlock(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type === "tool_result");
}

/**
 * The `tool_use_id` identities of the structured `tool_result` blocks in one
 * persisted `message`, bounded. Identities only: an answer, an error body, and
 * every other field of the block stay unread.
 */
function readToolResultRequestIds(message: Record<string, unknown>): readonly string[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const requestId = readToken(block.tool_use_id);
    if (requestId !== null && !ids.includes(requestId)) {
      ids.push(requestId);
      if (ids.length >= MAX_QUESTION_CLOSURES_PER_WINDOW) break;
    }
  }
  return ids;
}

/**
 * Whether a persisted ROOT `user` row is the provider speaking rather than a
 * human, from the closed markers the provider itself persists: `isMeta`, a
 * `commandMode` no human types, or an `origin.kind` the provider stamps on its own
 * injections (a settled background task, for instance). Anything else stays a
 * human prompt, which errs toward withdrawing a published claim rather than
 * keeping one.
 */
function isProviderInjectedUserRow(parsed: Record<string, unknown>): boolean {
  if (parsed.isMeta === true) return true;
  if (parsed.commandMode === "task-notification") return true;
  return isRecord(parsed.origin) && parsed.origin.kind === "task-notification";
}

/**
 * Whether one whole-file window still shows a brand-new conversation. Only the
 * row `type` discriminator is read: any persisted `user` or `assistant` row — in
 * any scope, from any session — means this file already recorded a conversation,
 * and an unreadable row leaves the answer unknown rather than empty.
 */
function scanForPrerecordedWork(records: readonly string[]): {
  readonly conversationRows: number;
  readonly malformed: number;
} {
  let conversationRows = 0;
  let malformed = 0;
  for (const record of records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      malformed += 1;
      continue;
    }
    if (parsed.type === "user" || parsed.type === "assistant") conversationRows += 1;
  }
  return { conversationRows, malformed };
}

/** A length-only array: `Array.isArray` and `.length` are all the reducer may read. */
function opaqueArray(length: number): readonly unknown[] {
  return new Array(length) as unknown[];
}

function readToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * One ROOT `Stop` payload's own count snapshot, or unknown. Absent or unreadable
 * stays unknown: a missing or malformed snapshot is never turned into a 0/0 that
 * the provider did not state.
 */
function readBackgroundCounts(event: NativeHookEvent): NativeHookBackgroundCounts | null {
  const counts = (event as { background_counts?: unknown }).background_counts;
  if (!isRecord(counts)) return null;
  const tasks = counts.tasks;
  const shells = counts.shells;
  if (typeof tasks !== "number" || typeof shells !== "number") return null;
  if (!Number.isSafeInteger(tasks) || !Number.isSafeInteger(shells) || tasks < 0 || shells < 0) return null;
  return { tasks, shells };
}

function snapshotsEqual(
  current: NativeClaudeAcquisitionSnapshot | null,
  next: NativeClaudeAcquisitionSnapshot,
): boolean {
  if (current === null) return false;
  return current.busy === next.busy
    && current.pendingInput === next.pendingInput
    && current.activeTasks === next.activeTasks
    && current.activeShells === next.activeShells
    && current.activity.length === next.activity.length
    && current.activity.every((line, index) => line === next.activity[index]);
}
