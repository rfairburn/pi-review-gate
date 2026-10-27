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
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig, type ExecutionRetryPolicy } from "../src/config";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { setDurableWriteFaultInjectionForTesting } from "../src/execution/durable-write";
import { runWaveWorkerLifecycle } from "../src/execution/wave-worker-lifecycle";
import { terminateProcessTree } from "../src/adapters/process";
import { runExecutorWithRecovery } from "../src/execution/executor-recovery";
import {
  createOperationRecord,
  operationOwnershipStatus,
  operationRecordPath,
  readOperationRecord,
  writeOperationRecord,
  type OperationRecord,
} from "../src/execution/operation-record";
import { captureWaveBase, type WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import type { ExecutorAdapter, ExecutorLiveControl, ExecutorRequest, ExecutorTurn } from "../src/execution/types";
import { ClaudeExecutorAdapter } from "../src/execution/adapters/claude-cli";
import { denyProcessGroupSignals, mockRootPid, readMockEvents, writeMockClaudeCli } from "./helpers/claude-mock-cli";

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

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function within<T>(promise: Promise<T>, message: string, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

test("recovery — zero-base retry skips jitter draws and retains retry numbering", async () => {
  const scenario = await startRecoveryScenario("task-zero-base-retry");
  const { capture, worktree, operation, artifactDir } = scenario;
  const turns: number[] = [];
  let randomDraws = 0;
  const originalRandom = Math.random;
  Math.random = () => {
    randomDraws += 1;
    return 0.5;
  };
  try {
    const result = await runExecutorWithRecovery({
      adapter: {
        kind: "fake",
        model: "fake-model",
        run: async (request) => {
          turns.push(request.turn);
          if (turns.length === 1) return failingTurn(artifactDir, "zero-base-session");
          return {
            text: "recovered",
            session: { adapter: "fake", id: "zero-base-session" },
            stdoutPath: join(artifactDir, "stdout.log"),
            stderrPath: join(artifactDir, "stderr.log"),
            code: 0,
            timedOut: false,
            aborted: false,
          };
        },
      },
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
      },
      prompt: "Do bounded work.",
      startingTurn: 7,
      capture,
      worktree,
      taskId: "task-zero-base-retry",
      title: "Zero-base retry task",
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: true,
        maxSameIncidentRepeats: 1,
      },
      operation,
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(turns, [7, 8], "the first generic retry advances the executor turn once");
    assert.equal(randomDraws, 0, "recovery's base-zero guard runs before the shared computation");
    assert.equal(operation.attempts[0]?.outcome, "retry");
    assert.equal(operation.attempts[1]?.outcome, "completed");
  } finally {
    Math.random = originalRandom;
    await scenario.cleanup();
  }
});

// #533 F3: when a retry's recorded native session cannot be reopened, the
// fresh-session fallback delivers `handoffPrompt` instead of `prompt`. That
// handoff must therefore carry BOTH the caller's exact full task and this
// retry's current recovery instructions, incident, and checkpoint locator —
// exactly what the resumed prompt carries — rather than the constant caller
// handoff that would silently drop them.
const RECOVERY_HANDOFF_TASK = [
  "FULL TASK HANDOFF",
  "Task: finish the bounded recovery slice.",
  "Acceptance: a fresh session still knows the whole task.",
  "",
  "Current continuation instructions:",
  "RECOVERY-HANDOFF-CONTINUATION: address the reviewer finding.",
].join("\n");

const RECOVERY_HANDOFF_PROMPT = "RECOVERY-HANDOFF-CONTINUATION: address the reviewer finding.";

function expectedRecoveryPrompt(base: string, checkpointSha: string): string {
  return [
    "The previous executor attempt was interrupted by an infrastructure or provider failure.",
    "Continue the same task from the preserved workspace state. Do not discard or duplicate completed changes.",
    "Previous incident: Executor exited with status 1.",
    `Recovery checkpoint: ${checkpointSha}`,
    "Finish the requested implementation and verification, then provide the normal final summary.",
    "",
    "Original bounded task (authoritative if this adapter could not restore conversational context):",
    base,
  ].join("\n");
}

test("recovery — a retry keeps the current incident and checkpoint in the fresh-session handoff and leaves the resumed prompt unchanged", async () => {
  const scenario = await startRecoveryScenario("task-retry-handoff");
  const { capture, worktree, operation, artifactDir } = scenario;
  const observed: ExecutorRequest[] = [];
  try {
    const result = await runExecutorWithRecovery({
      adapter: {
        kind: "fake",
        model: "fake-model",
        run: async (request) => {
          observed.push(request);
          if (observed.length === 1) return failingTurn(artifactDir, "retry-handoff-session");
          return { ...failingTurn(artifactDir, "retry-handoff-session"), code: 0, text: "recovered" };
        },
      },
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
        // The caller's continuation-only prompt above assumes the prior history
        // survived; this is the complete task a replacement session needs.
        handoffPrompt: RECOVERY_HANDOFF_TASK,
      },
      prompt: RECOVERY_HANDOFF_PROMPT,
      startingTurn: 1,
      capture,
      worktree,
      taskId: "task-retry-handoff",
      title: "Retry handoff task",
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
        maxSameIncidentRepeats: 1,
      },
      operation,
    });

    assert.equal(result.status, "completed");
    const checkpointSha = result.checkpoint?.commitSha;
    assert.ok(checkpointSha, "the retry carries a verified checkpoint locator");
    assert.equal(observed.length, 2);
    const [first, retry] = observed;

    // The first attempt's inputs are untouched.
    assert.equal(first!.prompt, RECOVERY_HANDOFF_PROMPT);
    assert.equal(first!.handoffPrompt, RECOVERY_HANDOFF_TASK);

    // The resumed retry prompt is exactly the pre-existing construction: it is
    // composed from the caller's prompt only, with no added task text.
    assert.equal(retry!.prompt, expectedRecoveryPrompt(RECOVERY_HANDOFF_PROMPT, checkpointSha!));
    assert.ok(!retry!.prompt.includes("FULL TASK HANDOFF"));

    // The fresh-session fallback receives the SAME current recovery text plus the
    // caller's exact full task, so nothing the resumed session was told is lost.
    assert.equal(retry!.handoffPrompt, expectedRecoveryPrompt(RECOVERY_HANDOFF_TASK, checkpointSha!));
    assert.ok(retry!.handoffPrompt!.includes("FULL TASK HANDOFF"));
    assert.ok(retry!.handoffPrompt!.includes("Acceptance: a fresh session still knows the whole task."));
    assert.ok(retry!.handoffPrompt!.includes("RECOVERY-HANDOFF-CONTINUATION: address the reviewer finding."));
    assert.ok(retry!.handoffPrompt!.includes(`Recovery checkpoint: ${checkpointSha}`));
    assert.ok(retry!.handoffPrompt!.includes("Previous incident: Executor exited with status 1."));
    assert.notEqual(retry!.handoffPrompt, retry!.prompt,
      "the adapter can still select the full-task fallback for an unusable session");

    // The retry still resumes the retained session as identity only: no transcript
    // path, prior response text, or workspace is copied onto the request.
    assert.deepEqual(Object.keys(retry!.session ?? {}).sort(), ["adapter", "id"]);
    assert.equal(retry!.session?.id, "retry-handoff-session");
    assert.ok(!retry!.handoffPrompt!.includes("recovered"), "no prior transcript or response text is replayed");
  } finally {
    await scenario.cleanup();
  }
});

