/**
 * Owned-run Codex native foreground + tool-activity ACQUISITION controller
 * (native Codex sidebar status source phase).
 *
 * One controller observes exactly one owned native Codex run. It consumes the
 * already-authenticated {@link NativeHookEvent} values the landed hook lane
 * delivers for that run, and — separately — reads the ONE rollout file the
 * provider itself named in that run's own `SessionStart` payload through the
 * landed bounded {@link readNativeJsonlTail}. Everything it reads is folded into
 * the landed pure `native-codex-status` reducer, and the reducer's verdict is
 * published as one complete observation. Nothing here is wired to the manager,
 * launch, broker registration, PTY, sidebar, or roster yet; the caller owns that.
 *
 * What "acquisition" means concretely, and its honest limits:
 *
 * 1. No second conversation, service, or census. The controller never asks the
 *    provider anything: no `app-server` connection, no thread/subagent listing,
 *    no process scan, no clock-based idle heuristic. The only triggers for work
 *    are this run's own hook events and one filesystem watch on the one bound
 *    file. Running / Ready / the tool TYPE line all come from the provider's own
 *    persisted, ordered rollout records plus the hook metadata the lane already
 *    authenticated.
 * 2. Identity is the thread, not the lineage. Codex `session_id` is the identity
 *    shared by the root thread and every descendant, so it is kept only to refuse
 *    events that name a DIFFERENT native conversation. The root thread UUID this
 *    row is bound to is derived from the pinned canonical rollout basename
 *    (`rollout-<timestamp>-<thread-uuid>[_<rollout-uuid>].jsonl`, optionally
 *    `.zst`) and corroborated by a `session_meta` record actually read from that
 *    same file. A contradiction between the two is a source failure, never a
 *    guess. There is no HOME or session-directory search and no adoption of a
 *    thread that was not named by this run's own hook.
 * 3. `agent_id`-first routing. A hook event that carries `agent_id` belongs to a
 *    descendant and can even name the PARENT's transcript path, so it never
 *    binds, rebinds, refreshes, or closes this row. In the rollout stream the
 *    same discrimination is structural: a turn record whose `root_turn_id`
 *    differs from its own `turn_id` is a nested turn.
 * 4. Ready is the reducer's decision, and this controller only ever supplies the
 *    provenance the reducer documents. `currentRootTurnId` is set exclusively
 *    from a ROOT `task_started`/`turn_started` this controller positively read at
 *    a verified record boundary in the bound file, in file order, with contiguous
 *    provider ordinals, and it is cleared by any scope change or source gap. It is
 *    attested as that start record is applied, which is what lets genuinely new
 *    work move the row off an older turn that never reached a durable terminal;
 *    the reducer's terminal tombstones and the ordinal check keep a replay from
 *    getting the same authority. A terminal record's own `turn_id` is never copied
 *    into the attestation, so a replayed, delayed, or never-started terminal cannot
 *    mark the row Ready on its own.
 * 5. One file, bounded, private. Only the positively bound path is ever opened,
 *    through the shared bounded reader (which owns `O_NOFOLLOW`, the regular-file
 *    check, the identity check, the window cap, the per-record cap, and the
 *    verified record framing). Record text is host-internal: it is never
 *    retained in state, returned in an observation, logged, or broadcast, and the
 *    published surface is `busy`, bounded sanitized activity lines, and the
 *    closed gap codes below.
 * 6. Whole-batch evaluation. Every complete record in a scanned window is
 *    classified before anything is applied, so a malformed or oversized row AFTER
 *    a sufficient terminal withdraws the observation instead of being skipped
 *    because a witness appeared earlier. A partial trailing row is not a failure:
 *    it stays unread and the next append is what resolves it.
 * 7. The declared categories are the truth of this route. `agent` and `activity`
 *    are supported (the persisted root records and the authenticated hook
 *    metadata carry them). `input`, `tasks`, and `shells` are declared
 *    `unsupported` for this source: the current hook route observes
 *    `SessionStart` only, and no persisted root record in the bound file gives a
 *    complete pending-question, background-task, or background-shell census. So
 *    `pendingInput`, `activeTasks`, and `activeShells` are always `null` here —
 *    never `false`, never `0`, and never reconstructed from an empty observed
 *    set. A supported category whose evidence failed is `unknown`, which is a
 *    different thing from an unsupported category, which is not-applicable.
 *
 * Failures withdraw. A missing/unreadable/replaced/truncated bound file, a
 * malformed or oversized record inside the scanned window, a recognized status
 * record whose required scope is missing or unusable (including a persisted tool
 * item whose turn scope the landed reducer needs), a non-contiguous provider
 * ordinal, a window that could not cover the cursor, a thread-identity
 * contradiction, a watcher that cannot be created or that reports an error, and an
 * authenticated hook-lane failure all collapse the supported observations to
 * `unknown` (never zero, never a stale Ready) and fence the in-flight generation,
 * so a late read from that generation restores nothing. Activity observed before a
 * loss is withheld rather than republished — a supported category the source could
 * not vouch for is unknown, not stale — and only a record the landed reducer itself
 * accepts as fresh tool activity makes it observable again, so a text item, a
 * descendant's tool, or a replay for a tombstoned turn cannot resurrect a withdrawn
 * label. The reducer is degraded, not reset, so terminal tombstones and replay
 * protection survive the gap. The watcher deliberately survives a gap, because the
 * next append to the bound file is what re-establishes evidence; only a scope
 * change, `invalidate()`, `SessionEnd`, and `dispose()` detach it.
 *
 * Honest limits of this phase (all reported, none papered over):
 *
 * - Hook delivery and trust are not verified here. The current Codex launch prep
 *    injects only `SessionStart`, and `/hooks` trust is a one-time operator
 *    action; until a hook actually runs, nothing binds and every category stays
 *    unknown. No live provider delivery is claimed by this file or its tests.
 * - Initial-bind ordering is source-grounded but bounded. The provider persists
 *    the current turn's `task_started` BEFORE the pending `SessionStart` hooks run
 *    (`RegularTask::run` emits it inline, and `run_pending_session_start_hooks`
 *    runs later inside `run_turn`), so the hook is not proof that the turn just
 *    began. The first window is therefore split at a floor captured synchronously
 *    when the scope binds. A record that STARTED at or before that size predates
 *    this scope: it is history, and may only seed the one fact that a root turn is
 *    in flight (so a resumed or forked rollout never adopts an old conversation's
 *    completed state as Ready). A record that starts after the floor is fresh
 *    evidence about the turn running now, so a completion appended immediately
 *    after the hook — while the first async read is still in flight — is decided
 *    normally instead of being discarded as old history. When the floor itself
 *    falls inside a record the provider is still writing, the newest historical
 *    fact is not yet knowable (that record may be the terminal for the start it
 *    would seed), so seeding waits: the cursor and the floor are left untouched
 *    until the record completes, rather than consumed and then reinterpreted as
 *    fresh evidence by the next read.
 * - Provider records carry a persisted `ordinal` that increments by exactly one.
 *    A jump, a stall, or a reversal proves records this controller never read sit
 *    in between even though the bytes were contiguous, so the window is a history
 *    gap. A `Legacy` history records no ordinal at all and is left alone.
 * - Because the attestation must come from an observed root start, a turn whose
 *    start record fell outside every readable window (more than one bounded
 *    window of records after it) cannot be marked Ready; the row degrades to
 *    `unknown` and recovers on the next turn whose start is seen.
 */

