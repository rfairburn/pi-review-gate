import { type ReviewGateConfig } from "../config";
import { releaseReviewCheckpoint } from "../review-checkpoint";
import { type ExecutionAssociationsSnapshot, type SessionStateStore } from "../session-state";
import { ownedReviewCheckpointDescriptors, type ReviewGateState } from "../state";
import { reviewCheckpointDescriptorIdentity } from "../session-state";
import { sendNoticeUnlessItThrows } from "./diagnostics";

type Owner = ReturnType<typeof ownedReviewCheckpointDescriptors>[number];

export interface SessionPersistenceDependencies {
  /** Host object for best-effort persistence notices. */
  pi: unknown;
  /** Canonical review-gate state, sampled when each queued save executes. */
  state: ReviewGateState;
  isSessionActive: () => boolean;
  /**
   * Live execution-association snapshot for the save. Resolves undefined only
   * while the execution manager itself is unavailable, which blocks the save.
   */
  associations: () => ExecutionAssociationsSnapshot | undefined;
  /** Effective (frozen or materialized) review config for the save digest. */
  reviewConfig: () => ReviewGateConfig;
}

export interface SessionPersistence {
  /** Bind (or unbind) the late session store; called only from session_start. */
  bindStore(store: SessionStateStore | undefined): void;
  /** Await every save/release already admitted to the serialized tail. */
  awaitSaveTail(): Promise<void>;
  /**
   * Ordinary save: resolves without writing when there is no state store or
   * the session has gone inactive (unless forced). Resolving without writing
   * is NOT durable proof; use persistConfirmed/persistAutomaticDelivery where
   * a real write must be acknowledged.
   */
  persist(force?: boolean): Promise<void>;
  /** True only when a real durable save plus owner retirement completed. */
  persistConfirmed(): Promise<boolean>;
  /** Durable-boolean save used by the automatic-delivery uncertainty gate. */
  persistAutomaticDelivery(): Promise<boolean>;
  /** The serialized save-and-release operation itself (admission-sampled). */
  saveAndRetire(store: SessionStateStore): Promise<boolean>;
  /** Drop all ledger entries for a new session. */
  resetLedger(): void;
  /** Adopt the restored state's checkpoint owners as durable. */
  adoptRestoredOwners(): void;
  /** Drain the bound store's write tail (no-op when unbound). */
  drain(): Promise<void>;
}

export function createSessionPersistence(deps: SessionPersistenceDependencies): SessionPersistence {
  let stateStore: SessionStateStore | undefined;
  // Only verified, durably written owners enter this ledger. Retain failed
  // releases for retry; a quarantined/damaged restore never enters it.
  let durableOwners = new Map<string, Owner>();
  let ownerSaveTail = Promise.resolve();
  let latestSavedOwners = new Map<string, Owner>();
  const retiredOwnerIds = new Set<string>();

  const ownersOf = () => new Map(ownedReviewCheckpointDescriptors(deps.state).map((owner) =>
    [reviewCheckpointDescriptorIdentity(owner.cwd, owner.descriptor), owner]));

  const saveWithOwnerRetirement = (store: SessionStateStore): Promise<boolean> => {
    // Admit saves one at a time, including the entire release. A new save
    // cannot put a descriptor back on disk while its old pin is being removed.
    // Sample state at admission (not invocation), when save() serializes it.
    const operation = ownerSaveTail.then(async (): Promise<boolean> => {
      if (store !== stateStore) return false;
      const savedOwners = ownersOf();
      if ([...savedOwners.keys()].some((id) => retiredOwnerIds.has(id))) {
        await sendNoticeUnlessItThrows(deps.pi, "review gate: a retired checkpoint was re-armed while its prior owner was being released; persistence blocked. Capture a fresh checkpoint before reviewing");
        throw new Error("review gate: retired checkpoint re-armed; capture a fresh checkpoint before reviewing");
      }
      // Throws are not acknowledgements. The next queued save still runs;
      // this operation never suppresses a previously confirmed retirement.
      const associations = deps.associations();
      if (associations === undefined) throw new Error("review gate: execution tools unavailable during session save");
      const saved = await store.save(deps.state, associations, deps.reviewConfig());
      if (!saved) {
        if ([...durableOwners.keys()].some((id) => !savedOwners.has(id))) {
          await sendNoticeUnlessItThrows(deps.pi, "review gate: checkpoint owners retained because the session-state save is unavailable; the prior sidecar still owns them. Repair persistence and restart before relying on a cleared window");
        }
        return false;
      }
      latestSavedOwners = savedOwners;
      for (const [id, owner] of savedOwners) durableOwners.set(id, owner);
      for (const [id, owner] of durableOwners) {
        if (latestSavedOwners.has(id) || ownersOf().has(id)) continue;
        const released = await releaseReviewCheckpoint(owner.cwd, owner.descriptor, { scope: deps.state.checkpointScope });
        if (released.status !== "ok") {
          await sendNoticeUnlessItThrows(deps.pi, `review gate: retained checkpoint owner; release failed (${released.reason}). Inspect the checkpoint store and retry after repairing storage; no review success is implied`);
          throw new Error(`review gate: retained checkpoint owner; release failed (${released.reason}): ${released.detail}`);
        }
        durableOwners.delete(id);
        retiredOwnerIds.add(id);
      }
      return true;
    });
    ownerSaveTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const saveDurable = async (): Promise<boolean> => {
    if (!stateStore || !deps.isSessionActive()) return false;
    return saveWithOwnerRetirement(stateStore);
  };

  return {
    bindStore(store) {
      stateStore = store;
    },
    awaitSaveTail() {
      return ownerSaveTail;
    },
    async persist(force = false) {
      if (!stateStore || (!deps.isSessionActive() && !force)) return;
      await saveWithOwnerRetirement(stateStore);
    },
    persistConfirmed: () => saveDurable(),
    persistAutomaticDelivery: () => saveDurable(),
    saveAndRetire: (store) => saveWithOwnerRetirement(store),
    resetLedger() {
      durableOwners = new Map();
      latestSavedOwners = new Map();
      retiredOwnerIds.clear();
    },
    adoptRestoredOwners() {
      durableOwners = ownersOf();
      latestSavedOwners = new Map(durableOwners);
    },
    async drain() {
      await stateStore?.drain();
    },
  };
}
