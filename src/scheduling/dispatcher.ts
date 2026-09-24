/**
 * Process-local scheduled-execution timer runtime (issue #26).
 *
 * The runtime samples the host's ACTUAL local wall clock once per distinct
 * absolute minute and dispatches every enabled entry whose expression matches
 * that sampled minute, directly through the existing background subtask
 * infrastructure (the onDue hook) — no model or orchestrator launch turn. Each
 * dispatch carries the exact sampled due minute, so overlap skips and failure
 * wakes report the scheduled occurrence, not the wall-clock dispatch instant.
 * Entries dispatch independently: a slow start of one entry never serializes
 * another's due dispatch, while per-entry chains keep same-entry occurrences
 * from double-starting. It is deliberately future-only:
 *
 * - Starting, re-enabling, or replanning marks the in-progress minute as
 *   already sampled, so the first possible dispatch is the next full minute.
 * - The sampler never iterates between its last sampled minute and now: a
 *   host sleep, process off-time, or disabled entry produces no catch-up.
 * - Each absolute minute is sampled at most once (bounded memory), which also
 *   defines daylight-saving behavior over the real host clock: nonexistent
 *   spring-forward local minutes are never observed, so they are missed; a
 *   repeated fall-back local minute is observed at each distinct absolute due
 *   minute, so it fires once per pass.
 * - A queued occurrence is bound to the generation and entry definition it was
 *   sampled under. Every disarm (switch Off, detach, Save/replan — re-enabling
 *   replans too) advances the generation, so an occurrence that waited behind
 *   a same-entry start across any of those boundaries is dropped at admission:
 *   it can never start on re-enable/reload or execute an edited definition.
 * - An admission that lands past the occurrence's own due minute is handed to
 *   the hook flagged as overdue: the hook reports it (an overlap skip wake with
 *   the active handles when a run of the entry is active, otherwise a bounded
 *   not-run report) and never launches a catch-up run.
 *
 * The live switch (src/scheduling/runtime.ts) drives start/stop through a real
 * setter contract: the runtime subscribes once and reacts synchronously to
 * setEnabled(). Disabling stops future dispatch only — active subtasks keep
 * running under the controller's own recovery semantics, and process exit
 * relies on that same existing recovery rather than any guaranteed
 * notification to an exited process.
 */
import type { ScheduledTaskCatalog, ScheduledTaskEntryConfig } from "../config";
import { parseCronExpression, cronMatchesLocalDate, type ParsedCronExpression } from "./cron";
import type { SchedulerRuntimeHolder } from "./runtime";

const MINUTE_MS = 60_000;
/** Default tick cadence: a dispatch lands within this window after its minute. */
export const DEFAULT_SCHEDULER_TICK_INTERVAL_MS = 15_000;
/** Sampled minutes are remembered long enough to absorb clock wobble and DST. */
const SAMPLED_MINUTE_MEMORY_MS = 48 * 60 * MINUTE_MS;

export interface CronMinuteSamplerEntry {
  id: string;
  enabled: boolean;
  cron: ParsedCronExpression;
}

/**
 * The result of sampling one newly observed absolute minute: its exact start
 * (the due time every dispatch for that minute reports) and the enabled entry
 * ids whose expression matches it.
 */
export interface SampledDueMinute {
  /** Absolute epoch ms of the sampled minute's start (seconds and ms are zero). */
  minuteMs: number;
  /** Enabled entry ids due at this minute, in catalog order (may be empty). */
  dueIds: readonly string[];
}

/**
 * Pure per-minute sampler. Callers feed it the actual host clock; it returns
 * the sampled minute and the ids due at a newly observed absolute minute and
 * never more than once per absolute minute, regardless of how often tick() is
 * called or how far the clock jumped forward.
 */
/**
 * Maps an absolute instant to the local wall-clock date the host would show
 * at that instant. Injectable so tests can simulate DST transitions without
 * depending on the test host's timezone; production always uses the real host
 * clock — the entire DST policy falls out of this sampling, not of any
 * fire-time computation.
 */
export type LocalDateOf = (nowMs: number) => Date;

export interface CronMinuteSamplerOptions {
  /** Injectable wall-clock interpretation for DST simulation; defaults to the host local time. */
  localDateOf?: LocalDateOf;
}

export class CronMinuteSampler {
  private readonly sampled = new Map<number, true>();
  private readonly localDateOf: LocalDateOf;

  constructor(options: CronMinuteSamplerOptions = {}) {
    this.localDateOf = options.localDateOf ?? ((ms) => new Date(ms));
  }

