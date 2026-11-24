/**
 * #682: the trusted per-call lifecycle guard (`effectGuard`) on the recovery
 * controller operations a native lane may now reach: Interrupt (both modes),
 * ForceMerge, and MarkClean.
 *
 * Verified here, in process, against the real controller, a real retained
 * interrupted wave (the shared background-controller fixture: a real Git
 * workspace and a real run-as-binary executor), the real source-mutation
 * coordinator, and the real conflict-gate store:
 * - ForceMerge: a caller revoked while it waits for the source lease never
 *   crosses into the workspace; its recorded command fails durably and
 *   nothing lands. A caller revoked inside the tracked source preparation
 *   lets that preparation finish (no rollback) and stops before requesting
 *   the lease. A caller current through the crossing lands even when revoked
 *   right after it, and no further guard check runs.
 * - Interrupt: a caller revoked at entry records nothing and the writer keeps
 *   running. An admitted interrupt_with_merge whose caller is revoked after
 *   admission still settles and saves the interrupt, but never records a
 *   merge attempt or requests the separate merge. Owner retirement (shutdown,
 *   then detach) waits for an admitted guarded interrupt's durable outcome; a
 *   guarded interrupt is refused during an owner transition; Pi's is untracked.
 * - MarkClean: a guarded clearance serialized behind another one is refused
 *   when its caller is revoked during its own validation, or while it waits,
 *   and never clears the successor gate that it (or nobody) validated.
 * - Unguarded calls (Pi, /subtask-*) behave as before: each scenario's control
 *   step lands or clears normally without a guard.
 * Barriers are deterministic fault hooks; nothing waits on wall-clock timing.
 * No tool boundary, native lane, or provider transport is covered here (see
 * the native managed-tool delegate tests).
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  EFFECT_GUARD_FORCE_MERGE_REVOKED,
  EFFECT_GUARD_INTERRUPT_MERGE_REVOKED,
  EFFECT_GUARD_INTERRUPT_REVOKED,
  EFFECT_GUARD_MARK_CLEAN_REVOKED,
  type BackgroundExecutionController,
  type ControllerEffectGuard,
} from "../src/execution/background-controller";
import { readGroup } from "../src/execution/background-group-store";
import type { ConflictGate, ConflictGateStore } from "../src/execution/conflict-gate-store";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";
import { setupInterruptedMergeTask, waitFor } from "./helpers/background-controller-fixtures";

// Private temp tree for this test process; removed even when a test fails.
const privateTmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-review-recovery-guard-")));
const tempVariables = process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"];
const originalTemp = new Map(tempVariables.map((name) => [name, process.env[name]]));
for (const name of tempVariables) process.env[name] = privateTmp;
test.after(() => {
  for (const [name, value] of originalTemp) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(privateTmp, { recursive: true, force: true });
});

interface Barrier {
  arm(): void;
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

/** A guard that is current until `revoke()`, counting every check. */
function revocableGuard(): { guard: ControllerEffectGuard; revoke(): void; checks(): number } {
  let current = true;
  let checks = 0;
  return {
    guard: { isCurrent: () => { checks += 1; return current; } },
    revoke: () => { current = false; },
    checks: () => checks,
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

const store = (controller: BackgroundExecutionController) => (controller as unknown as { conflictGates: ConflictGateStore }).conflictGates;
const installGate = (controller: BackgroundExecutionController, value: ConflictGate) =>
  (controller as unknown as { setConflictGate: (gate: ConflictGate) => void }).setConflictGate(value);
const pendingMerges = (controller: BackgroundExecutionController) => (controller as unknown as { pendingForceMerges: Map<string, unknown> }).pendingForceMerges;

const MERGE_ATTEMPT = /Interrupt-with-merge is attempting/;
const ownerCommits = (controller: BackgroundExecutionController) => (controller as unknown as { ownerCommits: Set<Promise<void>> }).ownerCommits;

async function durableCommand(root: string, taskId: string, instructionId: string) {
  return (await readGroup(root)).group.tasks.find((task) => task.taskId === taskId)?.commands.find((command) => command.instructionId === instructionId);
}

test("ForceMerge: a caller revoked while waiting for the source lease never crosses; its command fails durably and nothing lands", async () => {
  const scenario = await setupInterruptedMergeTask("guard-lease");
  const { root, controller, started, taskId } = scenario;
  const held = await sourceMutationCoordinator.acquire(root);
  const tails = (sourceMutationCoordinator as unknown as { tails: Map<string, Promise<void>> }).tails;
  const heldTail = tails.get(resolve(root));
  try {
    const caller = revocableGuard();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-guarded", actor: "model" }, { effectGuard: caller.guard });
    merge.catch(() => undefined);
    // Queued behind the held lease: entry, backfill, command, preparation, and pre-lease checks all passed.
    await waitFor(() => tails.get(resolve(root)) !== heldTail);
    assert.equal(caller.checks(), 5);
    caller.revoke();
    held();
    await assert.rejects(merge, { message: EFFECT_GUARD_FORCE_MERGE_REVOKED });
    assert.equal(caller.checks(), 6, "exactly one more check, at the crossing");

    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/, "nothing landed");
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(task.state, "interrupted", "the pre-merge state is kept");
    const command = task.commands.find((candidate) => candidate.instructionId === "force-guarded");
    assert.equal(command?.status, "failed");
    assert.equal(command?.error, EFFECT_GUARD_FORCE_MERGE_REVOKED);
    assert.equal((await durableCommand(started.root, taskId, "force-guarded"))?.status, "failed", "and that outcome is durable");
    assert.equal(pendingMerges(controller).has(taskId), false);
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false, "the lease was released");

    // Control: an unguarded (Pi) force-merge of the same task lands.
    const landed = await controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-unguarded", actor: "user" });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
  } finally {
    held();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("ForceMerge: a caller whose request signal aborts while queued for the source lease settles before the lease is released; nothing lands", async () => {
  const scenario = await setupInterruptedMergeTask("guard-lease-signal");
  const { root, controller, started, taskId } = scenario;
  const held = await sourceMutationCoordinator.acquire(root);
  const tails = (sourceMutationCoordinator as unknown as { tails: Map<string, Promise<void>> }).tails;
  const heldTail = tails.get(resolve(root));
  try {
    // An already-aborted request signal counts as revoked at entry: nothing is recorded.
    await assert.rejects(
      controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-pre-aborted", actor: "model" }, { effectGuard: { isCurrent: () => true, signal: AbortSignal.abort() } }),
      { message: EFFECT_GUARD_FORCE_MERGE_REVOKED },
    );
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]!.commands.some((command) => command.instructionId === "force-pre-aborted"), false);
    const request = new AbortController();
    let checks = 0;
    // The predicate stays current: only the request signal is cancelled.
    const guard: ControllerEffectGuard = { isCurrent: () => { checks += 1; return true; }, signal: request.signal };
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-signal", actor: "model" }, { effectGuard: guard });
    merge.catch(() => undefined);
    await waitFor(() => tails.get(resolve(root)) !== heldTail);
    assert.equal(checks, 5, "queued behind the held lease after the pre-lease check");
    request.abort();
    // The lease is still held: the request must settle on its own.
    await assert.rejects(merge, { message: EFFECT_GUARD_FORCE_MERGE_REVOKED });
    assert.equal(checks, 5, "no crossing check ran");
    assert.equal(pendingMerges(controller).has(taskId), false, "the pending merge was removed");
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(task.state, "interrupted");
    assert.equal(task.commands.find((candidate) => candidate.instructionId === "force-signal")?.status, "failed");
    assert.equal((await durableCommand(started.root, taskId, "force-signal"))?.status, "failed", "durably failed");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/, "nothing landed");

    held();
    // Control: once the holder releases, an unguarded (Pi) force-merge lands.
    const landed = await controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-after-signal", actor: "user" });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
  } finally {
    held();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("ForceMerge: revoked inside the tracked source preparation, the preparation finishes and the merge stops before requesting the lease", async () => {
  const prepared = barrier();
  let leaseRequests = 0;
  const scenario = await setupInterruptedMergeTask("guard-prepare", undefined, {
    faults: { forceMergeSourcePrepared: () => prepared.hook(), forceMergeBeforeLease: () => { leaseRequests += 1; } },
  });
  const { root, controller, started, taskId } = scenario;
  try {
    const caller = revocableGuard();
    prepared.arm();
    const merge = controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-prepare", actor: "model" }, { effectGuard: caller.guard });
    merge.catch(() => undefined);
    await prepared.arrived;
    assert.equal(caller.checks(), 4, "entry, backfill, command, and preparation checks passed");
    assert.equal((await durableCommand(started.root, taskId, "force-prepare"))?.status, "queued", "the command was recorded before preparation");
    caller.revoke();
    prepared.release();
    await assert.rejects(merge, { message: EFFECT_GUARD_FORCE_MERGE_REVOKED });
    assert.equal(caller.checks(), 5, "refused at the pre-lease check");
    assert.equal(leaseRequests, 1, "the pre-lease fault ran (it precedes the check), then no lease was taken");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    assert.equal((await durableCommand(started.root, taskId, "force-prepare"))?.status, "failed");
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "interrupted");
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
  } finally {
    prepared.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("ForceMerge: a caller current through the crossing lands even when revoked right after it; no check runs after the crossing", async () => {
  let checksAtFault = -1;
  let caller: ReturnType<typeof revocableGuard> | undefined;
  const scenario = await setupInterruptedMergeTask("guard-crossed", undefined, {
    faults: { forceMergeBeforeLease: () => { checksAtFault = caller?.checks() ?? -1; } },
  });
  const { root, controller, started, taskId } = scenario;
  try {
    caller = revocableGuard();
    const active = caller;
    // Revoked by the first save after the crossing (the delivered command).
    let revokedAfterCrossing = false;
    const internals = controller as unknown as { save(group: unknown): Promise<unknown> };
    const save = internals.save.bind(controller);
    internals.save = async (group: unknown) => {
      if ((pendingMerges(controller).get(taskId) as { acquired?: boolean } | undefined)?.acquired === true && !revokedAfterCrossing) {
        revokedAfterCrossing = true;
        active.revoke();
      }
      return save(group);
    };
    const landed = await controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-crossed", actor: "model" }, { effectGuard: active.guard });
    delete (internals as { save?: unknown }).save;
    assert.equal(revokedAfterCrossing, true, "the caller was revoked after crossing");
    assert.equal(checksAtFault, 4, "entry, backfill, command, and preparation checks precede the lease");
    assert.equal(active.checks(), 6, "then only the pre-lease and crossing checks; none after the crossing");
    assert.equal(landed.tasks[0]?.state, "landed", "an entered merge settles as on Pi");
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
    assert.equal((await durableCommand(started.root, taskId, "force-crossed"))?.status, "acknowledged");
  } finally {
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("Interrupt: a revoked caller records nothing; an admitted interrupt_with_merge settles and saves its interrupt but never requests the merge once revoked", async () => {
  const scenario = await setupInterruptedMergeTask("guard-interrupt", undefined, { interruptInSetup: false });
  const { root, controller, started, taskId } = scenario;
  try {
    const running = () => controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(running().state, "running");

    // Revoked before entry: no command, no abort; the writer keeps running.
    const early = revocableGuard();
    early.revoke();
    await assert.rejects(
      controller.interrupt({ executionId: started.executionId, taskId, mode: "interrupt_as_failure", instructionId: "interrupt-revoked", actor: "model" }, { effectGuard: early.guard }),
      { message: EFFECT_GUARD_INTERRUPT_REVOKED },
    );
    assert.equal(running().state, "running");
    assert.equal(running().commands.some((command) => command.instructionId === "interrupt-revoked"), false);

    // Admitted, then revoked at its first save: after the synchronous command
    // commit and before the abort is delivered, which still goes through.
    const caller = revocableGuard();
    const internals = controller as unknown as { save(group: unknown): Promise<unknown> };
    const save = internals.save.bind(controller);
    internals.save = async (group: unknown) => {
      caller.revoke();
      return save(group);
    };
    await assert.rejects(
      controller.interrupt({ executionId: started.executionId, taskId, mode: "interrupt_with_merge", instructionId: "interrupt-merge", actor: "model" }, { effectGuard: caller.guard }),
      { message: EFFECT_GUARD_INTERRUPT_MERGE_REVOKED },
    );
    delete (internals as { save?: unknown }).save;
    assert.equal(caller.checks(), 2, "entry and the pre-merge re-proof only: the admitted interrupt settled unchecked");
    const settled = running();
    assert.equal(settled.state, "interrupted", "the interrupt settled");
    assert.equal(settled.commands.find((command) => command.instructionId === "interrupt-merge")?.status, "acknowledged");
    assert.equal((await durableCommand(started.root, taskId, "interrupt-merge"))?.status, "acknowledged", "and was saved");
    assert.equal(settled.commands.some((command) => command.action === "force_merge"), false, "the merge was never requested");
    assert.equal(settled.activity.some((event) => MERGE_ATTEMPT.test(event.message)), false, "no merge attempt is recorded in memory");
    const persisted = (await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(persisted.activity.some((event) => MERGE_ATTEMPT.test(event.message)), false, "nor durably");
    assert.equal(pendingMerges(controller).has(taskId), false);
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/, "nothing landed");

    // Control: the stopped task is still recoverable by an unguarded force-merge.
    const landed = await controller.forceMerge({ executionId: started.executionId, taskId, mergeAnyhow: true, instructionId: "force-after", actor: "user" });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
  } finally {
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("Interrupt: owner retirement (shutdown, then detach) waits for an admitted guarded interrupt's durable outcome and never attempts its merge", async () => {
  const scenario = await setupInterruptedMergeTask("guard-interrupt-retire", undefined, { interruptInSetup: false });
  const { root, controller, started, taskId } = scenario;
  const verification = barrier();
  try {
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]!.state, "running");
    // Pause the post-runtime writer verification of this interrupt.
    const internals = controller as unknown as { unverifiedWriterAfterInterrupt: (...args: unknown[]) => Promise<string | undefined> };
    const verify = internals.unverifiedWriterAfterInterrupt.bind(controller);
    internals.unverifiedWriterAfterInterrupt = async (...args: unknown[]) => {
      await verification.hook();
      return verify(...args);
    };
    verification.arm();
    const caller = revocableGuard();
    const interrupt = controller.interrupt({ executionId: started.executionId, taskId, mode: "interrupt_with_merge", instructionId: "interrupt-retire", actor: "model" }, { effectGuard: caller.guard });
    interrupt.catch(() => undefined);
    await verification.arrived;
    assert.equal(ownerCommits(controller).size, 1, "the admitted settlement is a registered owner commit");
    assert.equal((await durableCommand(started.root, taskId, "interrupt-retire"))?.status, "delivered");

    // Native run revocation: the request falls and custody retires the owner.
    caller.revoke();
    let retired = false;
    const retirement = (async () => {
      await controller.shutdown();
      await controller.detach();
    })().then(() => { retired = true; });
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 100));
    assert.equal(retired, false, "retirement waits for the admitted interrupt's settlement");

    verification.release();
    await retirement;
    await assert.rejects(interrupt, /no longer current|owning session is changing/);
    const persisted = (await readGroup(started.root)).group.tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(persisted.commands.find((command) => command.instructionId === "interrupt-retire")?.status, "acknowledged", "the durable outcome was saved before the attachment was cleared");
    assert.equal(persisted.commands.some((command) => command.action === "force_merge"), false, "no merge was requested");
    assert.equal(persisted.activity.some((event) => MERGE_ATTEMPT.test(event.message)), false, "and no merge attempt was recorded");
    assert.equal(ownerCommits(controller).size, 0);
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/, "nothing landed");
  } finally {
    verification.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("Interrupt: a guarded interrupt is refused during an owner transition; an unguarded one is never tracked as an owner commit", async () => {
  const scenario = await setupInterruptedMergeTask("guard-interrupt-transition", undefined, { interruptInSetup: false });
  const { controller, started, taskId } = scenario;
  try {
    const internals = controller as unknown as { detaching: number };
    internals.detaching += 1;
    try {
      await assert.rejects(
        controller.interrupt({ executionId: started.executionId, taskId, mode: "interrupt_as_failure", instructionId: "interrupt-transition", actor: "model" }, { effectGuard: { isCurrent: () => true } }),
        /Interrupt refused: the owning session is changing/,
      );
    } finally {
      internals.detaching -= 1;
    }
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]!.commands.some((command) => command.instructionId === "interrupt-transition"), false, "nothing recorded");
    // Pi: untracked, exactly as before.
    const unguarded = controller.interrupt({ executionId: started.executionId, taskId, mode: "interrupt_as_failure", instructionId: "interrupt-pi", actor: "user" });
    assert.equal(ownerCommits(controller).size, 0);
    assert.equal((await unguarded).tasks[0]?.state, "interrupted");
  } finally {
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("MarkClean: a guarded clearance serialized behind another never clears a successor gate once its caller is revoked", async () => {
  const publish = barrier();
  let onValidated: (() => void) | undefined;
  let validations = 0;
  const scenario = await setupInterruptedMergeTask("guard-markclean", undefined, {
    faults: {
      publishAssociations: () => publish.hook(),
      markCleanValidated: () => { validations += 1; onValidated?.(); },
    },
  });
  const { root, controller, started, taskId } = scenario;
  try {
    for (const variant of ["revoked during its own validation", "revoked while queued"] as const) {
      await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
      const first = gate(root, started.executionId, taskId, `first gate (${variant})`, ["conflicted.txt"]);
      installGate(controller, first);
      publish.arm();
      const unguarded = controller.markClean({ actor: "user" });
      const caller = revocableGuard();
      const guarded = controller.markClean({ actor: "model", effectGuard: caller.guard });
      guarded.catch(() => undefined);
      // The first clearance removed its gate and is still committing; the guarded call waits behind it.
      await publish.arrived.then(() => undefined);
      const validationsBefore = validations;
      // A successor gate with NO markers: a stale call that wrongly proceeded would validate and clear it.
      await writeFile(join(root, "next.txt"), "no markers here\n", "utf8");
      const successor = gate(root, started.executionId, taskId, `successor gate (${variant})`, ["next.txt"]);
      installGate(controller, successor);
      if (variant === "revoked while queued") caller.revoke();
      else onValidated = () => caller.revoke();
      publish.release();

      assert.deepEqual(await unguarded, { cleared: true, paths: ["conflicted.txt"] }, variant);
      await assert.rejects(guarded, { message: EFFECT_GUARD_MARK_CLEAN_REVOKED }, variant);
      onValidated = undefined;
      if (variant === "revoked while queued") {
        assert.equal(caller.checks(), 2, `${variant}: entry and after the wait`);
        assert.equal(validations, validationsBefore, `${variant}: refused before validating`);
      } else {
        assert.equal(caller.checks(), 3, `${variant}: entry, after the wait, and after validation`);
        assert.equal(validations, validationsBefore + 1, `${variant}: refused after validating`);
      }
      assert.deepEqual(store(controller).list(), [successor], `${variant}: the successor gate stays`);
      assert.deepEqual(store(controller).blockedState(root), { blocked: true, ownReason: successor.reason, foreign: false }, variant);
      assert.deepEqual(controller.associations().conflictGates, [successor], `${variant}: and stays published`);

      // Control: an unguarded (Pi) clearance validates and clears the successor itself.
      assert.deepEqual(await controller.markClean({ actor: "user" }), { cleared: true, paths: ["next.txt"] }, variant);
      assert.equal(sourceMutationCoordinator.blocked(root).blocked, false, variant);
      // Fresh one-shot barrier for the next variant.
      Object.assign(publish, barrier());
    }
  } finally {
    publish.release();
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});
