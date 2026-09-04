import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import {
  candidateRefName,
  candidateSnapshotRefName,
  normalizeCandidate,
  pinReviewCycleCandidate,
  recoveryRefName,
  reviewCycleAliasRefName,
  verifyReviewCycleIdentity,
  waveLineageOf,
  type PriorCandidate,
} from "../src/execution/wave-commits";
import {
  createOperationRecord,
  writeOperationRecord,
  type OperationRecord,
  type RecoveryCheckpoint,
} from "../src/execution/operation-record";
import { reconcileAbandonedOperation, verifyRecoveryCheckpoint } from "../src/execution/operation-actions";
import { runExecutorWithRecovery } from "../src/execution/executor-recovery";
import type { ExecutorAdapter, ExecutorTurn } from "../src/execution/types";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

async function gitInRepo(args: string[], repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
  });
  return stdout.trim();
}

async function mkTmp(prefix: string): Promise<string> {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function setupCapture(
  artifactDir: string,
  waveId = "test-wave",
): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-imm-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await writeFile(join(sourceDir, "app.js"), "console.log('hi');\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId,
    artifactDir,
  });
  return { sourceDir, capture };
}

/** Write a marker file so the worktree tree becomes `marker-${name}`. */
async function writeMarker(worktreeRoot: string, name: string): Promise<void> {
  await writeFile(join(worktreeRoot, `${name}.txt`), `${name}\n`, "utf8");
}

async function refSha(repoPath: string, ref: string): Promise<string> {
  return gitInRepo(["rev-parse", "--verify", ref], repoPath).catch(() => "");
}

/** Create a commit object with a specific parent and message (message via stdin). */
async function gitCommitTree(
  repoPath: string,
  treeSha: string,
  parentSha: string,
  message: string,
): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", ["commit-tree", treeSha, "-p", parentSha], {
      cwd: repoPath,
      env: { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git commit-tree exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolvePromise(stdout.trim());
      }
    });
    child.stdin.write(message);
    child.stdin.end();
  });
}

async function worktreeCount(repoPath: string): Promise<number> {
  const out = await gitInRepo(["worktree", "list", "--porcelain"], repoPath);
  return out.split("\n").filter((line) => line.startsWith("worktree ")).length;
}

// ── A-reviewed / B-recovery / C-final stale-CAS sequence ─────────────────────

