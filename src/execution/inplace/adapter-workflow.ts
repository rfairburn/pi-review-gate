import { join, resolve } from "node:path";
import { DEFAULT_EXECUTION_RETRY_POLICY, type ReviewGateConfig } from "../../config";
import { captureObservedToolPathAfterStates, recordToolEventObservability, type EvidenceState } from "../../evidence";
import { createExecutorAdapter } from "../adapters/factory";
import { createIncident, createOperationRecord, readOperationRecord, writeOperationRecord, type ExecutorAssignmentRecord, type OperationRecord } from "../operation-record";
import { normalizeExecutorToolCatalog } from "../tool-catalog";
import type { ExecutorSession } from "../types";
import type { WaveWorkerTask } from "../wave-worker";
import { ensureArtifactDir } from "./containment";
import type { InPlaceBaseline } from "./basis";
import type { InPlaceRunInput, InPlaceWorkerResult } from "./contracts";
import { buildInPlaceContinuationDisclosure, buildInPlacePrompt } from "./prompts";
import { beginInPlaceAssignment, inPlaceChildSettlementIsVerified, runInplaceTurnLoop, type RecoveredInPlaceRun } from "./turn-loop";

// ── turn runner shared by fresh and continued in-place tasks ─────────────────

async function loadOrCreateInPlaceOperation(input: {
  taskId: string;
  task: WaveWorkerTask;
  workspaceRoot: string;
  artifactDir: string;
  config: ReviewGateConfig;
}): Promise<OperationRecord> {
  const existing = await readOperationRecord(join(input.artifactDir, "operation.json")).catch(() => undefined);
  if (existing) {
    if (existing.taskId !== input.taskId || resolve(existing.artifactDir) !== resolve(input.artifactDir)) {
      throw new Error("Retained in-place operation record does not match this task.");
    }
    if (existing.state === "failed_critical") {
      throw new Error("Retained in-place operation is fail-closed after an unverified process settlement; automatic continuation is refused.");
    }
    return existing;
  }
  // Deliberate in-place identity: the retained record names the in-place
  // execution window (`inplace`), not a wave. Nothing here fabricates a base
  // commit or capture: in-place work has neither.
  const record = createOperationRecord({
    waveId: "inplace",
    taskId: input.taskId,
    title: input.task.title,
    worktreeRoot: input.workspaceRoot,
    effectiveCwd: input.workspaceRoot,
    artifactDir: input.artifactDir,
    retryBudget: input.config.execution?.retryPolicy?.maxRetries ?? DEFAULT_EXECUTION_RETRY_POLICY.maxRetries,
    executorToolCatalog: normalizeExecutorToolCatalog(input.task),
  });
  await writeOperationRecord(record);
  return record;
}

/**
 * Run one in-place executor turn: initial (fresh dispatch) or resumed
 * (continuation feedback delivered to the retained session and workspace).
 */
