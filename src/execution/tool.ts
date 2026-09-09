import { deferredPiToolsEnabled, externalAgentCatalog, externalAgentSupportsExecution, resolvedWorkerResources, type ReviewGateConfig } from "../config";
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
  type BackgroundTaskKind,
  type BackgroundTaskDefinition,
} from "./background-controller";
import type { ReattachmentBundle } from "./operation-record";
import { EVIDENCE_FILTERS, EVIDENCE_LIMIT_MAX, EvidenceCursorError, EvidenceNavigationError, type SubtaskEvidenceSelector } from "./subtask-evidence";
import {
  completionNotificationGuidanceLine,
  lifecycleWakeGuidanceLine,
  notificationModeContractProse,
  subtaskNotificationMode,
  terminalWakeGuidanceLine,
} from "./subtask-notifications";
import { randomUUID } from "node:crypto";
import { parseDuration } from "../background-shell/jobs";
import {
  assignExecutorToolCatalog,
  createExecutorToolCatalog,
  defaultExecutorInitialActiveTools,
  resolveExecutorToolCatalog,
} from "./tool-catalog";

const ACTIONS = ["start", "add", "inspect", "watch", "continue", "steer", "interrupt", "force_merge", "mark_clean"] as const;
type Action = typeof ACTIONS[number];

export const EXECUTION_TOOL_NAMES: Record<Action, string> = {
  start: "SubtasksStart",
  add: "SubtasksAdd",
  inspect: "SubtasksInspect",
  watch: "SubtasksWatch",
  continue: "SubtasksContinue",
  steer: "SubtasksSteer",
  interrupt: "SubtasksInterrupt",
  force_merge: "SubtasksForceMerge",
  mark_clean: "SubtasksMarkClean",
};

const EXECUTION_TOOL_NAME_LIST = ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action]);

const SHARED_PROMPT_GUIDELINES = [
  "Use SubtasksStart with an array of one or more bounded tasks and kind execute or research; retain the stable execution/task handles returned for every task.",
  "Use kind research for substantial independent read-only discovery that can proceed in the background. Use concurrent foreground read/web/shell calls for quick, shallow, or tightly coupled investigation, and continue useful foreground work while research runs.",
  "Research groups return reports and never land workspace changes. Execution groups review and land accepted changes.",
  "Use SubtasksAdd to top off a running execution without waiting for slower tasks.",
  "Each task captures main independently when dispatched and lands independently when accepted.",
  "Use SubtasksInspect for durable state and recent activity; artifact paths permit deeper rg-based investigation.",
  "Use SubtasksWatch only when a future one-shot checkpoint would be decision-relevant. It returns immediately, replaces any prior watch for that execution, cancels when an earlier completion/failure/conflict/recovery event arrives, and must be explicitly rearmed after firing. It is not a polling loop or recurring heartbeat.",
  "Use SubtasksSteer for queued, starting, or live tasks: queued steering is durably incorporated before startup and live steering uses the executor transport.",
  "SubtasksSteer accepts an optional interrupt boolean: true interrupts the task's active executor turn first and delivers the instructions to the same task and workspace without cancelling, landing, or terminating it; omitted or false preserves normal steering. If the adapter cannot interrupt an in-flight turn, the request reports a concrete unsupported status instead of claiming interruption.",
  "Steering wins over review: a steer received while reviewing interrupts that review, resumes the executor with the changed request, and reviews the replacement result.",
  "If an active adapter cannot steer its current long-running command, keep the steer queued for the next executor handoff; do not treat that transport limitation as rejection.",
  lifecycleWakeGuidanceLine(),
  "SubtasksInspect always requires an explicit taskId, even for a single-task execution; for every other operation a taskId may be omitted only when the supplied executionId contains exactly one task, otherwise use the returned taskId.",
  completionNotificationGuidanceLine(),
  "Start/add distinguish tasks already assigned for executor startup from tasks still waiting for capacity. Completion events report durable phase timing, execution revision, peak concurrency on final completion, and estimated post-settlement capacity for SubtasksAdd.",
  "A conflicted result means main contains conflict markers and automatic landings are blocked. Resolve it immediately and call SubtasksMarkClean.",
  "Use SubtasksForceMerge only for a stopped task with a verified checkpoint; mergeAnyhow may intentionally materialize conflicts in main. Every force-merge outcome requires manual inspection of the main workspace and never proves the requested changes are present or correct.",
  "A request to cancel or stop without landing means interrupt_as_failure. Use interrupt_with_merge only when the user explicitly wants a mechanical checkpoint landing; it never guarantees the requested changes are present or correct, so inspect the main workspace manually afterward in every case.",
  terminalWakeGuidanceLine(),
];

