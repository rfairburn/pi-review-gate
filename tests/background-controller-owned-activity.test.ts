/**
 * Focused synthetic tests for background-execution owned-work telemetry
 * (src/execution/background-controller.ts).
 *
 * The pure ownership predicate is exercised directly, and real controllers
 * (with no worker capacity) cover the authoritative-lifecycle rules: execution
 * telemetry is UNKNOWN before and during every restore, UNKNOWN after a failed
 * or association-refusing restore, and only a successful completion establishes
 * zero. No executor process, PTY, or shell is spawned.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackgroundExecutionController, taskOwnsUnsettledWork } from "../src/execution/background-controller";
import { createState } from "../src/state";
import {
  activateOwnedActivity,
  ownedActivitySnapshot,
  registerOwnedActivitySource,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import { boundedScalingConfig, controllerInternals, initGitRepo } from "./helpers/background-controller-fixtures";

test("task ownership predicate retains bundle-less started work until an archivable outcome", () => {
  // Active/queued logical work.
  assert.equal(taskOwnsUnsettledWork({ state: "queued" }, false, false), true);
  assert.equal(taskOwnsUnsettledWork({ state: "running", generation: 1 }, false, false), true);
  // A live runtime or force-merge is owned regardless of state.
  assert.equal(taskOwnsUnsettledWork({ state: "stopped_for_application_exit" }, true, false), true);
  assert.equal(taskOwnsUnsettledWork({ state: "failed" }, false, true), true);

  // Bundle-less started work is NOT settled: in-place settlement clears the
  // bundle while its executor loop can retain an unverified child owner, and
  // wave recovery can fail before a bundle is assigned.
  assert.equal(
    taskOwnsUnsettledWork({ state: "paused_recoverable", generation: 1 }, false, false),
    true,
    "a started in-place task that cleared its bundle stays owned",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "stopped_for_application_exit", generation: 3 }, false, false),
    true,
    "a started task stopped at application exit stays owned",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "paused_recoverable", inplaceResult: { operationRecord: "/op.json" } }, false, false),
    true,
    "an in-place operation record is an ownership anchor",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "failed", waveRoot: "/wave" }, false, false),
    true,
    "a failed task with a wave anchor stays owned",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "failed", bundle: { operationId: "op-1" } }, false, false),
    true,
    "a durable continuation bundle is an ownership anchor",
  );

  // Undispatched work and authoritative settled outcomes release.
  assert.equal(
    taskOwnsUnsettledWork({ state: "failed" }, false, false),
    false,
    "an undispatched failed task (generation 0, no anchors) is settled",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "stopped_for_application_exit" }, false, false),
    false,
    "an undispatched queued task stopped at application exit is settled",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "landed", generation: 2, waveRoot: "/wave", bundle: { operationId: "op-1" } }, false, false),
    false,
    "an archivable outcome releases even with former anchors",
  );
});

test("every restore invalidates completeness before its first await", async () => {
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => process.cwd(),
    });

    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "unknown before the first restore");

    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "a complete restore establishes zero");

    // A subsequent restore must invalidate the prior zero synchronously, before
    // its first await, even though it has no current tasks.
    const pending = controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(
      ownedActivitySnapshot().backgroundTasks,
      null,
      "the new restore invalidates completeness before any asynchronous work",
    );
    await pending;
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "successful completion re-establishes zero");

    const missingRoot = join(tmpdir(), `prg-missing-group-${randomUUID()}`);
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [missingRoot] });
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "a failed restore keeps execution unknown");

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a refused inner association recovery keeps execution unknown, never zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-owned-recovery-"));
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    await initGitRepo(root);
    // Opt in before the controller lifecycle so its registration is installed
    // (not replayed) and can be authoritatively resolved by a real restore.
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "a clean restore establishes zero");

    const started = await controller.start([{ title: "seed task", instructions: "seed", acceptanceCriteria: ["done"] }]);
    // Give the queued execute task a wave anchor that does not exist on disk, so
    // its recovery backfill is refused while readGroup itself succeeds.
    const internals = controllerInternals(controller);
    const group = internals.groups.get(started.executionId)!;
    group.tasks[0]!.waveRoot = join(root, "missing-wave-root");
    await internals.save(group);
    const associations = controller.associations();

    // The next restore marks execution unknown at entry, then refuses the inner
    // association recovery: it must NOT finish as a complete (zero) restore.
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: associations.groupRoots });
    assert.equal(
      ownedActivitySnapshot().backgroundTasks,
      null,
      "an unresolved association recovery cannot finish as a complete (zero) restore",
    );

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    // Git/controller-created descendants have no per-entry creation/settlement
    // receipts here. Retain them rather than recursively claiming their ownership.
    console.info(`owned-recovery fixture retained (descendant ownership unproven): ${root}`);
  }
});
