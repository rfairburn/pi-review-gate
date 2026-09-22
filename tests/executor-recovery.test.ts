/**
 * #165: abort during retry backoff must settle as a verified cancellation.
 *
 * These tests drive the real production recovery loop (`runExecutorWithRecovery`)
 * against a real wave capture and worker worktree, with an in-process adapter
 * standing in for the executor process. The abort timing is order-controlled:
 * the adapter (or the recovery hook) aborts exactly when the loop enters the
 * retry backoff, never via sleeps or lucky reruns.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExecutionRetryPolicy } from "../src/config";
import { runExecutorWithRecovery } from "../src/execution/executor-recovery";
import {
  createOperationRecord,
  writeOperationRecord,
  type OperationRecord,
} from "../src/execution/operation-record";
import { captureWaveBase, type WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import type { ExecutorAdapter, ExecutorRequest, ExecutorTurn } from "../src/execution/types";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
  return stdout.trim();
}

async function mkTmp(prefix: string): Promise<string> {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function setupCapture(artifactDir: string): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-recov-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "recovery-wave",
    artifactDir,
  });
  return { sourceDir, capture };
}

/** Backoff long enough that only an explicit abort can end it; no jitter. */
const LONG_BACKOFF: ExecutionRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 120_000,
  maxDelayMs: 120_000,
  jitter: false,
  maxSameIncidentRepeats: 2,
};

function failingTurn(artifactDir: string, session: string): ExecutorTurn {
  // Exit status 1 classifies as a retryable process_exit failure.
  return {
    text: "",
    session: { adapter: "fake", id: session },
    stdoutPath: join(artifactDir, "stdout.log"),
    stderrPath: join(artifactDir, "stderr.log"),
    code: 1,
    timedOut: false,
    aborted: false,
  };
}

interface Scenario {
  capture: WaveCaptureResult;
  worktree: Awaited<ReturnType<typeof createWorkerWorktree>>;
  operation: OperationRecord;
  artifactDir: string;
  cleanup: () => Promise<void>;
}

async function startRecoveryScenario(taskId: string): Promise<Scenario> {
  const artifactDir = await mkTmp(`pi-recov-${taskId}-`);
  const { sourceDir, capture } = await setupCapture(artifactDir);
  await mkdir(join(capture.waveRoot, "artifacts", taskId), { recursive: true });
  const worktree = await createWorkerWorktree(capture, taskId);
  const operation = createOperationRecord({
    waveId: capture.waveId,
    taskId,
    title: `Recovery ${taskId}`,
    worktreeRoot: worktree.worktreeRoot,
    effectiveCwd: worktree.effectiveCwd,
    artifactDir: join(capture.waveRoot, "artifacts", taskId),
    retryBudget: LONG_BACKOFF.maxRetries,
  });
  await writeOperationRecord(operation);
  return {
    capture,
    worktree,
    operation,
    artifactDir,
    cleanup: async () => {
      await removeWorktree(worktree.worktreeRoot, capture.repositoryPath).catch(() => undefined);
      await rm(artifactDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    },
  };
}

test("recovery — abort during retry backoff settles cancelled with the failure incident and verified work retained", async () => {
  const scenario = await startRecoveryScenario("task-backoff-abort");
  try {
    const { capture, worktree, operation, artifactDir } = scenario;
    const controller = new AbortController();
    let adapterCalls = 0;

    // Turn 1: the executor writes work, then fails (exit status 1). The loop
    // classifies the failure, records the incident, verifies a checkpoint,
    // and enters retry backoff. onRetry fires at that exact boundary, where
    // the test aborts — the abort lands inside the backoff, never during a
    // turn and never during checkpointing.
    const adapter: ExecutorAdapter = {
      kind: "fake",
      model: "fake-model",
      run: async () => {
        adapterCalls += 1;
        await writeFile(join(worktree.worktreeRoot, "draft.txt"), "recover me\n", "utf8");
        return failingTurn(artifactDir, "backoff-session");
      },
    };

    const result = await runExecutorWithRecovery({
      adapter,
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
        signal: controller.signal,
      },
      prompt: "Do bounded work.",
      startingTurn: 1,
      capture,
      worktree,
      taskId: "task-backoff-abort",
      title: "Recovery task",
      retryPolicy: LONG_BACKOFF,
      operation,
      onRetry: () => controller.abort(new Error("interrupt_as_failure")),
    });

    assert.equal(adapterCalls, 1, "the retry turn never ran");
    assert.equal(result.status, "cancelled", "abort during backoff settles cancelled, not failed or thrown");
    assert.equal(result.error, "Executor was cancelled during retry backoff.");
    assert.equal(result.lastTurnNumber, 1);

    // Durable record: cancelled, with the verified checkpoint of the work
    // written before the failure retained.
    assert.equal(operation.state, "cancelled");
    const checkpoint = operation.checkpoint!;
    assert.ok(checkpoint, "the verified work checkpoint is retained");
    assert.equal(checkpoint.verified, true);
    assert.equal(checkpoint.differsFromBase, true);
    assert.ok(checkpoint.changedPaths.includes("draft.txt"), "checkpoint captures the pre-failure work");
    assert.ok(checkpoint.ref.startsWith("refs/pi-review-gate/"), "checkpoint pins the immutable snapshot ref");

    // Prior failure incident retained verbatim; the cancellation itself adds
    // no duplicate canonical incident.
    assert.equal(operation.incidents.length, 1);
    assert.equal(operation.incidents[0]!.cause, "process_exit");
    assert.equal(operation.incidents[0]!.retryable, true);
    assert.equal(operation.incidents[0]!.resolvedAt, undefined);
    assert.deepEqual(
      result.incidents.map((incident) => incident.incidentId),
      operation.incidents.map((incident) => incident.incidentId),
      "the returned incidents are exactly the retained failure incidents",
    );

    // The interrupted attempt cycle settled as cancelled.
    const attempt = operation.attempts.at(-1)!;
    assert.equal(attempt.outcome, "cancelled");
    assert.ok(attempt.incidentId, "the attempt keeps its failure-incident linkage");
  } finally {
    await scenario.cleanup();
  }
});

