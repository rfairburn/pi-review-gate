import { externalAgentCatalog, externalAgentSupportsExecution, resolvedExecutorPool, type ReviewGateConfig } from "../config";
import { activeExchangeBaseline, checkpointReviewWindow } from "../state";
import type { ReviewGateState } from "../state";
import { createWorkspaceSnapshot, type FileSnapshot, type WorkspaceSnapshot } from "../capture";
import { resolve } from "node:path";
import { scopedModelChoices } from "../settings/models";
import type { SubtaskReviewReport } from "../review-report";
import { executeWave, type WaveControllerInput, type WaveResult, type WaveProgressUpdate, type WaveTaskResult } from "./wave-controller";
import { WaveCaptureError } from "./wave-repository";
import type { WaveWorkerTask } from "./wave-worker";
import { continueOperation, inspectOperation, inspectWaveRoot, reattachmentBundlesForWave } from "./operation-actions";
import type { ReattachmentBundle } from "./operation-record";
import { redactSensitiveText, redactSensitiveValue } from "../redaction";
import type { ExecutionAssociationsSnapshot } from "../session-state";

const BATCH_TOOL_NAME = "execute_subtasks";

interface ExecutionToolManagerInput {
  pi: unknown;
  config: ReviewGateConfig;
  state: ReviewGateState;
  cwd: () => string;
  notify?: (message: string) => void | Promise<void>;
  onAssociationsChanged?: (associations: ExecutionAssociationsSnapshot) => void | Promise<void>;
}

type WaveFailureKind =
  | "capture_error"
  | "worker_failure"
  | "integration_conflict"
  | "integration_error"
  | "landing_conflict"
  | "landing_error"
  | "landing_rolled_back"
  | "landing_recovery_required"
  | "aborted"
  | "not_landed";

interface WaveRecoveryAction {
  action: "inspect" | "self_resolve" | "continue" | "start" | "manual_recovery";
  instruction: string;
  taskId?: string;
  bundle?: ReattachmentBundle;
}

interface WaveOutcomePacket {
  landed: boolean;
  failureKind?: WaveFailureKind;
  actionRequired: boolean;
  sourceWorkspace: {
    root?: string;
    disposition: "landed" | "unchanged" | "recovery_required";
    changedByWave: boolean | "unknown";
    message: string;
  };
  recovery: {
    automaticRetry: "not_needed" | "skipped_deterministic" | "exhausted" | "not_attempted" | "unsafe" | "not_applicable";
    summary: string;
    actions: WaveRecoveryAction[];
  };
}

export class ExecutionToolManager {
  private registered = false;
  private running = false;
  private associatedBundles: ReattachmentBundle[] = [];
  private associatedWaveRoots: string[] = [];

  constructor(private readonly input: ExecutionToolManagerInput) {}

  associations(): ExecutionAssociationsSnapshot {
    return {
      waveRoots: [...this.associatedWaveRoots],
      bundles: this.associatedBundles.map((bundle) => ({ ...bundle })),
    };
  }