// #533 review: an initial dispatch supplies the SAME text as both its prompt and
// its full-task handoff. Equal original inputs must retain recovery text in the
// fresh-session handoff. The emulated adapter below applies the Pi adapter's rule
// (an explicitly supplied handoff is delivered to the replacement session, and
// only a missing handoff returns the refused turn), so this test fails if the
// retry's current incident, checkpoint locator, or full task is dropped.
test("recovery — a retry whose original prompt already is the full handoff keeps the current incident and checkpoint through the fresh-session fallback", async () => {
  const scenario = await startRecoveryScenario("task-retry-equal-handoff");
  const { capture, worktree, operation, artifactDir } = scenario;
  const fullTaskHandoff = [
    "FULL TASK HANDOFF",
    "Task: finish the bounded recovery slice.",
    "Acceptance: a fresh session still knows the whole task.",
  ].join("\n");
  const observed: ExecutorRequest[] = [];
  const delivered: string[] = [];
  const refused: string[] = [];
  try {
    const result = await runExecutorWithRecovery({
      adapter: {
        kind: "fake",
        model: "fake-model",
        run: async (request) => {
          observed.push(request);
          if (observed.length === 1) return failingTurn(artifactDir, "equal-handoff-session");
          // Identity refusal prevents delivery to the resumed session; an
          // explicitly supplied handoff goes to the replacement session.
          refused.push("resumed session identity was refused");
          if (!request.handoffPrompt) {
            return { ...failingTurn(artifactDir, "equal-handoff-session"), failure: { category: "protocol", message: "resumed session identity was refused" } };
          }
          delivered.push(request.handoffPrompt);
          return { ...failingTurn(artifactDir, "equal-handoff-session"), code: 0, text: "recovered from the full task handoff" };
        },
      },
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
        // The initial-dispatch shape: prompt and handoff are the same text.
        handoffPrompt: fullTaskHandoff,
      },
      prompt: fullTaskHandoff,
      startingTurn: 1,
      capture,
      worktree,
      taskId: "task-retry-equal-handoff",
      title: "Equal handoff retry task",
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
        maxSameIncidentRepeats: 1,
      },
      operation,
    });

    assert.equal(result.status, "completed", "the retry must still recover through the full-task fallback");
    const checkpointSha = result.checkpoint?.commitSha;
    assert.ok(checkpointSha);
    assert.equal(observed.length, 2);
    const [first, retry] = observed;
    assert.equal(first!.prompt, fullTaskHandoff);
    assert.equal(first!.handoffPrompt, fullTaskHandoff);
    // The resumed retry prompt is the unchanged recovery construction and already
    // carries the whole task, this incident, and the checkpoint locator.
    assert.equal(retry!.prompt, expectedRecoveryPrompt(fullTaskHandoff, checkpointSha!));
    // The caller's handoff is re-composed with the current recovery text, so an
    // equal-text fallback still carries the whole task, this incident, and the
    // checkpoint locator.
    const expectedHandoff = expectedRecoveryPrompt(fullTaskHandoff, checkpointSha!);
    assert.equal(retry!.handoffPrompt, expectedHandoff);
    assert.equal(retry!.handoffPrompt, retry!.prompt);
    assert.deepEqual(refused, ["resumed session identity was refused"], "the refusal was observed exactly once");
    assert.deepEqual(delivered, [expectedHandoff], "the fresh session receives the full task, current incident, and checkpoint");
    assert.ok(delivered[0]!.includes("Previous incident: Executor exited with status 1."));
    assert.ok(delivered[0]!.includes(`Recovery checkpoint: ${checkpointSha}`));
    assert.ok(delivered[0]!.includes("FULL TASK HANDOFF"));
    assert.equal(retry!.session?.id, "equal-handoff-session");
  } finally {
    await scenario.cleanup();
  }
});

