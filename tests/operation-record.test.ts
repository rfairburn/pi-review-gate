import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireOperationOwner,
  buildOperationDiagnostics,
  createOperationRecord,
  operationOwnershipStatus,
  recordOperationChildExit,
  recordOperationChildProcess,
  releaseOperationOwner,
} from "../src/execution/operation-record";

function operation() {
  return createOperationRecord({
    waveId: "wave-owner",
    taskId: "task-0",
    title: "owner test",
    worktreeRoot: "/tmp/owner-worktree",
    effectiveCwd: "/tmp/owner-worktree",
    artifactDir: "/tmp/owner-artifacts",
    retryBudget: 2,
  });
}

test("operation ownership distinguishes live, released, and confirmed-dead writers", () => {
  const record = operation();
  acquireOperationOwner(record);
  const lifecycle = recordOperationChildProcess(record, process.pid, process.pid);
  assert.equal(operationOwnershipStatus(record).status, "live");
  assert.equal(operationOwnershipStatus(record).processAlive, true);

  releaseOperationOwner(record);
  assert.equal(operationOwnershipStatus(record).status, "released");
  assert.equal(operationOwnershipStatus(record).processAlive, false);

  record.owner = {
    version: 1,
    instanceId: "dead-instance",
    hostPid: 2_147_483_647,
    childPid: 2_147_483_646,
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    status: "active",
  };
  assert.equal(operationOwnershipStatus(record).status, "dead");
  assert.equal(operationOwnershipStatus(record).processAlive, false);

  record.owner = {
    version: 1,
    instanceId: "dead-host-exited-child",
    hostPid: 2_147_483_647,
    childPid: process.pid,
    childProcessGroupId: process.pid,
    childLifecycleId: lifecycle.lifecycleId,
    childStartedAt: new Date().toISOString(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    status: "active",
  };
  assert.equal(recordOperationChildExit(record, lifecycle), true);
  assert.equal(operationOwnershipStatus(record).status, "dead", "an acknowledged child exit must not be confused with PID reuse");
});

test("late operation-child exit is fenced from a newer durable child identity", () => {
  const record = operation();
  acquireOperationOwner(record);
  const first = recordOperationChildProcess(record, 31_001, 31_001);
  const second = recordOperationChildProcess(record, 31_002, 31_002);

  assert.equal(recordOperationChildExit(record, first), false);
  assert.equal(record.owner?.childPid, second.pid);
  assert.equal(record.owner?.childProcessGroupId, second.processGroupId);
  assert.equal(record.owner?.childLifecycleId, second.lifecycleId);
  assert.equal(record.owner?.childExitedAt, undefined);
  assert.equal(recordOperationChildExit(record, second), true);
  assert.ok(record.owner?.childExitedAt);
});

test("a cancelled operation with a verified checkpoint remains explicitly continuable", async () => {
  const record = operation();
  record.state = "cancelled";
  record.checkpoint = {
    checkpointId: "cancelled-checkpoint",
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    ref: "refs/pi-review-gate/recovery/cancelled",
    differsFromBase: true,
    createdAt: new Date().toISOString(),
    verified: true,
    changedPaths: ["partial.txt"],
  };

  const diagnostics = await buildOperationDiagnostics(record, "/tmp/wave-cancelled");

  assert.equal(diagnostics.retryable, true);
  assert.deepEqual(diagnostics.recovery.safeActions, ["inspect", "continue"]);
  assert.match(diagnostics.recovery.recommendedAction, /continue/i);
});
