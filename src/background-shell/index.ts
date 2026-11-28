/*
 * Derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { onExit } from "signal-exit";
import { expandableResult, type ToolResultRenderCallback } from "../tool-result-expansion";
import { isToolCallFingerprint, toolCallFingerprint, type StartLiveness, type SubmittedToolCallFingerprint } from "../tool-call-fingerprint";
import {
  selectWindowsPowerShellForJobsAsync,
  spawnBackgroundJob,
  type WindowsJobShellRoute,
  type WindowsShellSelection,
} from "./shell";
import { BACKGROUND_SHELL_TOOL_NAMES } from "./tool-names";
import {
  requestWindowsOwnershipStop,
  ownershipAcknowledgement,
  ownershipVerdict,
  type BackgroundJobOwnership,
  type OwnershipAcknowledgement,
} from "./ownership";
import { scheduleForceKill } from "./process";
import { terminalColumns, truncateLineToWidth } from "./width";
import {
  registerOwnedActivitySource,
  type OwnedActivityIntentRefresh,
  type OwnedActivitySourceHandle,
} from "../session-host/owned-activity";
import {
  DEFAULT_RULES,
  LineBuffer,
  MIN_WAKE_INTERVAL_MS,
  MAX_ERROR_DISPLAY_CHARS,
  MAX_LABEL_CHARS,
  MAX_LOG_LINE_CHARS,
  MAX_LOG_RESULT_CHARS,
  PendingLineBuffer,
  WAKE_CONTEXT_LINES,
  compileMatchers,
  describeWakeRules,
  evaluateExit,
  evaluateMatch,
  evaluateSilence,
  formatElapsed,
  formatWakePayload,
  laneDelivery,
  normalizeRules,
  truncateText,
  type JobMatchers,
  type JobWakeState,
  type WakeEvent,
  type WakeRules,
} from "./jobs";
import {
  renderShellListResult,
  renderShellLogResult,
  renderShellSendResult,
  renderShellStartResult,
  renderShellStopResult,
  shellListCollapsedView,
  shellLogCollapsedView,
  shellSendCollapsedView,
  shellStartCollapsedView,
  shellStopCollapsedView,
  shellResultDetails,
  type ShellResultViewTheme,
} from "./result-view";

interface BackgroundShellTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, any>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: any,
  ): Promise<Record<string, unknown>>;
  /** Shared native expansion wiring (#57/#58): the preserved native-fallback
   *  collapsed view plus this family's per-tool expanded detail renderer. */
  renderResult?: ToolResultRenderCallback<ShellResultViewTheme>;
}

export interface BackgroundShellHost {
  registerTool(tool: BackgroundShellTool): unknown;
  on(name: string, handler: (...args: any[]) => unknown): unknown;
  sendMessage(message: Record<string, unknown>, delivery: Record<string, unknown>): unknown;
}

export interface BackgroundShellJobSnapshot {
  id: string;
  label: string;
  pid?: number;
  processGroupId?: number;
}

export interface BackgroundShellLifecycleSnapshot {
  revision: number;
  running: BackgroundShellJobSnapshot[];
}

export interface BackgroundShellLifecycleEvent {
  type: "started" | "settled";
  revision: number;
  job: BackgroundShellJobSnapshot;
  running: BackgroundShellJobSnapshot[];
  /** The ordinary per-job exit notification already resumed the model. */
  exitWakeScheduled: boolean;
}

