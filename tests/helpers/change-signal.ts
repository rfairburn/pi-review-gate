/**
 * The one shared bounded readiness signal used by the real-host harnesses.
 *
 * `tests/session-host-native-windows-harness.ts` (and through it the POSIX and
 * Windows launchers) and `tests/helpers/session-host-native-main-harness.ts`
 * all wait on the same two observation problems, so they share one reviewed
 * timing core instead of keeping divergent copies of it:
 *
 * - Readiness owned by an in-process state change (`onData`, `onExit`, a
 *   fixture callback) cannot be missed, so `waitFor` stays exactly
 *   notification-driven: one immediate evaluation, then evaluation only when
 *   `notify()` runs. Converting those waits would hide a genuine "no output" or
 *   "no exit" product fault.
 * - Readiness carried by a durable file - an appended JSONL record or a leaf
 *   the owned job creates - is re-read from disk on every evaluation, and its
 *   only live trigger is an `fs.watch` notification that can be coalesced or
 *   never delivered. `waitForRecheck` (and `waitForDurableReadyLeaf`, the same
 *   opt-in for a leaf that must appear) keeps the unchanged predicate, the
 *   single original absolute deadline, and the `notify()` fast path, while
 *   adding a bounded periodic re-evaluation and one final re-evaluation at the
 *   deadline, so an already-durable fact cannot stay unexamined merely because
 *   no notification arrived. Re-evaluation never resets, extends, or re-arms
 *   the deadline, and never turns a genuinely pending condition into success.
 *
 * The quiet witnesses below are the negative-witness half of the same class and
 * keep their existing notification-driven semantics verbatim: a quiet witness
 * asserts that nothing arrives in a bounded window, and its robustness against
 * a missed notification is a separate, deliberately unchanged limitation.
 */
import { existsSync } from "node:fs";

/**
 * Bounded periodic re-evaluation cadence for durable journal readiness waits.
 * It stays far below the harness event deadlines (tens of seconds), so a
 * coalesced or dropped watcher notification delays readiness by a small bound
 * only and never widens the absolute deadline.
 */
export const DURABLE_JOURNAL_RECHECK_INTERVAL_MS = 25;

export class ChangeSignal {
  private readonly listeners = new Set<() => void>();
  private unsettledWaiters = 0;

  /** Test-only accounting: waiters that have not settled yet. */
  get pendingWaiterCount(): number {
    return this.unsettledWaiters;
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Notification-driven wait: evaluates the predicate once immediately and
   * again only when `notify()` runs. That is exact for readiness owned by an
   * in-process state change whose signal cannot be missed; a durable file
   * append observed through `fs.watch` can be missed or coalesced, so journal
   * readiness uses `waitForRecheck` instead.
   */
  waitFor(predicate: () => boolean, timeoutMs: number, description: string, signal?: AbortSignal): Promise<void> {
    return this.wait(predicate, timeoutMs, description, signal, undefined);
  }

  /**
   * Durable-readiness wait: identical absolute deadline, abort, and predicate
   * exception semantics to `waitFor`, with notification-independent
   * observation points - an immediate evaluation, a bounded periodic
   * re-evaluation, and one final re-evaluation when the deadline expires - so a
   * predicate already satisfied by a durable record cannot stay unexamined
   * merely because a watcher notification never arrived. `notify()` remains the
   * fast path. Re-evaluation never resets, extends, or re-arms the single
   * absolute deadline, and a periodic tick never authorizes readiness after
   * that deadline has passed.
   */
  waitForRecheck(
    predicate: () => boolean,
    timeoutMs: number,
    description: string,
    signal?: AbortSignal,
    recheckIntervalMs: number = DURABLE_JOURNAL_RECHECK_INTERVAL_MS,
  ): Promise<void> {
    if (!Number.isFinite(recheckIntervalMs) || recheckIntervalMs <= 0) {
      return Promise.reject(new Error(`${description}: recheck interval must be a positive finite duration`));
    }
    return this.wait(predicate, timeoutMs, description, signal, recheckIntervalMs);
  }

  /**
   * Negative witness: succeeds only if `predicate` never becomes true before
   * `timeoutMs` elapses, and fails on the first notification that observes it.
   * Unchanged notification-driven semantics (see the module header).
   */
  waitForQuiet(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(check);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const check = (): void => {
        if (settled) return;
        try {
          if (predicate()) finish(new Error(`${description}: unexpected owned event`));
        } catch {
          finish(new Error(`${description}: bounded event predicate failed`));
        }
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  /**
   * Negative frame witness: succeeds once `quietMs` passes with no
   * notification, and fails if the overall deadline expires first. Unchanged
   * notification-driven semantics (see the module header).
   */
  waitForQuietPeriod(quietMs: number, timeoutMs: number, description: string): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        this.listeners.delete(restart);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const restart = (): void => {
        if (settled) return;
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), quietMs);
      };
      const deadlineTimer = setTimeout(() => finish(new Error(`${description}: deadline exceeded before quiet`)), timeoutMs);
      this.listeners.add(restart);
      restart();
    });
  }

  private wait(
    predicate: () => boolean,
    timeoutMs: number,
    description: string,
    signal: AbortSignal | undefined,
    recheckIntervalMs: number | undefined,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      let recheckTimer: NodeJS.Timeout | undefined;
      const deadlineAt = Date.now() + timeoutMs;
      this.unsettledWaiters += 1;
      const onAbort = (): void => finish(new Error(`${description}: cancelled before completion`));
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (recheckTimer !== undefined) clearInterval(recheckTimer);
        deadlineTimer = undefined;
        recheckTimer = undefined;
        this.listeners.delete(check);
        signal?.removeEventListener("abort", onAbort);
        this.unsettledWaiters -= 1;
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const evaluate = (): void => {
        if (settled) return;
        try {
          if (predicate()) finish();
        } catch {
          finish(new Error(`${description}: bounded event predicate failed`));
        }
      };
      const check = (): void => {
        evaluate();
      };
      if (signal?.aborted) {
        finish(new Error(`${description}: cancelled before completion`));
        return;
      }
      // Scheduled once: no re-evaluation path re-arms or extends this deadline.
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined;
        // Notification-independent final re-evaluation before rejecting. It is
        // opt-in with the periodic recheck so notification-only waits keep their
        // exact notification-only semantics.
        if (recheckIntervalMs !== undefined) evaluate();
        if (!settled) finish(new Error(`${description}: deadline exceeded`));
      }, timeoutMs);
      if (recheckIntervalMs !== undefined) {
        recheckTimer = setInterval(() => {
          // Periodic ticks never authorize readiness after the absolute
          // deadline; the deadline callback owns that final evaluation.
          if (Date.now() < deadlineAt) evaluate();
        }, recheckIntervalMs);
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.listeners.add(check);
      check();
    });
  }
}

/**
 * Positive durable-leaf readiness on the shared recheck core: the unchanged
 * "does the owned leaf exist yet" predicate, re-read from the filesystem on the
 * bounded cadence and once at the original absolute deadline, with the caller's
 * `fs.watch` notification kept as the fast path. A leaf created without any
 * delivered watcher event is therefore still observed; a leaf that never
 * appears still fails with the original deadline error, so nothing here
 * fabricates readiness. The caller keeps its own subsequent leaf validation.
 */
export function waitForDurableReadyLeaf(
  signal: ChangeSignal,
  readyPath: string,
  timeoutMs: number,
  description: string,
): Promise<void> {
  return signal.waitForRecheck(() => existsSync(readyPath), timeoutMs, description);
}
