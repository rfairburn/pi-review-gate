/**
 * #682 production-owner prerequisite: durable restore of the managed execution
 * associations owned by ONE exact hosted native (Claude/Codex) conversation.
 *
 * This is composition, not a new engine or schema. It joins two existing
 * contracts for one exact {@linkcode NativeManagedAssociationOwner}:
 * - the private owner store (`readNativeManagedAssociations` /
 *   `writeNativeManagedAssociations`), which keeps the existing
 *   `ExecutionAssociationsSnapshot` shape and owns every file-level
 *   fail-closed rule;
 * - the real `ExecutionToolManager` boundary: `restoreAssociations` (the
 *   canonical restore Pi uses for its session sidecar), `associations()` (the
 *   canonical live snapshot), and the `onAssociationsChanged` callback.
 *
 * The host supplies the actual manager through a factory that receives the
 * association-save callback, so construction, exposure, policy and catalog
 * stay entirely host-owned. Nothing here builds a Pi host, implements a
 * manager, launches anything, or reads configuration.
 *
 * One handle serves one exact owner run. Every `restore()` call shares the
 * same single attempt: the store is read once, the factory runs at most once,
 * and the canonical restore runs at most once. A host that wants to try again
 * (for example after a human repaired the owner file) creates a new handle.
 *
 * Tool availability and durability are independent. As in Pi, a usable
 * manager can offer tools even when a prior group or bundle could not be
 * recovered. The affected handle can fail without hiding unrelated tools or
 * discarding validly attached work. A failed record read or thrown restore
 * uses the same non-authoritative empty fallback as Pi. The tool scope opens
 * only once canonical restore (or its fallback) succeeds, and only for the
 * exact current owner.
 *
 * A fulfilled restore does not prove we can replace the owner record. An
 * incomplete restore keeps the prior file byte-identical and reports a fixed
 * diagnostic (never the raw path or controller message). Successful restore
 * enables publication of the live associations for this owner only.
 *
 * The save callback (the manager's `onAssociationsChanged`):
 * - Before the canonical restore completes it writes nothing and resolves
 *   without confirming, so neither the empty pre-restore manager nor a partially
 *   restored one can replace the persisted associations. (It must not reject
 *   here: the controller publishes from inside restore, e.g. while adopting a
 *   legacy bundle.) If a save was declined, the verified post-restore snapshot
 *   is published once after the restore is proven complete.
 * - After a complete restore it publishes through the store. A committed write
 *   resolves `undefined`: this store records execution associations only, never
 *   a parent review checkpoint, so it never issues the bare `true` or receipt
 *   that `ParentCheckpointLedger` treats as permission to retire parent
 *   checkpoint owners. The ledger therefore retains them and reports that the
 *   parent save was not confirmed.
 * - While persistence is OPEN, a refused or failed publication REJECTS with a
 *   bounded error. `publishAssociations` ignores resolved values but propagates
 *   rejections, so the canonical operation (for example a shared Start) reports
 *   the durability failure. Work the controller already admitted stays admitted
 *   and is never cancelled here, though it may not progress until the
 *   controller next schedules (a failed Start publication skips its pump).
 * - Once persistence is CLOSED (after a failed or incomplete restore) every
 *   save is declined: nothing is written and nothing is acknowledged, but it
 *   does not reject. The restore result carries the diagnostic, and a
 *   rejection would turn the lifecycle bookkeeping of validly attached, retained
 *   work into a task failure because an unrelated association did not restore.
 *
 * Freshness. The host's exact-owner run proof (`isCurrent`) is the run's own
 * lifetime, never an individual MCP request's cancellation signal. It is checked
 * before the read, after the read, after the restore, and again on every
 * hand-out: each `restore()` call rechecks it before returning a ready manager,
 * and the synchronous {@linkcode NativeManagedOwnerRestore.readyManager} is the
 * accessor for a synchronous scope resolver. Revocation is sticky for the handle;
 * a revoked run never yields its manager as ready again.
 *
 * Lifetime: once a manager was constructed it may hold restored, admitted
 * groups. A stale outcome or a failed fallback after construction never
 * exposes the manager, but it is handed back as `retainedManager` and is never cancelled,
 * shut down, or detached here. After a complete restore its save callback stays
 * open even when the run is later revoked, so admitted work keeps its durable
 * record for the same exact owner. Retiring it, and doing so before restoring
 * the same exact owner again, is the host's lifecycle decision.
 *
 * Out of scope by design: host startup wiring, policy/config, scope
 * resolution, callbacks/notifications, and any cross-owner registry.
 */
