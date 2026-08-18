import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvedExecutorPool, type ReviewGateConfig } from "../config";
import type { ExecutorPoolAssignment } from "./executor-pool";
import { candidateRefName, normalizeCandidate, pinRecoveryCandidate } from "./wave-commits";
import type { WaveIntegrationResult } from "./wave-integration";
import { executeWaveLanding, inspectLandingRecoveryManifests, planWaveLanding, recoverLandingManifest, type LandingExecutionResult, type LandingPlan, type LandingRecoveryManifestInspection } from "./wave-landing";
import { readWaveCaptureRecord } from "./wave-repository";
import { runWaveWorkerLifecycle, type WaveWorkerLifecycleResult } from "./wave-worker-lifecycle";
import { createTaskInstructionEvidenceRecorder, resumeWaveWorker, type WaveWorkerResult, type WaveWorkerTask } from "./wave-worker";
import { createWorkerWorktree, pinCommit, removeWorktree, type WorkerWorktree } from "./wave-worktrees";
import { GIT_NO_LOCKS_ENV as GIT_ENV } from "./wave-validation";
import {
  createReattachmentBundle,
  createIncident,
  operationOwnershipStatus,
  operationRecordPath,
  readOperationRecord,
  releaseOperationOwner,
  writeOperationRecord,
  type OperationRecord,
  type OperationInstruction,
  type ReattachmentBundle,
} from "./operation-record";
import type { WaveManifest, WaveManifestTask } from "./wave-controller";
import { ExecutorPoolScheduler, type ExecutorPoolLease } from "./executor-pool";
import { acquireWaveOwner, heartbeatWaveOwner, inspectWaveOwner, releaseWaveOwner } from "./wave-owner";
import type { ExecutorLiveControl } from "./types";
import { sourceMutationCoordinator } from "./source-mutation-lease";

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
      recoveryManifests?: LandingRecoveryManifestInspection[];
    };
    tasks: WaveManifestTask[];
    task?: WaveManifestTask;
  };
  live: boolean;
  checkpointVerification: {
    status: "verified" | "missing" | "invalid";
    error?: string;
  };
  steerable: false;
  safeActions: Array<"continue" | "inspect">;
  blockedActions: Array<{ action: string; reason: string }>;
}

export async function inspectOperation(bundle: ReattachmentBundle): Promise<OperationInspection> {
  const { waveRoot, manifest, record } = await resolveOperation(bundle);
  const ownership = operationOwnershipStatus(record);
  const waveOwnership = await inspectWaveOwner(waveRoot);
  const landingRecoveryManifests = await inspectLandingRecoveryManifests(waveRoot);
  const activeLandingRecovery = landingRecoveryManifests.some((recovery) =>
    recovery.state === "in_progress" || recovery.state === "recovery_required" || !recovery.verified);
  const legacyTerminalWave = !waveOwnership.lease && ["completed", "aborted"].includes(manifest.phase);
  const waveProcessAlive = waveOwnership.processAlive && !legacyTerminalWave;
  const activeState = ["running", "compacting", "retrying"].includes(record.state);
  const checkpointVerification = record.checkpoint
    ? await verifyRecoveryCheckpoint(waveRoot, record).then(
        () => ({ status: "verified" as const }),
        (error) => ({ status: "invalid" as const, error: error instanceof Error ? error.message : String(error) }),
      )
    : { status: "missing" as const };
  const canReconcileAbandonedWriter = activeState
    && Boolean(record.owner)
    && (ownership.status === "dead" || ownership.status === "released");
  const canContinue = !ownership.processAlive
    && !waveProcessAlive
    && (!activeLandingRecovery || landingRecoveryManifests.every((recovery) => recovery.verified))
    && record.state !== "failed_critical"
    && (checkpointVerification.status === "verified" || canReconcileAbandonedWriter);
  const sourceDisposition = activeLandingRecovery || manifest.landingStatus === "recovery_required"
    ? "recovery_required"
    : manifest.landingStatus === "landed"
    ? "landed"
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
      landing: manifest.landingStatus || landingRecoveryManifests.length > 0 ? {
        status: manifest.landingStatus,
        appliedPaths: manifest.landingAppliedPaths,
        alreadyAppliedPaths: manifest.landingAlreadyAppliedPaths,
        conflicts: manifest.landingConflicts,
        failedAtPath: manifest.landingFailedAtPath,
        failureReason: manifest.landingFailureReason,
        manifestPath: manifest.landingManifestPath,
        rollbackError: manifest.landingRollbackError,
        headDrift: manifest.landingHeadDrift,
        recoveryManifests: landingRecoveryManifests,
      } : undefined,
      tasks: manifest.tasks,
      task: manifest.tasks.find((task) => task.taskId === record.taskId),
    },
    live: ownership.processAlive || waveProcessAlive,
    checkpointVerification,
    steerable: false,
    safeActions: canContinue ? ["continue", "inspect"] : ["inspect"],
    blockedActions: [
      { action: "steer", reason: ownership.status === "live"
        ? "The executor is live, but foreground adapters do not yet accept steering."
        : "The current executor adapters are foreground-only and this operation has no live turn." },
      ...(!canContinue ? [{ action: "continue", reason: waveProcessAlive
        ? waveOwnership.message
        : ownership.processAlive
          ? ownership.message
          : activeLandingRecovery && landingRecoveryManifests.some((recovery) => !recovery.verified)
            ? "A landing recovery manifest is unverified; source mutation is blocked."
          : checkpointVerification.status === "invalid"
            ? `Recovery checkpoint verification failed: ${checkpointVerification.error}`
          : `Operation state ${record.state} does not currently permit an automatic continuation.` }] : []),
    ],
  };
}