  /** Mark the in-progress minute as already sampled (future-only start/replan). */
  beginAt(nowMs: number): void {
    this.prune(nowMs);
    this.sampled.set(this.absoluteMinuteOf(nowMs), true);
  }

  /** Sample a newly observed absolute minute; undefined when already sampled. */
  sampleMinute(nowMs: number, entries: readonly CronMinuteSamplerEntry[]): SampledDueMinute | undefined {
    const minute = this.absoluteMinuteOf(nowMs);
    if (this.sampled.has(minute)) return undefined;
    this.prune(minute);
    this.sampled.set(minute, true);
    const date = this.localDateOf(minute);
    return {
      minuteMs: minute,
      dueIds: entries.filter((entry) => entry.enabled && cronMatchesLocalDate(entry.cron, date)).map((entry) => entry.id),
    };
  }

  private absoluteMinuteOf(nowMs: number): number {
    return Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - SAMPLED_MINUTE_MEMORY_MS;
    for (const minute of this.sampled.keys()) {
      if (minute < cutoff) this.sampled.delete(minute);
    }
  }
}

export interface ScheduledTaskRuntimeOptions {
  /** The live process-local switch holder; changes are applied immediately. */
  switchState: SchedulerRuntimeHolder;
  /** Current in-memory scheduled-task catalog (always valid; recovery drops invalid entries). */
  catalog: () => ScheduledTaskCatalog | undefined;
  /**
   * Dispatch one due entry through the existing subtask execution path.
   * `dueAt` is the exact sampled due minute (never the dispatch instant).
   * `overdue` is true when admission was delayed past the occurrence's own
   * due minute (this entry's previous dispatch had not yet settled): the hook
   * must not launch a catch-up run — it reports the occurrence instead (an
   * overlap skip wake with the active handles when a run of the entry is
   * active, a bounded not-run report otherwise). May throw; rejections are
   * reported, never swallowed.
   */
  onDue: (
    entryId: string,
    entry: ScheduledTaskEntryConfig,
    dueAt: Date,
    overdue: boolean,
  ) => Promise<void> | void;
  /** Actionable reporting for dispatch or sampling failures. */
  onError?: (message: string) => void;
  /** Test-only clock injection; defaults to Date.now. */
  now?: () => number;
  /** Test-only tick cadence override. */
  tickIntervalMs?: number;
  /** Injectable wall-clock interpretation for DST simulation; defaults to the host local time. */
  localDateOf?: LocalDateOf;
}

/**
 * The per-process timer loop. attach() belongs to a session lifetime (the
 * orchestrator that receives the ordinary subtask notifications); detach()
 * stops the timers without touching active subtasks. replan() is the immediate
 * Save hook: it re-arms future-only sampling from the next minute boundary so
 * catalog edits take effect at the very next due occurrence with no replay of
 * missed times. Every disarm advances the dispatch generation, so occurrences
 * queued under an older generation (switch Off, detach, or a Save/replan —
 * including the replan an explicit re-enable performs) are dropped at
 * admission instead of starting stale or edited work.
 */
export class ScheduledTaskRuntime {
  private readonly sampler: CronMinuteSampler;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attached = false;
  private unsubscribed: (() => void) | undefined;
  /**
   * Per-entry dispatch chains. Distinct entries never wait on each other (no
   * global backlog across minute boundaries), while a same-entry due
   * occurrence is admitted only after the entry's previous dispatch settled,
   * so concurrent ticks can never start two runs of one entry. Settled chains
   * remove themselves from the map; a pending chain stays until it settles, so
   * same-entry serialization survives detach/re-attach.
   */
  private readonly inFlight = new Map<string, Promise<void>>();
  /**
   * Dispatch generation. Advanced by every disarm (switch Off, detach, and
   * Save/replan — the re-enable path replans too). A queued occurrence that
   * captured an older generation crossed a boundary while it waited behind a
   * same-entry start and is dropped at admission.
   */
  private generation = 0;
  /** Entries whose invalid cron was already reported since the last replan. */
  private readonly reportedInvalid = new Set<string>();

  constructor(private readonly options: ScheduledTaskRuntimeOptions) {
    this.sampler = new CronMinuteSampler({ localDateOf: options.localDateOf });
    this.now = options.now ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_SCHEDULER_TICK_INTERVAL_MS;
  }

  /** Arm timers for the current session if the switch is On. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.unsubscribed = this.options.switchState.subscribe((enabled) => {
      // Real setter contract: an explicit toggle stops or starts immediately.
      if (enabled) this.replan();
      else this.disarm();
    });
    if (this.options.switchState.enabled) this.arm();
  }

  /** Stop timers for the ending session; active subtasks are untouched. Idempotent. */
  detach(): void {
    this.disarm();
    this.attached = false;
    this.unsubscribed?.();
    this.unsubscribed = undefined;
  }