  async restoreAssociations(value: ExecutionAssociationsSnapshot): Promise<void> {
    const requestedRoots = [...new Set(value.waveRoots)];
    const verifiedRoots: string[] = [];
    const bundles: ReattachmentBundle[] = [];
    for (const waveRoot of requestedRoots) {
      let discovered: ReattachmentBundle[];
      try {
        discovered = await reattachmentBundlesForWave(waveRoot);
      } catch (error) {
        await this.input.notify?.(`review gate: retained wave association could not be verified and was not reattached (${waveRoot}): ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      verifiedRoots.push(waveRoot);
      for (const bundle of discovered) {
        const index = bundles.findIndex((candidate) => candidate.operationId === bundle.operationId);
        if (index >= 0) bundles[index] = bundle;
        else bundles.push(bundle);
      }
    }
    this.associatedWaveRoots = verifiedRoots;
    this.associatedBundles = bundles;
  }

  private async rememberWaveRoot(waveRoot: string | undefined): Promise<void> {
    if (!waveRoot || this.associatedWaveRoots.includes(waveRoot)) return;
    this.associatedWaveRoots.push(waveRoot);
    await this.publishAssociations();
  }

  private async mergeAssociatedBundles(bundles: ReattachmentBundle[]): Promise<void> {
    for (const bundle of bundles) {
      const copy = { ...bundle };
      const index = this.associatedBundles.findIndex((candidate) => candidate.operationId === copy.operationId);
      if (index >= 0) this.associatedBundles[index] = copy;
      else this.associatedBundles.push(copy);
      if (!this.associatedWaveRoots.includes(bundle.waveRoot)) this.associatedWaveRoots.push(bundle.waveRoot);
    }
    await this.publishAssociations();
  }

  private async publishAssociations(): Promise<void> {
    try {
      await this.input.onAssociationsChanged?.(this.associations());
    } catch (error) {
      await this.input.notify?.(`review gate: failed to persist execution association: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  sync(): void {
    const pool = resolvedExecutorPool(this.input.config);
    const agents = externalAgentCatalog(this.input.config);
    const resolvable = pool.length > 0 && pool.every(({ selection }) =>
      selection.source === "little-coder"
      || agents.some((agent) => agent.id === selection.id && externalAgentSupportsExecution(agent)));
    if (resolvable && !this.registered) {
      this.register();
    }
    if (this.registered) {
      setToolActive(this.input.pi, BATCH_TOOL_NAME, Boolean(resolvable));
    }
  }

  private register(): void {
    if (!isRecord(this.input.pi) || typeof this.input.pi.registerTool !== "function") {
      return;
    }
    this.input.pi.registerTool({
      name: BATCH_TOOL_NAME,
      label: "Execute Subtasks",
      description: "Run one or more bounded implementation phases using isolated executors, then integrate and land the results.",
      promptSnippet: "Delegate one or more bounded implementation phases to the configured isolated executor",
      promptGuidelines: [
        "Use execute_subtasks for delegated implementation, including a single bounded phase.",
        "Submit independent tasks together; configured worker concurrency controls how many run at once.",
        "Each task runs in an isolated worktree with its own review lifecycle.",
        "Results are integrated in declared order and landed into the source workspace.",
        "Non-ignored untracked files are included in the captured snapshot; ignored files are excluded.",
        "Only a landed result means executor changes reached the source workspace.",
        "Treat every non-landed result as requiring an explicit recovery decision; do not report accepted task commits as source-workspace changes.",
        "For integration or landing conflicts, read the complete outcome and recovery packet, state that source is unchanged, then choose deliberately between resolving the combined change yourself and continuing a specific task by its reattachment bundle.",
        "For non-landed work, preserve the wave root and reattachment bundles; prefer inspect then continue over recreating recoverable task work.",
        "After an application restart, inspect restored wave roots and bundles before acting: a live or uncertain owner blocks another writer, while a confirmed-dead owner may be reconciled from its retained worktree or verified checkpoint.",
        "Inspect may target a waveRoot when no task bundle exists yet; retained wave manifests include the original task definitions needed to re-dispatch unfinished work deliberately.",
        "A recovery_required landing is the exception to the unchanged-source guarantee: inspect its recovery manifest before any further source edits.",
        "Steer is live-turn-only and never degrades into a continuation.",
      ],
      executionMode: "sequential",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["start", "continue", "steer", "inspect"],
            description: "Start new work, continue a prior operation, steer a live turn, or inspect operation state.",
          },
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "instructions", "acceptanceCriteria"],
              properties: {
                title: { type: "string", minLength: 1, description: "Short name for this subtask." },
                instructions: { type: "string", minLength: 1, description: "Complete bounded implementation instructions." },
                acceptanceCriteria: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                  description: "Observable requirements for completion.",
                },
                relevantContext: { type: "string", description: "Optional context not evident from the repository." },
              },
            },
            description: "Tasks to execute in parallel (1..16).",
          },
          maxWorkers: {
            type: "integer",
            minimum: 1,
            maximum: 16,
            description: "Maximum concurrent workers (1..16, default 4).",
          },
          integratePartial: {
            type: "boolean",
            description: "When true, integrate eligible workers despite failed ones (default false).",
          },
          bundle: {
            type: "object",
            additionalProperties: false,
            required: ["version", "operationId", "waveId", "taskId", "waveRoot", "expectedRevision"],
            properties: {
              version: { type: "integer", enum: [1] },
              operationId: { type: "string", minLength: 1 },
              waveId: { type: "string", minLength: 1 },
              taskId: { type: "string", minLength: 1 },
              waveRoot: { type: "string", minLength: 1 },
              expectedRevision: { type: "integer", minimum: 0 },
            },
            description: "Optional explicit reattachment bundle. Omit only when one associated operation is unambiguous.",
          },
          waveRoot: {
            type: "string",
            minLength: 1,
            description: "Optional explicit wave root for inspect, including waves that have not produced an operation bundle yet.",
          },
          instructions: { type: "string", minLength: 1, description: "Instructions for continue or steer." },
          instructionId: { type: "string", minLength: 1, description: "Optional idempotency key; defaults to the tool-call ID." },
        },
      },
      execute: async (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: ((result: unknown) => void) | undefined,
        ctx: unknown,
      ) => {
        if (this.running) {
          return batchToolResult({
            summary: "Another execution invocation is already active. Wait for it to finish.",
            isError: true,
          });
        }

        const operationInput = normalizeExecutionInput(params);
        if (!operationInput) {
          return batchToolResult({
            summary: "Invalid execute_subtasks parameters for the selected action.",
            isError: true,
          });
        }

        if (operationInput.action !== "start") {
          if (operationInput.action === "inspect" && operationInput.waveRoot) {
            try {
              return operationToolResult("inspect", await inspectWaveRoot(operationInput.waveRoot), false);
            } catch (error) {
              return operationToolResult("inspect", {
                summary: error instanceof Error ? error.message : String(error),
                waveRoot: operationInput.waveRoot,
              }, true);
            }
          }
          const bundle = operationInput.bundle ?? (this.associatedBundles.length === 1 ? this.associatedBundles[0] : undefined);
          if (!bundle) {
            if (operationInput.action === "inspect" && this.associatedWaveRoots.length === 1) {
              try {
                return operationToolResult("inspect", await inspectWaveRoot(this.associatedWaveRoots[0]), false);
              } catch (error) {
                return operationToolResult("inspect", {
                  summary: error instanceof Error ? error.message : String(error),
                  waveRoot: this.associatedWaveRoots[0],
                }, true);
              }
            }
            return batchToolResult({
              summary: this.associatedBundles.length > 1
                ? "More than one operation is associated with this orchestrator context; supply an explicit bundle."
                : "No associated operation is available; supply a reattachment bundle.",
              associatedBundles: this.associatedBundles.map((associated) => ({ ...associated })),
              associatedWaveRoots: [...this.associatedWaveRoots],
              isError: true,
            });
          }
          try {
            if (operationInput.action === "inspect") {
              const inspection = await inspectOperation(bundle);
              await this.mergeAssociatedBundles([inspection.bundle]);
              return operationToolResult("inspect", inspection, false);
            }
            if (operationInput.action === "steer") {
              const inspection = await inspectOperation(bundle);
              await this.mergeAssociatedBundles([inspection.bundle]);
              return operationToolResult("steer", {
                ...inspection,
                summary: "The target has no live steerable turn. Use continue to perform another turn.",
              }, true);
            }

            const scopedModels = (scopedModelChoices(ctx) ?? []).map((choice) => choice.model);
            const modelError = validateInternalModel(this.input.config, scopedModels);
            if (modelError) return batchToolResult({ summary: modelError, isError: true });
            const parentBaseline = activeExchangeBaseline(this.input.state);
            if (!parentBaseline) {
              return batchToolResult({
                summary: "No clean parent ownership baseline is available. Cannot continue and land recovered work.",
                isError: true,
              });
            }
            const beforeInspection = await inspectOperation(bundle);
            const continuationRoot = beforeInspection.manifest.sourceRoot;
            const preContinuationSnapshot = await createWorkspaceSnapshot(continuationRoot, {
              maxFileBytes: this.input.config.maxFileBytes,
              maxSnapshotBytes: this.input.config.maxSnapshotBytes,
              signal,
              reuseUnchangedFrom: parentBaseline,
            });
            const continuationProgress: WaveProgressView = {
              startedAt: new Date().toISOString(),
              phase: "working",
              message: `Resuming ${beforeInspection.record.taskId} from its durable checkpoint`,
              waveId: beforeInspection.record.waveId,
              waveRoot: bundle.waveRoot,
              taskStatuses: [{
                subtaskId: beforeInspection.record.taskId,
                phase: "continuing",
                message: "continuation queued",
                artifactDir: beforeInspection.record.artifactDir,
                executorAdapter: beforeInspection.record.adapter,
                executorModel: beforeInspection.record.model,
              }],
              activity: [],
            };
            const publishContinuation = (message?: string) => {
              if (message) {
                continuationProgress.message = message;
                continuationProgress.phase = continuationPhase(message);
                continuationProgress.taskStatuses[0] = {
                  ...continuationProgress.taskStatuses[0],
                  phase: continuationProgress.phase,
                  message,
                };
                if (continuationProgress.activity.at(-1) !== message) {
                  continuationProgress.activity.push(`${beforeInspection.record.taskId}: ${message}`);
                  if (continuationProgress.activity.length > 32) continuationProgress.activity.shift();
                }
              }
              onUpdate?.({
                content: [{
                  type: "text",
                  text: `${wavePhaseLabel(continuationProgress.phase)} · ${elapsed(continuationProgress.startedAt)} · ${continuationProgress.message}`,
                }],
                details: {
                  state: "running",
                  action: "continue",
                  bundle: beforeInspection.bundle,
                  progress: {
                    ...continuationProgress,
                    taskStatuses: [...continuationProgress.taskStatuses],
                    activity: [...continuationProgress.activity],
                  },
                },
              });
            };
            publishContinuation();
            const continuationTicker = onUpdate ? setInterval(() => publishContinuation(), 5_000) : undefined;
            continuationTicker?.unref?.();
            this.running = true;
            let result: Awaited<ReturnType<typeof continueOperation>>;
            try {
              result = await continueOperation({
                bundle,
                instructions: operationInput.instructions,
                instructionId: operationInput.instructionId ?? toolCallId,
                config: this.input.config,
                scopedModels,
                signal,
                onUpdate: (message) => publishContinuation(message),
              });
            } finally {
              if (continuationTicker) clearInterval(continuationTicker);
            }
            await this.mergeAssociatedBundles([result.inspection.bundle]);
            const landed = isRecord(result.landing) && result.landing.status === "landed";
            if (result.landing?.status === "landed") {
              const landedPaths = [...(result.landing.appliedPaths ?? []), ...(result.landing.alreadyAppliedPaths ?? [])];
              if (landedPaths.length > 0) {
                const afterSnapshot = await createWorkspaceSnapshot(continuationRoot, {
                  maxFileBytes: this.input.config.maxFileBytes,
                  maxSnapshotBytes: this.input.config.maxSnapshotBytes,
                  signal,
                  reuseUnchangedFrom: preContinuationSnapshot,
                });
                const selective = buildSelectiveCheckpoint(
                  parentBaseline,
                  preContinuationSnapshot,
                  afterSnapshot,
                  landedPaths,
                  continuationRoot,
                );
                checkpointReviewWindow(this.input.state, selective.snapshot);
              }
            }
            return operationToolResult("continue", result, !landed);
          } catch (error) {
            const inspection = await inspectOperation(bundle).catch(() => undefined);
            if (inspection) await this.mergeAssociatedBundles([inspection.bundle]);
            return operationToolResult(operationInput.action, {
              summary: error instanceof Error ? error.message : String(error),
              bundle: inspection?.bundle ?? bundle,
              inspection,
            }, true);
          } finally {
            this.running = false;
          }
        }

        const batchInput = operationInput;

        const scopedModels = (scopedModelChoices(ctx) ?? []).map((choice) => choice.model);
        const modelError = validateInternalModel(this.input.config, scopedModels);
        if (modelError) {
          return batchToolResult({ summary: modelError, isError: true });
        }

        // Check parent baseline before any capture.
        const parentBaseline = activeExchangeBaseline(this.input.state);
        if (!parentBaseline) {
          return batchToolResult({
            summary: "No clean parent ownership baseline is available. Cannot start wave execution.",
            isError: true,
          });
        }

        const cwd = extractCwd(ctx) ?? this.input.cwd();
        const tasks: WaveWorkerTask[] = batchInput.tasks.map((t) => ({
          title: t.title,
          instructions: t.instructions,
          acceptanceCriteria: t.acceptanceCriteria,
          relevantContext: t.relevantContext,
        }));

        const waveProgress: WaveProgressView = {
          startedAt: new Date().toISOString(),
          phase: "capturing",
          message: "preparing wave execution",
          taskStatuses: [],
          activity: [],
        };
        const lastActivityByScope = new Map<string, string>();

        const publishWave = (update?: WaveProgressUpdate) => {
          if (update) {
            waveProgress.phase = update.phase;
            waveProgress.message = update.message;
            if (update.waveId) waveProgress.waveId = update.waveId;
            if (update.waveRoot) {
              waveProgress.waveRoot = update.waveRoot;
            }
            if (update.baseCommit) waveProgress.baseCommit = update.baseCommit;
            if (update.maxWorkers) waveProgress.maxWorkers = update.maxWorkers;
            if (update.counts) waveProgress.counts = update.counts;
            if (update.activity) {
              for (const message of update.activity) {
                const taskPrefix = /^([^:\s]+):\s/.exec(message)?.[1];
                const scope = taskPrefix ?? "__wave__";
                if (lastActivityByScope.get(scope) === message) continue;
                lastActivityByScope.set(scope, message);
                waveProgress.activity.push(message);
              }
              if (waveProgress.activity.length > 40) waveProgress.activity.splice(0, waveProgress.activity.length - 40);
            }
            // Merge controller-emitted taskStatuses (taskId/phase/reviewer/artifactDir)
            // into the existing per-task view keyed by taskId.
            if (update.taskStatuses) {
              for (const ts of update.taskStatuses) {
                const idx = waveProgress.taskStatuses.findIndex((s) => s.subtaskId === ts.taskId);
                const previous = idx >= 0 ? waveProgress.taskStatuses[idx] : undefined;
                const entry = {
                  subtaskId: ts.taskId,
                  phase: ts.phase,
                  message: previous?.phase === ts.phase ? previous.message : ts.phase,
                  artifactDir: ts.artifactDir ?? previous?.artifactDir,
                  reviewer: ts.reviewer ?? previous?.reviewer,
                  executorAdapter: ts.executorAdapter ?? previous?.executorAdapter,
                  executorModel: ts.executorModel ?? previous?.executorModel,
                  reviewCycle: ts.reviewCycle ?? previous?.reviewCycle,
                  candidateCommitSha: ts.candidateCommitSha ?? previous?.candidateCommitSha,
                  acceptedCommitSha: ts.acceptedCommitSha ?? previous?.acceptedCommitSha,
                };
                if (idx >= 0) {
                  waveProgress.taskStatuses[idx] = entry;
                } else {
                  waveProgress.taskStatuses.push(entry);
                }
              }
            }
            const subtask = update.subtask;
            if (subtask) {
              const idx = waveProgress.taskStatuses.findIndex((s) => s.subtaskId === subtask.subtaskId);
              const previous = idx >= 0 ? waveProgress.taskStatuses[idx] : undefined;
              const entry = {
                ...previous,
                subtaskId: subtask.subtaskId ?? "unknown",
                phase: subtask.phase,
                message: subtask.message,
                artifactDir: subtask.artifactDir ?? previous?.artifactDir,
                reviewer: subtask.reviewers?.join(", ") ?? previous?.reviewer,
                executorAdapter: subtask.adapter ?? previous?.executorAdapter,
                executorModel: subtask.model ?? previous?.executorModel,
                reviewCycle: subtask.reviewCycle ?? previous?.reviewCycle,
              };
              if (idx >= 0) {
                waveProgress.taskStatuses[idx] = entry;
              } else {
                waveProgress.taskStatuses.push(entry);
              }
            }
          }
          onUpdate?.({
            content: [{ type: "text", text: `${wavePhaseLabel(waveProgress.phase)} · ${elapsed(waveProgress.startedAt)} · ${waveProgress.message}` }],
            details: { state: "running", progress: { ...waveProgress, taskStatuses: [...waveProgress.taskStatuses], activity: [...waveProgress.activity] } },
          });
        };

        publishWave();
        const ticker = onUpdate ? setInterval(() => publishWave(), 5_000) : undefined;
        ticker?.unref?.();
        this.running = true;

        try {
          const effectiveMaxWorkers = batchInput.maxWorkers
            ?? this.input.config.execution?.maxWorkers
            ?? 4;
          const waveInput: WaveControllerInput = {
            cwd,
            tasks,
            config: this.input.config,
            scopedModels,
            maxWorkers: effectiveMaxWorkers,
            integratePartial: batchInput.integratePartial,
            signal,
            onProgress: publishWave,
            onWaveCreated: async (waveRoot) => {
              waveProgress.waveRoot = waveRoot;
              await this.rememberWaveRoot(waveRoot);
            },
          };

          // Capture pre-wave snapshot immediately before executeWave for ownership-aware checkpoint.
          const preWaveSnapshot = await createWorkspaceSnapshot(cwd, {
            maxFileBytes: this.input.config.maxFileBytes,
            maxSnapshotBytes: this.input.config.maxSnapshotBytes,
            signal,
            reuseUnchangedFrom: parentBaseline,
          });

          let waveResult: WaveResult;
          try {
            waveResult = await executeWave(waveInput);
          } catch (err) {
            // Handle typed capture errors: produce a structured tool error
            // with a stable code, journal entry, and no source mutation.
            if (err instanceof WaveCaptureError) {
              appendJournal(this.input.pi, {
                version: 1,
                kind: "wave_capture_error",
                waveId: err.waveId ?? waveInput.waveId ?? "unknown",
                phase: err.phase,
                code: err.code,
                error: err.message,
                timestamp: new Date().toISOString(),
              });
              return batchToolResult({
                summary: err.code === "cancelled"
                  ? `Wave cancelled during capture: ${err.message}`
                  : `Wave capture failed [${err.code}]: ${err.message}`,
                waveId: err.waveId,
                phase: err.phase,
                errorCode: err.code,
                isError: true,
              });
            }
            // Re-throw unexpected errors.
            throw err;
          }

          // Only checkpoint parent baseline on successful landing.
          // Use selective checkpoint: only update landed wave paths, preserve pre-wave parent edits.
          let landed = false;
          let parentOwnedOverlapPaths: string[] = [];
          const allWavePaths = [
            ...(waveResult.landing?.appliedPaths ?? []),
            ...(waveResult.landing?.alreadyAppliedPaths ?? []),
          ];
          if (waveResult.landing?.status === "landed" && allWavePaths.length > 0) {
            const afterSnapshot = await createWorkspaceSnapshot(cwd, {
              maxFileBytes: this.input.config.maxFileBytes,
              maxSnapshotBytes: this.input.config.maxSnapshotBytes,
              signal,
              reuseUnchangedFrom: preWaveSnapshot,
            });
            // Build selective checkpoint: pre-wave baseline + only landed wave paths.
            // Use sourceRoot (Git top-level) for path resolution, not cwd.
            // Ownership-safe: if parent already changed a path before the wave,
            // leave the baseline entry so parent review sees baseline→final.
            const result = buildSelectiveCheckpoint(
              parentBaseline,
              preWaveSnapshot,
              afterSnapshot,
              allWavePaths,
              waveResult.sourceRoot,
            );
            checkpointReviewWindow(this.input.state, result.snapshot);
            parentOwnedOverlapPaths = result.parentOwnedOverlapPaths;
            landed = true;
          }

          // Only a landed outcome is success; every non-landed outcome is an error.
          const isError: boolean = waveResult.landing?.status !== "landed";

          // Append journal entry.
          appendJournal(this.input.pi, {
            version: 1,
            kind: "wave",
            waveId: waveResult.waveId,
            waveRoot: waveResult.waveRoot,
            phase: waveResult.phase,
            taskCount: waveResult.taskResults.length,
            taskStatuses: waveResult.taskResults.map((tr) => ({
              taskId: tr.taskId,
              title: tr.title,
              status: tr.status,
              acceptedCommitSha: tr.acceptedCommitSha,
            })),
            integration: waveResult.integration?.status,
            landing: waveResult.landing?.status,
            integratePartial: batchInput.integratePartial === true,
            landed,
            parentOwnedOverlapPaths,
            timestamp: new Date().toISOString(),
          });

          const summaryLines = waveResult.taskResults
            .map((tr) => `${tr.taskId}: ${tr.status}`)
            .join(", ");
          await this.mergeAssociatedBundles(waveResult.taskResults.flatMap((task) => task.bundle ? [task.bundle] : []));
          return batchToolResult({
            summary: `Wave ${waveResult.waveId} completed: ${summaryLines}`,
            waveId: waveResult.waveId,
            waveRoot: waveResult.waveRoot,
            sourceRoot: waveResult.sourceRoot,
            phase: waveResult.phase,
            taskResults: waveResult.taskResults,
            integration: waveResult.integration,
            landing: waveResult.landing,
            parentOwnedOverlapPaths,
            isError,
          });
        } catch (error) {
          return batchToolResult({
            summary: error instanceof Error ? error.message : String(error),
            waveId: waveProgress.waveId,
            waveRoot: waveProgress.waveRoot,
            phase: waveProgress.phase,
            errorCode: "execution_controller_error",
            isError: true,
          });
        } finally {
          if (ticker) clearInterval(ticker);
          this.running = false;
        }
      },
      renderCall: (args: unknown, theme: ThemeLike) => renderBatchCall(args, theme),
      renderResult: (result: unknown, options: unknown, theme: ThemeLike) => renderBatchResult(result, options, theme),
    });

    this.registered = true;
  }
}