test("recovery — abort-first control: an abort during the turn still settles cancelled with no failure incident", async () => {
  const scenario = await startRecoveryScenario("task-turn-abort");
  try {
    const { capture, worktree, operation, artifactDir } = scenario;
    const controller = new AbortController();

    // The adapter ends its turn only when the signal aborts — the post-turn
    // cancellation path. It also settles immediately if the signal is already
    // aborted, so the test always terminates even if I/O outruns the timer.
    const adapter: ExecutorAdapter = {
      kind: "fake",
      model: "fake-model",
      run: (request: ExecutorRequest) =>
        new Promise<ExecutorTurn>((resolve) => {
          const turn: ExecutorTurn = {
            ...failingTurn(artifactDir, "turn-session"),
            code: 0,
            text: "interrupted mid-turn",
            aborted: true,
          };
          if (request.signal?.aborted) {
            resolve(turn);
            return;
          }
          request.signal?.addEventListener("abort", () => resolve(turn), { once: true });
        }),
    };

    const turnPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort(new Error("interrupt_as_failure"));
    })();

    const result = await runExecutorWithRecovery({
      adapter,
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
        signal: controller.signal,
      },
      prompt: "Do bounded work.",
      startingTurn: 1,
      capture,
      worktree,
      taskId: "task-turn-abort",
      title: "Recovery task",
      retryPolicy: LONG_BACKOFF,
      operation,
    });
    await turnPromise;

    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "Executor was cancelled.");
    assert.equal(operation.state, "cancelled");
    assert.ok(operation.checkpoint, "cancellation checkpoint verified");
    assert.equal(operation.incidents.length, 0, "no failure incident exists on a clean abort");
    assert.equal(operation.attempts.at(-1)!.outcome, "cancelled");
  } finally {
    await scenario.cleanup();
  }
});

test("recovery — an unverifiable cancellation checkpoint during a backoff abort stays fail-closed critical", async () => {
  const scenario = await startRecoveryScenario("task-backoff-critical");
  try {
    const { capture, worktree, operation, artifactDir } = scenario;
    const controller = new AbortController();

    const adapter: ExecutorAdapter = {
      kind: "fake",
      model: "fake-model",
      run: async () => {
        await writeFile(join(worktree.worktreeRoot, "draft.txt"), "recover me\n", "utf8");
        return failingTurn(artifactDir, "critical-session");
      },
    };

    const result = await runExecutorWithRecovery({
      adapter,
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
        signal: controller.signal,
      },
      prompt: "Do bounded work.",
      startingTurn: 1,
      capture,
      worktree,
      taskId: "task-backoff-critical",
      title: "Recovery task",
      retryPolicy: LONG_BACKOFF,
      operation,
      // At the backoff boundary, make the worktree unverifiable (attached
      // HEAD) before aborting: the cancellation checkpoint must fail closed.
      onRetry: async () => {
        await git(["checkout", "-b", "rogue-attachment"], worktree.worktreeRoot);
        controller.abort(new Error("interrupt_as_failure"));
      },
    });

    assert.equal(result.status, "critical", "cancellation checkpoint unverifiability fails closed");
    assert.match(result.error!, /could not be verified/);
    assert.equal(operation.state, "failed_critical");

    // The prior failure incident is retained; the cancellation_checkpoint
    // incident is the only added representation.
    assert.equal(operation.incidents.length, 2);
    assert.equal(operation.incidents[0]!.cause, "process_exit");
    const critical = operation.incidents[1]!;
    assert.equal(critical.stage, "cancellation_checkpoint");
    assert.equal(critical.retryable, false);
    assert.equal(critical.terminalCode, "recovery_state_corrupt_or_unverifiable");

    // The verified work checkpoint from the failed turn is still durable.
    assert.ok(operation.checkpoint, "the earlier verified checkpoint survives");
    assert.equal(operation.checkpoint!.verified, true);
    assert.equal(operation.attempts.at(-1)!.outcome, "failed");
  } finally {
    await scenario.cleanup();
  }
});
