import { DEFAULT_SUBTASK_NOTIFICATION_MODE, externalAgentCatalog, externalAgentSupportsExecution, resolvedExecutorPool, type ReviewGateConfig } from "../config";
import type { ReviewGateState } from "../state";
import { scopedModelChoices } from "../settings/models";
import type { ExecutionAssociationsSnapshot } from "../session-state";
import {
  BackgroundExecutionController,
  isActiveTaskState,
  isForceMergeCandidateTaskState,
  isInterruptibleTaskState,
  type BackgroundInspection,
  type BackgroundReviewReadinessTask,
  type BackgroundTaskDefinition,
} from "./background-controller";
import type { ReattachmentBundle } from "./operation-record";
import { randomUUID } from "node:crypto";

const ACTIONS = ["start", "add", "inspect", "continue", "steer", "interrupt", "force_merge", "mark_clean"] as const;
type Action = typeof ACTIONS[number];

export const EXECUTION_TOOL_NAMES: Record<Action, string> = {
  start: "SubtasksStart",
  add: "SubtasksAdd",
  inspect: "SubtasksInspect",
  continue: "SubtasksContinue",
  steer: "SubtasksSteer",
  interrupt: "SubtasksInterrupt",
  force_merge: "SubtasksForceMerge",
  mark_clean: "SubtasksMarkClean",
};

const EXECUTION_TOOL_NAME_LIST = ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action]);

const SHARED_PROMPT_GUIDELINES = [
  "Use SubtasksStart with an array of one or more bounded tasks; retain the stable execution/task handles returned for every task.",
  "Use SubtasksAdd to top off a running execution without waiting for slower tasks.",
  "Each task captures main independently when dispatched and lands independently when accepted.",
  "Use SubtasksInspect for durable state and recent activity; artifact paths permit deeper rg-based investigation.",
  "Use SubtasksSteer for queued, starting, or live tasks: queued steering is durably incorporated before startup and live steering uses the executor transport.",
  "Steering wins over review: a steer received while reviewing interrupts that review, resumes the executor with the changed request, and reviews the replacement result.",
  "If an active adapter cannot steer its current long-running command, keep the steer queued for the next executor handoff; do not treat that transport limitation as rejection.",
  "The start/add result reports queued tasks. Quiet mode (the default) triggers orchestrator turns for each LANDED, FAILED, CONFLICTED, or other recovery-required task; Noisy mode additionally triggers RUNNING (steerable) and REVIEWING (steering can supersede review). CAPTURING, ACCEPTED, WAITING_TO_LAND, and LANDING remain visible in SubtasksInspect and /subtasks-view but do not trigger turns. DO NOT POLL for task-state changes and do not create a timer, sleep job, repeated inspect loop, or other waiting surrogate. Use SubtasksInspect only when a current diagnostic snapshot is independently useful for a decision.",
  "A taskId may be omitted only when the supplied executionId contains exactly one task; otherwise use the returned taskId.",
  "Every task landing triggers a notification and lists every sibling that has not landed, even in quiet mode, so freed capacity can be topped off immediately. Do not verify aggregate outputs until the execution-complete notification.",
  "Start/add distinguish tasks already assigned for executor startup from tasks still waiting for capacity. Completion events report durable phase timing, execution revision, peak concurrency on final completion, and estimated post-settlement capacity for SubtasksAdd.",
  "A conflicted result means main contains conflict markers and automatic landings are blocked. Resolve it immediately and call SubtasksMarkClean.",
  "Use SubtasksForceMerge only for a stopped task with a verified checkpoint; mergeAnyhow may intentionally materialize conflicts in main. Every force-merge outcome requires manual inspection of the main workspace and never proves the requested changes are present or correct.",
  "A request to cancel or stop without landing means interrupt_as_failure. Use interrupt_with_merge only when the user explicitly wants a mechanical checkpoint landing; it never guarantees the requested changes are present or correct, so inspect the main workspace manually afterward in every case.",
  "Each task completion, failure, and critical conflict triggers a model notification. Ordinary running/reviewing transitions do so only in noisy mode. Use SubtasksInspect whenever you need current status or diagnostics; avoid tight repetitive polling.",
];

function toolDescription(action: Action): string {
  switch (action) {
    case "start":
      return "Start 1–16 durable background execution subtasks and return stable execution/task handles immediately.";
    case "add":
      return "Add 1–16 durable background subtasks to an existing execution so freed capacity can be topped off.";
    case "inspect":
      return "Inspect durable execution-subtask state, recent activity, live controls, and artifact locations.";
    case "continue":
      return "Continue a stopped execution subtask from its verified checkpoint, optionally using an explicit reattachment bundle.";
    case "steer":
      return "Give new authoritative instructions to a queued, running, or reviewing execution subtask.";
    case "interrupt":
      return "Interrupt a queued or active execution subtask, either as failure or with an explicitly requested checkpoint landing.";
    case "force_merge":
      return "Mechanically attempt to land a stopped task's verified checkpoint; manual workspace inspection is always required afterward.";
    case "mark_clean":
      return "Validate that main-workspace conflict markers are resolved and wake queued independent landings.";
  }
}

