import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvedExecutorPool, type ReviewGateConfig } from "../config";
import { candidateRefName } from "./wave-commits";
import { integrateWave, type SelectedWorker, type WaveIntegrationResult } from "./wave-integration";
import { executeWaveLanding, planWaveLanding, type LandingExecutionResult } from "./wave-landing";
import { readWaveCaptureRecord } from "./wave-repository";
import { runWaveWorkerLifecycle, type WaveWorkerLifecycleResult } from "./wave-worker-lifecycle";
import { resumeWaveWorker, type WaveWorkerResult, type WaveWorkerTask } from "./wave-worker";
import { createWorkerWorktree, pinCommit, removeWorktree, type WorkerWorktree } from "./wave-worktrees";
import { GIT_NO_LOCKS_ENV as GIT_ENV } from "./wave-validation";
import {
  createReattachmentBundle,
  createIncident,
  operationRecordPath,
  readOperationRecord,
  writeOperationRecord,
  type OperationRecord,
  type OperationInstruction,
  type ReattachmentBundle,
} from "./operation-record";
import type { WaveManifest, WaveManifestTask } from "./wave-controller";
import { ExecutorPoolScheduler, type ExecutorPoolLease } from "./executor-pool";

export interface OperationInspection {
  bundle: ReattachmentBundle;
  staleBundle: boolean;
  record: OperationRecord;
  manifest: {
    path: string;
    phase: string;
    sourceRoot: string;
    repositoryPath: string;
    baseCommit: string;
    baseRef: string;
    integrationStatus?: string;
    landingStatus?: string;
    sourceWorkspace: {
      disposition: "unchanged" | "landed" | "recovery_required";
      guidance: string;
    };
    integration?: {
      status?: string;
      validationStatus?: string;
      integratedRef?: string;
      finalCommitSha?: string;
      worktree?: string;
      worktreeDisposition?: "preserved_for_diagnosis" | "cleanup_attempted";
      conflictingTaskId?: string;
      conflictingCommitSha?: string;
      conflictingPaths?: string[];
      gitDiagnostics?: string;
      error?: string;
      workerMappings?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
      successfullyIntegrated?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
    };
    landing?: {
      status?: string;
      appliedPaths?: string[];
      alreadyAppliedPaths?: string[];
      conflicts?: Array<{ path: string; reason: string }>;
      failedAtPath?: string | null;
      failureReason?: string;
      manifestPath?: string;
      rollbackError?: string;
      headDrift?: { drifted: boolean; capturedHead?: string; currentHead?: string };
    };
    tasks: WaveManifestTask[];
    task?: WaveManifestTask;
  };
  live: false;
  steerable: false;
  safeActions: Array<"continue" | "inspect">;
  blockedActions: Array<{ action: string; reason: string }>;
}