import type { ExecutionRestoreResult, ExecutionRestoreReasonCode } from "../execution/restore-reconciliation";
import type { ExecutionToolManager } from "../execution/tool";
import type { ParentCheckpointSaveResult } from "../execution/parent-checkpoint-ledger";
import type { ExecutionAssociationsSnapshot } from "../session-state";
import {
  isValidNativeManagedAssociationOwner,
  readNativeManagedAssociations,
  writeNativeManagedAssociations,
  type NativeManagedAssociationOwner,
  type NativeManagedAssociationPublicationHooks,
  type NativeManagedAssociationReadHooks,
  type NativeManagedAssociationUnavailableReason,
  type NativeManagedAssociationWriteResult,
} from "./native-managed-association-store";

/** The part of the real manager this composition drives; a narrowing, not a second implementation. */
export type NativeManagedRestorableManager = Pick<ExecutionToolManager, "restoreAssociations" | "associations">;

/** The existing manager callback contract the factory wires as `onAssociationsChanged`. */
export type NativeManagedAssociationSave = (
  associations: ExecutionAssociationsSnapshot,
) => Promise<ParentCheckpointSaveResult>;

export interface NativeManagedOwnerRestoreOptions<M extends NativeManagedRestorableManager> {
  /** Trusted host state root (never model input). */
  readonly stateRoot: string;
  /** The exact, already-authenticated owner. Copied and validated once at handle creation. */
  readonly owner: NativeManagedAssociationOwner;
  /**
   * Host-supplied freshness proof for this exact owner run (not a per-request
   * signal). Must be synchronous and side-effect free.
   */
  readonly isCurrent: () => boolean;
  /**
   * Constructs the host's actual manager, wiring `save` as its
   * `onAssociationsChanged`. Called at most once per handle, only after a
   * usable read and a fresh owner proof. The manager must not be exposed or
   * receive work before this handle reports it ready.
   */
  readonly createManager: (save: NativeManagedAssociationSave) => M;
  /** Test-only store fault injection; production callers never pass hooks. */
  readonly testHooks?: {
    readonly read?: NativeManagedAssociationReadHooks;
    readonly publication?: NativeManagedAssociationPublicationHooks;
  };
}

export type NativeManagedOwnerRestoreFailure =
  | "manager-construction-failed"
  | "restore-failed"
  | "restore-incomplete"
  | "publication-failed";

export type NativeManagedOwnerRestoreDiagnostic =
  | { readonly stage: "read"; readonly reason: NativeManagedAssociationUnavailableReason }
  | { readonly stage: "restore"; readonly reason: "restore-failed" | "restore-incomplete"; readonly references?: readonly ExecutionRestoreReasonCode[] }
  | { readonly stage: "publish"; readonly reason: "publication-failed" };

/** Fixed operator guidance; never display artifact paths or exception text. */
export function nativeManagedOwnerRestoreNotice(diagnostic: NativeManagedOwnerRestoreDiagnostic): string {
  const label = `Managed-work ${diagnostic.stage} (${diagnostic.reason})`;
  switch (diagnostic.stage) {
    case "read":
      return `${label}: owner record preserved. Check access or recover the record, then restart this row. See Recovery.`;
    case "restore": {
      const references = diagnostic.references?.length ? ` (${diagnostic.references.join(", ")})` : "";
      return `${label}${references}: owner record preserved. Check the original execution and wave storage, then restart this row. See Recovery.`;
    }
    case "publish":
      return `${label}: owner update not saved. Check state storage and restart this row. See Recovery.`;
  }
}

export type NativeManagedOwnerRestoreResult<M> =
  /** The canonical tool scope is available, even if some prior state could not be recovered. */
  | {
    readonly status: "ready";
    readonly manager: M;
    readonly source: "loaded" | "absent" | "unavailable";
    /** Store revision that was loaded (absent for an empty restore). */
    readonly revision?: number;
    readonly diagnostic?: NativeManagedOwnerRestoreDiagnostic;
  }
  /** No valid owner could be established; no manager was constructed. */
  | { readonly status: "unavailable"; readonly reason: NativeManagedAssociationUnavailableReason }
  /** The owner run was revoked. */
  | { readonly status: "stale"; readonly retainedManager?: M }
  /** Construction, restore, completeness, or the deferred post-restore publication failed. */
  | { readonly status: "failed"; readonly reason: NativeManagedOwnerRestoreFailure; readonly retainedManager?: M };