export async function runInplaceTurnWorker(input: InPlaceRunInput & {
  mode: "initial" | "continuation";
  startingTurn: number;
  feedback?: string;
  priorSession?: ExecutorSession;
  evidence: EvidenceState;
  baseline: InPlaceBaseline;
}): Promise<InPlaceWorkerResult> {
  const { taskId, task, config } = input;
  normalizeExecutorToolCatalog(task);
  const artifactDir = await ensureArtifactDir(input.artifactDir, input.workspaceRoot);
  const operation = await loadOrCreateInPlaceOperation({
    taskId,
    task,
    workspaceRoot: input.workspaceRoot,
    artifactDir,
    config,
  });

  const initialAssignment = input.executorAssignment;
  if (!initialAssignment) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: "No executor capacity was assigned for this in-place task.",
      adapter: "none",
      error: "No executor capacity was assigned for this in-place task.",
      operationRecord: join(artifactDir, "operation.json"),
      incidents: [...operation.incidents],
      attempts: operation.attempts.length,
    };
  }

  let prompt = input.mode === "continuation" && input.feedback
    ? (input.priorSession
      ? [
        buildInPlaceContinuationDisclosure(true),
        "",
        "Current continuation instructions:",
        input.feedback,
      ].join("\n")
      : [
        buildInPlacePrompt(task, input.workspaceRoot),
        "",
        buildInPlaceContinuationDisclosure(false),
        "",
        "Current continuation instructions:",
        input.feedback,
      ].join("\n"))
    : buildInPlacePrompt(task, input.workspaceRoot);

  let assignment = initialAssignment;
  let session = input.priorSession;
  let startingTurn = input.startingTurn;
  let failoverExhausted = false;
  let reason: ExecutorAssignmentRecord["reason"] = input.mode === "continuation" ? "continuation" : "initial";
  for (;;) {
    const assignmentRecord = beginInPlaceAssignment(operation, assignment, reason, config);
    input.onUpdate?.({
      phase: input.mode === "continuation" ? "correcting" : "starting",
      message: reason === "failover"
        ? `starting replacement executor ${assignment.entry.entryId} in the same in-place workspace`
        : input.mode === "continuation"
          ? `resuming in-place executor turn ${startingTurn} in ${input.workspaceRoot}`
          : "in-place worker starting executor",
      artifactDir,
      executorEntryId: assignment.entry.entryId,
      executorSelection: { ...assignment.entry.selection },
    });

    let adapter: ReturnType<typeof createExecutorAdapter>;
    try {
      adapter = (input.adapterFactory ?? createExecutorAdapter)(config, assignment.entry.selection);
      operation.adapter = adapter.kind;
      operation.model = adapter.model;
      recordToolEventObservability(input.evidence, adapter.kind, adapter.toolEventObservability ?? {
        mode: "unavailable",
        description: "This executor adapter does not expose a structured tool-event stream; tool-level write paths are not observed.",
      });
      await writeOperationRecord(operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create executor adapter.";
      const incident = createIncident({
        attempt: operation.attempts.length,
        generation: operation.generation,
        cause: "provider_error",
        stage: "adapter_initialization",
        message,
        retryable: true,
      });
      operation.incidents.push(incident);
      assignmentRecord.endedAt = new Date().toISOString();
      assignmentRecord.outcome = "failed";
      const next = await input.acquireFailover?.(assignment);
      if (!next || input.signal?.aborted) {
        failoverExhausted = Boolean(input.acquireFailover) && !input.signal?.aborted;
        operation.state = input.signal?.aborted ? "cancelled" : "paused_recoverable";
        await writeOperationRecord(operation);
        input.onLiveControl?.(undefined);
        return {
          status: input.signal?.aborted ? "cancelled" : "executor_error",
          taskId,
          title: task.title,
          summary: input.signal?.aborted ? "In-place executor was cancelled." : message,
          adapter: "none",
          error: message,
          operationRecord: join(artifactDir, "operation.json"),
          incidents: [...operation.incidents],
          attempts: operation.attempts.length,
          effectiveAssignment: assignment,
          failoverExhausted,
        };
      }
      incident.resolvedAt = new Date().toISOString();
      incident.resolution = "executor_pool_failover";
      operation.generation += 1;
      operation.session = undefined;
      assignment = next;
      session = undefined;
      startingTurn = Math.max(startingTurn, operation.attempts.length + 1);
      prompt = inPlaceFailoverPrompt(task, input.workspaceRoot, input.mode, input.feedback, message);
      reason = "failover";
      await writeOperationRecord(operation);
      continue;
    }

    input.onUpdate?.({
      phase: "executing",
      message: `executor turn ${startingTurn} running in place`,
      artifactDir,
      adapter: adapter.kind,
      model: adapter.model,
      executorEntryId: assignment.entry.entryId,
      executorSelection: { ...assignment.entry.selection },
    });

    let run: RecoveredInPlaceRun;
    try {
      run = await runInplaceTurnLoop({
        adapter,
        evidence: input.evidence,
        baseline: input.baseline,
        workspaceRoot: input.workspaceRoot,
        artifactDir,
        config,
        task,
        taskId,
        prompt,
        startingTurn,
        session,
        signal: input.signal,
        operation,
        assignment,
        onUpdate: input.onUpdate,
        onLiveControl: input.onLiveControl,
      });
    } finally {
      assignmentRecord.endedAt = new Date().toISOString();
      assignmentRecord.outcome = operation.state === "running" || operation.state === "completed" || operation.state === "cancelled"
        ? "completed"
        : "failed";
      await writeOperationRecord(operation);
    }
    await captureObservedToolPathAfterStates(input.evidence, input.workspaceRoot, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });

    if (run.status === "failed" && !input.signal?.aborted && run.incidents.at(-1)?.retryable === true) {
      if (!inPlaceChildSettlementIsVerified(run.childProcesses, run.unmatchedChildExit)) {
        const message = "In-place executor failure is not eligible for failover because child-process settlement was not verified.";
        const incident = createIncident({
          attempt: operation.attempts.length,
          generation: operation.generation,
          cause: "process_exit",
          stage: "failover_settlement",
          message,
          retryable: false,
          terminalCode: "recovery_state_corrupt_or_unverifiable",
        });
        operation.incidents.push(incident);
        operation.state = "failed_critical";
        await writeOperationRecord(operation);
        run = { ...run, status: "failed", error: message };
      } else {
        const next = await input.acquireFailover?.(assignment);
        if (next) {
          for (const incident of run.incidents) {
            if (!incident.resolvedAt && incident.retryable) {
              incident.resolvedAt = new Date().toISOString();
              incident.resolution = "executor_pool_failover";
            }
          }
          input.onUpdate?.({
            phase: "executing",
            message: `executor failover: ${assignment.entry.entryId} -> ${next.entry.entryId} after configured recovery attempts; continuing in the same in-place workspace with no reset or rollback`,
            artifactDir,
            executorEntryId: next.entry.entryId,
            executorSelection: { ...next.entry.selection },
          });
          operation.generation += 1;
          operation.session = undefined;
          assignment = next;
          session = undefined;
          startingTurn = run.lastTurnNumber + 1;
          prompt = inPlaceFailoverPrompt(task, input.workspaceRoot, input.mode, input.feedback, run.error ?? "executor failure");
          reason = "failover";
          await writeOperationRecord(operation);
          continue;
        }
        failoverExhausted = Boolean(input.acquireFailover);
      }
    }

    const operationRecord = join(artifactDir, "operation.json");
    const common = {
      taskId,
      title: task.title,
      usage: run.turn?.usage,
      turn: run.turn,
      adapter: adapter.kind,
      model: adapter.model,
      session: run.turn?.session ?? session ?? operation.session ?? undefined,
      operationRecord,
      incidents: [...operation.incidents],
      attempts: operation.attempts.length,
      lastExecutorTurn: run.lastTurnNumber,
      effectiveAssignment: assignment,
      failoverExhausted,
    };
    if (run.status === "cancelled" || input.signal?.aborted) {
      input.onUpdate?.({
        phase: "completing",
        message: "in-place executor was cancelled; writes it already performed were not rolled back",
        artifactDir,
        adapter: adapter.kind,
        model: adapter.model,
      });
      return { ...common, status: "cancelled", summary: run.turn?.text ?? "In-place executor was cancelled.", error: run.error };
    }
    if (run.status !== "completed" || !run.turn) {
      const timedOut = run.error?.includes("timed out") ?? false;
      input.onUpdate?.({
        phase: "completing",
        message: timedOut ? "in-place executor timed out" : "in-place executor failed",
        artifactDir,
        adapter: adapter.kind,
        model: adapter.model,
      });
      return {
        ...common,
        status: timedOut ? "timeout" : "executor_error",
        summary: run.error ?? "In-place executor failed.",
        error: run.error ?? "In-place executor failed.",
      };
    }
    input.onUpdate?.({
      phase: "completing",
      message: "in-place executor turn completed; its writes remain in the workspace",
      artifactDir,
      adapter: adapter.kind,
      model: adapter.model,
    });
    return { ...common, status: "completed", summary: run.turn.text, session: run.turn.session };
  }
}

function inPlaceFailoverPrompt(
  task: WaveWorkerTask,
  workspaceRoot: string,
  mode: "initial" | "continuation",
  feedback: string | undefined,
  failure: string,
): string {
  return [
    "In-place executor failover (authoritative):",
    "A prior executor assignment failed or exhausted the configured same-adapter recovery attempts. Continue this same task directly in the existing launch-selected workspace.",
    `Selected workspace: ${workspaceRoot}. No wave capture, new launch baseline, workspace reset, checkpoint, rollback, or landing occurred. The original launch baseline remains authoritative.`,
    "Prior direct workspace writes, writes outside this workspace, and other external effects may already have occurred. Inspect the current workspace and relevant state before continuing; avoid repeating completed actions.",
    "The prior executor session/conversation is not transferred to this replacement. This is a fresh session; rely on the task, current workspace and state, and the incident below.",
    `Prior executor failure: ${failure}`,
    "",
    buildInPlacePrompt(task, workspaceRoot),
    ...(mode === "continuation" && feedback ? ["", "Current continuation instructions:", feedback] : []),
  ].join("\n");
}