export async function inspectOperation(bundle: ReattachmentBundle): Promise<OperationInspection> {
  const { waveRoot, manifest, record } = await resolveOperation(bundle);
  const canContinue = Boolean(record.session && record.checkpoint?.verified)
    && !["cancelled", "failed_critical", "running", "compacting", "retrying"].includes(record.state);
  const sourceDisposition = manifest.landingStatus === "landed"
    ? "landed"
    : manifest.landingStatus === "recovery_required"
      ? "recovery_required"
      : "unchanged";
  const sourceGuidance = sourceDisposition === "landed"
    ? "The wave changes were landed into the source workspace."
    : sourceDisposition === "recovery_required"
      ? "Landing rollback was incomplete; inspect the recovery manifest before modifying the source workspace."
      : "The wave did not land executor changes; the source workspace remains unchanged by this wave.";
  return {
    bundle: createReattachmentBundle(record, waveRoot),
    staleBundle: bundle.expectedRevision !== record.revision,
    record,
    manifest: {
      path: join(waveRoot, "wave-manifest.json"),
      phase: manifest.phase,
      sourceRoot: manifest.sourceRoot,
      repositoryPath: manifest.repositoryPath,
      baseCommit: manifest.baseCommit,
      baseRef: manifest.baseRef,
      integrationStatus: manifest.integrationStatus,
      landingStatus: manifest.landingStatus,
      sourceWorkspace: {
        disposition: sourceDisposition,
        guidance: sourceGuidance,
      },
      integration: manifest.integrationStatus ? {
        status: manifest.integrationStatus,
        validationStatus: manifest.integrationValidationStatus,
        integratedRef: manifest.integrationRef,
        finalCommitSha: manifest.integrationFinalCommitSha,
        worktree: manifest.integrationWorktree,
        worktreeDisposition: manifest.integrationWorktree
          ? manifest.integrationStatus === "conflicted" || manifest.integrationStatus === "error"
            ? "preserved_for_diagnosis"
            : "cleanup_attempted"
          : undefined,
        conflictingTaskId: manifest.integrationConflictingTaskId,
        conflictingCommitSha: manifest.integrationConflictingCommitSha,
        conflictingPaths: manifest.integrationConflictingPaths,
        gitDiagnostics: manifest.integrationGitDiagnostics,
        error: manifest.integrationError,
        workerMappings: manifest.integrationWorkerMappings,
        successfullyIntegrated: manifest.integrationSuccessfullyIntegrated,
      } : undefined,
      landing: manifest.landingStatus ? {
        status: manifest.landingStatus,
        appliedPaths: manifest.landingAppliedPaths,
        alreadyAppliedPaths: manifest.landingAlreadyAppliedPaths,
        conflicts: manifest.landingConflicts,
        failedAtPath: manifest.landingFailedAtPath,
        failureReason: manifest.landingFailureReason,
        manifestPath: manifest.landingManifestPath,
        rollbackError: manifest.landingRollbackError,
        headDrift: manifest.landingHeadDrift,
      } : undefined,
      tasks: manifest.tasks,
      task: manifest.tasks.find((task) => task.taskId === record.taskId),
    },
    live: false,
    steerable: false,
    safeActions: canContinue ? ["continue", "inspect"] : ["inspect"],
    blockedActions: [
      { action: "steer", reason: "The current executor adapters are foreground-only and this operation has no live turn." },
      ...(!canContinue ? [{ action: "continue", reason: `Operation state ${record.state} does not currently permit an automatic continuation.` }] : []),
    ],
  };
}

