/**
 * #682 startup prerequisite: host custody of the native managed owner for ONE
 * exact durable owner tuple at a time.
 *
 * {@linkcode createNativeManagedConversationOwner} deliberately leaves
 * lifecycle custody with its caller: its `prepare()` hands back the real
 * manager (ready, or `retainedManager` on a stale or failed outcome) and never
 * detaches, shuts down, or cancels it. This module is that caller. It adds no
 * persistence, no result or callback policy, and no registry beyond the
 * per-tuple serialization below; every rule still lives in the owner, its
 * restore handle, and the real `ExecutionToolManager`/controller.
 *
 * Key. The durable owner tuple the association store is keyed by: row id (the
 * store's slot id), backend, conversation id, and canonical workspace, exactly
 * as the store compares them, under the one host state root this custody is
 * bound to. Distinct tuples never wait on each other.
 *
 * One preparation per run. {@linkcode NativeManagedOwnerCustody.acquire}
 * takes the exact {@linkcode NativeMcpLaneRunScope} the lane hands out; that
 * run object can be acquired once (a second acquire throws, whatever its
 * tuple). The custody constructs one owner for it and calls its `prepare()`
 * at most once, and only after every earlier holder of the same tuple has
 * fully handed off. While a predecessor's manager can still write, no
 * successor restore of that tuple starts.
 *
 * Retirement. Only the run's own revocation (`run.signal`) or the host drain
 * retires a holder, never an individual request's cancellation. Retirement
 * first closes this custody's admissions for the run (its delegate lists
 * nothing and answers every call as not exposed; it opens only after a ready
 * preparation), waits for the single
 * preparation to settle, and then hands the manager it produced, ready or
 * retained, off through the existing canonical path: `shutdown()` (the
 * controller records active tasks as `stopped_for_application_exit` and awaits
 * their runtimes) and then `detach()`, each awaited. A later exact restore may
 * resume that work through the existing engine. Only this run's own manager
 * is touched; nothing else is cancelled or terminated.
 *
 * Fail closed. A handoff step that rejects (or a manager that lacks the
 * canonical lifecycle) poisons the tuple for this custody's lifetime: the
 * waiting successor and every later acquire of it are refused, and the step
 * after a failed one is not attempted, so the manager is retained rather than
 * claimed clean. A handoff that never settles keeps every successor of that
 * tuple waiting; a waiting successor whose own run is revoked settles stale
 * without restoring. A run revoked before its preparation starts never
 * prepares. A holder that never produced a manager (refused, stale, or
 * unavailable) completes its handoff as soon as its predecessors have, so a
 * failure propagates through every queued holder of the tuple at once, and a
 * hold refused by the custody reports that tuple's real pending or failed
 * chain, never an unconditional `clean`.
 *
 * Host shutdown. {@linkcode NativeManagedOwnerCustody.drain} closes the custody
 * to new acquires, retires every holder as above (current runs included), and
 * reports `clean` only when every handoff completed. An optional caller signal
 * stops the WAIT only: it reports `unsettled` and never forces anything.
 *
 * Out of scope: host startup/discovery pairing, main integration, wake routing,
 * and any change to the owner, the lane, or the controller.
 */
import type { ExecutionToolManager } from "../execution/tool";
import type { NativeMcpLaneContext, NativeMcpLaneDelegate, NativeMcpLaneRunScope } from "./instances";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "./native-managed-conversation-owner";
import type { NativeManagedOwnerRestoreResult } from "./native-managed-owner-restore";

/** Why the custody itself refused a preparation. */
export type NativeManagedOwnerCustodyRefusal =
  /** An earlier holder of the same tuple did not hand off cleanly; it may still write. */
  | "predecessor-handoff-failed"
  /** The host drain began; no new owner is prepared. */
  | "host-draining";

export type NativeManagedOwnerCustodyPrepareResult =
  | NativeManagedOwnerRestoreResult<ExecutionToolManager>
  | { readonly status: "refused"; readonly reason: NativeManagedOwnerCustodyRefusal };

/**
 * How one holder's chain settled: `clean` only when every earlier holder of the
 * same tuple and this holder's own manager (if any) completed both handoff steps.
 */
export type NativeManagedOwnerHandoff = "clean" | "failed";

export interface NativeManagedOwnerHold {
  /** Pass as the lane owner's delegate. Exposes nothing once retirement begins. */
  readonly delegate: NativeMcpLaneDelegate;
  /** This run's single preparation, shared by every call; never rejects. */
  prepare(): Promise<NativeManagedOwnerCustodyPrepareResult>;
  /** Settles once this run's manager and every earlier same-tuple holder handed off. Never rejects. */
  readonly handoff: Promise<NativeManagedOwnerHandoff>;
  /**
   * Resolves once retirement of this hold begins (the run's own revocation or the
   * host drain), before its handoff settles. Observation only: it changes no
   * admission, cancellation, or handoff. A refused hold, which holds nothing, is
   * already retired. Never rejects.
   */
  readonly retiring: Promise<void>;
}

