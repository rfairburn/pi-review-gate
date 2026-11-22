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
 * Restore completeness. A fulfilled `restoreAssociations` does not by itself
 * prove the snapshot was restored: the controller reports an unreadable group
 * record, a failed durable rewrite of an attached group, or an unadoptable
 * bundle through its restore-specific diagnostic callback and continues, and a
 * superseded restore returns without attaching. Because every later save
 * replaces the owner file with the manager's live `associations()`, the restore
 * counts as complete only when (a) the canonical restore reported no failure
 * diagnostic (only the fact is recorded; its text is neither kept nor
 * forwarded) and (b) every reference the loaded snapshot carried is still
 * present in the manager's live snapshot afterwards: each group root and wave
 * root (the loaded snapshot must carry an explicit group roster: an omitted
 * one is unknown ownership, never empty), each bundle by its full stable identity with a non-regressing revision,
 * and each conflict gate with all of its durable fields. Otherwise the outcome
 * is `restore-incomplete`, persistence stays closed for good, and the owner file
 * is left byte-identical, so the missing work stays recoverable.
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
 *   does not reject. The restore result already reports the failure, and a
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
 * groups. A stale or failed outcome after construction never exposes it as
 * ready, but it is handed back as `retainedManager` and is never cancelled,
 * shut down, or detached here. After a complete restore its save callback stays
 * open even when the run is later revoked, so admitted work keeps its durable
 * record for the same exact owner. Retiring it, and doing so before restoring
 * the same exact owner again, is the host's lifecycle decision.
 *
 * Out of scope by design: host startup wiring, policy/config, scope
 * resolution, callbacks/notifications, and any cross-owner registry.
 */
import { resolve } from "node:path";

import type { ReattachmentBundle } from "../execution/operation-record";
import type { ExecutionToolManager } from "../execution/tool";
import type { ParentCheckpointSaveResult } from "../execution/parent-checkpoint-ledger";
import type { ExecutionAssociationsSnapshot, PersistedConflictGate } from "../session-state";
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

export type NativeManagedOwnerRestoreResult<M> =
  /** Completely restored and fresh at this hand-out: the only exposable outcome. */
  | {
    readonly status: "ready";
    readonly manager: M;
    readonly source: "loaded" | "absent";
    /** Store revision that was loaded (absent for an empty restore). */
    readonly revision?: number;
  }
  /** The owner's durable state could not be established; no manager was constructed. */
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
    if (read.status === "unavailable") return { status: "unavailable", reason: read.reason };

    let gate: SaveGate = "pending";
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

    const snapshot: ExecutionAssociationsSnapshot = read.status === "loaded"
      ? read.associations
      : { waveRoots: [], bundles: [], groupRoots: [] };
    // The canonical restore reports each per-item failure through this
    // restore-specific callback and then continues; record the fact only.
    let restoreReportedFailure = false;
    try {
      await manager.restoreAssociations(snapshot, undefined, () => { restoreReportedFailure = true; });
    } catch {
      // Never let a manager whose restore failed overwrite the owner file.
      gate = "closed";
      return { status: "failed", reason: "restore-failed", retainedManager: manager };
    }
    let live: ExecutionAssociationsSnapshot | undefined;
    try {
      live = manager.associations();
    } catch {
      live = undefined;
    }
    if (restoreReportedFailure || live === undefined || !preservesReferences(snapshot, live)) {
      // Attached groups stay attached; only the owner file is protected.
      gate = "closed";
      return { status: "failed", reason: "restore-incomplete", retainedManager: manager };
    }
    gate = "open";
    // The deferred save publishes exactly the snapshot that was just verified.
    const deferredPublished = !declinedBeforeRestore || (await publish(live)).status === "published";
    if (!fresh()) return { status: "stale", retainedManager: manager };
    if (!deferredPublished) return { status: "failed", reason: "publication-failed", retainedManager: manager };
    return read.status === "loaded"
      ? { status: "ready", manager, source: "loaded", revision: read.revision }
      : { status: "ready", manager, source: "absent" };
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
 * True when every reference the loaded snapshot carried is still present in the
 * manager's live snapshot, so replacing the owner file with the live snapshot
 * cannot drop anything that was persisted.
 */
function preservesReferences(loaded: ExecutionAssociationsSnapshot, live: ExecutionAssociationsSnapshot): boolean {
  // An omitted roster is unknown ownership, not an authoritative empty set (the
  // canonical controller's own rule): a later save must never turn it into one.
  if (!Array.isArray(loaded.groupRoots) || !Array.isArray(loaded.bundles) || !Array.isArray(loaded.waveRoots)) return false;
  try {
    const liveGroups = new Set((live.groupRoots ?? []).map((root) => resolve(root)));
    const liveWaves = new Set((live.waveRoots ?? []).map((root) => resolve(root)));
    // Highest live revision per full stable bundle identity.
    const liveBundles = new Map<string, number>();
    for (const bundle of live.bundles ?? []) {
      const key = bundleKey(bundle);
      liveBundles.set(key, Math.max(liveBundles.get(key) ?? -1, bundle.expectedRevision));
    }
    const liveGates = new Set(gatesOf(live).map(gateKey));
    return loaded.groupRoots.every((root) => liveGroups.has(resolve(root)))
      && loaded.waveRoots.every((root) => liveWaves.has(resolve(root)))
      && loaded.bundles.every((bundle) => Number.isSafeInteger(bundle.expectedRevision)
        && bundle.expectedRevision >= 0
        && (liveBundles.get(bundleKey(bundle)) ?? -1) >= bundle.expectedRevision)
      && gatesOf(loaded).every((gate) => liveGates.has(gateKey(gate)));
  } catch {
    return false;
  }
}

function gatesOf(snapshot: ExecutionAssociationsSnapshot): readonly PersistedConflictGate[] {
  return snapshot.conflictGates ?? (snapshot.conflictGate ? [snapshot.conflictGate] : []);
}

/** The full stable identity of a reattachment bundle (its revision is compared separately). */
function bundleKey(bundle: ReattachmentBundle): string {
  return JSON.stringify([bundle.version, bundle.operationId, bundle.waveId, bundle.taskId, resolve(bundle.waveRoot)]);
}

/** Every durable field of a persisted conflict gate, in a fixed order. */
function gateKey(gate: PersistedConflictGate): string {
  return JSON.stringify([
    gate.executionId,
    gate.taskId,
    resolve(gate.sourceRoot),
    gate.paths,
    gate.activatedAt,
    gate.manifestPath,
    gate.reason,
    gate.sidecars?.map(({ path, sidecarPath }) => [path, sidecarPath ?? null]) ?? null,
  ]);
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