export async function continueOperation(input: {
  bundle: ReattachmentBundle;
  instructions: string;
  instructionId: string;
  config: ReviewGateConfig;
  scopedModels?: string[];
  signal?: AbortSignal;
  onUpdate?: (message: string) => void;
}): Promise<{
  inspection: OperationInspection;
  lifecycle?: WaveWorkerLifecycleResult;
  integration?: WaveIntegrationResult;
  landing?: LandingExecutionResult;
  duplicateInstruction?: boolean;
}> {
  const resolved = await resolveOperation(input.bundle);
  const { waveRoot, manifest } = resolved;
  let record = resolved.record;
  if (input.bundle.expectedRevision !== record.revision) {
    throw new Error(
      `Stale reattachment bundle revision ${input.bundle.expectedRevision}; current operation revision is ${record.revision}. Inspect and retry with the returned bundle.`,
    );
  }
  const priorInstruction = record.instructions.find((item) => item.instructionId === input.instructionId);
  if (priorInstruction) {
    return {
      inspection: await inspectOperation(createReattachmentBundle(record, waveRoot)),
      duplicateInstruction: true,
    };
  }
  if (!record.session || !record.checkpoint) {
    throw new Error("Operation cannot continue because its session or verified recovery checkpoint is missing.");
  }
  if (record.state === "cancelled" || record.state === "failed_critical") {
    throw new Error(`Operation state ${record.state} cannot be continued automatically.`);
  }
  if (record.state === "running" || record.state === "compacting" || record.state === "retrying") {
    throw new Error("Operation may still own a live writer; inspect it before continuing.");
  }
  const previouslyLanded = record.state === "landed" || manifest.landingStatus === "landed";
  const continuationLandingBase = previouslyLanded ? record.checkpoint.commitSha : undefined;

  const capture = await readWaveCaptureRecord(waveRoot);
  const task = await readTask(record.artifactDir);
  const recoveryWorktree = await ensureRecoveryWorktree(capture, record, input.signal);
  record.generation += 1;
  const continuationCapture = { ...capture, waveId: `${capture.waveId}-g${record.generation}` };
  await promisify(execFile)("git", [
    "update-ref",
    candidateRefName(continuationCapture.waveId, record.taskId),
    record.checkpoint.commitSha,
  ], {
    cwd: capture.repositoryPath,
    env: { ...process.env, ...GIT_ENV },
    timeout: 30_000,
    signal: input.signal,
  });

  const instructionRecord: OperationInstruction = {
    instructionId: input.instructionId,
    sequence: record.nextInstructionSequence++,
    action: "continue",
    text: input.instructions,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  record.instructions.push(instructionRecord);
  await writeOperationRecord(record);

  const prior: WaveWorkerResult = {
    status: "completed",
    taskId: record.taskId,
    title: record.title,
    summary: "Recovered from durable operation state.",
    adapter: record.adapter ?? record.session.adapter,
    model: record.model,
    session: record.session,
    candidate: {
      commitSha: record.checkpoint.commitSha,
      treeSha: record.checkpoint.treeSha,
      candidateRef: candidateRefName(record.waveId, record.taskId),
      differsFromBase: record.checkpoint.differsFromBase,
    },
    operationRecord: operationRecordPath(record.artifactDir),
    bundle: createReattachmentBundle(record, waveRoot),
    checkpoint: record.checkpoint,
    incidents: record.incidents,
    attempts: record.attempts.length,
    lastExecutorTurn: Math.max(0, ...record.attempts.map((attempt) => attempt.turn)),
  };
  const nextTurn = (prior.lastExecutorTurn ?? 0) + 1;
  const instruction = [
    `Continuation instruction ${input.instructionId}:`,
    input.instructions,
    "Continue from the preserved workspace and session state; do not restart completed work.",
  ].join("\n\n");
  instructionRecord.status = "delivered";
  instructionRecord.deliveredAt = new Date().toISOString();
  await writeOperationRecord(record);
  const continuationPool = new ExecutorPoolScheduler(resolvedExecutorPool(input.config));
  let failoverLease: ExecutorPoolLease | undefined;
  const acquireFailover = async (currentPriority: number) => {
    failoverLease?.release();
    failoverLease = await continuationPool.acquireAfter(currentPriority, input.signal);
    return failoverLease;
  };
  let continued: WaveWorkerResult;
  try {
    continued = await resumeWaveWorker({
    taskId: record.taskId,
    task,
    capture: continuationCapture,
    worktree: recoveryWorktree,
    artifactDir: record.artifactDir,
    config: input.config,
    sourceRoot: capture.discovery.captureRoot,
    sourceRootAliases: [capture.discovery.requestedCwd],
    priorResult: prior,
    feedback: instruction,
    turn: nextTurn,
    signal: input.signal,
    acquireFailover,
    onUpdate: (update) => input.onUpdate?.(update.message),
    });
  } catch (error) {
    record = await readOperationRecord(operationRecordPath(record.artifactDir));
    const persistedInstruction = record.instructions.find((item) => item.instructionId === input.instructionId);
    if (persistedInstruction) {
      persistedInstruction.status = "failed";
      persistedInstruction.error = error instanceof Error ? error.message : String(error);
    }
    record.state = "paused_recoverable";
    await writeOperationRecord(record);
    failoverLease?.release();
    throw error;
  }

  let lifecycle: WaveWorkerLifecycleResult;
  try {
    lifecycle = await runWaveWorkerLifecycle({
      taskId: record.taskId,
      task,
      capture: continuationCapture,
      worktree: recoveryWorktree,
      artifactDir: record.artifactDir,
      config: input.config,
      sourceRoot: capture.discovery.captureRoot,
      sourceRootAliases: [capture.discovery.requestedCwd],
      scopedModels: input.scopedModels,
      signal: input.signal,
      acquireFailover,
      onUpdate: (update) => input.onUpdate?.(update.message),
      initialResult: continued,
    });
  } finally {
    failoverLease?.release();
  }
  record = await readOperationRecord(operationRecordPath(record.artifactDir));
  const persistedInstruction = record.instructions.find((item) => item.instructionId === input.instructionId);
  if (persistedInstruction) {
    persistedInstruction.status = "acknowledged";
    persistedInstruction.acknowledgedAt = new Date().toISOString();
  }

  if (!isEligible(lifecycle) || !lifecycle.acceptedCommitSha) {
    record.state = lifecycle.status === "cancelled" ? "cancelled" : "paused_recoverable";
    await writeOperationRecord(record);
    await publishContinuationManifest(join(waveRoot, "wave-manifest.json"), manifest, lifecycle);
    return { inspection: await inspectOperation(createReattachmentBundle(record, waveRoot)), lifecycle };
  }

  const selected = selectedWorkers(manifest, lifecycle);
  for (const worker of selected) {
    if (worker.taskId === lifecycle.taskId) continue;
    await pinCommit(continuationCapture, worker.commitSha, { type: "worker", taskId: worker.taskId }, input.signal);
  }
  const integration = await retryOperationStage(
    record,
    input.config,
    "integrating",
    "integration_error",
    async () => {
      await removeWorktree(join(waveRoot, "integration"), capture.repositoryPath).catch(() => {});
      return integrateWave(continuationCapture, selected, input.signal);
    },
    input.signal,
  );
  if (integration.status !== "integrated" || !integration.finalCommitSha) {
    record.state = "paused_recoverable";
    await writeOperationRecord(record);
    await publishContinuationManifest(join(waveRoot, "wave-manifest.json"), manifest, lifecycle, integration);
    return { inspection: await inspectOperation(createReattachmentBundle(record, waveRoot)), lifecycle, integration };
  }
  const landing = await retryOperationStage(
    record,
    input.config,
    "landing",
    "landing_error",
    async () => {
      const landingCapture = continuationLandingBase
        ? { ...continuationCapture, baseCommit: continuationLandingBase }
        : continuationCapture;
      const plan = await planWaveLanding(landingCapture, integration.finalCommitSha, capture.discovery.captureRoot, input.signal);
      return executeWaveLanding(plan, landingCapture, input.signal);
    },
    input.signal,
  );
  record.state = landing.status === "landed"
    ? "landed"
    : landing.status === "recovery_required"
      ? "failed_critical"
      : "paused_recoverable";
  if (landing.status === "recovery_required") {
    record.incidents.push(createIncident({
      attempt: record.attempts.length,
      generation: record.generation,
      cause: "landing_error",
      stage: "landing",
      message: landing.diagnostics.failureReason,
      retryable: false,
      terminalCode: "landing_rollback_incomplete",
    }));
  }
  await writeOperationRecord(record);
  await publishContinuationManifest(join(waveRoot, "wave-manifest.json"), manifest, lifecycle, integration, landing);
  if (landing.status === "landed") {
    await removeWorktree(recoveryWorktree.worktreeRoot, capture.repositoryPath).catch(() => {});
  }
  return {
    inspection: await inspectOperation(createReattachmentBundle(record, waveRoot)),
    lifecycle,
    integration,
    landing,
  };
}

async function ensureRecoveryWorktree(
  capture: Awaited<ReturnType<typeof readWaveCaptureRecord>>,
  record: OperationRecord,
  signal?: AbortSignal,
): Promise<WorkerWorktree> {
  const existing = await fs.lstat(record.worktreeRoot).catch(() => undefined);
  if (existing?.isDirectory() && !existing.isSymbolicLink()) {
    return { worktreeRoot: record.worktreeRoot, effectiveCwd: record.effectiveCwd };
  }
  if (!record.checkpoint?.verified) throw new Error("Cannot recreate worker without a verified recovery checkpoint.");
  const worktree = await createWorkerWorktree(capture, record.taskId, signal);
  await promisify(execFile)("git", ["reset", "--hard", record.checkpoint.commitSha], {
    cwd: worktree.worktreeRoot,
    env: { ...process.env, ...GIT_ENV },
    timeout: 30_000,
    signal,
  });
  record.worktreeRoot = worktree.worktreeRoot;
  record.effectiveCwd = worktree.effectiveCwd;
  await writeOperationRecord(record);
  return worktree;
}

async function retryOperationStage<T>(
  record: OperationRecord,
  config: ReviewGateConfig,
  stage: string,
  cause: "integration_error" | "landing_error",
  invoke: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const policy = config.execution?.retryPolicy ?? { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 15_000, jitter: true, maxSameIncidentRepeats: 2 };
  let retries = 0;
  let lastMessage: string | undefined;
  let repeats = 0;
  for (;;) {
    try {
      const value = await invoke();
      for (const incident of record.incidents) {
        if (incident.cause === cause && !incident.resolvedAt) {
          incident.resolvedAt = new Date().toISOString();
          incident.resolution = `${stage}_recovered`;
        }
      }
      await writeOperationRecord(record);
      return value;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      repeats = lastMessage === message ? repeats + 1 : 1;
      lastMessage = message;
      const retryable = retries < policy.maxRetries && repeats <= policy.maxSameIncidentRepeats;
      record.incidents.push(createIncident({
        attempt: record.attempts.length + retries + 1,
        generation: record.generation,
        cause,
        stage,
        message,
        retryable,
      }));
      record.state = retryable ? "retrying" : "paused_recoverable";
      await writeOperationRecord(record);
      if (!retryable) throw error;
      retries += 1;
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retries - 1));
      const delay = policy.jitter ? Math.floor(ceiling * (0.5 + Math.random() * 0.5)) : ceiling;
      if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    }
  }
}