export async function reattachmentBundlesForWave(inputWaveRoot: string): Promise<ReattachmentBundle[]> {
  const waveRoot = await fs.realpath(resolve(inputWaveRoot));
  if (!basename(waveRoot).startsWith("wave-")) throw new Error("Invalid wave root.");
  const manifest = JSON.parse(await readFile(join(waveRoot, "wave-manifest.json"), "utf8")) as WaveManifest;
  if (manifest.version !== 1 || typeof manifest.waveId !== "string") throw new Error("Invalid wave manifest.");
  const bundles: ReattachmentBundle[] = [];
  for (const task of manifest.tasks) {
    const artifactDir = join(waveRoot, "artifacts", task.taskId);
    const path = operationRecordPath(artifactDir);
    const record = await readOperationRecord(path).catch(() => undefined);
    if (!record) continue;
    if (record.waveId !== manifest.waveId || record.taskId !== task.taskId || record.operationId !== `${manifest.waveId}/${task.taskId}`) {
      throw new Error(`Operation identity mismatch for ${task.taskId}.`);
    }
    if (await fs.realpath(record.artifactDir) !== await fs.realpath(artifactDir)) {
      throw new Error(`Operation artifact ownership mismatch for ${task.taskId}.`);
    }
    bundles.push(createReattachmentBundle(record, waveRoot));
  }
  return bundles;
}