function toolDescription(action: Action): string {
  switch (action) {
    case "start":
      return "Start 1–16 durable background execution or read-only research subtasks and return stable execution/task handles immediately.";
    case "add":
      return "Add 1–16 durable background subtasks to an existing execution so freed capacity can be topped off.";
    case "inspect":
      return "Inspect durable execution-subtask state, recent activity, live controls, and artifact locations for an explicitly named task; taskId is required.";
    case "watch":
      return "Request one future one-shot checkpoint if an execution is still active after a specified duration.";
    case "continue":
      return "Continue a stopped background subtask from its verified checkpoint, optionally using an explicit reattachment bundle.";
    case "steer":
      return "Give new authoritative instructions to a queued, running, or reviewing background subtask.";
    case "interrupt":
      return "Interrupt a queued or active background subtask as failure; execute tasks may explicitly request checkpoint landing.";
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
    case "watch": return "Use SubtasksWatch for one deliberate future checkpoint; it is one-shot and must be explicitly rearmed.";
    case "continue": return "Resume stopped work from a verified checkpoint with SubtasksContinue.";
    case "steer": return "Change queued or in-flight work with SubtasksSteer, optionally interrupting the active turn first (interrupt: true); steering supersedes review.";
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
  /** Full parent authorization when the top-level active schema is deferred. */
  authorizedTools?: () => string[] | undefined;
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
  kind?: BackgroundTaskKind;
  bundle?: ReattachmentBundle;
  instructions?: string;
  instructionId?: string;
  interruptMode?: "interrupt_as_failure" | "interrupt_with_merge";
  /** Steer only: interrupt the active executor turn before delivery (issue #63). */
  interrupt?: boolean;
  mergeAnyhow?: boolean;
  offset?: number;
  lines?: number;
  evidence?: SubtaskEvidenceSelector;
  afterMs?: number;
}

export class ExecutionToolManager {
  private registered = false;
  private commandsRegistered = false;
  private launchAllowedExecutionTools: Set<string> | undefined;
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
    const pool = resolvedWorkerResources(this.input.config);
    const agents = externalAgentCatalog(this.input.config);
    const resolvable = pool.length > 0 && pool.every(({ selection }) =>
      selection.source === "pi"
      || agents.some((agent) => agent.id === selection.id && externalAgentSupportsExecution(agent)));
    if (resolvable && !this.registered) {
      this.register();
      const activeAtRegistration = activeToolSnapshot(this.input.pi);
      this.launchAllowedExecutionTools = new Set(
        activeAtRegistration?.filter((name) => EXECUTION_TOOL_NAME_LIST.includes(name as typeof EXECUTION_TOOL_NAME_LIST[number])) ?? [],
      );
    }
    if (!this.commandsRegistered) this.registerUserCommands();
    if (this.registered) {
      for (const name of EXECUTION_TOOL_NAME_LIST) {
        setToolActive(this.input.pi, name, resolvable && this.launchAllowedExecutionTools?.has(name) === true);
      }
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
            if (value !== undefined) await notifyUserCommand(ctx, this.input.notify, formatUserCommandResult(value), "info");
          } catch (error) {
            await notifyUserCommand(ctx, this.input.notify, `review gate: /${name} failed: ${messageOf(error)}`, "error");
          }
        },
      });
    };
    register("subtasks", "List background execute and research subtasks.", async () => this.controller.list());
    register("subtasks-view", "Toggle the live expanded execution-subtask view below the editor.", async (_args, ctx) => {
      await this.controller.toggleExpandedView(ctx);
      return undefined;
    });
    register("subtask-inspect", "Pick and inspect a background subtask; explicit IDs remain optional.", async (args, ctx) => {
      const [executionId, taskId] = words(args);
      if (executionId) return this.controller.inspectTask(executionId, taskId);
      const selected = await selectTask(this.controller, ctx, "Inspect background subtask");
      return selected ? this.controller.inspectTask(selected.executionId, selected.taskId) : undefined;
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
      const explicit = args.trim().length > 0;
      let executionId: string | undefined;
      let taskId: string | undefined;
      let instruction = "";
      if (explicit) {
        let rest: string;
        [executionId, rest] = splitFirst(args);
        [taskId, instruction] = splitFirst(rest);
        if (!executionId?.startsWith("exec-") || !taskId?.startsWith("task-") || !instruction.trim()) {
          throw new Error("usage: /subtask-steer <executionId> <taskId> <instruction>; or run /subtask-steer with no arguments to pick a task and enter the instruction interactively");
        }
      } else {
        const selected = await selectTask(this.controller, ctx, "Steer background subtask", (task) => ["queued", "capturing", "running", "reviewing"].includes(task.state));
        if (!selected) return undefined;
        executionId = selected.executionId;
        taskId = selected.taskId;
        const ui = commandUi(ctx);
        if (!ui?.input && !ui?.editor) throw new Error("interactive input is unavailable; use /subtask-steer <executionId> <taskId> <instruction>");
        instruction = (await ui.input?.("Steering instruction")) ?? (await ui.editor?.("Steering instruction", "")) ?? "";
        if (!instruction.trim()) return undefined;
      }
      return this.controller.steer({ executionId, taskId, instructions: instruction, instructionId: `user-steer-${randomUUID()}`, actor: "user" });
    });
    register("subtask-interrupt", "Pick a queued or active task to interrupt; explicit arguments remain optional.", async (args, ctx) => {
      let [executionId, taskId, mode] = words(args);
      if (!executionId || !taskId) {
        const selected = await selectTask(this.controller, ctx, "Interrupt background subtask", (task) => isInterruptibleTaskState(task.state));
        if (!selected) return undefined;
        executionId = selected.executionId;
        taskId = selected.taskId;
      }
      if (!mode) {
        const ui = commandUi(ctx);
        if (!ui) throw new Error("interactive selector is unavailable; use /subtask-interrupt <executionId> <taskId> <failure|merge>");
        const kind = this.controller.inspect(executionId, taskId).kind;
        const options = kind === "research"
          ? ["Interrupt as failure"]
          : ["Interrupt as failure", "Interrupt and merge checkpoint"];
        const selectedMode = await ui.select("Interrupt outcome", options);
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
        const selected = await selectTask(
          this.controller,
          ctx,
          "Force-merge execution subtask",
          (task, inspection) => inspection.kind === "execute" && Boolean(task.bundle) && isForceMergeCandidateTaskState(task.state),
        );
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
          const kind = normalized.kind ?? "execute";
          const inspection = await this.controller.start(this.withParentTools(normalized.tasks!, kind), kind);
          return backgroundResult("start", inspection, false, this.input.config);
        }
        case "add": {
          const kind = this.controller.inspect(normalized.executionId).kind;
          const inspection = await this.controller.add(normalized.executionId, this.withParentTools(normalized.tasks!, kind));
          return backgroundResult("add", inspection, false, this.input.config);
        }
        case "inspect": {
          // Finding 15: exact task handles also recover settled tasks whose
          // records were archived (lazily loaded and integrity-checked).
          const inspection = await this.controller.inspectTask(normalized.executionId, normalized.taskId, normalized.offset, normalized.lines, normalized.evidence);
          return backgroundResult("inspect", inspection, false);
        }
        case "watch": {
          const subscription = this.controller.watch(normalized.executionId, normalized.afterMs!);
          const replacement = subscription.replaced ? " It replaced the prior watch for this execution." : "";
          return result(
            `SubtasksWatch armed for ${subscription.executionId}; if work is still active after ${formatDuration(subscription.afterMs)}, one checkpoint notification will trigger a turn.${replacement} An earlier completion, failure, conflict, or recovery notification cancels it. Call SubtasksWatch again after it fires if another checkpoint is useful.`,
            { action: "watch", ...subscription },
            false,
          );
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
            interrupt: normalized.interrupt,
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
      // Issue #61: evidence selector/navigation failures (a mistyped entryId, an
      // unknown callId, a malformed or expired cursor, an out-of-range index) are
      // read-only and task-scoped. They must not leak unrelated executions'
      // inventory, IDs, titles, artifact paths, diagnostic markers, or recovery
      // history; return one concise, actionable diagnostic with a bounded
      // navigation hint instead of the full group packet. Genuine failures keep
      // the full diagnostic below.
      if (isEvidenceSelectorError(error)) {
        return result(
          [
            `${toolName} failed: ${diagnostic}`,
            evidenceRecoveryHint(normalized.taskId),
          ].join("\n"),
          {
            action: normalized.action,
            diagnostic,
            executionId: normalized.executionId,
            taskId: normalized.taskId,
            evidenceSelectorError: true,
          },
          true,
        );
      }
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

  private withParentTools(tasks: BackgroundTaskDefinition[], kind: BackgroundTaskKind): BackgroundTaskDefinition[] {
    const allowedTools = this.input.authorizedTools?.() ?? activeToolSnapshot(this.input.pi);
    if (!allowedTools) {
      throw new Error(`${kind === "research" ? "Research" : "Execution"} requires an authoritative parent active-tool snapshot; the current Pi host did not provide one.`);
    }
    const childTools = kind === "research" ? researchToolIntersection(allowedTools) : allowedTools;
    return tasks.map((task) => {
      // Validate any supplied contract, but preserve only an explicitly named
      // initial set. The authoritative parent snapshot always determines the
      // allowed ceiling; a supplied catalog is not an activation request.
      resolveExecutorToolCatalog(task);
      const explicitInitial = task.executorToolCatalog?.initialActiveTools;
      const catalog = createExecutorToolCatalog(
        childTools,
        explicitInitial ?? (deferredPiToolsEnabled(this.input.config)
          ? defaultExecutorInitialActiveTools(childTools)
          : childTools),
      );
      // Build the durable definition from known fields only: stale pre-cutover
      // keys on a supplied input never enter a new record.
      const definition: BackgroundTaskDefinition = {
        title: task.title,
        instructions: task.instructions,
        acceptanceCriteria: [...task.acceptanceCriteria],
        ...(task.relevantContext !== undefined ? { relevantContext: task.relevantContext } : {}),
        backgroundKind: kind,
        ...(task.authoritativeUpdates
          ? { authoritativeUpdates: task.authoritativeUpdates.map((item) => ({ ...item })) }
          : {}),
      };
      assignExecutorToolCatalog(definition, catalog);
      return definition;
    });
  }
}

/**
 * The research role allow policy. Also the planning-mode visibility policy at
 * the top level (plus read-only subtask observation controls): anything not on
 * this list is write-capable or execution control and stays out of plan/research.
 */
export const RESEARCH_ALLOWED_TOOLS = new Set([
  "read", "grep", "glob", "find", "ls", "WebFetch", "WebSearch", "BrowserExtract",
  // Research may use bounded diagnostics and observational hover, but
  // consequential click/form authority never enters the read-only role policy.
  "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserConsole", "BrowserNetwork", "BrowserInspect", "BrowserScreenshot",
  "BrowserScroll", "BrowserHover", "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
]);

function researchToolIntersection(parent: string[]): string[] {
  return parent.filter((tool) => RESEARCH_ALLOWED_TOOLS.has(tool));
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
  const inspectTaskId = { type: "string", minLength: 1, description: "Stable task handle. Required for inspection, even for single-task executions; use a handle returned by SubtasksStart/SubtasksAdd or shown in prior results." };
  const tasks = { type: "array", minItems: 1, maxItems: 16, items: taskSchema(), description: "One to sixteen bounded task definitions for the selected group kind." };
  const instructions = { type: "string", minLength: 1, description: "New authoritative direction for this operation." };
  const instructionId = { type: "string", minLength: 1, description: "Optional caller-provided idempotency handle." };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  switch (action) {
    case "start":
      properties.kind = {
        type: "string",
        enum: ["execute", "research"],
        description: "execute produces reviewed workspace changes that land; research is read-only and returns a report. Defaults to execute.",
      };
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
      properties.taskId = inspectTaskId;
      properties.offset = { type: "integer", minimum: 0, description: "Absolute activity offset for detailed inspection. Mutually exclusive with evidence." };
      properties.lines = { type: "integer", minimum: 1, maximum: 500, description: "Activity lines to return, up to 500. Mutually exclusive with evidence." };
      properties.evidence = {
        type: "object",
        additionalProperties: false,
        properties: {
          find: { type: "string", minLength: 1, description: "Case-insensitive search across the task's indexed executor evidence (tool calls/results, process outcomes, worker claims, reviewer findings). Returns bounded snippets; continue with entryId deep reads." },
          index: { type: "integer", minimum: 0, description: "Start position for a ranged evidence read (within the filtered sequence when filter is set)." },
          limit: { type: "integer", minimum: 1, maximum: EVIDENCE_LIMIT_MAX, description: `Entries per evidence read, up to ${EVIDENCE_LIMIT_MAX}.` },
          cursor: { type: "string", minLength: 1, description: "Opaque cursor from a prior unfiltered evidence read; returns only newer entries. Expired, replaced, or ambiguous cursors are rejected explicitly." },
          callId: { type: "string", minLength: 1, description: "Read one tool call and its linked result by pairing id (in-flight calls report no observed result)." },
          filter: { type: "string", enum: [...EVIDENCE_FILTERS], description: "Restrict evidence navigation to one category." },
          entryId: { type: "string", minLength: 1, description: "Deep-read one evidence entry's retained content in bounded chunks (continue with chunkIndex)." },
          chunkIndex: { type: "integer", minimum: 0, description: "Chunk number for an entryId deep read." },
        },
        description: "Bounded read-only navigation over the task's durable executor evidence. Mutually exclusive with offset/lines. Streams are observed data; worker claims never imply verification.",
      };
      required.push("taskId");
      break;
    case "watch":
      properties.executionId = executionId;
      properties.after = {
        type: "string",
        minLength: 1,
        description: "One-shot delay such as 30s, 15m, or 2h. Allowed range: 1 second through 7 days.",
      };
      required.push("executionId", "after");
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
      properties.interrupt = {
        type: "boolean",
        description: "Optional. When true, interrupt the task's active executor turn before delivering the instructions to the same task and workspace. Omitted or false preserves normal steering. This never cancels, lands, or terminates the task; an adapter that cannot interrupt an in-flight turn reports a concrete unsupported status.",
      };
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
  if (value.after !== undefined) {
    if (typeof value.after !== "string") throw new Error("after must be a duration string such as 30s, 15m, or 2h");
    const afterMs = parseDuration(value.after);
    if (afterMs === null || afterMs < 1_000 || afterMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error("after must be a duration from 1s through 168h");
    }
    normalized.afterMs = afterMs;
  }
  if (value.kind !== undefined) {
    if (value.kind !== "execute" && value.kind !== "research") throw new Error("kind must be execute or research");
    normalized.kind = value.kind;
  }
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
  if (value.interrupt !== undefined) {
    if (typeof value.interrupt !== "boolean") throw new Error("interrupt must be boolean");
    normalized.interrupt = value.interrupt;
  }
  if (value.evidence !== undefined) {
    normalized.evidence = normalizeEvidenceSelector(value.evidence);
    if (normalized.offset !== undefined || normalized.lines !== undefined) {
      throw new Error("evidence navigation is mutually exclusive with offset/lines activity paging");
    }
  }
  const allowed = allowedKeys(action);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${key} is not valid for action ${action}`);
  if ((action === "start" || action === "add") && !normalized.tasks) throw new Error(`${action} requires tasks`);
  if ((action === "continue" || action === "steer") && !normalized.instructions) throw new Error(`${action} requires instructions`);
  if ((action === "steer" || action === "interrupt" || action === "force_merge") && !normalized.executionId && !normalized.taskId) {
    throw new Error(`${action} requires executionId or taskId`);
  }
  if (action === "interrupt" && !normalized.interruptMode) throw new Error("interrupt requires interruptMode");
  if (action === "watch" && (!normalized.executionId || normalized.afterMs === undefined)) throw new Error("watch requires executionId and after");
  if (action === "inspect" && !normalized.taskId) {
    throw new Error("inspect requires an explicit taskId; use a stable task handle returned by SubtasksStart/SubtasksAdd or shown in prior inspection results");
  }
  return normalized;
}

function allowedKeys(action: Action): Set<string> {
  switch (action) {
    case "start": return new Set(["kind", "tasks"]);
    case "add": return new Set(["executionId", "tasks"]);
    case "inspect": return new Set(["executionId", "taskId", "offset", "lines", "evidence"]);
    case "watch": return new Set(["executionId", "after"]);
    case "continue": return new Set(["executionId", "taskId", "bundle", "instructions", "instructionId"]);
    case "steer": return new Set(["executionId", "taskId", "instructions", "instructionId", "interrupt"]);
    case "interrupt": return new Set(["executionId", "taskId", "interruptMode", "instructionId"]);
    case "force_merge": return new Set(["executionId", "taskId", "mergeAnyhow", "instructionId"]);
    case "mark_clean": return new Set();
  }
}

function normalizeEvidenceSelector(value: unknown): SubtaskEvidenceSelector {
  if (!isRecord(value)) throw new Error("evidence must be an object");
  const allowed = new Set(["find", "index", "limit", "cursor", "callId", "filter", "entryId", "chunkIndex"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`evidence.${key} is not a valid evidence navigation field`);
  }
  const selector: SubtaskEvidenceSelector = {};
  for (const name of ["find", "cursor", "callId", "entryId"] as const) {
    const fieldValue = value[name];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== "string" || fieldValue.length === 0) throw new Error(`evidence.${name} must be a non-empty string`);
    selector[name] = fieldValue;
  }
  if (value.filter !== undefined) {
    if (!EVIDENCE_FILTERS.includes(value.filter)) throw new Error(`evidence.filter must be one of: ${EVIDENCE_FILTERS.join(", ")}`);
    selector.filter = value.filter;
  }
  if (value.index !== undefined) selector.index = optionalInteger(value.index, "evidence.index", 0, Number.MAX_SAFE_INTEGER)!;
  if (value.limit !== undefined) selector.limit = optionalInteger(value.limit, "evidence.limit", 1, EVIDENCE_LIMIT_MAX)!;
  if (value.chunkIndex !== undefined) selector.chunkIndex = optionalInteger(value.chunkIndex, "evidence.chunkIndex", 0, Number.MAX_SAFE_INTEGER)!;
  const exclusiveModes = [selector.find, selector.cursor, selector.callId].filter((field) => field !== undefined).length;
  if (selector.entryId && exclusiveModes > 0) throw new Error("evidence.entryId cannot be combined with find/cursor/callId");
  if (exclusiveModes > 1) throw new Error("evidence.find, evidence.cursor, and evidence.callId are mutually exclusive");
  return selector;
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
  const notificationMode = subtaskNotificationMode(config ?? {} as ReviewGateConfig);
  const successVerb = inspection.kind === "research" ? "reports" : "lands";
  const notificationContract = notificationModeContractProse(notificationMode, successVerb);
  const scheduling = inspection.scheduling;
  const schedulingSummary = action === "start" || action === "add"
    ? ` Scheduler at acceptance: ${scheduling.dispatchAssigned} task(s) assigned and starting, ${scheduling.dispatchPending} still pending dispatch; ${scheduling.activeWorkers}/${scheduling.configuredWorkerLimit} global workers and ${scheduling.activePoolLeases}/${scheduling.configuredPoolCapacity} executor-pool slots are occupied; ${scheduling.estimatedImmediatelyAvailableSlots} slot(s) appear immediately available. Assignment is not proof that executor startup has completed.`
    : "";
  const toolName = EXECUTION_TOOL_NAMES[action];
  const summary = action === "start" || action === "add"
    ? `${toolName} accepted: ${inspection.kind} group ${inspection.executionId} has ${active} active task(s).${startupDelay}${schedulingSummary} Queued state and stable task handles are included below. ${notificationContract} Internal progress stays available in SubtasksInspect and /subtasks-view without triggering turns. DO NOT POLL for task-state changes. Do not create a timer, sleep job, repeated inspect loop, or other waiting surrogate; continue other work or yield. Use SubtasksInspect only when a current diagnostic snapshot is independently useful for a decision.`
    : action === "force_merge"
      ? `${toolName}: execution ${inspection.executionId}, ${active} active task(s). Force-merge only reports a mechanical landing attempt; always inspect the main workspace manually because it does not prove the requested changes are present or correct.`
    : action === "interrupt" && inspection.tasks.some((task) => task.commands.some((command) => command.action === "interrupt" && command.mode === "interrupt_with_merge"))
      ? `${toolName}: execution ${inspection.executionId}, ${active} active task(s). Interrupt-with-merge only attempted a mechanical checkpoint landing; always inspect the main workspace manually because this status does not prove the requested changes are present or correct.`
      : `${toolName}: ${inspection.kind} group ${inspection.executionId}, ${active} active task(s).`;
  return result(formatInspectionForModel(summary, inspection, action === "inspect"), { action, ...inspection }, isError);
}

function formatInspectionForModel(summary: string, inspection: BackgroundInspection, includeTiming = false): string {
  const lines = [summary];
  if (includeTiming) {
    const scheduling = inspection.scheduling;
    lines.push(
      `Execution diagnostics: revision ${inspection.revision}; peak concurrency ${inspection.peakConcurrency}.`,
      `Scheduler: ${scheduling.activeWorkers}/${scheduling.configuredWorkerLimit} workers active; ${scheduling.activePoolLeases}/${scheduling.configuredPoolCapacity} pool leases active; ${scheduling.dispatchPending} task(s) in this execution and ${scheduling.globallyDispatchPending} task(s) globally pending dispatch; ${scheduling.estimatedImmediatelyAvailableSlots} immediate slot(s) estimated.`,
    );
  }
  lines.push("Task handles (retain these for SubtasksSteer, SubtasksInterrupt, and SubtasksInspect):");
  if (inspection.archivedCount > 0) {
    lines.push(`  (${inspection.archivedCount} earlier settled task(s) are archived and not listed; SubtasksInspect with their taskId loads the integrity-checked archive.)`);
  }
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
    if (task.reportPath) lines.push(`  research report: ${task.reportPath}`);
    const command = task.commands.at(-1);
    if (command) lines.push(`  latest command: ${command.action} ${command.instructionId} · ${command.status}${command.error ? ` · ${command.error}` : ""}`);
    if (task.artifactDir) lines.push(`  artifacts: ${task.artifactDir}`);
    const activity = task.activity.slice(-3);
    if (activity.length > 0) {
      lines.push("  recent historical activity (earlier phases may be superseded; the current state/outcome above is authoritative):");
      for (const event of activity) lines.push(`  - ${event.sequence} · ${event.phase} · ${clipPlain(event.message, 500)}`);
    }
  }
  if (inspection.evidence) {
    const evidence = inspection.evidence;
    lines.push(
      `Evidence (${evidence.mode}): ${evidence.snapshot.totalEntries} indexed entr${evidence.snapshot.totalEntries === 1 ? "y" : "ies"} across ${evidence.snapshot.sources.length} source(s). Streams are observed data; worker claims never imply verification.`,
    );
    for (const source of evidence.snapshot.sources.slice(0, 8)) {
      lines.push(`  source: ${source.sourceId} · ${source.adapter}/${source.stream} · ${source.records} record(s)`);
    }
    if (evidence.snapshot.capability.toolEvidence === "unavailable") {
      lines.push(`  tool evidence unavailable: ${evidence.snapshot.capability.reason ?? "no tool records"}`);
    }
    for (const item of evidence.snapshot.unavailable.slice(0, 5)) {
      lines.push(`  unavailable: ${item.source ?? "task"} · ${item.reason} · ${clipPlain(item.detail, 300)}`);
    }
    const context = evidence.context;
    if (context) {
      if (context.state) lines.push(`  authoritative state: ${context.state}`);
      if (context.currentCommand) {
        lines.push(
          `  current command (in flight; result NOT yet observed): ${context.currentCommand.toolName ?? "tool"} ${clipPlain(context.currentCommand.preview, 200)}${context.currentCommand.elapsedMs !== undefined ? ` · running ~${Math.round(context.currentCommand.elapsedMs / 1000)}s` : ""} · entry ${context.currentCommand.entryId}`,
        );
      }
      if (context.assignment?.history.length) {
        const current = context.assignment.current ? `current: ${context.assignment.current.adapter ?? "?"}${context.assignment.current.model ? `/${context.assignment.current.model}` : ""}; ` : "";
        lines.push(`  assignments: ${current}${context.assignment.history.map((item) => `${item.reason}@${item.at.slice(0, 19)} (${item.adapter ?? "?"})`).join(", ")}`);
      }
      if (context.steering?.length) {
        lines.push(`  steering: ${context.steering.map((item) => `${item.action} ${item.instructionId} · ${item.status}`).join(", ")}`);
      }
      if (context.changedFiles) {
        const paths = context.changedFiles.untrackedPaths && context.changedFiles.untrackedPaths.length > 0
          ? `[tracked: ${context.changedFiles.trackedPaths.join(", ")} | untracked task files: ${context.changedFiles.untrackedPaths.join(", ")}]`
          : `paths: ${context.changedFiles.trackedPaths.join(", ") || "(none recorded)"}`;
        lines.push(`  changed files (${context.changedFiles.landingStatus}): ${paths} — ${clipPlain(context.changedFiles.note, 300)}`);
      }
      if (context.review) {
        lines.push(`  review: aggregate ${context.review.aggregate} over ${context.review.cycles} cycle(s); latest reviewers: ${context.review.reviewers.map((reviewer) => `${reviewer.reviewerId}=${reviewer.verdict}`).join(", ")}`);
      }
    }
    for (const entry of evidence.entries ?? []) {
      const meta = [
        entry.kind,
        entry.toolName,
        entry.status,
        entry.provenance,
        entry.at ? entry.at.slice(0, 19) : undefined,
      ].filter(Boolean).join(" · ");
      lines.push(`  [${entry.index}] ${entry.entryId} — ${meta}${entry.truncatedContent ? " · truncated" : ""}`);
      if (entry.preview) lines.push(`    ${clipPlain(entry.preview, 400)}`);
      if (entry.pairedWith) lines.push(`    paired with: ${entry.pairedWith}`);
    }
    if (evidence.nextIndex !== undefined) {
      lines.push(`  more entries available: continue the ranged read with index=${evidence.nextIndex}.`);
    }
    if (evidence.cursor) {
      lines.push(`  incremental continuation: pass this cursor back in a later inspect to receive only newer evidence (expired/replaced cursors are rejected explicitly): ${evidence.cursor}`);
    }
    if (evidence.matchSummary) {
      lines.push(`  matches for \"${clipPlain(evidence.matchSummary.query, 80)}\": ${evidence.matchSummary.totalMatches} total${evidence.matchSummary.matchesTruncated ? " (list truncated)" : ""}.`);
      for (const match of evidence.matches ?? []) {
        lines.push(`  match [${match.index}] ${match.entryId} (${match.kind}): ${clipPlain(match.snippet, 300)}`);
      }
    }
    if (evidence.deepContent) {
      const deep = evidence.deepContent;
      lines.push(`  deep read ${deep.entryId} · chunk ${deep.chunkIndex} · ${deep.contentBytes} retained byte(s)${deep.truncatedContent ? " · source record truncated at retention cap" : ""}:`);
      // #54: the model-visible deep read must preserve the retained text's own
      // whitespace — newlines, indentation, tabs, and blank lines (deliberate
      // redaction and disclosed retention limits excepted). Navigation already
      // bounds each chunk (EVIDENCE_DEEP_CHUNK_CHARS plus at most one unit for
      // a surrogate-pair boundary adjustment), so render it verbatim: any
      // secondary clipping here could silently drop content that the next
      // chunk no longer carries, and whitespace collapsing would flatten
      // multiline YAML, source code, diffs, and command output.
      for (const contentLine of deep.content.split("\n")) lines.push(`    ${contentLine}`);
      if (deep.note) lines.push(`  note: ${clipPlain(deep.note, 200)}`);
      if (deep.hasMore) lines.push(`  more content: continue with entryId=${deep.entryId} chunkIndex=${deep.nextChunk}.`);
    }
    if (evidence.callPair) {
      const pair = evidence.callPair;
      lines.push(`  call ${pair.call?.callId ?? "?"}: status ${pair.status}${pair.call ? ` · call [${pair.call.index}] ${clipPlain(pair.call.preview, 300)}` : " · no call record found"}`);
      if (pair.result) lines.push(`    result [${pair.result.index}] · ${pair.result.status ?? "unknown"}: ${clipPlain(pair.result.preview, 400)}`);
      else lines.push("    result: not observed yet (in flight). A later in-flight status is never evidence of success.");
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

/** True for read-only evidence selector/navigation failures: a mistyped entryId,
 * an unknown callId, a malformed or expired cursor, or an out-of-range index.
 * These are task-scoped and must not leak unrelated executions' state (#61). */
function isEvidenceSelectorError(error: unknown): boolean {
  return error instanceof EvidenceNavigationError || error instanceof EvidenceCursorError;
}

/** Bounded, task-scoped navigation hint for evidence selector failures. It names
 * only the authorized task and how to recover — never other executions' data. */
function evidenceRecoveryHint(taskId: string | undefined): string {
  const target = taskId ? `task ${taskId}` : "the task";
  return `Recover with a bounded read on ${target}: list entries (evidence.index/limit, optionally filter or find), then deep-read by the exact entryId or resolve a call by its real callId.`;
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
      const renderedTasks = details.tasks.slice(0, 8);
      for (const task of renderedTasks) {
        if (!isRecord(task)) continue;
        const title = isRecord(task.definition) && typeof task.definition.title === "string" ? task.definition.title : task.taskId;
        const state = task.state === "queued"
          ? task.dispatchState === "assigned_starting"
            ? "queued (executor assigned/startup)"
            : "queued (executor capacity wait)"
          : task.state ?? "unknown";
        lines.push(clip(`  ${String(task.taskId ?? "task")}  ${state}  ${title ?? "task"}`, width));
      }
      // Finding 15 (review pass 2): compact rendering is explicitly bounded,
      // so it must disclose what it omits — both unrendered inline tasks and
      // archive-only settled history.
      if (details.tasks.length > renderedTasks.length) {
        lines.push(clip(`  … ${details.tasks.length - renderedTasks.length} additional inline task(s) omitted from this compact rendering.`, width));
      }
      const archivedCount = typeof details.archivedCount === "number" ? details.archivedCount : 0;
      if (archivedCount > 0) {
        lines.push(clip(`  … ${archivedCount} earlier settled task(s) are archived; inspect by taskId for exact history.`, width));
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

function formatDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  return `${milliseconds / 1_000}s`;
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return value as number;
}

async function selectTask(
  controller: BackgroundExecutionController,
  ctx: unknown,
  title: string,
  predicate: (task: BackgroundInspection["tasks"][number], inspection: BackgroundInspection) => boolean = () => true,
): Promise<{ executionId: string; taskId: string } | undefined> {
  const ui = commandUi(ctx);
  if (!ui) throw new Error("this command requires an interactive selector UI or explicit IDs");
  const choices = controller.list().flatMap((inspection) => inspection.tasks
    .filter((task) => predicate(task, inspection))
    .map((task) => ({
      executionId: inspection.executionId,
      taskId: task.taskId,
      label: `${task.definition.title} · ${task.state} · ${task.taskId} · ${inspection.executionId}`,
    })));
  if (choices.length === 0) throw new Error("no matching background subtasks are available");
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
    const archivedCount = typeof inspection.archivedCount === "number" ? inspection.archivedCount : 0;
    lines.push(`${typeof inspection.kind === "string" ? inspection.kind : "background"} group ${inspection.executionId} (${inspection.activeCount ?? 0} active${archivedCount > 0 ? `, ${archivedCount} archived task(s) not listed; inspect by taskId for exact history` : ""})`);
    for (const task of inspection.tasks) {
      if (!isRecord(task)) continue;
      const title = isRecord(task.definition) && typeof task.definition.title === "string" ? task.definition.title : "task";
      lines.push(`  ${String(task.taskId)}  ${String(task.state)}  ${title}`);
      if (typeof task.summary === "string" && task.summary.trim()) lines.push(`    ${task.summary.trim()}`);
      if (Array.isArray(task.commands)) {
        const command = task.commands.at(-1);
        if (isRecord(command) && typeof command.action === "string" && typeof command.status === "string") {
          lines.push(`    latest command: ${command.action} ${command.status}${typeof command.error === "string" ? ` — ${command.error}` : ""}`);
        }
      }
    }
  }
  if (lines.length > 0) return `review gate subtasks:\n${lines.join("\n")}`;
  return `review gate subtasks: ${JSON.stringify(value)}`;
}

async function notifyUserCommand(
  ctx: unknown,
  fallback: ((message: string) => void | Promise<void>) | undefined,
  message: string,
  level: "info" | "error",
): Promise<void> {
  if (isRecord(ctx) && isRecord(ctx.ui) && typeof ctx.ui.notify === "function") {
    await ctx.ui.notify(message, level);
    return;
  }
  await fallback?.(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
