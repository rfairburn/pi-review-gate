/**
 * Process-local scheduled-execution switch (issue #26).
 *
 * The switch is LIVE and CURRENT-PROCESS-ONLY: it is never persisted in the
 * config file and never becomes a shared default. A fresh process derives its
 * initial value exactly once from the scheduler launch flag (the launcher's
 * `--scheduler` exports PI_REVIEW_GATE_SCHEDULER); without the flag the
 * process starts Off. Inside one process the switch survives `/reload` — the
 * holder lives on globalThis under a well-known symbol so an extension reload
 * that re-instantiates module state still finds the same mutable object — and
 * only an explicit setEnabled() (the /review-settings row) changes it.
 *
 * The holder notifies subscribers synchronously on every change so the timer
 * runtime can stop or start immediately through a real setter contract; no
 * consumer polls the flag.
 */

/** Environment variable the launchers export for `--scheduler`. */
export const SCHEDULER_LAUNCH_FLAG_ENV = "PI_REVIEW_GATE_SCHEDULER";

/** The live switch as seen by the settings menu and the timer runtime. */
export interface SchedulerRuntimeSwitch {
  /** Current process-local On/Off state (read-only view). */
  readonly enabled: boolean;
  /** Apply a new state immediately; notifies subscribers synchronously. */
  setEnabled(next: boolean): void;
}

export interface SchedulerRuntimeHolder extends SchedulerRuntimeSwitch {
  enabled: boolean;
  listeners: Set<(enabled: boolean) => void>;
  subscribe(listener: (enabled: boolean) => void): () => void;
}

const HOLDER_KEY = Symbol.for("pi-review-gate.scheduled-task-runtime");

function globalHolderSlot(): Record<symbol, SchedulerRuntimeHolder | undefined> {
  return globalThis as unknown as Record<symbol, SchedulerRuntimeHolder | undefined>;
}

/** Same truthy values the extension uses for PI_REVIEW_GATE_* switches. */
export function schedulerLaunchFlagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[SCHEDULER_LAUNCH_FLAG_ENV];
  return value === "1" || value === "true" || value === "yes";
}

/**
 * The one process-local switch holder. The initial value is derived from the
 * launch flag exactly once per process (the first call wins); later calls —
 * including after a /reload re-activation — return the same holder with its
 * current state, so a live toggle is never reset by a reload and a changed
 * environment can never silently flip a running process.
 */
export function getSchedulerRuntime(): SchedulerRuntimeHolder {
  const slot = globalHolderSlot();
  const existing = slot[HOLDER_KEY];
  if (existing) return existing;
  const listeners = new Set<(enabled: boolean) => void>();
  const holder: SchedulerRuntimeHolder = {
    enabled: schedulerLaunchFlagEnabled(),
    listeners,
    setEnabled(next: boolean): void {
      if (holder.enabled === next) return;
      holder.enabled = next;
      for (const listener of [...listeners]) {
        try {
          listener(holder.enabled);
        } catch {
          // A failing subscriber must not block the switch or other
          // subscribers: the state change itself is authoritative.
        }
      }
    },
    subscribe(listener: (enabled: boolean) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  slot[HOLDER_KEY] = holder;
  return holder;
}

/**
 * @internal Test-only seam: discard the process-local holder so a test can
 * re-derive it from a controlled environment. Production code never resets
 * the switch mid-process.
 */
export function resetSchedulerRuntimeForTests(): void {
  delete globalHolderSlot()[HOLDER_KEY];
}
