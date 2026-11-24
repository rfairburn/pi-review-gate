import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import test from "node:test";
import { BackgroundExecutionController, type BackgroundFaultHooks } from "../src/execution/background-controller";
import { readGroup } from "../src/execution/background-group-store";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import { ConflictGateStore, type ConflictGate } from "../src/execution/conflict-gate-store";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";
import { readWaveCaptureRecord } from "../src/execution/wave-repository";
import { setupInterruptedMergeTask, waitFor } from "./helpers/background-controller-fixtures";

/**
 * #682 owner lifecycle: one controller is reused across owner transitions
 * (detach, then restore of the next owner's snapshot). These races pause
 * owner A's ForceMerge or MarkClean at a deliberate barrier, run owner B's
 * restore with a same-root conflict gate, and then let A resume, asserting on
 * the actual workspace, durable group records, gate store, and coordinator
 * blocks — not only on the returned result.
 */

const MARKERS = "<<<<<<< current workspace\nours\n=======\ntheirs\n>>>>>>> subtask\n";

interface Barrier {
  arm(): void;
  /** Resolves once the armed hook is reached. */
  arrived: Promise<void>;
  release(): void;
  hook(): Promise<void>;
}

/** One-shot barrier: the first armed hook call pauses until release(). */
function barrier(): Barrier {
  let armed = false;
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolveArrived) => { arrive = resolveArrived; });
  const released = new Promise<void>((resolveReleased) => { release = resolveReleased; });
  return {
    arm: () => { armed = true; },
    arrived,
    release,
    hook: async () => {
      if (!armed) return;
      armed = false;
      arrive();
      await released;
    },
  };
}

function gate(sourceRoot: string, executionId: string, taskId: string, reason: string, paths: string[]): ConflictGate {
  return {
    executionId,
    taskId,
    sourceRoot,
    paths,
    activatedAt: new Date().toISOString(),
    manifestPath: join(sourceRoot, `${executionId}-conflict-manifest.json`),
    reason,
  };
}

function store(controller: BackgroundExecutionController): ConflictGateStore {
  return (controller as unknown as { conflictGates: ConflictGateStore }).conflictGates;
}

function installGate(controller: BackgroundExecutionController, value: ConflictGate): void {
  (controller as unknown as { setConflictGate: (gate: ConflictGate) => void }).setConflictGate(value);
}

const tick = (ms = 50) => new Promise<void>((resolveTick) => setTimeout(resolveTick, ms));

