import type { ExecutionRetryPolicy } from "../config";
import { normalizeCandidate, pinRecoveryCandidate, type CandidateCommit } from "./wave-commits";
import type { WaveCaptureResult } from "./wave-repository";
import { ExecutorLifecycleError, type ExecutorAdapter, type ExecutorRequest, type ExecutorTurn } from "./types";
import type { WorkerWorktree } from "./wave-worktrees";
import {
  createIncident,
  writeOperationRecord,
  type ExecutionAttemptRecord,
  type ExecutionIncident,
  type OperationRecord,
  type RecoveryCheckpoint,
} from "./operation-record";

export interface RecoveredExecutorRun {
  status: "completed" | "failed" | "cancelled" | "critical";
  turn?: ExecutorTurn;
  error?: string;
  lastTurnNumber: number;
  checkpoint?: RecoveryCheckpoint;
  incidents: ExecutionIncident[];
}

export async function runExecutorWithRecovery(input: {
  adapter: ExecutorAdapter;
  request: Omit<ExecutorRequest, "turn" | "prompt" | "session">;
  prompt: string;
  startingTurn: number;
  session?: ExecutorRequest["session"];
  capture: WaveCaptureResult;
  worktree: WorkerWorktree;
  taskId: string;
  title: string;
  retryPolicy: ExecutionRetryPolicy;
  operation: OperationRecord;
  onRetry?: (message: string, turn: number) => void;
}): Promise<RecoveredExecutorRun> {
  const originalPrompt = input.prompt;
  let prompt = input.prompt;
  let session = input.session;
  let genericRetries = 0;
  let compactionRecoveries = 0;
  let totalAttempts = 0;
  let priorCheckpointCandidate: CandidateCommit | undefined;
  let checkpoint: RecoveryCheckpoint | undefined = input.operation.checkpoint;
  let recovery: ExecutorRequest["recovery"];
  const incidents: ExecutionIncident[] = [];
  const repeated = new Map<string, number>();

  for (;;) {
    totalAttempts += 1;
    const turnNumber = input.startingTurn + totalAttempts - 1;
    const attemptRecord: ExecutionAttemptRecord = {
      attempt: input.operation.attempts.length + 1,
      generation: input.operation.generation,
      turn: turnNumber,
      startedAt: new Date().toISOString(),
      sessionId: session?.id,
    };
    input.operation.attempts.push(attemptRecord);
    input.operation.state = "running";
    await writeOperationRecord(input.operation);

    let turn: ExecutorTurn | undefined;
    let thrown: unknown;
    try {
      turn = await input.adapter.run({
        ...input.request,
        prompt,
        turn: turnNumber,
        session,
        recovery,
      });
    } catch (error) {
      thrown = error;
    }

    if (input.request.signal?.aborted) {
      attemptRecord.endedAt = new Date().toISOString();
      attemptRecord.outcome = "cancelled";
      input.operation.state = "cancelled";
      await writeOperationRecord(input.operation);
      return {
        status: "cancelled",
        error: "Executor was cancelled.",
        lastTurnNumber: turnNumber,
        checkpoint,
        incidents,
      };
    }

    const failure = classifyFailure(turn, thrown);
    if (!failure) {
      attemptRecord.endedAt = new Date().toISOString();
      attemptRecord.outcome = "completed";
      attemptRecord.sessionId = turn?.session.id;
      input.operation.session = turn?.session;
      input.operation.state = "running";
      for (const incident of incidents) {
        if (!incident.resolvedAt) {
          incident.resolvedAt = new Date().toISOString();
          incident.resolution = "executor_recovered";
        }
      }
      await writeOperationRecord(input.operation);
      return {
        status: "completed",
        turn,
        lastTurnNumber: turnNumber,
        checkpoint,
        incidents,
      };
    }

    session = turn?.session ?? session;
    input.operation.session = session;
    const repeatKey = `${failure.cause}:${failure.message}`;
    const repeatCount = (repeated.get(repeatKey) ?? 0) + 1;
    repeated.set(repeatKey, repeatCount);
    const incident = createIncident({
      attempt: attemptRecord.attempt,
      generation: input.operation.generation,
      cause: failure.cause,
      stage: failure.stage,
      message: failure.message,
      retryable: true,
    });
    incidents.push(incident);
    input.operation.incidents.push(incident);
    attemptRecord.endedAt = new Date().toISOString();
    attemptRecord.outcome = "retry";
    attemptRecord.incidentId = incident.incidentId;

    try {
      const candidate = await normalizeCandidate(
        input.capture,
        input.worktree.worktreeRoot,
        input.taskId,
        input.title,
        priorCheckpointCandidate ? { commitSha: priorCheckpointCandidate.commitSha } : undefined,
      );
      priorCheckpointCandidate = candidate;
      checkpoint = {
        checkpointId: `${input.operation.operationId}:${attemptRecord.attempt}`,
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
        ref: await pinRecoveryCandidate(input.capture, input.taskId, candidate),
        differsFromBase: candidate.differsFromBase,
        createdAt: new Date().toISOString(),
        verified: true,
        changedPaths: await changedPaths(input.capture.repositoryPath, input.capture.baseCommit, candidate.commitSha),
      };
      input.operation.checkpoint = checkpoint;
    } catch (error) {
      incident.retryable = false;
      incident.terminalCode = "recovery_state_corrupt_or_unverifiable";
      const checkpointError = error instanceof Error ? error.message : String(error);
      input.operation.state = "failed_critical";
      attemptRecord.outcome = "failed";
      await writeOperationRecord(input.operation);
      return {
        status: "critical",
        error: `${failure.message}; the recovery checkpoint could not be created or verified. ${checkpointError}`,
        lastTurnNumber: turnNumber,
        checkpoint,
        incidents,
      };
    }

    const compactionIncident = failure.cause === "interruption" || failure.cause === "compaction_error";
    const repeatLimit = input.retryPolicy.maxSameIncidentRepeats;
    const withinRepeatLimit = repeatLimit > 0 && repeatCount <= repeatLimit;
    const canRetry = compactionIncident
      ? withinRepeatLimit && compactionRecoveries < repeatLimit
      : withinRepeatLimit && genericRetries < input.retryPolicy.maxRetries;

    if (!canRetry) {
      attemptRecord.outcome = "failed";
      input.operation.state = "paused_recoverable";
      await writeOperationRecord(input.operation);
      return {
        status: "failed",
        turn,
        error: failure.message,
        lastTurnNumber: turnNumber,
        checkpoint,
        incidents,
      };
    }

    if (compactionIncident) compactionRecoveries += 1;
    else genericRetries += 1;
    input.operation.state = compactionIncident ? "compacting" : "retrying";
    input.operation.generation += turn?.code === null ? 1 : 0;
    await writeOperationRecord(input.operation);
    input.onRetry?.(
      `${compactionIncident ? "recovering interrupted compaction" : "retrying executor"} ` +
        `(${compactionIncident ? compactionRecoveries : genericRetries}/${compactionIncident ? repeatLimit : input.retryPolicy.maxRetries})`,
      turnNumber + 1,
    );

    if (!compactionIncident) {
      await retryDelay(input.retryPolicy, genericRetries, input.request.signal);
    }
    prompt = recoveryPrompt(failure.message, compactionIncident, checkpoint, originalPrompt);
    recovery = {
      kind: compactionIncident ? "compaction" : "retry",
      compactBeforePrompt: compactionIncident,
    };
  }
}