test("recovery refuses retry and checkpoint while prior-attempt lifecycle persistence is unconfirmed", async () => {
  const scenario = await startRecoveryScenario("task-late-child-exit-fence");
  const { capture, worktree, operation, artifactDir } = scenario;
  const controller = new AbortController();
  let releaseFirstStart!: () => void;
  let announceFirstStart!: () => void;
  let announceLateFirstExit!: () => void;
  const firstStartEntered = new Promise<void>((resolvePromise) => { announceFirstStart = resolvePromise; });
  const lateFirstExitPublished = new Promise<void>((resolvePromise) => { announceLateFirstExit = resolvePromise; });
  const firstStartGate = new Promise<void>((resolvePromise) => { releaseFirstStart = resolvePromise; });
  const children: ChildProcess[] = [];
  const childCloses: Promise<void>[] = [];
  let firstPid: number | undefined;
  let firstLifecycleId: string | undefined;
  let adapterCalls = 0;
  let running: ReturnType<typeof runExecutorWithRecovery> | undefined;

  const adapter: ExecutorAdapter = {
    kind: "fake",
    model: "fake-model",
    run: async (request: ExecutorRequest) => {
      adapterCalls += 1;
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(1),80)"], {
        cwd: worktree.effectiveCwd,
        detached: process.platform !== "win32",
        stdio: "ignore",
      });
      children.push(child);
      const closePromise = new Promise<void>((resolve) => child.once("close", () => resolve()));
      childCloses.push(closePromise);
      if (child.pid === undefined) throw new Error("recovery lifecycle fixture failed to spawn its child");
      const processIdentity = {
        pid: child.pid,
        processGroupId: process.platform === "win32" ? undefined : child.pid,
      };
      const exitPromise = childExit(child);
      const startPromise = Promise.resolve(request.onProcessStart?.(processIdentity));
      void startPromise.catch(() => undefined);

      const exit = await exitPromise;
      await closePromise;
      await writeFile(join(worktree.worktreeRoot, "retry-draft.txt"), "unverified draft\n", "utf8");
      void startPromise.then(() => request.onProcessExit?.({ ...processIdentity, ...exit })).catch(() => undefined);
      return { ...failingTurn(artifactDir, "attempt-a"), timedOut: true };
    },
  };

  try {
    running = runExecutorWithRecovery({
      adapter,
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
        signal: controller.signal,
        onProcessStart: async ({ pid }) => {
          firstPid = pid;
          firstLifecycleId = operation.owner?.childLifecycleId;
          announceFirstStart();
          await firstStartGate;
        },
        onProcessExit: ({ pid }) => {
          if (pid === firstPid) announceLateFirstExit();
        },
      },
      prompt: "Keep process ownership until exit persistence is confirmed.",
      startingTurn: 1,
      capture,
      worktree,
      taskId: "task-late-child-exit-fence",
      title: "Late lifecycle ownership fencing",
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
        maxSameIncidentRepeats: 1,
      },
      operation,
    });
    void running.catch(() => undefined);

    await within(firstStartEntered, "attempt A did not publish its durable start identity");
    const result = await within(running, "unconfirmed lifecycle did not settle critical");
    assert.equal(result.status, "critical");
    assert.equal(adapterCalls, 1, "unverified child must never be retried");
    assert.equal(operation.state, "failed_critical");
    assert.equal(operation.checkpoint, undefined, "no checkpoint is safe without verified child settlement");
    assert.ok(firstPid && firstLifecycleId);
    assert.equal(operation.owner?.childPid, firstPid);
    assert.equal(operation.owner?.childLifecycleId, firstLifecycleId);
    assert.equal(operation.owner?.childExitedAt, undefined);
    assert.equal(operation.owner?.status, "active");
    const retained = await readOperationRecord(join(operation.artifactDir, "operation.json"));
    assert.equal(retained.owner?.childPid, firstPid);
    assert.equal(retained.owner?.childExitedAt, undefined);
    assert.equal(retained.owner?.status, "active");

    releaseFirstStart();
    await within(lateFirstExitPublished, "attempt A's retained exit callback did not complete");
    const durable = await readOperationRecord(join(operation.artifactDir, "operation.json"));
    assert.equal(durable.owner?.childPid, firstPid);
    assert.ok(durable.owner?.childExitedAt, "late exit persistence stays ordered and can still record real exit");
    assert.equal(durable.state, "failed_critical", "a late callback never invents a retry or checkpoint");
  } finally {
    releaseFirstStart();
    controller.abort();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await running?.catch(() => undefined);
    await within(Promise.all(childCloses), "finite recovery fixture children did not close");
    await scenario.cleanup();
  }
});