import { lstatSync, watch } from "node:fs";

import { isRecord } from "../record-guard";
import {
  classifyNativeCodexCandidate,
  createNativeCodexStatusState,
  projectNativeCodexStatus,
  reduceNativeCodexStatus,
  NATIVE_CODEX_MAX_TURN_ID_CHARS,
  type NativeCodexSourceSignal,
  type NativeCodexStatusState,
} from "./native-codex-status";
import {
  readNativeJsonlTail,
  type NativeJsonlFileIdentity,
  type NativeJsonlTailFailureReason,
} from "./native-jsonl-tail";
import type { NativeHookEvent, NativeHookFailure } from "./native-hook-protocol";
import type { NativeCliBackend } from "./session-backend";
import type { NativeStatusObservation, NativeStatusSupportMap } from "./native-status";

/**
 * What this source can literally state about its own categories.
 *
 * `agent` and `activity` are supported because the bound root rollout's ordered
 * records and this run's authenticated hook metadata actually carry them.
 * `input`, `tasks`, and `shells` are POSITIVE not-applicable declarations for
 * this source and this hook route: no complete pending-question, background-task,
 * or background-shell witness exists here. Declaring them `unsupported` is what
 * keeps their values `null` from being read as "0" or "idle" downstream, and it is
 * deliberately not the same thing as a supported category that failed to be read
 * (which is `unknown`). The future integration owns the shared support map and may
 * decorate this.
 */
export const NATIVE_CODEX_ACQUISITION_SUPPORT: NativeStatusSupportMap = Object.freeze({
  agent: "supported",
  input: "unsupported",
  tasks: "unsupported",
  shells: "unsupported",
  activity: "supported",
});

/**
 * One complete observation of everything this controller knows right now.
 *
 * `pendingInput`, `activeTasks`, and `activeShells` are structurally pinned to
 * `null`: this source declares those categories not-applicable, and a not-applicable
 * category is never reported as a value. There is deliberately no ownership count,
 * no input surface, and no native conversation tuple here.
 */
export interface NativeCodexAcquisitionSnapshot extends NativeStatusObservation {
  readonly busy: boolean | null;
  readonly pendingInput: null;
  readonly activity: readonly string[];
  readonly activeTasks: null;
  readonly activeShells: null;
  readonly support: NativeStatusSupportMap;
}

/**
 * Closed codes for a loss of the source this controller depends on. They name the
 * kind of loss only: no path, provider field, record text, or provider reason
 * string crosses this boundary.
 */
export type NativeCodexAcquisitionGapReason =
  /** The authenticated lane reported a closed failure for this run's own hook. */
  | "hook-failure"
  /** No transcript path was ever positively bound for this run's own scope. */
  | "unbound-transcript"
  | "unavailable"
  | "unreadable"
  | "not-a-regular-file"
  | "symlink"
  /** The bound path's device/inode changed: the file behind the cursor is gone. */
  | "replaced"
  | "truncated"
  /** A record inside the scanned window was not a readable status record. */
  | "malformed"
  /** A record inside the scanned window exceeded a bound and was not read. */
  | "oversized"
  /** The bounded window could not cover the cursor: records in between went unread. */
  | "skipped-window"
  /**
   * The provider's own record ordinals are discontinuous or unusable, so records
   * the controller never read may sit between what it did read.
   */
  | "history-gap"
  /** The rollout basename and a `session_meta` disagree about the bound thread. */
  | "thread-identity-conflict"
  | "watch-error"
  | "watch-unavailable";

export interface NativeCodexAcquisitionOptions {
  /**
   * Descriptive identity of the owned run this controller belongs to. Never used
   * as a lookup key and never published in an observation.
   */
  readonly rowId: string;
  /** Backend this controller accepts hook values for; anything else is ignored. */
  readonly backend: NativeCliBackend;
  /**
   * Emits one COMPLETE snapshot whenever what this controller knows changes. A
   * snapshot that omits a value is an unknown, never a hold-over, and nothing is
   * emitted for a duplicate of what the host already has.
   */
  readonly onSnapshot: (snapshot: NativeCodexAcquisitionSnapshot) => void;
  /** Optional host notice of a source loss, as a closed code only. */
  readonly onSourceGap?: (reason: NativeCodexAcquisitionGapReason) => void;
  /** Rollout read-window cap; defaults to the tail module's bound. */
  readonly maxTailBytes?: number;
  /** Per-record cap inside that window; defaults to the tail module's bound. */
  readonly maxLineBytes?: number;
  /**
   * File-watch seam. It is only ever called with the one positively bound rollout
   * path, and a throw from it is treated as a source failure that withdraws
   * published state rather than leaving it unmonitored. Defaults to
   * {@link fs.watch} on that path.
   */
  readonly watchFile?: NativeCodexWatchFactory;
}

/** One file watch this controller owns. `close` is idempotent by contract. */
export interface NativeCodexFileWatch {
  close(): void;
}

/** Callbacks the supplied watcher invokes for the bound path. */
export interface NativeCodexWatchHandlers {
  onChange(): void;
  onError(error: unknown): void;
}

/** Creates one watch on one already-bound path; throwing means "cannot monitor". */
export type NativeCodexWatchFactory = (path: string, handlers: NativeCodexWatchHandlers) => NativeCodexFileWatch;