interface ThemeLike {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

function textComponent(render: (width: number) => string[]) {
  return { render: (width: number) => render(Math.max(20, width - 2)), invalidate() {} };
}

function elapsed(startedAt: string): string {
  const milliseconds = Math.max(0, Date.now() - Date.parse(startedAt));
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function clip(value: string, width: number): string {
  const compact = stripTerminalSequences(value).replace(/\s+/g, " ").trim();
  const limit = Math.max(8, width);
  if (displayWidth(compact) <= limit) return compact;
  const contentLimit = limit - 1;
  let clipped = "";
  let used = 0;
  for (const character of compact) {
    const characterWidth = terminalCellWidth(character.codePointAt(0)!);
    if (used + characterWidth > contentLimit) break;
    clipped += character;
    used += characterWidth;
  }
  return `${clipped}…`;
}

function stripTerminalSequences(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += terminalCellWidth(character.codePointAt(0)!);
  }
  return width;
}

function terminalCellWidth(codePoint: number): number {
  if (codePoint === 0 || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (/\p{Mark}/u.test(String.fromCodePoint(codePoint))) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function renderReviewReportForModel(report: SubtaskReviewReport | undefined): string[] {
  if (!report) return [];
  const lines = [
    "",
    `Review aggregate: ${report.aggregate} (${report.summary})`,
    `Review cycles: ${report.reviewCycles}`,
    "Latest reviewer evidence:",
  ];
  for (const reviewer of report.reviewers) {
    lines.push(`- ${reviewer.displayLabel}: ${reviewer.verdict} — ${reviewer.summary}`);
    if (reviewer.error) {
      lines.push(`  Infrastructure warning (${reviewer.errorCategory ?? "infrastructure"}): ${reviewer.error}`);
      if (reviewer.diagnostic) lines.push(`  Diagnostic: ${reviewer.diagnostic}`);
    }
    for (const finding of reviewer.findings) {
      const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
      lines.push(`  ${finding.severity} ${location}: ${finding.issue} Recommendation: ${finding.recommendation}`);
    }
  }
  return lines;
}

function validateInternalModel(config: ReviewGateConfig, scopedModels: string[]): string | undefined {
  for (const { selection } of resolvedExecutorPool(config)) {
    if (selection.source === "little-coder" && !scopedModels.includes(selection.model)) {
      return `Configured little-coder executor model is not in ctx.scopedModels: ${selection.model}. Use /review-settings.`;
    }
  }
  return undefined;
}

function setToolActive(pi: unknown, name: string, active: boolean): void {
  if (!isRecord(pi) || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
    return;
  }
  const current = Array.isArray(pi.getActiveTools()) ? pi.getActiveTools() as string[] : [];
  const next = active
    ? [...new Set([...current, name])]
    : current.filter((tool) => tool !== name);
  pi.setActiveTools(next);
}

function appendJournal(pi: unknown, entry: Record<string, unknown>): void {
  if (isRecord(pi) && typeof pi.appendEntry === "function") {
    pi.appendEntry("pi-review-subtask", entry);
  }
}

function extractCwd(ctx: unknown): string | undefined {
  return isRecord(ctx) && typeof ctx.cwd === "string" ? ctx.cwd : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

// ── batch tool helpers ───────────────────────────────────────────────────────

interface WaveProgressView {
  startedAt: string;
  phase: string;
  message: string;
  waveId?: string;
  waveRoot?: string;
  baseCommit?: string;
  maxWorkers?: number;
  counts?: { queued: number; running: number; reviewing: number; correcting: number; accepted: number; failed: number; completed: number };
  taskStatuses: Array<{ subtaskId: string; phase: string; message: string; artifactDir?: string; reviewer?: string; executorAdapter?: string; executorModel?: string; reviewCycle?: number; candidateCommitSha?: string; acceptedCommitSha?: string }>;
  activity: string[];
}

interface NormalizedBatchInput {
  action: "start";
  tasks: Array<{
    title: string;
    instructions: string;
    acceptanceCriteria: string[];
    relevantContext?: string;
  }>;
  maxWorkers?: number;
  integratePartial?: boolean;
}

type NormalizedExecutionInput = NormalizedBatchInput | {
  action: "continue" | "steer";
  bundle?: ReattachmentBundle;
  instructions: string;
  instructionId?: string;
} | {
  action: "inspect";
  bundle?: ReattachmentBundle;
  waveRoot?: string;
};

const ALLOWED_TOP_KEYS = new Set(["action", "tasks", "maxWorkers", "integratePartial", "bundle", "waveRoot", "instructions", "instructionId"]);
const ALLOWED_TASK_KEYS = new Set(["title", "instructions", "acceptanceCriteria", "relevantContext"]);

function normalizeExecutionInput(value: unknown): NormalizedExecutionInput | undefined {
  if (!isRecord(value) || !["start", "continue", "steer", "inspect"].includes(String(value.action))) {
    return undefined;
  }

  // Reject unknown top-level keys.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_TOP_KEYS.has(key)) return undefined;
  }

  const bundle = value.bundle === undefined ? undefined : normalizeBundle(value.bundle);
  if (value.bundle !== undefined && !bundle) return undefined;
  if (value.action === "inspect") {
    if (value.tasks !== undefined || value.maxWorkers !== undefined || value.integratePartial !== undefined
      || value.instructions !== undefined || value.instructionId !== undefined) return undefined;
    if (value.waveRoot !== undefined && (typeof value.waveRoot !== "string" || !value.waveRoot.trim() || bundle)) return undefined;
    return { action: "inspect", bundle, waveRoot: typeof value.waveRoot === "string" ? value.waveRoot.trim() : undefined };
  }
  if (value.action === "continue" || value.action === "steer") {
    if (value.tasks !== undefined || value.maxWorkers !== undefined || value.integratePartial !== undefined
      || value.waveRoot !== undefined || typeof value.instructions !== "string" || !value.instructions.trim()) return undefined;
    if (value.instructionId !== undefined && (typeof value.instructionId !== "string" || !value.instructionId.trim())) return undefined;
    return {
      action: value.action,
      bundle,
      instructions: value.instructions.trim(),
      instructionId: typeof value.instructionId === "string" ? value.instructionId.trim() : undefined,
    };
  }
  if (!Array.isArray(value.tasks) || value.bundle !== undefined || value.waveRoot !== undefined || value.instructions !== undefined || value.instructionId !== undefined) {
    return undefined;
  }

  const tasks = value.tasks;
  if (tasks.length < 1 || tasks.length > 16) {
    return undefined;
  }
  const normalized: NormalizedBatchInput["tasks"] = [];
  for (const t of tasks) {
    if (!isRecord(t)) return undefined;

    // Reject unknown task keys.
    for (const key of Object.keys(t)) {
      if (!ALLOWED_TASK_KEYS.has(key)) return undefined;
    }

    if (typeof t.title !== "string"
      || typeof t.instructions !== "string"
      || !Array.isArray(t.acceptanceCriteria)
      || t.acceptanceCriteria.some((item: unknown) => typeof item !== "string")) {
      return undefined;
    }

    // Reject present relevantContext that is not a non-empty string.
    if (t.relevantContext !== undefined && t.relevantContext !== null && typeof t.relevantContext !== "string") {
      return undefined;
    }

    const title = String(t.title).trim();
    const instructions = String(t.instructions).trim();
    const acceptanceCriteria = t.acceptanceCriteria
      .map((item: string) => String(item).trim())
      .filter(Boolean);

    // Reject blank criteria after trimming.
    if (t.acceptanceCriteria.some((item: string) => !String(item).trim())) {
      return undefined;
    }

    if (!title || !instructions || acceptanceCriteria.length === 0) {
      return undefined;
    }
    normalized.push({
      title,
      instructions,
      acceptanceCriteria,
      relevantContext: typeof t.relevantContext === "string" && t.relevantContext.trim() ? t.relevantContext.trim() : undefined,
    });
  }

  let maxWorkers: number | undefined;
  if (value.maxWorkers !== undefined) {
    if (typeof value.maxWorkers !== "number" || !Number.isInteger(value.maxWorkers)) {
      return undefined;
    }
    if (value.maxWorkers < 1 || value.maxWorkers > 16) {
      return undefined;
    }
    maxWorkers = value.maxWorkers;
  }

  let integratePartial: boolean | undefined;
  if (value.integratePartial !== undefined) {
    if (typeof value.integratePartial !== "boolean") {
      return undefined;
    }
    integratePartial = value.integratePartial;
  }

  return { action: "start", tasks: normalized, maxWorkers, integratePartial };
}

function normalizeBundle(value: unknown): ReattachmentBundle | undefined {
  if (!isRecord(value)) return undefined;
  const keys = new Set(["version", "operationId", "waveId", "taskId", "waveRoot", "expectedRevision"]);
  if (Object.keys(value).some((key) => !keys.has(key))) return undefined;
  if (value.version !== 1
    || typeof value.operationId !== "string" || !value.operationId
    || typeof value.waveId !== "string" || !value.waveId
    || typeof value.taskId !== "string" || !value.taskId
    || typeof value.waveRoot !== "string" || !value.waveRoot
    || typeof value.expectedRevision !== "number" || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0) return undefined;
  return {
    version: 1,
    operationId: value.operationId,
    waveId: value.waveId,
    taskId: value.taskId,
    waveRoot: value.waveRoot,
    expectedRevision: value.expectedRevision,
  };
}

function isWaveTaskSuccess(status: string): boolean {
  return status === "accepted" || status === "accepted_with_warnings" || status === "completed_unreviewed" || status === "no_changes";
}

function wavePhaseLabel(phase: string): string {
  return ({
    capturing: "Capturing",
    working: "Working",
    continuing: "Continuing",
    reviewing: "Reviewing",
    correcting: "Correcting",
    settling: "Settling",
    integrating: "Integrating",
    planning: "Planning",
    landing: "Landing",
    completed: "Completed",
    aborted: "Aborted",
  })[phase] ?? phase;
}

function continuationPhase(message: string): string {
  if (/\bland(?:ing)?\b/i.test(message)) return "landing";
  if (/\bintegrat(?:e|ing|ion)\b/i.test(message)) return "integrating";
  if (/\breview/i.test(message)) return "reviewing";
  if (/\bcorrect(?:ing|ion)?\b/i.test(message)) return "correcting";
  return "continuing";
}

interface BatchToolResultInput {
  summary: string;
  isError: boolean;
  waveId?: string;
  waveRoot?: string;
  sourceRoot?: string;
  phase?: string;
  errorCode?: string;
  taskResults?: WaveTaskResult[];
  integration?: {
    status: string;
    validationStatus?: string;
    integratedRef?: string;
    finalCommitSha?: string;
    error?: string;
    worktree?: string;
    conflictingTaskId?: string;
    conflictingCommitSha?: string;
    conflictingPaths?: string[];
    gitDiagnostics?: string;
    workerMappings?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
    successfullyIntegrated?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
  };
  landing?: {
    status: string;
    appliedPaths?: string[];
    alreadyAppliedPaths?: string[];
    conflicts?: Array<{ path: string; reason: string }>;
    failedAtPath?: string | null;
    failureReason?: string;
    manifestPath?: string;
    rollbackError?: string;
    headDrift?: { drifted: boolean; capturedHead?: string; currentHead?: string };
  };
  parentOwnedOverlapPaths?: string[];
  associatedBundles?: ReattachmentBundle[];
  associatedWaveRoots?: string[];
}

function buildWaveOutcomePacket(input: BatchToolResultInput): WaveOutcomePacket | undefined {
  const hasWaveOutcome = Boolean(
    input.waveId
    || input.waveRoot
    || input.sourceRoot
    || input.phase
    || input.errorCode
    || input.taskResults
    || input.integration
    || input.landing,
  );
  if (!hasWaveOutcome) return undefined;

  const landed = input.landing?.status === "landed";
  const recoveryRequired = input.landing?.status === "recovery_required";
  const rolledBack = input.landing?.status === "rolled_back";
  const disposition = landed ? "landed" : recoveryRequired ? "recovery_required" : "unchanged";
  const sourceMessage = landed
    ? "LANDED — the reported executor changes were applied to the source workspace."
    : recoveryRequired
      ? "RECOVERY REQUIRED — landing rollback was incomplete, so the source workspace may be partially modified; inspect the recovery manifest before further edits."
      : rolledBack
        ? "UNCHANGED — the failed landing was fully rolled back; no executor changes from this wave remain applied."
        : "UNCHANGED — no executor changes from this wave were applied to the source workspace.";

  if (landed) {
    return {
      landed: true,
      actionRequired: false,
      sourceWorkspace: {
        root: input.sourceRoot,
        disposition,
        changedByWave: true,
        message: sourceMessage,
      },
      recovery: {
        automaticRetry: "not_needed",
        summary: "No recovery is required.",
        actions: [],
      },
    };
  }

  let failureKind: WaveFailureKind;
  if (input.errorCode) failureKind = "capture_error";
  else if (input.integration?.status === "conflicted") failureKind = "integration_conflict";
  else if (input.integration?.status === "error") failureKind = "integration_error";
  else if (input.landing?.status === "conflicted") failureKind = "landing_conflict";
  else if (input.landing?.status === "planning_error") failureKind = "landing_error";
  else if (input.landing?.status === "rolled_back") failureKind = "landing_rolled_back";
  else if (input.landing?.status === "recovery_required") failureKind = "landing_recovery_required";
  else if (input.phase === "aborted" || input.landing?.status === "aborted") failureKind = "aborted";
  else if (input.integration?.status === "worker_failure" || input.taskResults?.some((task) => !isWaveTaskSuccess(task.status))) failureKind = "worker_failure";
  else failureKind = "not_landed";

  const manifestPath = input.waveRoot ? `${input.waveRoot}/wave-manifest.json` : undefined;
  const actions: WaveRecoveryAction[] = [];
  if (manifestPath) {
    actions.push({
      action: "inspect",
      instruction: `Inspect ${manifestPath}, the operation records, and any preserved worktree before choosing a resolution.`,
    });
  }

  let summary: string;
  let automaticRetry: WaveOutcomePacket["recovery"]["automaticRetry"] = "not_applicable";
  if (failureKind === "integration_conflict") {
    automaticRetry = "skipped_deterministic";
    summary = "Resolve the deterministic integration conflict before any executor changes can reach the source workspace.";
    const paths = input.integration?.conflictingPaths?.join(", ") || "the reported conflicting paths";
    actions.push({
      action: "self_resolve",
      instruction: `Use the preserved integration worktree and pinned task commits to understand the overlap in ${paths}, then deliberately reproduce the combined resolution in the source workspace. The preserved worktree itself is diagnostic state, not landed work.`,
    });
    const target = input.taskResults?.find((task) => task.taskId === input.integration?.conflictingTaskId);
    if (target?.bundle) {
      actions.push({
        action: "continue",
        taskId: target.taskId,
        bundle: target.bundle,
        instruction: `Delegate resolution by continuing ${target.taskId} from its verified checkpoint. Tell it to reconcile ${paths} with the successfully integrated task changes; a successful continuation will re-run review, integration, and landing.`,
      });
    } else {
      actions.push({
        action: "continue",
        taskId: input.integration?.conflictingTaskId,
        instruction: "Choose the matching task reattachment bundle from Task results and continue that operation with explicit conflict-resolution instructions.",
      });
    }
  } else if (failureKind === "landing_conflict") {
    automaticRetry = "skipped_deterministic";
    summary = "Resolve the source-workspace drift before retrying or deliberately applying the integrated result.";
    actions.push({
      action: "self_resolve",
      instruction: "Compare each reported landing conflict against the integrated commit and current source path, then choose the intended combined content. No wave changes have been applied to source.",
    });
    actions.push({
      action: "continue",
      instruction: "To delegate, choose the responsible task bundle from Task results and continue it with the landing-conflict paths and current source intent; continuation will re-integrate all eligible task commits before landing.",
    });
  } else if (failureKind === "landing_recovery_required") {
    automaticRetry = "unsafe";
    summary = "Stop automatic recovery and reconcile the authenticated landing recovery manifest before further source edits.";
    actions.push({
      action: "manual_recovery",
      instruction: input.landing?.manifestPath
        ? `Inspect and recover ${input.landing.manifestPath}; preserve backups and temporary artifacts until source state is verified.`
        : "Locate the landing recovery manifest in the wave root and reconcile it before further source edits.",
    });
  } else if (failureKind === "worker_failure") {
    automaticRetry = "exhausted";
    summary = "Inspect failed task diagnostics, then continue recoverable operations or replace the failed task deliberately.";
    actions.push({
      action: "self_resolve",
      instruction: "Use the retained checkpoints and task diagnostics to implement the unfinished work directly in the source workspace under the normal review gate.",
    });
    for (const task of input.taskResults?.filter((item) => !isWaveTaskSuccess(item.status) && item.bundle) ?? []) {
      actions.push({
        action: "continue",
        taskId: task.taskId,
        bundle: task.bundle,
        instruction: `Continue ${task.taskId} from its retained checkpoint after inspecting its incidents and recovery diagnostics.`,
      });
    }
  } else if (failureKind === "integration_error") {
    automaticRetry = "exhausted";
    summary = "Integration infrastructure retries did not produce a landed result; inspect the preserved state before continuing a task or retrying deliberately.";
    actions.push({
      action: "self_resolve",
      instruction: "Inspect the accepted task commits and integration diagnostics, then deliberately reproduce the intended combined result in the source workspace.",
    }, {
      action: "continue",
      instruction: "Choose a recoverable task bundle from Task results and continue it; the continuation will retry integration and landing after another reviewed executor turn.",
    });
  } else if (failureKind === "landing_rolled_back") {
    automaticRetry = "not_attempted";
    summary = "The landing failed but rollback completed; inspect the failure reason before retrying or delegating a correction.";
    actions.push({
      action: "self_resolve",
      instruction: "After verifying the rollback, use the retained integrated commit and failure reason to implement the intended result directly in source.",
    }, {
      action: "continue",
      instruction: "Choose the responsible task bundle from Task results and continue it with the landing failure context so integration and landing are attempted again.",
    });
  } else if (failureKind === "landing_error") {
    automaticRetry = "exhausted";
    summary = "Landing planning retries did not produce a safe plan; inspect the failure and retained integrated result before retrying or delegating a correction.";
    actions.push({
      action: "self_resolve",
      instruction: "Inspect the integrated commit and planning failure, then implement a safe combined result directly in the source workspace.",
    }, {
      action: "continue",
      instruction: "Choose a task bundle from Task results and continue it with the planning failure context; continuation will rebuild integration and landing state.",
    });
  } else if (failureKind === "aborted") {
    automaticRetry = "not_applicable";
    summary = "The wave was interrupted before landing; inspect retained operation state and continue only recoverable tasks.";
    actions.push({
      action: "self_resolve",
      instruction: "Use retained checkpoints and artifacts to determine what remains, then complete it directly in source under the normal review gate.",
    }, {
      action: "continue",
      instruction: "Continue each recoverable task by its exact bundle from Task results; do not recreate work already present in a verified checkpoint.",
    });
  } else if (failureKind === "capture_error") {
    automaticRetry = "exhausted";
    summary = "Capture failed before executor work could land; correct the capture condition before starting another wave.";
    actions.push({
      action: "start",
      instruction: "After correcting the reported capture condition, start a new wave; no executor task state was landed from this failed capture.",
    });
  } else {
    automaticRetry = "not_applicable";
    summary = "The wave did not land; inspect the returned statuses and retained artifacts before deciding whether to self-resolve or delegate recovery.";
    actions.push({
      action: "self_resolve",
      instruction: "Use the retained task commits and diagnostics to complete the intended result directly in source under the normal review gate.",
    }, {
      action: "continue",
      instruction: "Choose an appropriate reattachment bundle from Task results and continue that operation with explicit recovery instructions.",
    });
  }

  return {
    landed: false,
    failureKind,
    actionRequired: true,
    sourceWorkspace: {
      root: input.sourceRoot,
      disposition,
      changedByWave: recoveryRequired ? "unknown" : false,
      message: sourceMessage,
    },
    recovery: {
      automaticRetry,
      summary,
      actions,
    },
  };
}

function batchToolResult(input: BatchToolResultInput): Record<string, unknown> {
  const lines: string[] = [];
  const outcome = buildWaveOutcomePacket(input);
  if (input.waveId) lines.push(`Wave: ${input.waveId}`);
  if (input.waveRoot) lines.push(`Wave root: ${input.waveRoot}`);
  if (input.phase) lines.push(`Phase: ${input.phase}`);
  if (input.errorCode) lines.push(`Error code: ${input.errorCode}`);
  lines.push(input.summary);

  if (outcome) {
    lines.push("");
    lines.push(outcome.landed ? "Outcome: LANDED" : `Outcome: NOT LANDED (${outcome.failureKind})`);
    lines.push(`Source workspace: ${outcome.sourceWorkspace.message}`);
    if (outcome.actionRequired) {
      lines.push(`Automatic retry: ${outcome.recovery.automaticRetry}`);
      lines.push(`Action required: ${outcome.recovery.summary}`);
    }
  }

  if (input.taskResults?.length) {
    lines.push("");
    lines.push("Task results:");
    for (const tr of input.taskResults) {
      const icon = isWaveTaskSuccess(tr.status) ? "✓" : "✗";
      lines.push(`  ${icon} ${tr.taskId} (${tr.status}): ${tr.title}`);
      if (tr.error) lines.push(`    error: ${tr.error}`);
      if (tr.attempts !== undefined) lines.push(`    attempts: ${tr.attempts}`);
      if (tr.checkpoint) {
        lines.push(`    recovery checkpoint: ${tr.checkpoint.commitSha} (${tr.checkpoint.ref})`);
      }
      if (tr.operationRecord) lines.push(`    operation record: ${tr.operationRecord}`);
      if (tr.bundle) lines.push(`    reattachment bundle: ${JSON.stringify(tr.bundle)}`);
      if (tr.incidents?.length) {
        for (const incident of tr.incidents) {
          lines.push(`    incident ${incident.incidentId}: ${incident.cause} — ${incident.message}`);
        }
      }
      if (tr.diagnostics && !isWaveTaskSuccess(tr.status)) {
        lines.push(`    recovery: ${tr.diagnostics.recovery.recommendedAction}`);
      }
      if (tr.reviewReport) {
        for (const line of renderReviewReportForModel(tr.reviewReport)) {
          lines.push(line ? `    ${line}` : "");
        }
      }
    }
  }

  if (input.integration) {
    lines.push(`\nIntegration: ${input.integration.status}`);
    if (input.integration.validationStatus) lines.push(`  validation: ${input.integration.validationStatus}`);
    if (input.integration.integratedRef) lines.push(`  integrated ref: ${input.integration.integratedRef}`);
    if (input.integration.finalCommitSha) lines.push(`  final commit: ${input.integration.finalCommitSha}`);
    if (input.integration.error) lines.push(`  error: ${input.integration.error}`);
    if (input.integration.worktree) {
      const disposition = input.integration.status === "conflicted" || input.integration.status === "error"
        ? "preserved for diagnosis"
        : "cleanup attempted after integration; use the retained ref/commit if this path is absent";
      lines.push(`  worktree: ${input.integration.worktree} (${disposition})`);
    }
    if (input.integration.conflictingTaskId) lines.push(`  conflict at: ${input.integration.conflictingTaskId}`);
    if (input.integration.conflictingCommitSha) lines.push(`  conflicting commit: ${input.integration.conflictingCommitSha}`);
    if (input.integration.conflictingPaths?.length) lines.push(`  conflicting paths: ${input.integration.conflictingPaths.join(", ")}`);
    if (input.integration.workerMappings?.length) {
      lines.push(`  worker mappings: ${input.integration.workerMappings.map((m) => `${m.taskId}#${m.integratedCommitSha.slice(0, 8)}`).join(", ")}`);
    }
    if (input.integration.successfullyIntegrated?.length) {
      lines.push(`  successfully integrated: ${input.integration.successfullyIntegrated.map((m) => `${m.taskId}#${m.integratedCommitSha.slice(0, 8)}`).join(", ")}`);
    }
    if (input.integration.gitDiagnostics) {
      lines.push("  git diagnostics:");
      lines.push(...input.integration.gitDiagnostics.split("\n").map((line) => `    ${line}`));
    }
  }
  if (input.landing) {
    lines.push(`Landing: ${input.landing.status}`);
    if (input.landing.appliedPaths?.length) lines.push(`  applied: ${input.landing.appliedPaths.join(", ")}`);
    if (input.landing.alreadyAppliedPaths?.length) lines.push(`  already applied: ${input.landing.alreadyAppliedPaths.join(", ")}`);
    if (input.landing.conflicts?.length) lines.push(`  conflicts: ${input.landing.conflicts.map((c) => `${c.path}: ${c.reason}`).join(", ")}`);
    if (input.landing.failedAtPath) lines.push(`  failed at: ${input.landing.failedAtPath}`);
    if (input.landing.failureReason) lines.push(`  failure: ${input.landing.failureReason}`);
    if (input.landing.rollbackError) lines.push(`  rollback error: ${input.landing.rollbackError}`);
    if (input.landing.manifestPath) lines.push(`  manifest: ${input.landing.manifestPath}`);
    if (input.landing.headDrift?.drifted) lines.push(`  source HEAD drifted since capture`);
  }

  if (input.parentOwnedOverlapPaths?.length) {
    lines.push(`Parent-owned overlap paths (not checkpointed): ${input.parentOwnedOverlapPaths.join(", ")}`);
  }
  if (input.associatedBundles?.length) {
    lines.push("Associated recoverable operations:");
    for (const bundle of input.associatedBundles) lines.push(`  - ${JSON.stringify(bundle)}`);
  }
  if (input.associatedWaveRoots?.length) {
    lines.push("Associated wave roots:");
    for (const waveRoot of input.associatedWaveRoots) lines.push(`  - ${waveRoot}`);
  }

  if (outcome?.actionRequired) {
    lines.push("");
    lines.push("Recovery guidance:");
    for (const action of outcome.recovery.actions) {
      lines.push(`  - ${action.action}: ${action.instruction}`);
      if (action.taskId) lines.push(`    task: ${action.taskId}`);
      if (action.bundle) lines.push(`    bundle: ${JSON.stringify(action.bundle)}`);
    }
  }

  lines.push("");
  lines.push("Note: Non-ignored untracked files are included; ignored files are excluded from the captured snapshot and landing.");

  const details = redactSensitiveValue({
      waveId: input.waveId,
      waveRoot: input.waveRoot,
      sourceRoot: input.sourceRoot,
      phase: input.phase,
      errorCode: input.errorCode,
      taskResults: input.taskResults,
      integration: input.integration,
      landing: input.landing,
      parentOwnedOverlapPaths: input.parentOwnedOverlapPaths,
      associatedBundles: input.associatedBundles,
      associatedWaveRoots: input.associatedWaveRoots,
      outcome,
      snapshotPolicy: "non-ignored untracked included; ignored files excluded",
      failureDiagnostics: input.taskResults?.filter((task) => !isWaveTaskSuccess(task.status)).map((task) => task.diagnostics),
    });
  return {
    content: [{ type: "text", text: redactSensitiveText(lines.join("\n")) }],
    details,
    ...(input.isError ? { isError: true } : {}),
  };
}

function operationToolResult(action: "continue" | "steer" | "inspect", details: unknown, isError: boolean): Record<string, unknown> {
  const record = isRecord(details) ? details : {};
  const summary = typeof record.summary === "string"
    ? record.summary
    : action === "inspect"
      ? "Operation inspection completed."
      : action === "continue"
        ? isError ? "Operation continuation did not land." : "Operation continuation completed and landed."
        : "Steering was not delivered.";
  const redactedDetails = redactSensitiveValue(details);
  return {
    content: [{ type: "text", text: redactSensitiveText(`${summary}\n\n${JSON.stringify(redactedDetails, null, 2)}`) }],
    details: { action, ...(isRecord(redactedDetails) ? redactedDetails : { value: redactedDetails }) },
    ...(isError ? { isError: true } : {}),
  };
}

function renderBatchCall(args: unknown, theme: ThemeLike) {
  const action = isRecord(args) && typeof args.action === "string" ? args.action : "start";
  const count = isRecord(args) && Array.isArray(args.tasks) ? args.tasks.length : 0;
  const detail = action === "start" ? `${count} task(s)` : action;
  return textComponent((width) => [
    clip(theme.fg("toolTitle", theme.bold("execute_subtasks ")) + theme.fg("accent", detail), width),
  ]);
}

function renderBatchResult(result: unknown, options: unknown, theme: ThemeLike) {
  const value = isRecord(result) ? result : {};
  const details = isRecord(value.details) ? value.details : {};
  const expanded = isRecord(options) && options.expanded === true;
  const progress = isWaveProgressView(details.progress) ? details.progress : undefined;

  if (progress) {
    return textComponent((width) => {
      const lines = [
        `${theme.fg("warning", "◌")} ${theme.fg("accent", wavePhaseLabel(progress.phase))}${theme.fg("muted", ` · ${elapsed(progress.startedAt)}`)}`,
        `  ${theme.fg("toolOutput", clip(progress.message, width - 4))}`,
      ];
      if (expanded) {
        if (progress.waveId) lines.push(theme.fg("dim", clip(`  wave: ${progress.waveId}`, width)));
        if (progress.baseCommit) lines.push(theme.fg("dim", clip(`  base: ${progress.baseCommit.slice(0, 12)}`, width)));
        if (progress.maxWorkers) lines.push(theme.fg("dim", clip(`  concurrency: ${progress.maxWorkers}`, width)));
        if (progress.counts) {
          const c = progress.counts;
          lines.push(theme.fg("dim", clip(`  counts: queued=${c.queued} running=${c.running} reviewing=${c.reviewing} correcting=${c.correcting} accepted=${c.accepted} failed=${c.failed} completed=${c.completed}`, width)));
        }
        if (progress.taskStatuses.length > 0) {
          lines.push("", theme.fg("toolTitle", "  Per-task status"));
          for (const ts of progress.taskStatuses.slice(-8)) {
            const isReviewing = ts.phase === "reviewing";
            const executor = ts.executorModel ?? ts.executorAdapter;
            const agentInfo = isReviewing && ts.reviewer
              ? ` · reviewer: ${ts.reviewer}`
              : executor ? ` · model: ${executor}` : "";
            lines.push(`  ${theme.fg("toolOutput", clip(`${ts.subtaskId}: ${ts.phase}${agentInfo} · ${ts.message}`, width - 6))}`);
            if (ts.artifactDir) {
              lines.push(theme.fg("dim", clip(`    artifacts: ${ts.artifactDir}`, width - 8)));
            }
          }
        }
        if (progress.activity && progress.activity.length > 0) {
          lines.push("", theme.fg("toolTitle", "  Recent activity"));
          for (const msg of progress.activity.slice(-8)) {
            lines.push(`  ${theme.fg("toolOutput", clip(msg, width - 4))}`);
          }
        }
        lines.push(clip(theme.fg("muted", "  Note: non-ignored untracked included; ignored files excluded."), width));
      } else {
        lines.push(clip(theme.fg("muted", "  (Ctrl+O to expand per-task status)"), width));
      }
      return lines;
    });
  }

  const phase = typeof details.phase === "string" ? details.phase : "completed";
  const failed = value.isError === true;
  const outcome = isRecord(details.outcome) ? details.outcome : undefined;
  const failureKind = outcome && typeof outcome.failureKind === "string"
    ? outcome.failureKind.replaceAll("_", " ")
    : undefined;
  const sourceWorkspace = outcome && isRecord(outcome.sourceWorkspace) ? outcome.sourceWorkspace : undefined;
  const integration = isRecord(details.integration) ? details.integration : undefined;
  const landing = isRecord(details.landing) ? details.landing : undefined;
  const recovery = outcome && isRecord(outcome.recovery) ? outcome.recovery : undefined;
  return textComponent((width) => {
    const lines = [
      clip(`${theme.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${theme.fg("accent", phase)}${failureKind ? theme.fg("error", ` · ${failureKind}`) : ""}`, width),
    ];
    if (details.waveId) lines.push(clip(theme.fg("dim", `  wave: ${details.waveId}`), width));
    if (details.waveRoot) lines.push(clip(theme.fg("dim", `  root: ${details.waveRoot}`), width));
    if (sourceWorkspace && typeof sourceWorkspace.message === "string") {
      lines.push(clip(theme.fg(failed ? "warning" : "success", `  source: ${sourceWorkspace.message}`), width));
    }

    if (Array.isArray(details.taskResults)) {
      lines.push(clip(theme.fg("toolTitle", "  Tasks"), width));
      for (const tr of details.taskResults) {
        const icon = isWaveTaskSuccess(tr.status) ? "✓" : "✗";
        lines.push(clip(`  ${icon} ${theme.fg("toolOutput", `${tr.taskId} (${tr.status}): ${tr.title}`)}`, width));
        if (isRecord(tr.reviewReport) && typeof tr.reviewReport.aggregate === "string") {
          lines.push(clip(theme.fg(
            tr.reviewReport.aggregate === "pass_with_warnings" ? "warning" : "dim",
            `    review: ${tr.reviewReport.aggregate}`,
          ), width));
        }
      }
    }

    if (integration) {
      lines.push(clip(theme.fg("dim", `  integration: ${integration.status}`), width));
      if (expanded) {
        if (integration.conflictingTaskId) lines.push(clip(theme.fg("warning", `    conflict at: ${integration.conflictingTaskId}`), width));
        if (integration.conflictingCommitSha) lines.push(clip(theme.fg("dim", `    conflicting commit: ${integration.conflictingCommitSha}`), width));
        if (Array.isArray(integration.conflictingPaths)) {
          lines.push(clip(theme.fg("warning", `    conflicting paths: ${integration.conflictingPaths.join(", ")}`), width));
        }
        if (integration.worktree) {
          const worktreeLabel = integration.status === "conflicted" || integration.status === "error"
            ? "preserved worktree"
            : "integration worktree (cleanup attempted)";
          lines.push(clip(theme.fg("dim", `    ${worktreeLabel}: ${integration.worktree}`), width));
        }
        if (typeof integration.gitDiagnostics === "string") {
          lines.push(theme.fg("toolTitle", "    Git diagnostics"));
          for (const diagnosticLine of integration.gitDiagnostics.split("\n")) {
            lines.push(clip(theme.fg("dim", `      ${diagnosticLine}`), width));
          }
        }
      }
    }
    if (landing) {
      lines.push(clip(theme.fg("dim", `  landing: ${landing.status}`), width));
      if (expanded && Array.isArray(landing.conflicts)) {
        for (const conflict of landing.conflicts) {
          if (!isRecord(conflict)) continue;
          lines.push(clip(theme.fg("warning", `    ${conflict.path}: ${conflict.reason}`), width));
        }
      }
      if (expanded && landing.manifestPath) lines.push(clip(theme.fg("warning", `    recovery manifest: ${landing.manifestPath}`), width));
    }
    if (expanded && recovery && typeof recovery.summary === "string") {
      lines.push(theme.fg("toolTitle", "  Recovery required"));
      if (typeof recovery.automaticRetry === "string") {
        lines.push(clip(theme.fg("dim", `    automatic retry: ${recovery.automaticRetry}`), width));
      }
      lines.push(clip(theme.fg("warning", `    ${recovery.summary}`), width));
      if (Array.isArray(recovery.actions)) {
        for (const item of recovery.actions) {
          if (!isRecord(item)) continue;
          const action = typeof item.action === "string" ? item.action : "action";
          const task = typeof item.taskId === "string" ? ` ${item.taskId}` : "";
          if (typeof item.instruction === "string") {
            lines.push(clip(theme.fg("toolOutput", `    ${action}${task}: ${item.instruction}`), width));
          }
          if (isRecord(item.bundle)) {
            lines.push(clip(theme.fg("dim", `      bundle: operation=${item.bundle.operationId} revision=${item.bundle.expectedRevision}`), width));
          }
        }
      }
    }
    lines.push(clip(theme.fg("muted", "  Note: non-ignored untracked included; ignored files excluded."), width));
    return lines;
  });
}

function isWaveProgressView(value: unknown): value is WaveProgressView {
  return isRecord(value)
    && typeof value.startedAt === "string"
    && typeof value.phase === "string"
    && typeof value.message === "string"
    && Array.isArray(value.taskStatuses);
}

/**
 * Build a selective checkpoint: start from the pre-wave parent baseline
 * and update only the paths that were successfully landed by the wave.
 * Untouched pre-wave differences remain as differences for parent review.
 *
 * Ownership-safe: if the parent already changed a path before the wave
 * (baseline→pre-wave differs), leave the baseline entry so parent review
 * later sees baseline→final (safe duplicate review).
 *
 * Uses absolute path matching to handle nested cwd path mapping correctly.
 * `sourceRoot` is the Git top-level (captureRoot) used for resolving applied paths.
 */
function buildSelectiveCheckpoint(
  preWaveBaseline: WorkspaceSnapshot,
  preWaveSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
  wavePaths: string[],
  sourceRoot: string,
): { snapshot: WorkspaceSnapshot; parentOwnedOverlapPaths: string[] } {
  // Build a set of absolute paths that were landed by the wave.
  // Use sourceRoot (Git top-level) for resolving applied paths, not afterSnapshot.cwd.
  const waveAbsolutePaths = new Set<string>();
  for (const relPath of wavePaths) {
    const absPath = resolve(sourceRoot, relPath);
    waveAbsolutePaths.add(absPath);
  }

  // Start from the pre-wave baseline files.
  const mergedFiles = new Map(preWaveBaseline.files);
  const parentOwnedOverlapPaths: string[] = [];

  // For each wave path, determine ownership:
  // - If baseline→pre-wave state was unchanged (parent didn't touch it),
  //   checkpoint the post-wave entry.
  // - If parent already changed that path, leave the original baseline entry
  //   so parent review later sees baseline→final (safe duplicate review).
  for (const [key, afterFile] of afterSnapshot.files) {
    if (!waveAbsolutePaths.has(afterFile.absolutePath)) {
      continue;
    }

    const baselineFile = preWaveBaseline.files.get(key);
    const preWaveFile = preWaveSnapshot.files.get(key);

    // Check if parent changed this path between baseline and pre-wave.
    const parentChanged = isParentOwnedChange(baselineFile, preWaveFile);

    if (parentChanged) {
      // Parent already changed this path — leave baseline entry.
      parentOwnedOverlapPaths.push(afterFile.relativePath);
    } else {
      // Parent did not change this path — checkpoint the post-wave entry.
      mergedFiles.set(key, afterFile);
    }
  }

  // Handle deletions: if a wave path was in the pre-wave baseline but not
  // in the after snapshot, check ownership before removing.
  for (const [key, baselineFile] of preWaveBaseline.files) {
    if (!waveAbsolutePaths.has(baselineFile.absolutePath)) {
      continue;
    }
    if (!afterSnapshot.files.has(key)) {
      // Path was deleted by the wave.
      const preWaveFile = preWaveSnapshot.files.get(key);
      const parentChanged = isParentOwnedChange(baselineFile, preWaveFile);

      if (parentChanged) {
        // Parent already changed this path — leave baseline entry.
        // The relative path is from the baseline file.
        parentOwnedOverlapPaths.push(baselineFile.relativePath);
      } else {
        // Parent did not change this path — remove from merged (wave deletion).
        mergedFiles.delete(key);
      }
    }
  }

  return {
    snapshot: {
      cwd: preWaveBaseline.cwd,
      capturedAt: afterSnapshot.capturedAt,
      files: mergedFiles,
    },
    parentOwnedOverlapPaths,
  };
}

/**
 * Check if the parent changed a path between baseline and pre-wave.
 * Handles add/delete semantics: if the file was absent in baseline but present
 * in pre-wave (or vice versa), the parent changed it.
 */
function isParentOwnedChange(
  baselineFile: FileSnapshot | undefined,
  preWaveFile: FileSnapshot | undefined,
): boolean {
  // Both absent — no change.
  if (!baselineFile && !preWaveFile) return false;
  // One absent, one present — parent added or deleted.
  if (!baselineFile || !preWaveFile) return true;
  // Both present — compare content and key metadata.
  return baselineFile.content !== preWaveFile.content
    || baselineFile.sha256 !== preWaveFile.sha256
    || baselineFile.isBinary !== preWaveFile.isBinary;
}