test("supplemental simulated identity reuse: a held old exit callback cannot clear a newer lifecycle", async () => {
  const scenario = await startRecoveryScenario("simulated-lifecycle-replacement");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
  try {
    const result = await runExecutorWithRecovery({
      adapter: { kind: "simulated-lifecycle-only", run: async request => {
        // No process is launched, adopted or signaled here. These are synthetic
        // callback identities, not evidence of native PID reuse or child exit.
        const identity = { pid: 987654321 };
        await request.onProcessStart?.(identity);
        const oldExit = request.onProcessExit?.({ ...identity, code: 0, signal: null });
        await within(callbackEntered, "old callback did not enter");
        await request.onProcessStart?.(identity);
        release();
        await oldExit;
        return failingTurn(scenario.artifactDir, "simulated-lifecycle");
      } },
      request: { cwd: scenario.worktree.effectiveCwd, artifactDir: scenario.artifactDir, onProcessExit: async () => { entered(); await gate; } },
      prompt: "Memory-only lifecycle identity fencing", startingTurn: 1,
      capture: scenario.capture, worktree: scenario.worktree, operation: scenario.operation,
      taskId: scenario.operation.taskId, title: "Simulated lifecycle identity fencing", retryPolicy: { ...LONG_BACKOFF, maxRetries: 0, maxSameIncidentRepeats: 0 },
    });
    assert.equal(result.status, "critical");
    assert.equal(scenario.operation.owner?.status, "active");
    assert.equal(scenario.operation.owner?.childExitedAt, undefined);
    assert.equal(scenario.operation.checkpoint, undefined);
  } finally {
    release();
    // Join this fixture's serialized publication before removing its files.
    await within(writeOperationRecord(scenario.operation), "simulated lifecycle fixture publication remains pending");
    await scenario.cleanup();
  }
});