/**
 * The canonical Codex rollout basename, exactly as the pinned provider renders it:
 * `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-uuid>.jsonl`, with an appended
 * `_<rollout-uuid>` for a reverted thread, and an optional `.zst` on a compressed
 * rollout. The thread UUID is the ROOT identity this row binds to; the shared
 * lineage `session_id` is not thread identity and is never used to find a file.
 */
const CODEX_ROLLOUT_BASENAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl(?:\.zst)?$/;

/** A `session_meta` payload's `id` as the provider serializes a `ThreadId`. */
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The longest transcript path this controller will bind. It matches the native
 * hook lane's own path bound, so a path the lane could carry is never silently
 * dropped here; a longer one is simply not a bindable path.
 */
const MAX_BOUND_TRANSCRIPT_PATH_CHARS = 2048;

/**
 * `SessionStart` sources that keep the current thread AND the current turn scope.
 * Compaction rewrites history in place; it is never a new thread and never a new
 * idle turn, so it neither rebinds nor resets. `startup`, `clear`, `fork`,
 * `resume`, and any source this version does not know are scope changes.
 */
const SCOPE_KEEPING_SESSION_START_SOURCES: ReadonlySet<string> = new Set(["compact"]);

/** Reducer input without the caller provenance this controller owns. */
type ControllerEvidence =
  | { readonly kind: "rollout"; readonly record: unknown }
  | { readonly kind: "hook"; readonly event: unknown }
  | { readonly kind: "source"; readonly signal: NativeCodexSourceSignal };

/** One root-turn lifecycle fact read from one record, in file order. */
interface RootLifecycleFact {
  readonly kind: "start" | "terminal";
  /** Null for a terminal the provider did not correlate (a null-turn `turn_aborted`). */
  readonly turnId: string | null;
}

/** One positively framed record, with the facts the controller may use. */
interface ScannedRecord {
  readonly record: Record<string, unknown>;
  readonly lifecycle: RootLifecycleFact | null;
  /** The thread id a `session_meta` record names, when this record is one. */
  readonly metaThreadId: string | null;
}

/** One whole-window classification pass. Nothing is applied until it completes. */
interface BatchScan {
  readonly gap: NativeCodexAcquisitionGapReason | null;
  /**
   * The records the reducer may see, in file order: every record in a steady
   * window, and only the records that STARTED AFTER the bind floor in the first
   * window of a new scope. Records that predate the floor are history.
   */
  readonly records: readonly ScannedRecord[];
  /** The newest ROOT lifecycle fact among the records that predate the bind floor. */
  readonly newestPreBind: RootLifecycleFact | null;
  /** A thread id read from a `session_meta` inside this window. */
  readonly metaThreadId: string | null;
  /** The last provider ordinal positively framed in this window. */
  readonly lastOrdinal: number | null;
}

/**
 * The default file-watch seam: exactly one non-persistent `fs.watch` on the one
 * positively bound rollout path.
 */
const defaultWatchFile: NativeCodexWatchFactory = (path, handlers) => {
  const watcher = watch(path, { persistent: false }, () => handlers.onChange());
  watcher.on("error", (error) => handlers.onError(error));
  return { close: () => watcher.close() };
};

/**
 * Acquires source-grounded root foreground and tool-TYPE activity for ONE owned
 * native Codex run. Constructed per owned run; never shared, never a registry, and
 * never reachable from a wire frame or a child.
 */
export class NativeCodexAcquisitionController {
  readonly rowId: string;

  readonly #backend: NativeCliBackend;
  readonly #onSnapshot: (snapshot: NativeCodexAcquisitionSnapshot) => void;
  readonly #onSourceGap: ((reason: NativeCodexAcquisitionGapReason) => void) | undefined;
  readonly #maxTailBytes: number | undefined;
  readonly #maxLineBytes: number | undefined;
  readonly #watchFile: NativeCodexWatchFactory;

  /** Reducer state. Rebuilt on every scope rebind; never mutated in place. */
  #state: NativeCodexStatusState = createNativeCodexStatusState();

  /**
   * Local fence. Bumped by a scope rebind, a source failure, an invalidation, and
   * disposal, so a read that started earlier — or a callback queued earlier — can
   * write nothing. The watcher is fenced on its own handle identity instead, so a
   * gap can retire a read without silencing the file that recovers it.
   */
  #generation = 0;
  /** Private source generation the reducer tags evidence with; a rebind mints a new one. */
  #scopeTag = 0;
  #disposed = false;

  /**
   * The shared lineage `session_id` this run named. Kept only to refuse events
   * from another native conversation; never used as thread identity and never
   * used to reach a file.
   */
  #lineageSessionId: string | null = null;
  /** The ONE rollout path the provider named for that scope. */
  #transcriptPath: string | null = null;
  /** The ROOT thread this row is bound to, from the rollout name and/or `session_meta`. */
  #rootThreadId: string | null = null;
  /** Absolute offset through the last complete record positively scanned. */
  #cursor: number | null = null;
  /** Identity of the file the cursor belongs to; a change is a replacement. */
  #identity: NativeJsonlFileIdentity | null = null;
  /**
   * Byte size of the bound rollout captured when this scope bound. It is the
   * seeding floor: a record that STARTED at or before it is pre-bind history, and
   * a record that started after it is fresh evidence about the current turn.
   * Cleared once the first scan has been classified.
   */
  #bindSize: number | null = null;
  /**
   * The last provider ordinal positively read in this scope. Provider ordinals
   * increment by one per persisted record, so a jump, a reversal, or an unusable
   * value proves records went unread.
   */
  #lastOrdinal: number | null = null;
  /**
   * The activity array the reducer held when the last source loss happened, or
   * null when nothing is withheld. While it is set, already-observed activity is
   * not republished: a supported category that could not be read is unknown. It
   * clears only when fresh evidence moves the reducer's activity past it.
   */
  #activityWithheld: readonly string[] | null = null;
  /**
   * The caller-current root turn: set ONLY from a root `task_started`/
   * `turn_started` positively read at a verified record boundary of the bound
   * file, cleared by a terminal for that turn, a scope change, and any source gap.
   */
  #currentRootTurnId: string | null = null;

  #watcher: NativeCodexFileWatch | null = null;
  #reading = false;
  #readAgain = false;
  #last: NativeCodexAcquisitionSnapshot | null = null;