export interface NativeManagedOwnerRestore<M> {
  /** The detached, frozen exact owner this handle restores; undefined when the supplied owner was invalid. */
  readonly owner: NativeManagedAssociationOwner | undefined;
  /**
   * The shared single attempt. Never rejects. Every call rechecks the run's
   * freshness before handing out a ready manager; a revoked run reads as stale.
   */
  restore(): Promise<NativeManagedOwnerRestoreResult<M>>;
  /**
   * Synchronous accessor for a synchronous scope resolver: the manager only when
   * the attempt settled ready and the run is still fresh right now, otherwise
   * undefined. Never starts or waits for a restore.
   */
  readyManager(): M | undefined;
}

type SaveGate = "pending" | "open" | "closed";

/** Bounded rejection reason for a save whose associations were not durably recorded. */
export class NativeManagedAssociationSaveError extends Error {
  constructor(readonly reason: string) {
    super(`Native owner execution associations were not durably recorded (${reason}); already admitted work remains admitted and was not cancelled by this save failure.`);
    this.name = "NativeManagedAssociationSaveError";
  }
}

/** Create the restore handle for one exact native owner run. Nothing runs until `restore()`. */
export function createNativeManagedOwnerRestore<M extends NativeManagedRestorableManager>(
  options: NativeManagedOwnerRestoreOptions<M>,
): NativeManagedOwnerRestore<M> {
  // Bind every input once, so later caller mutation cannot switch the owner,
  // the state root, the freshness proof, or the factory mid-flight.
  const { stateRoot, isCurrent, createManager } = options;
  const owner = detachOwner(options.owner);
  const readHooks = options.testHooks?.read;
  const publicationHooks = options.testHooks?.publication;
  let attempt: Promise<NativeManagedOwnerRestoreResult<M>> | undefined;
  let settled: NativeManagedOwnerRestoreResult<M> | undefined;
  let revoked = false;

  /** Sticky freshness: once the run reads as revoked (or the proof throws), it stays revoked. */
  const fresh = (): boolean => {
    if (revoked) return false;
    let current = false;
    try {
      current = isCurrent() === true;
    } catch {
      current = false;
    }
    if (!current) revoked = true;
    return current;
  };

  /** Re-prove freshness for one hand-out of a settled result. */
  const handOut = (result: NativeManagedOwnerRestoreResult<M>): NativeManagedOwnerRestoreResult<M> =>
    result.status === "ready" && !fresh() ? { status: "stale", retainedManager: result.manager } : result;

  const run = async (): Promise<NativeManagedOwnerRestoreResult<M>> => {
    if (owner === undefined) return { status: "unavailable", reason: "invalid-owner" };
    if (!fresh()) return { status: "stale" };
    const read = await readNativeManagedAssociations(stateRoot, owner, readHooks);
    if (!fresh()) return { status: "stale" };

    // As in Pi, an unavailable sidecar keeps persistence closed but does
    // not hide tools for the current, proved conversation.
    let gate: SaveGate = read.status === "unavailable" ? "closed" : "pending";
    let declinedBeforeRestore = false;
    const publish = async (associations: ExecutionAssociationsSnapshot): Promise<NativeManagedAssociationWriteResult> => {
      try {
        return await writeNativeManagedAssociations(stateRoot, owner, associations, publicationHooks);
      } catch {
        return { status: "failed", reason: "publication-failed" };
      }
    };
    const save: NativeManagedAssociationSave = async (associations) => {
      if (gate === "pending") {
        // Nothing may replace the persisted owner state before the canonical
        // restore is proven complete; the full snapshot is published afterwards.
        declinedBeforeRestore = true;
        return undefined;
      }
      // The restore result already reports the failure. Never overwrite the owner
      // file, and never turn a retained group's lifecycle save into a task failure.
      if (gate === "closed") return undefined;
      const result = await publish(associations);
      if (result.status !== "published") throw new NativeManagedAssociationSaveError(`${result.status}: ${result.reason}`);
      // Association durability only: never a parent-checkpoint acknowledgement.
      return undefined;
    };

    let manager: M;
    try {
      manager = createManager(save);
      if (!isRestorableManager(manager)) throw new TypeError("not a restorable manager");
    } catch {
      gate = "closed";
      return { status: "failed", reason: "manager-construction-failed" };
    }

    const ready = (diagnostic?: NativeManagedOwnerRestoreDiagnostic): NativeManagedOwnerRestoreResult<M> => {
      if (!fresh()) return { status: "stale", retainedManager: manager };
      return {
        status: "ready", manager, source: read.status,
        ...(read.status === "loaded" ? { revision: read.revision } : {}),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      };
    };
    // The same non-authoritative fallback as Pi: a failed read/restore is
    // not evidence that the previous runtime or its recovery state was empty.
    const fallback = async (diagnostic: NativeManagedOwnerRestoreDiagnostic): Promise<NativeManagedOwnerRestoreResult<M>> => {
      gate = "closed";
      if (!fresh()) return { status: "stale", retainedManager: manager };
      try {
        await manager.restoreAssociations({ waveRoots: [], bundles: [] }, { authoritative: false }, () => undefined);
      } catch {
        return { status: "failed", reason: "restore-failed", retainedManager: manager };
      }
      return ready(diagnostic);
    };
    if (read.status === "unavailable") return fallback({ stage: "read", reason: read.reason });
    const snapshot: ExecutionAssociationsSnapshot = read.status === "loaded"
      ? read.associations
      : { waveRoots: [], bundles: [], groupRoots: [] };
    let recovery: ExecutionRestoreResult | void;
    try {
      // The shared result carries safe categories. Raw Pi restore notices
      // can contain workspace paths and are not forwarded into the sidebar.
      recovery = await manager.restoreAssociations(snapshot, undefined, () => undefined);
    } catch {
      return fallback({ stage: "restore", reason: "restore-failed" });
    }
    let live: ExecutionAssociationsSnapshot | undefined;
    try {
      live = manager.associations();
    } catch {
      live = undefined;
    }
    // The shared restorer owns completeness, including durable rewrites and
    // the precise set of references normal cleanup released. No classification
    // is not evidence that overwriting the owner file is safe.
    if (!recovery?.recovery.complete || live === undefined) {
      // Keep the usable live scope and attached groups. Do not replace an
      // owner file that still carries unresolved history.
      gate = "closed";
      const references = recovery && [...new Set(recovery.recovery.reasons.map(({ code }) => code))].slice(0, 3);
      return ready({ stage: "restore", reason: "restore-incomplete", ...(references?.length ? { references } : {}) });
    }
    gate = "open";
    // The deferred save publishes exactly the snapshot that was just verified.
    const deferredPublished = !declinedBeforeRestore || (await publish(live)).status === "published";
    return ready(deferredPublished ? undefined : { stage: "publish", reason: "publication-failed" });
  };

  return {
    owner,
    restore: async () => {
      attempt ??= run()
        .catch((): NativeManagedOwnerRestoreResult<M> => ({ status: "failed", reason: "restore-failed" }))
        .then((result) => (settled = result));
      return handOut(await attempt);
    },
    readyManager: () => {
      if (settled?.status !== "ready") return undefined;
      return fresh() ? settled.manager : undefined;
    },
  };
}

/**
 * Validate the caller's exact owner key (exact keys, the store's own rules),
 * then detach and freeze one copy and validate that copy too, so an accessor
 * that changes between reads can never smuggle an unvalidated owner through.
 */
function detachOwner(value: unknown): NativeManagedAssociationOwner | undefined {
  try {
    if (!isValidNativeManagedAssociationOwner(value)) return undefined;
    const { slotId, backend, conversationId, workspace } = value;
    const copy: NativeManagedAssociationOwner = Object.freeze({ slotId, backend, conversationId, workspace });
    return isValidNativeManagedAssociationOwner(copy) ? copy : undefined;
  } catch {
    return undefined;
  }
}

function isRestorableManager(value: unknown): value is NativeManagedRestorableManager {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NativeManagedRestorableManager>;
  return typeof candidate.restoreAssociations === "function" && typeof candidate.associations === "function";
}