test("immutable refs — A-reviewed/B-recovery/C-final stale-CAS sequence keeps every candidate", async () => {
  const artifactDir = await mkTmp("pi-imm-abc-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-abc");
    const repoPath = capture.repositoryPath;
    const legacyCandidates = candidateRefName(capture.waveId, "task-abc");
    const legacyRecovery = recoveryRefName(capture.waveId, "task-abc");

    // A: initial candidate, reviewed (legacy mutable refs pinned at A by the
    // prior implementation, plus the immutable cycle-1 alias).
    await writeMarker(worker.worktreeRoot, "a-change");
    const a = await normalizeCandidate(capture, worker.worktreeRoot, "task-abc", "A");
    await gitInRepo(["update-ref", legacyCandidates, a.commitSha], repoPath);
    await gitInRepo(["update-ref", legacyRecovery, a.commitSha], repoPath);
    const alias1 = await pinReviewCycleCandidate(capture, "task-abc", 1, {
      commitSha: a.commitSha,
      treeSha: a.treeSha,
    });
    assert.equal(alias1, reviewCycleAliasRefName(capture.waveId, "task-abc", 1));

    // B: recovery checkpoint candidate (different tree), durable checkpoint
    // identity recorded with its actual snapshot ref.
    await writeMarker(worker.worktreeRoot, "b-recovery");
    const b = await normalizeCandidate(capture, worker.worktreeRoot, "task-abc", "B recovery", {
      commitSha: a.commitSha,
      treeSha: a.treeSha,
      ref: legacyRecovery,
    });
    const checkpointB: RecoveryCheckpoint = {
      checkpointId: "op:2",
      commitSha: b.commitSha,
      treeSha: b.treeSha,
      ref: b.candidateRef,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: [],
    };
    assert.equal(await refSha(repoPath, checkpointB.ref), b.commitSha);

    // C: a stale writer resumes with the ORIGINAL reviewed candidate identity
    // (A, carrying A's actual immutable ref) while the durable state has
    // already moved to B. This used to be the stale compare-and-swap failure;
    // with content-addressed create-once refs A's ref is immutable and C's
    // fresh tree simply pins its own new ref.
    await writeMarker(worker.worktreeRoot, "c-final");
    const stalePriorA: PriorCandidate = { commitSha: a.commitSha, treeSha: a.treeSha, ref: a.candidateRef };
    // A legacy-era writer replaced the mutable candidates ref meanwhile; the
    // new flow never reads or writes it for identity decisions.
    await gitInRepo(["update-ref", legacyCandidates, b.commitSha], repoPath);
    const c = await normalizeCandidate(capture, worker.worktreeRoot, "task-abc", "C final", stalePriorA);

    // Every candidate remains pinned under its own immutable ref.
    assert.equal(await refSha(repoPath, a.candidateRef), a.commitSha);
    assert.equal(await refSha(repoPath, b.candidateRef), b.commitSha);
    assert.equal(await refSha(repoPath, c.candidateRef), c.commitSha);
    assert.notEqual(a.candidateRef, b.candidateRef);
    assert.notEqual(b.candidateRef, c.candidateRef);

    // The immutable aliases and snapshot refs are distinct namespaces.
    assert.equal(await refSha(repoPath, alias1), a.commitSha, "cycle-1 alias still pins A");

    // Legacy mutable refs were not written by the new implementation after
    // the simulated legacy era: recovery/<task> still pins B-era state and
    // the snapshot flow never recreated or moved it.
    assert.equal(await refSha(repoPath, legacyRecovery), a.commitSha);
    assert.equal(await refSha(repoPath, legacyCandidates), b.commitSha);

    // Worktree ended clean at C.
    const status = await git(["status", "--porcelain", "--untracked-files=all"], worker.worktreeRoot);
    assert.equal(status, "");
    const head = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    assert.equal(head, c.commitSha);

    // No extra repositories or worktrees appeared.
    const worktrees = await worktreeCount(repoPath);
    assert.equal(worktrees, 2, "only the wave repo and the single worker worktree exist");
    const repoDirs = await gitInRepo(["rev-parse", "--absolute-git-dir"], repoPath);
    assert.ok(repoDirs.endsWith(".git") || repoDirs === repoPath, "single private repository");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── same-tree races ──────────────────────────────────────────────────────────

test("immutable refs — same-tree races adopt one proven commit and one ref", async () => {
  const artifactDir = await mkTmp("pi-imm-race-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const w1 = await createWorkerWorktree(capture, "task-race");
    // A second detached worktree for the same task identity (as a recreated
    // recovery worktree would be), populated with the identical tree.
    const altRoot = join(capture.waveRoot, "workers", "task-race-alt");
    await mkdir(altRoot, { recursive: true });
    await git(["worktree", "add", "--detach", altRoot, capture.baseCommit], capture.repositoryPath);
    const w2 = { worktreeRoot: altRoot, effectiveCwd: altRoot };
    await writeMarker(w1.worktreeRoot, "same-tree");
    await writeMarker(w2.worktreeRoot, "same-tree");
    const baselineWorktrees = await worktreeCount(capture.repositoryPath);

    const [r1, r2] = await Promise.all([
      normalizeCandidate(capture, w1.worktreeRoot, "task-race", "Race one"),
      normalizeCandidate(capture, w2.worktreeRoot, "task-race", "Race two"),
    ]);

    assert.equal(r1.candidateRef, r2.candidateRef, "same tree must resolve to one content-addressed ref");
    assert.equal(r1.treeSha, r2.treeSha);

    // Both results adopt the same proven commit.
    assert.equal(r1.commitSha, r2.commitSha, "race loser must adopt the winner's proven commit");

    const pinned = await refSha(capture.repositoryPath, r1.candidateRef);
    assert.equal(pinned, r1.commitSha);

    // Normalization created no additional repositories or worktrees.
    assert.equal(await worktreeCount(capture.repositoryPath), baselineWorktrees, "no additional worktrees");

    // Both worktrees ended clean on the adopted commit.
    for (const w of [w1, w2]) {
      const status = await git(["status", "--porcelain", "--untracked-files=all"], w.worktreeRoot);
      assert.equal(status, "");
      const head = await git(["rev-parse", "HEAD"], w.worktreeRoot);
      assert.equal(head, r1.commitSha);
      await removeWorktree(w.worktreeRoot, capture.repositoryPath);
    }

    await git(["worktree", "remove", "--force", altRoot], capture.repositoryPath).catch(() => {});
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── different-tree independence ──────────────────────────────────────────────

test("immutable refs — different trees are independent and coexist", async () => {
  const artifactDir = await mkTmp("pi-imm-diff-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-diff");

    await writeMarker(worker.worktreeRoot, "tree-one");
    const one = await normalizeCandidate(capture, worker.worktreeRoot, "task-diff", "Tree one");

    await writeMarker(worker.worktreeRoot, "tree-two");
    const two = await normalizeCandidate(capture, worker.worktreeRoot, "task-diff", "Tree two");

    assert.notEqual(one.treeSha, two.treeSha);
    assert.notEqual(one.candidateRef, two.candidateRef);
    assert.equal(await refSha(capture.repositoryPath, one.candidateRef), one.commitSha);
    assert.equal(await refSha(capture.repositoryPath, two.candidateRef), two.commitSha);
    // The earlier candidate is not lost by later normalization.
    assert.equal(await refSha(capture.repositoryPath, one.candidateRef), one.commitSha);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── alias mutation rejection ─────────────────────────────────────────────────

test("immutable refs — review cycle aliases reject mutation and stay idempotent", async () => {
  const artifactDir = await mkTmp("pi-imm-alias-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-alias");

    await writeMarker(worker.worktreeRoot, "alpha");
    const alpha = await normalizeCandidate(capture, worker.worktreeRoot, "task-alias", "Alpha");
    await writeMarker(worker.worktreeRoot, "beta");
    const beta = await normalizeCandidate(capture, worker.worktreeRoot, "task-alias", "Beta");

    const alias1 = await pinReviewCycleCandidate(capture, "task-alias", 1, {
      commitSha: alpha.commitSha,
      treeSha: alpha.treeSha,
    });

    // Re-pinning the same commit for the same cycle is idempotent.
    const again = await pinReviewCycleCandidate(capture, "task-alias", 1, {
      commitSha: alpha.commitSha,
      treeSha: alpha.treeSha,
    });
    assert.equal(again, alias1);

    // Recording a different candidate for an existing cycle fails closed.
    await assert.rejects(
      pinReviewCycleCandidate(capture, "task-alias", 1, {
        commitSha: beta.commitSha,
        treeSha: beta.treeSha,
      }),
      /immutable and points to/,
    );
    assert.equal(await refSha(capture.repositoryPath, alias1), alpha.commitSha, "alias unchanged after rejected mutation");

    // A later cycle can pin a different candidate.
    const alias2 = await pinReviewCycleCandidate(capture, "task-alias", 2, {
      commitSha: beta.commitSha,
      treeSha: beta.treeSha,
    });
    assert.equal(await refSha(capture.repositoryPath, alias2), beta.commitSha);

    // Read-only re-verification detects alias corruption.
    await verifyReviewCycleIdentity(capture, "task-alias", alias1, {
      commitSha: alpha.commitSha,
      treeSha: alpha.treeSha,
    });
    await gitInRepo(["update-ref", alias1, beta.commitSha], capture.repositoryPath);
    await assert.rejects(
      verifyReviewCycleIdentity(capture, "task-alias", alias1, {
        commitSha: alpha.commitSha,
        treeSha: alpha.treeSha,
      }),
      /points to/,
    );
    await gitInRepo(["update-ref", alias1, alpha.commitSha], capture.repositoryPath);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── identity proof fail-closed ───────────────────────────────────────────────

test("immutable refs — snapshot refs that fail the identity proof fail closed", async () => {
  const artifactDir = await mkTmp("pi-imm-corrupt-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-corrupt");

    await writeMarker(worker.worktreeRoot, "planned");
    const planned = await normalizeCandidate(capture, worker.worktreeRoot, "task-corrupt", "Planned");

    // Pre-plant the planned tree's snapshot ref at the wave base commit,
    // which does not prove the candidate identity.
    const corruptRef = candidateSnapshotRefName(capture.waveId, "task-corrupt", planned.treeSha);
    await gitInRepo(["update-ref", corruptRef, capture.baseCommit], capture.repositoryPath);

    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-corrupt", "Corrupt"),
      /does not prove|parent is/,
    );
    assert.equal(await refSha(capture.repositoryPath, corruptRef), capture.baseCommit, "corrupt ref untouched");

    // A legacy prior ref that no longer pins its recorded commit fails closed.
    const legacyRecovery = recoveryRefName(capture.waveId, "task-corrupt");
    await gitInRepo(["update-ref", legacyRecovery, capture.baseCommit], capture.repositoryPath);
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-corrupt", "Legacy stale", {
        commitSha: planned.commitSha,
        treeSha: planned.treeSha,
        ref: legacyRecovery,
      }),
      /points to .* expected|Refusing to continue from an unverified prior candidate/,
    );

    // Cleanup the manually created legacy ref before worktree removal.
    await gitInRepo(["update-ref", "-d", legacyRecovery], capture.repositoryPath);
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── legacy continuation migration ────────────────────────────────────────────

test("immutable refs — legacy recovery checkpoint migrates lazily on adoption", async () => {
  const artifactDir = await mkTmp("pi-imm-legacy-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-legacy");
    const repoPath = capture.repositoryPath;

    await writeMarker(worker.worktreeRoot, "legacy-work");
    const legacy = await normalizeCandidate(capture, worker.worktreeRoot, "task-legacy", "Legacy work");

    // Simulate the legacy era: only the mutable recovery ref exists.
    const legacyRecovery = recoveryRefName(capture.waveId, "task-legacy");
    await gitInRepo(["update-ref", legacyRecovery, legacy.commitSha], repoPath);
    assert.equal(await refSha(repoPath, candidateRefName(capture.waveId, "task-legacy")), "", "no candidates ref");

    // A later continuation adopts the durable legacy checkpoint with an
    // unchanged tree: it must keep the same commit and migrate the identity
    // onto the immutable snapshot ref without writing the legacy ref.
    await git(["reset", "--hard", legacy.commitSha], worker.worktreeRoot);
    const adopted = await normalizeCandidate(capture, worker.worktreeRoot, "task-legacy", "Legacy work", {
      commitSha: legacy.commitSha,
      treeSha: legacy.treeSha,
      ref: legacyRecovery,
    });

    assert.equal(adopted.commitSha, legacy.commitSha, "unchanged tree adopts the durable checkpoint commit");
    assert.equal(adopted.candidateRef, candidateSnapshotRefName(capture.waveId, "task-legacy", legacy.treeSha));
    assert.equal(await refSha(repoPath, adopted.candidateRef), legacy.commitSha, "snapshot ref migrated lazily");
    assert.equal(await refSha(repoPath, legacyRecovery), legacy.commitSha, "legacy recovery ref untouched");
    assert.equal(await refSha(repoPath, candidateRefName(capture.waveId, "task-legacy")), "", "legacy candidates ref never written");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── executor-recovery honors the durable operation checkpoint ────────────────

test("immutable refs — executor-recovery adopts the durable operation checkpoint as its initial prior", async () => {
  const artifactDir = await mkTmp("pi-imm-recovery-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-recov");
    const artifactPath = join(capture.waveRoot, "artifacts", "task-recov");
    await mkdir(artifactPath, { recursive: true });
    const repoPath = capture.repositoryPath;

    // Durable checkpoint from a prior run, pinned under the legacy mutable
    // recovery ref (pre-migration record shape).
    await writeMarker(worker.worktreeRoot, "durable-work");
    const durable = await normalizeCandidate(capture, worker.worktreeRoot, "task-recov", "Durable work");
    const legacyRecovery = recoveryRefName(capture.waveId, "task-recov");
    await gitInRepo(["update-ref", legacyRecovery, durable.commitSha], repoPath);
    const durableCheckpoint: RecoveryCheckpoint = {
      checkpointId: "op:1",
      commitSha: durable.commitSha,
      treeSha: durable.treeSha,
      ref: legacyRecovery,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: ["durable-work.txt"],
    };

    const operation: OperationRecord = createOperationRecord({
      waveId: capture.waveId,
      taskId: "task-recov",
      title: "Recovery test",
      worktreeRoot: worker.worktreeRoot,
      effectiveCwd: worker.effectiveCwd,
      artifactDir: artifactPath,
      retryBudget: 2,
    });
    operation.checkpoint = durableCheckpoint;
    await writeOperationRecord(operation);

    // Adapter fails once (empty response), then completes with no further
    // workspace changes. The first recovery checkpoint must adopt the
    // durable checkpoint's commit and migrate its ref onto the immutable
    // snapshot namespace instead of creating a parallel candidate.
    let calls = 0;
    const turn: ExecutorTurn = {
      text: "Recovered and finished.",
      session: { adapter: "fake", id: "recov-session" },
      stdoutPath: join(artifactPath, "stdout.log"),
      stderrPath: join(artifactPath, "stderr.log"),
      code: 0,
      timedOut: false,
      aborted: false,
    };
    const adapter: ExecutorAdapter = {
      kind: "fake",
      model: "fake-model",
      run: async () => {
        calls += 1;
        if (calls === 1) {
          return { ...turn, text: "" };
        }
        return turn;
      },
    };

    const result = await runExecutorWithRecovery({
      adapter,
      request: {
        cwd: worker.effectiveCwd,
        artifactDir: artifactPath,
        workspaceAccess: "workspace-write",
        signal: undefined,
      },
      prompt: "Recover the work.",
      startingTurn: 2,
      capture,
      worktree: worker,
      taskId: "task-recov",
      title: "Recovery test",
      retryPolicy: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 2 },
      operation,
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    const checkpoint = operation.checkpoint!;
    assert.equal(checkpoint.commitSha, durable.commitSha, "recovery checkpoint adopted the durable commit");
    assert.equal(checkpoint.ref, candidateSnapshotRefName(capture.waveId, "task-recov", durable.treeSha), "checkpoint ref migrated to the immutable snapshot ref");
    assert.equal(await refSha(repoPath, checkpoint.ref), durable.commitSha);
    assert.equal(await refSha(repoPath, legacyRecovery), durable.commitSha, "legacy recovery ref was not rewritten");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── no extra repositories/worktrees during ref operations ────────────────────

test("immutable refs — pinning candidates and aliases creates no repositories or worktrees", async () => {
  const artifactDir = await mkTmp("pi-imm-noextra-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-noextra");
    const before = await worktreeCount(capture.repositoryPath);

    await writeMarker(worker.worktreeRoot, "work");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-noextra", "Work");
    await pinReviewCycleCandidate(capture, "task-noextra", 1, {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
    });

    assert.equal(await worktreeCount(capture.repositoryPath), before, "no additional worktrees");
    // The wave repo remains the only git repository: refs are stored inside it.
    const refs = await gitInRepo(
      ["for-each-ref", "--format=%(refname)", "refs/pi-review-gate/"],
      capture.repositoryPath,
    );
    assert.ok(refs.includes(candidate.candidateRef));
    assert.ok(refs.includes(reviewCycleAliasRefName(capture.waveId, "task-noextra", 1)));

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── trailer-like task titles must not shadow the identity trailers ──────────

test("immutable refs — trailer-like task titles do not shadow the identity trailers", async () => {
  const artifactDir = await mkTmp("pi-imm-titles-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-titles");
    const repoPath = capture.repositoryPath;

    // Titles that begin with each trailer key (and a combined one) must not
    // be mistaken for the commit's identity trailers. Each iteration uses a
    // fresh tree so every candidate pins its own snapshot ref.
    const titles = [
      "Wave-Id: example",
      "Task-Id: example",
      "Fix Wave-Id: fake and Task-Id: fake",
    ];
    for (const [index, title] of titles.entries()) {
      await writeMarker(worker.worktreeRoot, `title-${index}`);
      const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-titles", title);

      // Pinning the review alias re-verifies tree/base/wave/task identity
      // from the commit's final trailer block.
      const alias = await pinReviewCycleCandidate(capture, "task-titles", index + 1, {
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
      });
      assert.equal(alias, reviewCycleAliasRefName(capture.waveId, "task-titles", index + 1));
      assert.equal(await refSha(repoPath, alias), candidate.commitSha);

      // Re-normalizing the unchanged tree must adopt the same proven commit
      // (the adoption path verifies the trailer identity as well).
      const adopted = await normalizeCandidate(capture, worker.worktreeRoot, "task-titles", title, {
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
        ref: candidate.candidateRef,
      });
      assert.equal(adopted.commitSha, candidate.commitSha);
      assert.equal(adopted.candidateRef, candidate.candidateRef);
    }

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── explicit lineage resolution ──────────────────────────────────────────────

test("immutable refs — waveLineageOf resolves and validates explicit lineage", () => {
  // Original captures (no lineage fields) are generation 0 of their own id.
  assert.deepEqual(waveLineageOf({ waveId: "plain" }), { rootWaveId: "plain", generation: 0 });
  assert.deepEqual(
    waveLineageOf({ waveId: "release-g2", rootWaveId: "release-g2", continuationGeneration: 0 }),
    { rootWaveId: "release-g2", generation: 0 },
  );
  // A valid original wave id ending in -gN is the ROOT of its own chain.
  assert.deepEqual(
    waveLineageOf({ waveId: "release-g2-g1", rootWaveId: "release-g2", continuationGeneration: 1 }),
    { rootWaveId: "release-g2", generation: 1 },
  );
  // Inconsistent or partial lineage fails closed.
  assert.throws(
    () => waveLineageOf({ waveId: "other-wave-g1", rootWaveId: "release-g2", continuationGeneration: 1 }),
    /Invalid continuation lineage/,
  );
  assert.throws(
    () => waveLineageOf({ waveId: "release-g2-g1", rootWaveId: "release-g2" }),
    /Invalid continuation lineage/,
  );
  assert.throws(
    () => waveLineageOf({ waveId: "release-g2-g1", continuationGeneration: 1 }),
    /Invalid continuation lineage/,
  );
});

// ── continuation of an original wave id that itself ends in -gN ─────────────

test("immutable refs — continuation of an original wave id ending in -gN adopts the prior candidate", async () => {
  const artifactDir = await mkTmp("pi-imm-gwave-");
  try {
    // A valid ORIGINAL wave id that itself ends in "-gN".
    const { capture } = await setupCapture(artifactDir, "release-g2");
    const worker = await createWorkerWorktree(capture, "task-gwave");
    const repoPath = capture.repositoryPath;

    await writeMarker(worker.worktreeRoot, "g-work");
    const original = await normalizeCandidate(capture, worker.worktreeRoot, "task-gwave", "Original work");
    assert.equal(await refSha(repoPath, original.candidateRef), original.commitSha);

    // First continuation of this wave: release-g2-g1, with the explicit
    // root/generation lineage carried on the capture.
    const continuation = {
      ...capture,
      waveId: "release-g2-g1",
      rootWaveId: "release-g2",
      continuationGeneration: 1,
    };

    // Unchanged tree: the continuation must adopt the original-wave commit;
    // its trailer (Wave-Id: release-g2) is generation 0 of the same chain.
    const adopted = await normalizeCandidate(continuation, worker.worktreeRoot, "task-gwave", "Original work", {
      commitSha: original.commitSha,
      treeSha: original.treeSha,
      ref: original.candidateRef,
    });
    assert.equal(adopted.commitSha, original.commitSha, "unchanged tree adopts the original-wave commit");
    assert.equal(adopted.candidateRef, candidateSnapshotRefName("release-g2-g1", "task-gwave", original.treeSha));
    assert.equal(await refSha(repoPath, adopted.candidateRef), original.commitSha);
    // The root wave's snapshot ref is untouched by the continuation.
    assert.equal(await refSha(repoPath, original.candidateRef), original.commitSha);

    // A new tree in the continuation pins its own snapshot under the -g1
    // namespace; its trailer (Wave-Id: release-g2-g1) proves the lineage.
    await writeMarker(worker.worktreeRoot, "g-more");
    const continued = await normalizeCandidate(continuation, worker.worktreeRoot, "task-gwave", "Continued work", {
      commitSha: adopted.commitSha,
      treeSha: adopted.treeSha,
      ref: adopted.candidateRef,
    });
    assert.notEqual(continued.treeSha, original.treeSha);
    assert.equal(continued.candidateRef, candidateSnapshotRefName("release-g2-g1", "task-gwave", continued.treeSha));
    assert.equal(await refSha(repoPath, continued.candidateRef), continued.commitSha);

    // Review aliases for the continuation wave verify against the explicit lineage.
    const alias = await pinReviewCycleCandidate(continuation, "task-gwave", 1, {
      commitSha: continued.commitSha,
      treeSha: continued.treeSha,
    });
    assert.equal(alias, reviewCycleAliasRefName("release-g2-g1", "task-gwave", 1));
    assert.equal(await refSha(repoPath, alias), continued.commitSha);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── independently supplied -gN wave ids are separate chains ─────────────────

test("immutable refs — independent -gN wave ids never share a candidate identity", async () => {
  const artifactDir = await mkTmp("pi-imm-conflate-");
  try {
    const { capture } = await setupCapture(artifactDir, "release-g2");
    const worker = await createWorkerWorktree(capture, "task-conflate");
    const repoPath = capture.repositoryPath;

    await writeMarker(worker.worktreeRoot, "conflate-work");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-conflate", "Conflate work");

    // Forge a commit for the SAME tree and task whose Wave-Id trailer names
    // an independent wave (release-g1). It must not be adoptable as a prior
    // candidate of release-g2: independently supplied ids are separate
    // chains even though one textually ends in the other's generation suffix.
    const forgedSha = await gitCommitTree(
      repoPath,
      candidate.treeSha,
      capture.baseCommit,
      "Forged work\n\nWave-Id: release-g1\nTask-Id: task-conflate",
    );
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-conflate", "Conflate again", {
        commitSha: forgedSha,
        treeSha: candidate.treeSha,
      }),
      /does not prove the wave identity/,
    );

    // The legitimate candidate remains pinned and adoptable.
    const adopted = await normalizeCandidate(capture, worker.worktreeRoot, "task-conflate", "Conflate work", {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      ref: candidate.candidateRef,
    });
    assert.equal(adopted.commitSha, candidate.commitSha);
    assert.equal(await refSha(repoPath, adopted.candidateRef), candidate.commitSha);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── inconsistent continuation lineage fails closed ──────────────────────────

test("immutable refs — a capture whose wave id contradicts its recorded lineage fails closed", async () => {
  const artifactDir = await mkTmp("pi-imm-lineage-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-lineage");

    await writeMarker(worker.worktreeRoot, "lineage-work");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-lineage", "Lineage work");

    // A continuation capture whose wave id does not match its recorded root
    // wave and generation must fail before touching the worktree.
    const tampered = {
      ...capture,
      waveId: "other-wave-g1",
      rootWaveId: capture.waveId,
      continuationGeneration: 1,
    };
    await assert.rejects(
      normalizeCandidate(tampered, worker.worktreeRoot, "task-lineage", "Lineage work", {
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
        ref: candidate.candidateRef,
      }),
      /Invalid continuation lineage/,
    );

    // The worktree is untouched and the original candidate still verifies.
    const status = await git(["status", "--porcelain", "--untracked-files=all"], worker.worktreeRoot);
    assert.equal(status, "");
    const head = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    assert.equal(head, candidate.commitSha);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── recovery checkpoint identity verification ───────────────────────────────

async function changedPathsBetween(repoPath: string, baseCommit: string, commitSha: string): Promise<string[]> {
  return (await gitInRepo(["diff", "--name-only", "-z", baseCommit, commitSha], repoPath))
    .split("\0")
    .filter(Boolean);
}

test("recovery checkpoint — a valid checkpoint from another task is rejected", async () => {
  const artifactDir = await mkTmp("pi-imm-xtask-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const workerA = await createWorkerWorktree(capture, "task-a");
    const workerB = await createWorkerWorktree(capture, "task-b");
    const repoPath = capture.repositoryPath;

    await writeMarker(workerA.worktreeRoot, "a-work");
    const a = await normalizeCandidate(capture, workerA.worktreeRoot, "task-a", "Task A work");
    await writeMarker(workerB.worktreeRoot, "b-work");
    const b = await normalizeCandidate(capture, workerB.worktreeRoot, "task-b", "Task B work");

    const recordA = createOperationRecord({
      waveId: capture.waveId,
      taskId: "task-a",
      title: "Task A",
      worktreeRoot: workerA.worktreeRoot,
      effectiveCwd: workerA.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", "task-a"),
      retryBudget: 1,
    });

    // Task A's own checkpoint verifies.
    recordA.checkpoint = {
      checkpointId: "op-a:1",
      commitSha: a.commitSha,
      treeSha: a.treeSha,
      ref: a.candidateRef,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, a.commitSha),
    };
    await verifyRecoveryCheckpoint(capture.waveRoot, recordA);

    // Task A's record referencing task B's fully valid checkpoint must fail
    // before any worktree restoration: the ref does not belong to task-a.
    recordA.checkpoint = {
      ...recordA.checkpoint,
      commitSha: b.commitSha,
      treeSha: b.treeSha,
      ref: b.candidateRef,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, b.commitSha),
    };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /does not belong to task "task-a"/,
    );

    // Reconciliation must not replace a foreign checkpoint with a fresh
    // task-a candidate merely because task A's retained worktree has a
    // different tree from task B's checkpoint.
    const substitutedDuringReconcile = {
      ...recordA,
      checkpoint: { ...recordA.checkpoint },
    };
    await assert.rejects(
      reconcileAbandonedOperation(substitutedDuringReconcile, capture.waveRoot),
      /does not belong to task "task-a"/,
    );

    // A commit that proves task B's identity but is pinned under a ref in
    // task A's snapshot namespace must fail the trailer proof: the ref form
    // alone cannot establish task identity.
    const forgedInA = await gitCommitTree(
      repoPath,
      b.treeSha,
      capture.baseCommit,
      `Task B work\n\nWave-Id: ${capture.waveId}\nTask-Id: task-b`,
    );
    const forgedRef = candidateSnapshotRefName(capture.waveId, "task-a", b.treeSha);
    await gitInRepo(["update-ref", forgedRef, forgedInA], repoPath);
    recordA.checkpoint = {
      ...recordA.checkpoint,
      commitSha: forgedInA,
      ref: forgedRef,
    };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /does not prove the task identity/,
    );

    await removeWorktree(workerA.worktreeRoot, repoPath);
    await removeWorktree(workerB.worktreeRoot, repoPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("recovery checkpoint — a checkpoint from another wave chain is rejected", async () => {
  const artifactDir = await mkTmp("pi-imm-xwave-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const workerA = await createWorkerWorktree(capture, "task-a");
    const repoPath = capture.repositoryPath;

    await writeMarker(workerA.worktreeRoot, "a-work");
    const a = await normalizeCandidate(capture, workerA.worktreeRoot, "task-a", "Task A work");

    const recordA = createOperationRecord({
      waveId: capture.waveId,
      taskId: "task-a",
      title: "Task A",
      worktreeRoot: workerA.worktreeRoot,
      effectiveCwd: workerA.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", "task-a"),
      retryBudget: 1,
    });

    // A ref in another wave's namespace is rejected by the ref-path form
    // even though it pins a commit that shares this wave's base.
    const forgedForeign = await gitCommitTree(
      repoPath,
      a.treeSha,
      capture.baseCommit,
      `Task A work\n\nWave-Id: foreign-wave\nTask-Id: task-a`,
    );
    const foreignRef = candidateSnapshotRefName("foreign-wave", "task-a", a.treeSha);
    await gitInRepo(["update-ref", foreignRef, forgedForeign], repoPath);
    recordA.checkpoint = {
      checkpointId: "op-a:2",
      commitSha: forgedForeign,
      treeSha: a.treeSha,
      ref: foreignRef,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, a.commitSha),
    };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /outside the wave chain rooted at/,
    );

    // A commit whose Wave-Id trailer names another wave is rejected even
    // when pinned under this wave's own snapshot namespace (simulated
    // substitution of the ref target).
    await writeMarker(workerA.worktreeRoot, "a-more");
    const more = await normalizeCandidate(capture, workerA.worktreeRoot, "task-a", "Task A more");
    const forgedTrailer = await gitCommitTree(
      repoPath,
      more.treeSha,
      capture.baseCommit,
      `Task A more\n\nWave-Id: foreign-wave\nTask-Id: task-a`,
    );
    const ownRef = candidateSnapshotRefName(capture.waveId, "task-a", more.treeSha);
    await gitInRepo(["update-ref", ownRef, forgedTrailer], repoPath);
    recordA.checkpoint = {
      ...recordA.checkpoint,
      commitSha: forgedTrailer,
      treeSha: more.treeSha,
      ref: ownRef,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, more.commitSha),
    };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /does not prove the wave identity/,
    );

    await removeWorktree(workerA.worktreeRoot, repoPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("recovery checkpoint — refs outside the allowed candidate/recovery forms are rejected", async () => {
  const artifactDir = await mkTmp("pi-imm-refform-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const workerA = await createWorkerWorktree(capture, "task-a");
    const repoPath = capture.repositoryPath;

    await writeMarker(workerA.worktreeRoot, "a-work");
    const a = await normalizeCandidate(capture, workerA.worktreeRoot, "task-a", "Task A work");

    const recordA = createOperationRecord({
      waveId: capture.waveId,
      taskId: "task-a",
      title: "Task A",
      worktreeRoot: workerA.worktreeRoot,
      effectiveCwd: workerA.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", "task-a"),
      retryBudget: 1,
    });
    const baseCheckpoint = {
      commitSha: a.commitSha,
      treeSha: a.treeSha,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, a.commitSha),
    };

    // A review-cycle alias is not a checkpoint form.
    const aliasRef = reviewCycleAliasRefName(capture.waveId, "task-a", 1);
    await gitInRepo(["update-ref", aliasRef, a.commitSha], repoPath);
    recordA.checkpoint = { ...baseCheckpoint, checkpointId: "op-a:1", ref: aliasRef };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /not an allowed candidate or recovery form/,
    );

    // A legacy candidates ref for another task is rejected.
    const legacyOther = candidateRefName(capture.waveId, "task-b");
    await gitInRepo(["update-ref", legacyOther, a.commitSha], repoPath);
    recordA.checkpoint = { ...baseCheckpoint, checkpointId: "op-a:2", ref: legacyOther };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /does not belong to task/,
    );

    // A legacy recovery ref for this task remains an accepted read-only
    // compatibility input.
    const legacyOwn = recoveryRefName(capture.waveId, "task-a");
    await gitInRepo(["update-ref", legacyOwn, a.commitSha], repoPath);
    recordA.checkpoint = { ...baseCheckpoint, checkpointId: "op-a:3", ref: legacyOwn };
    await verifyRecoveryCheckpoint(capture.waveRoot, recordA);

    // Legacy compatibility applies only to the exact candidates/<task> and
    // recovery/<task> forms; descendant refs are not compatibility inputs.
    const malformedLegacy = `${candidateRefName(capture.waveId, "task-a")}/extra`;
    await gitInRepo(["update-ref", malformedLegacy, a.commitSha], repoPath);
    recordA.checkpoint = { ...baseCheckpoint, checkpointId: "op-a:malformed", ref: malformedLegacy };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /not an allowed candidate or recovery form/,
    );

    // A snapshot ref whose tree segment does not match the recorded tree
    // fails closed.
    const mismatchRef = candidateSnapshotRefName(capture.waveId, "task-a", "f".repeat(40));
    await gitInRepo(["update-ref", mismatchRef, a.commitSha], repoPath);
    recordA.checkpoint = { ...baseCheckpoint, checkpointId: "op-a:4", ref: mismatchRef };
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, recordA),
      /records tree .* but the checkpoint records/,
    );

    await removeWorktree(workerA.worktreeRoot, repoPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("recovery checkpoint — checkpoints from earlier generations of the same chain verify", async () => {
  const artifactDir = await mkTmp("pi-imm-gen-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const workerA = await createWorkerWorktree(capture, "task-a");
    const repoPath = capture.repositoryPath;

    await writeMarker(workerA.worktreeRoot, "gen-work");
    const original = await normalizeCandidate(capture, workerA.worktreeRoot, "task-a", "Original work");

    // Continuation generation 1 pins its checkpoint under <wave>-g1.
    const continuationCapture = {
      ...capture,
      waveId: `${capture.waveId}-g1`,
      rootWaveId: capture.waveId,
      continuationGeneration: 1,
    };
    await writeMarker(workerA.worktreeRoot, "gen-more");
    const continued = await normalizeCandidate(continuationCapture, workerA.worktreeRoot, "task-a", "Continued work", {
      commitSha: original.commitSha,
      treeSha: original.treeSha,
      ref: original.candidateRef,
    });
    assert.equal(continued.candidateRef, candidateSnapshotRefName(`${capture.waveId}-g1`, "task-a", continued.treeSha));

    const recordGen0 = createOperationRecord({
      waveId: capture.waveId,
      taskId: "task-a",
      title: "Task A",
      worktreeRoot: workerA.worktreeRoot,
      effectiveCwd: workerA.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", "task-a"),
      retryBudget: 1,
    });
    recordGen0.checkpoint = {
      checkpointId: "op-a:0",
      commitSha: original.commitSha,
      treeSha: original.treeSha,
      ref: original.candidateRef,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, original.commitSha),
    };
    // The original-wave checkpoint verifies at generation 0.
    await verifyRecoveryCheckpoint(capture.waveRoot, recordGen0);

    const recordGen1 = createOperationRecord({
      waveId: capture.waveId,
      taskId: "task-a",
      title: "Task A",
      worktreeRoot: workerA.worktreeRoot,
      effectiveCwd: workerA.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", "task-a"),
      retryBudget: 1,
    });
    recordGen1.generation = 1;
    recordGen1.checkpoint = {
      checkpointId: "op-a:1",
      commitSha: continued.commitSha,
      treeSha: continued.treeSha,
      ref: continued.candidateRef,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, continued.commitSha),
    };
    // The -g1 checkpoint verifies once the record has reached generation 1.
    await verifyRecoveryCheckpoint(capture.waveRoot, recordGen1);

    // The same checkpoint must not verify for a record still at generation
    // 0: a future generation of the chain is not part of its lineage yet.
    const premature = { ...recordGen1 };
    premature.generation = 0;
    await assert.rejects(
      verifyRecoveryCheckpoint(capture.waveRoot, premature),
      /outside the wave chain rooted at/,
    );

    await removeWorktree(workerA.worktreeRoot, repoPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── abandoned-writer reconciliation across continuation generations ────────

test("reconciliation — an abandoned gen-1 checkpoint with an unchanged tree is adopted, not rejected", async () => {
  const artifactDir = await mkTmp("pi-imm-recgen-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const workerA = await createWorkerWorktree(capture, "task-a");
    const repoPath = capture.repositoryPath;
    const artifactPath = join(capture.waveRoot, "artifacts", "task-a");
    await mkdir(artifactPath, { recursive: true });

    await writeMarker(workerA.worktreeRoot, "gen-work");
    const original = await normalizeCandidate(capture, workerA.worktreeRoot, "task-a", "Original work");

    // Continuation generation 1 produces a checkpoint under <wave>-g1.
    const continuationCapture = {
      ...capture,
      waveId: `${capture.waveId}-g1`,
      rootWaveId: capture.waveId,
      continuationGeneration: 1,
    };
    await writeMarker(workerA.worktreeRoot, "gen-more");
    const continued = await normalizeCandidate(continuationCapture, workerA.worktreeRoot, "task-a", "Continued work", {
      commitSha: original.commitSha,
      treeSha: original.treeSha,
      ref: original.candidateRef,
    });

    // The executor of continuation 1 ended without releasing the operation,
    // leaving its gen-1 checkpoint and an unchanged worktree.
    const record = createOperationRecord({
      waveId: capture.waveId,
      taskId: "task-a",
      title: "Task A",
      worktreeRoot: workerA.worktreeRoot,
      effectiveCwd: workerA.effectiveCwd,
      artifactDir: artifactPath,
      retryBudget: 1,
    });
    record.generation = 1;
    record.state = "retrying";
    record.checkpoint = {
      checkpointId: "op-a:g1",
      commitSha: continued.commitSha,
      treeSha: continued.treeSha,
      ref: continued.candidateRef,
      differsFromBase: true,
      createdAt: new Date().toISOString(),
      verified: true,
      changedPaths: await changedPathsBetween(repoPath, capture.baseCommit, continued.commitSha),
    };

    // Reconciliation must adopt the durable gen-1 checkpoint verbatim
    // instead of failing its wave identity against the original capture.
    const reconciled = await reconcileAbandonedOperation(record, capture.waveRoot);
    assert.equal(reconciled.state, "paused_recoverable");
    assert.equal(reconciled.checkpoint?.commitSha, continued.commitSha, "unchanged tree adopts the durable gen-1 commit");
    assert.equal(reconciled.checkpoint?.ref, continued.candidateRef, "the checkpoint's actual ref is carried verbatim");

    // The reconciled checkpoint verifies under the same chain and generation.
    await verifyRecoveryCheckpoint(capture.waveRoot, reconciled);

    // A later change in the abandoned worktree pins a fresh candidate that
    // still proves the gen-1 wave identity of this chain.
    await writeMarker(workerA.worktreeRoot, "gen-late");
    const changed = await reconcileAbandonedOperation(reconciled, capture.waveRoot);
    assert.notEqual(changed.checkpoint?.commitSha, continued.commitSha);
    assert.equal(
      changed.checkpoint?.ref,
      candidateSnapshotRefName(`${capture.waveId}-g1`, "task-a", changed.checkpoint!.treeSha),
    );
    await verifyRecoveryCheckpoint(capture.waveRoot, changed);

    await removeWorktree(workerA.worktreeRoot, repoPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});