export interface BackgroundShellController {
  snapshot(): BackgroundShellLifecycleSnapshot;
  subscribe(listener: (event: BackgroundShellLifecycleEvent) => void): () => void;
  /** Fail-closed liveness check keyed by the exact submitted ShellStart call. */
  startLiveness(fingerprint: string): StartLiveness;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function integerSchema(description: string): Record<string, unknown> {
  return { type: "integer", description };
}

// Background shell jobs that wake the agent on events in the job, not on a
// timer. See jobs.ts for why polling is the wrong primitive here.
//
// Lifetime: a job must outlive a TURN but must never outlive the SESSION.
// Orphaned children are the failure mode that matters — they hold GPU memory on
// a box whose whole constraint is 8GB of it — so session_shutdown reaps
// everything, with the SIGTERM→SIGKILL escalation borrowed from the sub-coder
// spawner (PR #102 fixed the version that gated on proc.killed and could never
// actually fire). On Windows there is no signal stage: the per-job stop file
// asks the owning watchdog to terminate the whole job object, and that watchdog
// also terminates it on its own when the host disappears (see
// wrapWithPowerShellWatchdog).
//
// Shell: a fixed platform contract (#99) — Bash on macOS/Linux, PowerShell on
// Windows (pwsh first, then powershell.exe; neither => clear error before any
// job starts). There is no shell selection in arguments or configuration.
//
// Guarding: ShellStart hands a string to a shell. It is registered through the
// same Pi tool surface as the rest of this harness and remains subject to the
// caller's native --tools allowlist.

const MAX_JOBS = 8;
const STALL_TICK_MS = 30_000;

interface Job {
  id: string;
  /** Hashed exact native ShellStart name+arguments; never exposes command text. */
  startCallFingerprint?: string;
  label: string;
  command: string;
  proc: ChildProcess;
  buffer: LineBuffer;
  /** Wake patterns compiled once — never per line. */
  matchers: JobMatchers;
  rules: WakeRules;
  wake: JobWakeState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  lastOutputAt: number | null;
  exited: boolean;
  /** Partial trailing line, held until its newline arrives. Bounded: see
   *  PendingLineBuffer — a no-newline firehose cannot grow it past the cap. */
  pending: PendingLineBuffer;
  /** Set the first time stdin reports an error (EPIPE, destroyed, …). Bounds
   *  the buffer to one diagnostic per job across a normal exit race. */
  stdinDead?: boolean;
  stdinError?: string;
  /** A match wake held back to see whether the job exits first. */
  pendingWake?: ReturnType<typeof setTimeout>;
  /**
   * Exit-wake receipt. "queued": the completion was submitted to Pi and its
   * custom message has not entered the transcript yet. "injected": the
   * transcript carries it (message_start with customType
   * "pi-review-bg-shell", details.id === job.id, details.kind === "exit" —
   * other notifications from the same job, such as an earlier match, never
   * acknowledge it). Injection is NOT delivery under steering (#452): Pi can
   * drain a queued steering wake while tearing an aborted run down and end
   * that run without another provider request, so only a later normal
   * assistant response (see consumeInjectedExitWakes) proves the owning
   * session's model consumed the context. pi.sendMessage returns void on the
   * real extension API, so these transcript events — not a delivery result —
   * are the only supported signal. At agent_settled an outstanding receipt
   * (queued, or injected but not yet consumed) triggers a single bounded
   * recovery turn that resumes Pi's own drainage of the retained completion
   * instead of re-submitting it.
   */
  exitWakeState?: "queued" | "injected";
  /** Windows-only per-job ownership identity (job-object record/stop paths);
   *  keeps descendants accounted for and cleanable after the shell root exits. */
  ownership?: BackgroundJobOwnership;
  /** True while a root-exited job's ownership evidence is missing or
   *  unreadable: the job stays accounted for (blocking) until verified clear.
   *  Never true on macOS/Linux (process groups already cover descendants). */
  ownershipUnverifiable?: boolean;
  /** Windows only: which route hosts the job (#800). `msix` jobs run their
   *  command in a Store PowerShell workload launched inside the job object. */
  shellRoute?: WindowsJobShellRoute;
  /** Set when the job settled on the job object's explicit terminal
   *  acknowledgement while its stdio pipe was still held open by a process
   *  outside the job (#800). */
  settledOnAcknowledgement?: OwnershipAcknowledgement;
}

const jobs = new Map<string, Job>();
let seq = 0;
/** Bumped by every reapAll() (session start/shutdown): an asynchronous
 *  ShellStart that began in an earlier session must not spawn into the next. */
let sessionGeneration = 0;

/**
 * Unsettled work observed by this module copy, retained until independently
 * confirmed settlement — including jobs reaped out of `jobs` (reapAll clears
 * the map without settling). This is the authoritative exact inventory the
 * resync and the registry's intent-refresh pass reconstruct from: a reaped
 * job's token must survive until its close/verdict, never vanish with the map.
 */
const unsettledShellJobs = new Map<string, { job: Job; intentHeld: boolean }>();

/**
 * Process-unique prefix for owned-activity tokens. A module incarnation's job
 * ids restart at 1 on reload, so the prefix (fresh per module instance) plus
 * the job id is what makes a token globally unique across reloads; a released
 * token can therefore never remove a newer incarnation's ownership.
 */
const ownedActivityTokenPrefix = randomUUID();

function ownedActivityToken(job: Job): string {
  return `${ownedActivityTokenPrefix}:${job.id}`;
}

/**
 * Owned-work observation for native session cards. Registered at module load;
 * the registry stays inert (no IO, no observation) until the authenticated
 * session-host reporter opts in, and this registration is replayed then. The
 * resync only re-acquires tokens of jobs that are still unsettled: it never
 * releases, because only independently confirmed settlement may do that.
 */
let shellOwnedActivity: OwnedActivitySourceHandle | undefined;
shellOwnedActivity = registerOwnedActivitySource("backgroundShells", "background-shell", {
  resync: () => {
    const handle = shellOwnedActivity;
    if (!handle) return; // module still initializing: no unsettled work observed
    // The unsettled ledger is the exact authoritative inventory: it covers live
    // jobs AND jobs reaped out of `jobs` before confirmed settlement. Re-acquire
    // every positive token; never release, because only an actual settlement
    // event may do that.
    for (const entry of unsettledShellJobs.values()) {
      const token = ownedActivityToken(entry.job);
      handle.acquire(token);
      if (entry.intentHeld) handle.acquireIntent(token);
    }
    handle.resolveUncertainty();
    // Intent is fully accounted for only when no job's liveness is unverified;
    // an unverifiable record stays unknown until its verdict resolves.
    if (intentUnverifiableJobs.size === 0) handle.resolveIntentUncertainty();
  },
  refreshActivity: (): OwnedActivityIntentRefresh => {
    const handle = shellOwnedActivity;
    if (handle === undefined) return { status: "incomplete" };
    // Retirement is not incompleteness: this incarnation's own ledger is still
    // the only proof of its unsettled jobs, and the registry fences the result
    // against this exact incarnation's revision.
    const tokens = new Set<string>();
    for (const [token, entry] of unsettledShellJobs) {
      // The intent-unverifiable ledger is authoritative: a root exit with an
      // unverifiable ownership verdict lands here BEFORE close arrives, while
      // the job record's own verdict field may still be unset. Genuinely
      // unobserved work stays unknown — never a fabricated zero.
      if (intentUnverifiableJobs.has(entry.job.id)) return { status: "incomplete" };
      if (entry.intentHeld) tokens.add(token);
    }
    return { status: "complete", intentTokens: tokens };
  },
});

/**
 * Pure telemetry decision for one close/error completion signal. Kept separate
 * so the error-before-close semantics are covered by a synthetic regression
 * without spawning a process: `release` may release the ownership token only
 * on an independently confirmed exit (with verified Windows ownership where
 * applicable); `retain` keeps it positive after a bare error or an unverified
 * verdict. The caller's ordinary Windows ownership gate is unchanged and runs
 * before this decision in the live path.
 */
function shellCompletionAction(input: {
  confirmedExit: boolean;
  verdict: "clear" | "running" | "unverifiable" | undefined;
}): "release" | "retain" {
  // Only a confirmed exit may release; a bare error (or a late confirmed close
  // after one) is judged purely on the settled signal and the ownership verdict.
  if (!input.confirmedExit) return "retain";
  if (input.verdict !== undefined && input.verdict !== "clear") return "retain";
  return "release";
}

/** Release this job's telemetry token; idempotent, only after confirmed settlement. */
function releaseOwnedShellActivity(job: Job): void {
  const token = ownedActivityToken(job);
  unsettledShellJobs.delete(token);
  shellOwnedActivity?.release(token);
}

/**
 * Activity-intent decision for one shell completion observation. Kept pure and
 * separate from `shellCompletionAction`: a retained cleanup obligation never
 * keeps intent positive, and an unverifiable ownership record is UNKNOWN rather
 * than a fabricated stop. On POSIX a bare error (no close yet) keeps the job
 * active until its close arrives; on Windows a verified `clear` verdict, or a
 * verified live-descendant `running` verdict, decides independently of whether
 * the shell root already exited.
 */
function shellIntentAction(input: {
  confirmedExit: boolean;
  verdict: "clear" | "running" | "unverifiable" | undefined;
}): "active" | "stopped" | "unknown" {
  if (input.verdict === "unverifiable") return "unknown";
  if (input.verdict === "running") return "active";
  if (input.verdict === "clear") return "stopped";
  return input.confirmedExit ? "stopped" : "active";
}

/**
 * Jobs whose Windows ownership evidence is missing/unreadable: their process
 * work is genuinely unobserved, so the shell activity count is UNKNOWN until
 * one resolves. This uncertainty is ours alone; resolving it never clears a
 * different uncertainty a pre-opt-in replay established.
 */
const intentUnverifiableJobs = new Set<string>();
let shellIntentUncertaintyHeld = false;

function markShellIntentUnverifiable(job: Job): void {
  if (intentUnverifiableJobs.has(job.id)) return;
  intentUnverifiableJobs.add(job.id);
  if (shellIntentUncertaintyHeld) return;
  shellIntentUncertaintyHeld = true;
  shellOwnedActivity?.markIntentUncertain();
}

function clearShellIntentUnverifiable(job: Job): void {
  if (!intentUnverifiableJobs.delete(job.id)) return;
  if (intentUnverifiableJobs.size > 0 || !shellIntentUncertaintyHeld) return;
  shellIntentUncertaintyHeld = false;
  shellOwnedActivity?.resolveIntentUncertainty();
}

/**
 * Apply one activity-intent observation. Registry mutations notify synchronous
 * subscribers (the reporter emits a frame per notification), so the ordering is
 * safety-critical: mark the source uncertain BEFORE dropping its positive token
 * (an unverified shell must go 1 -> null, never 1 -> 0 -> null), and acquire the
 * positively observed token BEFORE resolving uncertainty (a verified-live shell
 * must go null -> 1, never null -> 0 -> 1). Ownership settlement is untouched.
 */
function observeShellIntent(job: Job, action: "active" | "stopped" | "unknown"): void {
  const token = ownedActivityToken(job);
  // Keep the unsettled ledger's intent view exact; a missing entry means this
  // observation predates ledger tracking (or the job already settled).
  const unsettled = unsettledShellJobs.get(token);
  if (unsettled) unsettled.intentHeld = action === "active";
  if (action === "unknown") {
    markShellIntentUnverifiable(job);
    shellOwnedActivity?.releaseIntent(token);
    return;
  }
  if (action === "stopped") shellOwnedActivity?.releaseIntent(token);
  else shellOwnedActivity?.acquireIntent(token);
  // Resolve only after the token reflects the positively observed state, so a
  // synchronous subscriber never observes a fabricated zero in between.
  clearShellIntentUnverifiable(job);
}

/**
 * Intent-only observation for the shell root's own exit, made before the later
 * stream close that settles ownership. Root exit ends the running indicator
 * immediately (so a delayed close can never strand it) unless a verified
 * Windows verdict still names live owned descendants (active) or ownership
 * evidence is genuinely unreadable (unknown). This never touches ownership
 * settlement, wakes, or the ordinary close/error handling.
 */
function observeShellRootExit(job: Job): void {
  const windowsOwned = process.platform === "win32" && job.ownership && job.proc.pid !== undefined;
  const verdict = windowsOwned
    ? ownershipVerdict(job.ownership!.markerPath, processIsAlive(job.proc.pid), processIsAlive, job.shellRoute)
    : undefined;
  observeShellIntent(job, shellIntentAction({ confirmedExit: true, verdict }));
}

/** Narrow pure seam for focused settlement tests; no process or IO is touched. */
export const __test = Object.freeze({
  shellCompletionAction,
  shellIntentAction,
  /**
   * The module's real shell-source handle. It is registered at import, so a
   * caller that opts the registry in afterward can resolve the replay
   * uncertainty and then drive real intent observations. No process or IO.
   */
  shellActivityHandle(): OwnedActivitySourceHandle | undefined {
    return shellOwnedActivity;
  },
  /**
   * Run the real activity-intent observation path for a synthetic job id: the
   * same function the shell completion/close/error callbacks invoke. No
   * process, timer, or IO is touched.
   */
  observeShellIntentForTests(jobId: string, action: "active" | "stopped" | "unknown"): void {
    observeShellIntent({ id: jobId } as Job, action);
  },
  /**
   * Attach the real stream/settlement handlers to a synthetic job backed by a
   * fake child process, so the registered exit/error/close callbacks can be
   * exercised without spawning anything. No process or IO is touched.
   */
  attachStreamsForTests(pi: BackgroundShellHost, job: Job): void {
    attachStreams(pi, job);
  },
  /** Stop every acknowledgement watcher (test teardown only: production keeps
   *  them across reapAll until the job settles). No process or IO. */
  clearAcknowledgementWatchesForTests(): void {
    for (const timer of acknowledgementTimers.values()) clearInterval(timer);
    acknowledgementTimers.clear();
  },
  /**
   * Register a synthetic job (fake child process) exactly as ShellStart
   * registers a spawned one — the `jobs` map, owned-activity ownership and
   * intent, and the unsettled ledger — then attach the real handlers. Lets a
   * test reap it with the real reapAll(). No process or IO is touched.
   */
  registerJobForTests(pi: BackgroundShellHost, job: Job): void {
    jobs.set(job.id, job);
    const token = ownedActivityToken(job);
    shellOwnedActivity?.acquire(token);
    shellOwnedActivity?.acquireIntent(token);
    unsettledShellJobs.set(token, { job, intentHeld: true });
    attachStreams(pi, job);
  },
  /** Whether the job's ownership token is still held in the unsettled ledger. */
  ownershipHeldForTests(jobId: string): boolean {
    return unsettledShellJobs.has(`${ownedActivityTokenPrefix}:${jobId}`);
  },
  /** The exact ownership token the real settlement path releases for a job id. */
  ownedActivityTokenForTests(jobId: string): string {
    return `${ownedActivityTokenPrefix}:${jobId}`;
  },
  /**
   * Test seam: record one synthetic started-then-reaped job in the real
   * unsettled ledger WITHOUT adding it to `jobs` (reapAll's map clear), so the
   * resync/refresh paths can be exercised without spawning or reaping a
   * process. The entry settles through the ordinary close path for the same id.
   */
  trackReapedShellJobForTests(jobId: string, exited: boolean): string {
    const job = { id: jobId, exited } as Job;
    const token = `${ownedActivityTokenPrefix}:${jobId}`;
    unsettledShellJobs.set(token, { job, intentHeld: !exited });
    return token;
  },
});
let stallTimer: ReturnType<typeof setInterval> | null = null;
let lifecycleRevision = 0;
const lifecycleListeners = new Set<(event: BackgroundShellLifecycleEvent) => void>();
/** Kept so the indicator can repaint from process events that carry no ctx. */
let uiCtx: any = null;

/** Per-job timers that re-check Windows ownership after the shell root has
 *  exited but owned descendants may remain; cleared on settle and reapAll. */
const ownershipReleaseTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Per-job timers, started at the Windows root's exit, that settle a job on
 *  the job object's explicit terminal acknowledgement when its stdio pipe is
 *  held open by a process outside the job (#800). Keyed by the job object and
 *  cleared only on settlement — NOT by reapAll(): for a reaped job whose root
 *  already exited while an outside process holds its pipe, this watcher is the
 *  only path that can still release its ownership token and this host's pipe
 *  ends once the job object is verified empty. */
const acknowledgementTimers = new Map<Job, ReturnType<typeof setInterval>>();

/** How often the acknowledgement re-check runs after the root exits. */
const ACKNOWLEDGEMENT_TICK_MS = 500;
/** How long an observed acknowledgement must stand without a stream close
 *  before the job settles on it: a job whose last in-job pipe holder just
 *  exited closes its pipe within milliseconds, and this window lets that
 *  ordinary close (with every buffered byte of output) win the race. */
const ACKNOWLEDGEMENT_DRAIN_MS = 1_500;

/** True when `pid` names a live process (EPERM means alive-but-protected). */
function processIsAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const INDICATOR_KEY = "bg-shell";
const honey = (s: string) => `\x1b[38;2;225;90;31m${s}\x1b[39m`;
const gray = (s: string) => `\x1b[90m${s}\x1b[39m`;

function runningJobs(): Job[] {
  return [...jobs.values()].filter((j) => !j.exited);
}

function jobSnapshot(job: Job): BackgroundShellJobSnapshot {
  return {
    id: job.id,
    label: job.label,
    pid: job.proc.pid,
    processGroupId: process.platform === "win32" ? undefined : job.proc.pid,
  };
}

function lifecycleSnapshot(): BackgroundShellLifecycleSnapshot {
  return {
    revision: lifecycleRevision,
    running: runningJobs().map(jobSnapshot),
  };
}

function publishLifecycle(
  type: BackgroundShellLifecycleEvent["type"],
  job: Job,
  exitWakeScheduled = false,
): void {
  lifecycleRevision += 1;
  const snapshot = lifecycleSnapshot();
  const event: BackgroundShellLifecycleEvent = {
    type,
    revision: snapshot.revision,
    job: jobSnapshot(job),
    running: snapshot.running,
    exitWakeScheduled,
  };
  for (const listener of lifecycleListeners) {
    try {
      listener(event);
    } catch {
      /* lifecycle observers must not break process event handlers */
    }
  }
}

const controller: BackgroundShellController = {
  snapshot: lifecycleSnapshot,
  subscribe(listener) {
    lifecycleListeners.add(listener);
    return () => lifecycleListeners.delete(listener);
  },
  startLiveness(fingerprint) {
    let unknown = false;
    for (const job of runningJobs()) {
      if (!job.startCallFingerprint) {
        unknown = true;
      } else if (job.startCallFingerprint === fingerprint) {
        return { state: "active", identity: job.id };
      }
    }
    return unknown ? { state: "unknown" } : { state: "inactive" };
  },
};

/**
 * One line under the input showing what is running in the background, so a job
 * started ten minutes ago is never invisible. Absent entirely when nothing is
 * running — an idle session gets no extra chrome.
 */
function setIndicator(ctx?: any): void {
  const target = ctx ?? uiCtx;
  if (ctx) uiCtx = ctx;
  if (!target?.hasUI) return;
  const live = runningJobs();
  try {
    if (live.length === 0) {
      target.ui.setWidget(INDICATOR_KEY, undefined, { placement: "belowEditor" });
      return;
    }
    const now = Date.now();
    const names = live
      .slice(0, 3)
      .map((j) => `${j.label} ${formatElapsed(now - j.startedAt)}`)
      .join(", ");
    const more = live.length > 3 ? ` +${live.length - 3}` : "";
    const noun = live.length === 1 ? "job" : "jobs";
    const raw = `${honey("⟳")} ${live.length} background ${noun} ${gray(`— ${names}${more}`)}`;
    target.ui.setWidget(INDICATOR_KEY, [truncateLineToWidth(raw, terminalColumns())], {
      placement: "belowEditor",
    });
  } catch {
    /* widget surface unavailable in some run modes */
  }
}

function nextId(): string {
  seq += 1;
  return `job${seq}`;
}

function textResult(text: string, isError = false, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

/** Every error reaching the model goes through here. Error messages embed
 *  model-supplied fragments (job ids, labels, spawn exception text); left
 *  unbounded, a multi-megabyte argument would be echoed straight into model
 *  context. Truncate with the visible marker before returning. */
function errorResult(text: string, details: Record<string, unknown> = {}) {
  return textResult(truncateText(text, MAX_ERROR_DISPLAY_CHARS), true, details);
}

function resolveJob(target: string): { job?: Job; error?: ReturnType<typeof textResult> } {
  const exact = jobs.get(target);
  if (exact) return { job: exact };
  const matches = [...jobs.values()].filter((job) => job.label === target);
  if (matches.length === 1) return { job: matches[0] };
  if (matches.length > 1) {
    const choices = matches.map((job) => `- ${job.id} (${statusOf(job)})`).join("\n");
    return {
      error: errorResult(
        `Error: label ${JSON.stringify(target)} is ambiguous. Matching job IDs:\n${choices}\n` +
          `Retry ShellStop with one exact job ID, for example: {"id":${JSON.stringify(matches[0].id)}}`,
      ),
    };
  }
  return { error: errorResult(`Error: no such job id or label ${JSON.stringify(target)}. Use ShellList to see available job IDs.`) };
}

/** Send a wake event to the agent through the lane its urgency earns.
 *
 *  The real extension API's pi.sendMessage returns void (the loader forwards
 *  the call without returning a result), so there is no delivery promise to
 *  observe. For exit wakes — the acknowledged completion contract behind
 *  "You will be notified automatically; there is no need to poll" — the send is therefore
 *  retained on the job as a queued receipt until its custom message enters
 *  the transcript (message_start with matching customType and details.id),
 *  and as an injected receipt until a later normal assistant response proves
 *  the model consumed it. The receipt is set BEFORE the send: a host may
 *  observe the injection synchronously from inside the void sendMessage call
 *  (its message_start fires before the call returns), and observation only
 *  advances an existing receipt. If that host then throws, the observed wake
 *  still reports accepted; a throw with no observation leaves nothing
 *  scheduled and nothing to recover. A run that ends before consuming an
 *  injected wake, or before draining its queued steering wake (an aborted
 *  run), leaves the receipt outstanding; at agent_settled it triggers one
 *  bounded recovery turn
 *  that consumes the completion instead of re-submitting it — never a second
 *  copy. Routine status wakes stay best-effort: losing one is survivable by
 *  design, and they are never tracked or resumed. */
function sendWake(pi: BackgroundShellHost, job: Job, event: WakeEvent, now: number): boolean {
  job.wake.lastWakeAt = now;
  const delivery = laneDelivery(event.lane);
  const payload = formatWakePayload({
    id: job.id,
    label: job.label,
    command: job.command,
    event,
    elapsedMs: (job.endedAt ?? now) - job.startedAt,
    exitCode: event.kind === "exit" ? job.exitCode : undefined,
    lines: job.buffer.around(WAKE_CONTEXT_LINES),
    totalLines: job.buffer.total,
  });
  // Tag the notification with its event kind so observation can acknowledge
  // only exit completions: an earlier match wake can be injected while this
  // job's exit completion is still queued in Pi, and must not clear the
  // outstanding-exit marker.
  const message = { customType: "pi-review-bg-shell", content: payload, display: true, details: { id: job.id, kind: event.kind } };
  // Mark the exit wake outstanding before sending so a synchronous
  // observation from inside sendMessage (message_start before the void call
  // returns) can record its injection on the spot — observeWakeDelivery only
  // advances an existing receipt.
  if (event.kind === "exit") {
    job.exitWakeState = "queued";
  }
  try {
    pi.sendMessage(message, delivery as any);
  } catch {
    if (event.kind === "exit" && job.exitWakeState === "injected") {
      // The host observed this injection synchronously before throwing: the
      // wake reached the transcript, so report it accepted — the review gate
      // then stays off its own completion follow-up instead of duplicating
      // the delivered wake. The receipt remains until a completed response
      // proves the injected context was consumed.
      return true;
    }
    if (event.kind === "exit") {
      // Refused before any observation: nothing was delivered, so leave no
      // receipt for settlement recovery to act on — unscheduled, not lost.
      job.exitWakeState = undefined;
    }
    // A delivery mode can be rejected while pi is mid-transition. Losing a
    // status wake is survivable; throwing out of a process event handler is not.
    return false;
  }
  return true;
}

/** Record that an EXIT wake's custom message has been injected into the
 *  transcript. Pi emits message_start/message_end for the injected custom
 *  message (role "custom", customType "pi-review-bg-shell", details.id = job
 *  id, details.kind = event kind) — both when it is queued and drained
 *  mid-run and when it starts a fresh run — so this proves injection, NOT
 *  consumption. Only an exit injection (kind === "exit") advances the
 *  receipt: matching on a match wake could clear the exit receipt for a
 *  completion that is still queued. */
function observeWakeDelivery(event: unknown): void {
  const message = (event as { message?: Record<string, unknown> } | undefined)?.message;
  if (!message || message.role !== "custom" || message.customType !== "pi-review-bg-shell") return;
  const details = message.details as { id?: unknown; kind?: unknown } | undefined;
  if (!details || typeof details.id !== "string" || details.kind !== "exit") return;
  const job = jobs.get(details.id);
  if (job?.exitWakeState) job.exitWakeState = "injected";
}

/** Clear injected exit receipts whose completion a provider request actually
 *  consumed: a normal assistant response (stop, tool use, or length) can only
 *  follow a request issued after the injection, so it proves the owning
 *  session's model received the wake. An aborted, error, or unknown response
 *  proves the opposite — Pi can inject a queued steering wake while tearing an
 *  aborted run down and end that run without any request consuming it (#452) —
 *  so the receipt stays outstanding for settlement recovery. Runs are serial,
 *  so one completed response consumes every injected exit wake. A "queued"
 *  receipt is never cleared here: the wake may not be in this request yet. */
function consumeInjectedExitWakes(event: unknown): void {
  const message = (event as { message?: Record<string, unknown> } | undefined)?.message;
  if (!message || message.role !== "assistant") return;
  const stopReason = message.stopReason;
  if (stopReason !== "stop" && stopReason !== "toolUse" && stopReason !== "length") return;
  for (const job of jobs.values()) {
    if (job.exitWakeState !== "injected") continue;
    job.exitWakeState = undefined;
  }
}

/** Resume recovery of exit wakes that were not proved consumed.
 *  Called at agent_settled: a run that just settled may have ended without
 *  draining its queued steering wake (an aborted run), or Pi may have injected
 *  a queued steering wake while tearing that run down and ended it before any
 *  provider request consumed it. Pi retains the queued completion —
 *  Agent.abort() does not clear the queues, and neither does a new prompt — so
 *  re-submitting it would inject one copy immediately and drain the original
 *  again when the recovery turn stops: a duplicate. One bounded hidden control
 *  message (distinct customType, display:false) starts the recovery turn
 *  instead; that turn consumes the retained completion from Pi's steering
 *  queue (drained at its first steering poll) or from the context an aborted
 *  run already injected, exactly once, without touching any unrelated queued
 *  messages. Every outstanding receipt (queued, or injected but unconsumed) is
 *  cleared before the control send, so an already-consumed wake never triggers
 *  recovery and a refused or canceled recovery never retries the same exit
 *  wake. One trigger per settlement services every outstanding job. */
function resendUnobservedExitWakes(pi: BackgroundShellHost): void {
  let needsResume = false;
  for (const job of jobs.values()) {
    if (!job.exitWakeState) continue;
    job.exitWakeState = undefined;
    needsResume = true;
  }
  if (!needsResume) return;
  try {
    // The completion remains in Pi's queue; resume drainage, not delivery of a
    // second copy. Never clear queues containing unrelated messages.
    pi.sendMessage({
      customType: "pi-review-bg-shell-resume",
      content: "Resume pending background-shell notifications.",
      display: false,
    }, { deliverAs: "followUp", triggerTurn: true });
  } catch {
    // The session may be shutting down; the job's final state stays readable
    // through ShellList/ShellLog, which is the documented floor, not the promise.
  }
}

/** Deliver a wake event through its lane. #452: eligible routine and exit
 *  wakes steer, so they reach the owning turn at Pi's next supported boundary
 *  instead of waiting for the natural stop (settlement). Delivery is therefore
 *  never held by this code merely because an agent run is already active. */
function deliverWake(pi: BackgroundShellHost, job: Job, event: WakeEvent, now: number): boolean {
  // A Store/MSIX job reaped by a session change stays observed until its job
  // object is verified empty (#800), and its pipe can stay open meanwhile; no
  // match, silence, or exit wake from it — and none of its command or output —
  // may reach the replacement session.
  if (job.shellRoute === "msix" && jobs.get(job.id) !== job) return false;
  return sendWake(pi, job, event, now);
}

/** How long a match wake waits to see whether the job is about to exit anyway.
 *  A crash prints its traceback and then dies within milliseconds; without this
 *  the model gets woken twice for one event — once for the matched line, once
 *  for the exit — and spends two turns learning one thing. */
const EXIT_COALESCE_MS = 1500;

/** How long ShellSend waits for the write callback before reporting the write
 *  as delivery-UNCONFIRMED (never as written). Live jobs flush small writes to
 *  the OS pipe buffer immediately, so this only bounds the backpressure case —
 *  a payload larger than the pipe capacity that the child is not reading. Any
 *  later failure still lands via the stdin 'error' listener. */
const WRITE_FLUSH_TIMEOUT_MS = 1500;
const MAX_STDIN_ERROR_CHARS = 240;

function boundedStdinError(reason: string): string {
  if (reason.length <= MAX_STDIN_ERROR_CHARS) return reason;
  return `${reason.slice(0, MAX_STDIN_ERROR_CHARS - 14)}…[truncated]`;
}

/** True when the job's stdin cannot accept writes any more. */
function stdinIsDead(job: Job): boolean {
  const stdin = job.proc.stdin;
  return job.stdinDead === true || !stdin || stdin.destroyed || !stdin.writable;
}

/** Record a stdin failure exactly once per job — first reason wins, one
 *  bounded buffer note. Every dead-stdin path (stream 'error' event, write
 *  callback error, synchronous throw, already-destroyed precheck) funnels
 *  through here so ShellLog always explains an unwritable stdin without ever
 *  accumulating repeated notes during exit races. Returns the stored reason. */
function recordStdinFailure(job: Job, reason: string): string {
  if (job.stdinDead) return job.stdinError!;
  const boundedReason = boundedStdinError(reason);
  job.stdinDead = true;
  job.stdinError = boundedReason;
  job.buffer.push(`[stdin error] write to job stdin failed: ${boundedReason}`);
  return boundedReason;
}

function handleLine(pi: BackgroundShellHost, job: Job, line: string): void {
  job.buffer.push(line);
  const now = Date.now();
  job.lastOutputAt = now;
  job.wake.stallNotified = false; // output resumed — re-arm the stall detector

  // Match once. The same result drives both the counter and the wake decision.
  const hit = job.matchers.match(line);
  if (!hit) return;
  job.wake.matchCount += 1;
  const event = evaluateMatch(hit, line, job.rules, job.wake, job.wake.matchCount, now);
  if (!event) return;

  // If this job also wakes on exit, hold the match briefly: should it die in
  // that window, the exit wake carries the same excerpt *plus* the exit code,
  // so it strictly supersedes this one and finish() drops the pending timer.
  if (!job.rules.exit) {
    deliverWake(pi, job, event, now);
    return;
  }
  if (job.pendingWake) clearTimeout(job.pendingWake);
  job.pendingWake = setTimeout(() => {
    job.pendingWake = undefined;
    if (job.exited) return; // exit wake already covered it
    deliverWake(pi, job, event, Date.now());
  }, EXIT_COALESCE_MS);
  (job.pendingWake as any).unref?.();
}

/** Settle a job as finished: record exit state, flush the pending line, drop
 *  held wakes, send the exit wake, and publish the lifecycle event. */
function settleJob(pi: BackgroundShellHost, job: Job, code: number, options: { wake?: boolean } = {}): void {
  if (job.exited) return;
  // `wake: false` settles a job that belongs to an earlier session (reaped):
  // its record is finished, but nothing is delivered into the current one.
  const wake = options.wake ?? true;
  job.exited = true;
  job.exitCode = code;
  job.endedAt = Date.now();
  // A partial line held back by the pending-line buffer is flushed now — the
  // stream is over, so it can never complete (same rule as Pi).
  const remaining = job.pending.flush();
  if (remaining) {
    if (wake) handleLine(pi, job, remaining);
    else job.buffer.push(remaining);
  }
  // Drop any held match wake: the exit wake below says everything it would
  // have, and the exit code besides.
  if (job.pendingWake) {
    clearTimeout(job.pendingWake);
    job.pendingWake = undefined;
  }
  setIndicator();
  if (!wake) return;
  const event = evaluateExit(code, job.rules);
  const exitWakeScheduled = event ? deliverWake(pi, job, event, Date.now()) : false;
  // reapAll() removes jobs before their asynchronous close callbacks arrive.
  // Such callbacks belong to a dead session and must not wake lifecycle
  // consumers in a newly started one.
  if (jobs.get(job.id) === job) publishLifecycle("settled", job, exitWakeScheduled);
}

/** Stop the per-job ownership re-check for a settled (or reaped) job. */
function clearOwnershipRelease(job: Job): void {
  const timer = ownershipReleaseTimers.get(job.id);
  if (timer) clearInterval(timer);
  ownershipReleaseTimers.delete(job.id);
}

function clearAcknowledgementWatch(job: Job): void {
  const timer = acknowledgementTimers.get(job);
  if (timer) clearInterval(timer);
  acknowledgementTimers.delete(job);
}

/**
 * Root-exit settlement on an explicit acknowledgement (#800). Started when the
 * Windows root process exits; the ordinary path (stream close, then the
 * ownership verdict) still settles first whenever it can. This one exists for
 * the case where the stream close can never come: a process OUTSIDE the job —
 * for example one a nested Store app activation started — inherited the job's
 * stdout/stderr pipe and keeps it open. Waiting on that close would hold the
 * job (and a MAX_JOBS slot) for as long as the outside process lives.
 *
 * Settles only on ALL of: the root's own exit event (exact ChildProcess, never
 * a pid probe), a record the watchdog or wrapper actually wrote
 * (`released` / `terminated` / `failed` — see ownershipAcknowledgement), and
 * that acknowledgement still standing after a short drain window with no
 * close. A missing, unreadable, or still-`running` record — including a dead
 * watchdog whose record was never finalized — never settles here: it keeps the
 * job accounted for exactly as before. On settlement the job's own pipe ends
 * are released so nothing keeps this host waiting on the outside process; no
 * process is signalled, and nothing is claimed about the outside process.
 *
 * A job reaped by a session change (reapAll) keeps this watcher until it
 * settles: its ownership token and pipe ends are still released here, but it
 * no longer belongs to the active session, so it is settled without any wake
 * or lifecycle event reaching the replacement session.
 */
function scheduleAcknowledgedSettlement(pi: BackgroundShellHost, job: Job, code: number): void {
  if (acknowledgementTimers.has(job) || !job.ownership) return;
  const markerPath = job.ownership.markerPath;
  let seenAt: number | null = null;
  let seen: OwnershipAcknowledgement | undefined;
  const timer = setInterval(() => {
    if (job.exited) {
      clearAcknowledgementWatch(job);
      return;
    }
    const acknowledgement = ownershipAcknowledgement(markerPath, job.shellRoute);
    if (acknowledgement === undefined && job.shellRoute === "msix") {
      // No acknowledgement yet: keep the Store job's ownership view current
      // after root exit even though no stream close may ever arrive (the
      // root has exited, so only the record decides).
      const verdict = ownershipVerdict(markerPath, false, processIsAlive, "msix");
      job.ownershipUnverifiable = verdict === "unverifiable";
      observeShellIntent(job, shellIntentAction({ confirmedExit: true, verdict }));
    }
    if (acknowledgement === undefined || acknowledgement !== seen) {
      seen = acknowledgement;
      seenAt = acknowledgement === undefined ? null : Date.now();
      return;
    }
    if (seenAt === null || Date.now() - seenAt < ACKNOWLEDGEMENT_DRAIN_MS) return;
    clearAcknowledgementWatch(job);
    clearOwnershipRelease(job);
    job.settledOnAcknowledgement = acknowledgement;
    job.buffer.push(
      acknowledgement === "failed"
        ? "[pi-review-gate] settled: the command never ran (startup failed before ownership was established); its output pipe was still held open by a process outside the job."
        : `[pi-review-gate] settled on the job object's verified acknowledgement (${acknowledgement}): every process in the job is gone. ` +
            "Its output pipe was still held open by a process outside the job object (for example one started by a nested Store app activation); " +
            "that process is not tracked, stopped, or reported, and any further output from it is not captured.",
    );
    observeShellIntent(job, "stopped");
    releaseOwnedShellActivity(job);
    settleJob(pi, job, code, { wake: jobs.get(job.id) === job });
    // Release this host's pipe ends; the outside process keeps whatever it
    // holds, and nothing here waits on it any longer.
    for (const stream of [job.proc.stdin, job.proc.stdout, job.proc.stderr]) {
      try { stream?.destroy(); } catch { /* already closed */ }
    }
  }, ACKNOWLEDGEMENT_TICK_MS);
  // Never hold the process open on our account.
  (timer as any).unref?.();
  acknowledgementTimers.set(job, timer);
}

/** Re-check a root-exited Windows job's ownership until it is verified
 *  complete, then settle it with the exit code the shell reported. One-second
 *  ticks only observe the watchdog's record — its own poll (default 5 s) is
 *  what bounds how long "running" can be over-reported. */
function scheduleOwnershipRelease(pi: BackgroundShellHost, job: Job, code: number): void {
  if (ownershipReleaseTimers.has(job.id)) return;
  const timer = setInterval(() => {
    if (job.exited) {
      clearOwnershipRelease(job);
      return;
    }
    const verdict = ownershipVerdict(
      job.ownership!.markerPath,
      processIsAlive(job.proc.pid),
      processIsAlive,
      job.shellRoute,
    );
    job.ownershipUnverifiable = verdict === "unverifiable";
    observeShellIntent(job, shellIntentAction({ confirmedExit: true, verdict }));
    if (verdict === "clear") {
      clearOwnershipRelease(job);
      releaseOwnedShellActivity(job);
      settleJob(pi, job, code);
    }
  }, 1_000);
  // Never hold the process open on our account.
  (timer as any).unref?.();
  ownershipReleaseTimers.set(job.id, timer);
}

function attachStreams(pi: BackgroundShellHost, job: Job): void {
  const onChunk = (buf: Buffer) => {
    // Bound the pending partial line BEFORE accumulation (finding 4): a
    // multi-MB no-newline stream is capped and marked, never held in full.
    for (const line of job.pending.push(buf.toString())) {
      handleLine(pi, job, line);
    }
  };
  job.proc.stdout?.on("data", onChunk);
  job.proc.stderr?.on("data", onChunk);

  // A child may exit (or close stdin) while an earlier ShellSend write is still
  // queued; the resulting EPIPE/ERR_STREAM_DESTROYED arrives ASYNCHRONOUSLY as
  // an 'error' event on the stdin stream. try/catch around write() can never
  // see it — without this listener Node raises it as an uncaught exception and
  // kills the whole pi host. Recorded once, as a bounded buffer note.
  job.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
    recordStdinFailure(job, err.code || err.message || "stdin write failed");
  });

  const finish = (code: number | null, confirmedExit: boolean) => {
    // Windows ownership: the shell root exiting does NOT end the job while
    // owned descendants remain, and a bare ChildProcess 'error' is never proof
    // of exit. The pure decision below keeps telemetry ownership retained until
    // independently confirmed settlement; the ordinary ownership gate and
    // settleJob behavior are unchanged.
    const windowsOwned = process.platform === "win32" && job.ownership && job.proc.pid !== undefined;
    const verdict = windowsOwned
      ? ownershipVerdict(job.ownership!.markerPath, processIsAlive(job.proc.pid), processIsAlive, job.shellRoute)
      : undefined;
    const action = shellCompletionAction({ confirmedExit, verdict });
    const intent = shellIntentAction({ confirmedExit, verdict });
    if (job.exited) {
      // A confirmed close that arrives after an earlier error/abort still
      // settles telemetry even though the ordinary record is already settled.
      if (action === "release") releaseOwnedShellActivity(job);
      // The job is already settled: activity intent can only be released here,
      // never re-acquired from a late partial signal.
      if (intent === "stopped") observeShellIntent(job, "stopped");
      return;
    }
    // Activity intent is judged independently of ownership: a retained cleanup
    // obligation must not keep it positive, and unverifiable ownership is
    // UNKNOWN, never a fabricated stop or an invented liveness.
    observeShellIntent(job, intent);
    if (windowsOwned && verdict !== "clear") {
      job.ownershipUnverifiable = verdict === "unverifiable";
      scheduleOwnershipRelease(pi, job, code ?? 0);
      return;
    }
    // An error alone (`confirmedExit` false) retains ownership as positive
    // outstanding; only an actual close (or the verified ownership verdict)
    // releases it.
    if (action === "release") releaseOwnedShellActivity(job);
    settleJob(pi, job, code ?? 0);
  };
  job.proc.on("exit", (code) => {
    observeShellRootExit(job);
    if (process.platform === "win32" && job.ownership) scheduleAcknowledgedSettlement(pi, job, code ?? 0);
  });
  job.proc.on("close", (code) => finish(code ?? 0, true));
  job.proc.on("error", (err) => {
    job.buffer.push(`[spawn error] ${String((err as Error)?.message ?? err)}`);
    finish(-1, false);
  });
}

/** Stall detection is the one rule that needs a clock, because "nothing
 *  happened" produces no event to react to. It runs on a single shared
 *  interval for all jobs rather than a timer per job, and fires at most once
 *  per quiet period. */
function ensureStallTimer(pi: BackgroundShellHost): void {
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.exited) continue;
      const event = evaluateSilence(job.rules, job.wake, job.lastOutputAt, now);
      if (!event) continue;
      if (now - job.wake.lastWakeAt < MIN_WAKE_INTERVAL_MS) continue;
      job.wake.stallNotified = true;
      deliverWake(pi, job, event, now);
    }
  }, STALL_TICK_MS);
  // Never hold the process open on our account.
  (stallTimer as any).unref?.();
}