  constructor(options: NativeCodexAcquisitionOptions) {
    if (typeof options?.rowId !== "string" || options.rowId.trim() === "") {
      throw new RangeError("native Codex acquisition requires a rowId");
    }
    if (options.backend !== "codex") {
      throw new RangeError("native Codex acquisition accepts the codex backend only");
    }
    if (typeof options.onSnapshot !== "function") {
      throw new RangeError("native Codex acquisition requires an onSnapshot callback");
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
   * another backend, every descendant event, and every event after disposal are
   * ignored without effect.
   */
  acceptHook(event: NativeHookEvent): void {
    if (this.#disposed) return;
    if (!isRecord(event) || event.backend !== this.#backend) return;
    const hookEventName = typeof event.hook_event_name === "string" ? event.hook_event_name : "";

    // `agent_id`-first routing: root and every descendant share the lineage
    // `session_id`, and a `SubagentStop` can even name the PARENT's transcript, so
    // an event carrying `agent_id` is never this row's root authority.
    if (hasAgentScope(event.agent_id)) return;

    const lineage = readToken(event.session_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
    const nextPath = readToken(event.transcript_path, MAX_BOUND_TRANSCRIPT_PATH_CHARS);

    // An event naming a different native conversation is not this run's evidence
    // and drives no effect at all. A root `SessionStart` is the one exception: it
    // is the provider itself naming this run's new scope, and the reducer adopts it.
    if (hookEventName !== "SessionStart"
      && this.#lineageSessionId !== null
      && lineage !== null
      && lineage !== this.#lineageSessionId) return;

    if (hookEventName === "SessionEnd") {
      this.#unbind();
      return;
    }

    const source = typeof event.source === "string" ? event.source : null;
    const compaction = hookEventName === "SessionStart"
      && source !== null
      && SCOPE_KEEPING_SESSION_START_SOURCES.has(source);
    // A root `SessionStart` (startup, clear, fork, resume, or a source this version
    // does not know) restarts the scope, and so does any admitted root event that
    // names a DIFFERENT rollout file: the provider moved this run's history.
    const pathMoved = this.#transcriptPath !== null
      && nextPath !== null
      && nextPath !== this.#transcriptPath;
    const rebound = !compaction && (hookEventName === "SessionStart" || pathMoved);
    if (rebound) {
      this.#rebind(lineage, nextPath);
    } else if (this.#transcriptPath === null && nextPath !== null) {
      // A path arriving for a scope that started without one: bind, do not rebind.
      this.#transcriptPath = nextPath;
      this.#rootThreadId = deriveCodexRolloutThreadId(nextPath);
      // Keep the invariant that the reducer state carries exactly this row's root
      // binding, so its thread check cannot be skipped by a stale null.
      this.#state = createNativeCodexStatusState({
        rootThreadId: this.#rootThreadId,
        generation: this.#scopeGeneration(),
      });
    }

    this.#state = this.#reduce({ kind: "hook", event });
    this.#syncWatcher();
    if (this.#transcriptPath === null) {
      // A scope the provider never named a rollout for cannot be observed at all:
      // the supported values stay unknown and the loss is reported, not guessed.
      if (rebound) this.#reportGap("unbound-transcript");
    } else {
      // The run's own admitted event is both the first trigger for a freshly bound
      // file and a bounded second chance after a lost watch callback. Concurrent
      // reads coalesce into at most one follow-up scan.
      void this.#readTail();
    }
    this.#emit();
  }

  /**
   * Consume one authenticated closed failure from this run's hook lane. One lost
   * event is a real observation gap: the supported observations collapse to
   * unknown and the in-flight generation is fenced. Nothing is replayed.
   */
  acceptFailure(failure: NativeHookFailure): void {
    if (this.#disposed) return;
    if (!isRecord(failure) || failure.backend !== this.#backend) return;
    this.#sourceFailure("hook-failure", "source-failure");
  }

  /**
   * Stop vouching for everything this controller last reported. Values become
   * unknown (never zero, never a stale Ready), the in-flight read is fenced, and
   * the watcher is detached. The caller keeps ownership of its own capture seam
   * and of minting any fresh capture for recovery; this call neither mints nor
   * retires one, and no later callback from the retired generation restores
   * anything. A fresh owned hook event re-attaches the watcher.
   */
  invalidate(): void {
    if (this.#disposed) return;
    this.#retire();
    // The scope is still this run's, so recovery re-establishes the same floor
    // rule: whatever the rollout already holds is history, and only records
    // appended after this point can vouch for the current turn again.
    this.#bindSize = this.#transcriptPath === null ? null : boundRolloutSize(this.#transcriptPath);
    this.#state = this.#reduce({ kind: "source", signal: "rebind" });
    this.#emit();
  }

  /**
   * Final cleanup: closes this controller's own watcher and fences its generation.
   * It kills no process, deletes no provider history or rollout, and is idempotent.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#retire();
    this.#lineageSessionId = null;
    this.#transcriptPath = null;
    this.#rootThreadId = null;
  }

  // --- scope binding -------------------------------------------------------

  /**
   * Rebind this row to the scope the provider just named: a fresh private source
   * generation, a fresh root thread identity, and no carry-over of any turn,
   * cursor, file identity, or attestation. `startup`, `clear`, `fork`, and
   * `resume` all land here; `compact` deliberately never does.
   */
  #rebind(lineage: string | null, transcriptPath: string | null): void {
    this.#retire();
    this.#scopeTag += 1;
    this.#lineageSessionId = lineage;
    this.#transcriptPath = transcriptPath;
    this.#rootThreadId = transcriptPath === null ? null : deriveCodexRolloutThreadId(transcriptPath);
    // The seeding floor is captured synchronously here, before any read is
    // issued: everything at or before this offset existed when the provider named
    // this scope, and anything appended after it is fresh evidence about the turn
    // that is running now. Without this floor, a terminal the provider appends
    // right after the hook would land in the same window as the current turn's
    // start and be discarded as pre-bind history.
    this.#bindSize = transcriptPath === null ? null : boundRolloutSize(transcriptPath);
    // The reducer's documented rebind: every earlier observation goes out of
    // scope and the new private generation replaces the old one, so evidence
    // tagged to the previous scope is dropped rather than adopted.
    this.#state = reduceNativeCodexStatus(this.#state, {
      kind: "source",
      signal: "rebind",
      generation: this.#scopeGeneration(),
    });
    if (this.#state.rootThreadId !== this.#rootThreadId) {
      this.#state = createNativeCodexStatusState({
        rootThreadId: this.#rootThreadId,
        generation: this.#scopeGeneration(),
      });
    }
  }

  /** `SessionEnd`: the conversation this controller vouched for is over. */
  #unbind(): void {
    this.#retire();
    this.#state = this.#reduce({ kind: "source", signal: "rebind" });
    this.#lineageSessionId = null;
    this.#transcriptPath = null;
    this.#rootThreadId = null;
    this.#bindSize = null;
    this.#emit();
  }

  /** Fence the generation, detach the watcher, and drop every derived read fact. */
  #retire(): void {
    this.#generation += 1;
    this.#closeWatcher();
    this.#cursor = null;
    this.#identity = null;
    this.#lastOrdinal = null;
    this.#currentRootTurnId = null;
    this.#activityWithheld = null;
    this.#readAgain = false;
  }

