/**
 * Dispatch-event fan-out for original SubtasksStart/SubtasksAdd tool cards
 * (#93).
 *
 * This registry carries NO truth data. The authoritative dispatch record lives
 * on the durable task record; this module only routes "an actual dispatch
 * happened for execution X" notifications to rendered tool rows so they can
 * invalidate themselves through Pi's native renderer context
 * (`context.invalidate()` → row rerender). No polling, no fetching, no extra
 * inspection: the row re-renders from the controller's in-memory task state.
 *
 * Retention is lifecycle-aware, never blind FIFO. An execution's listeners are
 * removed only when a dispatch event reports — through the settling check the
 * owning controller supplies with the notification — that EVERY task of that
 * execution is archivable (permanently terminal): such an execution cannot
 * produce further dispatch events for the cards that rendered it (tasks added
 * later belong to their own SubtasksAdd rows, which subscribe when they
 * render). An execution with any non-archivable task — including a card still
 * queued behind executor capacity or paused in a recoverable state that can be
 * continued and dispatch again — is never evicted, so a live original card
 * always receives its dispatch update no matter how many other executions
 * register. The steady-state map is therefore bounded by the executions that
 * can still dispatch plus archivable entries not yet swept by the next event;
 * listeners are deduplicated per rendered row (one listener per row), and
 * sweeping an archivable execution drops its whole entry, releasing every one
 * of its listeners at once. Unknown executions (other controllers, groups this
 * controller does not know) report `undefined` from the settling check and are
 * kept — eviction stays fail-safe.
 */

export interface DispatchCardNotification {
  executionId: string;
  taskId: string;
}

export type DispatchCardListener = (notification: DispatchCardNotification) => void;

/**
 * Settle probe supplied by the controller that emitted a notification:
 * `true` only when it knows the execution and every task in it has settled.
 * `false` or `undefined` (unknown execution, error) means "keep watching".
 */
export type DispatchCardSettledCheck = (executionId: string) => boolean | undefined;

const watched = new Map<string, Set<DispatchCardListener>>();

/**
 * Watch one execution for dispatch events. Returns an unsubscribe function.
 * The same (executionId, listener) pair is idempotent.
 */
export function watchDispatchCards(executionId: string, listener: DispatchCardListener): () => void {
  let set = watched.get(executionId);
  if (!set) {
    set = new Set();
    watched.set(executionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    // Only retire the entry when this closure still owns the live set: a
    // re-watched execution must keep its other watchers.
    if (set.size === 0 && watched.get(executionId) === set) {
      watched.delete(executionId);
    }
  };
}

/** Fan a dispatch event out to every rendered card watching the execution. */
export function notifyDispatchCards(
  executionId: string,
  taskId: string,
  isExecutionSettled?: DispatchCardSettledCheck,
): void {
  const set = watched.get(executionId);
  if (set && set.size > 0) {
    const notification: DispatchCardNotification = { executionId, taskId };
    for (const listener of [...set]) {
      try {
        listener(notification);
      } catch {
        // A failing row callback must never break the dispatch event path;
        // the durable record stays authoritative either way.
      }
    }
  }
  if (!isExecutionSettled) return;
  // Lifecycle-aware sweep: drop entries whose owner reports every task
  // archivable (permanently terminal). Recoverable or failed tasks can be
  // continued and dispatch again, so their cards keep watching. Entries
  // without a probe answer (unknown execution, error) stay — evicting a card
  // that can still dispatch would break the lifecycle contract, so doubt
  // always resolves to keeping the subscription.
  for (const candidate of [...watched.keys()]) {
    let settled: boolean | undefined;
    try {
      settled = isExecutionSettled(candidate);
    } catch {
      settled = undefined;
    }
    if (settled === true) watched.delete(candidate);
  }
}

/** Whether any rendered card currently watches the execution. */
export function hasDispatchCardWatcher(executionId: string): boolean {
  return watched.has(executionId);
}

/** Test seam: clear every watcher. */
export function resetDispatchCardsForTests(): void {
  watched.clear();
}