/**
 * Signal the job's whole process group, not just the shell we spawned.
 * `python train.py` runs as a grandchild under that shell, so killing only the
 * shell would leave the process actually holding the GPU running.
 */
function signalGroup(job: Job, sig: NodeJS.Signals): void {
  const pid = job.proc.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // Windows has no process groups and no portable signals: the stop file is
    // the request, and the owning watchdog terminates the whole job object on
    // its next poll — reaching descendants that outlived the shell root. It
    // never targets a pid: after the root exits that pid may identify an
    // unrelated process. There is no weaker stage to escalate from, so `sig`
    // carries no meaning here.
    requestWindowsOwnershipStop(job.ownership);
    return;
  }
  try {
    process.kill(-pid, sig); // negative pid = the group (spawned detached)
  } catch {
    try {
      job.proc.kill(sig); // group already gone; fall back to the direct child
    } catch {
      /* already reaped */
    }
  }
}

function killJob(job: Job): void {
  signalGroup(job, "SIGTERM");
  // Same escalation as the sub-coder spawner, gated on real exit rather than
  // proc.killed — which Node sets on dispatch, making the old check unreachable
  // (PR #102). On Windows each retry just re-asserts the synchronous stop-file
  // request; the watchdog acts on it within one poll.
  scheduleForceKill(
    { kill: (s?: any) => { signalGroup(job, (s ?? "SIGKILL") as NodeJS.Signals); return true; } } as any,
    () => job.exited,
  );
}

