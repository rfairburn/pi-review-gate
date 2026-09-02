/*
 * Derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { scheduleForceKill } from "./process";
import { terminalColumns, truncateLineToWidth } from "./width";
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
  evaluateExit,
  evaluateMatch,
  evaluateSilence,
  formatElapsed,
  formatWakePayload,
  laneDelivery,
  normalizeRules,
  truncateText,
  wrapWithParentWatchdog,
  type JobMatchers,
  type JobWakeState,
  type WakeEvent,
  type WakeRules,
} from "./jobs";

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
// actually fire).
//
// Guarding: ShellStart hands a string to a shell. It is registered through the
// same Pi tool surface as the rest of this harness and remains subject to the
// caller's native --tools allowlist.

const MAX_JOBS = 8;
const STALL_TICK_MS = 30_000;

interface Job {
  id: string;
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
   * At most one nonurgent (match/milestone/silence) wake held internally
   * while the agent is active, instead of accumulating as queued Pi
   * followUps that would be delivered stale after a later exit. Delivered at
   * agent_settled only while the job is still running; an exit supersedes it.
   */
  heldWake?: { event: WakeEvent; count: number };
}

const jobs = new Map<string, Job>();
let seq = 0;
let stallTimer: ReturnType<typeof setInterval> | null = null;
let lifecycleRevision = 0;
const lifecycleListeners = new Set<(event: BackgroundShellLifecycleEvent) => void>();
/** Kept so the indicator can repaint from process events that carry no ctx. */
let uiCtx: any = null;

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

/** True while Pi reports an active agent run (agent_start … agent_settled).
 *  Nonurgent wakes arriving in this window are held internally instead of
 *  being queued into Pi, where they would pile up behind the busy agent and —
 *  if the job exits meanwhile — be delivered after the exit wake claiming the
 *  job is "still running". */
let agentRunActive = false;

/** Send a wake event to the agent through the lane its urgency earns. */
function sendWake(pi: BackgroundShellHost, job: Job, event: WakeEvent, now: number, coalescedCount: number): boolean {
  job.wake.lastWakeAt = now;
  const delivery = laneDelivery(event.lane);
  const reported = coalescedCount > 1
    ? { ...event, reason: `${event.reason} (coalesced ${coalescedCount} wake(s) while the agent was busy)` }
    : event;
  const payload = formatWakePayload({
    id: job.id,
    label: job.label,
    command: job.command,
    event: reported,
    elapsedMs: (job.endedAt ?? now) - job.startedAt,
    exitCode: event.kind === "exit" ? job.exitCode : undefined,
    lines: job.buffer.around(WAKE_CONTEXT_LINES),
    totalLines: job.buffer.total,
  });
  try {
    pi.sendMessage(
      { customType: "pi-review-bg-shell", content: payload, display: true, details: { id: job.id } },
      delivery as any,
    );
    return true;
  } catch {
    // A delivery mode can be rejected while pi is mid-transition. Losing a
    // status wake is survivable; throwing out of a process event handler is not.
    return false;
  }
}

/** Deliver a wake event, coalescing routine non-exit ones internally while the
 *  agent is active so they cannot accumulate in Pi and go stale. Exit wakes
 *  always supersede held status and go through while Pi is still streaming;
 *  Pi can then drain the exit follow-up before agent_settled. Urgent ("now")
 *  matches likewise go through immediately. */
function deliverWake(pi: BackgroundShellHost, job: Job, event: WakeEvent, now: number): boolean {
  const supersedesHeldWake = event.kind === "exit" || event.lane === "now";
  if (!supersedesHeldWake && agentRunActive) {
    const held = job.heldWake;
    if (held) {
      // Latest event wins: it describes the newest state of the job.
      held.event = event;
      held.count += 1;
    } else {
      job.heldWake = { event, count: 1 };
    }
    return true;
  }
  if (supersedesHeldWake) {
    // A completed job or newer urgent event makes routine status obsolete.
    job.heldWake = undefined;
  }
  return sendWake(pi, job, event, now, 1);
}

/** Release held routine wakes once Pi settles. Exit handling clears these
 *  synchronously, so an exited job can never emit a stale "still running"
 *  notification here. */
