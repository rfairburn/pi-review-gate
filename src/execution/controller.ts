import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSnapshot, compareSnapshots, type WorkspaceSnapshot } from "../capture";
import { createCorrectionFeedbackMarker, isRepeatedNoProgressFeedback } from "../correction-feedback";
import { automaticReviewEnabled, configWithReviewers, resolveReviewers, type ReviewGateConfig } from "../config";
import { reviewerDisplayLabel, runReview, type ReviewRunOutput } from "../review";
import {
  activeExchangeBaseline,
  beginAgentRun,
  buildRequestContext,
  checkpointReviewWindow,
  createState,
  getCorrectionAttemptCount,
  recordReviewerFeedbackAndArmExchange,
  rememberUserRequest,
  setReviewWindowBaseline,
  type ReviewGateState,
} from "../state";
import { createReviewTransmissionMessage, type ReviewTransmissionAction } from "../transmission";
import type { TokenUsage } from "../usage";
import {
  buildReviewReportFromHistory,
  type SubtaskReviewReport,
} from "../review-report";
import { createExecutorAdapter } from "./adapters/factory";
import type { ExecutorSession, ExecutorTurn, SubtaskProgressPhase, SubtaskProgressUpdate } from "./types";

export interface ExecuteSubtaskInput {
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  relevantContext?: string;
}

export type SubtaskOutcomeKind =
  | "accepted"
  | "accepted_with_warnings"
  | "completed_unreviewed"
  | "blocked"
  | "deferred"
  | "review_error"
  | "executor_error"
  | "cancelled";

export interface SubtaskPacket {
  subtaskId: string;
  title: string;
  kind: SubtaskOutcomeKind;
  summary: string;
  finalSnapshot: string;
  changedFiles: string[];
  reviewStatus: "accepted" | "accepted_with_warnings" | "not_run" | "failed";
  reviewDisabledReason?: "no_enabled_reviewers" | "review_master_disabled" | "no_reviewable_changes";
  reviewCycles: number;
  executorAdapter: string;
  executorModel?: string;
  usage?: TokenUsage;
  bundleDir?: string;
  error?: string;
  reviewReport?: SubtaskReviewReport;
}

export interface ExecuteSubtaskControllerInput {
  task: ExecuteSubtaskInput;
  cwd: string;
  config: ReviewGateConfig;
  parentState: ReviewGateState;
  scopedModels?: string[];
  signal?: AbortSignal;
  notify?: (message: string) => void | Promise<void>;
  onUpdate?: (update: SubtaskProgressUpdate) => void;
  appendJournal?: (entry: Record<string, unknown>) => void;
}