/** Reap everything. A background job may outlive a turn, never the session. */
export function reapAll(): void {
  for (const job of jobs.values()) {
    if (job.pendingWake) clearTimeout(job.pendingWake);
    if (!job.exited) {
      // On Windows the host may re-raise its signal and exit right after this:
      // the stop-file request is synchronous, and the watchdog's parent-death
      // check (host pid gone) terminates each job object as the backstop.
      if (process.platform === "win32") {
        requestWindowsOwnershipStop(job.ownership);
      } else killJob(job);
    }
  }
  for (const timer of ownershipReleaseTimers.values()) clearInterval(timer);
  ownershipReleaseTimers.clear();
  // Acknowledgement watchers deliberately survive: see acknowledgementTimers.
  sessionGeneration += 1;
  jobs.clear();
  if (stallTimer) {
    clearInterval(stallTimer);
    stallTimer = null;
  }
}

/**
 * Reap on any way pi-review-gate can stop.
 *
 * `session_shutdown` covers the orderly path. The public signal-exit observer
 * handles supported fatal signals only when they are otherwise unowned; it
 * never replaces or redispatches listeners owned by the native host or other
 * extensions. When a host listener owns a signal, its normal shutdown event
 * continues to reap jobs. The observer callback is synchronous: POSIX groups
 * receive the existing TERM request, and Windows receives its synchronous
 * stop-file request. Neither this callback nor the ordinary `exit` fallback
 * can await escalation. Each job's existing parent/ownership watchdog remains
 * the backstop for work that outlives the host or cannot be reaped inline.
 *
 * Registered once per process. Returning no value from the observer preserves
 * signal-exit's normal signal handling, including the default disposition
 * when no other handler owns the signal.
 */