async function publishContinuationManifest(
  path: string,
  manifest: WaveManifest,
  lifecycle: WaveWorkerLifecycleResult,
  integration?: WaveIntegrationResult,
  landing?: LandingExecutionResult,
): Promise<void> {
  const task = manifest.tasks.find((item) => item.taskId === lifecycle.taskId);
  if (task) {
    Object.assign(task, {
      status: lifecycle.status,
      summary: lifecycle.summary,
      error: lifecycle.error,
      acceptedRef: lifecycle.acceptedRef,
      acceptedCommitSha: lifecycle.acceptedCommitSha,
      reviewReport: lifecycle.reviewReport,
      operationRecord: lifecycle.operationRecord,
      bundle: lifecycle.bundle,
      incidents: lifecycle.incidents,
      checkpoint: lifecycle.checkpoint,
      attempts: lifecycle.attempts,
    });
  }
  manifest.phase = "completed";
  if (integration) {
    delete manifest.landingStatus;
    delete manifest.landingAppliedPaths;
    delete manifest.landingAlreadyAppliedPaths;
    delete manifest.landingConflicts;
    delete manifest.landingFailedAtPath;
    delete manifest.landingFailureReason;
    delete manifest.landingManifestPath;
    delete manifest.landingRollbackError;
    manifest.integrationStatus = integration.status;
    delete manifest.integrationConflictingTaskId;
    delete manifest.integrationConflictingCommitSha;
    delete manifest.integrationConflictingPaths;
    delete manifest.integrationGitDiagnostics;
    delete manifest.integrationError;
    delete manifest.integrationSuccessfullyIntegrated;
    delete manifest.integrationWorkerMappings;
    delete manifest.integrationValidationStatus;
    delete manifest.integrationRef;
    delete manifest.integrationFinalCommitSha;
    manifest.integrationWorktree = integration.worktree;
    if (integration.status === "conflicted") {
      manifest.integrationConflictingTaskId = integration.conflictingTaskId;
      manifest.integrationConflictingCommitSha = integration.conflictingCommitSha;
      manifest.integrationConflictingPaths = integration.conflictingPaths;
      manifest.integrationGitDiagnostics = integration.gitDiagnostics;
      manifest.integrationWorktree = integration.worktree;
    } else if (integration.status === "integrated") {
      manifest.integrationValidationStatus = integration.validationStatus;
      manifest.integrationRef = integration.integratedRef;
      manifest.integrationFinalCommitSha = integration.finalCommitSha;
      manifest.integrationWorkerMappings = integration.workerMappings;
    } else {
      manifest.integrationValidationStatus = integration.validationStatus;
      manifest.integrationRef = integration.integratedRef;
      manifest.integrationFinalCommitSha = integration.baseCommitSha;
      manifest.integrationWorkerMappings = integration.workerMappings;
    }
  }
  if (landing) {
    manifest.landingStatus = landing.status;
    delete manifest.landingAppliedPaths;
    delete manifest.landingAlreadyAppliedPaths;
    delete manifest.landingConflicts;
    delete manifest.landingFailedAtPath;
    delete manifest.landingFailureReason;
    delete manifest.landingManifestPath;
    delete manifest.landingRollbackError;
    if (landing.status === "landed") {
      manifest.landingAppliedPaths = landing.appliedPaths;
      manifest.landingAlreadyAppliedPaths = landing.alreadyAppliedPaths;
    } else if (landing.status === "conflicted") {
      manifest.landingConflicts = landing.conflicts;
    } else if (landing.status === "recovery_required") {
      manifest.landingFailedAtPath = landing.diagnostics.failedAtPath;
      manifest.landingFailureReason = landing.diagnostics.failureReason;
      manifest.landingManifestPath = landing.diagnostics.manifestPath;
      manifest.landingRollbackError = landing.diagnostics.rollbackError;
    } else if (landing.status === "rolled_back") {
      manifest.landingFailedAtPath = landing.failedAtPath;
      manifest.landingFailureReason = landing.failureReason;
    }
  }
  manifest.revision += 1;
  manifest.updatedAt = new Date().toISOString();
  const temporary = `${path}.tmp.${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
  await fs.rename(temporary, path);
}

async function resolveOperation(bundle: ReattachmentBundle): Promise<{
  waveRoot: string;
  manifest: WaveManifest;
  record: OperationRecord;
}> {
  if (bundle.version !== 1 || !bundle.waveId || !bundle.taskId || !bundle.operationId || !bundle.waveRoot) {
    throw new Error("Invalid reattachment bundle.");
  }
  const waveRoot = await fs.realpath(resolve(bundle.waveRoot));
  if (!basename(waveRoot).startsWith("wave-")) throw new Error("Invalid wave root in reattachment bundle.");
  const manifestPath = join(waveRoot, "wave-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WaveManifest;
  if (manifest.version !== 1 || manifest.waveId !== bundle.waveId) {
    throw new Error("Reattachment bundle does not match the wave manifest.");
  }
  const path = join(waveRoot, "artifacts", bundle.taskId, "operation.json");
  const resolvedPath = await fs.realpath(path);
  const rel = relative(waveRoot, resolvedPath);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Operation record is outside the wave root.");
  const record = await readOperationRecord(resolvedPath);
  if (record.operationId !== bundle.operationId || record.waveId !== bundle.waveId || record.taskId !== bundle.taskId) {
    throw new Error("Reattachment bundle identity does not match the operation record.");
  }
  if (await fs.realpath(record.artifactDir) !== await fs.realpath(join(waveRoot, "artifacts", bundle.taskId))) {
    throw new Error("Operation artifact ownership does not match the wave.");
  }
  return { waveRoot, manifest, record };
}

async function readTask(artifactDir: string): Promise<WaveWorkerTask> {
  const parsed = JSON.parse(await readFile(join(artifactDir, "task.json"), "utf8")) as { task?: WaveWorkerTask };
  if (!parsed.task || typeof parsed.task.title !== "string" || !Array.isArray(parsed.task.acceptanceCriteria)) {
    throw new Error("Operation task metadata is missing or invalid.");
  }
  return parsed.task;
}

function isEligible(result: WaveWorkerLifecycleResult): boolean {
  return result.status === "accepted" || result.status === "accepted_with_warnings" || result.status === "completed_unreviewed";
}

function selectedWorkers(manifest: WaveManifest, recovered: WaveWorkerLifecycleResult): SelectedWorker[] {
  const selected = manifest.tasks.flatMap((task) => {
    if (task.taskId === recovered.taskId) return [];
    if (!task.acceptedCommitSha || !["accepted", "accepted_with_warnings", "completed_unreviewed"].includes(task.status)) return [];
    return [{ taskId: task.taskId, commitSha: task.acceptedCommitSha }];
  });
  selected.push({ taskId: recovered.taskId, commitSha: recovered.acceptedCommitSha! });
  return selected;
}
