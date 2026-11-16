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
 *    the vouch. A restored run's spawn receives the same baseline only once its
 *    own exact resume proof is also held (see 9). Independently, a root
 *    `SessionStart` whose own payload names
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
 * 6. Counts are live native membership, or a real snapshot, never a guess. Two
 *    sources feed one published pair, and they are never mixed:
 *    - the per-run membership {@link NativeClaudeBackgroundLedger} carries this
 *      run's exact active set. It is seeded only by evidence that can vouch for
 *      it — the host's own launch of this process, or a complete ROOT membership
 *      snapshot — and it then moves exactly on positively observed edges: a
 *      confirmed `background_started` launch identity, a matching settle read out
 *      of this run's own persisted root rows, and a complete ROOT `Stop`
 *      `background_members` snapshot, which is the resync and outranks everything
 *      the ledger itself remembered. A genuine hole — a settle for an id never
 *      launched, a membership change whose member cannot be identified, a scope
 *      boundary, a hook-lane loss, or a lost transcript (this file is one of the
 *      two places a member's end is positively read, so a skipped window, a
 *      replaced or truncated file, or a watcher failure is a census hole, not just
 *      a read failure) — withdraws the ledger to unknown until the next complete
 *      snapshot: it never holds a stale count and never fabricates a zero. Every
 *      transcript membership source first passes one root fence — not sidechain,
 *      not agent-scoped, and naming no conversation other than this run's bound
 *      root session — so a child's or another conversation's completion can
 *      neither settle this run's member nor open a hole here.
 *    - when the ledger has no exact set to publish, a ROOT `Stop`'s own
 *      identity-free `background_counts` totals stand as this run's last-reported
 *      snapshot: present (including 0/0) is a real observation, absent or
 *      unreadable is unknown, and any membership edge clears it, because totals
 *      cannot account for a member the ledger never saw.
 *    - the provider's `background_tasks` array — on `Stop` AND on `SubagentStop`
 *      — is an IN-FLIGHT census, and a Claude agent whose own model turn has
 *      ended while it still owns background work is not in it. So the published
 *      task figure is the DISTINCT UNION of the ledger's generic non-shell
 *      in-flight members and this run's LIVE agent identities, tracked by
 *      {@link NativeClaudeAgentLifetime} from the child lane: an agent that has
 *      parked on work it owns, whose owned work has just settled and is about to
 *      wake it, or whose final turn has ended without its end being established
 *      yet stays counted, and an id counted by both sources is ONE task. A
 *      background shell an agent launched stays a shell and is never added to
 *      tasks. Only an exact ledger census takes part in that union; a
 *      last-reported totals snapshot stays the provider's own number. An agent
 *      leaves the count only on a positively established actual end — its turn
 *      boundary showing it owned nothing still running or pending, and its own
 *      terminal completion recorded in that same execution window — never on a
 *      snapshot omission, a turn boundary alone, a root question, or the rest of
 *      the session emptying out.
 *    A published number is dropped only by what can actually contradict it — a
 *    newer ROOT snapshot, a membership transition the transcript positively
 *    shows, a scope change, or a loss of the authenticated hook lane — and never
 *    merely because some other event arrived. Ordinary new foreground work (a
 *    prompt, tool use, or a newer root model row in the transcript) says nothing
 *    about background membership, so a live set or a last-reported snapshot
 *    survives it. Nothing reconstructs a count from activity, quietness, or a
 *    missing snapshot. The two categories are published independently: a hole in
 *    one category's coverage — an unkeyable member of a named kind, a launch of a
 *    named kind this ledger cannot track, totals that cannot describe that
 *    category's own exact set — makes THAT category unknown and leaves the other
 *    stating exactly what it still knows, while a hole nobody can attribute, a
 *    scope change, or a lane loss still withdraws both. Counts are DISPLAY ONLY:
 *    they are never this host's
 *    `backgroundTasks`/`backgroundShells`, never ownership, and never Stop or
 *    idle authority. A `SubagentStop` snapshot is that child's array and is never
 *    root scope, so it never replaces or erases the census; the child lane is
 *    still the only place an agent's own lifetime is visible, and it feeds the
 *    live-agent side of the union above. The live
 *    `system/background_tasks_changed` level is unreachable
 *    on this hook/PTY route by design, so it is never probed and never reported
 *    as a failed probe.
 * 7. Published state stays monitored — including while the provider has not
 *    created its root JSONL yet, where that file's own creation is the watched
 *    event that starts monitoring and a brand-new file is scanned from its first
 *    record so nothing already written is skipped. Terminal-witness arming and
 *    fixed-file validity/count monitoring are separate: while a count snapshot or a
 *    source-confirmed Ready is published, the watcher stays attached and reads
 *    continue, so a structured task transition in the transcript
 *    (`attachment/task_status`, a provider `queue-operation` `enqueue` in this
 *    run's own bound root session whose `task-notification` envelope names a
 *    finished id and a terminal status, a `queued_command` whose `origin.kind` is
 *    `task-notification` or whose `origin.producer` is `session-task` — except a
 *    delivery of a member this run's ledger positively remembers as ALREADY
 *    settled, which restates an applied end, asserts no new membership, and is
 *    never handed to the live-agent lifetime as a completion — or a
 *    `toolUseResult.status` of `async_launched`) settles the member it names or,
 *    when it cannot name a member this ledger tracks, withdraws the published
 *    counts, a positively observed NEW ROOT model row in that file withdraws the
 *    published foreground and activity to unknown — except the persisted
 *    INVOCATION of a question request this run's own hook lane already accepted,
 *    which is the same observed work landing late and contradicts nothing — and a
 *    later replacement or
 *    truncation of the bound file withdraws the transcript-derived state. Rootness comes
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
 * 8. One file, bounded, private. Only the positively bound transcript path, plus
 *    the named child transcripts this run's own child boundaries handed over, are
 *    ever opened; there is no HOME or session-directory search, no filename is
 *    derived or guessed, no directory is listed, no other native conversation is
 *    adopted, there is no periodic poll (the only re-read triggers are the watcher
 *    on that one file and the run's own hook events, and a child lane is read only
 *    when its own boundary arrives or that same watcher already woke a read), and
 *    there is no retention, logging, or broadcast of any record text. Every
 *    complete record in a scanned window is validated before anything is
 *    committed, so a malformed row after a sufficient summary withdraws rather
 *    than publishing Ready.
 *
 * 9. Conversation identity and restoration (issue #277). This controller can
 *    report, through the owner's private `onConversationIdentity` channel, the
 *    exact provider conversation UUID its OWN positively bound root scope proved:
 *    a genuine authenticated ROOT `SessionStart` of this run whose `session_id`
 *    is one exact UUID and whose provider `cwd` resolves to the same existing
 *    directory as the row's selected workspace. That identity is the controller's
 *    current root binding, never a second tracker: no history, filename, prose,
 *    birthtime, or other conversation is consulted, and it proves identity only —
 *    never persistence, idleness, input, or counts. No model prompt is required.
 *    A later genuine root `SessionStart` that proves another UUID follows it, one
 *    that replaces the binding WITHOUT proof (no UUID, no usable `cwd`, another
 *    workspace) explicitly withdraws it (`null`) instead of leaving the old id, a
 *    root `SessionEnd` whose reason is a conversation replacement (`clear`,
 *    `resume`) withdraws it, and an authenticated hook-lane loss withdraws it
 *    until this run's own admitted root hooks positively name the same bound
 *    conversation again. Ordinary status uncertainty — an unreadable payload, an
 *    unreadable transcript, an unknown axis — and any other `SessionEnd`, an
 *    invalidation, or disposal never withdraw it: a normal native exit usually
 *    lands while the owner still sees a live PTY, and the conversation it ends is
 *    exactly the one this row must restore, so after that ordinary `SessionEnd`
 *    even a lane failure (hooks racing the closing process) keeps it. A report the owner refused
 *    before activation is kept as the ONE current candidate and offered again
 *    from {@link NativeClaudeAcquisitionController.observeOwnedStartup}; nothing
 *    is queued, timed, or replayed, and a disposed controller reports nothing.
 *    A RESTORED run (`resumeConversationId` present) additionally admits NOTHING
 *    from its hook lane until that proof names the expected id with
 *    `source: "resume"`: a child, a foreign or malformed session, another source,
 *    another workspace, or a missing hook leaves every axis unknown and the
 *    expected id unconfirmed — the persisted id is an expectation, not
 *    authority. A restored run gets the owner's ordinary idle/none/0/0 launch
 *    baseline ONCE, and only when BOTH facts hold, in either order: the owner's
 *    activation of this exact new process ({@link
 *    NativeClaudeAcquisitionController.observeOwnedStartup}) and that run's own
 *    exact resume proof. Activation before proof only records that the owner
 *    vouched the spawn; the baseline lands with the proof, before any later hook
 *    of the run is admitted. Proof before activation leaves the baseline to
 *    activation, but ANY further hook of this run in between forfeits it, and so
 *    does any change to the bound transcript after the position fixed at the
 *    proof, so a late activation never states idle over something it did not
 *    see. Before the proof nothing is admitted, but a hook naming the expected
 *    conversation (other than a root start notice) still forfeits the baseline:
 *    that conversation was already doing something this run could not observe. The
 *    baseline is the same owner fact a fresh run gets — a new process with no
 *    input and no background work of its own — never a reading of the resumed
 *    history: the scan floor still excludes every older row, and this run's own
 *    later prompts, questions, tool and task edges, snapshots, newer transcript
 *    rows, scope ends, and lane losses replace or withdraw it exactly as for a
 *    fresh run. A refused, missing, or foreign proof mints nothing.
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
 *
 * A recognized payload this observer cannot read is NOT a lane loss. The reducer
 * states which observation axes that payload contradicted — the root foreground
 * claim and/or the pending-input census — and this controller publishes exactly
 * that degraded snapshot: this run's session admission, its live background
 * membership, its last-reported count snapshot, and the transcript lane all
 * survive, because the unreadable field contradicted none of them. Escalating one
 * unreadable field into a whole-lane failure erased live background counts and a
 * healthy question census for facts the payload never touched, and it made an
 * answered question look like the hook lane had died. Only an authenticated
 * failure of the lane itself withdraws everything the lane supported.
 */

import { lstatSync, realpathSync, statSync, watch, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { isRecord } from "../record-guard";
import { isNativeConversationId } from "./native-conversation";
import {
  NativeClaudeAgentLifetime,
  type NativeClaudeAgentLifetimeMark,
} from "./native-claude-agent-lifetime";
import {
  NativeClaudeBackgroundLedger,
  NATIVE_CLAUDE_BACKGROUND_KINDS,
  isValidNativeClaudeBackgroundMemberId,
  isNativeClaudeBackgroundKind,
  readNativeClaudeBackgroundLaunch,
  readNativeClaudeBackgroundMembers,
  type NativeClaudeBackgroundCoverage,
  type NativeClaudeBackgroundKind,
} from "./native-claude-background";
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
  /**
   * Owner-private: this row's selected workspace. It is compared, as one existing
   * directory, against a root `SessionStart`'s own provider `cwd`; it is never
   * scanned, listed, or used to locate anything. Without it no conversation
   * identity can be proved.
   */
  readonly workspace?: string;
  /**
   * Owner-private: the exact conversation UUID this run was launched to RESUME.
   * Its presence makes this a restored run: nothing from the hook lane is admitted
   * until this run's own authenticated root `SessionStart` with `source: "resume"`
   * names exactly this id in the selected workspace, and the owner's spawn never
   * vouches an idle/empty baseline. It is an expectation to prove, never proof; a
   * value that is not one exact UUID can never be proved.
   */
  readonly resumeConversationId?: string;
  /**
   * Owner-private identity channel: the exact UUID this run's current root binding
   * proved, or `null` when a previously reported identity was positively lost
   * while live. `false` means the owner refused it (for example before
   * activation); `true` or no value means accepted. It is never a status value.
   */
  readonly onConversationIdentity?: (conversationId: string | null) => boolean | void;
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

/**
 * One agent's named child transcript, as this run was told about it.
 *
 * `identity` is the file identity the cursor belongs to, so a replacement cannot
 * be read as an append, and `cursor` only ever advances over bytes this lane
 * positively consumed as complete records.
 */
interface NativeChildTranscriptLane {
  readonly path: string;
  identity: NativeJsonlFileIdentity | null;
  cursor: number;
  reading: boolean;
  /**
   * True when a read was requested while one was already in flight. The bytes that
   * request was for may have landed after the in-flight read sized its window, so
   * it is never dropped: it is drained once that read has committed, while this
   * lane is still the one its agent owns.
   */
  readAgain: boolean;
}

/** One whole-window classification pass. Nothing is applied until it completes. */
interface WindowScan {
  readonly malformed: number;
  /** True when the window carried a structured native task/launch transition. */
  readonly transition: boolean;
  /**
   * Member identities a settled native task row in this window names, in file
   * order, bounded. Identities only: no command, description, output, or
   * notification text crosses. Each carries the byte offset its record starts at,
   * so an AGENT's own completion can be fenced against the execution window that
   * produced it; a member's own end needs no such fence because settling is
   * monotone.
   */
  readonly settlements: readonly { readonly id: string; readonly offset: number }[];
  /**
   * True when a membership transition could not be resolved to one member this
   * ledger tracks — the census changed, but not in a way that can be counted.
   */
  readonly unresolvedTransition: boolean;
  /**
   * The count categories an unresolved transition actually reaches: the closed
   * kinds the row positively names (an async agent launch can only be a task),
   * or BOTH categories when the row proves a change without naming one. Empty
   * only when nothing went unresolved, and never wider than the rows in this
   * window actually prove.
   */
  readonly unresolvedKinds: readonly NativeClaudeBackgroundKind[];
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

/**
 * Root `SessionEnd` reasons that positively state the current conversation is
 * being REPLACED in this live process, so a proved identity no longer names the
 * current conversation. Every other reason (an exit, a logout, an unknown value)
 * ends the process's session, not the conversation's standing as the one this
 * row last ran, so the identity is kept for restoration.
 */
const CONVERSATION_REPLACED_END_REASONS: ReadonlySet<string> = new Set(["clear", "resume"]);

/** Hook kinds that are positively observed new root work, ending an armed pass. */
const NEW_ROOT_WORK_EVENTS: ReadonlySet<string> = new Set(["UserPromptSubmit", "PreToolUse"]);

/**
 * The closed native task statuses that positively state a member finished. Only
 * these settle a tracked member; anything else the provider reports about a live
 * task is not evidence that membership ended.
 */
const SETTLED_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/**
 * The provider's own queue operations. An `enqueue` of a task notification is the
 * record the provider writes when a background job finishes — persisted before
 * that notification is ever handed to the model, and therefore before any answer,
 * decline, or next prompt. `dequeue` only says the queued text was handed over:
 * it is neither new work nor a settlement, and no other operation claims anything
 * here.
 */
const NATIVE_QUEUE_ENQUEUE = "enqueue";

/** The provider's own completion envelope and the two tags this lane consumes. */
const TASK_NOTIFICATION_OPEN = "<task-notification>";
const TASK_NOTIFICATION_CLOSE = "</task-notification>";
const TASK_NOTIFICATION_ID_TAG = "task-id";
const TASK_NOTIFICATION_STATUS_TAG = "status";

/**
 * Bounded envelope text. The provider's completion block is a few hundred bytes;
 * anything larger is not that block and is refused rather than scanned.
 */
const MAX_TASK_NOTIFICATION_BYTES = 8 * 1024;

/** Bounded tag value: an id or a status token, never a body. */
const MAX_TASK_NOTIFICATION_VALUE_BYTES = 64;

/** Bounded settled-member identities extracted from one scanned window. */
const MAX_SETTLEMENTS_PER_WINDOW = 64;

/**
 * Bound on the child tool-request identities remembered for replay suppression.
 * This is a memory bound on request ids, not on work: forgetting one costs that
 * request's deduplication and nothing else, and it never caps what may be alive.
 */
const MAX_SEEN_CHILD_REQUEST_KEYS = 4096;

/**
 * Private per-run ledger scope tokens. One controller observes exactly one owned
 * run, so a process-unique token is exactly that run's scope: it is never
 * published, never a provider field, and never derived from a native session id,
 * which lets the host's launch-time baseline stand before the provider ever
 * names a conversation.
 */
let ledgerScopeSequence = 0;

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
  /** Owner-selected workspace for identity proof, or null (nothing provable). */
  readonly #workspace: string | null;
  readonly #onConversationIdentity: ((conversationId: string | null) => boolean | void) | undefined;
  /** True for a run launched to resume one exact conversation. Never changes. */
  readonly #restoring: boolean;
  /** The exact UUID a restored run must prove, or null when none can be. */
  readonly #restoreExpected: string | null;
  /** True while a restored run has not yet proved its expected conversation. */
  #restoreAwaitingProof: boolean;
  /**
   * A restored run's one-time launch-baseline gate. `waiting` until one of its
   * two facts arrives: `activated` once the owner vouched the spawn first,
   * `proved` once the exact resume proof was admitted first; `spent` once the
   * baseline was minted, forfeited, or never applicable (a fresh run).
   */
  #restoredBaseline: "waiting" | "activated" | "proved" | "spent";
  /**
   * The exact UUID the CURRENT root binding was proved for by this run's own root
   * `SessionStart` and workspace comparison, or null when the binding is unproved.
   * It is this controller's own binding, not a separate tracker.
   */
  #boundIdentity: string | null = null;
  /** True after an authenticated lane loss until the bound conversation is named again. */
  #identitySuspended = false;
  /**
   * True once the bound conversation's own root `SessionEnd` with an ordinary
   * (non-replacement) reason was admitted: the provider is ending this process's
   * session, normally while the owner still sees a live PTY. The proved identity
   * is the conversation this row last ran and must survive that shutdown, so a
   * later lane failure — the expected fate of hooks racing a closing process — is
   * not treated as a hidden switch. Only a new root `SessionStart` clears it.
   */
  #conversationEnded = false;
  /** The identity value the owner last accepted from this controller. */
  #reportedIdentity: string | null = null;
  /** True while the current candidate was refused and may be offered once more. */
  #identityOfferPending = false;

  readonly #reducer = new NativeClaudeStatusReducer();
  /** This run's live background membership census. Never published as ownership. */
  readonly #ledger = new NativeClaudeBackgroundLedger();
  /** This run's private ledger scope token; never crosses an observation. */
  readonly #ledgerScope: string;
  /**
   * This run's LIVE agent census: which agent identities are alive, including the
   * ones no in-flight snapshot lists any more. It is unioned DISTINCT with the
   * ledger's generic non-shell task members at publication, so one agent is one
   * task whether or not the provider currently lists it, and a shell the agent
   * launched stays a shell and is never counted twice.
   */
  readonly #agents = new NativeClaudeAgentLifetime();

  /**
   * Child-scoped tool results already consumed, keyed by agent identity, hook
   * event, and the provider's own per-request id. Replay suppression only: it
   * decides nothing about whether an agent is alive, and forgetting an entry costs
   * that request's deduplication and nothing else.
   */
  readonly #seenChildRequests = new Set<string>();

  /**
   * Requests whose own `PostToolUse` this projection has consumed. A request is
   * issued once and answered once, so its identity is tombstoned: no later edge
   * naming it is ever newer work.
   */
  readonly #settledChildRequests = new Set<string>();

  /**
   * One named child transcript per agent identity this run's own `SubagentStop`
   * positively named it for. This is a bound path, never a discovered one: no
   * directory is listed, no filename is guessed, and an agent whose boundary named
   * no path simply has no lane. Each lane carries the file identity and the offset
   * this controller consumed inside it, so a replacement or a truncation is a gap
   * rather than a cursor that silently reads the wrong file.
   */
  readonly #childLanes = new Map<string, NativeChildTranscriptLane>();

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
  /**
   * The byte offset at which transcript rows begin being able to contradict the
   * FOREGROUND this controller last derived from the hook lane. Every accepted
   * root-work hook re-states it at the file's size at that moment: rows already
   * written belong to the very turn that hook just described, so reading them a
   * moment later — which the preserved scan cursor guarantees happens — is not
   * newer work and must not withdraw what the hook positively observed. Membership
   * rows and question-result rows are still consumed from below that floor: only
   * the foreground contradiction is fenced by position.
   */
  #foregroundFloor = 0;
  /** Identity of the file the cursor belongs to; a change is a replacement. */
  #identity: NativeJsonlFileIdentity | null = null;
  /**
   * The path of the transcript this controller has actually read from — a scan
   * floor established or a window consumed. Unlike the scan cursor it survives a
   * retire, because it answers a different question: has this file ever existed
   * for us at all. A provider creates its root JSONL when the conversation
   * begins, so a bound path that has never been read and is not there yet holds
   * no records, while a path once read and now missing is a hole.
   */
  #transcriptSeenPath: string | null = null;
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
  /**
   * Last reported ROOT `Stop` count totals, which carry no member identities.
   * They publish only while the membership ledger has no exact set, and any
   * membership edge clears them. Null is unknown, never zero. They are stated
   * category by category: a snapshot whose own membership could not be keyed for
   * one category states no last-reported number for THAT category, because a
   * count the observer cannot attribute to a member cannot be defended against
   * the next edge of that kind. The other category keeps its number.
   */
  #snapshotCounts: NativeClaudeBackgroundCoverage | null = null;

  #watcher: ActiveWatch | null = null;
  /**
   * One bounded watch on the PARENT of the bound transcript, armed only while that
   * path is absent and has never been read. The provider creates its root JSONL
   * when the conversation begins, so the creation itself is the only event that
   * can say monitoring can start; a file that does not exist yet cannot be watched
   * directly. It is closed the moment the file appears (the file watch takes over)
   * and never outlives the lane it belongs to.
   */
  #pendingFileWatch: ActiveWatch | null = null;
  /** The path whose creation {@link #pendingFileWatch} waits for. */
  #awaitedTranscriptPath: string | null = null;
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
    this.#ledgerScope = `native-claude-run-${++ledgerScopeSequence}`;
    this.#workspace = typeof options.workspace === "string" && options.workspace !== "" ? options.workspace : null;
    this.#onConversationIdentity = typeof options.onConversationIdentity === "function"
      ? options.onConversationIdentity
      : undefined;
    this.#restoring = options.resumeConversationId !== undefined;
    this.#restoreExpected = isNativeConversationId(options.resumeConversationId)
      ? options.resumeConversationId
      : null;
    this.#restoreAwaitingProof = this.#restoring;
    this.#restoredBaseline = this.#restoring ? "waiting" : "spent";
  }

  /**
   * Consume one already-authenticated hook event for this owned run. Events for
   * another backend, and every event after disposal, are ignored without effect.
   */
  acceptHook(event: NativeHookEvent): void {
    if (this.#disposed) return;
    if (!isRecord(event) || event.backend !== this.#backend) return;

    // A restored run admits nothing until its own authenticated root resume of the
    // expected conversation, in the selected workspace, has arrived. Everything
    // else — a child, another session, another source, a malformed payload — is
    // not evidence about the conversation this row is supposed to be, so it may
    // neither confirm the expectation nor populate the row with another root's
    // status. Nothing is held for later: a dropped event is simply not this run's.
    let restoreProof = false;
    if (this.#restoreAwaitingProof) {
      if (!this.#provesRestoredRoot(event)) {
        // Still not admitted — it publishes nothing and confirms nothing — but a
        // hook naming the very conversation this run is resuming, other than a
        // root start notice, is that conversation already doing something. The
        // launch baseline could only be stated over it unseen, so it is forfeited.
        // A foreign or unattributable hook is not this conversation and changes
        // nothing.
        if (this.#namesRestoredConversation(event)) this.#restoredBaseline = "spent";
        return;
      }
      this.#restoreAwaitingProof = false;
      restoreProof = true;
    }

    const hookEventName = typeof event.hook_event_name === "string" ? event.hook_event_name : "";
    // Only an ABSENT agent identity is this run's root scope. A present identity
    // this observer cannot read is malformed — the reducer says so and refuses the
    // payload — and a bounded-text validation pass must not turn it into permission
    // to consume root membership or to move this run's transcript binding.
    const agentId = (event as { agent_id?: unknown }).agent_id;
    const isRoot = agentId === undefined || agentId === null;
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

    if (!restoreProof && this.#restoredBaseline === "proved") {
      // The proof landed before activation, and now another hook that survived
      // this run's admission fences has arrived before activation too. Whatever it
      // is, a later launch baseline would have to stand over it unseen, so the
      // one-time baseline is forfeited. A foreign or stale hook, already refused
      // above, changes nothing here.
      this.#restoredBaseline = "spent";
    }

    this.#noteScope(event, isRoot, hookEventName);
    if (isRoot && hookEventName === "SessionStart") {
      // The root binding was just replaced by this run's own boundary: the
      // identity follows it exactly — the proved UUID, or an explicit withdrawal
      // when the new binding cannot be proved — and never keeps the old one.
      this.#boundIdentity = this.#provesRootContext(event) ? eventSession : null;
      this.#identitySuspended = false;
      this.#conversationEnded = false;
      this.#syncIdentity();
    } else if (isRoot
      && this.#boundIdentity !== null
      && this.#sessionId !== null
      && this.#sessionId !== this.#boundIdentity) {
      // The root binding this controller now holds names ANOTHER conversation
      // without that conversation's own proving `SessionStart` — a scope adopted
      // from an ordinary root hook after the proved one ended and the lane lost
      // its closed-scope fence. The binding is the identity's only authority, so
      // the old id no longer names the current conversation and is withdrawn
      // rather than left saved beside another root's status. Late hooks of the
      // proved conversation itself re-adopt the same id and change nothing.
      this.#boundIdentity = null;
      this.#identitySuspended = false;
      this.#conversationEnded = false;
      this.#syncIdentity();
    }
    if (pathRebound) reduction = this.#reducer.reduce(event);
    if (reduction.outcome === "invalid") {
      // A recognized payload this observer cannot read degrades exactly the
      // observation axes the reducer itself declared, and the snapshot it
      // returned already states them. It is not evidence about anything else
      // this lane vouched: this run's scope admission, its live background
      // membership, and the transcript lane survive it, because this payload
      // contradicted none of them. Escalating an unreadable field into a
      // whole-lane loss is what let an unrelated question-close erase live
      // background counts and the run's own session binding; only an
      // authenticated loss of the lane (`acceptFailure`) may do that, and no
      // membership edge of an unattributable payload is consumed here.
      // The declared axes still own their own follow-up. A hole in the
      // FOREGROUND ends any terminal-witness authority this run held: this
      // observer lost the thread of the turn, so a summary row that surfaces
      // later can never be shown to close it, and publishing `Ready` over the
      // newer root boundary is exactly what the Stop barrier exists to prevent.
      // A census-only hole leaves that authority, the membership ledger, and the
      // scan cursor alone.
      if (reduction.affects.includes("foreground")) this.#retireTerminalWitness();
      // A background launch this very payload positively states is an independent
      // fact, validated by the protocol on its own terms: an unreadable
      // `tool_use_id` says nothing about it, and dropping it would keep reporting
      // a known-empty census beside a launch this run was told about. It is
      // consumed only when this event is exactly attributable to this run's own
      // root scope; a malformed or unattributable scope is still refused.
      if (isRoot
        && hookEventName === "PostToolUse"
        && eventSession !== null
        && this.#sessionId === eventSession) {
        this.#noteMembership(event, isRoot, hookEventName);
      }
      this.#syncWatcher();
      if (this.#shouldRead()) void this.#readTail();
      this.#emit();
      return;
    }

    // Only this run's own scope may contribute counts: an event naming a different
    // native conversation never replaces this run's own snapshot.
    const sameScope = this.#sessionId === null || eventSession === null || eventSession === this.#sessionId;
    if (sameScope) this.#noteMembership(event, isRoot, hookEventName);

    const admitted = reduction.outcome === "applied";

    // Accepted new root work ends the armed pass outright, independently of any
    // prompt correlation: an arm whose turn has been superseded, and any read
    // still in flight for it, can no longer publish.
    if (admitted && sameScope && isRoot && NEW_ROOT_WORK_EVENTS.has(hookEventName)) {
      this.#startupVouched = false;
      // The previous turn's terminal-witness authority is over, but rows this
      // controller has not scanned yet are still this run's facts: a completion
      // record written a moment before this hook must not go permanently unread
      // because an unrelated foreground edge arrived.
      this.#retireTerminalWitness();
      // What that hook positively stated describes everything written so far, so
      // only rows appended after it can contradict it. A file this controller
      // cannot size gets no floor at all: unreadable positions must not be used to
      // discard a positively observed hook-lane foreground.
      const boundary = this.#statBound();
      this.#foregroundFloor = "gap" in boundary ? Number.POSITIVE_INFINITY : boundary.stats.size;
    }

    if (admitted && sameScope && isRoot && hookEventName === "Stop") {
      this.#armTerminalRead(readToken((event as { prompt_id?: unknown }).prompt_id));
    } else if (admitted && sameScope && isRoot && (hookEventName === "StopFailure" || hookEventName === "SessionEnd")) {
      // Neither path can produce a terminal witness for this pass.
      this.#armed = null;
    }

    if (admitted && sameScope && isRoot && hookEventName === "SessionEnd"
      && eventSession !== null
      && eventSession === this.#boundIdentity
      && CONVERSATION_REPLACED_END_REASONS.has(readToken((event as { reason?: unknown }).reason) ?? "")) {
      // The provider states this conversation is being replaced in the live
      // process: the proved identity no longer names the current conversation.
      this.#boundIdentity = null;
      this.#identitySuspended = false;
      this.#syncIdentity();
    } else if (admitted && sameScope && isRoot && hookEventName === "SessionEnd"
      && eventSession !== null
      && eventSession === this.#boundIdentity) {
      // An ordinary end (an exit, a logout, `other`, an absent or unknown reason)
      // closes this process's session, not the conversation's standing as the one
      // this row last ran: the identity is kept, never reported as `null`, and it
      // stays the restoration target across the shutdown that follows.
      this.#conversationEnded = true;
    } else if (admitted && sameScope && isRoot
      && hookEventName !== "SessionEnd"
      && this.#identitySuspended
      && eventSession !== null
      && eventSession === this.#boundIdentity
      && eventSession === this.#sessionId) {
      // After a lane loss, this run's own admitted ROOT hook positively names the
      // conversation its binding proved. A switch hidden by the gap would have
      // named another session and been refused above, so this is the bound
      // conversation still being the current one — new evidence, not a replay.
      this.#identitySuspended = false;
      this.#syncIdentity();
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

    // A restored run's exact resume proof is the second half of its launch
    // baseline. If the owner already activated this process, the baseline lands
    // now — on the freshly rebound proved scope, before any later hook of this run
    // is admitted. Otherwise activation will state it, unless something else of
    // this run arrives first. A gate already forfeited before the proof stays so.
    if (restoreProof && this.#restoredBaseline !== "spent") {
      const activated = this.#restoredBaseline === "activated";
      const current = admitted && this.#restoredProofCurrent();
      if (activated) {
        this.#restoredBaseline = "spent";
        if (current) this.#mintRestoredBaseline();
      } else if (current) {
        this.#restoredBaseline = "proved";
        // Fix the bound transcript's position at the proof itself, so the rows the
        // provider appends before activation are never mistaken for prior history:
        // activation compares against this floor instead of starting a new one at
        // whatever the end of the file has become by then.
        if (this.#transcriptPath !== null) this.#ensureScanFloor();
      } else {
        this.#restoredBaseline = "spent";
      }
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
    // The lost event may have been a root boundary that replaced the conversation,
    // so the proved identity can no longer be stated as current while live. Once
    // the bound conversation's own ordinary `SessionEnd` was admitted, a failure is
    // the expected loss of hooks racing a closing process, not evidence of a
    // switch: the identity this row last ran is kept for restoration. A real new
    // root binding after that end still decides afresh through its own
    // `SessionStart`.
    if (this.#boundIdentity !== null && !this.#conversationEnded) {
      this.#identitySuspended = true;
      this.#syncIdentity();
    }
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
   * replaces or withdraws the baseline exactly like any other source. For a
   * restored run this is only the owner's half: the baseline is stated once, when
   * this run's own exact resume proof is also held (see 9 in the module notes).
   */
  observeOwnedStartup(): void {
    if (this.#disposed) return;
    // Activation is the first moment the owner can accept an identity, so the ONE
    // current candidate it refused earlier is offered again here — not a history,
    // and never a candidate this controller has since withdrawn or replaced.
    if (this.#identityOfferPending) this.#syncIdentity();
    // A restored run states this baseline only once its own exact resume proof is
    // also in hand. Activation first merely records the owner's half and leaves the
    // baseline to the proof; activation after a proof that nothing else followed
    // states it now. A repeated or later activation finds the gate spent.
    if (this.#restoring) {
      if (this.#restoredBaseline === "waiting") {
        this.#restoredBaseline = "activated";
        return;
      }
      if (this.#restoredBaseline !== "proved") return;
      this.#restoredBaseline = "spent";
      if (!this.#restoredProofCurrent()
        || !this.#restoredTranscriptUntouched()
        || !this.#mintRestoredBaseline()) return;
      this.#syncWatcher();
      this.#emit();
      return;
    }
    if (!this.#mintOwnedBaseline()) return;
    this.#syncWatcher();
    this.#emit();
  }

  /**
   * Whether the CURRENT root binding is still exactly the restored conversation
   * this run proved: bound, identity proved for that id, and not suspended by a
   * lane loss. A switched, withdrawn, or unbound scope never receives the
   * restored baseline.
   */
  #restoredProofCurrent(): boolean {
    return this.#restoreExpected !== null
      && !this.#restoreAwaitingProof
      && !this.#identitySuspended
      && this.#boundIdentity === this.#restoreExpected
      && this.#sessionId === this.#restoreExpected;
  }

  /**
   * Whether one not-yet-admitted hook names the exact conversation this restored
   * run is resuming, other than a ROOT `SessionStart` (a start notice — the proof
   * itself, or a failed attempt at it — is not work). A hook naming another
   * session, or none, is not attributable to it.
   */
  #namesRestoredConversation(event: NativeHookEvent): boolean {
    if (this.#restoreExpected === null) return false;
    if (readToken((event as { session_id?: unknown }).session_id) !== this.#restoreExpected) return false;
    const agentId = (event as { agent_id?: unknown }).agent_id;
    const isRoot = agentId === undefined || agentId === null;
    return !(isRoot && event.hook_event_name === "SessionStart");
  }

  /**
   * For a proof that arrived before activation: whether the bound transcript is
   * still exactly the file, at exactly the position, fixed at that proof. Anything
   * appended since — a new root turn, a task transition, or any other row — is
   * current evidence that a launch baseline minted now would sit above unread, and
   * a replaced, truncated, unreadable, or never-floored file cannot be vouched for
   * either. A run with no bound transcript has no file lane to skip.
   */
  #restoredTranscriptUntouched(): boolean {
    if (this.#transcriptPath === null) return true;
    if (this.#cursor === null || this.#identity === null) return false;
    const bound = this.#statBound();
    if ("gap" in bound) return false;
    return bound.stats.size === this.#cursor
      && bound.stats.dev === this.#identity.dev
      && bound.stats.ino === this.#identity.ino;
  }

  /**
   * Mint the owner's launch baseline for a restored run whose proof is current.
   * The ledger must still be unbound — nothing of this run's membership has been
   * observed — so a census this run already tracks is never reset to zero.
   * Returns whether it was applied; publication is the caller's.
   */
  #mintRestoredBaseline(): boolean {
    if (this.#ledger.snapshot().scopeToken !== null || this.#snapshotCounts !== null) return false;
    return this.#mintOwnedBaseline();
  }

  /**
   * The one place the owner's launch baseline is minted, for a fresh run at
   * activation and for a restored run once both its activation and its proof hold.
   * Refused over observed work, an ended scope, a retired baseline, or an existing
   * vouch; returns whether it was applied. Publication is the caller's.
   */
  #mintOwnedBaseline(): boolean {
    if (this.#startupVouched || this.#baselineRetired) return false;
    const baseline = this.#reducer.observeOwnedStartup();
    if (baseline.outcome !== "applied") return false;
    this.#startupVouched = true;
    // A process this host started a moment ago has registered no background work
    // of its own: that is a positively observed zero for this run, not a
    // reconstruction, and any later ROOT `Stop` snapshot, task transition, scope
    // change, or lane loss replaces or withdraws it on its own evidence.
    // The membership ledger gets the same vouch from the same evidence: this is
    // the ONE place a KNOWN-EMPTY census is minted, and it is minted on this run's
    // own private scope token, so a later provider `SessionStart` that binds a
    // session id can neither reset it nor have it re-minted over live work.
    this.#ledger.initializeFreshOwnedRun(this.#ledgerScope);
    this.#snapshotCounts = { tasks: 0, shells: 0 };
    return true;
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
    this.#snapshotCounts = null;
    // The census goes unknown on this run's own scope; the scope itself stays
    // bound, because recovery is new evidence, never a freshly minted baseline.
    this.#ledger.noteCoverageGap(this.#ledgerScope);
    // The live-agent lifetime is PRESERVED but no longer stateable. An explicit
    // withdrawal is not evidence that a parked agent stopped existing — so the
    // identities stay counted — but it IS a hole in the run's own evidence, and a
    // complete in-flight census later does not repair a lifetime: the provider's
    // empty `background_tasks` array says only that nothing is in flight, which an
    // agent that parked, woke, or ended during the hole is fully consistent with.
    // So the task axis stays unknown until THAT agent's own edge arrives. Clearing
    // the identities instead would turn a withdrawal into a fabricated undercount.
    this.#agents.noteCoverageGap(this.#ledgerScope);
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
    // Disposal is normal retirement, never identity loss: nothing is reported, and
    // no candidate survives to be offered by anything later.
    this.#identityOfferPending = false;
    this.#startupVouched = false;
    this.#baselineRetired = true;
    this.#retire();
    this.#snapshotCounts = null;
    // The run is over: retire the ledger scope outright. Nothing is carried into a
    // later run, and this call never mints a fresh status-capture authority.
    this.#ledger.retireScope(this.#ledgerScope);
    this.#agents.retireScope(this.#ledgerScope);
    this.#childLanes.clear();
    this.#seenChildRequests.clear();
    this.#settledChildRequests.clear();
    this.#sessionId = null;
    this.#transcriptPath = null;
  }

  // --- conversation identity -----------------------------------------------

  /**
   * The initial proof a restored run waits for: this run's own authenticated ROOT
   * `SessionStart` with `source: "resume"`, naming exactly the expected UUID, in
   * the selected workspace. Nothing weaker confirms the expectation.
   */
  #provesRestoredRoot(event: NativeHookEvent): boolean {
    if (this.#restoreExpected === null) return false;
    const agentId = (event as { agent_id?: unknown }).agent_id;
    if (agentId !== undefined && agentId !== null) return false;
    if (event.hook_event_name !== "SessionStart") return false;
    if ((event as { source?: unknown }).source !== "resume") return false;
    if ((event as { session_id?: unknown }).session_id !== this.#restoreExpected) return false;
    return this.#provesRootContext(event);
  }

  /**
   * Whether one root `SessionStart` proves the conversation it names: an exact
   * provider UUID, and a provider `cwd` that is the same existing directory as the
   * row's selected workspace. No path is guessed, searched, or derived.
   */
  #provesRootContext(event: NativeHookEvent): boolean {
    if (!isNativeConversationId((event as { session_id?: unknown }).session_id)) return false;
    const workspace = this.#workspace;
    const cwd = (event as { cwd?: unknown }).cwd;
    if (workspace === null || typeof cwd !== "string") return false;
    return sameExistingDirectory(cwd, workspace);
  }

  /**
   * Bring the owner's view of this run's identity in line with the current root
   * binding: the proved UUID, or an explicit `null` only when something this
   * controller previously reported is no longer current. A value the owner
   * already accepted is never sent twice, and an unproved binding that was never
   * reported sends nothing.
   */
  #syncIdentity(): void {
    if (this.#disposed) return;
    const target = this.#identitySuspended ? null : this.#boundIdentity;
    if (target === null) {
      this.#identityOfferPending = false;
      if (this.#reportedIdentity === null) return;
      this.#reportedIdentity = null;
      this.#offerIdentity(null);
      return;
    }
    if (target === this.#reportedIdentity) {
      this.#identityOfferPending = false;
      return;
    }
    if (this.#offerIdentity(target)) {
      this.#reportedIdentity = target;
      this.#identityOfferPending = false;
    } else {
      this.#identityOfferPending = true;
    }
  }

  #offerIdentity(conversationId: string | null): boolean {
    const report = this.#onConversationIdentity;
    if (report === undefined) return false;
    try {
      return report(conversationId) !== false;
    } catch {
      // The owner's channel is contained: a throw is a refusal, nothing more.
      return false;
    }
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
      // reports the boundary the host already knows — but only while the ledger
      // STILL states that exact empty census. A category it already lost to an
      // untracked launch is not restored by a vouch the host minted on work it
      // never saw, and a partial pair must not be republished as a whole one.
      const baselineCoverage = this.#ledger.coverage();
      if (this.#startupVouched
        && baselineCoverage.tasks === 0
        && baselineCoverage.shells === 0) {
        this.#snapshotCounts = { tasks: 0, shells: 0 };
      }
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

  /**
   * Drop every derived fact: a new scope inherits no Ready, count, or cursor.
   * Membership is never re-based here — a boundary the provider reports is not
   * the host's spawn, so this call cannot mint a fresh census. What it can do is
   * report a hole, and only where one actually exists: a positively known EMPTY
   * census states that nothing was outstanding when this boundary arrived, so the
   * boundary contradicts nothing and the exact zeros stand (which is what lets a
   * host-owned run keep live counts across its own `SessionStart`). Neither a live
   * set nor a PARTIAL census survives a boundary this observer cannot see through:
   * an empty member MAP with one category already withdrawn is a hole in the old
   * scope, and carrying the surviving exact zero into the new one would present
   * that hole as a census. Both withdraw to unknown until this run's next complete
   * membership snapshot.
   */
  #resetScope(sessionId: string | null, transcriptPath: string | null): void {
    this.#retire();
    this.#snapshotCounts = null;
    const coverage = this.#ledger.coverage();
    // The LIVE-AGENT overlay is part of this run's census exactly as a ledger
    // member is. An agent this projection still counts is a task the boundary
    // carries, so a run whose ledger map is empty but whose agent is still alive
    // is NOT an exactly-empty census: publishing zeros here would clear a live
    // agent as if it had never started, and the whole point of the empty-census
    // rule is to carry forward only a census this run can vouch for as whole.
    const exactlyEmptyCensus = this.#ledger.snapshot().members.length === 0
      && this.#agents.liveIds().length === 0
      && !this.#agents.hasUnresolvedCounted()
      && coverage.tasks !== null
      && coverage.shells !== null;
    if (!exactlyEmptyCensus) this.#ledger.noteCoverageGap(this.#ledgerScope);
    // An agent whose lifetime this projection was still tracking belongs to the
    // conversation this boundary replaces, not to the one after it. Carrying it
    // over would keep a live-agent count published across a boundary this
    // observer cannot see through, and would defeat the exact-empty-census rule
    // that keeps a host-owned run's real zeros standing here.
    this.#agents.clearAgents(this.#ledgerScope);
    // A named child transcript belongs to the conversation this boundary replaces.
    // Its cursor and identity describe that file in that conversation, and neither
    // survives a rebound transcript or a new session.
    this.#childLanes.clear();
    this.#sessionId = sessionId;
    this.#transcriptPath = transcriptPath;
  }

  /**
   * Retire the in-flight read AND re-establish a fresh scan floor. Used when the
   * transcript lane itself loses standing: a new scope or file, a lost read, an
   * explicit withdrawal, or the end of the run.
   *
   * Neither variant clears background membership: retiring a read cursor, a
   * generation, or a published `Ready` says nothing about what is running, and
   * only membership's own invalidators (a newer root snapshot, a transition row
   * that positively shows membership change, a scope change, a lost settlement
   * source, or a hook-lane loss) withdraw it.
   */
  #retire(): void {
    this.#retireLane(false);
  }

  /**
   * Retire the terminal-witness authority — the armed pass, the corroborated
   * fresh start, the published `Ready`, the accepted terminal identity, and any
   * read in flight — while KEEPING the byte offset this controller has already
   * scanned up to. Newer root work ends what the previous turn's read could
   * claim; it says nothing about rows the file already holds past the last
   * completed scan, so a membership transition written before this edge is still
   * read next. Dropping the cursor here would skip it until some unrelated
   * snapshot, leaving a count wrong in the meantime — and a read discarded by the
   * generation change is covered by the same preserved offset.
   */
  #retireTerminalWitness(): void {
    this.#retireLane(true);
  }

  #retireLane(keepScanCursor: boolean): void {
    this.#generation += 1;
    this.#armed = null;
    this.#freshProbe = null;
    this.#closeWatcher();
    // A preserved cursor is only safe together with the file identity it belongs
    // to: reading a replaced or truncated file from an old offset is worse than
    // skipping it, so the two are retired or kept as one fact.
    if (!keepScanCursor) {
      this.#cursor = null;
      this.#identity = null;
      this.#foregroundFloor = 0;
    }
    this.#terminalAccepted = false;
    this.#readyPublished = false;
    this.#readAgain = false;
  }

  // --- native background membership ----------------------------------------

  /**
   * Feed this run's ROOT background membership edges to the ledger, and keep the
   * identity-free totals snapshot honest alongside it.
   *
   * Only root events are root membership: a `SubagentStop` snapshot is that
   * child's whole array and can never replace or erase the root set. Within the
   * root lane:
   * - a `PostToolUse` that actually launched background work contributes one
   *   confirmed member. A `PreToolUse` `run_in_background` intent, a failed
   *   launch, and a foreground agent produce no such projection at all, so they
   *   contribute nothing here either.
   * - a ROOT `Stop` carrying `background_members` is a complete census and
   *   resyncs the ledger exactly, including a real empty set.
   * - a ROOT `Stop` carrying only totals replaces the last-reported snapshot;
   *   absent or unreadable totals are unknown, never a retained number and never
   *   a zero. Totals that disagree with a census this ledger can state prove at
   *   least one membership edge of THAT category went unobserved, so exactly
   *   that category withdraws to unknown rather than silently under- or
   *   over-counting — and the other category, which the disagreement says nothing
   *   about, keeps its exact number.
   * - when the provider's own snapshot says it held an active member it could not
   *   key, it names the closed categories in `background_unidentified_kinds`.
   *   Those categories lose their ledger coverage AND their last-reported number
   *   (an unattributable member cannot be settled by any later edge), while every
   *   other category this run can still state goes on publishing exactly what it
   *   knew. That is the whole point of carrying the kind gap: one unkeyable agent
   *   is not a hole in the shells.
   * Ordinary foreground work is not a membership edge, so the published numbers
   * survive it as last-reported until one of membership's own invalidators lands.
   *
   * A CHILD event is never root membership, but it is not inert either: it is the
   * only place an agent's own lifetime is visible. {@link #noteAgentEdge} handles
   * that lane, and it never replaces, erases, or withdraws the root census.
   */
  #noteMembership(event: NativeHookEvent, isRoot: boolean, hookEventName: string): void {
    if (!isRoot) {
      this.#noteAgentEdge(event, hookEventName);
      return;
    }

    if (hookEventName === "PostToolUse") {
      const launch = readNativeClaudeBackgroundLaunch(event);
      if (launch === null) return;
      this.#ensureLedgerScope();
      const observation = this.#ledger.observeStarted(this.#ledgerScope, launch);
      // A launch this ledger ACTUALLY records is membership change the last totals
      // snapshot cannot account for, and it names its own category: the ledger
      // carries that category from here, while the other category's last-reported
      // number stands. A replayed launch the ledger ignored is not new evidence at
      // all, so it may not delete a totals snapshot that arrived after it.
      if (observation.outcome !== "ignored") this.#invalidateSnapshotKinds([launch.kind]);
      return;
    }
    if (hookEventName !== "Stop") return;

    // The provider's own snapshot is now the authority on this run's membership:
    // the launch-time baseline vouch is spent, and the numbers come from here on.
    this.#startupVouched = false;
    const members = readNativeClaudeBackgroundMembers(event);
    if (members !== null) {
      this.#ensureLedgerScope();
      this.#ledger.replaceFullRootMembers(this.#ledgerScope, members);
      this.#snapshotCounts = null;
      return;
    }
    const totals = readBackgroundCounts(event);
    const kindGaps = readNativeClaudeBackgroundKindGaps(event);
    // A category the provider could not key states no last-reported number for
    // that category; the categories it did key still do.
    this.#snapshotCounts = totals === null
      ? null
      : {
        tasks: kindGaps.includes("task") ? null : totals.tasks,
        shells: kindGaps.includes("shell") ? null : totals.shells,
      };
    const holes = new Set<NativeClaudeBackgroundKind>(kindGaps);
    if (totals !== null) {
      const coverage = this.#ledger.coverage();
      if (coverage.tasks !== null && coverage.tasks !== totals.tasks) holes.add("task");
      if (coverage.shells !== null && coverage.shells !== totals.shells) holes.add("shell");
    }
    if (holes.size > 0) this.#ledger.noteCoverageGap(this.#ledgerScope, [...holes]);
  }

  /**
   * Feed this run's LIVE agent census from the child lane.
   *
   * Every edge here is fenced on what actually identifies this owned run rather
   * than on any turn clock: the child hook must name THIS run's bound root
   * session (the provider carries the root session id on every child hook), and
   * when it names a transcript path it must name this run's bound root file, not
   * a child file. The global root prompt journal is deliberately not consulted:
   * Claude reuses the root journal's `prompt_id` for a woken agent long after the
   * root turn that minted it ended, so prompt equality can neither admit nor
   * refuse an agent edge. The controller instance itself is the row, PTY
   * incarnation, and current run; the scope token it mints is what the projection
   * fences on, and a scope boundary clears it.
   *
   * What is admitted:
   * - `SubagentStart` is the ONE edge that makes an agent identity known, and it
   *   is what puts a live agent into the counted set. It is not a census member
   *   claim: the provider's own in-flight snapshot, when it carries one, remains
   *   the authority on the ledger.
   * - a child `PreToolUse`/`PostToolUse` is a further execution edge for an
   *   identity already known, and reopens an id whose window had closed.
   * - a child `PostToolUse` whose own result positively launched background work
   *   is BOTH an execution edge and the only proof that this agent owns that
   *   member. The launched member then joins the run's census exactly like a
   *   root-launched one (a background shell a child started is still a shell of
   *   this session), and it is recorded as owned, which is what turns the agent's
   *   later turn boundary into a park instead of a death.
   * - `SubagentStop` closes the turn. It is per-turn, never a death: whether it
   *   ends the agent depends on whether the boundary payload showed the agent
   *   still owning anything running or pending.
   *
   * What is refused: an identity this projection has never seen start, an
   * unusable identity, an event naming another conversation or a child
   * transcript, and any event while no root scope is bound. A refused edge
   * establishes nothing, mutates nothing, and opens no hole — it is an edge about
   * an agent this run's own start evidence never named, so it cannot be
   * attributed to this run's live census either way. While such an agent runs the
   * provider's own root snapshot still lists it, which is what keeps its
   * membership counted; only its parked lifetime is unavailable, and inventing a
   * hole from an unattributable edge is how an unrelated child would erase a
   * healthy census.
   */
  #noteAgentEdge(event: NativeHookEvent, hookEventName: string): void {
    const agentId = readToken((event as { agent_id?: unknown }).agent_id);
    if (agentId === null) return;
    if (this.#sessionId === null) return;
    if (readToken((event as { session_id?: unknown }).session_id) !== this.#sessionId) return;
    const eventPath = readToken((event as { transcript_path?: unknown }).transcript_path);
    if (eventPath !== null && this.#transcriptPath !== null && eventPath !== this.#transcriptPath) return;
    // One position per event, taken from the bound root transcript this run reads.
    // It is what lets a completion record be fenced against the execution window
    // that produced it instead of the window that happened to consume it.
    const mark = this.#markNow();

    if (hookEventName === "SubagentStart") {
      this.#agents.observeAgentStart(this.#ledgerScope, agentId, mark);
      return;
    }
    if (hookEventName === "PreToolUse") {
      if (!this.#unseenChildRequest(event, agentId)) return;
      this.#agents.observeAgentActivity(this.#ledgerScope, agentId, mark);
      return;
    }
    if (hookEventName === "PostToolUse") {
      // A replayed child result is not a newer execution edge. One tool request
      // is issued once, so a result this projection already consumed for this
      // identity describes work it has already accounted for: it neither reopens a
      // closed window nor re-attributes a member that has since settled. It is
      // dropped BEFORE anything is admitted, so replay cannot resurrect an ended
      // agent or hand it ownership of a member that ended long ago.
      if (!this.#unseenChildRequest(event, agentId)) return;
      if (!this.#agents.observeAgentActivity(this.#ledgerScope, agentId, mark).changed) return;
      const launch = readNativeClaudeBackgroundLaunch(event);
      if (launch === null) return;
      // The agent is known and this is this run's own conversation, so the member
      // it launched is this session's member: a child's background shell is a
      // shell of this run, not somebody else's. It enters the census on the same
      // terms as a root launch and is attributed to the agent that started it.
      this.#ensureLedgerScope();
      const observation = this.#ledger.observeStarted(this.#ledgerScope, launch);
      if (observation.outcome !== "ignored") this.#invalidateSnapshotKinds([launch.kind]);
      // A launch the LEDGER refuses because that member already settled is not
      // fresh ownership: the child's own end landed before its launch edge did, so
      // this result is late and cannot make a settled member live-owned again.
      if (observation.reason === "late-start-after-settle") return;
      this.#agents.observeOwnership(this.#ledgerScope, agentId, launch.id, mark);
      return;
    }
    if (hookEventName === "SubagentStop") {
      // `null` here means the boundary carried no readable membership array, so
      // this observer cannot show the agent owned nothing and claims no end.
      const members = readNativeClaudeBackgroundMembers(event);
      const inFlight = members === null ? null : members.map((member) => member.id);
      this.#agents.observeTurnEnd(this.#ledgerScope, agentId, inFlight, mark);
      this.#bindChildTranscript(event, agentId);
      return;
    }
  }

  /**
   * True once for each child-scoped tool edge of one request of one identity.
   * `tool_use_id` is the provider's own per-request identity and a request is
   * issued exactly once, so a repeat of the same identity is the same result
   * arriving twice — never newer work, and never a reason to reopen a window.
   * `PreToolUse` and `PostToolUse` of one request share an id, so the event name
   * is part of the key.
   *
   * Omitting `tool_use_id` is permitted by the protocol, so it cannot mean "one
   * request per agent per event": two genuinely different launches that happen to
   * arrive without one would collapse into each other, and the second member would
   * never reach membership or ownership — an exact count that is simply wrong. When
   * there is no request identity, the validated background launch's OWN identity is
   * used as the discriminator instead, because the provider keys each launched
   * member exactly once. A launch-less edge with no request identity at all has
   * nothing to key on and shares the one fallback slot; that costs it a window
   * reopen and nothing else.
   */
  #unseenChildRequest(event: NativeHookEvent, agentId: string): boolean {
    const toolUseId = readToken((event as { tool_use_id?: unknown }).tool_use_id);
    // A consumed result tombstones its request: the provider answers a call only
    // after it, so ANY later edge naming that id — a replayed result, or even that
    // request's own `PreToolUse` arriving out of order — is older or duplicate
    // evidence about a request that already finished.
    if (toolUseId !== null && this.#settledChildRequests.has(toolUseId)) return false;
    // Only a launch that independently validates carries a member identity worth
    // keying on, and a request id already excludes the need for one.
    const launchId = toolUseId === null
      ? readNativeClaudeBackgroundLaunch(event)?.id ?? ""
      : "";
    const key = `${agentId}\u0000${event.hook_event_name}\u0000${toolUseId ?? ""}\u0000${launchId}`;
    if (this.#seenChildRequests.has(key)) return false;
    this.#seenChildRequests.add(key);
    if (event.hook_event_name === "PostToolUse" && toolUseId !== null) {
      this.#settledChildRequests.add(toolUseId);
    }
    while (this.#seenChildRequests.size > MAX_SEEN_CHILD_REQUEST_KEYS) {
      const oldest = this.#seenChildRequests.values().next();
      if (oldest.done) break;
      this.#seenChildRequests.delete(oldest.value);
    }
    while (this.#settledChildRequests.size > MAX_SEEN_CHILD_REQUEST_KEYS) {
      const oldest = this.#settledChildRequests.values().next();
      if (oldest.done) break;
      this.#settledChildRequests.delete(oldest.value);
    }
    return true;
  }

  /**
   * One position inside the one bound root transcript this run reads. The token is
   * that file's device/inode identity, so a position can only ever be compared
   * against another position in the same file: a replacement or a restart is a
   * different token, and two different tokens order nothing.
   */
  #markAt(
    identity: NativeJsonlFileIdentity | null,
    offset: number,
  ): NativeClaudeAgentLifetimeMark | null {
    if (identity === null) return null;
    return { sourceToken: `${identity.dev}:${identity.ino}`, offset };
  }

  /**
   * The bound transcript's position right now, or null when it cannot be sized.
   * A child lane has no barrier of its own to take, so this is exactly the size the
   * root file had when the edge arrived.
   */
  #markNow(): NativeClaudeAgentLifetimeMark | null {
    const stat = this.#statBound();
    if ("gap" in stat) return null;
    return this.#markAt({ dev: stat.stats.dev, ino: stat.stats.ino }, stat.stats.size);
  }

  /**
   * Bind the one named child transcript a `SubagentStop` positively handed over,
   * for the one agent that boundary closed.
   *
   * Nothing here is discovered: an agent whose boundary named no path keeps no
   * lane, an identity this run never saw start is refused a lane outright (it
   * would be a path bound to nobody), and a lane whose path changed is discarded
   * rather than re-pointed, because a cursor into one file says nothing about the
   * file that replaced it. Reading is event-driven and never a poll: a lane is read
   * when its own boundary arrives, and again when the root journal reports one of
   * that agent's members settling — the two moments the provider itself delivers
   * work into that agent.
   */
  #bindChildTranscript(event: NativeHookEvent, agentId: string): void {
    if (!this.#agents.knowsAgent(agentId)) return;
    const childPath = readToken((event as { agent_transcript_path?: unknown }).agent_transcript_path);
    if (childPath === null) return;
    const existing = this.#childLanes.get(agentId);
    if (existing !== undefined && existing.path !== childPath) this.#childLanes.delete(agentId);
    if (!this.#childLanes.has(agentId)) {
      this.#childLanes.set(agentId, { path: childPath, identity: null, cursor: 0, reading: false, readAgain: false });
    }
    void this.#readChildLane(agentId);
  }

  /**
   * Read one child lane once. Nothing is applied unless the read still belongs to
   * the current generation, and a read that cannot be completed is a closed gap
   * about THAT agent's own evidence: it never reaches another agent's lifetime,
   * the shell census, or the root foreground, and it is never read as "nothing was
   * routed" — an unreadable file states nothing, which is not the same fact.
   *
   * A request that arrives while a read is in flight is coalesced, never dropped,
   * and drained only after that read has committed — and only while the lane, its
   * agent's ownership of it, and the generation are all still the ones it was made
   * under. A lane that was discarded, rebound, or gapped meanwhile is not read again
   * on its behalf, and nothing is retried that was not actually requested.
   */
  async #readChildLane(agentId: string): Promise<void> {
    const lane = this.#childLanes.get(agentId);
    if (lane === undefined || this.#disposed) return;
    if (lane.reading) {
      lane.readAgain = true;
      return;
    }
    lane.reading = true;
    const generation = this.#generation;
    let gap: NativeClaudeAcquisitionGapReason | null = null;
    let records: readonly string[] = [];
    let readIdentity: NativeJsonlFileIdentity | null = null;
    let scannedTo: number | null = null;
    try {
      const result = await readNativeJsonlTail({
        path: lane.path,
        from: lane.cursor,
        maxBytes: this.#maxTailBytes,
        maxLineBytes: this.#maxLineBytes,
        ...(lane.identity === null ? {} : { expectIdentity: lane.identity }),
      });
      if (!result.ok) {
        gap = mapTailFailure(result.reason);
      } else if (result.skippedBefore) {
        gap = "skipped-window";
      } else if (result.oversizedLines > 0) {
        gap = "oversized";
      } else {
        records = result.records;
        readIdentity = result.identity;
        scannedTo = result.scannedToIsRecordBoundary ? result.scannedTo : null;
      }
    } catch {
      gap = "unreadable";
    } finally {
      lane.reading = false;
    }
    try {
      // A retired scope, a newer generation, or a lane this agent no longer owns
      // discards the read outright.
      if (this.#disposed || generation !== this.#generation || this.#childLanes.get(agentId) !== lane) return;
      if (gap !== null) {
        this.#childLaneGap(agentId, gap);
        return;
      }
      lane.identity = readIdentity;
      // A window that ended inside a record advances nothing: that record stays
      // unread and is read again whole once the provider finishes appending it.
      if (scannedTo !== null) lane.cursor = scannedTo;
      for (const record of records) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(record);
        } catch {
          // A row this lane cannot parse is a hole in THIS agent's routed-completion
          // evidence, not a fact about the run's membership.
          this.#childLaneGap(agentId, "malformed");
          return;
        }
        if (!isRecord(parsed)) {
          this.#childLaneGap(agentId, "malformed");
          return;
        }
        const routed = readRoutedTaskCompletion(parsed, this.#sessionId, agentId);
        if (routed === null) continue;
        // Work the provider delivered INTO this agent. It is a positive routed
        // completion witness for this agent rather than a queued wake — the delivery
        // names the agent that received it — and no position is needed, because
        // settling a member is monotone. The lifetime still refuses to read this as
        // the agent's own end.
        const applied = this.#agents.observeSettled(this.#ledgerScope, routed, null);
        // The same envelope the root journal carries, read from the file it was
        // delivered into. It settles work this run's OWN census holds; it never
        // reaches a member this run never tracked, because a lane bound to one agent
        // states nothing about the rest of the census and must not open a hole there.
        const tracked = this.#ledger.snapshot().members.find((member) => member.id === routed);
        if (tracked !== undefined) {
          const settled = this.#ledger.observeSettled(this.#ledgerScope, routed);
          if (settled.reason !== "duplicate-settle") this.#invalidateSnapshotKinds([tracked.kind]);
        }
        if (applied.changed) this.#emit();
      }
    } finally {
      // A request made while this read was in flight is drained now that it has
      // committed. The lane must still be the one this agent owns under the same
      // generation: a discarded, rebound, or gapped lane is not resurrected, and the
      // pending bit dies with it.
      const drain = lane.readAgain;
      lane.readAgain = false;
      if (drain && !this.#disposed && generation === this.#generation && this.#childLanes.get(agentId) === lane) {
        void this.#readChildLane(agentId);
      }
    }
  }

  /**
   * One child lane's coverage is gone: the gap is reported through the same closed
   * channel, and that ONE agent's lifetime is marked uncertain — its identity and
   * counted state preserved, its eligibility to stand in an exact published census
   * withdrawn until its own evidence resumes.
   *
   * A file that has NEVER been read is the one case that loses nothing, and it is
   * also the one case that must keep its lane. A provider creates a transcript
   * eventually, so a positively named path that has not appeared yet holds nothing
   * that could have been missed — but the binding came from the provider and stays
   * true, so the lane has to survive to be retried by the root events that already
   * exist. Dropping it here would strand a real delivery behind a file that merely
   * arrived late. A lane whose identity WAS established is different: the file it
   * read is gone, so it is discarded and its agent's coverage degrades.
   */
  #childLaneGap(agentId: string, reason: NativeClaudeAcquisitionGapReason): void {
    const lane = this.#childLanes.get(agentId);
    const neverRead = lane === undefined || lane.identity === null;
    this.#reportGap(reason);
    if (reason === "unavailable" && neverRead) return;
    this.#childLanes.delete(agentId);
    this.#agents.observeAgentGap(this.#ledgerScope, agentId);
    this.#emit();
  }

  /**
   * Give every agent that still owns unsettled work one child-lane read, driven by
   * a root-journal read that already happened. This adds no watcher, no timer, and
   * no polling: it is the same event, and it is what lets a delivery the provider
   * wrote into the child's own file settle work even where the root journal's row
   * for it was never readable.
   */
  #readOwnedChildLanes(): void {
    if (this.#childLanes.size === 0) return;
    for (const agentId of this.#childLanes.keys()) void this.#readChildLane(agentId);
  }

  /**
   * Bind the ledger to this run before its first membership edge. A run the host
   * launched already holds a positively known empty baseline; any other run is
   * ADOPTED, which tracks members but publishes nothing until a complete root
   * snapshot proves the census whole — a mid-stream join never claims the empty
   * set it did not observe from the beginning.
   */
  #ensureLedgerScope(): void {
    if (this.#ledger.snapshot().scopeToken === null) this.#ledger.adoptRootSession(this.#ledgerScope);
  }

  /**
   * Withdraw the last-reported totals snapshot CATEGORY by CATEGORY, for exactly
   * the categories a proven membership edge contradicts. A category no edge
   * touched keeps its last-reported number; an edge that proves membership change
   * without naming a category withdraws both, because a hole nobody can attribute
   * is a hole in the whole census. This never invents a number for the withdrawn
   * category and never lets the surviving one stand for the pair.
   */
  #invalidateSnapshotKinds(kinds: readonly NativeClaudeBackgroundKind[]): void {
    const totals = this.#snapshotCounts;
    if (totals === null) return;
    const tasks = kinds.length === 0 || kinds.includes("task") ? null : totals.tasks;
    const shells = kinds.length === 0 || kinds.includes("shell") ? null : totals.shells;
    this.#snapshotCounts = tasks === null && shells === null ? null : { tasks, shells };
  }

  /**
   * The pair this controller may publish: the ledger's exact live census whenever
   * membership is known, otherwise the last ROOT `Stop` totals snapshot,
   * otherwise unknown — decided CATEGORY by CATEGORY. A category with a hole
   * publishes `null` even when the other category publishes an exact number, so a
   * task-side evidence loss can never erase a known shell census or the other way
   * round. Every membership edge clears the totals, so the two sources never
   * contradict each other and an unknown census never falls back to a number that
   * edge already contradicted.
   *
   * The TASK category is the DISTINCT UNION of two things that answer different
   * questions: the ledger's generic non-shell in-flight members (what the
   * provider's own census currently lists — agents, monitors, workflows, and
   * anything else the provider does not label a shell), and this run's LIVE agent
   * identities, which include the agents no in-flight snapshot lists any more
   * because they have parked, are waiting to be woken, or have ended their final
   * turn without their end being established yet. An id counted by both is ONE
   * task, never two, and a background shell an agent launched stays in SHELLS and
   * is never added to tasks. The union only ever applies to an exact ledger
   * census: a last-reported totals snapshot is the provider's own stated number
   * for a scope whose live set this observer cannot state, and blending an agent
   * lifetime count into it would present a mixed provenance as one exact figure.
   *
   * One thing makes the task side unstateable rather than merely large: an id the
   * provider currently lists as a SHELL member that this run also knows as a live
   * AGENT. The provider keys both categories in one task-registry namespace, so
   * that is not a count this observer can defend either way — it is an identity
   * conflict, and the task category goes unknown while the shell census the
   * provider stated keeps standing.
   *
   * A last-reported totals snapshot is kept ONLY where this observer holds no live
   * agent to reconcile it against. The provider's total is a count of work CURRENTLY
   * IN FLIGHT, and a live agent may or may not be inside that set — nothing in a
   * total says which. Numerical capacity is not membership evidence: a total of two
   * beside one positively live agent does not prove the two include it, and it does
   * not prove they do not. So once this run holds a live agent and cannot state
   * exact membership, the task axis is withdrawn rather than published on an
   * unproven overlap, and the other axis keeps its number. With no live agent and no
   * overlay the totals fallback behaves exactly as it always did.
   *
   * Finally, an agent whose own lifetime crosses an evidence gap this observer
   * cannot see through is preserved but not published: the identities it holds may
   * be alive and it may hold more than it can name, so the task axis is unknown
   * until that agent's own evidence resumes. A complete root snapshot repairs the
   * LEDGER's census; it does not repair a lifetime.
   */
  #publishedCounts(): NativeClaudeBackgroundCoverage {
    const coverage = this.#ledger.coverage();
    const totals = this.#snapshotCounts;
    const shells = coverage.shells ?? totals?.shells ?? null;
    if (this.#agents.hasUnresolvedCounted()) return { tasks: null, shells };
    if (coverage.tasks === null) {
      // An overlay this observer cannot reconcile against exact membership is enough
      // to withdraw the axis: an agent may be inside the provider's in-flight total
      // or outside it, and no arithmetic on the total can tell the two apart.
      if (this.#agents.liveIds().length > 0) return { tasks: null, shells };
      return { tasks: totals?.tasks ?? null, shells };
    }
    const liveAgents = this.#agents.liveIds();
    if (liveAgents.length === 0) return { tasks: coverage.tasks, shells };
    const members = this.#ledger.snapshot().members;
    const taskIds = new Set<string>();
    for (const member of members) {
      if (member.kind === "task") taskIds.add(member.id);
    }
    for (const id of liveAgents) {
      if (members.some((member) => member.id === id && member.kind === "shell")) {
        return { tasks: null, shells };
      }
      taskIds.add(id);
    }
    return { tasks: taskIds.size, shells };
  }

  // --- reading: terminal witness and published-state monitoring -------------

  /**
   * True while there is anything worth reading the file for: an armed terminal
   * read, or published state (a live census or count snapshot, or ANY idle
   * foreground claim the reducer is currently making — a witness-confirmed
   * `Ready` or a corroborated fresh-start idle) whose validity, task transitions,
   * and any newer ROOT model row still have to be watched, or a question request
   * the hook lane opened and
   * has never seen close — its closure can live only in this file, so a declined
   * question must not wait for some other event to be resolved.
   */
  #shouldRead(): boolean {
    return this.#armed !== null
      || this.#hasPublishedCounts()
      || this.#idlePublished()
      || this.#reducer.openQuestionRequestIds().length > 0;
  }

  /**
   * True while EITHER published category still holds a number worth monitoring:
   * one exact census and one unknown category is still a published state, and a
   * read is what can still settle or correct the exact half.
   */
  #hasPublishedCounts(): boolean {
    const counts = this.#publishedCounts();
    return counts.tasks !== null || counts.shells !== null;
  }

  /**
   * True while the reducer publishes a genuine IDLE foreground — a source-read
   * terminal record, a corroborated fresh start, or the host's own launch
   * baseline. A foreground published `false` because a question request stands is
   * stopped-on-input in the middle of a live turn, not an idle claim, and must
   * never be contradicted as if the turn had ended. A fresh-start idle is not a
   * claim READ from this file, but this file is still the only thing that can
   * contradict it once the hook lane goes silent, so it stays monitored.
   */
  #idlePublished(): boolean {
    return this.#reducer.idleForegroundPublished();
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
    // loss) replaces or withdraws it exactly like any other snapshot. It is a
    // totals-level claim, not a minted census: only the host's own spawn may seed
    // the ledger's known-empty set, so a run observed from outside keeps these
    // corroborated zeros until its first complete membership snapshot.
    this.#snapshotCounts = { tasks: 0, shells: 0 };
    // This read consumed the entire file, so the monitor's floor starts here and
    // the first row of any later turn is still seen.
    if (scannedTo !== null && readIdentity !== null) {
      this.#cursor = scannedTo;
      this.#identity = readIdentity;
      this.#transcriptSeenPath = this.#transcriptPath;
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
    // A file this controller was WAITING for was created by this very run, so
    // nothing in it predates the conversation being observed: the scan starts at
    // its first record, and a launch confirmation, a persisted question result, or
    // a completion written before anyone could watch still lands. A file that was
    // already there when monitoring started keeps the prior-history floor, so an
    // older turn's row can never close a newer one.
    const appeared = this.#awaitedTranscriptPath === this.#transcriptPath;
    this.#awaitedTranscriptPath = null;
    this.#cursor = appeared ? 0 : stat.stats.size;
    this.#identity = { dev: stat.stats.dev, ino: stat.stats.ino };
    this.#transcriptSeenPath = this.#transcriptPath;
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
    if (!this.#ensureScanFloor()) {
      // Nothing can be scanned yet. If the reason is simply that the provider has
      // not created this file, that creation has to be an EVENT: no later hook is
      // guaranteed to arrive, and a poll or timer is not available. Every other
      // gap reports itself where it happened and gets no watch.
      this.#armMaterializationWatch();
      return;
    }
    this.#closeMaterializationWatch();
    if (this.#watcher === null) this.#attachWatcher();
  }

  /**
   * Arm the one bounded creation watch for the bound transcript's parent
   * directory. Its callback answers exactly one question — has the bound file
   * appeared yet — and hands over to {@link #syncWatcher} either way, so no
   * observation is derived from the directory itself and nothing is read from it.
   */
  #armMaterializationWatch(): void {
    const path = this.#transcriptPath;
    if (this.#disposed || path === null) return;
    if (this.#pendingFileWatch !== null && this.#awaitedTranscriptPath === path) return;
    const bound = this.#statBound();
    if ("stats" in bound || bound.gap !== "unavailable") {
      this.#closeMaterializationWatch();
      this.#awaitedTranscriptPath = null;
      return;
    }
    this.#closeMaterializationWatch();
    // The fact that this path did not exist yet is what later justifies scanning
    // the created file from its first record instead of skipping its history.
    this.#awaitedTranscriptPath = path;
    const generation = this.#generation;
    try {
      const handle = this.#watchFile(dirname(path), {
        onChange: () => {
          if (this.#disposed || generation !== this.#generation || this.#pendingFileWatch?.handle !== handle) return;
          this.#syncWatcher();
          // A file that just appeared may already hold this run's rows: read it
          // now rather than waiting for an append that may never come. A file that
          // still does not exist reports nothing at all.
          void this.#readTail();
        },
        onError: () => {
          if (this.#disposed || generation !== this.#generation || this.#pendingFileWatch?.handle !== handle) return;
          this.#closeMaterializationWatch();
          // Losing this watch is the coverage gap, not the file's absence: with a
          // tracked member and no guaranteed further hook, nothing else is left
          // that can ever consume this file's rows. The transcript lane's own
          // failure path withdraws ledger exactness and reports the gap, while the
          // hook lane's foreground, question census, and scope stay as observed.
          this.#transcriptFailure("watch-unavailable");
        },
      });
      this.#pendingFileWatch = { generation, handle };
    } catch {
      // Same fact, reached synchronously: the only mechanism that could learn this
      // file was created cannot be built, so exact membership cannot be defended.
      this.#transcriptFailure("watch-unavailable");
    }
  }

  #closeMaterializationWatch(): void {
    const pending = this.#pendingFileWatch;
    this.#pendingFileWatch = null;
    if (pending === null) return;
    try {
      pending.handle.close();
    } catch {
      // An already-closed watcher is the desired end state.
    }
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
    this.#closeMaterializationWatch();
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
    // Likewise the member ids this run's census holds active NOW: a membership row
    // that names one of them confirms the census instead of contradicting it.
    const activeMembers = new Set(this.#ledger.snapshot().members.map((member) => member.id));
    // Whether this run's LEDGER positively remembers one member as ALREADY
    // settled. A provider delivery of an end this ledger already applied is that
    // same fact restated, so the scan asks this one bit instead of reading the
    // delivery as membership change. The predicate is read-only and scope-fenced
    // (it mutates nothing, opens no lifetime window, and exposes no id list), and
    // it is resolved against the ledger as it stands whenever a window is
    // classified — including at the commit-time rescan below.
    const knownSettledId = (id: string): boolean => this.#ledger.hasSettled(this.#ledgerScope, id);
    const from = Math.max(armedFor?.byteOffset ?? 0, this.#cursor ?? 0);
    const expectIdentity = armedFor?.identity ?? this.#identity ?? undefined;
    this.#reading = true;

    let gap: NativeClaudeAcquisitionGapReason | null = null;
    let scan: WindowScan | null = null;
    let scannedTo: number | null = null;
    let readIdentity: NativeJsonlFileIdentity | null = null;
    // The window's records and where they start, kept for the commit below: a
    // membership or question edge accepted while this read is in flight is resolved
    // against what this run holds at COMMIT time, not against the set captured
    // before the await.
    let windowRecords: readonly string[] = [];
    let windowStart = 0;
    // The size observed under the SAME handle that produced this window, trailing
    // partial record included: what a committed window proves, it proves at this
    // size.
    let windowFileSize = 0;
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
        // Every record in the window, in order, starts exactly here: the tail
        // reader consumed whole newline-terminated lines up to `scannedTo`, and an
        // oversized line would have discarded this scan entirely.
        windowRecords = result.records;
        windowFileSize = result.fileSize;
        windowStart = result.scannedTo - result.records.reduce(
          (bytes, record) => bytes + Buffer.byteLength(record, "utf8") + 1,
          0,
        );
        scan = this.#scanRecords(
          result.records,
          armedFor !== null,
          sessionId,
          openQuestions,
          activeMembers,
          knownSettledId,
          windowStart,
        );
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
        this.#monitoringFailure(gap, armedFor !== null);
      } else if (scan !== null && scannedTo !== null && readIdentity !== null) {
        // A hook accepted while this window was in flight can name a member this
        // ledger holds NOW and did not hold when the read began — the ordinary
        // shape of an async launch, whose persisted `async_launched` row and whose
        // `background_started` confirmation land seconds apart. Judged against the
        // captured set that row is an unresolvable membership change, so the
        // census the hook just made exact would withdraw, and the cursor advanced
        // here would hide the row ever after. The same records are therefore
        // classified once more against what this run holds at commit time, and only
        // that result is applied. Malformed and oversized counts cannot depend on
        // identities, so the window's validity is already settled.
        const membersNow = new Set(this.#ledger.snapshot().members.map((member) => member.id));
        const questionsNow = new Set(this.#reducer.openQuestionRequestIds());
        if (!sameIdentityNames(activeMembers, membersNow) || !sameIdentityNames(openQuestions, questionsNow)) {
          scan = this.#scanRecords(
            windowRecords,
            armedFor !== null,
            sessionId,
            questionsNow,
            membersNow,
            knownSettledId,
            windowStart,
          );
        }
        // A persisted `tool_result` for a request this reducer holds open is that
        // request's own terminal evidence — the shape a declined, cancelled, or
        // answered question leaves when no `Post*` hook ever arrived. It is
        // applied first, because it is an independent fact about one request and
        // neither a membership transition nor newer work makes it less true. Only
        // the identity crossed here; no answer, error text, or result content.
        for (const requestId of scan.questionClosures) {
          this.#reducer.observeQuestionToolResult({ requestId, sessionId });
        }
        // A structured native task/launch transition is proven membership change,
        // so the identity-free totals snapshot can no longer describe this run
        // whichever way the window resolves. Where the row names the member that
        // ended, that member settles and the census stays exact — which is what
        // lets a background command finishing while the row sits `Ready`, or with a
        // question pending, move the count on its own event instead of waiting for
        // the next prompt's snapshot. Where it cannot name one this ledger tracks,
        // the census has a hole and withdraws to unknown until the next complete
        // root snapshot — at the width the row itself proves. A row that positively
        // names the category it changed (an async agent launch is a task) withdraws
        // only that category; a row that names none withdraws both, because a hole
        // nobody can attribute is a hole in the whole census. Nothing here
        // reconstructs a count or fabricates a zero.
        if (scan.transition) {
          // Which categories this window actually reaches: the ones an unresolved
          // row names, plus the categories the LEDGER itself reports as settled.
          // A settlement this ledger ignored (a repeat of an edge it already
          // applied) is not membership change and contradicts no last-reported
          // number. A settlement for an id it never tracked proves a launch this
          // run missed — a hole no row attributes — so it reaches BOTH categories
          // even when another settlement in the same window names one. A task-only
          // transition leaves a known shell total standing, and the other way
          // round; nothing here reconstructs a count or fabricates a zero.
          const touched: NativeClaudeBackgroundKind[] = [...scan.unresolvedKinds];
          const trackedMembers = this.#ledger.snapshot().members;
          for (const entry of scan.settlements) {
            const settledId = entry.id;
            const tracked = trackedMembers.find((member) => member.id === settledId);
            if (tracked === undefined && this.#agents.knowsAgent(settledId)) {
              // The id that ended is an AGENT of this run whose lifetime this
              // projection holds, not a census member whose launch edge went
              // missing. This run's own start edge is why it is counted, so its
              // terminal record is a fully attributed TASK settlement: it moves
              // the task category, and it is not evidence that this run lost
              // sight of a member it should have been tracking.
              if (!touched.includes("task")) touched.push("task");
            } else {
              const settlement = this.#ledger.observeSettled(this.#ledgerScope, settledId);
              // A repeat of an edge this ledger already applied is not membership
              // change, and stale evidence may not delete a totals snapshot that
              // arrived after it.
              if (settlement.reason !== "duplicate-settle") {
                const kind = tracked?.kind;
                if (kind !== undefined) {
                  if (!touched.includes(kind)) touched.push(kind);
                } else {
                  // A settlement this ledger cannot attribute to one of its own
                  // members proves a launch this run missed — a hole no row names
                  // — so it reaches both categories even beside a settlement that
                  // does.
                  noteUnresolvedKind(touched, null);
                }
              }
            }
            // The same positive terminal record drives the live-agent lifetime:
            // it is what turns a parked agent into one waiting to be woken, and —
            // fenced to the execution window its own record position proves — one
            // conjunct of an agent's actual end. It is applied to every settlement
            // this window named, whichever way the census arithmetic above resolved.
            this.#agents.observeSettled(
              this.#ledgerScope,
              settledId,
              this.#markAt(readIdentity, entry.offset),
            );
          }
          if (touched.length > 0) this.#invalidateSnapshotKinds(touched);
          if (scan.unresolvedTransition) {
            this.#ledger.noteCoverageGap(this.#ledgerScope, scan.unresolvedKinds);
          }
        }
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
          this.#transcriptSeenPath = path;
          // A root-work hook accepted while the file did not exist could not state
          // a position, so it suppressed the foreground floor rather than risk
          // discarding a positive hook observation. That suppression is only ever
          // meant to cover the window this read just consumed: from here the file
          // has a real size, so the floor becomes finite and a newer root row this
          // run's hook lane never saw can end a published waiting state again.
          //
          // Only a window that actually consumed a whole record ends it. The
          // provider creates the file before it writes its first record, so the
          // creation can wake a read that finds it empty, or holding only the
          // first record's leading bytes: that read consumed nothing, the rows the
          // suppressed hook described are all still ahead of it, and a finite
          // floor here would present them as newer work than the hook observed.
          if (this.#foregroundFloor === Number.POSITIVE_INFINITY && windowRecords.length > 0) {
            this.#foregroundFloor = windowFileSize;
          }
          if (armedFor !== null) this.#applyWitness(armedFor, sessionId, scan.candidates);
          // A root prompt or model row while the row is published as
          // stopped-on-input shows the provider moved on without this run's hook
          // lane: the pause is over, so the foreground becomes unverifiable rather
          // than staying a claim the file contradicts. It proves nothing about the
          // request itself — the open request keeps its identity, still counts as
          // pending input, and its own close edge still lands.
          if (scan.foregroundWork && this.#reducer.questionBlocksForeground()) {
            this.#reducer.noteRootWorkBeyondClaims();
          }
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
    // The provider writes a routed delivery into an agent's own named transcript at
    // the same moment it records the corresponding row in the root journal, so this
    // append is the event that reaches it. No watcher, timer, or poll is added: one
    // bounded read per existing lane, on a read that already happened.
    this.#readOwnedChildLanes();
    this.#syncWatcher();
    this.#emit();
  }

  /**
   * Classify every complete record in the window. Only closed discriminators are
   * read — row `type`/`subtype`, `attachment.type`/`attachment.taskId`/
   * `attachment.status`, `origin.kind`/`origin.producer`, `toolUseResult.status`
   * and `toolUseResult.agentId`, the root-model markers (`isSidechain`, agent id,
   * session, and the presence of a `message` object), the block `type` of a
   * persisted `tool_result`, the `type` and `id` of a persisted ROOT `assistant`
   * row's `tool_use` blocks (identities only, never a name, an input, or prose),
   * the provider-injection markers (`isMeta`,
   * `commandMode`, `origin.kind`), the `queue-operation` row's `operation` and
   * `sessionId` plus only the `task-id`/`status` tags inside its completion
   * envelope, the same two tags inside one completion envelope in a task-origin
   * `queued_command` attachment's `prompt`, and the summary row's
   * rootness/terminality fields.
   * No content, command, description, output, summary, output path, notification
   * body, question, answer, or error text: a membership id is consumed as an
   * opaque key and never leaves the controller.
   *
   * `recordOffset` is where the first record of this window starts in the file, so
   * each row's position is known: a foreground contradiction is only ever raised by
   * a row that begins at or beyond the floor the latest accepted root-work hook
   * established. Membership and question-result rows are consumed regardless of
   * position, because they correct facts the hook lane never reported rather than
   * claiming the conversation moved on.
   *
   * `knownSettledId` answers one bit about an id this window names: whether this
   * run's ledger already settled it. It exists so a delivery of an end that was
   * already applied is read as the same fact rather than as a hole, and it is
   * consulted only for that — it never settles, opens, or withdraws anything.
   */
  #scanRecords(
    records: readonly string[],
    seekWitness: boolean,
    sessionId: string | null,
    openQuestionIds: ReadonlySet<string>,
    activeMemberIds: ReadonlySet<string>,
    knownSettledId: (id: string) => boolean,
    recordOffset: number,
  ): WindowScan {
    let malformed = 0;
    let transition = false;
    let unresolvedTransition = false;
    const unresolvedKinds: NativeClaudeBackgroundKind[] = [];
    const settlements: { id: string; offset: number }[] = [];
    let foregroundWork = false;
    let newRootPromptWork = false;
    let firstCandidateIndex = -1;
    let foregroundWorkAfterCandidate = false;
    const candidates: NativeClaudeTerminalRecord[] = [];
    const questionClosures: string[] = [];
    for (const [index, record] of records.entries()) {
      // Whole lines, in order: this row starts here and the next starts after it.
      const recordStart = recordOffset;
      recordOffset += Buffer.byteLength(record, "utf8") + 1;
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
      const membership = readMembershipTransition(parsed, activeMemberIds, sessionId, knownSettledId);
      if (membership !== null) {
        transition = true;
        if (membership.settle === null) {
          noteUnresolvedKind(unresolvedKinds, membership.kind);
          unresolvedTransition = true;
        } else if (settlements.length >= MAX_SETTLEMENTS_PER_WINDOW) {
          // A settlement this window could not carry is a hole, not a truncation.
          noteUnresolvedKind(unresolvedKinds, null);
          unresolvedTransition = true;
        } else {
          // Every record keeps its own position. Collapsing repeated settlements
          // by identity would keep whichever offset arrived first, and for a
          // RESUMED agent the two records of one id are not the same fact: the
          // older one is fenced out of the current window while the newer one is
          // the evidence that ends it. Keeping both is safe because settling a
          // member is monotone — the second application is a no-op.
          settlements.push({ id: membership.settle, offset: recordStart });
        }
      }
      const rootRow = classifyRootTurnRow(parsed, sessionId);
      // Only a persisted human PROMPT row or a root `assistant` model row that
      // STARTED AFTER the latest accepted root-work hook is newer FOREGROUND work.
      // A row written earlier belongs to the turn that hook just described, and
      // reaching it late is a consequence of the preserved scan cursor, not of the
      // conversation moving on. A result-only row or a provider-injected
      // notification carries the conversation without starting a turn of its own,
      // so it outranks nothing: it must never cost a published Ready its
      // foreground, its question census, or a still-open child request.
      //
      // One root `assistant` row is NOT newer work either: the persisted
      // INVOCATION of a question request this run already accepted on its own hook
      // lane. The provider appends that row seconds after the `PreToolUse` it
      // mirrors, so it lands past the hook's floor while describing work this
      // observer reported as already running — the same tool call, not a newer
      // one. It is recognized positively, from the block shape and identities
      // alone, and only for the requests THIS read holds open as ROOT questions:
      // a row mixing in an unseen id, carrying a non-`tool_use` block, or holding
      // plain prose is a model that produced something new and still counts as
      // newer root work, exactly as before.
      const foreground = (rootRow === "prompt" || rootRow === "model")
        && !(rootRow === "model" && isOwnOpenQuestionInvocation(parsed, openQuestionIds))
        && recordStart >= this.#foregroundFloor;
      if (rootRow !== "none") {
        if (foreground) foregroundWork = true;
        if (foreground && rootRow === "prompt") newRootPromptWork = true;
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
      settlements,
      unresolvedTransition,
      unresolvedKinds,
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
    // The terminal-witness authority for the contradicted claim goes; the scan
    // offset stays, so rows this read had not reached are still read next instead
    // of being skipped past by a re-established floor at end-of-file.
    this.#retireTerminalWitness();
    // The conversation moved past whatever this controller published, and it did
    // so without this run's hook lane saying a word: the foreground claim it
    // supported is no longer trustworthy and goes unknown. It is NOT proof that
    // an open question request closed — that request's own close edge still owns
    // it, and a declined or unanswered request must not be erased by newer work
    // elsewhere in the file. A window that only carried a task transition, a
    // settlement, or a tool-result row never reaches this path — those rows
    // contradict nothing about the foreground.
    this.#reducer.noteRootWorkBeyondClaims();
    // A retained count is still a published value: keep watching the same file
    // from where this read left off, so membership change can still contradict it.
    this.#syncWatcher();
    this.#emit();
  }

  /**
   * A loss of the authenticated hook lane: what that lane supported — the
   * foreground, this run's scope binding, and the count snapshot it last
   * published — collapses to unknown, never to zero. This is the ONLY thing that
   * withdraws the whole lane, and it is reached only from an authenticated
   * failure of that lane: a recognized payload this observer could not read is a
   * degradation the reducer states axis by axis, never a transport loss, and it
   * must not cost the run its session admission or its live background census.
   */
  #hookLaneFailure(reason: NativeClaudeAcquisitionGapReason): void {
    this.#startupVouched = false;
    this.#baselineRetired = true;
    this.#retire();
    this.#snapshotCounts = null;
    // The authenticated lane is where every membership edge comes from, so a loss
    // of it is a real hole in the census, not just in the last snapshot. The live
    // agent census comes from that same lane: an agent that ended, parked, or was
    // woken during the hole is indistinguishable from one that kept running, so
    // every tracked identity is marked uncertain. Its identity and its counted
    // state SURVIVE — a gap is not a death, and an agent must not be deleted just
    // because this observer stopped seeing it — but no exact task count may be
    // stated from it until that agent's own edge arrives.
    this.#ledger.noteCoverageGap(this.#ledgerScope);
    this.#agents.noteCoverageGap(this.#ledgerScope);
    this.#reportGap(reason);
    this.#reducer.invalidate();
    this.#emit();
  }

  /**
   * A loss of the transcript read lane: the armed read, the scan cursor, and any
   * source-confirmed `Ready` are withdrawn, because they are claims read from
   * that one file. A ROOT `Stop` count snapshot is withdrawn only where this hole
   * actually strands tracked members; otherwise it came from the provider's own
   * hook payload, and a file this controller cannot read says nothing about
   * background membership. The gap is still reported and the
   * foreground claim still goes unknown, so no transcript-derived claim survives
   * a lane that cannot support it.
   */
  #transcriptFailure(reason: NativeClaudeAcquisitionGapReason): void {
    this.#retire();
    this.#reportGap(reason);
    // This file is one of the two places a member's end is positively read, so a
    // hole in its coverage is a hole in the census: an exact active set cannot
    // keep claiming to be exact across records this controller can no longer
    // read. What that hole REACHES depends on whether this run holds members whose
    // ends are now stranded. Stranded members mean rows this controller can never
    // read again, of a kind it cannot name — an unattributable membership hole, so
    // both categories' last-reported totals go with it rather than surviving as a
    // number the lost rows could contradict. With nothing tracked, this hole
    // contradicts no membership fact at all: the hook payload's own last-reported
    // totals stand, and the hook lane's foreground, question census, and scope are
    // untouched — a transcript this controller cannot read says nothing about
    // them. The next complete root census restores exactness either way.
    const strandsTrackedMembers = this.#ledger.snapshot().members.length > 0;
    this.#ledger.noteCoverageGap(this.#ledgerScope);
    // The same file is the only place an agent's own terminal completion is read.
    // A hole here means a completion this controller can never see again, so an
    // agent it still counts may have ended inside the gap: the identity stays
    // counted and published-as-unknown rather than being silently closed or
    // silently kept as an exact live agent. A file that has NEVER been read is the
    // one absence that is not a hole: nothing was ever recorded in it, so no
    // transition could have hidden there. Once this run HAS read the file, its
    // disappearance is lost evidence like any other gap.
    if (reason !== "unbound-transcript" && (reason !== "unavailable" || this.#transcriptSeen())) {
      this.#agents.noteCoverageGap(this.#ledgerScope);
    }
    if (strandsTrackedMembers) this.#snapshotCounts = null;
    // Only the claim this lane supported goes unknown. The authenticated hook
    // lane still vouches the run's foreground, its question census, and its
    // scope, so a transcript this controller cannot read must not cost the row
    // its pending-input answer until the next `SessionStart`.
    this.#reducer.withdrawTranscriptForeground();
    this.#emit();
  }

  /** True once the currently bound path has been read from at all. */
  #transcriptSeen(): boolean {
    const path = this.#transcriptPath;
    return path !== null && this.#transcriptSeenPath === path;
  }

  /**
   * A gap reported by the ordinary monitoring lane, as opposed to one that stops
   * a terminal witness this pass was seeking.
   *
   * A provider creates its root JSONL when the conversation begins, so a bound
   * path that this controller has never read and that is not there yet is a
   * source with NOTHING recorded in it — not a coverage hole. It can hold no
   * membership transition, so the census this run's own spawn vouched for stays
   * exact, and a healthy startup is not announced to the host as a gap on every
   * hook. A path once read and now missing, any other reason, and any gap that
   * would have fed a witness are real holes and withdraw as before.
   */
  #monitoringFailure(reason: NativeClaudeAcquisitionGapReason, soughtWitness: boolean): void {
    if (!soughtWitness && reason === "unavailable" && !this.#transcriptSeen()) return;
    this.#transcriptFailure(reason);
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
    const counts = this.#publishedCounts();
    const snapshot: NativeClaudeAcquisitionSnapshot = {
      busy: foreground.busy,
      pendingInput: foreground.pendingInput,
      activity: [...foreground.activity],
      activeTasks: counts.tasks,
      activeShells: counts.shells,
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

/**
 * Whether two absolute paths name the same EXISTING directory: both resolve,
 * through the platform's own canonical resolution, to a directory, and either the
 * canonical paths are equal or the two resolve to the same directory object
 * (device and inode). One resolution per path; nothing is listed or scanned, and
 * any failure is simply "not proved".
 */
function sameExistingDirectory(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false;
  try {
    const leftReal = realpathSync.native(left);
    const rightReal = realpathSync.native(right);
    const leftStats = statSync(leftReal, { bigint: true });
    const rightStats = statSync(rightReal, { bigint: true });
    if (!leftStats.isDirectory() || !rightStats.isDirectory()) return false;
    if (leftReal === rightReal) return true;
    return leftStats.ino !== 0n
      && leftStats.dev === rightStats.dev
      && leftStats.ino === rightStats.ino;
  } catch {
    return false;
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

/** True when two captured identity sets hold exactly the same opaque names. */
function sameIdentityNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const name of left) {
    if (!right.has(name)) return false;
  }
  return true;
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
 * The root fence every membership-transition source must pass before its row may
 * touch this run's census: the row must not be sidechain work, must not carry an
 * agent identity, and must not name a native conversation other than this run's
 * bound root session. A child's completion, or another conversation's, is that
 * conversation's fact: it can neither settle this run's member nor open a hole in
 * this run's census. A row naming no conversation at all is attributed to the
 * bound file this tail reads, and nothing else.
 */
function isRootMembershipRow(parsed: Record<string, unknown>, boundSessionId: string | null): boolean {
  if (parsed.isSidechain === true) return false;
  if (readToken(parsed.agentId) !== null || readToken(parsed.agent_id) !== null) return false;
  const rowSession = readToken(parsed.sessionId) ?? readToken(parsed.session_id);
  if (rowSession === null) return true;
  return boundSessionId !== null && rowSession === boundSessionId;
}

/**
 * What one persisted row positively states about this run's ROOT background
 * membership, recognized from closed discriminators only, or `null` when the row
 * says nothing about membership:
 * - a provider `queue-operation` `enqueue` in this run's own bound root session
 *   whose `content` carries the native `task-notification` envelope: the envelope
 *   names the finished member's own id and a closed terminal status, which
 *   settles it exactly the moment it is persisted — while a question is still
 *   open, before the notification is delivered, and before any answer or decline.
 *   A `dequeue`, a foreign or unattributable session, and any payload without the
 *   envelope claim nothing at all.
 * - a `task_status` attachment names the provider's own task id and a closed
 *   status. One of `completed`, `failed`, or `cancelled` names the member that
 *   ended, which is what settles it exactly. A still-live status for a member
 *   this census already holds confirms that census and changes nothing.
 * - a `queued_command` attachment whose origin is a settled background run proves
 *   membership changed without naming a member this ledger can consume, so it
 *   resolves to a change with no identity — EXCEPT the one case that names a fact
 *   this ledger already applied: a task-origin delivery whose own completion
 *   envelope names a member THIS scoped ledger positively remembers as SETTLED (and
 *   not as an active member again). That row is the provider handing over an end it
 *   recorded earlier, so it asserts nothing new and is read as nothing at all.
 *   Unknown, still-active, reactivated, malformed, ambiguous, unclosed, repeated,
 *   nonterminal, or over-long deliveries keep the unattributable change exactly as
 *   before, and a `queued_command` from any other origin still claims nothing even
 *   when its payload looks like a completion.
 * - an async-launch tool result whose member is not already tracked proves a
 *   launch this ledger never saw, so it too resolves to a change with no identity.
 * - an async-launch result for a member already tracked is the same launch the
 *   hook lane reported, so it is not news.
 *
 * Only the id and status discriminators are read; no description, command,
 * output, summary, output path, or notification body is read or retained, and an
 * id never leaves the controller.
 *
 * `knownSettledId` is the one-bit question above: it reports whether this run's
 * ledger already settled an id the row names. It is consulted ONLY to decide
 * whether a task-origin delivery restates a settled member, never to settle,
 * withdraw, or open anything, and a ledger that forgot an id (its bounded memory
 * evicted it) answers no — so the delivery then withdraws, as it always did.
 *
 * An unresolved change also reports which count category it reaches, and only
 * when the row positively names one. An async agent launch can only ever add a
 * TASK member — the same closed pairing the hook lane projects a launch edge
 * from — so an untracked `async_launched` agent id is a task-side hole and says
 * nothing about the shells. A provider notification, a `task_status` row, and a
 * completion this window could not carry name no category this lane can prove
 * (the provider's own task-type label is deliberately not read here), so they
 * reach both categories. Guessing a narrower hole than the row proves is how a
 * known count becomes a fabricated one.
 */
function readMembershipTransition(
  parsed: Record<string, unknown>,
  activeMemberIds: ReadonlySet<string>,
  boundSessionId: string | null,
  knownSettledId: (id: string) => boolean,
): { readonly settle: string | null; readonly kind: NativeClaudeBackgroundKind | null } | null {
  // No child, agent-scoped, or foreign-conversation row reaches the census at all,
  // whichever membership source it would otherwise have been read from.
  if (!isRootMembershipRow(parsed, boundSessionId)) return null;
  if (parsed.type === "queue-operation") return readQueuedTaskCompletion(parsed, boundSessionId);
  if (isRecord(parsed.attachment)) {
    const attachment = parsed.attachment;
    const kind = typeof attachment.type === "string" ? attachment.type : "";
    if (kind === "task_status") {
      const status = readToken(attachment.status);
      if (status !== null
        && SETTLED_TASK_STATUSES.has(status)
        && isValidNativeClaudeBackgroundMemberId(attachment.taskId)) {
        return { settle: attachment.taskId, kind: null };
      }
      if (isValidNativeClaudeBackgroundMemberId(attachment.taskId)
        && activeMemberIds.has(attachment.taskId)) return null;
      return { settle: null, kind: null };
    }
    if (kind === "queued_command" && isRecord(attachment.origin)) {
      const origin = attachment.origin;
      if (origin.kind !== "task-notification" && origin.producer !== "session-task") return null;
      // A delivery of an end this run's own ledger already applied is that fact
      // restated, not a second change: the settlement arrived from the provider's
      // structured record (or the hook lane) before this row was ever appended, so
      // the row can neither move a count nor open a hole in a census it contradicts
      // by nothing. Anything this ledger cannot positively place as settled — an
      // unknown id, one it still counts ACTIVE, one a later census reactivated, or a
      // payload it cannot read cleanly — keeps the unattributable change, because a
      // forgotten or unproven id is not knowledge.
      const delivered = readQueuedDeliveryTaskId(attachment);
      return delivered !== null && knownSettledId(delivered)
        ? null
        : { settle: null, kind: null };
    }
    return null;
  }
  if (isRecord(parsed.toolUseResult) && parsed.toolUseResult.status === "async_launched") {
    const agentId = readToken(parsed.toolUseResult.agentId);
    return agentId !== null && activeMemberIds.has(agentId)
      ? null
      : { settle: null, kind: "task" };
  }
  return null;
}

/**
 * Read the provider's own structured completion record out of one `enqueue`d
 * queue payload. The envelope is the provider's tag block, so this reads tags and
 * two values and nothing else: the finished member's id and its terminal status.
 * The summary, the output-file path, and the whole surrounding body are never
 * read into a value, and the payload's prose is never interpreted.
 *
 * `null` means the row says nothing about membership — not an `enqueue`, a foreign
 * or unattributable session, or a payload with no completion envelope (the queue
 * carries other things too). A payload that DOES carry the envelope but cannot be
 * read cleanly is a change with no usable identity, which is reported as such so
 * the census withdraws instead of holding a count that may already be wrong.
 */
function readQueuedTaskCompletion(
  parsed: Record<string, unknown>,
  boundSessionId: string | null,
): { readonly settle: string | null; readonly kind: NativeClaudeBackgroundKind | null } | null {
  if (parsed.operation !== NATIVE_QUEUE_ENQUEUE) return null;
  // Only this run's own bound root session: the queue row names the conversation
  // it belongs to, and a foreign or unreadable one is not this run's fact.
  if (boundSessionId === null || readToken(parsed.sessionId) !== boundSessionId) return null;
  const content = parsed.content;
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TASK_NOTIFICATION_BYTES) {
    return null;
  }
  const start = content.indexOf(TASK_NOTIFICATION_OPEN);
  if (start < 0) return null;
  const end = content.indexOf(TASK_NOTIFICATION_CLOSE, start);
  if (end < 0) return { settle: null, kind: null };
  const envelope = content.slice(start, end + TASK_NOTIFICATION_CLOSE.length);
  const status = readEnvelopeTag(envelope, TASK_NOTIFICATION_STATUS_TAG);
  if (status === null) return { settle: null, kind: null };
  // A status this lane does not recognize as ended is a membership change it
  // cannot classify, so it withdraws the census rather than leaving a count that
  // may already be wrong or inventing an end the provider never stated.
  if (!SETTLED_TASK_STATUSES.has(status)) return { settle: null, kind: null };
  const taskId = readEnvelopeTag(envelope, TASK_NOTIFICATION_ID_TAG);
  if (taskId === null || !isValidNativeClaudeBackgroundMemberId(taskId)) return { settle: null, kind: null };
  return { settle: taskId, kind: null };
}

/**
 * Read the member a task-origin `queued_command` DELIVERY hands over, out of the
 * ONE completion envelope inside that attachment's own `prompt`, or `null` when
 * the row states no single readable end. The agreed contract is closed metadata
 * only: the payload must carry the envelope exactly ONCE — one opening tag, one
 * closing tag, in that order, with no envelope tag outside them, inside the
 * existing byte bound — and the two machine tags are read by the SAME shared
 * exact-once rule, closed terminal status set, and identity validity the root
 * `queue-operation` lane already uses.
 *
 * Everything else in the payload stays OPAQUE, exactly as it always was: the
 * summary, the output path, and every other tag or prose around the machine tags
 * carry no membership meaning, are never interpreted, and their tag structure —
 * repeated, unclosed, custom, or crossed — never decides what this row asserts.
 * Judging the body would invent a document schema the producer never promised and
 * would reject a healthy report over markup inside a description, which is how a
 * closed metadata contract turns into a content filter.
 *
 * The value is only ever used to ask whether this run's ledger already settled
 * that member, so this parser grants NO authority of its own: it cannot settle a
 * member, cannot name a category, and — unlike a structured terminal record — it
 * is never handed to the live-agent lifetime as a completion, because a delivery
 * can replay an old end long after that agent's own window reopened. A missing,
 * unreadable, unclosed, repeated, or nonterminal payload yields `null` and the
 * caller keeps its existing unattributable change.
 */
function readQueuedDeliveryTaskId(attachment: Record<string, unknown>): string | null {
  const prompt = attachment.prompt;
  if (typeof prompt !== "string" || Buffer.byteLength(prompt, "utf8") > MAX_TASK_NOTIFICATION_BYTES) {
    return null;
  }
  const start = prompt.indexOf(TASK_NOTIFICATION_OPEN);
  if (start < 0) return null;
  if (prompt.indexOf(TASK_NOTIFICATION_OPEN, start + TASK_NOTIFICATION_OPEN.length) !== -1) return null;
  const end = prompt.indexOf(TASK_NOTIFICATION_CLOSE, start + TASK_NOTIFICATION_OPEN.length);
  if (end < 0) return null;
  // No envelope closing tag before this envelope opened, and none after it closes:
  // the payload holds exactly one envelope, not one envelope plus stray pieces.
  const firstClose = prompt.indexOf(TASK_NOTIFICATION_CLOSE);
  if (firstClose < start) return null;
  if (prompt.indexOf(TASK_NOTIFICATION_CLOSE, end + TASK_NOTIFICATION_CLOSE.length) !== -1) return null;
  const envelope = prompt.slice(start, end + TASK_NOTIFICATION_CLOSE.length);
  const status = readEnvelopeTag(envelope, TASK_NOTIFICATION_STATUS_TAG);
  if (status === null || !SETTLED_TASK_STATUSES.has(status)) return null;
  const taskId = readEnvelopeTag(envelope, TASK_NOTIFICATION_ID_TAG);
  if (taskId === null || !isValidNativeClaudeBackgroundMemberId(taskId)) return null;
  return taskId;
}

/**
 * What one record of one agent's OWN named child transcript positively routes back
 * INTO that agent: a provider-injected `user` record whose ACTUAL message content
 * carries the native `task-notification` envelope naming the finished member with a
 * closed terminal status. Claude persists a delivery as a conversation row, so the
 * notification lives inside `message.content` — as a plain string or as `text`
 * blocks — and not in a top-level field of the record. Reading a shape the producer
 * never writes is how a real delivery silently settles nothing.
 *
 * The record must also be this run's own and this agent's own. A child transcript
 * is bound to exactly one agent by the boundary that named it, so a record carrying
 * a different session or a different agent is not this agent's delivery and states
 * nothing at all.
 *
 * Same envelope, same closed status set, same single-occurrence tag rule, and the
 * same id-validity requirement as the root queue lane — and the same refusal to
 * read anything else: no summary, no output path, no body, no description. Message
 * content is scanned ONLY for the envelope's presence; surrounding prose is never
 * interpreted, and a record carrying the envelope more than once is ambiguous and
 * refused rather than guessed at.
 *
 * `null` means the record routes nothing into this agent. It is deliberately NOT a
 * membership hole: this lane is supplementary evidence about one agent, and a row
 * that is simply not a delivery — an ordinary conversation row, or a replayed
 * request body that merely mentions a task — says nothing about anyone's census.
 */
function readRoutedTaskCompletion(
  parsed: Record<string, unknown>,
  boundSessionId: string | null,
  boundAgentId: string,
): string | null {
  if (parsed.type !== "user" || !isProviderInjectedUserRow(parsed)) return null;
  if (boundSessionId === null || !isRecord(parsed.message)) return null;
  // Conflicting scope metadata is a refusal, not a pass.
  const rowSession = readToken(parsed.sessionId) ?? readToken(parsed.session_id);
  const rowAgent = readToken(parsed.agentId) ?? readToken(parsed.agent_id);
  if (rowSession !== null && rowSession !== boundSessionId) return null;
  if (rowAgent !== null && rowAgent !== boundAgentId) return null;
  const raw = parsed.message.content;
  const parts: string[] = typeof raw === "string"
    ? [raw]
    : Array.isArray(raw)
      ? raw.flatMap((block) => isRecord(block)
        && block.type === "text"
        && typeof block.text === "string" ? [block.text] : [])
      : [];
  const envelopes = parts.filter((part) => part.includes(TASK_NOTIFICATION_OPEN));
  // Exactly one part of the record may carry a delivery. A record that splits
  // deliveries across parts is refused rather than guessed at; within the one part
  // that does carry one, the tag rules below are the established single-occurrence
  // ones, identical to the root queue lane.
  if (envelopes.length !== 1) return null;
  const content = envelopes[0];
  if (content === undefined || Buffer.byteLength(content, "utf8") > MAX_TASK_NOTIFICATION_BYTES) {
    return null;
  }
  const start = content.indexOf(TASK_NOTIFICATION_OPEN);
  const end = content.indexOf(TASK_NOTIFICATION_CLOSE, start);
  if (end < 0) return null;
  const envelope = content.slice(start, end + TASK_NOTIFICATION_CLOSE.length);
  const status = readEnvelopeTag(envelope, TASK_NOTIFICATION_STATUS_TAG);
  if (status === null || !SETTLED_TASK_STATUSES.has(status)) return null;
  const taskId = readEnvelopeTag(envelope, TASK_NOTIFICATION_ID_TAG);
  if (taskId === null || !isValidNativeClaudeBackgroundMemberId(taskId)) return null;
  return taskId;
}

/**
 * Widen the categories an unresolved membership change reaches. A row that names
 * a category withdraws that one; a row that proves a change without naming one
 * withdraws both, because a hole nobody can attribute is a hole in the whole
 * census. Widening is monotonic: once both are in, a later proven kind cannot
 * narrow the window's claim back.
 */
function noteUnresolvedKind(
  kinds: NativeClaudeBackgroundKind[],
  kind: NativeClaudeBackgroundKind | null,
): void {
  if (kind === null) {
    for (const every of NATIVE_CLAUDE_BACKGROUND_KINDS) {
      if (!kinds.includes(every)) kinds.push(every);
    }
    return;
  }
  if (!kinds.includes(kind)) kinds.push(kind);
}

/**
 * One `<tag>value</tag>` value, read only when the tag appears exactly once and
 * its value is a single opaque token. An ambiguous or nested tag is refused: this
 * never guesses which of two values a payload meant.
 */
function readEnvelopeTag(envelope: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = envelope.indexOf(open);
  if (start < 0) return null;
  if (envelope.indexOf(open, start + open.length) !== -1) return null;
  const valueStart = start + open.length;
  const valueEnd = envelope.indexOf(close, valueStart);
  if (valueEnd < 0) return null;
  const value = envelope.slice(valueStart, valueEnd);
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_TASK_NOTIFICATION_VALUE_BYTES) return null;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
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
 * Whether one persisted ROOT `assistant` row is the provider's own record of the
 * INVOCATION of a question request this run already accepted on its hook lane —
 * the same tool call the `PreToolUse` described, appended after that hook's floor
 * rather than a newer turn. Positive identification only, from closed structure:
 * an actual `message` whose `content` is a non-empty array in which EVERY block is
 * a `tool_use` block carrying one valid identity that THIS read holds open as a
 * ROOT question. So at least one open identity must be named, and nothing else may
 * be in the row.
 *
 * Deliberately narrow. The row's `name` and `input` are never read, so no tool
 * name is invented and no argument is inspected; an identity this reducer never
 * opened, a `text` or `thinking` block beside the tool call, a missing or
 * unreadable block id, or plain prose content is a model that said something new
 * and stays newer root work. The open identities are ROOT-scoped by construction
 * ({@link NativeClaudeStatusReducer.openQuestionRequestIds}), so a match is a
 * question request of this run's own root conversation without any name string
 * being consulted, and a subagent's request or another conversation's row never
 * reaches this judgement at all.
 */
function isOwnOpenQuestionInvocation(
  parsed: Record<string, unknown>,
  openQuestionIds: ReadonlySet<string>,
): boolean {
  if (openQuestionIds.size === 0) return false;
  if (!isRecord(parsed.message)) return false;
  const content = parsed.message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") return false;
    const requestId = readToken(block.id);
    if (requestId === null || !openQuestionIds.has(requestId)) return false;
  }
  return true;
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

/**
 * The closed count categories this run's own ROOT `Stop` snapshot says it held an
 * active member of WITHOUT a usable id. Empty when the snapshot carried no such
 * claim. A present-but-unreadable claim names nothing, which is the widest
 * reading: this lane withdraws every category rather than guessing which half of
 * its census a malformed gap statement was talking about.
 */
function readNativeClaudeBackgroundKindGaps(
  event: NativeHookEvent,
): readonly NativeClaudeBackgroundKind[] {
  const raw = (event as { background_unidentified_kinds?: unknown }).background_unidentified_kinds;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0) return [...NATIVE_CLAUDE_BACKGROUND_KINDS];
  const kinds: NativeClaudeBackgroundKind[] = [];
  for (const entry of raw) {
    if (!isNativeClaudeBackgroundKind(entry)) return [...NATIVE_CLAUDE_BACKGROUND_KINDS];
    if (!kinds.includes(entry)) kinds.push(entry);
  }
  return kinds;
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