const CLEANUP_SIGNALS = new Set<string>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
let exitHooksInstalled = false;
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  process.on("exit", () => {
    // Synchronous only — no async work is allowed to run at this point. On
    // Windows that means the synchronous stop-file request; the watchdog's
    // parent-death check (host pid gone) terminates each job object as the
    // backstop once the host is actually gone.
    for (const job of jobs.values()) {
      if (job.exited) continue;
      if (process.platform === "win32") {
        requestWindowsOwnershipStop(job.ownership);
      } else signalGroup(job, "SIGTERM");
    }
  });

  onExit((_code, signal) => {
    if (signal && CLEANUP_SIGNALS.has(signal)) reapAll();
  });
}

function statusOf(job: Job): string {
  if (!job.exited) return job.ownershipUnverifiable ? "unverifiable" : "running";
  return job.exitCode === 0 ? "done" : `failed(${job.exitCode})`;
}

export function registerBackgroundShell(
  pi: BackgroundShellHost,
  submittedFingerprintFor?: SubmittedToolCallFingerprint,
  onNativeToolError?: (toolCallId: string, toolName: string) => void,
): BackgroundShellController {
  const registerTool = (tool: BackgroundShellTool): void => {
    const execute = tool.execute;
    pi.registerTool({
      ...tool,
      execute: async (...args: Parameters<BackgroundShellTool["execute"]>) => {
        const result = await execute(...args);
        if (result.isError === true) onNativeToolError?.(args[0], tool.name);
        return result;
      },
    });
  };

  registerTool({
    name: BACKGROUND_SHELL_TOOL_NAMES.start,
    label: "ShellStart",
    description:
      "Start a long-running command in the background and return immediately. The command runs in " +
      "this platform's fixed shell — Bash on macOS/Linux, PowerShell on Windows (pwsh when available, " +
      "otherwise Windows PowerShell; there is no shell selection) — so write it in that shell's " +
      "syntax. Use this instead of the foreground shell tool for anything that takes minutes " +
      "(training, builds, installs, servers, watchers). Declare what is worth interrupting you for " +
      "in wake_on; you will be told automatically when it happens, so there is no need to poll " +
      "the job in a loop. Check its status when you need the output or a decision, and keep the " +
      "foreground available for other work.",
    parameters: objectSchema({
      command: stringSchema("Shell command to run in the background"),
      label: stringSchema("Short name for this job, e.g. 'finetune'"),
      wake_on: objectSchema({
        exit: { type: "boolean", description: "Wake when it exits (default true)" },
        match: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description: "Regex or literal text worth waking for, e.g. ['Traceback','val_loss=']",
        },
        silence: stringSchema("Wake if it goes quiet this long after producing output, e.g. '10m'"),
        every_n_matches: integerSchema("Only wake on every Nth match, to throttle a chatty pattern"),
      }),
    }, ["command"]),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const startCallFingerprint = submittedFingerprintFor
        ? submittedFingerprintFor(toolCallId, "ShellStart")
        : toolCallFingerprint("ShellStart", params);
      if (!isToolCallFingerprint(startCallFingerprint)) {
        return errorResult("Error: the submitted ShellStart identity could not be verified; no job was started.");
      }
      const command = String(params.command ?? "").trim();
      if (!command) return errorResult("Error: command is required");

      const live = [...jobs.values()].filter((j) => !j.exited).length;
      if (live >= MAX_JOBS) {
        return errorResult(
          `Error: ${live} background jobs already running (max ${MAX_JOBS}). Stop one with ShellStop first.`,
        );
      }

      const id = nextId();
      const label = truncateText(
        String(params.label ?? "").trim() || truncateText(command.split(/\s+/)[0] || id, MAX_LABEL_CHARS),
        MAX_LABEL_CHARS,
      );
      const rules = params.wake_on ? normalizeRules(params.wake_on) : { ...DEFAULT_RULES };

      let proc: ChildProcess;
      let ownership: BackgroundJobOwnership | undefined;
      let shellSelection: WindowsShellSelection | undefined;
      try {
        // Fixed platform shell (#99): /bin/bash on macOS/Linux in its own
        // detached process group (the in-job watchdog takes the whole tree down
        // with `kill -TERM 0`), PowerShell on Windows via pwsh/powershell.exe,
        // where the wrapper additionally hands the whole tree to a job object
        // owned by a per-job watchdog that outlives the shell root. A missing
        // PowerShell fails HERE, before any job is started. A `python train.py`
        // under the shell is a grandchild — killing only the shell would orphan
        // the thing actually holding the GPU, which is why stop/shutdown/
        // watchdog all take the whole tree down.
        // Windows shell selection (#800) runs no candidate: ordinary
        // PowerShell 7 first, then Store/MSIX PowerShell 7 on its launcher
        // route, then Windows PowerShell 5.1. Its bounded `where` lookups run
        // asynchronously so discovery never blocks the host's event loop
        // (other jobs' output, wakes, stops, and cancellation keep flowing).
        // Everything that can change during that wait is re-checked before
        // the spawn, and nothing is awaited between the re-checks and the
        // synchronous spawn + registration: a cancelled call, a session change
        // (reapAll), or a start that would now exceed MAX_JOBS never spawns.
        if (_signal?.aborted) return errorResult("ShellStart was cancelled before the job started.");
        let selection: WindowsShellSelection | undefined;
        if (process.platform === "win32") {
          const generation = sessionGeneration;
          selection = await selectWindowsPowerShellForJobsAsync();
          if (_signal?.aborted) return errorResult("ShellStart was cancelled before the job started.");
          if (generation !== sessionGeneration) {
            return errorResult("ShellStart was superseded by a session change before the job started; no job was started.");
          }
          const liveNow = [...jobs.values()].filter((j) => !j.exited).length;
          if (liveNow >= MAX_JOBS) {
            return errorResult(
              `Error: ${liveNow} background jobs already running (max ${MAX_JOBS}). Stop one with ShellStop first.`,
            );
          }
        }
        const spawned = spawnBackgroundJob(command, process.pid, 5, selection);
        proc = spawned.proc;
        ownership = spawned.ownership;
        shellSelection = spawned.shellSelection;
      } catch (e) {
        return errorResult(`Error: could not start job: ${(e as Error)?.message ?? e}`);
      }

      const job: Job = {
        id,
        startCallFingerprint,
        label,
        command,
        proc,
        buffer: new LineBuffer(),
        matchers: compileMatchers(rules.match),
        rules,
        wake: { matchCount: 0, lastWakeAt: 0, stallNotified: false },
        startedAt: Date.now(),
        lastOutputAt: null,
        exited: false,
        pending: new PendingLineBuffer(),
        ownership,
        ...(shellSelection ? { shellRoute: shellSelection.route } : {}),
      };
      jobs.set(id, job);
      // Owned-work observation: positive ownership starts here and is released
      // only after independently confirmed settlement (an actual close, or the
      // Windows ownership verdict proving the tree gone) — never by reapAll()'s
      // map clear and never by a bare ChildProcess error. Activity intent starts
      // positive here too and is released the moment the process work is
      // observed stopped, independently of any retained cleanup obligation. The
      // unsettled ledger mirrors both until confirmed settlement so a reaped
      // job's tokens survive the `jobs` map clear.
      const ownedToken = ownedActivityToken(job);
      shellOwnedActivity?.acquire(ownedToken);
      shellOwnedActivity?.acquireIntent(ownedToken);
      unsettledShellJobs.set(ownedToken, { job, intentHeld: true });
      publishLifecycle("started", job);
      attachStreams(pi, job);
      ensureStallTimer(pi);
      installExitHooks();
      setIndicator(_ctx);

      const watchingSummary = describeWakeRules(rules);

      return textResult(
        `Started "${label}" as ${id} (pid ${proc.pid ?? "?"}); currently running.\n` +
          `${describeContainmentSelection(shellSelection)}` +
          `Future wake triggers (not current events): ${watchingSummary || "nothing"}.\n` +
          `You will be notified automatically; there is no need to poll. A purposeful status read is fine.`,
        false,
        shellResultDetails("ShellStart", {
          event: "started",
          id,
          label,
          // Complete recorded command: the expanded card must show every line
          // beyond the legacy 512-character / 4-line preview cuts. The render
          // context's recorded call arguments remain the preferred source;
          // this is the untruncated fallback snapshot.
          command,
          // The job state at the moment this call returned — the card must
          // not claim any later completion without updated evidence.
          state: "running",
          pid: proc.pid,
          processGroupId: process.platform === "win32" ? undefined : proc.pid,
          // Windows ownership record path (job-object watchdog): the harness
          // readiness tracker keys off it to keep a root-exited job's
          // descendants accounted for until verified gone.
          ...(ownership ? { ownershipMarker: ownership.markerPath } : {}),
          // The route chosen at launch, so readiness validates the record as a
          // Store record whatever its text claims (#800).
          ...(ownership && shellSelection?.route === "msix" ? { ownershipRoute: "msix" } : {}),
          watching: watchingSummary,
          startedAt: Date.now(),
        }),
      );
    },
    renderResult: expandableResult(shellStartCollapsedView, renderShellStartResult),
  });

  registerTool({
    name: BACKGROUND_SHELL_TOOL_NAMES.list,
    label: "ShellList",
    description: "List background jobs with their status, runtime, and what they are watched for.",
    parameters: objectSchema({}),
    async execute() {
      if (jobs.size === 0) {
        return textResult("No background jobs.", false, shellResultDetails("ShellList", { jobs: [] }));
      }
      const now = Date.now();
      const jobsDetail = [...jobs.values()].map((j) => ({
        id: j.id,
        label: j.label,
        status: statusOf(j),
        ...(j.exited ? { exitCode: j.exitCode } : {}),
        pid: j.proc.pid,
        processGroupId: process.platform === "win32" ? undefined : j.proc.pid,
        // Complete recorded command, captured with the snapshot: expansion
        // renders it from this returned snapshot, never via a live lookup.
        command: j.command,
        watching: describeWakeRules(j.rules),
        totalLines: j.buffer.total,
        droppedCount: j.buffer.droppedCount,
        elapsedMs: (j.endedAt ?? now) - j.startedAt,
        lastOutputAgoMs: j.lastOutputAt === null ? null : Math.max(0, now - j.lastOutputAt),
      }));
      const rows = jobsDetail.map((j) => {
        const el = formatElapsed(j.elapsedMs);
        const quiet = j.lastOutputAgoMs === null ? "never" : formatElapsed(j.lastOutputAgoMs);
        return `${j.id}  ${j.status.padEnd(10)}  ${el.padStart(7)}  last output ${quiet} ago  ${j.totalLines} lines  "${j.label}"`;
      });
      return textResult(rows.join("\n"), false, shellResultDetails("ShellList", { jobs: jobsDetail }));
    },
    renderResult: expandableResult(shellListCollapsedView, renderShellListResult),
  });

  registerTool({
    name: BACKGROUND_SHELL_TOOL_NAMES.log,
    label: "ShellLog",
    description:
      "Read a slice of a background job's output. Defaults to the last 60 lines. Use offset to page " +
      "forward through a long log rather than pulling all of it into context.",
    parameters: objectSchema({
      id: stringSchema("Job id from ShellStart / ShellList"),
      lines: integerSchema("How many lines (default 60, max 400)"),
      offset: integerSchema("Absolute line offset; omit for the tail"),
    }, ["id"]),
    async execute(_id, params) {
      const job = jobs.get(String(params.id ?? ""));
      if (!job) return errorResult(`Error: no such job "${params.id}"`);
      const want = Math.max(1, Math.min(Number(params.lines ?? 60), 400));

      const render = (lines: string[], header: string): string => {
        // Per-line and total bounds; line counts and offsets are untouched, so
        // paging semantics survive even when long lines are cut.
        let text = [header, "```", ...lines.map((l) => truncateText(l, MAX_LOG_LINE_CHARS)), "```"]
          .join("\n");
        return truncateText(text, MAX_LOG_RESULT_CHARS);
      };

      const baseDetails = (lines: string[]) =>
        shellResultDetails("ShellLog", {
          id: job.id,
          label: job.label,
          status: statusOf(job),
          ...(job.exited ? { exitCode: job.exitCode } : {}),
          totalLines: job.buffer.total,
          droppedLines: job.buffer.droppedCount,
          lines: lines.length,
          // Request selectors as actually received, for the expanded view's
          // Request block: offset null = the tail default was used.
          requestOffset: params.offset === undefined ? null : Number(params.offset),
          requestLimit: want,
        });

      if (params.offset === undefined) {
        const lines = job.buffer.tail(want);
        const header = `${job.id} "${job.label}" ${statusOf(job)} · ${job.buffer.total} lines total`;
        return textResult(render(lines, header), false, {
          ...baseDetails(lines),
          from: Math.max(0, job.buffer.total - lines.length),
          nextOffset: job.buffer.total,
        });
      }
      const { lines, from, nextOffset } = job.buffer.slice(Number(params.offset), want);
      const header =
        `${job.id} "${job.label}" ${statusOf(job)} · lines ${from}–${nextOffset} of ${job.buffer.total}` +
        (job.buffer.droppedCount > 0 ? ` (${job.buffer.droppedCount} oldest dropped)` : "");
      return textResult(render(lines, header), false, {
        ...baseDetails(lines),
        from,
        nextOffset,
      });
    },
    renderResult: expandableResult(shellLogCollapsedView, renderShellLogResult),
  });

  registerTool({
    name: BACKGROUND_SHELL_TOOL_NAMES.send,
    label: "ShellSend",
    description:
      "Write a line to a running background job's stdin — for a REPL, or an installer that asks a " +
      "question. A newline is appended unless you end the text with one.",
    parameters: objectSchema({
      id: stringSchema("Job id"),
      text: stringSchema("Text to write to stdin"),
    }, ["id", "text"]),
    async execute(_id, params) {
      const job = jobs.get(String(params.id ?? ""));
      if (!job) return errorResult(`Error: no such job "${params.id}"`);
      // A recorded stdin failure (EPIPE from an earlier write) is the more
      // precise answer for a retry, so it wins over the exit flag. Otherwise an
      // exited job keeps the definitive "already exited" message: Node destroys
      // the child's stdin handle in its own exit handler (before our 'close'
      // driven finish()), so without this guard every exited job would trip the
      // dead-stream precheck and get a spurious [stdin error] note.
      const exited = job.exited || job.proc.exitCode !== null || job.proc.signalCode !== null;
      if (exited && !job.stdinDead) return errorResult(`Error: job ${job.id} has already exited`);
      if (stdinIsDead(job)) {
        const reason = recordStdinFailure(job, job.stdinError ?? "closed");
        return errorResult(
          `Error: stdin for ${job.id} is no longer writable (${reason}) — the job likely exited or ` +
            `closed its input. Check ShellLog/ShellList, and use ShellStop if it needs cleaning up.`,
          { kind: "pi-review-bg-shell", tool: "ShellSend", event: "stdin-closed", id: job.id },
        );
      }
      const text = String(params.text ?? "");
      const payload = text.endsWith("\n") ? text : `${text}\n`;
      const stdin = job.proc.stdin!;
      // Wait briefly for the write callback: a child that exits mid-write makes
      // the flush fail with EPIPE, which surfaces HERE (as a controlled result)
      // rather than as an unhandled 'error' event on the stdin stream. If the
      // callback has not fired within the window (payload larger than the pipe
      // buffer that the child is not reading), report delivery as UNCONFIRMED —
      // never as written — and leave any later failure to the stdin 'error'
      // listener via recordStdinFailure.
      const outcome = await new Promise<{ flushed: boolean; error?: string }>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          resolve({ flushed: false });
        }, WRITE_FLUSH_TIMEOUT_MS);
        (timer as any).unref?.();
        try {
          stdin.write(payload, (err: NodeJS.ErrnoException | null | undefined) => {
            if (done) return; // timeout already resolved; listener records the failure
            done = true;
            clearTimeout(timer);
            if (err) resolve({ flushed: false, error: err.code || err.message || "stdin write failed" });
            else resolve({ flushed: true });
          });
        } catch (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const err = e as NodeJS.ErrnoException;
          resolve({ flushed: false, error: err.code || err.message || "stdin write failed" });
        }
      });
      if (outcome.error) {
        const reason = recordStdinFailure(job, outcome.error);
        return errorResult(
          `Error: write to ${job.id} stdin failed (${reason}). The job likely exited mid-write; ` +
            `check ShellLog/ShellList, and use ShellStop if it needs cleaning up.`,
          { kind: "pi-review-bg-shell", tool: "ShellSend", event: "stdin-write-failed", id: job.id },
        );
      }
      if (!outcome.flushed) {
        // The callback never fired inside the window — the bytes are queued in
        // Node's internal buffer, not yet in the pipe. Never claim success.
        return textResult(
          `Queued ${payload.length} bytes to ${job.id} stdin, but delivery was NOT confirmed within ` +
            `1.5s (the child may not be reading; the write may be lost if the job exits soon). ` +
            `Check ShellLog, and resend if the data never arrives.`,
          false,
          shellResultDetails("ShellSend", {
            event: "stdin-write-unconfirmed",
            id: job.id,
            bytes: payload.length,
            delivery: "unconfirmed",
          }),
        );
      }
      return textResult(
        `Wrote ${payload.length} bytes to ${job.id} stdin.`,
        false,
        shellResultDetails("ShellSend", {
          id: job.id,
          label: job.label,
          bytes: payload.length,
          delivery: "confirmed",
        }),
      );
    },
    renderResult: expandableResult(shellSendCollapsedView, renderShellSendResult),
  });

  registerTool({
    name: BACKGROUND_SHELL_TOOL_NAMES.stop,
    label: "ShellStop",
    description:
      "Stop a background job by exact job ID or unique label. Terminates the job's whole process tree " +
      "(SIGTERM, then SIGKILL if it ignores that, on macOS/Linux; forced tree kill on Windows).",
    parameters: objectSchema({
      id: stringSchema("Exact job ID, unique label, or 'all'"),
    }, ["id"]),
    async execute(_id, params) {
      const target = String(params.id ?? "");
      if (target === "all") {
        // Snapshot the affected targets BEFORE signalling, and retain them on
        // the result: the canonical stop-all card must show the actual jobs
        // addressed by this call, not a later re-derivation, and "stopping"
        // must not be reported as confirmed termination.
        const targets = [...jobs.values()]
          .filter((j) => !j.exited)
          .map((j) => ({ id: j.id, label: j.label }));
        const n = targets.length;
        for (const { id } of targets) {
          const job = jobs.get(id);
          if (job && !job.exited) killJob(job);
        }
        const storeRoute = targets.some(({ id }) => jobs.get(id)?.shellRoute === "msix");
        return textResult(`Stopping ${n} job(s).${storeRoute ? STORE_STOP_SCOPE : ""}`, false, shellResultDetails("ShellStop", {
          target: "all",
          count: n,
          outcome: "stopping",
          targets,
        }));
      }
      const resolved = resolveJob(target);
      if (resolved.error) return resolved.error;
      const job = resolved.job!;
      if (job.exited) {
        return textResult(
          `Job ${job.id} had already exited (${statusOf(job)}).`,
          false,
          shellResultDetails("ShellStop", {
            target,
            jobId: job.id,
            label: job.label,
            status: statusOf(job),
            outcome: "already-exited",
          }),
        );
      }
      killJob(job);
      return textResult(
        `Stopping ${job.id} ("${job.label}").${describeStopScope(job)}`,
        false,
        shellResultDetails("ShellStop", {
          target,
          jobId: job.id,
          label: job.label,
          outcome: "stopping",
        }),
      );
    },
    renderResult: expandableResult(shellStopCollapsedView, renderShellStopResult),
  });

  // The injected custom wake message records that an exit completion reached
  // the transcript; a later normal assistant response records that the owning
  // session's model consumed it (see observeWakeDelivery /
  // consumeInjectedExitWakes). Wakes are not held for an active run (#452):
  // steering delivers them at Pi's next supported boundary.
  pi.on("message_start", (event) => observeWakeDelivery(event));
  pi.on("message_end", (event) => consumeInjectedExitWakes(event));
  pi.on("agent_settled", () => {
    resendUnobservedExitWakes(pi);
  });

  // A job may outlive a turn; it must never outlive the session.
  pi.on("session_shutdown", async () => {
    reapAll();
    setIndicator();
  });
  pi.on("session_start", async (_event, ctx) => {
    reapAll();
    installExitHooks();
    setIndicator(ctx);
  });

  // Keep the running-jobs line ticking while jobs are alive, so the elapsed
  // times under the input stay honest. Cheap: one shared timer, and it repaints
  // only while something is actually running.
  const tick = setInterval(() => {
    if (runningJobs().length > 0) setIndicator();
  }, 5_000);
  (tick as any).unref?.();
  return controller;
}

