/**
 * #781 — the shared Pi/host restore classification rule.
 *
 * These cases pin the asymmetry the rule exists to enforce: a reference is
 * reconciled out of the persisted record only on positive evidence that it is
 * gone or durably resolved, and every other kind of "not there" keeps the
 * reference required. Nothing here (or in the rule) deletes or adopts a
 * directory.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import {
  MAX_EXECUTION_RESTORE_REASONS,
  collapsedConflictGateRoots,
  describeExecutionRestore,
  executionBundleIdentity,
  executionBundleIsPreservedBy,
  executionGateIdentity,
  executionGateIsPreservedBy,
  isExecutionPathPositivelyAbsent,
  reconcileExecutionRestore,
  persistableExecutionAssociations,
  supersededExecutionRestore,
  type ExecutionRestoreEvidence,
  type ExecutionRestoreGroupOutcome,
  type ExecutionRestoreLiveState,
} from "../src/execution/restore-reconciliation";
import type { ReattachmentBundle } from "../src/execution/operation-record";
import type { BackgroundTaskRecord } from "../src/execution/task-state";
import type { ExecutionAssociationsSnapshot, PersistedConflictGate } from "../src/session-state";
import { collidingTaskRecord } from "./helpers/background-controller-fixtures";

const EMPTY_NO_EVIDENCE: ExecutionRestoreEvidence = {
  groupOutcomes: new Map(),
  groupSaveFailures: new Map(),
  bundleAdoptionFailures: new Map(),
  clearedGateIdentities: new Set(),
  collapsedGateRoots: new Set(),
  taskRecoveryFailures: new Map(),
};
const NO_LIVE: ExecutionRestoreLiveState = { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set() };

function snapshot(overrides: Partial<ExecutionAssociationsSnapshot> = {}): ExecutionAssociationsSnapshot {
  return { waveRoots: [], bundles: [], groupRoots: [], ...overrides };
}

function bundle(waveRoot: string, overrides: Partial<ReattachmentBundle> = {}): ReattachmentBundle {
  return { version: 1, operationId: "op-1", waveId: "wave-1", taskId: "task-1", waveRoot, expectedRevision: 3, ...overrides };
}

function gate(sourceRoot: string, overrides: Partial<PersistedConflictGate> = {}): PersistedConflictGate {
  return {
    executionId: "exec-1",
    taskId: "task-1",
    sourceRoot,
    paths: ["a.ts"],
    activatedAt: "2026-01-01T00:00:00.000Z",
    manifestPath: "/tmp/manifest.json",
    reason: "conflict",
    ...overrides,
  };
}

function task(taskId: string, state: BackgroundTaskRecord["state"], overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord {
  return { ...collidingTaskRecord(taskId, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "summary"), state, ...overrides };
}

function salvageRetained(taskId: string, waveRoot?: string): BackgroundTaskRecord {
  const record = task(taskId, "landed", waveRoot === undefined ? {} : { waveRoot });
  record.commands = [{
    instructionId: "cmd-1",
    action: "force_merge",
    actor: "user",
    status: "delivered",
    createdAt: "2026-01-02T00:00:00.000Z",
    salvage: {
      reason: "checkpoint unavailable",
      sourceKind: "worktree",
      candidateCommit: "a".repeat(40),
      candidateRef: "refs/review-gate/candidate",
      attributedPaths: [],
      baselineOnlyPaths: [],
      ambiguousPaths: ["keep.ts"],
    },
  }];
  return record;
}

async function withTemp<T>(run: (root: string) => Promise<T>): Promise<T> {
  // Canonicalized so a platform temp path with a symlink ancestor (for example
  // /tmp -> /private/tmp) never makes a positive control look obscured.
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-review-restore-reconcile-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a group root is reconciled only when the directory itself is positively absent", async () => await withTemp(async (root) => {
  const gone = join(root, "pi-review-execution-gone");
  const unreadable = await mkdtemp(join(root, "pi-review-execution-broken-"));
  await writeFile(join(unreadable, "execution.json"), "{ not a record", "utf8");
  const obscured = join(root, "pi-review-execution-symlink");
  await symlink(join(root, "nowhere"), obscured);

  const result = await reconcileExecutionRestore(
    snapshot({ groupRoots: [gone, unreadable, obscured] }),
    snapshot(),
    {
      groupOutcomes: new Map<string, ExecutionRestoreGroupOutcome>([
        [gone, { state: "absent" }],
        [unreadable, { state: "unavailable", detail: "Unexpected token o in JSON" }],
        [obscured, { state: "unavailable", detail: "Invalid background execution root." }],
      ]),
      groupSaveFailures: new Map(),
      bundleAdoptionFailures: new Map(),
      clearedGateIdentities: new Set(),
      collapsedGateRoots: new Set(),
      taskRecoveryFailures: new Map(),
    },
    NO_LIVE,
  );

  assert.equal(result.recovery.complete, false);
  assert.equal(result.recovery.reconciled, 1, "only the positively absent directory is collected work");
  assert.deepEqual(result.associations.groupRoots, [unreadable, obscured],
    "an existing directory with a missing or unusable manifest, and a symlinked root, stay required");
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["group-unavailable", "group-unavailable"]);
  assert.match(result.recovery.reasons[0]!.detail, /Unexpected token/);
}));

test("an absent directory is never reported as a failed read", async () => await withTemp(async (root) => {
  const missing = join(root, "wave-nothing");
  const existing = await mkdtemp(join(root, "wave-existing-"));
  const dangling = join(root, "wave-dangling");
  const blocker = join(root, "a-file");
  await symlink(join(root, "nowhere"), dangling);
  const notADirectory = join(blocker, "wave-child");
  await writeFile(blocker, "not a directory", "utf8");

  assert.equal(await isExecutionPathPositivelyAbsent(missing), true);
  assert.equal(await isExecutionPathPositivelyAbsent(existing), false);
  assert.equal(await isExecutionPathPositivelyAbsent(dangling), false, "a symlink leaf is an existing entry");
  assert.equal(await isExecutionPathPositivelyAbsent(notADirectory), false, "ENOTDIR is never evidence of absence");
  assert.equal(await isExecutionPathPositivelyAbsent(""), false);
  assert.equal(await isExecutionPathPositivelyAbsent(undefined), false);
  await rm(existing, { recursive: true, force: true });
}));

test("a collected wave and bundle of settled, ungated work are reconciled out", async () => await withTemp(async (root) => {
  const wave = join(root, "wave-collected");
  const live = snapshot({ groupRoots: [join(root, "pi-review-execution-live")] });
  const result = await reconcileExecutionRestore(
    snapshot({
      groupRoots: [join(root, "pi-review-execution-live")],
      waveRoots: [wave],
      bundles: [bundle(wave)],
    }),
    { ...live, groupRoots: [join(root, "pi-review-execution-live")] },
    EMPTY_NO_EVIDENCE,
    { tasks: [task("task-1", "reported")], restoredTaskHandles: [], gatedTaskIds: new Set() },
  );

  assert.equal(result.recovery.complete, true, "collected completed work is not a failed restore");
  assert.equal(result.recovery.reconciled, 2);
  assert.deepEqual(result.associations.waveRoots, []);
  assert.deepEqual(result.associations.bundles, []);
  assert.deepEqual(result.associations.groupRoots, [join(root, "pi-review-execution-live")]);
}));

test("in-flight, gated, and salvage-retained claimants keep their references required", async () => await withTemp(async (root) => {
  const wave = join(root, "wave-collected");
  const cases: Array<[string, ExecutionRestoreLiveState]> = [
    ["unsettled", { tasks: [task("task-1", "paused_recoverable", { waveRoot: wave })], restoredTaskHandles: [], gatedTaskIds: new Set() }],
    ["gated", { tasks: [task("task-1", "landed", { waveRoot: wave })], restoredTaskHandles: [], gatedTaskIds: new Set(["task-1"]) }],
    ["salvage-retained", { tasks: [salvageRetained("task-1", wave)], restoredTaskHandles: [], gatedTaskIds: new Set() }],
  ];
  for (const [label, liveState] of cases) {
    const result = await reconcileExecutionRestore(
      snapshot({ waveRoots: [wave], bundles: [bundle(wave)] }),
      snapshot(),
      EMPTY_NO_EVIDENCE,
      liveState,
    );
    assert.equal(result.recovery.complete, false, `${label}: a reference that cleanup could not have collected stays required`);
    assert.equal(result.recovery.reconciled, 0, label);
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["bundle-in-flight"], `${label}: the wave the required bundle names is protected by that bundle, without a duplicate reason`);
    assert.deepEqual(result.associations.waveRoots, [wave], label);
    assert.deepEqual(result.associations.bundles.length, 1, label);
  }
}));

test("a surviving wave or bundle is never called collected", async () => await withTemp(async (root) => {
  const wave = await mkdtemp(join(root, "wave-surviving-"));
  const result = await reconcileExecutionRestore(
    snapshot({ waveRoots: [wave], bundles: [bundle(wave)] }),
    snapshot(),
    EMPTY_NO_EVIDENCE,
    NO_LIVE,
  );
  assert.equal(result.recovery.complete, false);
  assert.equal(result.recovery.reconciled, 0, "canonical bundle recovery may still apply to a surviving wave root");
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["bundle-unrecoverable"],
    "the surviving wave is kept silently because the required bundle already reports it");
  await rm(wave, { recursive: true, force: true });
}));

test("a preserved bundle does not stand in for its own missing wave roster entry", async () => await withTemp(async (root) => {
  const wave = await mkdtemp(join(root, "wave-roster-missing-"));
  // The bundle survived in the live snapshot; only its wave-roster entry was
  // lost. Reporting `complete` here would let a save that trusts it drop a root
  // that canonical recovery still needs.
  const result = await reconcileExecutionRestore(
    snapshot({ waveRoots: [wave], bundles: [bundle(wave)] }),
    snapshot({ waveRoots: [], bundles: [bundle(wave)] }),
    EMPTY_NO_EVIDENCE,
    NO_LIVE,
  );
  assert.equal(result.recovery.complete, false, "a live bundle match proves the operation, not this roster entry");
  assert.deepEqual(result.recovery.reasons.map((reason) => [reason.kind, reason.code]), [["wave", "wave-unclaimed"]]);
  assert.match(result.recovery.reasons[0]!.detail, /does not stand in for this snapshot's own wave roster entry/);
  assert.deepEqual(result.associations.waveRoots, [wave], "the required wave root is retained, never reconciled out");
  assert.deepEqual(result.associations.bundles, [bundle(wave)]);

  // With its own live roster entry present, the same bundle is fully restored.
  const intact = await reconcileExecutionRestore(
    snapshot({ waveRoots: [wave], bundles: [bundle(wave)] }),
    snapshot({ waveRoots: [wave], bundles: [bundle(wave)] }),
    EMPTY_NO_EVIDENCE,
    NO_LIVE,
  );
  assert.equal(intact.recovery.complete, true);
  assert.deepEqual(intact.recovery.reasons, []);
  await rm(wave, { recursive: true, force: true });
}));

test("a task whose association could not be re-authenticated keeps its references required even though its record still names them", async () => await withTemp(async (root) => {
  const wave = join(root, "wave-gone");
  const liveTask = task("task-1", "paused_recoverable", { waveRoot: wave, bundle: bundle(wave) });
  const result = await reconcileExecutionRestore(
    snapshot({ waveRoots: [wave], bundles: [bundle(wave)] }),
    snapshot({ waveRoots: [wave], bundles: [bundle(wave)] }),
    { ...EMPTY_NO_EVIDENCE, taskRecoveryFailures: new Map([["task-1", "Recovery checkpoint is not verified: missing"]]) },
    { tasks: [liveTask], restoredTaskHandles: [], gatedTaskIds: new Set() },
  );
  assert.equal(result.recovery.complete, false);
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["bundle-in-flight"]);
  assert.match(result.recovery.reasons[0]!.detail, /checkpoint is not verified/);
}));

test("conflict gates: a proven clearance reconciles, a collapse or unexplained absence stays required", async () => await withTemp(async (root) => {
  const clearedRoot = join(root, "target-cleared");
  const collapsedRoot = join(root, "target-collapsed");
  const vanishedRoot = join(root, "target-vanished");
  const incoming = snapshot({
    conflictGates: [
      gate(clearedRoot),
      gate(collapsedRoot, { taskId: "task-a" }),
      gate(collapsedRoot, { taskId: "task-b", paths: ["b.ts"] }),
      gate(vanishedRoot, { taskId: "task-c" }),
    ],
  });
  const result = await reconcileExecutionRestore(
    incoming,
    snapshot({ conflictGates: [gate(collapsedRoot, { taskId: "task-b", paths: ["b.ts"] })] }),
    {
      groupOutcomes: new Map(),
      groupSaveFailures: new Map(),
      bundleAdoptionFailures: new Map(),
      clearedGateIdentities: new Set([executionGateIdentity(gate(clearedRoot))]),
      collapsedGateRoots: collapsedConflictGateRoots(incoming),
      taskRecoveryFailures: new Map(),
    },
    NO_LIVE,
  );

  assert.equal(result.recovery.reconciled, 1, "only the gate this session durably cleared is resolved");
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["gate-collapsed", "gate-unclaimed"]);
  assert.equal(result.associations.conflictGates?.length, 3,
    "both same-root gate records and the unexplained absence stay in the record; nothing is adopted or deleted");
  assert.deepEqual(collapsedConflictGateRoots(incoming), new Set([collapsedRoot]));
}));

test("clearing one gate of a same-root pair never clears its sibling", async () => await withTemp(async (root) => {
  const sourceRoot = join(root, "target-pair");
  const wave = join(root, "wave-sibling");
  const cleared = gate(sourceRoot, { taskId: "task-cleared" });
  const sibling = gate(sourceRoot, { taskId: "task-sibling", paths: ["s.ts"] });
  const incoming = snapshot({ waveRoots: [wave], bundles: [bundle(wave, { taskId: "task-sibling", operationId: "op-sibling" })], conflictGates: [cleared, sibling] });
  const result = await reconcileExecutionRestore(
    incoming,
    // The store holds one gate per root, and the drained clearance removed it.
    snapshot(),
    {
      ...EMPTY_NO_EVIDENCE,
      clearedGateIdentities: new Set([executionGateIdentity(cleared)]),
      collapsedGateRoots: collapsedConflictGateRoots(incoming),
    },
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(["task-sibling"]) },
  );

  assert.equal(result.recovery.reconciled, 1, "only the exact cleared record is resolved");
  assert.deepEqual(result.associations.waveRoots, [wave], "the sibling's wave stays required");
  assert.deepEqual(result.associations.bundles?.length, 1, "the sibling's bundle stays required");
  assert.deepEqual(result.associations.conflictGates, [sibling], "the cleared record drops, the sibling survives");
}));

test("an omitted roster stays incomplete without retaining a gate this restore actually cleared", async () => await withTemp(async (root) => {
  const sourceRoot = join(root, "target-omitted-clear");
  const wave = join(root, "wave-omitted-clear");
  const cleared = gate(sourceRoot, { taskId: "task-cleared" });
  const sibling = gate(sourceRoot, { taskId: "task-sibling", paths: ["s.ts"] });
  // A legacy persisted record: it names its gates but omits the group roster.
  const incoming = {
    waveRoots: [wave],
    bundles: [bundle(wave, { taskId: "task-sibling", operationId: "op-sibling" })],
    conflictGates: [cleared, sibling],
  } as ExecutionAssociationsSnapshot;
  const result = await reconcileExecutionRestore(
    incoming,
    snapshot(),
    {
      ...EMPTY_NO_EVIDENCE,
      clearedGateIdentities: new Set([executionGateIdentity(cleared)]),
      collapsedGateRoots: collapsedConflictGateRoots(incoming),
    },
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(["task-sibling"]) },
  );

  assert.equal(result.recovery.complete, false, "an omitted roster never becomes complete");
  assert.ok(result.recovery.reasons.some((reason) => reason.code === "roster-absent"),
    "the omitted roster is still reported as unknown ownership");
  assert.equal("groupRoots" in result.associations, false, "the omitted roster is preserved, not invented");
  assert.deepEqual(result.associations.conflictGates, [sibling],
    "a gate this restore durably cleared drops even with an omitted roster; its sibling survives");

  // The persistence projection Pi saves is built from this result and its live
  // state. If the cleared record survived classification it would be written
  // back, and the following restore would reinstall the block.
  const persisted = persistableExecutionAssociations(
    { waveRoots: [], bundles: [], conflictGates: [] },
    result.associations,
  );
  assert.deepEqual(persisted.conflictGates, [sibling],
    "the persistence projection never re-persists the gate this session cleared");
}));

test("clearing the current gate never promotes a shadowed legacy gate", async () => await withTemp(async (root) => {
  const sourceRoot = join(root, "target-shadowed-gate");
  const cleared = gate(sourceRoot, { taskId: "task-cleared" });
  const legacy = gate(sourceRoot, { taskId: "task-legacy" });
  const live = snapshot();
  const result = await reconcileExecutionRestore(
    {
      waveRoots: [], bundles: [],
      // The sidecar validator accepts both fields and the restore reader gives
      // the array precedence, so the singular record below is ignored all along.
      conflictGate: legacy,
      conflictGates: [cleared],
    },
    live,
    { ...EMPTY_NO_EVIDENCE, clearedGateIdentities: new Set([executionGateIdentity(cleared)]) },
    NO_LIVE,
  );
  assert.equal(result.recovery.complete, false, "the omitted group roster stays incomplete");
  assert.equal(result.associations.conflictGate, undefined,
    "emptying the current roster by a verified clearance never revives the shadowed fallback");
  assert.deepEqual(persistableExecutionAssociations(live, result.associations), live,
    "the persistence projection writes no stale gate back for the next restore to reinstate");
}));

test("an omitted roster reconciles nothing and never becomes an authoritative empty set", async () => await withTemp(async (root) => {
  const gone = join(root, "pi-review-execution-gone");
  const wave = join(root, "wave-gone");
  const result = await reconcileExecutionRestore(
    { waveRoots: [wave], bundles: [bundle(wave)] } as ExecutionAssociationsSnapshot,
    snapshot(),
    { ...EMPTY_NO_EVIDENCE, groupOutcomes: new Map([[gone, { state: "absent" }]]) },
    { tasks: [task("task-1", "reported")], restoredTaskHandles: [], gatedTaskIds: new Set() },
  );
  assert.equal(result.recovery.complete, false);
  assert.equal(result.recovery.reconciled, 0);
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code).includes("roster-absent"), true);
  assert.equal("groupRoots" in result.associations, false, "unknown ownership is never rewritten into an empty roster");
  assert.deepEqual(result.associations.waveRoots, [wave]);
}));

test("reasons are bounded for a notice while the reconciled total stays exact", async () => await withTemp(async (root) => {
  const many = Array.from({ length: MAX_EXECUTION_RESTORE_REASONS + 4 }, (_unused, index) => join(root, `target-${index}`));
  const result = await reconcileExecutionRestore(
    snapshot({ conflictGates: many.map((sourceRoot) => gate(sourceRoot)) }),
    snapshot(),
    EMPTY_NO_EVIDENCE,
    NO_LIVE,
  );
  assert.equal(result.recovery.reasons.length, MAX_EXECUTION_RESTORE_REASONS);
  assert.equal(result.recovery.truncated, true);
  assert.equal(result.recovery.complete, false);
  assert.equal(result.recovery.reconciled, 0);
  assert.equal(describeExecutionRestore(result), "execution restore: 0 collected, 8+ unresolved (gate:gate-unclaimed)");
  assert.equal(describeExecutionRestore(supersededExecutionRestore(snapshot())),
    "execution restore: 0 collected, 1 unresolved (group:restore-superseded)");
}));

test("a superseded restore reports the record unchanged and reconciles nothing", async () => {
  const incoming = snapshot({ groupRoots: ["/tmp/pi-review-execution-a"], waveRoots: ["/tmp/wave-a"], bundles: [bundle("/tmp/wave-a")] });
  const result = supersededExecutionRestore(incoming);
  assert.equal(result.recovery.complete, false);
  assert.equal(result.recovery.reconciled, 0);
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["restore-superseded"]);
  assert.deepEqual(result.associations, incoming);
});

test("an outstanding gate protects the absent group, its bundle, and the wave root", async () => await withTemp(async (root) => {
  const sourceRoot = join(root, "gated-target");
  const wave = join(root, "wave-gated");
  const persisted = snapshot({
    groupRoots: [join(root, "pi-review-execution-gone")],
    waveRoots: [wave],
    bundles: [bundle(wave)],
    conflictGates: [gate(sourceRoot)],
  });
  // The group is gone and its gate was never installed, so the caller still
  // reports the persisted gate's task as gated.
  const result = await reconcileExecutionRestore(
    persisted,
    snapshot({ groupRoots: [] }),
    { ...EMPTY_NO_EVIDENCE, groupOutcomes: new Map([[join(root, "pi-review-execution-gone"), { state: "absent" } as ExecutionRestoreGroupOutcome]]) },
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(["task-1"]) },
  );

  assert.equal(result.recovery.complete, false);
  assert.equal(result.recovery.reconciled, 0);
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["group-unavailable", "gate-unclaimed"]);
  assert.deepEqual(result.associations.groupRoots, persisted.groupRoots, "the missing group may own the gate's task");
  assert.deepEqual(result.associations.waveRoots, [wave], "a gated bundle's wave root is never pruned first");
  assert.equal(result.associations.bundles.length, 1);
  assert.equal(result.associations.conflictGates?.length, 1);
}));

test("a collapsed same-root gate pair keeps both gates and the bundle of the gate that could not be installed", async () => await withTemp(async (root) => {
  const sourceRoot = join(root, "collapsed-target");
  const waveA = join(root, "wave-a");
  const waveB = join(root, "wave-b");
  const incoming = snapshot({
    waveRoots: [waveA, waveB],
    bundles: [bundle(waveA, { taskId: "task-a", operationId: "op-a" }), bundle(waveB, { taskId: "task-b", operationId: "op-b" })],
    conflictGates: [gate(sourceRoot, { taskId: "task-a" }), gate(sourceRoot, { taskId: "task-b", paths: ["b.ts"] })],
  });
  // The canonical store could install only one of the two same-root gates, so
  // the caller passes every gate it still owes: the live one plus the persisted
  // sibling it could not install.
  const live = snapshot({ conflictGates: [gate(sourceRoot, { taskId: "task-b", paths: ["b.ts"] })] });
  const result = await reconcileExecutionRestore(
    incoming,
    live,
    { ...EMPTY_NO_EVIDENCE, collapsedGateRoots: collapsedConflictGateRoots(incoming) },
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(["task-a", "task-b"]) },
  );

  assert.equal(result.recovery.reconciled, 0, "neither bundle nor wave of a still-required gate is collected work");
  assert.deepEqual(result.associations.waveRoots, [waveA, waveB]);
  assert.equal(result.associations.bundles.length, 2, "the non-installed gate's bundle stays required");
  assert.equal(result.associations.conflictGates?.length, 2, "both persisted gate records survive");
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code).includes("gate-collapsed"), true);
}));

test("a walk failure no reference can show still keeps the record closed", async () => await withTemp(async (root) => {
  const group = join(root, "pi-review-execution-live");
  const result = await reconcileExecutionRestore(
    snapshot({ groupRoots: [group] }),
    snapshot({ groupRoots: [group] }),
    { ...EMPTY_NO_EVIDENCE, groupSaveFailures: new Map([[group, "EROFS: read-only file system"]]) },
    NO_LIVE,
  );
  assert.equal(result.recovery.complete, false, "an attached group that is not durable is never reported as safe to persist");
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["group-not-durable"]);
  assert.match(result.recovery.reasons[0]!.detail, /EROFS/);

  // A group-only snapshot whose manifest names an unproven in-flight operation.
  const unproven = await reconcileExecutionRestore(
    snapshot({ groupRoots: [group] }),
    snapshot({ groupRoots: [group] }),
    { ...EMPTY_NO_EVIDENCE, taskRecoveryFailures: new Map([["task-active", "Recovery checkpoint is not verified: missing"]]) },
    { tasks: [task("task-active", "paused_recoverable", { waveRoot: join(root, "wave-gone") })], restoredTaskHandles: [], gatedTaskIds: new Set() },
  );
  assert.equal(unproven.recovery.complete, false);
  assert.deepEqual(unproven.recovery.reasons.map((reason) => reason.code), ["association-unverified"]);
  assert.match(unproven.recovery.reasons[0]!.detail, /checkpoint is not verified/);
}));

test("an unresolved symlink ancestor is a path-obscured reference, while a reclaimed parent still reconciles", async () => await withTemp(async (root) => {
  // A recorded wave below a symlink whose target (an unavailable mount) is gone.
  const mountLink = join(root, "scratch-mount");
  await symlink(join(root, "gone-mount"), mountLink);
  const obscured = join(mountLink, "wave-recorded");
  assert.equal(await isExecutionPathPositivelyAbsent(obscured), false,
    "a leaf ENOENT below a dangling symlink ancestor says nothing about collection");

  // A genuinely reclaimed parent directory: the parent is gone, its parent is a
  // real directory, so the recorded child is positively absent.
  const reclaimedBase = join(root, "previous-temp");
  await mkdir(reclaimedBase);
  const reclaimedWave = join(reclaimedBase, "wave-collected");
  await rm(reclaimedBase, { recursive: true, force: true });
  assert.equal(await isExecutionPathPositivelyAbsent(reclaimedWave), true);

  // The same distinction reaches the classification.
  const obscuredResult = await reconcileExecutionRestore(
    snapshot({ waveRoots: [obscured] }),
    snapshot(),
    EMPTY_NO_EVIDENCE,
    NO_LIVE,
  );
  assert.equal(obscuredResult.recovery.reconciled, 0);
  assert.deepEqual(obscuredResult.recovery.reasons.map((reason) => reason.code), ["wave-unclaimed"]);
  assert.deepEqual(obscuredResult.associations.waveRoots, [obscured]);

  const reclaimedResult = await reconcileExecutionRestore(
    snapshot({ waveRoots: [reclaimedWave] }),
    snapshot(),
    EMPTY_NO_EVIDENCE,
    NO_LIVE,
  );
  assert.equal(reclaimedResult.recovery.reconciled, 1);
  assert.deepEqual(reclaimedResult.associations.waveRoots, []);

  // A REAL nearest parent reached through a higher redirected symlink: the
  // recorded wave may still exist under the link's current target, so the leaf
  // ENOENT is not evidence that cleanup collected it.
  const target = join(root, "replacement");
  await mkdir(join(target, "nested"), { recursive: true });
  const alias = join(root, "scratch-alias");
  await symlink(target, alias);
  const redirected = join(alias, "nested", "wave-recorded");
  assert.equal(await isExecutionPathPositivelyAbsent(redirected), false,
    "a real nearest parent above a redirected symlink is still a path-obscured reference");
  const redirectedResult = await reconcileExecutionRestore(
    snapshot({ waveRoots: [redirected] }),
    snapshot(),
    EMPTY_NO_EVIDENCE,
    NO_LIVE,
  );
  assert.equal(redirectedResult.recovery.reconciled, 0);
  assert.deepEqual(redirectedResult.associations.waveRoots, [redirected]);

  // Positive control: the same shape with a real directory chain reconciles.
  const realNested = join(root, "previous-temp", "nested");
  await mkdir(realNested, { recursive: true });
  const realWave = join(realNested, "wave-collected");
  await rm(join(root, "previous-temp"), { recursive: true, force: true });
  assert.equal(await isExecutionPathPositivelyAbsent(realWave), true);
}));

test("a bundle whose canonical adoption failed stays required despite its live match", async () => await withTemp(async (root) => {
  const wave = join(root, "wave-adopted-but-undurable");
  const incomingBundle = bundle(wave, { taskId: "task-adopt", operationId: "op-adopt" });
  const incoming = snapshot({ waveRoots: [wave], bundles: [incomingBundle] });
  // The adoption attached the group and task before its save threw, so the
  // live snapshot matches the incoming reference exactly.
  const live = snapshot({ waveRoots: [wave], bundles: [incomingBundle] });
  const result = await reconcileExecutionRestore(
    incoming,
    live,
    { ...EMPTY_NO_EVIDENCE, bundleAdoptionFailures: new Map([[executionBundleIdentity(incomingBundle), "EROFS: read-only file system"]]) },
    NO_LIVE,
  );

  assert.equal(result.recovery.complete, false, "an undurable adoption is not a restored association");
  assert.equal(result.recovery.reconciled, 0);
  assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["bundle-unrecoverable"]);
  assert.match(result.recovery.reasons[0]!.detail, /canonical adoption failed: EROFS/);
  assert.deepEqual(result.associations.waveRoots, [wave], "the adoption failure also protects the wave root");
  assert.deepEqual(result.associations.bundles?.length, 1);
}));

test("a parent segment cannot hide a redirected symlink ancestor", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX path resolution");
  await withTemp(async (root) => {
    const target = join(root, "redirected", "target");
    const alias = join(root, "alias");
    await mkdir(target, { recursive: true });
    await mkdir(join(root, "redirected", "wave"));
    await symlink(target, alias);
    const waveRoot = [alias, "..", "wave"].join(sep);
    // The recorded path really exists — through the symlink. Lexical resolve()
    // would erase the alias and certify a different, non-existent path instead.
    assert.equal((await lstat(waveRoot)).isDirectory(), true);
    assert.equal(await isExecutionPathPositivelyAbsent(waveRoot), false,
      "a parent-segment path is never certified absent");

    const input = snapshot({ waveRoots: [waveRoot], bundles: [bundle(waveRoot)] });
    const restored = await reconcileExecutionRestore(input, snapshot(), EMPTY_NO_EVIDENCE, NO_LIVE);
    assert.deepEqual(restored.associations, input, "the recorded reference is retained exactly as recorded");
    assert.equal(restored.recovery.complete, false);
    assert.equal(restored.recovery.reconciled, 0);
  });
});

test("an archive-only owner blocks collection, and an unverifiable archive never releases it", async () => await withTemp(async (root) => {
  const wave = join(root, "wave-archived-owner");
  const incoming = snapshot({ waveRoots: [wave], bundles: [bundle(wave)] });
  const archivedSalvage = salvageRetained("task-1", wave);
  const released = task("task-1", "reported", { waveRoot: wave });

  const retained = await reconcileExecutionRestore(
    incoming,
    snapshot(),
    EMPTY_NO_EVIDENCE,
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(), archiveClaimants: async () => [archivedSalvage] },
  );
  assert.equal(retained.recovery.reconciled, 0, "compaction evicted the record; the archive still retains the salvage");
  assert.deepEqual(retained.recovery.reasons.map((reason) => reason.code), ["bundle-in-flight"]);
  assert.match(retained.recovery.reasons[0]!.detail, /an archived task still requires its recovery evidence/);
  assert.deepEqual(retained.associations.waveRoots, [wave]);
  assert.deepEqual(retained.associations.bundles?.length, 1);

  const unverified = await reconcileExecutionRestore(
    incoming,
    snapshot(),
    EMPTY_NO_EVIDENCE,
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(), archiveClaimants: async () => { throw new Error("tampered archive"); } },
  );
  assert.equal(unverified.recovery.reconciled, 0, "a failed exact archive read is never proof of release");
  assert.deepEqual(unverified.recovery.reasons.map((reason) => reason.code), ["bundle-unrecoverable"]);
  assert.match(unverified.recovery.reasons[0]!.detail, /the owning task archive could not be verified/);

  const releasedResult = await reconcileExecutionRestore(
    incoming,
    snapshot(),
    EMPTY_NO_EVIDENCE,
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(), archiveClaimants: async () => [released] },
  );
  assert.equal(releasedResult.recovery.reconciled, 2,
    "an authenticated archive whose task is settled and unrestrained still releases both references");
  assert.deepEqual(releasedResult.associations.waveRoots, []);
  assert.deepEqual(releasedResult.associations.bundles, []);

  // A wave-only snapshot has no task id to look the archive owner up by, so
  // while any archive is retained the reference stays unresolved.
  const waveOnly = snapshot({ waveRoots: [wave], bundles: [] });
  const ambiguous = await reconcileExecutionRestore(
    waveOnly,
    snapshot(),
    EMPTY_NO_EVIDENCE,
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(), hasArchivedTasks: true },
  );
  assert.equal(ambiguous.recovery.reconciled, 0, "no exact handle exists to prove the archive released this wave");
  assert.deepEqual(ambiguous.recovery.reasons.map((reason) => reason.code), ["wave-unclaimed"]);
  assert.match(ambiguous.recovery.reasons[0]!.detail, /no exact task handle to verify against retained archives/);
  assert.deepEqual(ambiguous.associations.waveRoots, [wave]);

  const noArchives = await reconcileExecutionRestore(
    waveOnly,
    snapshot(),
    EMPTY_NO_EVIDENCE,
    { tasks: [], restoredTaskHandles: [], gatedTaskIds: new Set(), hasArchivedTasks: false },
  );
  assert.equal(noArchives.recovery.reconciled, 1, "with no retained archive, an unclaimed absent wave is collected work");
  assert.deepEqual(noArchives.associations.waveRoots, []);
}));

test("the shared identity helpers are the one rule for bundle revision and gate fields", () => {
  const wave = "/tmp/wave-identity";
  const loaded = bundle(wave, { expectedRevision: 3 });
  assert.equal(executionBundleIsPreservedBy(loaded, [bundle(wave, { expectedRevision: 4 })]), true);
  assert.equal(executionBundleIsPreservedBy(loaded, [bundle(wave, { expectedRevision: 3 })]), true);
  assert.equal(executionBundleIsPreservedBy(loaded, [bundle(wave, { expectedRevision: 2 })]), false, "a regressed revision is not preservation");
  assert.equal(executionBundleIsPreservedBy(loaded, [bundle(wave, { taskId: "other" })]), false);
  assert.equal(executionBundleIsPreservedBy(loaded, []), false);
  assert.notEqual(executionBundleIdentity(bundle(wave)), executionBundleIdentity(bundle("/tmp/other-wave")));

  const persisted = gate("/tmp/target", { sidecars: [{ path: "a.ts", sidecarPath: "/tmp/a.side" }] });
  assert.equal(executionGateIsPreservedBy(persisted, [{ ...persisted, sidecars: [{ path: "a.ts", sidecarPath: "/tmp/a.side" }] }]), true);
  assert.equal(executionGateIsPreservedBy(persisted, [{ ...persisted, sidecars: [{ path: "a.ts" }] }]), false, "every durable field counts");
  assert.equal(executionGateIsPreservedBy(persisted, [{ ...persisted, paths: ["b.ts"] }]), false);
  assert.equal(executionGateIsPreservedBy(persisted, []), false);
  assert.notEqual(executionGateIdentity(persisted), executionGateIdentity(gate("/tmp/target")));
});