export async function inspectWaveRoot(inputWaveRoot: string): Promise<{
  waveRoot: string;
  manifest: WaveManifest;
  ownership: Awaited<ReturnType<typeof inspectWaveOwner>>;
  bundles: ReattachmentBundle[];
  landingRecoveryManifests: LandingRecoveryManifestInspection[];
  recovery: {
    sourceWorkspaceUnchanged: boolean | "unknown";
    unfinishedTasks: Array<{ taskId: string; status: string; task?: WaveWorkerTask }>;
    guidance: string;
  };
}> {
  const waveRoot = await fs.realpath(resolve(inputWaveRoot));
  if (!basename(waveRoot).startsWith("wave-")) throw new Error("Invalid wave root.");
  const manifest = JSON.parse(await readFile(join(waveRoot, "wave-manifest.json"), "utf8")) as WaveManifest;
  if (manifest.version !== 1 || typeof manifest.waveId !== "string") throw new Error("Invalid wave manifest.");
  const ownership = await inspectWaveOwner(waveRoot);
  const legacyTerminalWave = !ownership.lease && ["completed", "aborted"].includes(manifest.phase);
  const controllerMayBeActive = ownership.processAlive && !legacyTerminalWave;
  const bundles = await reattachmentBundlesForWave(waveRoot);
  const landingRecoveryManifests = await inspectLandingRecoveryManifests(waveRoot);
  const sourceUncertain = manifest.landingStatus === "recovery_required"
    || landingRecoveryManifests.some((recovery) => recovery.state === "in_progress" || recovery.state === "recovery_required" || !recovery.verified);
  const unfinishedTasks = manifest.tasks
    .filter((task) => !["accepted", "accepted_with_warnings", "completed_unreviewed", "no_changes"].includes(task.status))
    .map((task) => ({ taskId: task.taskId, status: task.status, task: task.task }));
  return {
    waveRoot,
    manifest,
    ownership,
    bundles,
    landingRecoveryManifests,
    recovery: {
      sourceWorkspaceUnchanged: sourceUncertain ? "unknown" : manifest.landingStatus === "landed" ? false : true,
      unfinishedTasks,
      guidance: controllerMayBeActive
        ? "The existing wave controller may still be active; do not start another writer."
        : sourceUncertain
          ? "Resolve the authenticated landing recovery manifest before changing the source workspace."
          : unfinishedTasks.length > 0
            ? "Use the retained task definitions and operation bundles to inspect or deliberately re-dispatch only unfinished work."
            : "All durable task results are available for inspection.",
    },
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
  executorAssignment?: ExecutorPoolLease;
  executorPool?: ExecutorPoolScheduler;
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
  takeDeferredSteering?: () => Promise<Array<{ instruction: string; instructionId: string }>>;
  onLandingConflict?: (input: { capture: Awaited<ReturnType<typeof readWaveCaptureRecord>>; plan: LandingPlan }) => void | Promise<void>;
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
  const ownership = operationOwnershipStatus(record);
  const waveOwnership = await inspectWaveOwner(waveRoot);
  const legacyTerminalWave = !waveOwnership.lease && ["completed", "aborted"].includes(manifest.phase);
  if (waveOwnership.processAlive && !legacyTerminalWave) {
    throw new Error(`Wave still has a live or uncertain controller. ${waveOwnership.message} Inspect again before continuing.`);
  }
  const continuationOwner = await acquireWaveOwner(waveRoot, manifest.waveId);
  let continuationHeartbeatTail: Promise<void> = Promise.resolve();
  const continuationHeartbeat = setInterval(() => {
    continuationHeartbeatTail = continuationHeartbeatTail
      .then(() => heartbeatWaveOwner(waveRoot, continuationOwner))
      .catch(() => undefined);
  }, 5_000);
  continuationHeartbeat.unref?.();
  let continuationOwnerReleased = false;
  const releaseContinuationOwner = async () => {
    if (continuationOwnerReleased) return;
    continuationOwnerReleased = true;
    clearInterval(continuationHeartbeat);
    await continuationHeartbeatTail;
    await releaseWaveOwner(waveRoot, continuationOwner);
  };
  try {
  const landingRecoveryManifests = await inspectLandingRecoveryManifests(waveRoot);
  for (const recovery of landingRecoveryManifests) {
    if (recovery.state !== "in_progress" && recovery.state !== "recovery_required") continue;
    if (!recovery.verified) {
      throw new Error(`Landing recovery manifest is not verified; source mutation remains blocked: ${recovery.manifestPath} (${recovery.error ?? "unknown verification error"})`);
    }
    const result = await recoverLandingManifest(recovery.manifestPath);
    if (result.status !== "recovered" && result.status !== "terminal") {
      throw new Error(`Landing recovery could not complete automatically: ${JSON.stringify(result)}`);
    }
  }
  if (ownership.processAlive) {
    throw new Error(`Operation still has a live or uncertain writer. ${ownership.message} Inspect again before continuing.`);
  }
  if (record.state === "failed_critical") {
    throw new Error(`Operation state ${record.state} cannot be continued automatically.`);
  }
  if (record.state === "running" || record.state === "compacting" || record.state === "retrying") {
    if (!record.owner) {
      throw new Error("Operation predates durable writer ownership and may still have an unrecorded writer; automatic continuation is blocked.");
    }
    record = await reconcileAbandonedOperation(record, waveRoot);
  }
  const capture = await readWaveCaptureRecord(waveRoot);
  if (!record.checkpoint?.verified) {
    throw new Error("Operation cannot continue because its verified recovery checkpoint is missing.");
  }
  try {
    await verifyRecoveryCheckpoint(waveRoot, record, capture);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.state = "failed_critical";
    record.incidents.push(createIncident({
      attempt: Math.max(1, record.attempts.length),
      generation: record.generation,
      cause: "workspace_error",
      stage: "checkpoint_verification",
      message,
      retryable: false,
      terminalCode: "recovery_state_corrupt_or_unverifiable",
    }));
    await writeOperationRecord(record);
    throw new Error(`Recovery checkpoint verification failed; automatic continuation is blocked: ${message}`);
  }
  const previouslyLanded = record.state === "landed" || manifest.landingStatus === "landed";
  const continuationLandingBase = previouslyLanded ? record.checkpoint.commitSha : undefined;

  const task = await readTask(record.artifactDir);
  const steeringEvidence = createTaskInstructionEvidenceRecorder(task, record.artifactDir);
  const publishLiveControl = (control: ExecutorLiveControl | undefined): void => {
    input.onLiveControl?.(steeringEvidence.wrap(control));
  };
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
    adapter: record.adapter ?? record.session?.adapter ?? "unknown",
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
  const continuationPool = input.executorPool ?? new ExecutorPoolScheduler(resolvedExecutorPool(input.config));
  let failoverLease: ExecutorPoolLease | undefined;
  const acquireFailover = async (currentAssignment: ExecutorPoolAssignment) => {
    failoverLease?.release();
    failoverLease = await continuationPool.acquireAfterRoute(
      currentAssignment,
      () => resolvedExecutorPool(input.config),
      input.signal,
    );
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
    executorAssignment: input.executorAssignment,
    acquireFailover,
    onLiveControl: publishLiveControl,
    onUpdate: (update) => input.onUpdate?.(update.message),
    });
    if (continued.status === "completed") {
      await steeringEvidence.record(input.instructions, input.instructionId, "continue");
    }
    await steeringEvidence.flush();
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
      executorAssignment: input.executorAssignment,
      acquireFailover,
      onLiveControl: publishLiveControl,
      takeDeferredSteering: input.takeDeferredSteering,
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
    await releaseContinuationOwner();
    return { inspection: await inspectOperation(createReattachmentBundle(record, waveRoot)), lifecycle };
  }

  const integration = await retryOperationStage<WaveIntegrationResult>(
    record,
    input.config,
    "integrating",
    "integration_error",
    async () => {
      input.onUpdate?.("preparing the accepted continuation for independent landing");
      const integratedRef = await pinCommit(
        continuationCapture,
        lifecycle.acceptedCommitSha!,
        { type: "integration" },
        input.signal,
      );
      return {
        status: "integrated",
        integratedRef,
        finalCommitSha: lifecycle.acceptedCommitSha!,
        workerMappings: [{
          taskId: lifecycle.taskId,
          originalCommitSha: lifecycle.acceptedCommitSha!,
          integratedCommitSha: lifecycle.acceptedCommitSha!,
          order: 1,
        }],
        validationStatus: "not_run",
      };
    },
    input.signal,
  );
  if (integration.status !== "integrated" || !integration.finalCommitSha) {
    record.state = "paused_recoverable";
    await writeOperationRecord(record);
    await publishContinuationManifest(join(waveRoot, "wave-manifest.json"), manifest, lifecycle, integration);
    await releaseContinuationOwner();
    return { inspection: await inspectOperation(createReattachmentBundle(record, waveRoot)), lifecycle, integration };
  }
  const landing = await retryOperationStage(
    record,
    input.config,
    "landing",
    "landing_error",
    async () => {
      input.onUpdate?.("landing the accepted continuation into the source workspace");
      const landingCapture = continuationLandingBase
        ? { ...continuationCapture, baseCommit: continuationLandingBase }
        : continuationCapture;
      const releaseSource = await sourceMutationCoordinator.acquire(capture.discovery.captureRoot, input.signal);
      try {
        const plan = await planWaveLanding(landingCapture, integration.finalCommitSha, capture.discovery.captureRoot, input.signal);
        if (plan.conflicts.length > 0) await input.onLandingConflict?.({ capture: landingCapture, plan });
        return executeWaveLanding(plan, landingCapture, input.signal);
      } finally {
        releaseSource();
      }
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
  await releaseContinuationOwner();
  return {
    inspection: await inspectOperation(createReattachmentBundle(record, waveRoot)),
    lifecycle,
    integration,
    landing,
  };
  } finally {
    await releaseContinuationOwner();
  }
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

async function verifyRecoveryCheckpoint(
  waveRoot: string,
  record: OperationRecord,
  knownCapture?: Awaited<ReturnType<typeof readWaveCaptureRecord>>,
): Promise<void> {
  const checkpoint = record.checkpoint;
  if (!checkpoint?.verified) throw new Error("Recovery checkpoint is missing or is not marked verified.");
  const capture = knownCapture ?? await readWaveCaptureRecord(waveRoot);
  const objectType = await gitRead(["cat-file", "-t", checkpoint.commitSha], capture.repositoryPath);
  if (objectType !== "commit") throw new Error(`Recovery object ${checkpoint.commitSha} is not a commit.`);
  const treeSha = await gitRead(["rev-parse", `${checkpoint.commitSha}^{tree}`], capture.repositoryPath);
  if (treeSha !== checkpoint.treeSha) {
    throw new Error(`Recovery checkpoint tree mismatch: recorded ${checkpoint.treeSha}, actual ${treeSha}.`);
  }
  if (!checkpoint.ref.startsWith("refs/pi-review-gate/waves/")) {
    throw new Error(`Recovery checkpoint ref is outside the protected namespace: ${checkpoint.ref}.`);
  }
  const pinnedCommit = await gitRead(["rev-parse", "--verify", checkpoint.ref], capture.repositoryPath);
  if (pinnedCommit !== checkpoint.commitSha) {
    throw new Error(`Recovery checkpoint ref mismatch: ${checkpoint.ref} points to ${pinnedCommit}, expected ${checkpoint.commitSha}.`);
  }
  const parents = (await gitRead(["show", "-s", "--format=%P", checkpoint.commitSha], capture.repositoryPath)).split(/\s+/).filter(Boolean);
  if (parents.length !== 1 || parents[0] !== capture.baseCommit) {
    throw new Error(`Recovery checkpoint parent mismatch: expected sole parent ${capture.baseCommit}.`);
  }
  const changedPaths = (await gitReadRaw(["diff", "--name-only", "-z", capture.baseCommit, checkpoint.commitSha], capture.repositoryPath))
    .split("\0")
    .filter(Boolean)
    .sort();
  const recordedPaths = [...checkpoint.changedPaths].sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(recordedPaths)) {
    throw new Error("Recovery checkpoint changed-path inventory does not match the pinned commit.");
  }
  if (checkpoint.differsFromBase !== (changedPaths.length > 0)) {
    throw new Error("Recovery checkpoint differs-from-base flag does not match its content.");
  }
}

async function gitRead(args: string[], cwd: string): Promise<string> {
  return (await gitReadRaw(args, cwd)).trim();
}

async function gitReadRaw(args: string[], cwd: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    timeout: 30_000,
  });
  return stdout;
}