function toolPromptSnippet(action: Action): string {
  switch (action) {
    case "start": return "Start bounded background implementation work with SubtasksStart.";
    case "add": return "Top off an existing background execution with SubtasksAdd.";
    case "inspect": return "Use SubtasksInspect for a decision-relevant diagnostic snapshot, never as a polling loop.";
    case "continue": return "Resume stopped work from a verified checkpoint with SubtasksContinue.";
    case "steer": return "Change queued or in-flight work with SubtasksSteer; steering supersedes review.";
    case "interrupt": return "Stop work with SubtasksInterrupt and choose the requested landing semantics explicitly.";
    case "force_merge": return "Use SubtasksForceMerge only for a stopped verified checkpoint, then inspect main manually.";
    case "mark_clean": return "After resolving materialized conflicts in main, call SubtasksMarkClean.";
  }
}

interface ExecutionToolManagerInput {
  pi: unknown;
  config: ReviewGateConfig;
  state: ReviewGateState;
  cwd: () => string;
  notify?: (message: string) => void | Promise<void>;
  onAssociationsChanged?: (associations: ExecutionAssociationsSnapshot) => void | Promise<void>;
  onExpandedViewChanged?: (expanded: boolean) => void | Promise<void>;
}

interface CommandUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  editor?(title: string, initial?: string): Promise<string | undefined>;
}

interface NormalizedInput {
  action: Action;
  executionId?: string;
  taskId?: string;
  tasks?: BackgroundTaskDefinition[];
  bundle?: ReattachmentBundle;
  instructions?: string;
  instructionId?: string;
  interruptMode?: "interrupt_as_failure" | "interrupt_with_merge";
  mergeAnyhow?: boolean;
  offset?: number;
  lines?: number;
}

export class ExecutionToolManager {
  private registered = false;
  private commandsRegistered = false;
  private readonly controller: BackgroundExecutionController;

  constructor(private readonly input: ExecutionToolManagerInput) {
    this.controller = new BackgroundExecutionController(input);
  }

  associations(): ExecutionAssociationsSnapshot {
    return this.controller.associations();
  }

  async restoreAssociations(value: ExecutionAssociationsSnapshot): Promise<void> {
    await this.controller.restore(value);
  }

  setScopedModels(models: readonly string[]): void {
    this.controller.setScopedModels(models);
  }

  setUiContext(ctx: unknown): void {
    this.controller.setUiContext(ctx);
  }

  criticalPrompt(): string | undefined {
    return this.controller.criticalPrompt();
  }

  reviewReadiness(): BackgroundReviewReadinessTask[] {
    return this.controller.reviewReadiness();
  }

  async shutdown(): Promise<void> {
    await this.controller.shutdown();
  }

  async detach(): Promise<void> {
    await this.controller.detach();
  }

  sync(): void {
    this.controller.syncUiPreferences();
    this.controller.refreshPool();
    const pool = resolvedExecutorPool(this.input.config);
    const agents = externalAgentCatalog(this.input.config);
    const resolvable = pool.length > 0 && pool.every(({ selection }) =>
      selection.source === "little-coder"
      || agents.some((agent) => agent.id === selection.id && externalAgentSupportsExecution(agent)));
    if (resolvable && !this.registered) this.register();
    if (!this.commandsRegistered) this.registerUserCommands();
    if (this.registered) {
      for (const name of EXECUTION_TOOL_NAME_LIST) setToolActive(this.input.pi, name, resolvable);
    }
  }