function flushHeldWakes(pi: BackgroundShellHost): void {
  for (const job of jobs.values()) {
    const held = job.heldWake;
    if (!held) continue;
    job.heldWake = undefined;
    if (job.exited) continue;
    sendWake(pi, job, held.event, Date.now(), held.count);
  }
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

  const finish = (code: number | null) => {
    if (job.exited) return;
    job.exited = true;
    job.exitCode = code;
    job.endedAt = Date.now();
    const remaining = job.pending.flush();
    if (remaining) {
      handleLine(pi, job, remaining);
    }
    // Drop any held match wake: the exit wake below says everything it would
    // have, and the exit code besides. A nonurgent wake held for the agent's
    // benefit is stale the instant the job exits — "still running" would be a
    // lie — so it goes too; if an exit notice is due it replaces it.
    if (job.pendingWake) {
      clearTimeout(job.pendingWake);
      job.pendingWake = undefined;
    }
    job.heldWake = undefined;
    setIndicator();
    const event = evaluateExit(code, job.rules);
    const exitWakeScheduled = event ? deliverWake(pi, job, event, Date.now()) : false;
    // reapAll() removes jobs before their asynchronous close callbacks arrive.
    // Such callbacks belong to a dead session and must not wake lifecycle
    // consumers in a newly started one.
    if (jobs.get(job.id) === job) publishLifecycle("settled", job, exitWakeScheduled);
  };
  job.proc.on("close", (code) => finish(code ?? 0));
  job.proc.on("error", (err) => {
    job.buffer.push(`[spawn error] ${String((err as Error)?.message ?? err)}`);
    finish(-1);
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
  // (PR #102).
  scheduleForceKill(
    { kill: (s?: any) => { signalGroup(job, (s ?? "SIGKILL") as NodeJS.Signals); return true; } } as any,
    () => job.exited,
  );
}

/** Reap everything. A background job may outlive a turn, never the session. */
export function reapAll(): void {
  agentRunActive = false;
  for (const job of jobs.values()) {
    if (job.pendingWake) clearTimeout(job.pendingWake);
    job.heldWake = undefined;
    if (!job.exited) killJob(job);
  }
  jobs.clear();
  if (stallTimer) {
    clearInterval(stallTimer);
    stallTimer = null;
  }
}

/**
 * Reap on any way pi-review-gate can stop.
 *
 * `session_shutdown` covers the orderly path. These cover the rest: ctrl+c,
 * `kill`, a closed terminal, a crash. SIGKILL cannot be caught by anyone, which
 * is exactly why each job also carries its own parent-watchdog (see
 * wrapWithParentWatchdog) — that is the backstop this cannot be.
 *
 * Registered once per process, and the handlers re-raise so we never change
 * pi-review-gate's own exit behaviour.
 */
let exitHooksInstalled = false;
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  process.on("exit", () => {
    // Synchronous only — no async work is allowed to run at this point.
    for (const job of jobs.values()) if (!job.exited) signalGroup(job, "SIGTERM");
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as NodeJS.Signals[]) {
    process.on(sig, () => {
      reapAll();
      // Re-raise with our handler removed so the default disposition applies
      // and our exit code matches what the signal would normally produce.
      process.removeAllListeners(sig);
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(1);
      }
    });
  }
}

function statusOf(job: Job): string {
  if (!job.exited) return "running";
  return job.exitCode === 0 ? "done" : `failed(${job.exitCode})`;
}

export function registerBackgroundShell(pi: BackgroundShellHost): BackgroundShellController {
  pi.registerTool({
    name: "ShellStart",
    label: "ShellStart",
    description:
      "Start a long-running command in the background and return immediately. Use this instead of " +
      "bash for anything that takes minutes (training, builds, installs, servers, watchers) — bash " +
      "blocks until the command exits. Declare what is worth interrupting you for in wake_on; you " +
      "will be told automatically when it happens, so do NOT poll the job in a loop.",
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
    async execute(_id, params, _signal, _onUpdate, _ctx) {
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
      try {
        // detached: its own process group, so the in-job watchdog can take the
        // whole tree down with `kill -TERM 0` without ever signalling
        // pi-review-gate, and so we can kill the group rather than just the shell
        // (a `python train.py` under bash is a grandchild — killing only the
        // shell would orphan the thing actually holding the GPU).
        proc = spawn(wrapWithParentWatchdog(command, process.pid), {
          shell: "/bin/bash",
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        return errorResult(`Error: could not start job: ${(e as Error)?.message ?? e}`);
      }

      const job: Job = {
        id,
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
      };
      jobs.set(id, job);
      publishLifecycle("started", job);
      attachStreams(pi, job);
      ensureStallTimer(pi);
      installExitHooks();
      setIndicator(_ctx);

      const watching = [
        rules.exit ? "exit" : null,
        rules.match.length > 0 ? `match ${rules.match.map((m) => JSON.stringify(m)).join(", ")}` : null,
        rules.silenceMs ? `silence ${formatElapsed(rules.silenceMs)}` : null,
        rules.everyNMatches ? `every ${rules.everyNMatches} matches` : null,
      ].filter(Boolean);

      return textResult(
        `Started "${label}" as ${id} (pid ${proc.pid ?? "?"}); currently running.\n` +
          `Future wake triggers (not current events): ${watching.join(", ") || "nothing"}.\n` +
          `You will be notified automatically; do not poll.`,
        false,
        {
          kind: "pi-review-bg-shell",
          event: "started",
          id,
          label,
          pid: proc.pid,
          processGroupId: process.platform === "win32" ? undefined : proc.pid,
        },
      );
    },
  });

  pi.registerTool({
    name: "ShellList",
    label: "ShellList",
    description: "List background jobs with their status, runtime, and what they are watched for.",
    parameters: objectSchema({}),
    async execute() {
      if (jobs.size === 0) return textResult("No background jobs.");
      const now = Date.now();
      const rows = [...jobs.values()].map((j) => {
        const el = formatElapsed((j.endedAt ?? now) - j.startedAt);
        const quiet = j.lastOutputAt ? formatElapsed(now - j.lastOutputAt) : "never";
        return `${j.id}  ${statusOf(j).padEnd(10)}  ${el.padStart(7)}  last output ${quiet} ago  ${j.buffer.total} lines  "${j.label}"`;
      });
      return textResult(rows.join("\n"));
    },
  });

  pi.registerTool({
    name: "ShellLog",
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

      if (params.offset === undefined) {
        const lines = job.buffer.tail(want);
        const header = `${job.id} "${job.label}" ${statusOf(job)} · ${job.buffer.total} lines total`;
        return textResult(render(lines, header));
      }
      const { lines, from, nextOffset } = job.buffer.slice(Number(params.offset), want);
      const header =
        `${job.id} "${job.label}" ${statusOf(job)} · lines ${from}–${nextOffset} of ${job.buffer.total}` +
        (job.buffer.droppedCount > 0 ? ` (${job.buffer.droppedCount} oldest dropped)` : "");
      return textResult(render(lines, header));
    },
  });

  pi.registerTool({
    name: "ShellSend",
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
          { kind: "pi-review-bg-shell", event: "stdin-closed", id: job.id },
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
          { kind: "pi-review-bg-shell", event: "stdin-write-failed", id: job.id },
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
          { kind: "pi-review-bg-shell", event: "stdin-write-unconfirmed", id: job.id },
        );
      }
      return textResult(`Wrote ${payload.length} bytes to ${job.id} stdin.`);
    },
  });

  pi.registerTool({
    name: "ShellStop",
    label: "ShellStop",
    description: "Stop a background job by exact job ID or unique label (SIGTERM, then SIGKILL if it ignores that).",
    parameters: objectSchema({
      id: stringSchema("Exact job ID, unique label, or 'all'"),
    }, ["id"]),
    async execute(_id, params) {
      const target = String(params.id ?? "");
      if (target === "all") {
        const n = [...jobs.values()].filter((j) => !j.exited).length;
        for (const job of jobs.values()) if (!job.exited) killJob(job);
        return textResult(`Stopping ${n} job(s).`);
      }
      const resolved = resolveJob(target);
      if (resolved.error) return resolved.error;
      const job = resolved.job!;
      if (job.exited) return textResult(`Job ${job.id} had already exited (${statusOf(job)}).`);
      killJob(job);
      return textResult(`Stopping ${job.id} ("${job.label}").`);
    },
  });

  // Track the agent's own lifecycle so nonurgent wakes can be held while the
  // model is busy and released exactly once it settles. Runtimes that never
  // emit these events keep today's immediate-delivery behaviour, because
  // agentRunActive simply stays false.
  pi.on("agent_start", () => {
    agentRunActive = true;
  });
  pi.on("agent_settled", () => {
    agentRunActive = false;
    flushHeldWakes(pi);
  });

  // A job may outlive a turn; it must never outlive the session.
  pi.on("session_shutdown", async () => {
    agentRunActive = false;
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

export default registerBackgroundShell;