// These fixtures drive the actual Codex adapter, owned finite Node child,
// operation write serialization, and (for wave-* cases) public worker lifecycle.
// The durable-write hook holds a real publication after rename; it does not
// replace writeOperationRecord or simulate process settlement. Scoped wrappers
// only observe spawn, callback completion, and the actual write promises so
// every held/queued publication can be joined before deleting our fixture.
for (const mode of ["held-exit-callback", "rejected-exit-callback", "start-write", "exit-write", "rejected-start-write", "wave-start-write", "wave-exit-write"] as const) {
  test(`Codex recovery bounded persistence: ${mode}`, { skip: process.platform === "win32" }, async t => {
    const scenario = await startRecoveryScenario(`codex-${mode}`);
    const { capture, worktree, artifactDir } = scenario;
    const operationPath = operationRecordPath(scenario.operation.artifactDir);
    const script = join(artifactDir, "finite-codex.cjs");
    const home = join(artifactDir, "home");
    const abort = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let announceHeld!: () => void;
    const held = new Promise<void>(resolve => { announceHeld = resolve; });
    let announceControl!: () => void;
    const ready = new Promise<void>(resolve => { announceControl = resolve; });
    let announceExitCallback!: () => void;
    const exitCallbackDone = new Promise<void>(resolve => { announceExitCallback = resolve; });
    let announceClose!: () => void;
    const closed = new Promise<void>(resolve => { announceClose = resolve; });
    let child: ChildProcess | undefined;
    const children: Array<{ proc: ChildProcess; exited: boolean; closed: Promise<void> }> = [];
    let exitAt = 0, closeAt = 0, attempts = 0, prompts = 0;
    let injected = false;
    let running: Promise<unknown> | undefined;
    let operation = scenario.operation;
    const writes = new Set<Promise<void>>();
    const publicationStates: string[] = [];
    const startWrite = mode.includes("start-write");
    const wave = mode.startsWith("wave-");
    const childProcessModule = require("node:child_process") as { spawn: (file: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess };
    const originalSpawn = childProcessModule.spawn;
    const operationModule = require("../src/execution/operation-record") as { writeOperationRecord: typeof writeOperationRecord };
    const originalWrite = operationModule.writeOperationRecord;
    const originalRun = CodexExecutorAdapter.prototype.run;
    try {
      await mkdir(home);
      await writeFile(script, [
        "const readline=require('node:readline');const out=v=>console.log(JSON.stringify(v));",
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),30));setTimeout(()=>process.exit(96),12000);",
        "readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(!c.method||!c.id)return;",
        "if(c.method==='initialize')out({id:c.id,result:{userAgent:'finite-recovery-fixture'}});",
        "else if(c.method==='thread/start')out({id:c.id,result:{thread:{id:'recovery-thread'}}});",
        "else if(c.method==='turn/start')out({id:c.id,result:{turn:{id:'recovery-turn'}}});",
        "else if(c.method==='turn/interrupt'){out({id:c.id,result:{}});out({method:'turn/completed',params:{threadId:'recovery-thread',turn:{id:'recovery-turn',status:'interrupted'}}});}});",
      ].join("\n"));
      childProcessModule.spawn = (file, args, options) => {
        if (!args?.includes(script)) return originalSpawn(file, args, options);
        const spawned = originalSpawn(file, args, { ...options, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH } });
        child ??= spawned;
        let announceChildClose!: () => void;
        const captured = { proc: spawned, exited: false, closed: new Promise<void>(resolve => { announceChildClose = resolve; }) };
        children.push(captured);
        spawned.once("exit", () => { captured.exited = true; if (child === spawned) exitAt = Date.now(); });
        spawned.once("close", () => {
          announceChildClose();
          if (child === spawned) { closeAt = Date.now(); announceClose(); }
        });
        return spawned;
      };
      operationModule.writeOperationRecord = record => {
        const write = originalWrite(record);
        if (operationRecordPath(record.artifactDir) === operationPath) {
          operation = record;
          writes.add(write);
          void write.then(() => writes.delete(write), () => writes.delete(write));
        }
        return write;
      };
      CodexExecutorAdapter.prototype.run = function(request) {
        attempts += 1;
        return originalRun.call(this, {
          ...request,
          onPromptDelivery: delivery => { prompts += 1; request.onPromptDelivery?.(delivery); },
          onProcessExit: async identity => {
            try { await request.onProcessExit?.(identity); }
            finally { announceExitCallback(); }
          },
        });
      };
      if (mode.includes("write")) setDurableWriteFaultInjectionForTesting(async (stage, path) => {
        if (path !== operationPath) return;
        if (stage === "after_rename") {
          const snapshot = await readOperationRecord(path);
          publicationStates.push(snapshot.state);
          const lifecycleWrite = startWrite
            ? snapshot.owner?.childPid === child?.pid && snapshot.owner?.childExitedAt === undefined
            : snapshot.owner?.childExitedAt !== undefined;
          if (!injected && child?.pid !== undefined && lifecycleWrite) {
            injected = true; announceHeld(); await gate;
            if (mode === "rejected-start-write") throw new Error("held lifecycle publication rejected after release");
          }
        }
      });
      const config = { id: "fixture", adapter: "codex-cli" as const, command: process.execPath, args: [script], timeoutMs: startWrite ? 300 : 10_000 };
      const began = Date.now();
      if (wave) {
        running = runWaveWorkerLifecycle({
          taskId: scenario.operation.taskId, task: { title: "Bounded Codex persistence", instructions: "Synthetic task", acceptanceCriteria: ["bounded stop"] },
          sourceRoot: capture.discovery.captureRoot, capture, worktree, artifactDir: scenario.operation.artifactDir,
          config: normalizeConfig({
            externalAgents: { fixture: { adapter: "codex-cli", command: process.execPath, execution: { args: [script], timeoutMs: config.timeoutMs } } },
            execution: { workerResources: { fixture: { selection: { source: "external", id: "fixture" }, maxConcurrent: 1 } }, routes: { execute: [{ resourceId: "fixture" }], research: [] }, retryPolicy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 } },
          }),
          signal: abort.signal, onLiveControl: control => { if (control) announceControl(); },
        });
      } else {
        running = runExecutorWithRecovery({
          adapter: new CodexExecutorAdapter(config),
          request: {
            cwd: worktree.effectiveCwd, artifactDir: scenario.operation.artifactDir, signal: abort.signal,
            onLiveControl: control => { if (control) announceControl(); },
            onProcessExit: async () => {
              if (mode === "held-exit-callback") { announceHeld(); await gate; }
              if (mode === "rejected-exit-callback") { announceHeld(); throw new Error("caller exit persistence rejected"); }
            },
          },
          prompt: "Synthetic task", startingTurn: 1, capture, worktree, taskId: scenario.operation.taskId, title: "Bounded Codex persistence",
          operation, retryPolicy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
        });
      }
      void running.catch(() => undefined);
      if (!startWrite) { await within(ready, "real Codex control was not exposed", 3_000); abort.abort(); }
      await within(held, "lifecycle persistence hold was not reached", 3_000);
      const result = await within(running, "bounded recovery rejoined unconfirmed persistence", 7_000) as { status: string; error?: string; checkpoint?: unknown };
      assert.equal(result.status, wave ? "executor_error" : "critical");
      assert.match(result.error ?? "", /persistence is unconfirmed/);
      assert.equal(attempts, 1, "unconfirmed callbacks must not cause a retry");
      assert.equal(result.checkpoint, undefined);
      assert.equal(operation.state, "failed_critical");
      assert.equal(operation.owner?.status, "active");
      assert.equal(operation.owner?.releasedAt, undefined);
      assert.equal(operation.checkpoint, undefined);
      assert.equal(prompts, startWrite ? 0 : 1);
      await within(closed, "actual fixture child close was not observed");
      assert.ok(exitAt > 0 && closeAt >= exitAt);
      assert.ok(Date.now() - began < 8_000, "no additional persistence deadline may be added by recovery/callers");
      if (mode !== "rejected-exit-callback") assert.ok(Date.now() - closeAt >= 4_900);
      const prior = await readOperationRecord(operationPath);
      assert.equal(prior.owner?.status, "active", "the previously durable lease must not be released while publication is held");
      if (wave) {
        const reported = JSON.parse(await readFile(join(scenario.operation.artifactDir, "result.json"), "utf8"));
        assert.ok(reported.incidents.some((incident: { stage: string }) => incident.stage === "executor_shutdown"));
        assert.match(reported.error, /persistence is unconfirmed/);
      }
      t.diagnostic(`actual child close ${closeAt-began}ms; bounded ${wave ? "public worker lifecycle" : "recovery"} result ${Date.now()-began}ms; ${mode === "rejected-exit-callback" ? "exit callback rejected; ownership retained" : "persistence hold unreleased"}`);
      // Deliberately release only AFTER the bounded result and then join all
      // actual callbacks/publications. Never remove a fixture with writes in flight.
      release();
      await within(exitCallbackDone, "late real exit callback did not finish");
      while (writes.size > 0) await within(Promise.allSettled([...writes]), "ordered publication did not settle after release");
      const durable = await readOperationRecord(operationPath);
      assert.equal(durable.state, "failed_critical", "late publication must never downgrade terminal state");
      assert.equal(durable.owner?.status, "active");
      assert.equal(durable.checkpoint, undefined);
      assert.equal(prompts, startWrite ? 0 : 1, "late persistence must never deliver a prompt");
      assert.equal(attempts, 1, "late persistence must never retry the task");
      const firstCritical = publicationStates.indexOf("failed_critical");
      assert.ok(publicationStates.length === 0 || firstCritical >= 0);
      if (firstCritical >= 0) assert.ok(publicationStates.slice(firstCritical).every(state => state === "failed_critical"), "no stale finalizer snapshot may downgrade late terminal publication");
    } finally {
      release(); abort.abort();
      try {
        for (const captured of children) if (!captured.exited) terminateProcessTree(captured.proc, "SIGKILL");
        await within(Promise.all(children.map(captured => captured.closed)), "finite Codex fixture did not close");
        await within(running?.catch(() => undefined) ?? Promise.resolve(), "recovery fixture did not settle after releasing persistence");
        for (const captured of children) if (!captured.exited) terminateProcessTree(captured.proc, "SIGKILL");
        await within(Promise.all(children.map(captured => captured.closed)), "late fixture invocation did not close");
        if (child?.pid !== undefined) await within(exitCallbackDone, "late fixture callback was not joined");
        while (writes.size > 0) await within(Promise.allSettled([...writes]), "owned fixture publications remain pending");
      } finally {
        setDurableWriteFaultInjectionForTesting(undefined);
        operationModule.writeOperationRecord = originalWrite;
        childProcessModule.spawn = originalSpawn;
        CodexExecutorAdapter.prototype.run = originalRun;
      }
      await scenario.cleanup();
    }
  });
}

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