  private registerUserCommands(): void {
    if (!isRecord(this.input.pi) || typeof this.input.pi.registerCommand !== "function") return;
    const pi = this.input.pi;
    const register = (name: string, description: string, handler: (args: string, ctx: unknown) => Promise<unknown | undefined>) => {
      pi.registerCommand(name, {
        description,
        handler: async (args: string, ctx: unknown) => {
          try {
            const value = await handler(args, ctx);
            if (value !== undefined) await this.input.notify?.(formatUserCommandResult(value));
          } catch (error) {
            await this.input.notify?.(`review gate: /${name} failed: ${messageOf(error)}`);
          }
        },
      });
    };
    register("subtasks", "List background execution subtasks.", async () => this.controller.list());
    register("subtasks-view", "Toggle the live expanded execution-subtask view below the editor.", async (_args, ctx) => {
      await this.controller.toggleExpandedView(ctx);
      return undefined;
    });
    register("subtask-inspect", "Pick and inspect an execution subtask; explicit IDs remain optional.", async (args, ctx) => {
      const [executionId, taskId] = words(args);
      if (executionId) return this.controller.inspect(executionId, taskId);
      const selected = await selectTask(this.controller, ctx, "Inspect execution subtask");
      return selected ? this.controller.inspect(selected.executionId, selected.taskId) : undefined;
    });
    register("subtask-add", "Pick an execution and add JSON task definitions; explicit arguments remain optional.", async (args, ctx) => {
      let [executionId, json] = splitFirst(args);
      const ui = commandUi(ctx);
      if (!executionId) executionId = await selectExecution(this.controller, ctx, "Add tasks to execution");
      if (!executionId) return undefined;
      if (!json) {
        if (!ui?.editor && !ui?.input) throw new Error("interactive editor/input is unavailable; use /subtask-add <executionId> <task-or-array-json>");
        json = (await ui.editor?.("Task JSON (one object or an array)", ""))
          ?? (await ui.input?.("Task JSON (one object or an array)"))
          ?? "";
      }
      if (!json.trim()) return undefined;
      const parsed = JSON.parse(json) as unknown;
      const tasks = normalizeTasks(Array.isArray(parsed) ? parsed : [parsed]);
      return this.controller.add(executionId, tasks);
    });
    register("subtask-steer", "Pick and steer a queued, active, or reviewing task; explicit arguments remain optional.", async (args, ctx) => {
      let [executionId, rest] = splitFirst(args);
      let [taskId, instruction] = splitFirst(rest);
      if (!executionId || !taskId) {
        const selected = await selectTask(this.controller, ctx, "Steer execution subtask", (task) => ["queued", "capturing", "running", "reviewing"].includes(task.state));
        if (!selected) return undefined;
        executionId = selected.executionId;
        taskId = selected.taskId;
      }
      if (!instruction) {
        const ui = commandUi(ctx);
        if (!ui?.input && !ui?.editor) throw new Error("interactive input is unavailable; use /subtask-steer <executionId> <taskId> <instruction>");
        instruction = (await ui.input?.("Steering instruction")) ?? (await ui.editor?.("Steering instruction", "")) ?? "";
      }
      if (!instruction.trim()) return undefined;
      return this.controller.steer({ executionId, taskId, instructions: instruction, instructionId: `user-steer-${randomUUID()}`, actor: "user" });
    });
    register("subtask-interrupt", "Pick a queued or active task to interrupt; explicit arguments remain optional.", async (args, ctx) => {
      let [executionId, taskId, mode] = words(args);
      if (!executionId || !taskId) {
        const selected = await selectTask(this.controller, ctx, "Interrupt execution subtask", (task) => isInterruptibleTaskState(task.state));
        if (!selected) return undefined;
        executionId = selected.executionId;
        taskId = selected.taskId;
      }
      if (!mode) {
        const ui = commandUi(ctx);
        if (!ui) throw new Error("interactive selector is unavailable; use /subtask-interrupt <executionId> <taskId> <failure|merge>");
        const selectedMode = await ui.select("Interrupt outcome", ["Interrupt as failure", "Interrupt and merge checkpoint"]);
        if (!selectedMode) return undefined;
        mode = selectedMode === "Interrupt and merge checkpoint" ? "merge" : "failure";
      }
      if (!["failure", "merge"].includes(mode)) {
        throw new Error("mode must be failure or merge");
      }
      return this.controller.interrupt({
        executionId,
        taskId,
        mode: mode === "merge" ? "interrupt_with_merge" : "interrupt_as_failure",
        instructionId: `user-interrupt-${randomUUID()}`,
        actor: "user",
      });
    });
    register("subtask-force-merge", "Mechanically land a stopped checkpoint, then manually inspect the workspace; explicit arguments remain optional.", async (args, ctx) => {
      let [executionId, taskId, mode] = words(args);
      const explicitTarget = Boolean(executionId && taskId);
      if (!executionId || !taskId) {
        const selected = await selectTask(this.controller, ctx, "Force-merge execution subtask", (task) => Boolean(task.bundle) && isForceMergeCandidateTaskState(task.state));
        if (!selected) return undefined;
        executionId = selected.executionId;
        taskId = selected.taskId;
      }
      if (!mode) {
        if (explicitTarget) mode = "clean";
        else {
        const ui = commandUi(ctx);
        if (!ui) throw new Error("interactive selector is unavailable; use /subtask-force-merge <executionId> <taskId> [anyhow]");
        const selectedMode = await ui.select("Force-merge mode", ["Clean merge only", "Merge anyhow and materialize conflicts"]);
        if (!selectedMode) return undefined;
        mode = selectedMode === "Merge anyhow and materialize conflicts" ? "anyhow" : "clean";
        }
      }
      if (mode !== "clean" && mode !== "anyhow") {
        throw new Error("mode must be clean or anyhow");
      }
      return this.controller.forceMerge({
        executionId,
        taskId,
        mergeAnyhow: mode === "anyhow",
        instructionId: `user-force-merge-${randomUUID()}`,
        actor: "user",
      });
    });
    register("subtask-mark-clean", "Validate resolved conflict markers and resume queued landings.", async () => this.controller.markClean());
    this.commandsRegistered = true;
  }

