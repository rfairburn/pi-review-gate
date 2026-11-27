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
 * Diagnostics. A failed handoff also records WHY, in a closed form the host can
 * report: which lifecycle step failed (`lifecycle`, `shutdown`, `detach`, or the
 * custody's own chain step), a closed reason for how it failed (the lifecycle was
 * not exposed, the owner's association publication refused, or one of a fixed few
 * Node error codes; anything else is only `threw` or `rejected`), and the failing
 * tuple's backend and roster slot row. Only the failure's TYPE is consulted: the
 * error's message and raw code are never read, kept, or forwarded, so no message,
 * path, prompt, or provider content can reach a drain result. The first record of
 * a tuple is the step that actually failed; later holders of that tuple inherit
 * only the `failed` verdict. A record explains a verdict that already stands: it
 * changes no settlement, poisoning, serialization, or fencing rule.
 *
 * Out of scope: host startup/discovery pairing, main integration, wake routing,
 * and any change to the owner, the lane, or the controller.
 */
import { isProxy } from "node:util/types";

import { ExecutionArtifactCleanupRefusal } from "../execution/background-group-store";
import type { ExecutionToolManager } from "../execution/tool";
import type { NativeMcpLaneContext, NativeMcpLaneDelegate, NativeMcpLaneRunScope } from "./instances";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "./native-managed-conversation-owner";
import {
  NativeManagedAssociationSaveError,
  type NativeManagedOwnerRestoreResult,
} from "./native-managed-owner-restore";

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
 * The ONE list of handoff stages: the manager's canonical `shutdown` and
 * `detach` steps, `lifecycle` when that pair was never exposed, and `handoff`
 * for the custody's own chain step, which can only fail defensively (it awaits
 * nothing that rejects by contract). {@linkcode NativeManagedHandoffStage} IS
 * this list; a host validates a verdict against
 * {@linkcode isNativeManagedHandoffStage} instead of restating it.
 */
export const NATIVE_MANAGED_HANDOFF_STAGES = Object.freeze(["lifecycle", "shutdown", "detach", "handoff"] as const);

export type NativeManagedHandoffStage = (typeof NATIVE_MANAGED_HANDOFF_STAGES)[number];

/** Whether a value is one of {@linkcode NATIVE_MANAGED_HANDOFF_STAGES}. */
export function isNativeManagedHandoffStage(value: unknown): value is NativeManagedHandoffStage {
  return typeof value === "string" && (NATIVE_MANAGED_HANDOFF_STAGES as readonly string[]).includes(value);
}

/**
 * The ONE list of handoff failure reasons, every member a token this module
 * owns: the canonical lifecycle pair was not exposed, the owner's execution
 * association publication refused or failed, an artifact cleanup ownership
 * guard refused a root, the step was aborted, or one of a
 * fixed few Node error codes (see {@linkcode FAILURE_CODES}: `not-permitted`
 * EPERM/EACCES/EROFS, `not-found` ENOENT/ENOTDIR/EISDIR, `busy` EBUSY/EMFILE/
 * ENFILE/EAGAIN, `no-space` ENOSPC/EDQUOT/EFBIG, `stale-handle` ESTALE, `io`
 * EIO, `invalid` EINVAL, `timed-out` ETIMEDOUT, `aborted` ABORT_ERR). The
 * error's message, its raw `code`, and any path, prompt, or provider text
 * inside it are never read into a reason: an unrecognized synchronous throw is
 * `threw` and an unrecognized rejection is `rejected`.
 * {@linkcode NativeManagedHandoffFailureReason} IS this list; a host validates
 * a verdict against {@linkcode isNativeManagedHandoffFailureReason}.
 */
export const NATIVE_MANAGED_HANDOFF_FAILURE_REASONS = Object.freeze([
  "lifecycle-unavailable",
  "association-publication-failed",
  "artifact-cleanup-refused",
  "aborted",
  "not-permitted",
  "not-found",
  "busy",
  "no-space",
  "stale-handle",
  "io",
  "invalid",
  "timed-out",
  "threw",
  "rejected",
] as const);

export type NativeManagedHandoffFailureReason = (typeof NATIVE_MANAGED_HANDOFF_FAILURE_REASONS)[number];

/** Whether a value is one of {@linkcode NATIVE_MANAGED_HANDOFF_FAILURE_REASONS}. */
export function isNativeManagedHandoffFailureReason(value: unknown): value is NativeManagedHandoffFailureReason {
  return typeof value === "string" && (NATIVE_MANAGED_HANDOFF_FAILURE_REASONS as readonly string[]).includes(value);
}

/** The only identity parts a shutdown diagnostic may name; both are custody key parts. */
interface NativeManagedHandoffTuple {
  /** The lane backend the failed holder was acquired with. */
  readonly backend: string;
  /** The roster slot row the lane resolved for the failed holder (its association key). */
  readonly rowId: string;
}