/** Fail fast instead of hanging when the pre-fix behavior would wait forever. */
async function within<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a force-merge that crossed into the workspace drains under its owner before a restore installs the next owner's same-root gate (#682)", async () => {
  const materialize = barrier();
  const faults: BackgroundFaultHooks = { materializeLandingConflicts: () => materialize.hook() };
  const scenario = await setupInterruptedMergeTask("owner-drain-merge", undefined, { faults });
  const { root, controller, started, taskId } = scenario;
  try {
    // The main side diverges from the worker's draft, so the merge must
    // materialize real diff3 markers and install its own gate.
    await writeFile(join(root, "draft.txt"), "main side\n", "utf8");
    materialize.arm();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-owner-a", actor: "user" });
    merge.catch(() => undefined);
    // Owner A holds the source lease and is paused just before materializing.
    await within(materialize.arrived, "owner A reaching materialization");

    const nextGate = gate(root, "exec-next-owner", "task-next-owner", "next owner gate", ["next.txt"]);
    let restored = false;
    const restore = controller.restore({ waveRoots: [], bundles: [], groupRoots: [], conflictGates: [nextGate] })
      .then(() => { restored = true; });
    await tick();
    assert.equal(restored, false, "the owner transition waits for the crossed merge instead of reusing the controller under it");
    assert.equal(store(controller).list().some((candidate) => candidate.executionId === "exec-next-owner"), false,
      "the next owner's gate is not installed while owner A's merge is still in flight");

    materialize.release();
    const outcome = await within(merge, "owner A merge settlement");
    assert.equal(outcome.tasks[0]?.state, "conflicted", "owner A's merge settles with its own truthful outcome");
    assert.equal(outcome.conflictGate?.executionId, started.executionId);
    await within(restore, "next owner restore");

    // The physical landing happened under A, and A's durable record says so.
    assert.match(await readFile(join(root, "draft.txt"), "utf8"), /<<<<<<< /);
    const persisted = (await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(persisted.state, "conflicted");
    assert.equal(persisted.commands.find((command) => command.instructionId === "force-owner-a")?.status, "acknowledged");

    // The next owner's gate is exactly the one installed, never replaced, and
    // it alone holds the root in the coordinator.
    assert.deepEqual(store(controller).list(), [nextGate]);
    assert.deepEqual(controller.associations().conflictGates, [nextGate]);
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "next owner gate", foreign: false });
    await controller.detach();
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false, "no leaked holder from owner A's gate");
  } finally {
    materialize.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("a force-merge still waiting for the source lease is cancelled by an owner transition and never lands under the next owner (#682)", async () => {
  const scenario = await setupInterruptedMergeTask("owner-cancel-merge");
  const { root, controller, started, taskId } = scenario;
  const held = await sourceMutationCoordinator.acquire(root);
  const tails = (sourceMutationCoordinator as unknown as { tails: Map<string, Promise<void>> }).tails;
  const heldTail = tails.get(resolve(root));
  try {
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-waiting", actor: "user" });
    merge.catch(() => undefined);
    // Owner A has queued behind the held lease (its own tail replaced ours).
    await waitFor(() => tails.get(resolve(root)) !== heldTail);

    const nextGate = gate(root, "exec-next-owner", "task-next-owner", "next owner gate", ["next.txt"]);
    await within(controller.restore({ waveRoots: [], bundles: [], groupRoots: [], conflictGates: [nextGate] }), "next owner restore");
    await within(assert.rejects(merge, /owning session changed[\s\S]*no checkpoint landed/), "owner A merge cancellation");
    held();
    await tick();

    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(root, "base.txt"), "utf8"), "base\n");
    assert.deepEqual(store(controller).list(), [nextGate]);
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "next owner gate", foreign: false });
    // A force-merge requested while an owner transition is in progress
    // rejects and nothing lands (target already detached, cancelled at
    // admission, or stopped by recovery verification's own epoch check).
    const detaching = controller.detach();
    await assert.rejects(controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-during-detach", actor: "user" }), /owning session is changing|detached during recovery verification|Task target is unknown/);
    await detaching;
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
  } finally {
    held();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("mark-clean validated before an owner restore refuses and leaves the next owner's replaced same-root gate, task, and block intact (#682)", async () => {
  const validated = barrier();
  const scenario = await setupInterruptedMergeTask("owner-markclean-validate", undefined, { faults: { markCleanValidated: () => validated.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));
    const associations = controller.associations();
    assert.equal(associations.conflictGates?.length, 1);
    // The next owner restores the same execution with a replaced same-root
    // gate whose markers were never validated.
    await writeFile(join(root, "next.txt"), MARKERS, "utf8");
    const nextGate = gate(root, started.executionId, taskId, "next owner gate", ["next.txt"]);

    validated.arm();
    const clean = controller.markClean();
    clean.catch(() => undefined);
    await within(validated.arrived, "owner A validation");
    await within(controller.restore({ ...associations, conflictGates: [nextGate] }), "next owner restore");
    validated.release();
    await within(assert.rejects(clean, /owning session changed[\s\S]*no conflict gate or task was changed/), "stale mark-clean refusal");

    assert.deepEqual(store(controller).list(), [nextGate], "the replaced gate is neither removed nor retired");
    assert.deepEqual(controller.associations().conflictGates, [nextGate], "durable associations keep the next owner's gate");
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "next owner gate", foreign: false });
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "interrupted", "the next owner's task is not marked landed");
    assert.equal((await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)?.state, "interrupted",
      "no next-owner state was committed");

    // The next owner's own recovery still works normally and validates its markers.
    await assert.rejects(controller.markClean(), /Conflict markers remain in: next\.txt/);
    await writeFile(join(root, "next.txt"), "resolved\n", "utf8");
    assert.deepEqual(await controller.markClean(), { cleared: true, paths: ["next.txt"] });
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "landed");
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
  } finally {
    validated.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("mark-clean that began committing drains under its owner before a restore installs the next owner's gate (#682)", async () => {
  const publish = barrier();
  const scenario = await setupInterruptedMergeTask("owner-markclean-commit", undefined, { faults: { publishAssociations: () => publish.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));
    const nextGate = gate(root, "exec-next-owner", "task-next-owner", "next owner gate", ["next.txt"]);

    publish.arm();
    const clean = controller.markClean({ actor: "user" });
    clean.catch(() => undefined);
    // Paused inside the commit: owner A already transitioned and released its gate.
    await within(publish.arrived, "owner A commit");
    let restored = false;
    const restore = controller.restore({ waveRoots: [], bundles: [], groupRoots: [started.root], conflictGates: [nextGate] })
      .then(() => { restored = true; });
    await tick();
    assert.equal(restored, false, "the owner transition drains the committing mark-clean first");

    publish.release();
    assert.deepEqual(await within(clean, "owner A commit settlement"), { cleared: true, paths: ["conflicted.txt"] });
    await within(restore, "next owner restore");

    const persisted = (await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(persisted.state, "landed", "owner A's clearance committed under owner A");
    assert.ok(persisted.activity.some((event) => event.phase === "landed" && event.message === "Conflict resolution validated; queued landing attempts released."));
    assert.deepEqual(store(controller).list(), [nextGate]);
    assert.deepEqual(controller.associations().conflictGates, [nextGate]);
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "next owner gate", foreign: false });
    await controller.detach();
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
  } finally {
    publish.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("mark-clean admitted while a detach is in progress is refused without changing gates (#682)", async () => {
  const scenario = await setupInterruptedMergeTask("owner-markclean-detaching");
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));
    const detaching = controller.detach();
    await assert.rejects(controller.markClean(), /owning session changed/);
    await detaching;
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false, "detach still releases the owner's block exactly once");
  } finally {
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("force-merge and mark-clean are refused while a restore is still attaching groups, and the restored gate is preserved (#682)", async () => {
  const restoreSave = barrier();
  const scenario = await setupInterruptedMergeTask("owner-restore-fence", undefined, { faults: { save: () => restoreSave.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    const restoredGate = gate(root, started.executionId, taskId, "restored gate", ["conflicted.txt"]);
    installGate(controller, restoredGate);
    await writeFile(join(root, "conflicted.txt"), MARKERS, "utf8");
    const associations = controller.associations();
    await controller.detach();

    restoreSave.arm();
    const restore = controller.restore(associations);
    // Paused in the attached group's save: the group is attached, but its
    // persisted gate is not installed yet.
    await within(restoreSave.arrived, "restore attaching the group");
    assert.equal(controller.list().length, 1, "the group is already attached");
    assert.equal(store(controller).size, 0, "the persisted gate is not installed yet");
    const associationFields = () => {
      const attached = controller.inspect(started.executionId, taskId).tasks[0]!;
      return JSON.stringify({ bundle: attached.bundle, result: attached.result, summary: attached.summary, updatedAt: attached.updatedAt });
    };
    const fieldsBefore = associationFields();
    await assert.rejects(controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-during-restore", actor: "user" }), /owning session is changing/);
    assert.equal(associationFields(), fieldsBefore, "a refused merge never backfills the attached task's association or timestamp");
    await assert.rejects(controller.markClean(), /owning session changed/);
    restoreSave.release();
    await within(restore, "restore completion");

    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/, "nothing landed into the gated workspace");
    assert.equal(await readFile(join(root, "conflicted.txt"), "utf8"), MARKERS);
    assert.equal(store(controller).list().length, 1);
    assert.equal(store(controller).list()[0]!.reason, "restored gate");
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "restored gate", foreign: false });
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(task.commands.some((command) => command.instructionId === "force-during-restore"), false, "a refused request records nothing");
  } finally {
    restoreSave.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("shutdown drains a mark-clean that is committing and refuses new ones, so no cleared gate is left persisted (#682)", async () => {
  const checkpoint = barrier();
  const scenario = await setupInterruptedMergeTask("owner-shutdown-markclean", undefined, { faults: { checkpointParent: () => checkpoint.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));

    checkpoint.arm();
    const clean = controller.markClean({ actor: "user" });
    clean.catch(() => undefined);
    // Paused after the landed save, before the gate is released.
    await within(checkpoint.arrived, "mark-clean commit between landed save and gate release");
    assert.equal((await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)?.state, "landed");
    assert.equal(store(controller).size, 1);

    let shutDown = false;
    const shutdown = controller.shutdown().then(() => { shutDown = true; });
    await tick();
    assert.equal(shutDown, false, "shutdown waits for the committing clearance");
    await assert.rejects(controller.markClean(), /application shutdown is in progress/);

    checkpoint.release();
    assert.deepEqual(await within(clean, "mark-clean commit"), { cleared: true, paths: ["conflicted.txt"] });
    await within(shutdown, "shutdown");
    assert.equal(controller.associations().conflictGates?.length ?? 0, 0, "no cleared gate remains for final persistence");
    assert.equal(store(controller).size, 0);
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
  } finally {
    checkpoint.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("a pre-lease force-merge cancelled by an owner transition is finalized on its original attachment and never touches the next owner (#682)", async () => {
  const beforeLease = barrier();
  const scenario = await setupInterruptedMergeTask("owner-stale-prelease", undefined, { faults: { forceMergeBeforeLease: () => beforeLease.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    const associations = controller.associations();
    beforeLease.arm();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-stale", actor: "user" });
    merge.catch(() => undefined);
    // Owner A recorded its queued command and paused before requesting the lease.
    await within(beforeLease.arrived, "owner A pre-lease");

    // The next owner restores the same execution (fresh records from disk).
    await within(controller.restore(associations), "next owner restore");
    const recent = () => (controller as unknown as { recentActivity: unknown[] }).recentActivity;
    const activityBefore = JSON.stringify(recent());
    const durable = (await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)!;
    const durableCommand = durable.commands.find((command) => command.instructionId === "force-stale");
    assert.equal(durableCommand?.status, "failed", "the cancellation was finalized durably on the original attachment, never left queued");
    assert.match(durableCommand?.error ?? "", /owning session changed/);
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.commands.find((command) => command.instructionId === "force-stale")?.status, "failed");

    beforeLease.release();
    await within(assert.rejects(merge, /owning session changed/), "stale merge rejection");
    await tick();
    assert.equal(JSON.stringify(recent()), activityBefore, "the stale request appends nothing to the next owner's activity");
    const after = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(after.state, "interrupted");
    assert.equal(after.commands.filter((command) => command.instructionId === "force-stale").length, 1);
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);

    // The next owner's own recovery is unaffected: a fresh request lands normally.
    const landed = await controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-next-owner", actor: "user" });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
  } finally {
    beforeLease.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("concurrent mark-clean calls are serialized: a successor gate installed meanwhile stays blocked and the later call reports no success (#682)", async () => {
  const publish = barrier();
  const scenario = await setupInterruptedMergeTask("owner-markclean-serial", undefined, { faults: { publishAssociations: () => publish.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "first gate", ["conflicted.txt"]));

    publish.arm();
    const first = controller.markClean({ actor: "user" });
    const second = controller.markClean({ actor: "user" });
    second.catch(() => undefined);
    // The first call has removed and released its gate and is still committing.
    await within(publish.arrived, "first mark-clean commit");
    // A successor gate (as a later force-merge would install) appears on the
    // same root with unresolved markers before the second call runs.
    await writeFile(join(root, "next.txt"), MARKERS, "utf8");
    const successor = gate(root, started.executionId, taskId, "successor gate", ["next.txt"]);
    installGate(controller, successor);
    publish.release();

    assert.deepEqual(await within(first, "first mark-clean"), { cleared: true, paths: ["conflicted.txt"] });
    await within(assert.rejects(second, /Conflict markers remain in: next\.txt/), "second mark-clean validates the successor itself");
    assert.deepEqual(store(controller).list(), [successor]);
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "successor gate", foreign: false });
    const released = controller.inspect(started.executionId, taskId).tasks[0]!.activity
      .filter((event) => event.phase === "landed" && /queued landing attempts released/.test(event.message));
    assert.equal(released.length, 1, "only the clearance that actually removed a gate announces success");
  } finally {
    publish.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

async function refsOf(repositoryPath: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)("git", ["--git-dir", repositoryPath, "for-each-ref", "--format=%(refname) %(objectname)"]);
  return stdout.split("\n").filter(Boolean).sort();
}

test("a mark-clean queued behind a paused clearance stays bound to its admitting owner across a restore (#682)", async () => {
  const validated = barrier();
  const scenario = await setupInterruptedMergeTask("owner-markclean-queued", undefined, { faults: { markCleanValidated: () => validated.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));
    const associations = controller.associations();
    // B's replacement gate names a file with NO markers: a call that wrongly
    // acquired B's authority would validate and clear it.
    await writeFile(join(root, "next.txt"), "no markers here\n", "utf8");
    const nextGate = gate(root, started.executionId, taskId, "next owner gate", ["next.txt"]);

    validated.arm();
    const first = controller.markClean({ actor: "user" });
    first.catch(() => undefined);
    await within(validated.arrived, "first A call validating");
    const second = controller.markClean({ actor: "user" });
    second.catch(() => undefined);
    await within(controller.restore({ ...associations, conflictGates: [nextGate] }), "next owner restore");
    validated.release();

    await within(assert.rejects(first, /owning session changed/), "first A call refusal");
    await within(assert.rejects(second, /owning session changed/), "queued A call refusal");
    assert.deepEqual(store(controller).list(), [nextGate]);
    assert.deepEqual(controller.associations().conflictGates, [nextGate]);
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "next owner gate", foreign: false });
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "interrupted");
    assert.equal((await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)?.state, "interrupted");

    // B's own clearance is not queued behind the abandoned A calls.
    assert.deepEqual(await within(controller.markClean({ actor: "user" }), "next owner mark-clean"), { cleared: true, paths: ["next.txt"] });
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
  } finally {
    validated.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("force-merge salvage preparation that pins a candidate ref drains under its owner; the cancelled merge never applies or replaces the next owner's gate (#682)", async () => {
  const prepared = barrier();
  const scenario = await setupInterruptedMergeTask("owner-salvage-prepare", undefined, { faults: { forceMergeSourcePrepared: () => prepared.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    const waveRoot = controller.inspect(started.executionId, taskId).tasks[0]!.waveRoot!;
    const repositoryPath = (await readWaveCaptureRecord(waveRoot)).repositoryPath;
    // Keep the worker's work reachable from a surviving branch head, then
    // drop the candidate-snapshot ref the interrupt pinned, so salvage
    // preparation must pin a snapshot ref again (a real ref write in the
    // wave repository).
    for (const line of await refsOf(repositoryPath)) {
      const [name, sha] = line.split(" ");
      if (name!.includes("/candidate-snapshots/")) {
        await promisify(execFile)("git", ["--git-dir", repositoryPath, "update-ref", "refs/heads/retained-worker", sha!]);
        await promisify(execFile)("git", ["--git-dir", repositoryPath, "update-ref", "-d", name!]);
      }
    }
    const refsBefore = await refsOf(repositoryPath);
    assert.equal(refsBefore.some((ref) => ref.includes("/candidate-snapshots/")), false);
    const associations = controller.associations();

    prepared.arm();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-salvage-stale", actor: "user" });
    merge.catch(() => undefined);
    // Paused inside the tracked preparation, after it wrote its candidate ref.
    await within(prepared.arrived, "salvage preparation");
    const refsPrepared = await refsOf(repositoryPath);
    const added = refsPrepared.filter((ref) => !refsBefore.includes(ref));
    assert.equal(added.length, 1, "preparation pinned exactly one new ref");
    assert.match(added[0]!, /\/candidate-snapshots\//, "the new ref is a salvage candidate snapshot");

    const nextGate = gate(root, "exec-next-owner", "task-next-owner", "next owner gate", ["next.txt"]);
    let restored = false;
    const restore = controller.restore({ ...associations, conflictGates: [nextGate] }).then(() => { restored = true; });
    await tick();
    assert.equal(restored, false, "the owner transition drains the preparation that writes recovery refs");

    prepared.release();
    await within(assert.rejects(merge, /owning session changed[\s\S]*no checkpoint landed/), "cancelled merge");
    await within(restore, "next owner restore");
    assert.deepEqual(await refsOf(repositoryPath), refsPrepared, "no recovery ref is written after the next owner attached");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/, "the cancelled merge applied nothing");
    assert.deepEqual(store(controller).list(), [nextGate]);
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "next owner gate", foreign: false });
    const command = controller.inspect(started.executionId, taskId).tasks[0]!.commands.find((candidate) => candidate.instructionId === "force-salvage-stale");
    assert.equal(command?.status, "failed", "the cancellation was finalized on the original attachment");
  } finally {
    prepared.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("shutdown keeps a gated task and its group recoverable when a drained clearance fails after its landed save (#682)", async () => {
  const checkpoint = barrier();
  let failCheckpoint = false;
  const scenario = await setupInterruptedMergeTask("owner-shutdown-markclean-fail", undefined, {
    faults: {
      checkpointParent: async () => {
        const fail = failCheckpoint;
        failCheckpoint = false;
        await checkpoint.hook();
        if (fail) throw new Error("injected checkpoint failure after the landed save");
      },
    },
  });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    const ownerGate = gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]);
    installGate(controller, ownerGate);

    checkpoint.arm();
    failCheckpoint = true;
    const clean = controller.markClean({ actor: "user" });
    clean.catch(() => undefined);
    await within(checkpoint.arrived, "mark-clean commit after landed save");
    const shutdown = controller.shutdown();
    checkpoint.release();
    await within(assert.rejects(clean, /injected checkpoint failure/), "failed clearance");
    await within(shutdown, "shutdown");

    assert.deepEqual(store(controller).list(), [ownerGate], "the gate stays tracked");
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "owner A gate", foreign: false });
    assert.deepEqual(controller.associations().conflictGates, [ownerGate], "final persistence still records the gate");
    assert.equal(controller.list().length, 1, "the gated group is not retired");
    assert.ok(controller.associations().groupRoots?.includes(started.root));
    const persisted = (await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.ok(persisted.waveRoot, "the gated task's recovery anchor is not cleaned up");
  } finally {
    checkpoint.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("a restore of the same group from a snapshot taken before a crossed merge created its gate keeps the drained gate and its markers (#682)", async () => {
  const materialize = barrier();
  const scenario = await setupInterruptedMergeTask("owner-reconcile-created", undefined, { faults: { materializeLandingConflicts: () => materialize.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "draft.txt"), "main side\n", "utf8");
    const snapshot = controller.associations();
    assert.equal(snapshot.conflictGates?.length ?? 0, 0, "the snapshot predates the gate");

    materialize.arm();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-reconcile", actor: "user" });
    merge.catch(() => undefined);
    await within(materialize.arrived, "crossed merge");
    const restore = controller.restore(snapshot);
    materialize.release();
    const outcome = await within(merge, "crossed merge settlement");
    assert.equal(outcome.tasks[0]?.state, "conflicted");
    await within(restore, "same-group restore");

    assert.match(await readFile(join(root, "draft.txt"), "utf8"), /<<<<<<< /, "real markers are on disk");
    const gates = store(controller).list();
    assert.equal(gates.length, 1, "the drained gate is carried into the restored owner");
    assert.equal(gates[0]!.executionId, started.executionId);
    assert.equal(gates[0]!.taskId, taskId);
    assert.ok(gates[0]!.paths.includes("draft.txt"));
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: gates[0]!.reason, foreign: false });
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "conflicted");
    await assert.rejects(controller.markClean(), /Conflict markers remain in: draft\.txt/);
  } finally {
    materialize.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("a restore of the same group from a snapshot taken before a committing mark-clean removed its gate does not resurrect it (#682)", async () => {
  const publish = barrier();
  const scenario = await setupInterruptedMergeTask("owner-reconcile-cleared", undefined, { faults: { publishAssociations: () => publish.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));
    const snapshot = controller.associations();
    assert.equal(snapshot.conflictGates?.length, 1, "the snapshot still carries the gate");

    publish.arm();
    const clean = controller.markClean({ actor: "user" });
    clean.catch(() => undefined);
    await within(publish.arrived, "committing mark-clean");
    const restore = controller.restore(snapshot);
    publish.release();
    assert.deepEqual(await within(clean, "mark-clean commit"), { cleared: true, paths: ["conflicted.txt"] });
    await within(restore, "same-group restore");

    assert.equal(store(controller).size, 0, "the drained clearance stays cleared");
    assert.equal(controller.associations().conflictGates?.length ?? 0, 0);
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "landed");
  } finally {
    publish.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("a same-root coordinator waiter stays blocked through the owner handoff until the replacement gate is cleared (#682)", async () => {
  const restoreSave = barrier();
  const scenario = await setupInterruptedMergeTask("owner-handoff-waiter", undefined, { faults: { save: () => restoreSave.hook() } });
  const { root, controller, started, taskId } = scenario;
  let releaseLease: (() => void) | undefined;
  try {
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));
    await writeFile(join(root, "next.txt"), MARKERS, "utf8");
    const nextGate = gate(root, started.executionId, taskId, "next owner gate", ["next.txt"]);
    const snapshot = { ...controller.associations(), conflictGates: [nextGate] };
    // A real waiter queued behind owner A's gate on the same root.
    let acquired = false;
    const waiter = sourceMutationCoordinator.acquire(root).then((release) => { acquired = true; releaseLease = release; });

    restoreSave.arm();
    const restore = controller.restore(snapshot);
    await within(restoreSave.arrived, "restore paused in the group save");
    assert.equal(store(controller).size, 0, "owner A's gate is released and B's is not installed yet");
    await tick();
    assert.equal(acquired, false, "the waiter cannot enter during the handoff");
    restoreSave.release();
    await within(restore, "restore");
    await tick();
    assert.equal(acquired, false, "the waiter stays blocked by the replacement gate");
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: "next owner gate", foreign: false });

    await writeFile(join(root, "next.txt"), "resolved\n", "utf8");
    assert.deepEqual(await controller.markClean(), { cleared: true, paths: ["next.txt"] });
    await within(waiter, "waiter after clearance");
    assert.equal(acquired, true);
  } finally {
    restoreSave.release();
    releaseLease?.();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("a crossed merge whose parent checkpoint fails after materializing still installs a blocking gate that restore carries (#682)", async () => {
  const materialize = barrier();
  let failCheckpoint = false;
  const scenario = await setupInterruptedMergeTask("owner-checkpoint-fail", undefined, {
    faults: {
      materializeLandingConflicts: () => materialize.hook(),
      checkpointParent: () => {
        if (failCheckpoint) {
          failCheckpoint = false;
          throw new Error("injected parent checkpoint failure after materialization");
        }
      },
    },
  });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "draft.txt"), "main side\n", "utf8");
    const snapshot = controller.associations();
    materialize.arm();
    failCheckpoint = true;
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-checkpoint-fail", actor: "user" });
    merge.catch(() => undefined);
    await within(materialize.arrived, "crossed merge");
    const restore = controller.restore(snapshot);
    materialize.release();
    const outcome = await within(merge, "crossed merge settlement");
    assert.equal(outcome.tasks[0]?.state, "conflicted", "the checkpoint failure is tolerated post-conflict bookkeeping");
    assert.ok(outcome.tasks[0]?.activity.some((event) => event.phase === "bookkeeping" && /post-conflict parent checkpoint failed/.test(event.message)));
    await within(restore, "restore");

    assert.match(await readFile(join(root, "draft.txt"), "utf8"), /<<<<<<< /);
    const persisted = (await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(persisted.state, "conflicted");
    const gates = store(controller).list();
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.taskId, taskId);
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: gates[0]!.reason, foreign: false });
  } finally {
    materialize.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

/** True only during a restore's own group saves (its initial detach has finished). */
function restoringGroupSave(controller: BackgroundExecutionController): boolean {
  const internals = controller as unknown as { detaching: number; activityRestores: number };
  return internals.detaching === 0 && internals.activityRestores > 0;
}

test("a superseding restore from the same pre-merge snapshot still carries a gate an earlier restore drained, and blocks a real waiter (#682)", async () => {
  const materialize = barrier();
  const restoreSave = barrier();
  let controllerRef: BackgroundExecutionController | undefined;
  const scenario = await setupInterruptedMergeTask("owner-overlap-created", undefined, {
    faults: {
      materializeLandingConflicts: () => materialize.hook(),
      save: async () => { if (controllerRef && restoringGroupSave(controllerRef)) await restoreSave.hook(); },
    },
  });
  const { root, controller, started, taskId } = scenario;
  controllerRef = controller;
  let releaseLease: (() => void) | undefined;
  try {
    await writeFile(join(root, "draft.txt"), "main side\n", "utf8");
    const snapshot = controller.associations();
    assert.equal(snapshot.conflictGates?.length ?? 0, 0, "the snapshot predates the gate");

    materialize.arm();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-overlap", actor: "user" });
    merge.catch(() => undefined);
    await within(materialize.arrived, "crossed merge");
    restoreSave.arm();
    const first = controller.restore(snapshot);
    first.catch(() => undefined);
    materialize.release();
    assert.equal((await within(merge, "crossed merge settlement")).tasks[0]?.state, "conflicted");
    // The first restore drained the merge, cleared the store, and is paused in
    // its group save before installing its reconciled gate.
    await within(restoreSave.arrived, "first restore group save");
    assert.equal(store(controller).size, 0);
    let acquired = false;
    const waiter = sourceMutationCoordinator.acquire(root).then((release) => { acquired = true; releaseLease = release; });
    const second = controller.restore(snapshot);
    restoreSave.release();
    await within(first, "superseded first restore");
    await within(second, "latest restore");
    await tick();

    assert.match(await readFile(join(root, "draft.txt"), "utf8"), /<<<<<<< /);
    const gates = store(controller).list();
    assert.equal(gates.length, 1, "the latest restore carries the drained gate");
    assert.equal(gates[0]!.taskId, taskId);
    assert.ok(gates[0]!.paths.includes("draft.txt"));
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: gates[0]!.reason, foreign: false });
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "conflicted");
    assert.equal(acquired, false, "a real waiter queued during the overlap stays blocked");

    await writeFile(join(root, "draft.txt"), "resolved\n", "utf8");
    assert.equal((await controller.markClean()).cleared, true);
    await within(waiter, "waiter after clearance");
    assert.equal(acquired, true);
  } finally {
    materialize.release();
    restoreSave.release();
    releaseLease?.();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("a superseding restore from the same pre-clearance snapshot does not resurrect a gate an earlier restore drained the clearance of (#682)", async () => {
  const publish = barrier();
  const restoreSave = barrier();
  let controllerRef: BackgroundExecutionController | undefined;
  const scenario = await setupInterruptedMergeTask("owner-overlap-cleared", undefined, {
    faults: {
      publishAssociations: () => publish.hook(),
      save: async () => { if (controllerRef && restoringGroupSave(controllerRef)) await restoreSave.hook(); },
    },
  });
  const { root, controller, started, taskId } = scenario;
  controllerRef = controller;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installGate(controller, gate(root, started.executionId, taskId, "owner A gate", ["conflicted.txt"]));
    const snapshot = controller.associations();
    assert.equal(snapshot.conflictGates?.length, 1, "the snapshot still carries the gate");

    publish.arm();
    const clean = controller.markClean({ actor: "user" });
    clean.catch(() => undefined);
    await within(publish.arrived, "committing mark-clean");
    restoreSave.arm();
    const first = controller.restore(snapshot);
    first.catch(() => undefined);
    publish.release();
    assert.deepEqual(await within(clean, "mark-clean commit"), { cleared: true, paths: ["conflicted.txt"] });
    await within(restoreSave.arrived, "first restore group save");
    const second = controller.restore(snapshot);
    restoreSave.release();
    await within(first, "superseded first restore");
    await within(second, "latest restore");

    assert.equal(store(controller).size, 0, "the drained clearance stays cleared in the latest restore");
    assert.equal(controller.associations().conflictGates?.length ?? 0, 0);
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false, "no reservation or gate outlives the restores");
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "landed");
  } finally {
    publish.release();
    restoreSave.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("mark-clean refuses to clear a gate while its creating force-merge is still recording the conflict outcome (#682)", async () => {
  const checkpoint = barrier();
  const scenario = await setupInterruptedMergeTask("owner-merge-settling", undefined, { faults: { checkpointParent: () => checkpoint.hook() } });
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "draft.txt"), "main side\n", "utf8");
    checkpoint.arm();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-settling", actor: "user" });
    merge.catch(() => undefined);
    // Paused at the post-materialization checkpoint: markers and gate exist.
    await within(checkpoint.arrived, "post-materialization checkpoint");
    assert.match(await readFile(join(root, "draft.txt"), "utf8"), /<<<<<<< /);
    const mergeGate = store(controller).list()[0]!;
    assert.equal(mergeGate.taskId, taskId);
    await writeFile(join(root, "draft.txt"), "resolved\n", "utf8");

    await assert.rejects(controller.markClean(), /force-merge is still recording its conflict outcome/);
    assert.deepEqual(store(controller).list(), [mergeGate], "the gate is not released");
    assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: mergeGate.reason, foreign: false });
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "conflicted", "the task is not marked landed");

    checkpoint.release();
    const outcome = await within(merge, "force-merge settlement");
    assert.equal(outcome.tasks[0]?.state, "conflicted", "force-merge reports its own conflicted outcome");
    assert.equal(outcome.conflictGate?.taskId, taskId);

    assert.deepEqual(await controller.markClean(), { cleared: true, paths: mergeGate.paths });
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "landed");
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
  } finally {
    checkpoint.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

/**
 * Restore A reserves its incoming gate root, then pauses in the awaited
 * notice for a missing group (after its initial detach finished). Returns the
 * paused restore, its release, and the reserved root.
 */
async function pauseRestoreInMissingGroupNotice(controller: BackgroundExecutionController, base: string) {
  const notice = barrier();
  const rootA = join(base, "a");
  await mkdir(rootA, { recursive: true });
  const gateA = gate(rootA, "exec-restore-a", "task-restore-a", "restore A gate", ["a.txt"]);
  notice.arm();
  const restoreA = controller.restore(
    { waveRoots: [], bundles: [], groupRoots: [join(base, "missing-group")], conflictGates: [gateA] },
    {},
    () => notice.hook(),
  );
  restoreA.catch(() => undefined);
  await within(notice.arrived, "restore A paused in its missing-group notice");
  assert.equal(sourceMutationCoordinator.blocked(rootA).blocked, true, "restore A reserved its incoming root");
  return { restoreA, releaseNotice: notice.release, rootA };
}

function plainController(root: string, faults?: BackgroundFaultHooks): BackgroundExecutionController {
  return new BackgroundExecutionController({
    pi: {},
    config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
    state: createState(),
    cwd: () => root,
    ...(faults ? { faults } : {}),
  });
}

test("the newest restore settles the handoff even while a superseded restore is paused in an awaited notice (#682)", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-owner-paused-restore-"));
  const controller = plainController(base);
  let releaseNotice: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  try {
    const paused = await pauseRestoreInMissingGroupNotice(controller, base);
    releaseNotice = paused.releaseNotice;
    let acquired = false;
    const waiter = sourceMutationCoordinator.acquire(paused.rootA).then((release) => { acquired = true; releaseLease = release; });
    await tick();
    assert.equal(acquired, false, "restore A's reservation holds while it is current");

    const rootB = join(base, "b");
    await mkdir(rootB, { recursive: true });
    await writeFile(join(rootB, "b.txt"), MARKERS, "utf8");
    const gateB = gate(rootB, "exec-restore-b", "task-restore-b", "restore B gate", ["b.txt"]);
    await within(controller.restore({ waveRoots: [], bundles: [], groupRoots: [], conflictGates: [gateB] }), "restore B");

    // Restore A is still paused, yet B's completed handoff released A's
    // obsolete reservation and no longer fences recovery.
    await within(waiter, "restore A root waiter after restore B settled");
    assert.equal(acquired, true);
    releaseLease!();
    releaseLease = undefined;
    assert.deepEqual(store(controller).list(), [gateB]);
    assert.deepEqual(store(controller).blockedState(rootB), { blocked: true, ownReason: "restore B gate", foreign: false });
    await assert.rejects(controller.markClean(), /Conflict markers remain in: b\.txt/, "recovery is admitted (validation runs)");
    await writeFile(join(rootB, "b.txt"), "resolved\n", "utf8");
    assert.deepEqual(await controller.markClean(), { cleared: true, paths: ["b.txt"] });
    assert.equal(sourceMutationCoordinator.blocked(rootB).blocked, false);

    releaseNotice();
    await within(paused.restoreA, "superseded restore A");
    assert.equal(store(controller).size, 0, "the superseded restore installs nothing");
    assert.equal(sourceMutationCoordinator.blocked(paused.rootA).blocked, false);
  } finally {
    releaseNotice?.();
    releaseLease?.();
    await controller.detach().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test("a standalone detach that supersedes a paused restore releases its reservation (#682)", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-owner-paused-detach-"));
  const controller = plainController(base);
  let releaseNotice: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  try {
    const paused = await pauseRestoreInMissingGroupNotice(controller, base);
    releaseNotice = paused.releaseNotice;
    let acquired = false;
    const waiter = sourceMutationCoordinator.acquire(paused.rootA).then((release) => { acquired = true; releaseLease = release; });
    await tick();
    assert.equal(acquired, false);

    await within(controller.detach(), "standalone detach");
    await within(waiter, "restore A root waiter after detach");
    assert.equal(acquired, true, "the paused restore's reservation was released by the superseding detach");

    releaseNotice();
    await within(paused.restoreA, "superseded restore A");
    assert.equal(store(controller).size, 0);
  } finally {
    releaseNotice?.();
    releaseLease?.();
    await controller.detach().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test("a restore from a pre-clearance snapshot with no group roster does not resurrect a group-less gate its drained mark-clean cleared (#682)", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-owner-groupless-clear-"));
  const publish = barrier();
  const controller = plainController(base, { publishAssociations: () => publish.hook() });
  let releaseLease: (() => void) | undefined;
  try {
    await writeFile(join(base, "conflicted.txt"), "resolved\n", "utf8");
    const groupless = gate(base, "exec-groupless", "task-groupless", "group-less gate", ["conflicted.txt"]);
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [], conflictGates: [groupless] });
    assert.equal(controller.list().length, 0, "no execution group is attached");
    const snapshot = controller.associations();
    assert.deepEqual(snapshot.conflictGates, [groupless]);
    assert.deepEqual(snapshot.groupRoots ?? [], [], "empty group roster");

    publish.arm();
    const clean = controller.markClean({ actor: "user" });
    clean.catch(() => undefined);
    // The commit released the gate and is paused publishing the clearance.
    await within(publish.arrived, "mark-clean publishing its clearance");
    assert.equal(store(controller).size, 0);
    const restore = controller.restore(snapshot);
    publish.release();
    assert.deepEqual(await within(clean, "mark-clean commit"), { cleared: true, paths: ["conflicted.txt"] });
    await within(restore, "restore from the pre-clearance snapshot");

    assert.equal(store(controller).size, 0, "the cleared gate is not reinstalled");
    assert.equal(controller.associations().conflictGates?.length ?? 0, 0);
    let acquired = false;
    const waiter = sourceMutationCoordinator.acquire(base).then((release) => { acquired = true; releaseLease = release; });
    await within(waiter, "coordinator waiter after restore");
    assert.equal(acquired, true, "the source is not blocked again");
  } finally {
    publish.release();
    releaseLease?.();
    await controller.detach().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});
