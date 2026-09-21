import { AsyncLocalStorage } from "node:async_hooks";
import { asError, throwIfAborted } from "./browser-primitives.js";

/**
 * Operation and deadline primitives for the interactive browser manager
 * (issue #153): the composite-promise deadline with external-signal
 * forwarding, bounded one-shot waits, async-local in-flight work tracking,
 * and the all-settled drain that keeps a rejected child from hiding
 * still-running sibling browser commands.
 */

// Async-local tracking keeps concurrent, separately owned sessions isolated.
export const operationWork = new AsyncLocalStorage<Set<Promise<unknown>>>();

/** Do not let a rejected child hide still-running sibling browser commands
 * from OperationDeadline's composite-promise tracking. The outer deadline can
 * still contain the browser and drain this group if a sibling never settles.
 */
export async function settleBrowserReads<const T extends readonly unknown[]>(operations: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}

export class OperationDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly timer: NodeJS.Timeout;
  private readonly externalSignal?: AbortSignal;
  private readonly onExternalAbort?: () => void;

  constructor(private readonly name: string, private readonly durationMs: number, externalSignal?: AbortSignal) {
    this.signal = this.controller.signal;
    this.deadlineAt = Date.now() + durationMs;
    this.timer = setTimeout(() => {
      this.controller.abort(new Error(`${name} exceeded its ${durationMs}ms total deadline.`));
    }, durationMs);
    this.timer.unref?.();
    if (externalSignal) {
      this.externalSignal = externalSignal;
      this.onExternalAbort = () => this.controller.abort(externalSignal.reason ?? new Error(`${name} cancelled.`));
      if (externalSignal.aborted) this.onExternalAbort();
      else externalSignal.addEventListener("abort", this.onExternalAbort, { once: true });
    }
  }

  remainingMs(): number {
    if (this.signal.aborted) throw asError(this.signal.reason);
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      const error = new Error(`${this.name} exceeded its ${this.durationMs}ms total deadline.`);
      this.controller.abort(error);
      throw error;
    }
    return remaining;
  }

  run<T>(operation: Promise<T>, phase: string): Promise<T> {
    // An expired approval prompt cannot dispatch: its permit is revoked by
    // the caller. It is not an in-flight browser command to drain.
    const pending = phase === "interactive confirmation" ? undefined : operationWork.getStore();
    pending?.add(operation);
    // Attach before checking the deadline: arguments are evaluated before run,
    // so a command may already have started even when remainingMs throws.
    void operation.then(() => pending?.delete(operation), () => pending?.delete(operation));
    this.remainingMs();
    return abortableOperation(operation, this.signal);
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.externalSignal && this.onExternalAbort) {
      this.externalSignal.removeEventListener("abort", this.onExternalAbort);
    }
  }
}

async function abortableOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(asError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  operation.catch(() => undefined);
  aborted.catch(() => undefined);
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

export async function within<T>(operation: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${timeoutMs}ms deadline.`)), timeoutMs);
    timer.unref?.();
    if (signal) {
      abortListener = () => reject(asError(signal.reason ?? new Error(`${label} cancelled.`)));
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  operation.catch(() => undefined);
  deadline.catch(() => undefined);
  try { return await Promise.race([operation, deadline]); }
  finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export async function boundedCleanup<T>(operation: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  return within(operation, deadlineMs, label);
}