/** One handoff failure with the exact tuple it belongs to. */
export interface NativeManagedOwnerHandoffFailure {
  readonly stage: NativeManagedHandoffStage;
  readonly reason: NativeManagedHandoffFailureReason;
  /** The lane backend the failed holder was acquired with. */
  readonly backend: string;
  /** The roster slot row the lane resolved for the failed holder (its association key). */
  readonly rowId: string;
}

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
  /**
   * At least one handoff failed (or failed earlier); those managers may still
   * write. `failures` names every distinct failure the custody recorded, oldest
   * first, each with its stage, closed reason, backend, and roster slot row.
   */
  | { readonly status: "failed"; readonly failures: readonly NativeManagedOwnerHandoffFailure[] }
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

/**
 * The only Node error codes a handoff reason distinguishes, each mapped to a
 * token this module owns. A Map is deliberate: a code like `constructor` or
 * `__proto__` finds no entry and can never escape the closed set. An error
 * carrying anything else — including its own message or a path inside it — can
 * only ever produce the generic fallback reason.
 */
const FAILURE_CODES: ReadonlyMap<string, NativeManagedHandoffFailureReason> = new Map([
  ["EPERM", "not-permitted"],
  ["EACCES", "not-permitted"],
  ["EROFS", "not-permitted"],
  ["ENOENT", "not-found"],
  ["ENOTDIR", "not-found"],
  ["EISDIR", "not-found"],
  ["EBUSY", "busy"],
  ["EMFILE", "busy"],
  ["ENFILE", "busy"],
  ["EAGAIN", "busy"],
  ["ENOSPC", "no-space"],
  ["EDQUOT", "no-space"],
  ["EFBIG", "no-space"],
  ["ESTALE", "stale-handle"],
  ["EIO", "io"],
  ["EINVAL", "invalid"],
  ["ETIMEDOUT", "timed-out"],
  ["ABORT_ERR", "aborted"],
]);

/**
 * One closed reason for a failed step. Only the failure's TYPE is consulted: the
 * owner restore's own association-save error, an AbortError, and a code matched
 * against {@linkcode FAILURE_CODES}. The message and the raw code are never read
 * out, so nothing a manager or a filesystem puts into them can reach the output;
 * `fallback` says only whether the step threw or rejected.
 *
 * Nothing the rejection value owns ever runs. A Proxy is never introspected at
 * all — every trap is caller-supplied code — and no prototype chain is walked
 * and no `instanceof` is used, so a Proxy that only sits ON the chain cannot be
 * entered either: the typed producers are recognized by DIRECT prototype
 * identity, and `code`/`name` are read only as OWN DATA descriptors (a getter
 * there makes the value unclassifiable rather than being invoked). The single
 * accessor consulted is `DOMException`'s own known `name` getter, on a value
 * whose direct prototype is that prototype. The whole probe stays contained: a
 * throw cannot replace the caller's stage with a later one, it can only lose the
 * reason detail.
 */
function classifyFailure(error: unknown, fallback: "threw" | "rejected"): NativeManagedHandoffFailureReason {
  try {
    if (typeof error !== "object" || error === null) return fallback;
    // Never introspected: `get`, `getOwnPropertyDescriptor`, and
    // `getPrototypeOf` on a Proxy are all caller-supplied code.
    if (isProxy(error)) return fallback;
    // Direct prototype identity, never `instanceof`: a chain walk would run the
    // traps of a Proxy sitting on the prototype chain. Each of these is the one
    // real producer of its shape, so its own prototype identifies it.
    const prototype = Object.getPrototypeOf(error);
    if (prototype === NativeManagedAssociationSaveError.prototype) return "association-publication-failed";
    if (prototype === ExecutionArtifactCleanupRefusal.prototype) return "artifact-cleanup-refused";
    const nameProperty = Object.getOwnPropertyDescriptor(error, "name");
    const codeProperty = Object.getOwnPropertyDescriptor(error, "code");
    // An accessor on either property makes the whole value unclassifiable: it is
    // never invoked.
    if ((nameProperty !== undefined && !Object.hasOwn(nameProperty, "value"))
      || (codeProperty !== undefined && !Object.hasOwn(codeProperty, "value"))) return fallback;
    if (nameProperty?.value === "AbortError") return "aborted";
    // A DOMException keeps `name` on the prototype, so its own known accessor is
    // consulted only for a value whose direct prototype is that prototype.
    if (prototype === DOMException.prototype
      && Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(error) === "AbortError") return "aborted";
    const code: unknown = codeProperty?.value;
    return typeof code === "string" ? FAILURE_CODES.get(code) ?? fallback : fallback;
  } catch {
    return fallback;
  }
}

/**
 * `shutdown()` then `detach()`, each awaited; the step after a failure is never
 * attempted. Returns undefined when both completed, otherwise the one failure
 * that stopped the handoff: where it stopped and a closed reason only. The error
 * value is never kept or forwarded.
 */