async function reconcileAbandonedOperation(record: OperationRecord, waveRoot: string): Promise<OperationRecord> {
  const capture = await readWaveCaptureRecord(waveRoot);
  const worktree = await fs.lstat(record.worktreeRoot).catch(() => undefined);
  if (!worktree?.isDirectory() || worktree.isSymbolicLink()) {
    if (!record.checkpoint?.verified) {
      throw new Error("The abandoned executor worktree is missing and no verified checkpoint can recover it.");
    }
    record.incidents.push(createIncident({
      attempt: Math.max(1, record.attempts.length),
      generation: record.generation,
      cause: "interruption",
      stage: "application_restart",
      message: "The prior writer ended without releasing the operation; its worktree was already cleaned, so recovery will recreate it from the last verified checkpoint.",
      retryable: true,
    }));
    releaseOperationOwner(record);
    record.state = "paused_recoverable";
    await writeOperationRecord(record);
    return record;
  }
  const candidate = await normalizeCandidate(
    capture,
    record.worktreeRoot,
    record.taskId,
    record.title,
    record.checkpoint ? { commitSha: record.checkpoint.commitSha } : undefined,
  );
  const changed = await promisify(execFile)("git", [
    "diff", "--name-only", "-z", capture.baseCommit, candidate.commitSha,
  ], {
    cwd: capture.repositoryPath,
    env: { ...process.env, ...GIT_ENV },
    timeout: 30_000,
  });
  record.checkpoint = {
    checkpointId: `${record.operationId}:restart:${record.revision + 1}`,
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    ref: await pinRecoveryCandidate(capture, record.taskId, candidate),
    differsFromBase: candidate.differsFromBase,
    createdAt: new Date().toISOString(),
    verified: true,
    changedPaths: changed.stdout.split("\0").filter(Boolean),
  };
  record.incidents.push(createIncident({
    attempt: Math.max(1, record.attempts.length),
    generation: record.generation,
    cause: "interruption",
    stage: "application_restart",
    message: "The prior application/executor writer ended without releasing the operation; its retained worktree was reconciled into a verified checkpoint.",
    retryable: true,
  }));
  releaseOperationOwner(record);
  record.state = "paused_recoverable";
  await writeOperationRecord(record);
  return record;
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
