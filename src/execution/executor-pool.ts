import type { ExecutorPoolEntry } from "../config";

export interface ExecutorPoolAssignment {
  readonly entry: ExecutorPoolEntry;
  readonly priority: number;
}

export interface ExecutorPoolLease extends ExecutorPoolAssignment {
  release(): void;
}

export interface ExecutorPoolCapacitySnapshot {
  totalCapacity: number;
  activeLeases: number;
  availableSlots: number;
  entries: Array<{
    entryId: string;
    priority: number;
    capacity: number;
    activeLeases: number;
    availableSlots: number;
  }>;
}

interface Waiter {
  after: number | string;
  resolve: (lease: ExecutorPoolLease | undefined) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Ordered, capacity-aware leases shared by background execution groups. */
export class ExecutorPoolScheduler {
  private readonly running = new Map<string, number>();
  private readonly waiters: Waiter[] = [];

  constructor(private entries: readonly ExecutorPoolEntry[]) {}

  reconfigure(entries: readonly ExecutorPoolEntry[]): void {
    this.entries = entries;
    this.drainWaiters();
  }

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

  tryAcquireEntry(entryId: string): ExecutorPoolLease | undefined {
    const priority = this.entries.findIndex((entry) => entry.entryId === entryId);
    if (priority < 0) return undefined;
    const entry = this.entries[priority]!;
    const active = this.running.get(entry.entryId) ?? 0;
    if (active >= entry.maxConcurrent) return undefined;
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

  acquireAfter(current: number | ExecutorPoolAssignment, signal?: AbortSignal): Promise<ExecutorPoolLease | undefined> {
    const after = typeof current === "number" ? current : current.entry.entryId;
    const startPriority = this.priorityAfter(after);
    if (startPriority >= this.entries.length) return Promise.resolve(undefined);
    const immediate = this.tryAcquire(startPriority);
    if (immediate) return Promise.resolve(immediate);
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolvePromise) => {
      const waiter: Waiter = { after, resolve: resolvePromise, signal };
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

  hasEntry(entryId: string): boolean {
    return this.entries.some((entry) => entry.entryId === entryId);
  }

  capacitySnapshot(releasingEntryId?: string): ExecutorPoolCapacitySnapshot {
    const entries = this.entries.map((entry, priority) => {
      const current = this.running.get(entry.entryId) ?? 0;
      const activeLeases = releasingEntryId === entry.entryId ? Math.max(0, current - 1) : current;
      return {
        entryId: entry.entryId,
        priority,
        capacity: entry.maxConcurrent,
        activeLeases,
        availableSlots: Math.max(0, entry.maxConcurrent - activeLeases),
      };
    });
    return {
      totalCapacity: entries.reduce((sum, entry) => sum + entry.capacity, 0),
      activeLeases: entries.reduce((sum, entry) => sum + entry.activeLeases, 0),
      availableSlots: entries.reduce((sum, entry) => sum + entry.availableSlots, 0),
      entries,
    };
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
      const startPriority = this.priorityAfter(waiter.after);
      if (startPriority >= this.entries.length) {
        this.waiters.splice(index, 1);
        waiter.signal?.removeEventListener("abort", waiter.abort!);
        waiter.resolve(undefined);
        continue;
      }
      const lease = this.tryAcquire(startPriority);
      if (!lease) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      waiter.resolve(lease);
    }
  }

  private priorityAfter(after: number | string): number {
    if (typeof after === "number") return after + 1;
    const currentPriority = this.entries.findIndex((entry) => entry.entryId === after);
    return currentPriority < 0 ? 0 : currentPriority + 1;
  }
}
