import { externalAgentCatalog, externalAgentSupportsExecution, type ReviewGateConfig } from "../config";
import { activeExchangeBaseline, checkpointReviewWindow } from "../state";
import type { ReviewGateState } from "../state";
import { createWorkspaceSnapshot, type FileSnapshot, type WorkspaceSnapshot } from "../capture";
import { resolve } from "node:path";
import { scopedModelChoices } from "../settings/models";
import { executeSubtask, type ExecuteSubtaskInput, type SubtaskPacket } from "./controller";
import type { SubtaskProgressPhase, SubtaskProgressUpdate } from "./types";
import { executeWave, type WaveControllerInput, type WaveResult, type WaveProgressUpdate } from "./wave-controller";
import { WaveCaptureError } from "./wave-repository";
import type { WaveWorkerTask } from "./wave-worker";

const TOOL_NAME = "execute_subtask";
const BATCH_TOOL_NAME = "execute_subtasks";

interface ExecutionToolManagerInput {
  pi: unknown;
  config: ReviewGateConfig;
  state: ReviewGateState;
  cwd: () => string;
  notify?: (message: string) => void | Promise<void>;
}

interface SubtaskProgressView extends SubtaskProgressUpdate {
  title: string;
  startedAt: string;
  activity: string[];
}

export class ExecutionToolManager {
  private registered = false;
  private running = false;

  constructor(private readonly input: ExecutionToolManagerInput) {}

  sync(): void {
    const active = this.input.config.execution?.activeExecutor;
    const resolvable = active?.source === "little-coder"
      || (active?.source === "external"
        && Boolean(externalAgentCatalog(this.input.config).some((agent) => agent.id === active.id && externalAgentSupportsExecution(agent))));
    if (resolvable && !this.registered) {
      this.register();
    }
    if (this.registered) {
      setToolActive(this.input.pi, TOOL_NAME, Boolean(resolvable));
      // execute_subtasks is active only when parallelEnabled is true.
      const parallelEnabled = this.input.config.execution?.parallelEnabled === true;
      setToolActive(this.input.pi, BATCH_TOOL_NAME, Boolean(resolvable && parallelEnabled));
    }
  }

  private register(): void {
    if (!isRecord(this.input.pi) || typeof this.input.pi.registerTool !== "function") {
      return;
    }
    this.input.pi.registerTool({
      name: TOOL_NAME,
      label: "Execute Subtask",
      description: "Run one bounded implementation phase in the configured isolated executor, then apply the configured review gate before returning.",
      promptSnippet: "Delegate one bounded implementation phase to the configured isolated executor",
      promptGuidelines: [
        "For multi-step implementation, use execute_subtask for one bounded serial phase at a time and wait for its result before choosing the next phase.",
        "Do not duplicate an execute_subtask executor's completed edits; if you intervene with your own edits, they are parent-owned.",
      ],
      executionMode: "sequential",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "instructions", "acceptanceCriteria"],
        properties: {
          title: { type: "string", minLength: 1, description: "Short name for this implementation phase." },
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
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: ((result: unknown) => void) | undefined,
        ctx: unknown,
      ) => {
        if (this.running) {
          return toolResult({
            kind: "blocked",
            summary: "Another execute_subtask invocation is already active. Wait for it to finish.",
          }, true);
        }
        const task = normalizeTask(params);
        if (!task) {
          return toolResult({ kind: "blocked", summary: "Invalid execute_subtask parameters." }, true);
        }
        const scopedModels = (scopedModelChoices(ctx) ?? []).map((choice) => choice.model);
        const modelError = validateInternalModel(this.input.config, scopedModels);
        if (modelError) {
          return toolResult({ kind: "blocked", summary: modelError }, true);
        }
        const progress: SubtaskProgressView = {
          title: task.title,
          startedAt: new Date().toISOString(),
          phase: "starting",
          message: "preparing delegated execution",
          activity: ["preparing delegated execution"],
        };
        const publish = (update?: SubtaskProgressUpdate) => {
          if (update) {
            Object.assign(progress, update);
            if (progress.activity.at(-1) !== update.message) {
              progress.activity.push(update.message);
              if (progress.activity.length > 40) progress.activity.splice(0, progress.activity.length - 40);
            }
          }
          onUpdate?.({
            content: [{ type: "text", text: `${phaseLabel(progress.phase)} · ${elapsed(progress.startedAt)} · ${progress.message}` }],
            details: { state: "running", progress: { ...progress, activity: [...progress.activity] } },
          });
        };
        publish();
        const ticker = onUpdate ? setInterval(() => publish(), 5_000) : undefined;
        ticker?.unref?.();
        this.running = true;
        try {
          const packet = await executeSubtask({
            task,
            cwd: extractCwd(ctx) ?? this.input.cwd(),
            config: this.input.config,
            parentState: this.input.state,
            scopedModels,
            signal,
            notify: this.input.notify,
            onUpdate: publish,
            appendJournal: (entry) => appendJournal(this.input.pi, entry),
          });
          return toolResult(packet, isFailure(packet));
        } finally {
          if (ticker) clearInterval(ticker);
          this.running = false;
        }
      },
      renderCall: (args: unknown, theme: ThemeLike) => renderSubtaskCall(args, theme),
      renderResult: (result: unknown, options: unknown, theme: ThemeLike) => renderSubtaskResult(result, options, theme),
    });