  /** The private generation label the reducer tags this scope's evidence with. */
  #scopeGeneration(): string {
    return `codex-scope-${this.#scopeTag}`;
  }

  /** Fold one piece of evidence in with this scope's provenance attached. */
  #reduce(evidence: ControllerEvidence): NativeCodexStatusState {
    return reduceNativeCodexStatus(this.#state, {
      ...evidence,
      generation: this.#scopeGeneration(),
      currentRootTurnId: this.#currentRootTurnId,
    });
  }

  // --- watching and reading ------------------------------------------------

  /** Keep at most one watcher on the one bound path, for as long as it is bound. */
  #syncWatcher(): void {
    if (this.#disposed || this.#watcher !== null || this.#transcriptPath === null) return;
    const path = this.#transcriptPath;
    try {
      // Exactly one watched file, no polling and no idle timer: an append to this
      // one rollout is the only thing that wakes a read.
      const handle = this.#watchFile(path, {
        onChange: () => {
          // A callback from a detached watcher is never current: the handle that
          // attached it is the fence, so a retired watcher cannot wake a read.
          if (this.#disposed || this.#watcher !== handle) return;
          void this.#readTail();
        },
        onError: () => {
          if (this.#disposed || this.#watcher !== handle) return;
          this.#closeWatcher();
          // Published state with nothing monitoring it is not a defensible
          // observation, so an error withdraws rather than merely reporting.
          this.#sourceFailure("watch-error", "source-failure");
        },
      });
      this.#watcher = handle;
    } catch {
      this.#sourceFailure("watch-unavailable", "source-failure");
    }
  }

  #closeWatcher(): void {
    const watcher = this.#watcher;
    this.#watcher = null;
    if (watcher === null) return;
    try {
      watcher.close();
    } catch {
      // An already-closed watcher is the desired end state.
    }
  }

  /**
   * Scan one bounded window and only then commit anything. The whole window is
   * classified first, so a malformed or oversized record anywhere in it withdraws
   * the observation instead of being skipped because a witness appeared earlier.
   * The result is applied only while the generation and bound path it started
   * under are still current, and a read queued behind this one is always drained.
   */
  async #readTail(): Promise<void> {
    if (this.#disposed) return;
    const path = this.#transcriptPath;
    if (path === null) return;
    if (this.#reading) {
      // One queued follow-up, not a queue: whatever is current when this read
      // finishes is what the next scan covers.
      this.#readAgain = true;
      return;
    }
    const generation = this.#generation;
    // No cursor means nothing has been positively framed yet. This scan may seed
    // at most the one in-flight fact described in the header, and only from
    // records that predate the bind floor; records after the floor are fresh.
    const seeding = this.#cursor === null;
    // The floor is the last boundary this controller could vouch for: captured when
    // the scope bound, or at the moment a loss forced a re-seed. Only when even
    // that is unavailable is the whole window read as history, which is the
    // conservative reading.
    if (seeding && this.#bindSize === null) this.#bindSize = boundRolloutSize(path);
    const bindSize = seeding ? this.#bindSize : null;
    const from = this.#cursor ?? 0;
    const expectIdentity = this.#identity ?? undefined;
    this.#reading = true;

    let gap: NativeCodexAcquisitionGapReason | null = null;
    let signal: NativeCodexSourceSignal = "source-failure";
    let scan: BatchScan | null = null;
    /** The offset this read positively consumed through, when it consumed at all. */
    let consumedTo: number | null = null;
    let readIdentity: NativeJsonlFileIdentity | null = null;
    /** True when the window simply ended inside a record: wait, do not withdraw. */
    let waitingForAppend = false;
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
      } else {
        if (result.scannedToIsRecordBoundary) {
          consumedTo = result.scannedTo;
          readIdentity = result.identity;
        } else if (result.records.length === 0 && result.fileSize <= from) {
          // Mid-append on a steady cursor: the trailing partial is not a failure
          // and there is nothing new to decide, so the cursor simply stays put.
          waitingForAppend = true;
        } else {
          // A window with no consumable record boundary at all: one record larger
          // than the window. That is a bound, not a witness.
          gap = "oversized";
          signal = "oversized";
        }
        if (gap === null && result.oversizedLines > 0) {
          gap = "oversized";
          signal = "oversized";
        }
        if (gap === null && seeding && bindSize !== null
          && result.trailingPartial && result.scannedTo < bindSize) {
          // The bind floor lies INSIDE the record the provider is still writing, so
          // this window cannot yet say what the newest historical fact is: that
          // unfinished record may well be the terminal for the start it would
          // otherwise seed. Committing here would consume the floor and let the next
          // steady read treat that same historical record as fresh. Seeding therefore
          // stays pending — cursor and floor untouched — until the record completes.
          // The complete records read so far are still validated below, so a real
          // defect is reported now rather than deferred with the seeding.
          waitingForAppend = true;
        }
        if (gap === null) {
          scan = this.#scanBatch(result.records, seeding, bindSize, result.scannedTo);
          if (scan.gap !== null) {
            gap = scan.gap;
            signal = scan.gap === "oversized"
              ? "oversized"
              : scan.gap === "history-gap" ? "gap" : "malformed";
          } else if (scan.metaThreadId !== null
            && this.#rootThreadId !== null
            && scan.metaThreadId !== this.#rootThreadId) {
            // The file's own metadata contradicts the thread this row is bound to:
            // which thread these records describe is no longer knowable.
            gap = "thread-identity-conflict";
          } else if (!seeding && result.skippedBefore) {
            // Steady reads must cover the cursor; records in between went unread.
            // The bytes still count as consumed, but the claim is no longer complete.
            gap = "skipped-window";
            signal = "gap";
          }
        }
      }
    } catch {
      gap = "unreadable";
    } finally {
      this.#reading = false;
    }

    const stale = this.#disposed
      || generation !== this.#generation
      || this.#transcriptPath !== path;
    if (!stale) {
      if (gap !== null) {
        // Bytes the reader positively framed are never re-read (that would
        // re-report the same bound forever); a read that failed outright has no
        // trustworthy cursor and re-seeds from the tail instead.
        this.#cursor = consumedTo;
        this.#identity = consumedTo === null ? null : readIdentity;
        this.#sourceFailure(gap, signal);
      } else if (scan !== null && !waitingForAppend) {
        this.#cursor = consumedTo;
        this.#identity = readIdentity;
        // The bind floor has now been classified into history and fresh records, so
        // every later scan is a steady one.
        this.#bindSize = null;
        if (scan.lastOrdinal !== null) this.#lastOrdinal = scan.lastOrdinal;
        this.#applyScan(scan);
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
   * Classify every complete record in the window before anything is applied. Only
   * closed discriminators are read — the record `type` and `ordinal`, the payload
   * `type`, the `turn_id`/`root_turn_id` scope, and a `session_meta` payload's
   * `id`. No prompt, command, argument, tool input or output, model text,
   * reasoning, path, or answer is ever read out of a record.
   *
   * Three things are validated over the WHOLE window before any of it is applied:
   * JSON framing, that every recognized status envelope actually carries the scope
   * it must (including the turn scope the landed reducer requires of a persisted
   * tool item), and that the provider's own record ordinals stay contiguous.
   */
  #scanBatch(
    lines: readonly string[],
    seeding: boolean,
    bindSize: number | null,
    scannedTo: number,
  ): BatchScan {
    const starts = recordStartOffsets(lines, scannedTo);
    const scanned: ScannedRecord[] = [];
    let newestPreBind: RootLifecycleFact | null = null;
    let metaThreadId: string | null = null;
    let previousOrdinal = this.#lastOrdinal;
    let lastOrdinal: number | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = classifyNativeCodexCandidate(lines[index] ?? "");
      if (candidate.status === "oversized") return failedScan("oversized");
      if (candidate.status === "malformed") return failedScan("malformed");
      if (candidate.status === "blank") continue;
      const record = candidate.record as Record<string, unknown>;
      const ordinal = readRecordOrdinal(record);
      if (ordinal === "invalid" || (ordinal !== null && previousOrdinal !== null
        // The provider increments `ordinal` by exactly one per persisted record, so
        // a jump, a stall, or a reversal proves records this controller never read
        // sit in between — even though the bytes themselves were contiguous.
        && ordinal !== previousOrdinal + 1)) {
        return failedScan("history-gap");
      }
      if (ordinal !== null) {
        previousOrdinal = ordinal;
        lastOrdinal = ordinal;
      }
      // Valid JSON is not enough: a recognized status record whose required scope
      // is missing or unusable is a malformed candidate, and it must not be
      // applied, seeded past, or followed by a later witness that decides anyway.
      if (isMalformedStatusEnvelope(record, this.#rootThreadId)) return failedScan("malformed");
      const lifecycle = readRootLifecycle(record);
      const threadId = readSessionMetaThreadId(record);
      const startOffset = starts[index] ?? null;
      // A record that started at or before the bind floor predates this scope. It
      // is history: never fed to the reducer, and able to contribute at most the
      // one in-flight fact below. Without a floor, the whole first window is
      // history, which is the conservative reading.
      const preBind = seeding && (bindSize === null || startOffset === null || startOffset < bindSize);
      if (lifecycle !== null && preBind) newestPreBind = lifecycle;
      if (threadId !== null) metaThreadId = threadId;
      if (!preBind) scanned.push({ record, lifecycle, metaThreadId: threadId });
    }
    return { gap: null, records: scanned, newestPreBind, metaThreadId, lastOrdinal };
  }

  /**
   * Apply one fully classified window. Records that predate the bind floor may
   * establish at most the one in-flight fact the header describes; the fresh
   * records are fed to the landed reducer in file order, so a later record in the
   * same window can invalidate an earlier one before anything is published.
   */
  #applyScan(scan: BatchScan): void {
    if (this.#rootThreadId === null && scan.metaThreadId !== null) {
      // The rollout name was not canonical, so the file's own metadata is the
      // corroboration. Adopting it rebuilds the (still unknown) state with the
      // positive thread binding rather than laundering an old one.
      this.#rootThreadId = scan.metaThreadId;
      this.#state = createNativeCodexStatusState({
        rootThreadId: this.#rootThreadId,
        generation: this.#scopeGeneration(),
      });
    }
    // Pre-bind history may establish at most one fact: the newest root lifecycle
    // record before the bind floor, and only when it is an unterminated start. A
    // newest fact that is a terminal is completed history — never this row's Ready
    // — and no fact at all leaves the row unknown.
    const seed = scan.newestPreBind;
    if (seed !== null && seed.kind === "start" && seed.turnId !== null) {
      this.#currentRootTurnId = seed.turnId;
      this.#state = this.#reduce({ kind: "rollout", record: seedStartRecord(seed.turnId) });
    }
    for (const entry of scan.records) {
      const lifecycle = entry.lifecycle;
      // A root start read forward in the current ordered stream, with contiguous
      // provider ordinals and no gap since the last record, IS this row's current
      // root turn. Attesting it BEFORE the reduce is what lets genuinely new work
      // move the row off an older turn that never reached a durable terminal.
      // Replay protection is untouched: the reducer still refuses a start for a
      // turn whose terminal it already consumed, and a record that arrives out of
      // ordinal order fails the whole batch during the scan above.
      if (lifecycle !== null && lifecycle.kind === "start" && lifecycle.turnId !== null
        && !this.#state.terminatedTurnIds.includes(lifecycle.turnId)) {
        this.#currentRootTurnId = lifecycle.turnId;
      }
      // A `session_meta` naming this same thread is confirmation and nothing else;
      // one naming a different thread already failed the batch during the scan.
      const before = this.#state;
      // Only the landed reducer can say whether THIS record is fresh tool activity
      // it actually accepts. Probing it with an empty activity array recognizes an
      // identical fresh label (the reducer collapses a repeat of the current one)
      // and a legacy tool witness, while a text or lifecycle item, a nested turn,
      // and a replay for a tombstoned turn all come back with no activity and so
      // cannot resurrect a label the source loss withdrew. The probe is pure and
      // runs on a copy, so real tombstones and replay protection are untouched.
      const restoresActivity = this.#activityWithheld !== null
        && reduceNativeCodexStatus({ ...before, activity: [] }, {
          kind: "rollout",
          record: entry.record,
          generation: this.#scopeGeneration(),
          currentRootTurnId: this.#currentRootTurnId,
        }).activity.length > 0;
      this.#state = this.#reduce({ kind: "rollout", record: entry.record });
      if (restoresActivity) this.#activityWithheld = null;
      if (this.#state.phase === "unknown" && before.phase !== "unknown") {
        // The landed reducer itself refused the view as incomplete, so whatever
        // turn was held is no longer defensible: a later terminal for it cannot
        // restore Ready across evidence the source itself could not vouch for.
        this.#currentRootTurnId = null;
      }
      if (lifecycle !== null && lifecycle.kind === "terminal"
        && lifecycle.turnId !== null && lifecycle.turnId === this.#currentRootTurnId) {
        // Consumed. A replay of this terminal is no longer fresh evidence.
        this.#currentRootTurnId = null;
      }
    }
  }

  // --- failure and emission ------------------------------------------------

  /**
   * A source loss: every supported observation collapses to unknown, the held
   * attestation and ordinal floor are withdrawn (a gap may have hidden a newer
   * turn's start), and the generation is fenced so an in-flight read restores
   * nothing. Activity already observed is withheld rather than republished: a
   * supported category the source could not vouch for is unknown, not stale. The
   * reducer's own state is only degraded, never reset, so terminal tombstones and
   * every replay protection survive the gap. The watcher stays attached: the next
   * append to the bound file is what re-establishes evidence.
   */
  #sourceFailure(reason: NativeCodexAcquisitionGapReason, signal: NativeCodexSourceSignal): void {
    this.#generation += 1;
    this.#currentRootTurnId = null;
    this.#lastOrdinal = null;
    this.#activityWithheld = [...this.#state.activity];
    // Whatever the rollout holds RIGHT NOW is the boundary of this lost observation:
    // records already in the file are history again, and only a later append can
    // vouch for the turn. Without re-capturing a floor here, a re-seeding window
    // would read every future record as history and the row could never recover.
    this.#bindSize = this.#transcriptPath === null ? null : boundRolloutSize(this.#transcriptPath);
    this.#state = this.#reduce({ kind: "source", signal });
    this.#reportGap(reason);
    this.#emit();
  }

  #reportGap(reason: NativeCodexAcquisitionGapReason): void {
    if (this.#disposed) return;
    try {
      this.#onSourceGap?.(reason);
    } catch {
      // A host diagnostic can never break the observer.
    }
  }

  #emit(): void {
    if (this.#disposed) return;
    const fields = projectNativeCodexStatus(this.#state);
    const snapshot: NativeCodexAcquisitionSnapshot = {
      busy: fields.busy,
      // Declared not-applicable for this source: never inferred, never defaulted.
      pendingInput: null,
      activity: this.#activityWithheld === null ? [...fields.activity] : [],
      activeTasks: null,
      activeShells: null,
      support: NATIVE_CODEX_ACQUISITION_SUPPORT,
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

function mapTailFailure(reason: NativeJsonlTailFailureReason): NativeCodexAcquisitionGapReason {
  if (reason === "identity-changed") return "replaced";
  if (reason === "truncated") return "truncated";
  if (reason === "unavailable") return "unavailable";
  if (reason === "not-a-regular-file") return "not-a-regular-file";
  if (reason === "symlink") return "symlink";
  // `path-not-absolute` and `unreadable` are both "this file could not be read".
  return "unreadable";
}

/**
 * The ROOT thread identity a canonical Codex rollout basename carries, or null
 * when the name is not canonical. Null is not a failure: the path still came from
 * this run's own hook, so it stays the one bound file, and a `session_meta`
 * actually read from it can still supply the identity.
 */
function deriveCodexRolloutThreadId(transcriptPath: string): string | null {
  const base = transcriptPath.split(/[\\/]/).at(-1) ?? "";
  const match = CODEX_ROLLOUT_BASENAME.exec(base);
  return match?.[1] ?? null;
}

/**
 * The thread a `session_meta` payload names, read as a discriminator only. The
 * pinned wire shape is `{"type":"session_meta","payload":{…flattened
 * SessionMeta…}}`, whose `id` is the stable thread id. Nothing else in the
 * payload — not `cwd`, not `base_instructions`, not the model, not the originator
 * — is read or retained.
 */
function readSessionMetaThreadId(record: Record<string, unknown>): string | null {
  if (record.type !== "session_meta") return null;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (payload === null) return null;
  const id = payload.id;
  if (typeof id !== "string") return null;
  const trimmed = id.trim().toLowerCase();
  return CODEX_THREAD_ID.test(trimmed) ? trimmed : null;
}

/**
 * The root-turn lifecycle fact one record carries, using exactly the reducer's
 * scope rule: `root_turn_id` equals `turn_id` for a root turn, so a record whose
 * `root_turn_id` differs is a nested (for example sub-agent) turn and contributes
 * no root fact at all. Only the `turn_id`/`root_turn_id` discriminators are read.
 */
function readRootLifecycle(record: Record<string, unknown>): RootLifecycleFact | null {
  if (record.type !== "event_msg" || !isRecord(record.payload)) return null;
  const payload = record.payload as Record<string, unknown>;
  const kind = payload.type;
  const isStart = kind === "task_started" || kind === "turn_started";
  const isTerminal = kind === "task_complete" || kind === "turn_complete" || kind === "turn_aborted";
  if (!isStart && !isTerminal) return null;
  const turnId = readToken(payload.turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  const rootTurnId = readToken(payload.root_turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  // A nested turn's start or terminal is never this row's root lifecycle.
  if (rootTurnId !== null && rootTurnId !== turnId) return null;
  return { kind: isStart ? "start" : "terminal", turnId };
}

/**
 * The single synthetic record a seeding scan feeds the reducer. It carries the
 * turn id the controller positively read and nothing else — no provider text is
 * ever carried forward from the record the fact came from.
 */
function seedStartRecord(turnId: string): Record<string, unknown> {
  return {
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId, root_turn_id: turnId },
  };
}

/**
 * True for ANY present, non-blank `agent_id`, including a value this controller
 * cannot use. Descendant scope fails closed: an unusable `agent_id` is never
 * treated as "absent", because that would hand a child event root authority.
 */
function hasAgentScope(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/** A bounded, trimmed token, or null when absent, blank, non-string, or too long. */
function readToken(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxChars) return null;
  return trimmed;
}

function snapshotsEqual(
  current: NativeCodexAcquisitionSnapshot | null,
  next: NativeCodexAcquisitionSnapshot,
): boolean {
  if (current === null) return false;
  return current.busy === next.busy
    && current.pendingInput === next.pendingInput
    && current.activeTasks === next.activeTasks
    && current.activeShells === next.activeShells
    && current.activity.length === next.activity.length
    && current.activity.every((line, index) => line === next.activity[index]);
}

/** A rejected scan: nothing in the window is applied, and the reason is closed. */
function failedScan(gap: NativeCodexAcquisitionGapReason): BatchScan {
  return { gap, records: [], newestPreBind: null, metaThreadId: null, lastOrdinal: null };
}

/**
 * The absolute byte offset each returned record starts at, or null where it could
 * not be established. The shared reader verified that `scannedTo` sits one byte
 * PAST the newline terminating the last returned record, so that newline is at
 * `scannedTo - 1` and the record's own bytes are `[start, scannedTo - 1)`. Walking
 * backward from the newline therefore starts at `scannedTo - 1`: beginning at
 * `scannedTo` itself would shift every start one byte too far and could read a
 * record that began before the bind floor as post-bind evidence. That is only
 * sound when the window held no oversized record, which the caller already treats
 * as a source gap before it gets here.
 */
function recordStartOffsets(lines: readonly string[], scannedTo: number): readonly (number | null)[] {
  const starts: (number | null)[] = new Array<number | null>(lines.length).fill(null);
  // The last consumed newline, not the byte after it.
  let end = scannedTo - 1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bytes = Buffer.byteLength(lines[index] ?? "", "utf8");
    const start = end - bytes;
    if (!Number.isSafeInteger(start) || start < 0) return starts;
    starts[index] = start;
    // Step over the newline that terminated this record.
    end = start - 1;
  }
  return starts;
}

/**
 * The provider's persisted record ordinal: `RolloutOrdinalState` increments it by
 * exactly one per written record, and a `Legacy` history mode omits it entirely.
 * `null` means this record carries none (so it neither sets nor breaks
 * continuity); `"invalid"` means a present value that cannot be a u64 ordinal.
 */
function readRecordOrdinal(record: Record<string, unknown>): number | null | "invalid" {
  const value = record.ordinal;
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "invalid";
  return value;
}

/** How the landed reducer's own bounded-string reader classifies one scope field. */
function readScopeField(value: unknown, maxChars: number): "absent" | "invalid" | "value" {
  if (value === undefined || value === null) return "absent";
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "absent";
  if (trimmed.length > maxChars) return "invalid";
  return "value";
}

/**
 * True for a record the landed reducer treats as a STATUS record whose required
 * scope is missing or unusable, mirroring exactly the cases where that reducer
 * degrades rather than ignores: an `event_msg` with no payload object or no
 * payload `type`; a lifecycle record without the `turn_id` the wire requires (a
 * `turn_aborted` may legitimately carry a null one); a persisted TOOL item without
 * the turn scope `readTurnScope` needs; a legacy tool witness with an unusable
 * scope. A record the reducer returns unchanged — a text or lifecycle item, a
 * nested turn, or one that visibly belongs to another thread — is irrelevant, never
 * a defect.
 */
function isMalformedStatusEnvelope(record: Record<string, unknown>, rootThreadId: string | null): boolean {
  if (record.type !== "event_msg") return false;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (payload === null || typeof payload.type !== "string") return true;
  const kind = payload.type;
  if (kind === "item_completed") {
    if (!threadCouldMatchBinding(rootThreadId, payload.thread_id)) return false;
    const item = isRecord(payload.item) ? payload.item : null;
    if (item === null || typeof item.type !== "string") return true;
    // `reduceItemCompleted` returns an unrecognized item unchanged, so only a
    // persisted tool item owns the turn scope this check guards.
    if (!isStatusToolItemType(item.type)) return false;
    return readScopeField(payload.turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS) !== "value"
      || readScopeField(payload.root_turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS) === "invalid";
  }
  if (kind === "patch_apply_end" || kind === "mcp_tool_call_end" || kind === "web_search_end") {
    // `noteLegacyTool` tolerates the empty turn id older records default to and
    // still contributes activity, so only an unusable scope is a defect here.
    const turn = readScopeField(payload.turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
    return turn === "invalid" || (turn === "value"
      && readScopeField(payload.root_turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS) === "invalid");
  }
  const isStart = kind === "task_started" || kind === "turn_started";
  const isTerminal = kind === "task_complete" || kind === "turn_complete" || kind === "turn_aborted";
  if (!isStart && !isTerminal) return false;
  if (readScopeField(payload.root_turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS) === "invalid") return true;
  const turn = readScopeField(payload.turn_id, NATIVE_CODEX_MAX_TURN_ID_CHARS);
  if (turn === "invalid") return true;
  return turn === "absent" && kind !== "turn_aborted";
}

/**
 * The closed vocabulary of persisted `TurnItem` kinds the landed reducer labels as
 * tool activity. Kept in step with `nativeCodexItemLabel`; everything outside it
 * is returned unchanged by the reducer and so carries no scope requirement.
 */
function isStatusToolItemType(itemType: string): boolean {
  return itemType === "CommandExecution" || itemType === "FileChange" || itemType === "McpToolCall"
    || itemType === "DynamicToolCall" || itemType === "FunctionCallOutput"
    || itemType === "WebSearch" || itemType === "ImageView";
}

/** True when a record's thread id cannot contradict this row's root binding. */
function threadCouldMatchBinding(rootThreadId: string | null, threadId: unknown): boolean {
  if (rootThreadId === null) return true;
  if (readScopeField(threadId, NATIVE_CODEX_MAX_TURN_ID_CHARS) !== "value") return true;
  return (threadId as string).trim() === rootThreadId;
}

/**
 * One synchronous size read of the one bound rollout, captured when the scope
 * binds. A missing or unreadable file yields null, which makes the first scan read
 * its whole window as history instead of claiming any of it is current.
 */
function boundRolloutSize(transcriptPath: string): number | null {
  try {
    const stats = lstatSync(transcriptPath, { throwIfNoEntry: false });
    return stats !== undefined && stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}