test("recovery — an explicit Claude interrupt with unverified owned shutdown stays critical with ownership retained (#310)", { skip: process.platform === "win32" }, async () => {
  const scenario = await startRecoveryScenario("task-unverified-shutdown");
  const scratch = await mkTmp("pi-recov-claude-310-");
  const marker = join(scratch, "events.log");
  const blocked = new Set<number>();
  const restoreKill = denyProcessGroupSignals(blocked);
  let rootPid: number | undefined;
  const operationModule = require("../src/execution/operation-record") as { writeOperationRecord: typeof writeOperationRecord };
  const originalWrite = operationModule.writeOperationRecord;
  let terminalPublication: Promise<void> | undefined;
  operationModule.writeOperationRecord = record => {
    const publication = originalWrite(record);
    if (record === scenario.operation && record.state === "failed_critical") {
      terminalPublication = publication;
      void publication.catch(() => undefined);
    }
    return publication;
  };
  try {
    const { capture, worktree, operation, artifactDir } = scenario;
    const cli = await writeMockClaudeCli(scratch);
    // The installed Agent SDK drives an owned local mock CLI (no provider).
    const adapter = new ClaudeExecutorAdapter(
      { id: "claude", adapter: "claude-cli", command: cli, env: { CLAUDE_MOCK_MARKER: marker }, model: "sonnet" },
      { interruptSettleMs: 5_000, processCleanupGraceMs: 200 },
    );
    const abort = new AbortController();
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const recovery = runExecutorWithRecovery({
      adapter,
      request: {
        cwd: worktree.effectiveCwd,
        artifactDir,
        workspaceAccess: "workspace-write",
        signal: abort.signal,
        onLiveControl: (control) => { if (control) resolveControl(control); },
      },
      prompt: "Do bounded work.",
      startingTurn: 1,
      capture,
      worktree,
      taskId: "task-unverified-shutdown",
      title: "Recovery task",
      retryPolicy: LONG_BACKOFF,
      operation,
    });
    const control = await within(controlReady, "live control was never published");
    rootPid = mockRootPid(await readMockEvents(marker));
    assert.ok(rootPid !== undefined);
    // Group-wide termination and verification of the owned CLI are refused.
    blocked.add(rootPid);

    // Controller order: adapter interrupt, then runtime abort.
    const transport = control.interrupt();
    abort.abort(new Error("interrupt_as_failure"));
    const acknowledgement = await within(transport, "explicit interrupt did not settle");
    assert.equal(acknowledgement.status, "failed");
    assert.match(acknowledgement.message, /owned Claude process shutdown was not verified/);

    const result = await within(recovery, "recovery did not settle");
    assert.equal(result.status, "critical");
    assert.match(result.error ?? "", /shutdown of its owned process was not verified/);
    assert.match(result.error ?? "", /persistence is unconfirmed/);
    assert.equal(operation.checkpoint, undefined, "no cancellation checkpoint is taken over a possibly live writer");
    // Returning critical no longer claims this publication settled. Join the
    // actual observed source write for the following durability assertions.
    assert.ok(terminalPublication);
    await within(terminalPublication, "terminal shutdown record did not publish");
    const durable = await readOperationRecord(operationRecordPath(operation.artifactDir));
    assert.equal(durable.state, "failed_critical");
    assert.equal(durable.checkpoint, undefined);
    const incident = durable.incidents.at(-1)!;
    assert.equal(incident.stage, "executor_shutdown");
    assert.equal(incident.cause, "process_exit");
    assert.equal(incident.terminalCode, "recovery_state_corrupt_or_unverifiable");
    assert.match(incident.message, /Claude CLI shutdown after explicit interruption was not verified/);
    // Ownership stays with the possibly live writer: no exit was recorded and
    // the lease was not released.
    assert.equal(durable.owner?.status, "active");
    assert.equal(durable.owner?.childPid, rootPid);
    assert.equal(durable.owner?.childExitedAt, undefined);
    assert.equal(operationOwnershipStatus(durable).processAlive, true);
    // The termination diagnostic is durable in the executor artifacts.
    const processResult = JSON.parse(await readFile(join(artifactDir, "executor", "0001", "process-result.json"), "utf8")) as { terminationError?: string };
    assert.match(processResult.terminationError ?? "", /EPERM/);
  } finally {
    restoreKill();
    try { await within(terminalPublication?.catch(() => undefined) ?? Promise.resolve(), "owned terminal record remains pending"); }
    finally { operationModule.writeOperationRecord = originalWrite; }
    if (rootPid !== undefined) {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        // Already gone (ESRCH): nothing of ours remains.
      }
    }
    await rm(scratch, { recursive: true, force: true });
    await scenario.cleanup();
  }
});