export type NativeManagedOwnerCustodyDrainResult =
  /** Every holder's manager completed `shutdown()` then `detach()`. */
  | { readonly status: "clean" }
  /** At least one handoff failed (or failed earlier); those managers may still write. */
  | { readonly status: "failed" }
  /** The caller stopped waiting before every handoff settled; nothing was forced. */
  | { readonly status: "unsettled" };

export interface NativeManagedOwnerCustodyOptions {
  /** The one trusted host state root every owner of this custody persists under. */
  readonly stateRoot: string;
  /** Test-only owner seam; production callers never pass hooks. */
  readonly testHooks?: {
    readonly createOwner?: (options: NativeManagedConversationOwnerOptions) => NativeManagedConversationOwner;
  };
}

export interface NativeManagedOwnerCustody {
  /** Hold the owner for one exact proved run. Throws for a malformed or already acquired run. */
  acquire(options: Omit<NativeManagedConversationOwnerOptions, "stateRoot">): NativeManagedOwnerHold;
  /** Host shutdown: refuse new acquires, retire every holder, await every handoff. Never rejects. */
  drain(options?: { readonly signal?: AbortSignal }): Promise<NativeManagedOwnerCustodyDrainResult>;
}

interface Holder {
  /** Retire this holder (idempotent): close admissions, then hand off once prepared. */
  retire(): void;
  readonly handoff: Promise<NativeManagedOwnerHandoff>;
}

/** The lifecycle the canonical handoff drives; a narrowing of the real manager. */
type RetirableManager = Pick<ExecutionToolManager, "shutdown" | "detach">;

function isRetirable(value: unknown): value is RetirableManager {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RetirableManager>;
  return typeof candidate.shutdown === "function" && typeof candidate.detach === "function";
}

/** The manager a settled preparation handed out, ready or retained. */
function managerOf(result: NativeManagedOwnerCustodyPrepareResult): unknown {
  if (result.status === "ready") return result.manager;
  return "retainedManager" in result ? result.retainedManager : undefined;
}

/** `shutdown()` then `detach()`, each awaited; the step after a failure is never attempted. */
async function handOff(manager: unknown): Promise<NativeManagedOwnerHandoff> {
  if (manager === undefined) return "clean";
  if (!isRetirable(manager)) return "failed";
  try {
    await manager.shutdown();
    await manager.detach();
    return "clean";
  } catch {
    return "failed";
  }
}

function runRevoked(run: NativeMcpLaneRunScope): boolean {
  try {
    return run.signal.aborted || run.isCurrent() !== true;
  } catch {
    return true;
  }
}

/** Resolves when the run's own signal aborts; never on any request's cancellation. */
function whenRevoked(run: NativeMcpLaneRunScope): Promise<void> {
  if (run.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => run.signal.addEventListener("abort", () => resolve(), { once: true }));
}

function tupleKey(rowId: string, backend: string, conversationId: string, workspace: string): string {
  return JSON.stringify([rowId, backend, conversationId, workspace]);
}