  private register(): void {
    if (!isRecord(this.input.pi) || typeof this.input.pi.registerTool !== "function") return;
    for (const action of ACTIONS) {
      const name = EXECUTION_TOOL_NAMES[action];
      this.input.pi.registerTool({
        name,
        label: name,
        description: toolDescription(action),
        promptSnippet: toolPromptSnippet(action),
        promptGuidelines: SHARED_PROMPT_GUIDELINES,
        executionMode: "sequential",
        parameters: toolSchema(action),
        execute: async (toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) =>
          this.executeAction(action, name, toolCallId, params, ctx),
        renderCall: (args: unknown, theme: ThemeLike) => renderCall(name, action, args, theme),
        renderResult: (value: unknown, options: unknown, theme: ThemeLike) => renderResult(value, options, theme),
      });
    }
    this.registered = true;
  }

  private async executeAction(action: Action, toolName: string, toolCallId: string, params: unknown, ctx: unknown): Promise<Record<string, unknown>> {
    this.controller.setUiContext(ctx);
    const models = scopedModelChoices(ctx)?.map((choice) => choice.model);
    if (models) this.controller.setScopedModels(models);
    let normalized: NormalizedInput;
    try {
      normalized = normalizeInput(action, params);
    } catch (error) {
      return result(`Invalid ${toolName} request: ${messageOf(error)}`, { diagnostic: messageOf(error) }, true);
    }
    const instructionId = normalized.instructionId ?? toolCallId;
    try {
      switch (normalized.action) {
        case "start": {
          const inspection = await this.controller.start(this.withParentTools(normalized.tasks!));
          return backgroundResult("start", inspection, false, this.input.config);
        }
        case "add": {
          const inspection = await this.controller.add(normalized.executionId, this.withParentTools(normalized.tasks!));
          return backgroundResult("add", inspection, false, this.input.config);
        }
        case "inspect": {
          const inspection = this.controller.inspect(normalized.executionId, normalized.taskId, normalized.offset, normalized.lines);
          return backgroundResult("inspect", inspection, false);
        }
        case "continue": {
          const inspection = await this.controller.continueTask({
            executionId: normalized.executionId,
            taskId: normalized.taskId,
            bundle: normalized.bundle,
            instructions: normalized.instructions!,
            instructionId,
            actor: "model",
          });
          return backgroundResult("continue", inspection, false);
        }
        case "steer": {
          const inspection = await this.controller.steer({
            executionId: normalized.executionId,
            taskId: normalized.taskId!,
            instructions: normalized.instructions!,
            instructionId,
            actor: "model",
          });
          return backgroundResult("steer", inspection, false);
        }
        case "interrupt": {
          const inspection = await this.controller.interrupt({
            executionId: normalized.executionId,
            taskId: normalized.taskId!,
            mode: normalized.interruptMode!,
            instructionId,
            actor: "model",
          });
          return backgroundResult("interrupt", inspection, false);
        }
        case "force_merge": {
          const inspection = await this.controller.forceMerge({
            executionId: normalized.executionId,
            taskId: normalized.taskId!,
            mergeAnyhow: normalized.mergeAnyhow === true,
            instructionId,
            actor: "model",
          });
          return backgroundResult("force_merge", inspection, false);
        }
        case "mark_clean": {
          const cleared = await this.controller.markClean();
          return result(
            cleared.cleared
              ? `Conflict gate cleared for ${cleared.paths.length} path(s); queued landings are waking automatically.`
              : "No workspace conflict gate is active.",
            cleared,
            false,
          );
        }
      }
    } catch (error) {
      const diagnostic = messageOf(error);
      const inspections = safeList(this.controller);
      const recovery = recoveryFor(normalized.action, diagnostic);
      const sourceWorkspace = this.controller.criticalPrompt()
        ? { disposition: "conflicted", instruction: this.controller.criticalPrompt()! }
        : { disposition: "unchanged_or_independently_landed", instruction: "Inspect task-specific landing state before claiming changes are in main." };
      const failureSummary = [
        `${toolName} failed: ${diagnostic}`,
        `Source workspace: ${sourceWorkspace.disposition}. ${sourceWorkspace.instruction}`,
        "Recovery guidance:",
        ...recovery.map((item) => `- ${item.action}: ${item.instruction}`),
        ...inspections.map((inspection) => formatInspectionForModel(`Durable execution state for ${inspection.executionId}:`, inspection, true)),
      ].join("\n");
      return result(failureSummary, {
        action: normalized.action,
        diagnostic,
        executionId: normalized.executionId,
        taskId: normalized.taskId,
        recovery,
        executions: inspections,
        sourceWorkspace,
      }, true);
    }
  }