export async function executeSubtask(input: ExecuteSubtaskControllerInput): Promise<SubtaskPacket> {
  const subtaskId = randomUUID();
  const parentBaseline = activeExchangeBaseline(input.parentState);
  if (!parentBaseline) {
    return failurePacket(input, subtaskId, "blocked", "No clean parent ownership baseline is available.", "missing_parent_baseline");
  }
  const preflight = await snapshot(input.cwd, input.config, input.signal);
  const adoptedParentChanges = compareSnapshots(parentBaseline, preflight);
  const adoptedParentChangedFiles = adoptedParentChanges.map((change) => change.path);

  const reviewerResolution = resolveReviewers(input.config, input.scopedModels);
  const reviewerSelectionIssues = [
    reviewerResolution.unknownIds.length > 0
      ? `unknown enabled reviewer ids: ${reviewerResolution.unknownIds.join(", ")}`
      : "",
    reviewerResolution.duplicateEnabledIds.length > 0
      ? `duplicate enabled reviewer ids: ${reviewerResolution.duplicateEnabledIds.join(", ")}`
      : "",
  ].filter(Boolean);
  if (input.config.enabled && reviewerSelectionIssues.length > 0) {
    return failurePacket(
      input,
      subtaskId,
      "blocked",
      `Reviewer selection is invalid: ${reviewerSelectionIssues.join("; ")}. Repair it with /review-settings before delegating.`,
      "invalid_reviewer_selection",
      preflight,
    );
  }

  const adapter = createExecutorAdapter(input.config);
  const artifactDir = await mkdtemp(join(tmpdir(), "pi-review-subtask-"));
  reportProgress(input, subtaskId, {
    phase: "starting",
    message: "subtask workspace captured; starting executor",
    artifactDir,
    adapter: adapter.kind,
    model: adapter.model,
  });
  await mkdir(join(artifactDir, "executor"), { recursive: true });
  await writeFile(join(artifactDir, "subtask.json"), JSON.stringify({
    version: 1,
    subtaskId,
    task: input.task,
    cwd: input.cwd,
    adapter: adapter.kind,
    model: adapter.model,
    adoptedParentChanges: adoptedParentChanges.map((change) => ({
      path: change.path,
      status: change.status,
    })),
    startedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  journal(input, subtaskId, "started", { adapter: adapter.kind, model: adapter.model });

  const childState = createState();
  rememberUserRequest(childState, renderTaskRequest(input.task, adoptedParentChangedFiles));
  beginAgentRun(childState);
  setReviewWindowBaseline(childState, parentBaseline);
  const childWindow = childState.reviewWindow!;
  childWindow.bundleDir = artifactDir;
  const reviewActive = automaticReviewEnabled(input.config, input.scopedModels);
  const frozenConfig = configWithReviewers(input.config, reviewerResolution.reviewers, reviewActive);
  let session: ExecutorSession | undefined;
  let turnNumber = 0;
  let lastTurn: ExecutorTurn | undefined;

  const invoke = async (prompt: string, phase: SubtaskProgressPhase): Promise<ExecutorTurn | SubtaskPacket> => {
    turnNumber += 1;
    reportProgress(input, subtaskId, {
      phase,
      message: `executor turn ${turnNumber} running`,
      artifactDir,
      adapter: adapter.kind,
      model: adapter.model,
      executorTurn: turnNumber,
    });
    let turn: ExecutorTurn;
    try {
      turn = await adapter.run({
        cwd: input.cwd,
        prompt,
        artifactDir,
        turn: turnNumber,
        signal: input.signal,
        session,
        onUpdate: (message) => reportProgress(input, subtaskId, {
          phase,
          message,
          artifactDir,
          adapter: adapter.kind,
          model: adapter.model,
          executorTurn: turnNumber,
        }),
      });
    } catch (error) {
      return finishFailure(
        input,
        subtaskId,
        artifactDir,
        input.signal?.aborted ? "cancelled" : "executor_error",
        error instanceof Error ? error.message : "Executor process failed.",
        childState,
        parentBaseline,
        adapter.kind,
        adapter.model,
      );
    }
    session = turn.session;
    lastTurn = turn;
    if (turn.text.trim()) {
      childWindow.evidence.finalAssistantSummaries.push(turn.text.slice(0, 4000));
    }
    if (turn.aborted || input.signal?.aborted) {
      return finishFailure(input, subtaskId, artifactDir, "cancelled", "Executor was cancelled.", childState, parentBaseline, adapter.kind, adapter.model);
    }
    if (turn.timedOut) {
      return finishFailure(input, subtaskId, artifactDir, "executor_error", "Executor timed out.", childState, parentBaseline, adapter.kind, adapter.model);
    }
    if (turn.failure) {
      return finishFailure(
        input,
        subtaskId,
        artifactDir,
        "executor_error",
        `Executor ${turn.failure.category} error: ${turn.failure.message}`,
        childState,
        parentBaseline,
        adapter.kind,
        adapter.model,
      );
    }
    if (turn.code !== 0) {
      return finishFailure(input, subtaskId, artifactDir, "executor_error", `Executor exited with status ${turn.code}.`, childState, parentBaseline, adapter.kind, adapter.model);
    }
    if (!turn.text.trim()) {
      return finishFailure(input, subtaskId, artifactDir, "executor_error", "Executor did not produce a usable final response.", childState, parentBaseline, adapter.kind, adapter.model);
    }
    return turn;
  };

  const initial = await invoke(buildInitialExecutorPrompt(input.task, adoptedParentChangedFiles), "executing");
  if (isPacket(initial)) return initial;

  if (!reviewActive) {
    const reason = input.config.enabled ? "no_enabled_reviewers" : "review_master_disabled";
    return finishSuccess({
      input,
      subtaskId,
      artifactDir,
      kind: "completed_unreviewed",
      summary: initial.text,
      before: parentBaseline,
      childState,
      adapterKind: adapter.kind,
      adapterModel: adapter.model,
      usage: initial.usage,
      reviewStatus: "not_run",
      reviewDisabledReason: reason,
      reviewCycles: 0,
    });
  }

  while (true) {
    const reviewCycle = childWindow.nextReviewSequence;
    const reviewerLabels = reviewerResolution.reviewers.map(reviewerDisplayLabel);
    reportProgress(input, subtaskId, {
      phase: "reviewing",
      message: `review cycle ${reviewCycle} running with ${reviewerLabels.join(", ")}`,
      artifactDir,
      adapter: adapter.kind,
      model: adapter.model,
      executorTurn: turnNumber,
      reviewCycle,
      reviewers: reviewerLabels,
    });
    journal(input, subtaskId, "reviewing", { turn: turnNumber });
    const output = await runReview({
      cwd: input.cwd,
      request: buildRequestContext(childState, childState.reviewWindow, { priorFeedback: "latest" }),
      before: childWindow.baseline!,
      config: frozenConfig,
      evidence: childWindow.evidence,
      correctionAttemptCount: getCorrectionAttemptCount(childWindow),
      actingUsage: lastTurn?.usage,
      window: childWindow,
      signal: input.signal,
      notify: input.notify,
      onUpdate: (message) => reportProgress(input, subtaskId, {
        phase: "reviewing",
        message,
        artifactDir,
        adapter: adapter.kind,
        model: adapter.model,
        executorTurn: turnNumber,
        reviewCycle,
        reviewers: reviewerLabels,
      }),
    });

    if (!output.changed) {
      if (output.noReviewReason === "unchanged_review_response") {
        return finishSuccess({
          input,
          subtaskId,
          artifactDir,
          kind: "accepted",
          summary: lastTurn!.text,
          before: parentBaseline,
          childState,
          adapterKind: adapter.kind,
          adapterModel: adapter.model,
          usage: lastTurn?.usage,
          reviewStatus: "accepted",
          reviewCycles: childWindow.nextReviewSequence - 1,
        });
      }
      return finishSuccess({
        input,
        subtaskId,
        artifactDir,
        kind: "completed_unreviewed",
        summary: lastTurn!.text,
        before: parentBaseline,
        childState,
        adapterKind: adapter.kind,
        adapterModel: adapter.model,
        usage: lastTurn?.usage,
        reviewStatus: "not_run",
        reviewDisabledReason: "no_reviewable_changes",
        reviewCycles: 0,
      });
    }

    if (output.result?.error === "aborted" || input.signal?.aborted) {
      return finishFailure(input, subtaskId, artifactDir, "cancelled", "Review was cancelled.", childState, parentBaseline, adapter.kind, adapter.model);
    }
    if (!output.result || !output.reviewedSnapshot) {
      return finishFailure(input, subtaskId, artifactDir, "review_error", output.error ?? "Review did not produce a decision.", childState, parentBaseline, adapter.kind, adapter.model);
    }

    if (output.result.verdict === "pass") {
      const message = await transmit(childState, output, "sent_for_observation", "passed");
      journal(input, subtaskId, "passed_pending_response", { reviewSequence: output.reviewSequence });
      const response = await invoke(message, "confirming");
      if (isPacket(response)) return response;
      continue;
    }

    if (output.result.verdict === "needs_changes") {
      if (isRepeatedNoProgressFeedback({
        previous: childWindow.lastCorrectionFeedback,
        result: output.result,
        changes: output.changes,
        evidenceEventCount: childWindow.evidence.events.length,
      })) {
        return finishFailure(input, subtaskId, artifactDir, "deferred", "Reviewer repeated the same blocking feedback without new correction evidence.", childState, parentBaseline, adapter.kind, adapter.model, output);
      }
      childWindow.lastCorrectionFeedback = createCorrectionFeedbackMarker({
        result: output.result,
        changes: output.changes,
        evidenceEventCount: childWindow.evidence.events.length,
      });
      if (childWindow.correctionCycles >= frozenConfig.maxCorrectionCycles) {
        return finishFailure(input, subtaskId, artifactDir, "deferred", "Automatic correction cap reached.", childState, parentBaseline, adapter.kind, adapter.model, output);
      }
      childWindow.correctionCycles += 1;
      const message = await transmit(childState, output, "sent_for_correction", "correction_required");
      journal(input, subtaskId, "correction_required", { reviewSequence: output.reviewSequence });
      const correction = await invoke(message, "correcting");
      if (isPacket(correction)) return correction;
      continue;
    }

    return finishFailure(input, subtaskId, artifactDir, "review_error", output.result.summary, childState, parentBaseline, adapter.kind, adapter.model, output);
  }
}

async function transmit(
  state: ReviewGateState,
  output: ReviewRunOutput,
  disposition: "sent_for_correction" | "sent_for_observation",
  action: ReviewTransmissionAction,
): Promise<string> {
  if (!output.result || !output.reviewerResults || !output.invocationDir || !output.bundleDir || output.reviewSequence === undefined || !output.reviewedSnapshot) {
    throw new Error("cannot transmit an incomplete executor review");
  }
  const message = await createReviewTransmissionMessage({
    invocationDir: output.invocationDir,
    reviewSequence: output.reviewSequence,
    gateVerdict: output.result.verdict,
    reviewerResults: output.reviewerResults,
    reviewerDisplayLabels: output.reviewerDisplayLabels,
    bundleDir: output.bundleDir,
    action,
  });
  recordReviewerFeedbackAndArmExchange(state, {
    result: output.result,
    reviewerResults: output.reviewerResults,
    reviewSequence: output.reviewSequence,
    source: "automatic",
    disposition,
    reviewedSnapshot: output.reviewedSnapshot,
  });
  return message;
}

async function finishSuccess(input: {
  input: ExecuteSubtaskControllerInput;
  subtaskId: string;
  artifactDir: string;
  kind: "accepted" | "completed_unreviewed";
  summary: string;
  before: WorkspaceSnapshot;
  childState: ReviewGateState;
  adapterKind: string;
  adapterModel?: string;
  usage?: TokenUsage;
  reviewStatus: "accepted" | "not_run";
  reviewDisabledReason?: SubtaskPacket["reviewDisabledReason"];
  reviewCycles: number;
}): Promise<SubtaskPacket> {
  const reviewers = resolveReviewers(input.input.config, input.input.scopedModels).reviewers;
  const reviewReport = buildReviewReportFromHistory({
    history: input.childState.reviewWindow?.reviewHistory ?? [],
    reviewers,
    artifactDir: input.artifactDir,
  });
  const kind: "accepted" | "accepted_with_warnings" | "completed_unreviewed" =
    input.kind === "accepted" && reviewReport?.aggregate === "pass_with_warnings"
      ? "accepted_with_warnings"
      : input.kind;
  const reviewStatus = kind === "accepted_with_warnings" ? "accepted_with_warnings" : input.reviewStatus;
  reportProgress(input.input, input.subtaskId, {
    phase: "completing",
    message: kind === "accepted_with_warnings"
      ? "subtask accepted with reviewer infrastructure warnings"
      : kind === "accepted" ? "subtask accepted" : "subtask completed without review",
    artifactDir: input.artifactDir,
    adapter: input.adapterKind,
    model: input.adapterModel,
  });
  const after = await snapshot(input.input.cwd, input.input.config, input.input.signal);
  checkpointReviewWindow(input.input.parentState, after);
  const retained = input.input.config.retainBundles === "always"
    || (input.input.config.retainBundles === "on-failure" && reviewReport?.aggregate === "pass_with_warnings");
  if (reviewReport && !retained) reviewReport.artifactDir = undefined;
  const packet: SubtaskPacket = {
    subtaskId: input.subtaskId,
    title: input.input.task.title,
    kind,
    summary: input.summary,
    finalSnapshot: snapshotDigest(after),
    changedFiles: compareSnapshots(input.before, after).map((change) => change.path),
    reviewStatus,
    reviewDisabledReason: input.reviewDisabledReason,
    reviewCycles: input.reviewCycles,
    executorAdapter: input.adapterKind,
    executorModel: input.adapterModel,
    usage: input.usage,
    bundleDir: retained ? input.artifactDir : undefined,
    reviewReport,
  };
  await writeFile(join(input.artifactDir, "completion.json"), JSON.stringify(packet, null, 2), "utf8");
  journal(input.input, input.subtaskId, kind, { reviewStatus });
  if (!retained) {
    await rm(input.artifactDir, { recursive: true, force: true });
  }
  return packet;
}

async function finishFailure(
  input: ExecuteSubtaskControllerInput,
  subtaskId: string,
  artifactDir: string,
  kind: Exclude<SubtaskOutcomeKind, "accepted" | "accepted_with_warnings" | "completed_unreviewed" | "blocked">,
  message: string,
  childState: ReviewGateState,
  before: WorkspaceSnapshot,
  adapterKind: string,
  adapterModel?: string,
  currentReviewOutput?: ReviewRunOutput,
): Promise<SubtaskPacket> {
  reportProgress(input, subtaskId, {
    phase: "completing",
    message,
    artifactDir,
    adapter: adapterKind,
    model: adapterModel,
  });
  const after = await snapshot(input.cwd, input.config, input.signal);
  const changedFiles = compareSnapshots(before, after).map((change) => change.path);
  const reviewReport = buildReviewReportFromHistory({
    history: childState.reviewWindow?.reviewHistory ?? [],
    reviewers: resolveReviewers(input.config, input.scopedModels).reviewers,
    artifactDir,
    currentOutput: currentReviewOutput,
  });
  const packet: SubtaskPacket = {
    subtaskId,
    title: input.task.title,
    kind,
    summary: message,
    finalSnapshot: snapshotDigest(after),
    changedFiles,
    reviewStatus: "failed",
    reviewCycles: childState.reviewWindow ? childState.reviewWindow.nextReviewSequence - 1 : 0,
    executorAdapter: adapterKind,
    executorModel: adapterModel,
    bundleDir: artifactDir,
    error: message,
    reviewReport,
  };
  await writeFile(join(artifactDir, "failure.json"), JSON.stringify(packet, null, 2), "utf8");
  journal(input, subtaskId, kind, { error: message });
  if (input.config.retainBundles === "never") {
    await rm(artifactDir, { recursive: true, force: true });
    packet.bundleDir = undefined;
    if (packet.reviewReport) packet.reviewReport.artifactDir = undefined;
  }
  return packet;
}

function failurePacket(
  input: ExecuteSubtaskControllerInput,
  subtaskId: string,
  kind: "blocked",
  message: string,
  error: string,
  snapshotValue?: WorkspaceSnapshot,
): SubtaskPacket {
  return {
    subtaskId,
    title: input.task.title,
    kind,
    summary: message,
    finalSnapshot: snapshotValue ? snapshotDigest(snapshotValue) : "unavailable",
    changedFiles: [],
    reviewStatus: "failed",
    reviewCycles: 0,
    executorAdapter: input.config.execution?.activeExecutor?.source ?? "none",
    error,
  };
}

function buildInitialExecutorPrompt(task: ExecuteSubtaskInput, adoptedParentChangedFiles: string[]): string {
  return [
    "You are the isolated implementation executor for one bounded phase.",
    "Work directly in the current workspace. Inspect the repository, implement the requested change, and run relevant verification.",
    ...(adoptedParentChangedFiles.length > 0
      ? [
        "The workspace includes changes made by the parent during its active exchange. Adopt these as seed work for this phase: inspect, preserve, complete, or correct them as needed. Do not revert them merely because you did not author them; they are part of the changes that will be reviewed.",
      ]
      : []),
    "Do not broaden the task, commit, push, or modify unrelated files.",
    "When finished, summarize changed files, verification performed, and remaining risks.",
    "",
    renderTaskRequest(task, adoptedParentChangedFiles),
  ].join("\n");
}

function renderTaskRequest(task: ExecuteSubtaskInput, adoptedParentChangedFiles: string[] = []): string {
  return [
    `Subtask: ${task.title}`,
    "",
    task.instructions,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...(task.relevantContext ? ["", "Relevant context:", task.relevantContext] : []),
    ...(adoptedParentChangedFiles.length > 0
      ? ["", "Changes adopted from the active parent exchange:", ...adoptedParentChangedFiles.map((path) => `- ${path}`)]
      : []),
  ].join("\n");
}

async function snapshot(
  cwd: string,
  config: ReviewGateConfig,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
  return createWorkspaceSnapshot(cwd, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
    signal,
  });
}

function isPacket(value: ExecutorTurn | SubtaskPacket): value is SubtaskPacket {
  return "kind" in value;
}

function snapshotDigest(value: WorkspaceSnapshot): string {
  const hash = createHash("sha256");
  for (const [path, file] of [...value.files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path);
    hash.update("\0");
    hash.update(file.sha256 ?? "missing");
    hash.update("\0");
    hash.update(file.entryType ?? "missing");
    hash.update("\0");
    hash.update(String(file.mode ?? 0));
    hash.update("\0");
    hash.update(file.linkTarget ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function journal(input: ExecuteSubtaskControllerInput, subtaskId: string, state: string, detail: Record<string, unknown>): void {
  input.appendJournal?.({
    version: 1,
    subtaskId,
    title: input.task.title,
    state,
    timestamp: new Date().toISOString(),
    ...detail,
  });
}

function reportProgress(
  input: ExecuteSubtaskControllerInput,
  subtaskId: string,
  update: SubtaskProgressUpdate,
): void {
  input.onUpdate?.({ subtaskId, ...update });
}