async function handOff(manager: unknown, tuple: NativeManagedHandoffTuple): Promise<NativeManagedOwnerHandoffFailure | undefined> {
  if (manager === undefined) return undefined;
  if (!isRetirable(manager)) return { stage: "lifecycle", reason: "lifecycle-unavailable", ...tuple };
  for (const stage of ["shutdown", "detach"] as const) {
    let step: Promise<unknown>;
    try {
      // Called as a method so the real manager keeps its own `this`.
      step = Promise.resolve(manager[stage]());
    } catch (error) {
      return { stage, reason: classifyFailure(error, "threw"), ...tuple };
    }
    try {
      await step;
    } catch (error) {
      return { stage, reason: classifyFailure(error, "rejected"), ...tuple };
    }
  }
  return undefined;
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
  /** Tuples whose handoff failed: refused for good, with the failure that says why. */
  const poisoned = new Map<string, NativeManagedOwnerHandoffFailure>();
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
    /** Bound once for this holder: the only identity a shutdown diagnostic may name. */
    const tuple: NativeManagedHandoffTuple = Object.freeze({ backend, rowId });
    // A refused hold still reports the tuple's real chain: clean only when no
    // earlier holder of it is pending or failed.
    const chain = (): Promise<NativeManagedOwnerHandoff> =>
      poisoned.has(key) ? Promise.resolve("failed" as const) : tails.get(key) ?? Promise.resolve("clean" as const);
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

    // The one recorder for this tuple. A holder records its OWN failure at the
    // step that failed, before its handoff resolves, so a successor never has to
    // carry a second copy of it: the first record of a tuple is always the step
    // that actually failed, and a later holder of the same tuple only inherits
    // the `failed` verdict.
    const recordFailure = (failure: NativeManagedOwnerHandoffFailure): void => {
      if (!poisoned.has(key)) poisoned.set(key, failure);
    };
    const handoff: Promise<NativeManagedOwnerHandoff> = (async (): Promise<NativeManagedOwnerHandoff> => {
      const manager = managerOf(await prepared);
      // Only a holder with a manager has something that can write; one that
      // never produced a manager (refused, stale, unavailable) is done as soon
      // as its predecessors are, so a failure propagates down the queue.
      if (manager !== undefined) await retirement;
      const own = await handOff(manager, tuple);
      if (own !== undefined) recordFailure(own);
      // Never report clean while an earlier holder of this tuple has not.
      const earlier = await predecessor;
      if (earlier === "failed") recordFailure({ stage: "handoff", reason: "rejected", ...tuple });
      return own === undefined && earlier === "clean" ? "clean" : "failed";
    })().catch((error): NativeManagedOwnerHandoff => {
      recordFailure({ stage: "handoff", reason: classifyFailure(error, "rejected"), ...tuple });
      return "failed";
    });

    const holder: Holder = { retire, handoff };
    holders.add(holder);
    tails.set(key, handoff);
    void handoff.then(() => {
      holders.delete(holder);
      if (tails.get(key) === handoff) tails.delete(key);
    });
    void whenRevoked(run).then(retire);

    const closed = (): boolean => !open || !exposable || runRevoked(run);
    const delegate: NativeMcpLaneDelegate = Object.freeze({
      listTools: async (context: NativeMcpLaneContext) => (closed() ? [] : owner.delegate.listTools(context)),
      callTool: async (context: NativeMcpLaneContext, call: Parameters<NativeMcpLaneDelegate["callTool"]>[1]) =>
        (closed() ? undefined : owner.delegate.callTool(context, call)),
      // #682: discovery metadata only; a closed hold (retiring, not ready, or
      // revoked) never answers yes.
      discoveryAwaitsDeliverySender: (context: NativeMcpLaneContext): boolean => {
        if (closed()) return false;
        try {
          return owner.delegate.discoveryAwaitsDeliverySender?.(context) === true;
        } catch {
          return false;
        }
      },
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
    // Each holder's own recorder was attached when it was acquired, so every
    // failure of these handoffs is already recorded when this continuation runs.
    const settled: Promise<NativeManagedOwnerCustodyDrainResult> = Promise.all(pending.map((holder) => holder.handoff))
      .then((outcomes): NativeManagedOwnerCustodyDrainResult =>
        outcomes.every((outcome) => outcome === "clean") && poisoned.size === 0
          ? { status: "clean" }
          : { status: "failed", failures: [...poisoned.values()] });
    const signal = drainOptions.signal;
    if (signal === undefined) return await settled;
    if (signal.aborted) return { status: "unsettled" };
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<NativeManagedOwnerCustodyDrainResult>((resolve) => {
      onAbort = () => resolve({ status: "unsettled" });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([settled, stopped]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };

  return Object.freeze({ acquire, drain });
}
