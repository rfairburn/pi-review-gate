import { externalAgentCatalog, externalAgentSupportsExecution, type ReviewGateConfig } from "../config";
import type { ReviewGateState } from "../state";
import { scopedModelChoices } from "../settings/models";
import { executeSubtask, type ExecuteSubtaskInput, type SubtaskPacket } from "./controller";
import type { SubtaskProgressPhase, SubtaskProgressUpdate } from "./types";

const TOOL_NAME = "execute_subtask";

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
