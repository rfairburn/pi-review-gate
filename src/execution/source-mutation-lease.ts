import { resolve } from "node:path";

interface Blocker {
  promise: Promise<void>;
  release: () => void;
  reason: string;
}

/**
 * Process-local serialization and critical-gate coordination for mutations of
 * a source workspace. Captures and executor work remain concurrent; only the
 * final revalidation/mutation section is serialized.
 */
export class SourceMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly blockers = new Map<string, Blocker>();

  async acquire(sourceRoot: string, signal?: AbortSignal): Promise<() => void> {
    const key = resolve(sourceRoot);
    for (;;) {
      await waitFor(this.blockers.get(key)?.promise, signal);

      let releaseLease!: () => void;
      const lease = new Promise<void>((resolveLease) => {
        releaseLease = resolveLease;
      });
      const previous = this.tails.get(key) ?? Promise.resolve();
      const tail = previous.then(() => lease);
      this.tails.set(key, tail);
      await waitFor(previous, signal).catch((error) => {
        releaseLease();
        throw error;
      });

      // A conflict can activate while this waiter is queued behind the task
      // that discovered it. Yield the lease and wait for mark_clean instead of
      // entering the source workspace after the gate became active.
      if (this.blockers.has(key)) {
        releaseLease();
        continue;
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseLease();
        if (this.tails.get(key) === tail) {
          void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key);
          });
        }
      };
    }
  }

  block(sourceRoot: string, reason: string): () => void {
    const key = resolve(sourceRoot);
    const existing = this.blockers.get(key);
    if (existing) return existing.release;
    let resolveBlock!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolveBlock = resolvePromise;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.blockers.delete(key);
      resolveBlock();
    };
    this.blockers.set(key, { promise, release, reason });
    return release;
  }

  blocked(sourceRoot: string): { blocked: boolean; reason?: string } {
    const blocker = this.blockers.get(resolve(sourceRoot));
    return blocker ? { blocked: true, reason: blocker.reason } : { blocked: false };
  }
}

async function waitFor(promise: Promise<void> | undefined, signal?: AbortSignal): Promise<void> {
  if (!promise) {
    if (signal?.aborted) throw abortError(signal);
    return;
  }
  if (!signal) {
    await promise;
    return;
  }
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
}

export const sourceMutationCoordinator = new SourceMutationCoordinator();