async function changedPaths(repositoryPath: string, base: string, candidate: string): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)("git", ["diff", "--name-only", "-z", base, candidate], {
    cwd: repositoryPath,
    timeout: 30_000,
  });
  return result.stdout.split("\0").filter(Boolean);
}

function classifyFailure(
  turn: ExecutorTurn | undefined,
  thrown: unknown,
): { cause: ExecutionIncident["cause"]; stage: string; message: string } | undefined {
  if (thrown !== undefined) {
    if (thrown instanceof ExecutorLifecycleError) {
      return {
        cause: thrown.category === "compaction" ? "compaction_error" : thrown.category === "interruption" ? "interruption" : thrown.category === "protocol" ? "protocol_error" : "process_exit",
        stage: thrown.category === "compaction" ? "compacting" : "executor",
        message: thrown.message,
      };
    }
    return {
      cause: "exception",
      stage: "executor",
      message: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
  if (!turn) return { cause: "protocol_error", stage: "adapter", message: "Executor returned no turn." };
  if (turn.timedOut) return { cause: "timeout", stage: "executor", message: "Executor timed out." };
  if (turn.failure) {
    return {
      cause: turn.failure.category === "interruption"
        ? "interruption"
        : turn.failure.category === "compaction"
          ? "compaction_error"
          : turn.failure.category === "provider"
            ? "provider_error"
            : turn.failure.category === "protocol"
              ? "protocol_error"
              : "process_exit",
      stage: turn.failure.category === "compaction" || turn.failure.category === "interruption" ? "compacting" : "executor",
      message: `Executor ${turn.failure.category} error: ${turn.failure.message}`,
    };
  }
  if (turn.aborted) return { cause: "interruption", stage: "executor", message: "Executor turn was interrupted." };
  if (turn.code !== 0) return { cause: "process_exit", stage: "executor", message: `Executor exited with status ${turn.code}.` };
  if (!turn.text.trim()) return { cause: "protocol_error", stage: "adapter", message: "Executor did not produce a usable final response." };
  return undefined;
}

function recoveryPrompt(message: string, compaction: boolean, checkpoint: RecoveryCheckpoint, originalPrompt: string): string {
  const lines = compaction
    ? [
      "The previous executor turn was intentionally interrupted for context compaction.",
      "Resume this same task from the durable session summary and current workspace state.",
      "Do not restart, revert, or repeat completed exploration. Continue from where the interrupted turn stopped.",
    ]
    : [
      "The previous executor attempt was interrupted by an infrastructure or provider failure.",
      "Continue the same task from the preserved workspace state. Do not discard or duplicate completed changes.",
    ];
  lines.push(
    `Previous incident: ${message}`,
    `Recovery checkpoint: ${checkpoint.commitSha}`,
    "Finish the requested implementation and verification, then provide the normal final summary.",
    "",
    "Original bounded task (authoritative if this adapter could not restore conversational context):",
    originalPrompt,
  );
  return lines.join("\n");
}

async function retryDelay(policy: ExecutionRetryPolicy, retry: number, signal?: AbortSignal): Promise<void> {
  if (policy.baseDelayMs === 0) return;
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
  const delay = policy.jitter ? Math.floor(exponential * (0.5 + Math.random() * 0.5)) : exponential;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled."));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
