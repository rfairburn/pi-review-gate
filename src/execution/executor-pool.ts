import type { ExecutorPoolEntry } from "../config";

export interface ExecutorPoolAssignment {
  readonly entry: ExecutorPoolEntry;
  readonly priority: number;
}

export interface ExecutorPoolLease extends ExecutorPoolAssignment {
  release(): void;
}

interface Waiter {
  startPriority: number;
  resolve: (lease: ExecutorPoolLease | undefined) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Ordered, capacity-aware leases for one execute_subtasks invocation. */
export class ExecutorPoolScheduler {
  private readonly running = new Map<string, number>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly entries: readonly ExecutorPoolEntry[]) {}

  tryAcquire(startPriority = 0): ExecutorPoolLease | undefined {
    for (let priority = Math.max(0, startPriority); priority < this.entries.length; priority += 1) {
      const entry = this.entries[priority];
      if (!entry) continue;
      const active = this.running.get(entry.entryId) ?? 0;
      if (active >= entry.maxConcurrent) continue;
      this.running.set(entry.entryId, active + 1);
      let released = false;
      return {
        entry,
        priority,
        release: () => {
          if (released) return;
          released = true;
          const remaining = Math.max(0, (this.running.get(entry.entryId) ?? 1) - 1);
          if (remaining === 0) this.running.delete(entry.entryId);
          else this.running.set(entry.entryId, remaining);
          this.drainWaiters();
        },
      };
    }
    return undefined;
  }

  acquireAfter(priority: number, signal?: AbortSignal): Promise<ExecutorPoolLease | undefined> {
    const startPriority = priority + 1;
    if (startPriority >= this.entries.length) return Promise.resolve(undefined);
    const immediate = this.tryAcquire(startPriority);
    if (immediate) return Promise.resolve(immediate);
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolvePromise) => {
      const waiter: Waiter = { startPriority, resolve: resolvePromise, signal };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolvePromise(undefined);
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  activeCount(entryId: string): number {
    return this.running.get(entryId) ?? 0;
  }

  private drainWaiters(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (!waiter || waiter.signal?.aborted) {
        this.waiters.splice(index, 1);
        waiter?.signal?.removeEventListener("abort", waiter.abort!);
        waiter?.resolve(undefined);
        continue;
      }
      const lease = this.tryAcquire(waiter.startPriority);
      if (!lease) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      waiter.resolve(lease);
    }
  }
}