/** Create the host's custody for native managed owners under one state root. */
export function createNativeManagedOwnerCustody(options: NativeManagedOwnerCustodyOptions): NativeManagedOwnerCustody {
  const { stateRoot } = options;
  const createOwner = options.testHooks?.createOwner ?? createNativeManagedConversationOwner;
  /** Per tuple: the chain tail every next holder of that tuple waits on. */
  const tails = new Map<string, Promise<NativeManagedOwnerHandoff>>();
  /** Tuples whose handoff failed: refused for good. */
  const poisoned = new Set<string>();
  const holders = new Set<Holder>();
  const acquiredRuns = new WeakSet<NativeMcpLaneRunScope>();
  let draining = false;

  const refusedHold = (reason: NativeManagedOwnerCustodyRefusal, handoff: Promise<NativeManagedOwnerHandoff>): NativeManagedOwnerHold => {
    const result = Object.freeze({ status: "refused" as const, reason });
    return Object.freeze({
      delegate: Object.freeze({ listTools: async () => [], callTool: async () => undefined }),
      prepare: async () => result,
      handoff,
      retiring: Promise.resolve(),
    });
  };

  const acquire = (input: Omit<NativeManagedConversationOwnerOptions, "stateRoot">): NativeManagedOwnerHold => {
    const { run } = input;
    if (typeof run !== "object" || run === null || !(run.signal instanceof AbortSignal) || typeof run.isCurrent !== "function") {
      throw new Error("session-host: native managed owner custody requires the exact host-proved run");
    }
    if (acquiredRuns.has(run)) throw new Error("session-host: a native managed owner run is prepared at most once");
    acquiredRuns.add(run);
    const { rowId, backend, conversationId, workspace } = input.identity;
    const key = tupleKey(rowId, backend, conversationId, workspace);
    // A refused hold still reports the tuple's real chain: clean only when no
    // earlier holder of it is pending or failed.
    const chain = (): Promise<NativeManagedOwnerHandoff> =>
      poisoned.has(key) ? Promise.resolve("failed") : tails.get(key) ?? Promise.resolve("clean");
    if (draining) return refusedHold("host-draining", chain());
    if (poisoned.has(key)) return refusedHold("predecessor-handoff-failed", chain());

    // Construct before joining the chain, so a malformed input throws here and
    // leaves the tuple's chain untouched. The owner binds the same detached
    // tuple this custody keyed on.
    const identity = Object.freeze({ rowId, backend, workspace, conversationId });
    const owner = createOwner({ ...input, identity, stateRoot });
    const predecessor = tails.get(key) ?? Promise.resolve<NativeManagedOwnerHandoff>("clean");

    let open = true;
    let exposable = false;
    let retireRequested!: () => void;
    const retirement = new Promise<void>((resolve) => { retireRequested = resolve; });
    const retire = (): void => {
      open = false;
      retireRequested();
    };

    // The single preparation: never before the predecessor handed off, never
    // after this run was revoked or the custody began draining.
    const prepared = (async (): Promise<NativeManagedOwnerCustodyPrepareResult> => {
      const turn = await Promise.race([
        predecessor.then((outcome) => ({ kind: "predecessor" as const, outcome })),
        retirement.then(() => ({ kind: "retired" as const })),
      ]);
      if (turn.kind === "retired" || !open) {
        return draining && !runRevoked(run)
          ? { status: "refused", reason: "host-draining" }
          : { status: "stale" };
      }
      if (turn.outcome !== "clean") return { status: "refused", reason: "predecessor-handoff-failed" };
      if (runRevoked(run)) return { status: "stale" };
      let result: NativeManagedOwnerCustodyPrepareResult;
      try {
        result = await owner.prepare();
      } catch {
        result = { status: "failed", reason: "restore-failed" };
      }
      // Only a ready preparation ever opens this run's delegate.
      exposable = result.status === "ready";
      return result;
    })();

    const handoff = (async (): Promise<NativeManagedOwnerHandoff> => {
      const manager = managerOf(await prepared);
      // Only a holder with a manager has something that can write; one that
      // never produced a manager (refused, stale, unavailable) is done as soon
      // as its predecessors are, so a failure propagates down the queue.
      if (manager !== undefined) await retirement;
      const own = await handOff(manager);
      // Never report clean while an earlier holder of this tuple has not.
      const earlier = await predecessor;
      return own === "clean" && earlier === "clean" ? "clean" : "failed";
    })().catch((): NativeManagedOwnerHandoff => "failed");

    const holder: Holder = { retire, handoff };
    holders.add(holder);
    tails.set(key, handoff);
    void handoff.then((outcome) => {
      holders.delete(holder);
      if (outcome !== "clean") poisoned.add(key);
      if (tails.get(key) === handoff) tails.delete(key);
    });
    void whenRevoked(run).then(retire);

    const closed = (): boolean => !open || !exposable || runRevoked(run);
    const delegate: NativeMcpLaneDelegate = Object.freeze({
      listTools: async (context: NativeMcpLaneContext) => (closed() ? [] : owner.delegate.listTools(context)),
      callTool: async (context: NativeMcpLaneContext, call: Parameters<NativeMcpLaneDelegate["callTool"]>[1]) =>
        (closed() ? undefined : owner.delegate.callTool(context, call)),
    });

    return Object.freeze({
      delegate,
      prepare: async (): Promise<NativeManagedOwnerCustodyPrepareResult> => {
        const result = await prepared;
        // Re-prove freshness at every hand-out; the manager stays in custody.
        return result.status === "ready" && closed() ? { status: "stale", retainedManager: result.manager } : result;
      },
      handoff,
      retiring: retirement,
    });
  };

  const drain = async (drainOptions: { readonly signal?: AbortSignal } = {}): Promise<NativeManagedOwnerCustodyDrainResult> => {
    draining = true;
    const pending = [...holders];
    for (const holder of pending) holder.retire();
    const settled = Promise.all(pending.map((holder) => holder.handoff))
      .then((outcomes) => (outcomes.every((outcome) => outcome === "clean") && poisoned.size === 0 ? "clean" : "failed") as "clean" | "failed");
    const signal = drainOptions.signal;
    if (signal === undefined) return { status: await settled };
    if (signal.aborted) return { status: "unsettled" };
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<"unsettled">((resolve) => {
      onAbort = () => resolve("unsettled");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return { status: await Promise.race([settled, stopped]) };
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };

  return Object.freeze({ acquire, drain });
}
