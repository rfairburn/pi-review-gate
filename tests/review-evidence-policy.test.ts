import assert from "node:assert/strict";
import test from "node:test";
import { effectiveReviewEvidenceSettings, normalizeConfig } from "../src/config";
import { rewriteTaskPaths, type WaveWorkerTask } from "../src/execution/wave-worker";
import { newTask } from "../src/execution/task-state";
import {
  captureWorkerReviewEvidencePolicy,
  normalizeWorkerReviewEvidencePolicy,
} from "../src/execution/review-evidence-policy";

const legacyTask: WaveWorkerTask = {
  title: "example",
  instructions: "edit files",
  acceptanceCriteria: ["tests pass"],
};

test("worker evidence policy uses canonical settings and remains scoped to its task kind", () => {
  const defaults = effectiveReviewEvidenceSettings(normalizeConfig({}));
  assert.deepEqual(captureWorkerReviewEvidencePolicy(defaults, "execute"), {
    toolOnly: false,
    snapshotFailureFallback: false,
    scope: "worktree",
  });
  assert.deepEqual(captureWorkerReviewEvidencePolicy(defaults, "inplace"), {
    toolOnly: false,
    snapshotFailureFallback: false,
    scope: "inplace",
  });

  const config = normalizeConfig({
    review: {
      evidence: {
        primaryToolOnly: true,
        worktreeToolOnly: true,
        inplaceToolOnly: false,
        snapshotFailureFallback: true,
      },
    },
  });
  const settings = effectiveReviewEvidenceSettings(config);
  assert.deepEqual(captureWorkerReviewEvidencePolicy(settings, "execute"), {
    toolOnly: true,
    snapshotFailureFallback: true,
    scope: "worktree",
  });
  assert.deepEqual(captureWorkerReviewEvidencePolicy(settings, "inplace"), {
    toolOnly: false,
    snapshotFailureFallback: true,
    scope: "inplace",
  });
  assert.deepEqual(captureWorkerReviewEvidencePolicy(settings, "research"), {
    toolOnly: false,
    snapshotFailureFallback: false,
    scope: "worktree",
  });
});

test("legacy task policies default off and persisted choices survive task-path rewriting", () => {
  const legacy = newTask(legacyTask);
  assert.deepEqual(legacy.definition.reviewEvidencePolicy, {
    toolOnly: false,
    snapshotFailureFallback: false,
    scope: "worktree",
  });

  const admitted = newTask({
    ...legacyTask,
    reviewEvidencePolicy: { toolOnly: true, snapshotFailureFallback: true, scope: "worktree" },
  });
  const rewritten = rewriteTaskPaths(admitted.definition, "/repo", "/worker/repo");
  assert.deepEqual(rewritten.reviewEvidencePolicy, {
    toolOnly: true,
    snapshotFailureFallback: true,
    scope: "worktree",
  });
  assert.deepEqual(normalizeWorkerReviewEvidencePolicy(undefined), {
    toolOnly: false,
    snapshotFailureFallback: false,
    scope: "worktree",
  });
  assert.deepEqual(normalizeWorkerReviewEvidencePolicy({ toolOnly: true, snapshotFailureFallback: false }, "inplace"), {
    toolOnly: true,
    snapshotFailureFallback: false,
    scope: "inplace",
  });
  assert.throws(() => normalizeWorkerReviewEvidencePolicy({ toolOnly: "yes", snapshotFailureFallback: true }), /invalid/);
  assert.throws(() => normalizeWorkerReviewEvidencePolicy({ toolOnly: true, snapshotFailureFallback: false, scope: "inplace" }, "worktree"), /invalid/);
});