    // ── Register execute_subtasks (batch parallel tool) ──
    this.input.pi.registerTool({
      name: BATCH_TOOL_NAME,
      label: "Execute Subtasks (Parallel)",
      description: "Run multiple bounded implementation phases in parallel using the configured isolated executor, then integrate and land the results.",
      promptSnippet: "Delegate multiple bounded implementation phases to run in parallel via the configured isolated executor",
      promptGuidelines: [
        "Use execute_subtasks when tasks are independent and can run concurrently.",
        "Each task runs in an isolated worktree with its own review lifecycle.",
        "Results are integrated in declared order and landed into the source workspace.",
        "Non-ignored untracked files are included in the captured snapshot; ignored files are excluded.",
      ],
      executionMode: "sequential",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tasks"],
        properties: {
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
            maximum: 4,
            description: "Maximum concurrent workers (1..4, default 2).",
          },
          integratePartial: {
            type: "boolean",
            description: "When true, integrate eligible workers despite failed ones (default false).",
          },
        },
      },
      execute: async (
        _toolCallId: string,
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

        const batchInput = normalizeBatchInput(params);
        if (!batchInput) {
          return batchToolResult({
            summary: "Invalid execute_subtasks parameters. Ensure tasks is a non-empty array (1..16) with valid task objects.",
            isError: true,
          });
        }

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

        const publishWave = (update?: WaveProgressUpdate) => {
          if (update) {
            waveProgress.phase = update.phase;
            waveProgress.message = update.message;
            if (update.waveId) waveProgress.waveId = update.waveId;
            if (update.waveRoot) waveProgress.waveRoot = update.waveRoot;
            if (update.baseCommit) waveProgress.baseCommit = update.baseCommit;
            if (update.maxWorkers) waveProgress.maxWorkers = update.maxWorkers;
            if (update.counts) waveProgress.counts = update.counts;
            if (update.activity) {
              waveProgress.activity.push(...update.activity);
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
            ?? 2;
          const waveInput: WaveControllerInput = {
            cwd,
            tasks,
            config: this.input.config,
            scopedModels,
            maxWorkers: effectiveMaxWorkers,
            integratePartial: batchInput.integratePartial,
            signal,
            onProgress: publishWave,
          };

          // Capture pre-wave snapshot immediately before executeWave for ownership-aware checkpoint.
          const preWaveSnapshot = await createWorkspaceSnapshot(cwd, {
            maxFileBytes: this.input.config.maxFileBytes,
            maxSnapshotBytes: this.input.config.maxSnapshotBytes,
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
                summary: `Wave capture failed [${err.code}]: ${err.message}`,
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
          return batchToolResult({
            summary: `Wave ${waveResult.waveId} completed: ${summaryLines}`,
            waveId: waveResult.waveId,
            waveRoot: waveResult.waveRoot,
            phase: waveResult.phase,
            taskResults: waveResult.taskResults,
            integration: waveResult.integration,
            landing: waveResult.landing,
            parentOwnedOverlapPaths,
            isError,
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

function renderSubtaskCall(args: unknown, theme: ThemeLike) {
  const task = isRecord(args) && typeof args.title === "string" ? args.title : "delegated phase";
  return textComponent((width) => [
    theme.fg("toolTitle", theme.bold("execute_subtask ")) + theme.fg("accent", clip(task, width - 20)),
  ]);
}

function renderSubtaskResult(result: unknown, options: unknown, theme: ThemeLike) {
  const value = isRecord(result) ? result : {};
  const details = isRecord(value.details) ? value.details : {};
  const expanded = isRecord(options) && options.expanded === true;
  const progress = isProgressView(details.progress) ? details.progress : undefined;
  if (progress) {
    return textComponent((width) => {
      const lines = [
        `${theme.fg("warning", "◌")} ${theme.fg("accent", phaseLabel(progress.phase))}${theme.fg("muted", ` · ${elapsed(progress.startedAt)}`)}`,
        `  ${theme.fg("toolOutput", clip(progress.message, width - 4))}`,
      ];
      if (expanded) {
        if (progress.model || progress.adapter) {
          lines.push(theme.fg("dim", clip(
            `  executor: ${progress.model ?? progress.adapter}${progress.adapter && progress.model ? ` [${progress.adapter}]` : ""}`,
            width,
          )));
        }
        if (progress.reviewers?.length) {
          lines.push(theme.fg("dim", clip(`  reviewers: ${progress.reviewers.join(", ")}`, width)));
        }
        if (progress.subtaskId) lines.push(theme.fg("dim", clip(`  subtask: ${progress.subtaskId}`, width)));
        if (progress.artifactDir) lines.push(theme.fg("dim", clip(`  artifacts: ${progress.artifactDir}`, width)));
        lines.push("", theme.fg("toolTitle", "  Recent activity"));
        for (const message of progress.activity.slice(-12)) {
          lines.push(`  ${theme.fg("toolOutput", clip(message, width - 4))}`);
        }
      } else {
        lines.push(theme.fg("muted", "  (Ctrl+O to expand live activity)"));
      }
      return lines;
    });
  }

  const kind = typeof details.kind === "string" ? details.kind : "completed";
  const failed = value.isError === true || !["accepted", "completed_unreviewed"].includes(kind);
  return textComponent((width) => {
    const lines = [
      `${theme.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${theme.fg("accent", kind)}`,
    ];
    const summary = typeof details.summary === "string" ? details.summary : textContent(value.content);
    const summaryLines = summary.trim().split(/\r?\n/).filter(Boolean);
    const shown = expanded ? summaryLines : summaryLines.slice(0, 2);
    for (const line of shown) lines.push(`  ${theme.fg("toolOutput", clip(line, width - 4))}`);
    if (expanded && Array.isArray(details.changedFiles) && details.changedFiles.length > 0) {
      lines.push("", theme.fg("dim", clip(`  changed: ${details.changedFiles.join(", ")}`, width)));
    }
    if (expanded && typeof details.bundleDir === "string") {
      lines.push(theme.fg("dim", clip(`  artifacts: ${details.bundleDir}`, width)));
    }
    if (!expanded && (summaryLines.length > shown.length || details.bundleDir)) {
      lines.push(theme.fg("muted", "  (Ctrl+O to expand)"));
    }
    return lines;
  });
}

function textComponent(render: (width: number) => string[]) {
  return { render: (width: number) => render(Math.max(20, width - 2)), invalidate() {} };
}

function isProgressView(value: unknown): value is SubtaskProgressView {
  return isRecord(value)
    && typeof value.title === "string"
    && typeof value.startedAt === "string"
    && isProgressPhase(value.phase)
    && typeof value.message === "string"
    && Array.isArray(value.activity);
}

function isProgressPhase(value: unknown): value is SubtaskProgressPhase {
  return value === "starting"
    || value === "executing"
    || value === "reviewing"
    || value === "correcting"
    || value === "confirming"
    || value === "completing";
}

function phaseLabel(phase: SubtaskProgressPhase): string {
  return ({
    starting: "Starting",
    executing: "Executing",
    reviewing: "Reviewing",
    correcting: "Correcting",
    confirming: "Confirming review",
    completing: "Completing",
  })[phase];
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

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "").join("\n");
}

function toolResult(packet: Partial<SubtaskPacket> & { kind: string; summary: string }, isError: boolean): Record<string, unknown> {
  const lines = [
    `Subtask outcome: ${packet.kind}`,
    packet.summary,
    ...(packet.reviewStatus ? [`Review status: ${packet.reviewStatus}`] : []),
    ...(packet.changedFiles?.length ? [`Changed files: ${packet.changedFiles.join(", ")}`] : []),
    ...(packet.bundleDir ? [`Artifacts: ${packet.bundleDir}`] : []),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: packet,
    ...(isError ? { isError: true } : {}),
  };
}

function isFailure(packet: SubtaskPacket): boolean {
  return !["accepted", "completed_unreviewed"].includes(packet.kind);
}

function normalizeTask(value: unknown): ExecuteSubtaskInput | undefined {
  if (!isRecord(value)
    || typeof value.title !== "string"
    || typeof value.instructions !== "string"
    || !Array.isArray(value.acceptanceCriteria)
    || value.acceptanceCriteria.some((item) => typeof item !== "string")) {
    return undefined;
  }
  const title = value.title.trim();
  const instructions = value.instructions.trim();
  const acceptanceCriteria = value.acceptanceCriteria.map((item) => String(item).trim()).filter(Boolean);
  if (!title || !instructions || acceptanceCriteria.length === 0) {
    return undefined;
  }
  return {
    title,
    instructions,
    acceptanceCriteria,
    relevantContext: typeof value.relevantContext === "string" ? value.relevantContext.trim() || undefined : undefined,
  };
}

function validateInternalModel(config: ReviewGateConfig, scopedModels: string[]): string | undefined {
  const active = config.execution?.activeExecutor;
  if (active?.source !== "little-coder") {
    return undefined;
  }
  return scopedModels.includes(active.model)
    ? undefined
    : `Configured little-coder executor model is not in ctx.scopedModels: ${active.model}. Use /review-settings.`;
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
  tasks: Array<{
    title: string;
    instructions: string;
    acceptanceCriteria: string[];
    relevantContext?: string;
  }>;
  maxWorkers?: number;
  integratePartial?: boolean;
}

const ALLOWED_TOP_KEYS = new Set(["tasks", "maxWorkers", "integratePartial"]);
const ALLOWED_TASK_KEYS = new Set(["title", "instructions", "acceptanceCriteria", "relevantContext"]);

function normalizeBatchInput(value: unknown): NormalizedBatchInput | undefined {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    return undefined;
  }

  // Reject unknown top-level keys.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_TOP_KEYS.has(key)) return undefined;
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
    if (value.maxWorkers < 1 || value.maxWorkers > 4) {
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

  return { tasks: normalized, maxWorkers, integratePartial };
}

function isWaveTaskSuccess(status: string): boolean {
  return status === "accepted" || status === "completed_unreviewed" || status === "no_changes";
}

function wavePhaseLabel(phase: string): string {
  return ({
    capturing: "Capturing",
    working: "Working",
    settling: "Settling",
    integrating: "Integrating",
    planning: "Planning",
    landing: "Landing",
    completed: "Completed",
    aborted: "Aborted",
  })[phase] ?? phase;
}

function batchToolResult(input: {
  summary: string;
  isError: boolean;
  waveId?: string;
  waveRoot?: string;
  phase?: string;
  errorCode?: string;
  taskResults?: Array<{
    taskId: string;
    title: string;
    status: string;
    summary: string;
    error?: string;
    acceptedCommitSha?: string;
  }>;
  integration?: {
    status: string;
    validationStatus?: string;
    error?: string;
    worktree?: string;
    conflictingTaskId?: string;
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
}): Record<string, unknown> {
  const lines: string[] = [];
  if (input.waveId) lines.push(`Wave: ${input.waveId}`);
  if (input.waveRoot) lines.push(`Wave root: ${input.waveRoot}`);
  if (input.phase) lines.push(`Phase: ${input.phase}`);
  if (input.errorCode) lines.push(`Error code: ${input.errorCode}`);
  lines.push(input.summary);

  if (input.taskResults?.length) {
    lines.push("");
    lines.push("Task results:");
    for (const tr of input.taskResults) {
      const icon = isWaveTaskSuccess(tr.status) ? "✓" : "✗";
      lines.push(`  ${icon} ${tr.taskId} (${tr.status}): ${tr.title}`);
      if (tr.error) lines.push(`    error: ${tr.error}`);
    }
  }

  if (input.integration) {
    lines.push(`\nIntegration: ${input.integration.status}`);
    if (input.integration.validationStatus) lines.push(`  validation: ${input.integration.validationStatus}`);
    if (input.integration.error) lines.push(`  error: ${input.integration.error}`);
    if (input.integration.worktree) lines.push(`  worktree: ${input.integration.worktree}`);
    if (input.integration.conflictingTaskId) lines.push(`  conflict at: ${input.integration.conflictingTaskId}`);
    if (input.integration.conflictingPaths?.length) lines.push(`  conflicting paths: ${input.integration.conflictingPaths.join(", ")}`);
    if (input.integration.workerMappings?.length) {
      lines.push(`  worker mappings: ${input.integration.workerMappings.map((m) => `${m.taskId}#${m.integratedCommitSha.slice(0, 8)}`).join(", ")}`);
    }
    if (input.integration.successfullyIntegrated?.length) {
      lines.push(`  successfully integrated: ${input.integration.successfullyIntegrated.map((m) => `${m.taskId}#${m.integratedCommitSha.slice(0, 8)}`).join(", ")}`);
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

  lines.push("");
  lines.push("Note: Non-ignored untracked files are included; ignored files are excluded from the captured snapshot and landing.");

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      waveId: input.waveId,
      waveRoot: input.waveRoot,
      phase: input.phase,
      errorCode: input.errorCode,
      taskResults: input.taskResults,
      integration: input.integration,
      landing: input.landing,
      parentOwnedOverlapPaths: input.parentOwnedOverlapPaths,
      snapshotPolicy: "non-ignored untracked included; ignored files excluded",
    },
    ...(input.isError ? { isError: true } : {}),
  };
}

function renderBatchCall(args: unknown, theme: ThemeLike) {
  const count = isRecord(args) && Array.isArray(args.tasks) ? args.tasks.length : 0;
  return textComponent((width) => [
    clip(theme.fg("toolTitle", theme.bold("execute_subtasks ")) + theme.fg("accent", `${count} task(s)`), width),
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
  return textComponent((width) => {
    const lines = [
      clip(`${theme.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${theme.fg("accent", phase)}`, width),
    ];
    if (details.waveId) lines.push(clip(theme.fg("dim", `  wave: ${details.waveId}`), width));
    if (details.waveRoot) lines.push(clip(theme.fg("dim", `  root: ${details.waveRoot}`), width));

    if (Array.isArray(details.taskResults)) {
      lines.push(clip(theme.fg("toolTitle", "  Tasks"), width));
      for (const tr of details.taskResults) {
        const icon = isWaveTaskSuccess(tr.status) ? "✓" : "✗";
        lines.push(clip(`  ${icon} ${theme.fg("toolOutput", `${tr.taskId} (${tr.status}): ${tr.title}`)}`, width));
      }
    }

    if (details.integration) lines.push(clip(theme.fg("dim", `  integration: ${details.integration.status}`), width));
    if (details.landing) lines.push(clip(theme.fg("dim", `  landing: ${details.landing.status}`), width));
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
