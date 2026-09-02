import { isAbsolute, relative, resolve, sep } from "node:path";

interface Blocker {
  promise: Promise<void>;
  release: () => void;
  reason: string;
}

/**
 * Process-local serialization and critical-gate coordination for mutations of
 * a source workspace. Captures and executor work remain concurrent; only the
 * final revalidation/mutation section is serialized. Ancestor and descendant
 * roots (for example, the Git capture root and a session cwd inside it)
 * participate in the same leases and conflict gates.
 */
export class SourceMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly blockers = new Map<string, Blocker>();

  async acquire(sourceRoot: string, signal?: AbortSignal): Promise<() => void> {
    const key = resolve(sourceRoot);
    for (;;) {
      // Ancestor and descendant roots share conflict gates: a gate on the
      // capture root must hold a session cwd inside it (and vice versa).
      const blockerPromises = [...this.blockers.entries()]
        .filter(([candidate]) => pathsOverlap(candidate, key))
        .map(([, blocker]) => blocker.promise);
      await waitFor(
        blockerPromises.length > 0 ? Promise.all(blockerPromises).then(() => undefined) : undefined,
        signal,
      );

      let releaseLease!: () => void;
      const lease = new Promise<void>((resolveLease) => {
        releaseLease = resolveLease;
      });
      const predecessors = [...new Set(
        [...this.tails.entries()]
          .filter(([candidate]) => pathsOverlap(candidate, key))
          .map(([, tail]) => tail),
      )];
      const previous = Promise.all(predecessors).then(() => undefined);
      const tail = previous.then(() => lease);
      this.tails.set(key, tail);
      const pruneTail = () => {
        if (this.tails.get(key) !== tail) return;
        void tail.then(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key);
        });
      };
      await waitFor(previous, signal).catch((error) => {
        releaseLease();
        // An aborted waiter never returns a release callback, so arrange the
        // same settled-tail cleanup here instead of retaining its cwd forever.
        pruneTail();
        throw error;
      });

      // A conflict can activate while this waiter is queued behind the task
      // that discovered it. Yield the lease and wait for mark_clean instead of
      // entering the source workspace after the gate became active.
      if ([...this.blockers.keys()].some((candidate) => pathsOverlap(candidate, key))) {
        releaseLease();
        continue;
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseLease();
        pruneTail();
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
    const key = resolve(sourceRoot);
    const blocker = [...this.blockers.entries()]
      .find(([candidate]) => pathsOverlap(candidate, key))?.[1];
    return blocker ? { blocked: true, reason: blocker.reason } : { blocked: false };
  }
}

/** Ancestor and descendant workspace roots coordinate as one workspace. */
function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