/** One bounded, user-facing line describing the Store/MSIX route (#800).
 *  Empty on the ordinary route, so a host with an unpackaged PowerShell 7 (or
 *  only Windows PowerShell 5.1) sees no change in the tool result. */
function describeContainmentSelection(selection: WindowsShellSelection | undefined): string {
  if (!selection || selection.route !== "msix") return "";
  return (
    "Shell: Store (MSIX) PowerShell 7 — no unpackaged PowerShell 7 was found. The command runs in a Store PowerShell " +
    "launched suspended inside this job's job object with the desktop-app launch policy, so processes it creates stay " +
    "in the job and ShellStop terminates them. A nested Store app activation can still start processes outside the " +
    "job object; those are not tracked, stopped, or reported. If that launch cannot be set up, the job fails before " +
    "the command runs and is not retried on another shell.\n"
  );
}

/** Appended to a ShellStop result that addresses a Store/MSIX job (#800). */
const STORE_STOP_SCOPE =
  " Store PowerShell route: the stop terminates every process in the job object and settles once the job is verified " +
  "empty; processes a nested Store app activation started outside the job object are not reached or claimed.";

function describeStopScope(job: Job): string {
  return job.shellRoute === "msix" ? STORE_STOP_SCOPE : "";
}

export default registerBackgroundShell;
