import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { materializeLandingConflicts, unresolvedConflictMarkers } from "../src/execution/conflict-materialization";
import { normalizeCandidate } from "../src/execution/wave-commits";
import { integrateWave } from "../src/execution/wave-integration";
import { planWaveLanding } from "../src/execution/wave-landing";
import { captureWaveBase } from "../src/execution/wave-repository";
import { createWorkerWorktree, pinCommit } from "../src/execution/wave-worktrees";

const execFileAsync = promisify(execFile);

test("conflict materialization applies clean paths and leaves ordinary markers only on conflicts", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-review-conflict-source-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-conflict-artifacts-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: source });
    await writeFile(join(source, "common.txt"), "base\n", "utf8");
    await writeFile(join(source, "clean.txt"), "clean base\n", "utf8");
    await writeFile(join(source, "delete.txt"), "delete me\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "conflict-wave" });
    const worker = await createWorkerWorktree(capture, "task-one");
    await writeFile(join(worker.worktreeRoot, "common.txt"), "worker\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "clean.txt"), "clean worker\n", "utf8");
    await rm(join(worker.worktreeRoot, "delete.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    await writeFile(join(source, "common.txt"), "user\n", "utf8");
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.conflicts.map((entry) => entry.path), ["common.txt"]);
    const materialized = await materializeLandingConflicts(capture, plan, "subtask task-one");
    assert.deepEqual(materialized.paths, ["common.txt"]);
    const conflict = await readFile(join(source, "common.txt"), "utf8");
    assert.match(conflict, /<<<<<<< current workspace/);
    assert.match(conflict, /user/);
    assert.match(conflict, /worker/);
    assert.equal(await readFile(join(source, "clean.txt"), "utf8"), "clean worker\n");
    await assert.rejects(access(join(source, "delete.txt")));
    assert.deepEqual(await unresolvedConflictMarkers(source, materialized.paths), ["common.txt"]);
    await writeFile(join(source, "common.txt"), "resolved\n", "utf8");
    assert.deepEqual(await unresolvedConflictMarkers(source, materialized.paths), []);
    assert.equal(JSON.parse(await readFile(materialized.manifestPath, "utf8")).paths.length, 3);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});
