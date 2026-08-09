import { externalAgentCatalog, externalAgentSupportsExecution, type ReviewGateConfig } from "../config";
import type { ReviewGateState } from "../state";
import { scopedModelChoices } from "../settings/models";
import { executeSubtask, type ExecuteSubtaskInput, type SubtaskPacket } from "./controller";

const TOOL_NAME = "execute_subtask";

interface ExecutionToolManagerInput {
  pi: unknown;
  config: ReviewGateConfig;
  state: ReviewGateState;
  cwd: () => string;
  notify?: (message: string) => void | Promise<void>;
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
            onUpdate: (message) => onUpdate?.({
              content: [{ type: "text", text: message }],
              details: { state: "running", message },
            }),
            appendJournal: (entry) => appendJournal(this.input.pi, entry),
          });
          return toolResult(packet, isFailure(packet));
        } finally {
          this.running = false;
        }
      },
    });
    this.registered = true;
  }
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