  private withParentTools(tasks: BackgroundTaskDefinition[]): BackgroundTaskDefinition[] {
    const allowedTools = activeToolSnapshot(this.input.pi);
    return tasks.map((task) => ({
      ...task,
      acceptanceCriteria: [...task.acceptanceCriteria],
      executorAllowedTools: allowedTools ? [...allowedTools] : undefined,
    }));
  }
}

function taskSchema(): Record<string, unknown> {
  const task = {
    type: "object",
    additionalProperties: false,
    required: ["title", "instructions", "acceptanceCriteria"],
    properties: {
      title: { type: "string", minLength: 1 },
      instructions: { type: "string", minLength: 1 },
      acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      relevantContext: { type: "string" },
    },
  };
  return task;
}

function toolSchema(action: Action): Record<string, unknown> {
  const executionId = { type: "string", minLength: 1, description: "Stable execution handle returned by SubtasksStart, SubtasksAdd, or SubtasksInspect." };
  const taskId = { type: "string", minLength: 1, description: "Stable task handle. May be omitted only when the execution contains exactly one task." };
  const tasks = { type: "array", minItems: 1, maxItems: 16, items: taskSchema(), description: "One to sixteen bounded execution-subtask definitions." };
  const instructions = { type: "string", minLength: 1, description: "New authoritative direction for this operation." };
  const instructionId = { type: "string", minLength: 1, description: "Optional caller-provided idempotency handle." };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  switch (action) {
    case "start":
      properties.tasks = tasks;
      required.push("tasks");
      break;
    case "add":
      properties.executionId = executionId;
      properties.tasks = tasks;
      required.push("tasks");
      break;
    case "inspect":
      properties.executionId = executionId;
      properties.taskId = taskId;
      properties.offset = { type: "integer", minimum: 0, description: "Absolute activity offset for detailed inspection." };
      properties.lines = { type: "integer", minimum: 1, maximum: 500, description: "Activity lines to return, up to 500." };
      break;
    case "continue":
      properties.executionId = executionId;
      properties.taskId = taskId;
      properties.bundle = reattachmentSchema();
      properties.instructions = instructions;
      properties.instructionId = instructionId;
      required.push("instructions");
      break;
    case "steer":
      properties.executionId = executionId;
      properties.taskId = taskId;
      properties.instructions = instructions;
      properties.instructionId = instructionId;
      required.push("instructions");
      break;
    case "interrupt":
      properties.executionId = executionId;
      properties.taskId = taskId;
      properties.interruptMode = {
        type: "string",
        enum: ["interrupt_as_failure", "interrupt_with_merge"],
        description: "interrupt_as_failure stops without landing. interrupt_with_merge mechanically attempts to land a stopped checkpoint only when explicitly requested; it does not guarantee the requested changes are present or correct, and the main workspace must always be inspected afterward.",
      };
      properties.instructionId = instructionId;
      required.push("interruptMode");
      break;
    case "force_merge":
      properties.executionId = executionId;
      properties.taskId = taskId;
      properties.mergeAnyhow = { type: "boolean", description: "Allow ordinary conflict markers to be materialized. Every force-merge attempt requires manual workspace inspection afterward." };
      properties.instructionId = instructionId;
      break;
    case "mark_clean":
      break;
  }
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

function reattachmentSchema(): Record<string, unknown> {
  return {
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
  };
}

function normalizeInput(action: Action, value: unknown): NormalizedInput {
  if (!isRecord(value)) throw new Error("request must be an object");
  const normalized: NormalizedInput = {
    action,
    executionId: optionalString(value.executionId, "executionId"),
    taskId: optionalString(value.taskId, "taskId"),
    instructions: optionalString(value.instructions, "instructions"),
    instructionId: optionalString(value.instructionId, "instructionId"),
    offset: optionalInteger(value.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
    lines: optionalInteger(value.lines, "lines", 1, 500),
  };
  if (value.bundle !== undefined) normalized.bundle = normalizeBundle(value.bundle);
  if (value.tasks !== undefined) normalized.tasks = normalizeTasks(value.tasks);
  if (value.interruptMode !== undefined) {
    if (value.interruptMode !== "interrupt_as_failure" && value.interruptMode !== "interrupt_with_merge") throw new Error("invalid interruptMode");
    normalized.interruptMode = value.interruptMode;
  }
  if (value.mergeAnyhow !== undefined) {
    if (typeof value.mergeAnyhow !== "boolean") throw new Error("mergeAnyhow must be boolean");
    normalized.mergeAnyhow = value.mergeAnyhow;
  }
  const allowed = allowedKeys(action);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${key} is not valid for action ${action}`);
  if ((action === "start" || action === "add") && !normalized.tasks) throw new Error(`${action} requires tasks`);
  if ((action === "continue" || action === "steer") && !normalized.instructions) throw new Error(`${action} requires instructions`);
  if ((action === "steer" || action === "interrupt" || action === "force_merge") && !normalized.executionId && !normalized.taskId) {
    throw new Error(`${action} requires executionId or taskId`);
  }
  if (action === "interrupt" && !normalized.interruptMode) throw new Error("interrupt requires interruptMode");
  return normalized;
}

function allowedKeys(action: Action): Set<string> {
  switch (action) {
    case "start": return new Set(["tasks"]);
    case "add": return new Set(["executionId", "tasks"]);
    case "inspect": return new Set(["executionId", "taskId", "offset", "lines"]);
    case "continue": return new Set(["executionId", "taskId", "bundle", "instructions", "instructionId"]);
    case "steer": return new Set(["executionId", "taskId", "instructions", "instructionId"]);
    case "interrupt": return new Set(["executionId", "taskId", "interruptMode", "instructionId"]);
    case "force_merge": return new Set(["executionId", "taskId", "mergeAnyhow", "instructionId"]);
    case "mark_clean": return new Set();
  }
}

function normalizeTasks(value: unknown): BackgroundTaskDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("tasks must contain 1..16 items");
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`tasks[${index}] must be an object`);
    for (const key of Object.keys(candidate)) {
      if (!["title", "instructions", "acceptanceCriteria", "relevantContext"].includes(key)) {
        throw new Error(`unsupported tasks[${index}] key ${key}`);
      }
    }
    const title = requiredString(candidate.title, `tasks[${index}].title`);
    const instructions = requiredString(candidate.instructions, `tasks[${index}].instructions`);
    if (!Array.isArray(candidate.acceptanceCriteria) || candidate.acceptanceCriteria.length === 0) throw new Error(`tasks[${index}].acceptanceCriteria is required`);
    const acceptanceCriteria = candidate.acceptanceCriteria.map((entry, criterion) => requiredString(entry, `tasks[${index}].acceptanceCriteria[${criterion}]`));
    const relevantContext = optionalString(candidate.relevantContext, `tasks[${index}].relevantContext`);
    return { title, instructions, acceptanceCriteria, relevantContext };
  });
}

function normalizeBundle(value: unknown): ReattachmentBundle {
  if (!isRecord(value) || value.version !== 1) throw new Error("bundle must be a version 1 reattachment bundle");
  return {
    version: 1,
    operationId: requiredString(value.operationId, "bundle.operationId"),
    waveId: requiredString(value.waveId, "bundle.waveId"),
    taskId: requiredString(value.taskId, "bundle.taskId"),
    waveRoot: requiredString(value.waveRoot, "bundle.waveRoot"),
    expectedRevision: requiredInteger(value.expectedRevision, "bundle.expectedRevision", 0, Number.MAX_SAFE_INTEGER),
  };
}

function backgroundResult(
  action: Action,
  inspection: BackgroundInspection,
  isError: boolean,
  config?: ReviewGateConfig,
): Record<string, unknown> {
  const active = inspection.tasks.filter((task) => isActiveTaskState(task.state)).length;
  const startupDelay = action === "start" || action === "add"
    ? " Queued tasks may wait for executor startup or available pool capacity."
    : "";
  const notificationMode = config?.execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE;
  const notificationContract = notificationMode === "quiet"
    ? "Quiet notification mode is active: ordinary RUNNING and REVIEWING transitions remain passive UI telemetry. Every task still triggers a turn when it lands, fails, conflicts, or requires recovery, and landing events identify siblings that remain active."
    : "Noisy notification mode is active: RUNNING and REVIEWING transitions trigger turns in addition to every landed, failed, conflicted, or recovery-required task.";
  const scheduling = inspection.scheduling;
  const schedulingSummary = action === "start" || action === "add"
    ? ` Scheduler at acceptance: ${scheduling.dispatchAssigned} task(s) assigned and starting, ${scheduling.dispatchPending} still pending dispatch; ${scheduling.activeWorkers}/${scheduling.configuredWorkerLimit} global workers and ${scheduling.activePoolLeases}/${scheduling.configuredPoolCapacity} executor-pool slots are occupied; ${scheduling.estimatedImmediatelyAvailableSlots} slot(s) appear immediately available. Assignment is not proof that executor startup has completed.`
    : "";
  const toolName = EXECUTION_TOOL_NAMES[action];
  const summary = action === "start" || action === "add"
    ? `${toolName} accepted: execution ${inspection.executionId} has ${active} active task(s).${startupDelay}${schedulingSummary} Queued state and stable task handles are included below. ${notificationContract} Internal CAPTURING, ACCEPTED, WAITING_TO_LAND, and LANDING progress stays available in SubtasksInspect and /subtasks-view without triggering turns. DO NOT POLL for task-state changes. Do not create a timer, sleep job, repeated inspect loop, or other waiting surrogate; continue other work or yield. Use SubtasksInspect only when a current diagnostic snapshot is independently useful for a decision.`
    : action === "force_merge"
      ? `${toolName}: execution ${inspection.executionId}, ${active} active task(s). Force-merge only reports a mechanical landing attempt; always inspect the main workspace manually because it does not prove the requested changes are present or correct.`
    : action === "interrupt" && inspection.tasks.some((task) => task.commands.some((command) => command.action === "interrupt" && command.mode === "interrupt_with_merge"))
      ? `${toolName}: execution ${inspection.executionId}, ${active} active task(s). Interrupt-with-merge only attempted a mechanical checkpoint landing; always inspect the main workspace manually because this status does not prove the requested changes are present or correct.`
      : `${toolName}: execution ${inspection.executionId}, ${active} active task(s).`;
  return result(formatInspectionForModel(summary, inspection, action === "inspect"), { action, ...inspection }, isError);
}

function formatInspectionForModel(summary: string, inspection: BackgroundInspection, includeTiming = false): string {
  const lines = [summary, "Task handles (retain these for SubtasksSteer, SubtasksInterrupt, and SubtasksInspect):"];
  for (const task of inspection.tasks) {
    const control = task.liveControl
      ? `live control: steer ${task.liveControl.steer ? "yes" : "no"}, interrupt ${task.liveControl.interrupt ? "yes" : "no"}`
      : task.state === "queued"
        ? task.dispatchState === "assigned_starting" ? "executor assigned; startup in progress" : "waiting for executor capacity"
        : "no live control currently registered";
    lines.push(`- ${task.taskId} · ${task.definition.title} · ${task.state} · ${control}`);
    if (includeTiming) {
      lines.push(`  timing (ms): total ${task.timing.totalMs}; queued ${task.timing.queueMs}; capture ${task.timing.captureMs}; execution ${task.timing.executionMs}; review ${task.timing.reviewMs}; landing ${task.timing.landingMs}`);
    }
    if (task.summary) lines.push(`  current authoritative outcome: ${clipPlain(task.summary, 700)}`);
    const command = task.commands.at(-1);
    if (command) lines.push(`  latest command: ${command.action} ${command.instructionId} · ${command.status}${command.error ? ` · ${command.error}` : ""}`);
    if (task.artifactDir) lines.push(`  artifacts: ${task.artifactDir}`);
    const activity = task.activity.slice(-3);
    if (activity.length > 0) {
      lines.push("  recent historical activity (earlier phases may be superseded; the current state/outcome above is authoritative):");
      for (const event of activity) lines.push(`  - ${event.sequence} · ${event.phase} · ${clipPlain(event.message, 500)}`);
    }
  }
  return lines.join("\n");
}

function result(summary: string, details: unknown, isError: boolean): Record<string, unknown> {
  return { content: [{ type: "text", text: summary }], details, isError };
}

function recoveryFor(action: Action, diagnostic: string): Array<{ action: string; instruction: string }> {
  return [
    { action: "SubtasksInspect", instruction: "Inspect the execution/task state and full artifact paths before choosing recovery." },
    ...(action === "steer" ? [{ action: "SubtasksContinue", instruction: "If the live turn ended, continue from its verified checkpoint instead of assuming steering was delivered." }] : []),
    ...(diagnostic.includes("conflict") ? [{ action: "resolve_then_SubtasksMarkClean", instruction: "Resolve materialized conflict markers in main immediately, then call SubtasksMarkClean." }] : []),
  ];
}

function safeList(controller: BackgroundExecutionController): BackgroundInspection[] {
  try { return controller.list(); } catch { return []; }
}

interface ThemeLike {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

function renderCall(toolName: string, action: Action, args: unknown, theme: ThemeLike): unknown {
  const taskCount = isRecord(args) && Array.isArray(args.tasks) ? ` · ${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}` : "";
  return textComponent((width) => [clip(theme.fg("toolTitle", theme.bold(toolName)) + theme.fg("accent", taskCount || ` · ${action}`), width)]);
}

function renderResult(value: unknown, _options: unknown, theme: ThemeLike): unknown {
  const details = isRecord(value) && isRecord(value.details) ? value.details : undefined;
  const summary = isRecord(value) && Array.isArray(value.content) && isRecord(value.content[0]) && typeof value.content[0].text === "string"
    ? value.content[0].text
    : "No execution result.";
  return textComponent((width) => {
    const lines = [clip(theme.fg(isRecord(value) && value.isError ? "error" : "success", summary), width)];
    if (details && Array.isArray(details.tasks)) {
      for (const task of details.tasks.slice(0, 8)) {
        if (!isRecord(task)) continue;
        const title = isRecord(task.definition) && typeof task.definition.title === "string" ? task.definition.title : task.taskId;
        const state = task.state === "queued"
          ? task.dispatchState === "assigned_starting"
            ? "queued (executor assigned/startup)"
            : "queued (executor capacity wait)"
          : task.state ?? "unknown";
        lines.push(clip(`  ${String(task.taskId ?? "task")}  ${state}  ${title ?? "task"}`, width));
      }
    }
    return lines;
  });
}

function textComponent(render: (width: number) => string[]) {
  return { render: (width: number) => render(Math.max(20, width - 2)), invalidate() {} };
}

function clip(value: string, width: number): string {
  const compact = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
  return compact.length <= width ? compact : `${compact.slice(0, Math.max(1, width - 1))}…`;
}

function clipPlain(value: string, width: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= width ? compact : `${compact.slice(0, Math.max(1, width - 1))}…`;
}

function setToolActive(pi: unknown, name: string, active: boolean): void {
  if (!isRecord(pi)) return;
  if (typeof pi.setToolActive === "function") {
    pi.setToolActive(name, active);
    return;
  }
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const current = pi.getActiveTools();
  if (!Array.isArray(current) || !current.every((value) => typeof value === "string")) return;
  const next = active
    ? current.includes(name) ? current : [...current, name]
    : current.filter((value) => value !== name);
  pi.setActiveTools(next);
}

function activeToolSnapshot(pi: unknown): string[] | undefined {
  if (!isRecord(pi) || typeof pi.getActiveTools !== "function") return undefined;
  const current = pi.getActiveTools();
  if (!Array.isArray(current) || !current.every((value) => typeof value === "string")) return undefined;
  return [...new Set(current.map((value) => value.trim()).filter(Boolean))];
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, field, min, max);
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return value as number;
}

async function selectTask(
  controller: BackgroundExecutionController,
  ctx: unknown,
  title: string,
  predicate: (task: BackgroundInspection["tasks"][number]) => boolean = () => true,
): Promise<{ executionId: string; taskId: string } | undefined> {
  const ui = commandUi(ctx);
  if (!ui) throw new Error("this command requires an interactive selector UI or explicit IDs");
  const choices = controller.list().flatMap((inspection) => inspection.tasks
    .filter(predicate)
    .map((task) => ({
      executionId: inspection.executionId,
      taskId: task.taskId,
      label: `${task.definition.title} · ${task.state} · ${task.taskId} · ${inspection.executionId}`,
    })));
  if (choices.length === 0) throw new Error("no matching execution subtasks are available");
  const selected = await ui.select(title, choices.map((choice) => choice.label));
  const choice = choices.find((candidate) => candidate.label === selected);
  return choice ? { executionId: choice.executionId, taskId: choice.taskId } : undefined;
}

async function selectExecution(
  controller: BackgroundExecutionController,
  ctx: unknown,
  title: string,
): Promise<string | undefined> {
  const ui = commandUi(ctx);
  if (!ui) throw new Error("this command requires an interactive selector UI or an explicit executionId");
  const choices = controller.list().map((inspection) => ({
    executionId: inspection.executionId,
    label: `${inspection.executionId} · ${inspection.activeCount} active · ${inspection.historicalCount} total`,
  }));
  if (choices.length === 0) throw new Error("no execution groups are available");
  const selected = await ui.select(title, choices.map((choice) => choice.label));
  return choices.find((choice) => choice.label === selected)?.executionId;
}

function commandUi(ctx: unknown): CommandUi | undefined {
  return isRecord(ctx) && isRecord(ctx.ui) && typeof ctx.ui.select === "function"
    ? ctx.ui as CommandUi
    : undefined;
}

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function splitFirst(value: string): [string | undefined, string] {
  const trimmed = value.trim();
  if (!trimmed) return [undefined, ""];
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? [trimmed, ""] : [trimmed.slice(0, boundary), trimmed.slice(boundary).trim()];
}

function formatUserCommandResult(value: unknown): string {
  const inspections = Array.isArray(value) ? value : [value];
  const lines: string[] = [];
  for (const inspection of inspections) {
    if (!isRecord(inspection) || typeof inspection.executionId !== "string" || !Array.isArray(inspection.tasks)) continue;
    lines.push(`execution ${inspection.executionId} (${inspection.activeCount ?? 0} active)`);
    for (const task of inspection.tasks) {
      if (!isRecord(task)) continue;
      const title = isRecord(task.definition) && typeof task.definition.title === "string" ? task.definition.title : "task";
      lines.push(`  ${String(task.taskId)}  ${String(task.state)}  ${title}`);
      if (typeof task.summary === "string" && task.summary.trim()) lines.push(`    ${task.summary.trim()}`);
    }
  }
  if (lines.length > 0) return `review gate subtasks:\n${lines.join("\n")}`;
  return `review gate subtasks: ${JSON.stringify(value)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