  /**
   * Immediate replan (Settings Save and explicit re-enable): future-only
   * sampling restarts from the next minute boundary against the current
   * catalog. Advances the generation either way, so occurrences queued before
   * the replan are dropped at admission; while Off or detached it re-arms
   * nothing. Always safe to call.
   */
  replan(): void {
    if (!this.attached) return;
    this.disarm();
    this.reportedInvalid.clear();
    if (this.options.switchState.enabled) this.arm();
  }

  /** True while the tick loop is armed. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  private arm(): void {
    this.sampler.beginAt(this.now());
    const tick = (): void => {
      this.timer = undefined;
      if (!this.attached) return;
      try {
        const sampled = this.sampleDueEntries();
        if (sampled) {
          const dueAt = new Date(sampled.minuteMs);
          for (const id of sampled.dueIds) {
            this.dispatchDue(id, dueAt);
          }
        }
      } catch (error) {
        this.reportError(`scheduled-task sampler tick failed: ${messageOf(error)}`);
      }
      if (this.attached && this.options.switchState.enabled) {
        this.timer = setTimeout(tick, this.tickIntervalMs);
        this.timer.unref?.();
      }
    };
    this.timer = setTimeout(tick, this.tickIntervalMs);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Every disarm is a temporal boundary: occurrences queued under the old
    // generation must not be admitted afterwards, whatever re-arms next.
    this.generation++;
  }

  private sampleDueEntries(): SampledDueMinute | undefined {
    const catalog = this.options.catalog();
    if (!catalog) return undefined;
    const entries: CronMinuteSamplerEntry[] = [];
    for (const [id, entry] of Object.entries(catalog)) {
      try {
        entries.push({ id, enabled: entry.enabled !== false, cron: parseCronExpression(entry.cron, `scheduledTasks.${id}.cron`) });
      } catch (error) {
        if (!this.reportedInvalid.has(id)) {
          this.reportedInvalid.add(id);
          this.reportError(`scheduled task ${id} has an invalid cron expression and will not run: ${messageOf(error)}`);
        }
        continue;
      }
    }
    return this.sampler.sampleMinute(this.now(), entries);
  }

  /**
   * Admit one due occurrence of one entry. The call is fire-and-forget with
   * respect to the tick loop (timers are never held by a slow start), but it
   * chains behind this entry's own previous dispatch so same-entry
   * occurrences cannot interleave; rejections fail closed through onError.
   * The occurrence captures its generation and a shallow copy of the entry
   * definition now, at sample time: a boundary crossed while it waits drops
   * it at admission, and it can never execute an edited definition. The
   * settled chain removes itself from inFlight without disturbing a newer
   * active one.
   */
  private dispatchDue(entryId: string, dueAt: Date): void {
    const sampled = this.options.catalog()?.[entryId];
    if (!sampled || sampled.enabled === false) return; // Removed or disabled at sample time.
    // Shallow-copy the definition as sampled so a queued occurrence can never
    // execute an edited definition even if a future catalog edit mutated the
    // entry in place (today entries are replaced, never mutated).
    const entry = { ...sampled };
    const generation = this.generation;
    const previous = this.inFlight.get(entryId) ?? Promise.resolve();
    const next = previous
      .then(() => this.dispatchEntry(entryId, entry, dueAt, generation))
      .catch((error: unknown) => {
        this.reportError(`scheduled task ${entryId} dispatch failed: ${messageOf(error)}`);
      })
      .finally(() => {
        // Tidy the settled chain without removing a newer active one.
        if (this.inFlight.get(entryId) === next) this.inFlight.delete(entryId);
      });
    this.inFlight.set(entryId, next);
  }

  private async dispatchEntry(
    entryId: string,
    entry: ScheduledTaskEntryConfig,
    dueAt: Date,
    generation: number,
  ): Promise<void> {
    // A boundary (switch Off, detach, or Save/replan) crossed since this
    // occurrence was sampled: drop it without admitting a run. It must never
    // start on re-enable/reload or execute an edited definition. Active
    // subtasks are untouched by the boundary — only not-yet-admitted starts stop.
    if (generation !== this.generation || !this.attached || !this.options.switchState.enabled) return;
    // Admission past the occurrence's own due minute: the hook reports it and
    // must not launch a catch-up run.
    const overdue = this.now() > dueAt.getTime() + MINUTE_MS;
    await this.options.onDue(entryId, entry, dueAt, overdue);
  }

  private reportError(message: string): void {
    try {
      this.options.onError?.(message);
    } catch {
      // Reporting must never take the loop down with it.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
