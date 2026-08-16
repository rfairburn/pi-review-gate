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
  recordOperationChildProcess(record, process.pid, process.pid);
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
    childStartedAt: new Date().toISOString(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    status: "active",
  };
  recordOperationChildExit(record);
  assert.equal(operationOwnershipStatus(record).status, "dead", "an acknowledged child exit must not be confused with PID reuse");
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
