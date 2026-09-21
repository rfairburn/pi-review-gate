import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { unresolvedConflictMarkers } from "./conflict-materialization";
import { sourceMutationCoordinator } from "./source-mutation-lease";

/**
 * One outstanding landing conflict gate (#25 multi-target). Gates are keyed to
 * the resolved source root: different targets keep independent gates and
 * lease blocks, so concurrent conflicts on separate repositories cannot
 * overwrite, early-release, or leak each other's block; landings into an
 * already-gated root serialize behind that root's block in the coordinator
 * instead.
 */
export interface ConflictGate {
  executionId: string;
  taskId: string;
  sourceRoot: string;
  paths: string[];
  activatedAt: string;
  manifestPath: string;
  reason: string;
  /** #126 approved (explicit force-merge only): conflicted paths whose content
   * could not carry text markers and was preserved instead. Entries with a
   * `sidecarPath` keep the worker version alongside the intact target — the
   * conflict stays unresolved while that file still exists and markClean
   * validates it. Entries without one record a worker-side deletion: no bytes
   * were fabricated, so resolution is the orchestrator's explicit act after
   * inspecting the gate and its manifest. */
  sidecars?: Array<{ path: string; sidecarPath?: string }>;
}

/** Copy a gate for snapshot/inspection exposure without sharing its path array. */
export function cloneConflictGate(gate: ConflictGate): ConflictGate {
  return { ...gate, paths: [...gate.paths] };
}

/** One outstanding gate plus the handle that releases its source-mutation block. */
export interface ConflictGateEntry {
  key: string;
  gate: ConflictGate;
  release: () => void;
}

/**
 * Storage, identity, activation, and validation for the controller's
 * outstanding conflict gates. The store owns only gate bookkeeping: it holds
 * one gate per resolved source root, blocks and releases that root in the
 * source-mutation coordinator, and validates whether unresolved conflict
 * markers or preserved sidecars still block clearance. Lifecycle decisions —
 * task transitions, persistence, notifications, aggregates, and the
 * force-merge transaction — remain with the controller, which sequences this
 * store's operations.
 */
export class ConflictGateStore {
  private readonly gates = new Map<string, { gate: ConflictGate; release: () => void }>();

  /** Number of outstanding gates (one per gated source root). */
  get size(): number {
    return this.gates.size;
  }

  /**
   * #25 multi-target: install one target's conflict gate and its lease block,
   * keyed by resolved source root. A same-root successor releases only that
   * root's prior block — a different target's gate and block stay untouched.
   */
  install(gate: ConflictGate): void {
    const key = resolve(gate.sourceRoot);
    this.gates.get(key)?.release();
    this.gates.set(key, {
      gate,
      release: sourceMutationCoordinator.block(gate.sourceRoot, gate.reason),
    });
  }

  /** The outstanding gate for one execution group, if any (at most one per group). */
  forExecution(executionId: string): ConflictGate | undefined {
    for (const { gate } of this.gates.values()) {
      if (gate.executionId === executionId) return gate;
    }
    return undefined;
  }

  /** The outstanding gate for one exact task, if any. */
  forTask(executionId: string, taskId: string): ConflictGate | undefined {
    for (const { gate } of this.gates.values()) {
      if (gate.executionId === executionId && gate.taskId === taskId) return gate;
    }
    return undefined;
  }

  /** Every outstanding gate (snapshot of the gates only, no release handles). */
  list(): ConflictGate[] {
    return [...this.gates.values()].map(({ gate }) => gate);
  }

  /**
   * Snapshot of the current outstanding entries for validation/clearing
   * callers: a gate installed after this snapshot is taken is not validated
   * and not cleared by the caller's loop, matching the prior snapshot
   * semantics exactly.
   */
  entries(): ConflictGateEntry[] {
    return [...this.gates.entries()].map(([key, { gate, release }]) => ({ key, gate, release }));
  }

  /** Drop one entry's bookkeeping without releasing its lease block. */
  delete(key: string): void {
    this.gates.delete(key);
  }

  /**
   * Release every outstanding root's block and drop all gates. Detach uses
   * this; the persisted snapshot re-blocks each gate on restore.
   */
  clear(): void {
    for (const { release } of this.gates.values()) release();
    this.gates.clear();
  }

  /**
   * Validate every outstanding gate before any clearance: unresolved diff3
   * markers (preserved sidecar conflicts are excluded from the marker scan)
   * and preserved sidecars still present alongside their target each keep the
   * clearance blocked. Returns one dirty reason per finding, root-prefixed
   * when several gates are outstanding so each dirty target stays actionable;
   * the single-gate message keeps its exact prior shape.
   */
  async unresolvedReasons(): Promise<string[]> {
    const entries = this.entries();
    const dirty: string[] = [];
    for (const { gate } of entries) {
      // #126 approved force-only fallback: preserved non-text conflicts
      // (symlink/type change, oversized side, worker-side deletion) never carry
      // diff3 markers, and their destination may be a symlink or a large/special
      // file. Reading them adds no verification value and could follow an unsafe
      // symlink or allocate unboundedly, so they are excluded from the marker
      // scan; their resolution is governed by the sidecar check below plus the
      // explicit markClean attestation.
      const preserved = new Set((gate.sidecars ?? []).map((sidecar) => sidecar.path));
      const unresolved = await unresolvedConflictMarkers(
        gate.sourceRoot,
        gate.paths.filter((path) => !preserved.has(path)),
      );
      if (unresolved.length > 0) {
        dirty.push(entries.length === 1 ? unresolved.join(", ") : `${gate.sourceRoot}: ${unresolved.join(", ")}`);
      }
      // #126 approved (explicit force-merge only): a preserved conflict is
      // resolved only once the worker version saved alongside has been handled
      // (chosen or discarded). While it still exists, the gate stays
      // unresolved. Record-only entries (worker-side deletion) have no file to
      // check; their resolution is the orchestrator's explicit act attested by
      // markClean.
      for (const sidecar of gate.sidecars ?? []) {
        if (!sidecar.sidecarPath) continue;
        const present = await stat(sidecar.sidecarPath).catch(() => undefined);
        if (present) {
          dirty.push(entries.length === 1
            ? `preserved conflict ${sidecar.path} still has its worker version saved alongside at ${sidecar.sidecarPath}; choose a side and remove the other file`
            : `${gate.sourceRoot}: preserved conflict ${sidecar.path} still has its worker version saved alongside at ${sidecar.sidecarPath}`);
        }
      }
    }
    return dirty;
  }
}