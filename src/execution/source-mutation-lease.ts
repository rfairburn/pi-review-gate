import { isAbsolute, relative, resolve, sep } from "node:path";

interface Blocker {
  promise: Promise<void>;
  release: () => void;
  reason: string;
  /** Opaque identity of the holder (for example, one conflict-gate store). */
  owner?: object;
}

/**
 * Owner-scoped view of the blockers overlapping one root. `ownReason` is only
 * ever taken from the asking owner's own holders; a holder with any other (or
 * no) owner contributes only the `foreign` flag, never its reason.
 */
export interface OwnedBlockState {
  blocked: boolean;
  /** Reason of the first overlapping blocker held by the asking owner. */
  ownReason?: string;
  /** Whether at least one overlapping blocker is held by any other holder. */
  foreign: boolean;
}

/**
 * Process-local serialization and critical-gate coordination for mutations of
 * a source workspace. Captures and executor work remain concurrent; only the
 * final revalidation/mutation section is serialized. Ancestor and descendant
 * roots (for example, the Git capture root and a session cwd inside it)
 * participate in the same leases and conflict gates.
 *
 * Every block() invocation is an independent holder with its own idempotent
 * release: several holders on the same or overlapping roots (for example, two
 * conversation owners' conflict gates) each keep the root blocked until every
 * one of them has been released, and no holder can release another's block.
 */
export class SourceMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  /** Resolved root -> its outstanding holders, in activation order. */
  private readonly blockers = new Map<string, Blocker[]>();

  async acquire(sourceRoot: string, signal?: AbortSignal): Promise<() => void> {
    const key = resolve(sourceRoot);
    for (;;) {
      // Ancestor and descendant roots share conflict gates: a gate on the
      // capture root must hold a session cwd inside it (and vice versa).
      // Wait for every overlapping holder, not just one per root.
      const blockerPromises = this.overlapping(key).map((blocker) => blocker.promise);
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
      if (this.overlapping(key).length > 0) {
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

  /**
   * Add one independent holder blocking `sourceRoot`. The returned release is
   * idempotent and removes only this holder: the root stays blocked while any
   * other holder on it (or on an overlapping root) remains.
   */
  block(sourceRoot: string, reason: string, owner?: object): () => void {
    const key = resolve(sourceRoot);
    let resolveBlock!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolveBlock = resolvePromise;
    });
    let released = false;
    const holder: Blocker = {
      promise,
      reason,
      ...(owner ? { owner } : {}),
      release: () => {
        if (released) return;
        released = true;
        const holders = this.blockers.get(key);
        if (holders) {
          const index = holders.indexOf(holder);
          if (index >= 0) holders.splice(index, 1);
          if (holders.length === 0) this.blockers.delete(key);
        }
        resolveBlock();
      },
    };
    const holders = this.blockers.get(key);
    if (holders) holders.push(holder);
    else this.blockers.set(key, [holder]);
    return holder.release;
  }

  /**
   * Process-wide blocked state with the first overlapping holder's reason.
   * The reason may belong to any holder; callers answering one owner must use
   * blockedFor() instead so another owner's reason is never disclosed.
   */
  blocked(sourceRoot: string): { blocked: boolean; reason?: string } {
    const blocker = this.overlapping(resolve(sourceRoot))[0];
    return blocker ? { blocked: true, reason: blocker.reason } : { blocked: false };
  }

  /** Owner-scoped blocked state: only `owner`'s own reasons are exposed. */
  blockedFor(sourceRoot: string, owner: object): OwnedBlockState {
    const holders = this.overlapping(resolve(sourceRoot));
    const own = holders.find((blocker) => blocker.owner === owner);
    return {
      blocked: holders.length > 0,
      ...(own ? { ownReason: own.reason } : {}),
      foreign: holders.some((blocker) => blocker.owner !== owner),
    };
  }

  private overlapping(key: string): Blocker[] {
    return [...this.blockers.entries()]
      .filter(([candidate]) => pathsOverlap(candidate, key))
      .flatMap(([, holders]) => holders);
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
