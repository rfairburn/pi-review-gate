import { deferredPiToolsEnabled, externalAgentCatalog, externalAgentSupportsExecution, resolvedWorkerResources, type ReviewGateConfig, type ScheduledTaskReviewOverride } from "../config";
import { editNativeTextField } from "../native-text-field";
import type { NativeEditorCustomFactory, NativeEditorFactory } from "../native-editor-bridge";
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
  type BackgroundTaskKind,
} from "./background-controller";
import type { ReattachmentBundle } from "./operation-record";
import { EVIDENCE_FILTERS, EVIDENCE_LIMIT_DEFAULT, EVIDENCE_LIMIT_MAX, EvidenceCursorError, EvidenceNavigationError, type SubtaskEvidenceSelector } from "./subtask-evidence";
import { redactSensitiveText } from "../redaction";
import { renderSubtaskResultCollapsed } from "./subtask-result-collapsed";
import { renderSubtaskResultExpanded } from "./subtask-result-expanded";
import {
  completionNotificationGuidanceLine,
  lifecycleWakeGuidanceLine,
  notificationModeContractProse,
  subtaskNotificationMode,
  terminalWakeGuidanceLine,
} from "./subtask-notifications";
import { randomUUID } from "node:crypto";
import { parseDuration } from "../background-shell/jobs";
import { expandableResult, EXPANDABLE_RESULT_MARKER, type ToolResultRenderCallback } from "../tool-result-expansion";
import { hasDispatchCardWatcher, watchDispatchCards } from "./dispatch-cards";
import {
  assignExecutorToolCatalog,
  createExecutorToolCatalog,
  defaultExecutorInitialActiveTools,
  resolveExecutorToolCatalog,
} from "./tool-catalog";
import { GIT_READ_TOOL_NAME } from "../git-read/tool";
import { isToolCallFingerprint, toolCallFingerprint, type StartLiveness, type SubmittedToolCallFingerprint } from "../tool-call-fingerprint";

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

/** #93: row-local native context.state guard key recording which execution a
 * rendered Start/Add card already watches for dispatch-driven invalidation. */
const DISPATCH_WATCH_STATE_KEY = "__piReviewGateDispatchWatchExecutionId";

/**
 * #93 weak row ownership: the global dispatch registry must never strongly
 * retain a native renderer callback — such a closure retains the host row, and
 * the registry outlives rows. These module-level helpers (deliberately outside
 * any render invocation so no closure can capture a native context) keep only
 * a WeakRef to the row's per-row state object; the current native invalidate
 * is looked up on the weak map at event time, and finalization releases the
 * subscription once a detached row is collected.
 */
const rowInvalidators = new WeakMap<object, () => void>();
const retiredRows = new FinalizationRegistry<() => void>((unsubscribe) => unsubscribe());

function subscribeWeakRow(executionId: string, owner: WeakRef<object>): () => void {
  const token = {};
  const unsubscribe = watchDispatchCards(executionId, () => {
    const row = owner.deref();
    if (row) rowInvalidators.get(row)?.();
    else unsubscribe();
  });
  const row = owner.deref();
  if (row) retiredRows.register(row, unsubscribe, token);
  return () => {
    retiredRows.unregister(token);
    unsubscribe();
  };
}

const SHARED_PROMPT_GUIDELINES = [
  "Use SubtasksStart with an array of one or more bounded tasks and kind execute or research; retain the stable execution/task handles returned for every task.",
  "Prefer beneficial parallelism over idle capacity: launch independent ready work concurrently when its expected time or primary-context benefit outweighs dispatch, review, and integration costs. Capacity is an opportunity, not a utilization target — there is no minimum task count or obligation to manufacture work, and waiting or serial execution is correct when nothing useful and independent is ready.",
  "Construct bounded tasks: one concrete, coherent outcome per subtask with explicit boundaries, invariants, and observable acceptance criteria. Minimize simultaneous unresolved decisions without assuming which model serves the worker; resolve architectural uncertainty before dispatching dependent implementation slices; keep genuinely dependent source-writing slices sequential and parallelize independent slices only when shared contracts are settled; do not fragment tightly coupled work merely to create more tasks.",
  "SubtasksStart accepts an optional top-level workspace string selecting an existing, explicitly authorized development checkout or Git worktree as the group's capture and landing destination; omitted or blank uses the parent session's working directory. The target is resolved once at start: every capture, reviewed landing, restore, continuation, and recovery path uses it, SubtasksAdd inherits the group's target, and steering never retargets it. Each task still gets its own isolated worktree captured from the target; several workers may land into the same target, and separate groups may target different repositories concurrently under the shared global capacity limits.",
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
  "Start/add distinguish tasks already assigned for executor startup from tasks still waiting for capacity. Completion events report the COMPLETE verdict or not-yet-complete sibling list, plus the estimated top-off opportunity for SubtasksAdd when scheduling information is available. Use SubtasksInspect for the durable execution revision, peak concurrency, and per-phase task timing instead of expecting them in completion notifications.",
  "A conflicted result means main contains conflict markers and automatic landings are blocked. Resolve it immediately and call SubtasksMarkClean.",
  "Use SubtasksForceMerge on a stopped execute task to land its verified checkpoint, or — when no ordinary checkpoint exists (for example after an attached-HEAD checkpoint failure, interruption, or failed critical state) — to salvage an identified snapshot of the worker's actual work from its retained worktree or surviving refs. An explicit force-merge merges ALL identified work in one call for every source kind: clean paths apply and ordinary text conflicts materialize standard diff3 markers that you then resolve and clear with SubtasksMarkClean; there is no clean-only mode and no second force option. A verified checkpoint is landed only when it carries all identified retained work; newer retained work supersedes it, and unorderable sources are surfaced as ambiguous instead of guessed. Salvage transfers only evidence-backed content, preserves conflicting and ambiguous target content, records forced-salvage provenance without fabricating review or a normal checkpoint, and never auto-lands deferred work afterward. Every force-merge outcome requires manual inspection of the main workspace and never proves the requested changes are present or correct.",
  "A request to cancel or stop without landing means interrupt_as_failure. Use interrupt_with_merge only when the user explicitly wants a mechanical checkpoint landing; it never guarantees the requested changes are present or correct, so inspect the main workspace manually afterward in every case.",
  terminalWakeGuidanceLine(),
];

function toolDescription(action: Action): string {
  switch (action) {
    case "start":
      return "Start 1–16 durable background execution or read-only research subtasks, optionally targeting an existing authorized checkout/worktree via workspace, and return stable execution/task handles immediately.";
    case "add":
      return "Add 1–16 durable background subtasks to an existing execution so freed capacity can be topped off.";
    case "inspect":
      return "Inspect durable execution-subtask state, recent activity, live controls, and artifact locations for an explicitly named task; taskId is required.";
    case "watch":
      return "Request one future one-shot checkpoint if an execution is still active after a specified duration.";
    case "continue":
      return "Continue a stopped background subtask from its verified checkpoint, optionally using an explicit reattachment bundle. Explicit inPlace: true instead continues a stopped execute task without a verified checkpoint in its exact retained worktree.";
    case "steer":
      return "Give new authoritative instructions to a queued, running, or reviewing background subtask.";
    case "interrupt":
      return "Interrupt a queued or active background subtask as failure; execute tasks may explicitly request checkpoint landing.";
    case "force_merge":
      return "Mechanically attempt to land a stopped task's verified checkpoint, or salvage an identified snapshot of its worker work when no ordinary checkpoint exists; manual workspace inspection is always required afterward.";
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
    case "force_merge": return "Use SubtasksForceMerge on a stopped task (verified checkpoint, or salvage when none exists), then inspect main manually.";
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
  /** Raw submitted identity for admitted native calls; UI/command starts synthesize it locally. */
  submittedFingerprintFor?: SubmittedToolCallFingerprint;
  /** Internal outcome signal for explicit returned errors from owned native tools. */
  onNativeToolError?: (toolCallId: string, toolName: string) => void;
}

interface CommandUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  /** Existing Pi confirmation dialog convention: `true` confirms, `false` or
   * dismissal (undefined) cancels. Optional because some hosts expose only
   * select/input/editor. */
  confirm?(title: string, message: string): Promise<boolean | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  editor?(title: string, initial?: string): Promise<string | undefined>;
  /** Host run mode ("tui" | "rpc" | ...), carried from the command context
   * for the shared native text field seam (issue #26). */
  mode?: string;
  /** Native editor bridge seams (Pi TUI hosts); delegated to the host UI. */
  custom?(factory: NativeEditorCustomFactory): Promise<string | undefined>;
  setEditorComponent?(factory: NativeEditorFactory | undefined): void;
  getEditorComponent?(): NativeEditorFactory | undefined;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

interface NormalizedInput {
  action: Action;
  executionId?: string;
  taskId?: string;
  tasks?: BackgroundTaskDefinition[];
  kind?: BackgroundTaskKind;
  /** Start only (#25): optional explicit execution target; blank normalizes to undefined. */
  workspace?: string;
  bundle?: ReattachmentBundle;
  instructions?: string;
  instructionId?: string;
  interruptMode?: "interrupt_as_failure" | "interrupt_with_merge";
  /** Steer only: interrupt the active executor turn before delivery (issue #63). */
  interrupt?: boolean;
  /** Continue only (#179): explicit same-worktree continuation without a verified checkpoint. */
  inPlace?: boolean;
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
  /**
   * Per-row dispatch subscription ownership, keyed by the renderer context's
   * per-row `state` object. Registry callbacks reference this owner weakly;
   * finalization releases subscriptions after detached rows are collected.
   */
  private static readonly rowUnsubscribes = new WeakMap<object, () => void>();
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

  /**
   * Issue #26: dispatch one scheduled entry through the ordinary subtask
   * start path. Reuses the same parent-authorization capture as
   * /subtask-add so a scheduled run gets exactly the same tool ceiling as
   * an interactive one — no model or orchestrator launch turn is involved.
   * Throws with actionable diagnostics when dispatch is impossible; the
   * scheduler runtime reports those instead of retrying silently.
   */
  async startScheduled(
    definition: BackgroundTaskDefinition,
    kind: BackgroundTaskKind,
    workspace: string | undefined,
    options: { scheduledTaskId: string; workerResourceId?: string; reviewOverride?: ScheduledTaskReviewOverride },
  ): Promise<BackgroundInspection> {
    const nativeInput = {
      tasks: [definition],
      ...(kind === "execute" ? {} : { kind }),
      ...(workspace !== undefined ? { workspace } : {}),
    };
    return this.controller.start(
      this.withParentTools([definition], kind),
      kind,
      workspace,
      { ...options, startCallFingerprint: toolCallFingerprint("SubtasksStart", nativeInput) },
    );
  }

  /** Issue #26: unsettled scheduled runs of one entry (overlap detection). */
  scheduledRuns(scheduledTaskId: string): ReturnType<BackgroundExecutionController["scheduledRuns"]> {
    return this.controller.scheduledRuns(scheduledTaskId);
  }

  startLiveness(fingerprint: string): StartLiveness {
    return this.controller.startLiveness(fingerprint);
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
    register("subtask-add", "Submit a subtask: the plain text argument is the raw instructions of one task in one new group immediately; no arguments opens the staged task form with an explicit submission step.", async (args, ctx) => {
      const trimmed = args.trim();
      // #120: no arguments opens the staged multi-field submission form
      // (new or existing group). This replaces the former pick-an-execution
      // flow, which only existed for the JSON path.
      if (!trimmed) return await this.subtaskAddForm(ctx);
      // #120 (correction): every nonblank argument is the raw task
      // instructions of exactly one task in one new default execution group —
      // including text that begins with an existing execution id, JSON-only
      // text, arrays, and prose or pasted code containing JSON. The human
      // command performs no JSON parsing or handle detection; structured
      // task submission stays on the model-facing SubtasksStart/SubtasksAdd
      // APIs, which are unchanged.
      await this.prepareCommandDispatch(ctx);
      const definition = plainTextSubtaskDefinition(trimmed);
      return await this.controller.start(
        this.withParentTools([definition], "execute"),
        "execute",
        undefined,
        { startCallFingerprint: toolCallFingerprint("SubtasksStart", { tasks: [definition] }) },
      );
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
        // The pre-bridge steering chain preserved on non-interactive hosts:
        // the single-line input first, the editor behind a cancelled input.
        // In an interactive TUI the shared native field seam presents the
        // host's own editor instead (issue #26).
        instruction = (await editNativeTextField(ui, "Steering instruction", "", { preferInputFirst: true })) ?? "";
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
    register("subtask-force-merge", "Merge all identified work of a stopped task into main — landing its verified checkpoint or salvaging identified worker work, materializing standard conflict markers for ordinary text conflicts in the same call — then manually inspect the workspace; explicit arguments remain optional.", async (args, ctx) => {
      let [executionId, taskId, legacyMode] = words(args);
      if (!executionId || !taskId) {
        const selected = await selectTask(
          this.controller,
          ctx,
          "Force-merge execution subtask",
          (task, inspection) => inspection.kind === "execute" && Boolean(task.waveRoot) && isForceMergeCandidateTaskState(task.state),
        );
        if (!selected) return undefined;
        executionId = selected.executionId;
        taskId = selected.taskId;
      }
      // A legacy third argument ("clean" | "anyhow") is still accepted for
      // compatibility; an explicit force-merge always merges all identified
      // work, so the value no longer changes behavior.
      if (legacyMode !== undefined && legacyMode !== "clean" && legacyMode !== "anyhow") {
        throw new Error("mode must be clean or anyhow");
      }
      return this.controller.forceMerge({
        executionId,
        taskId,
        mergeAnyhow: legacyMode === "anyhow",
        instructionId: `user-force-merge-${randomUUID()}`,
        actor: "user",
      });
    });
    register("subtask-mark-clean", "Validate resolved conflict markers and resume queued landings.", async () => this.controller.markClean({ actor: "user" }));
    this.commandsRegistered = true;
  }

  /** #120: command submissions reuse the tool path's context wiring so scoped
   * model routing and the live indicator stay authoritative and identical. */
  private async prepareCommandDispatch(ctx: unknown): Promise<void> {
    this.controller.setUiContext(ctx);
    const models = scopedModelChoices(ctx)?.map((choice) => choice.model);
    if (models) this.controller.setScopedModels(models);
  }

  /**
   * #120: the no-argument /subtask-add staged form. Every prompt stages one
   * field and fields are kept until explicit submission; cancellation at any
   * stage (a dismissed prompt) creates neither a task nor a group, and required
   * fields are validated before anything is submitted. New groups use the
   * SubtasksStart defaults (kind chosen in the form; an omitted or blank
   * workspace resolves to the current session workspace); existing groups
   * contribute their immutable kind and target workspace, which added tasks
   * inherit without retargeting. Submission routes through the same controller
   * Start/Add behavior and role routing the model tools use.
   */
  private async subtaskAddForm(ctx: unknown): Promise<BackgroundInspection | undefined> {
    await this.prepareCommandDispatch(ctx);
    const ui = commandUi(ctx);
    if (!ui || (!ui.input && !ui.editor)) {
      throw new Error("interactive form is unavailable; use /subtask-add <prompt> to submit one new group");
    }
    const destination = await ui.select("Submit a subtask", [
      "Create a new execution group",
      "Add to an existing execution group",
    ]);
    if (!destination) return undefined;

    if (destination === "Add to an existing execution group") {
      const groups = this.controller.list();
      if (groups.length === 0) {
        // Fail fast before collecting task fields: there is nothing to add to.
        throw new Error("no execution groups are available");
      }
      const labels = groups.map((inspection) =>
        `${inspection.executionId} · ${inspection.kind} · workspace ${inspection.cwd} · ${inspection.activeCount} active · ${inspection.historicalCount} total`);
      const selected = await ui.select("Existing execution group", labels);
      if (!selected) return undefined;
      const target = groups[labels.indexOf(selected)];
      if (!target) return undefined;
      const task = await this.formTaskFields(ui);
      if (!task) return undefined;
      // Explicit final submission step: nothing is dispatched until the staged
      // destination/task/settings are confirmed. Cancellation creates neither
      // a task nor a group. Added tasks inherit the group's immutable kind and
      // target workspace; the form never retargets the group.
      const confirmed = await this.confirmStagedSubmission(ui, {
        destination: `existing execution group ${target.executionId}`,
        kind: target.kind,
        workspace: target.cwd,
        task,
      });
      if (!confirmed) return undefined;
      return await this.controller.add(target.executionId, this.withParentTools([task], target.kind));
    }

    const task = await this.formTaskFields(ui);
    if (!task) return undefined;
    const kind = await ui.select("Execution kind", ["execute", "research"]);
    if (!kind) return undefined;
    if (kind !== "execute" && kind !== "research") throw new Error("kind must be execute or research");
    const workspace = await this.formPrompt(ui, "Target workspace (optional; leave blank to use the current session workspace)");
    if (workspace === undefined) return undefined;
    const resolvedWorkspace = workspace.trim();
    // Explicit final submission step: the staged destination, kind, workspace,
    // and task fields are shown for confirmation; nothing is dispatched until
    // the user explicitly submits, and cancellation creates no group.
    const confirmed = await this.confirmStagedSubmission(ui, {
      destination: "a new execution group",
      kind,
      workspace: resolvedWorkspace ? resolvedWorkspace : this.input.cwd(),
      task,
    });
    if (!confirmed) return undefined;
    const nativeInput = {
      kind,
      tasks: [task],
      ...(resolvedWorkspace ? { workspace: resolvedWorkspace } : {}),
    };
    return await this.controller.start(
      this.withParentTools([task], kind),
      kind,
      resolvedWorkspace ? resolvedWorkspace : undefined,
      { startCallFingerprint: toolCallFingerprint("SubtasksStart", nativeInput) },
    );
  }

  /** #120 (correction): the explicit final submission step of the staged
   * form. The complete staged input — destination, execution kind, target
   * workspace, and task fields — is summarized for confirmation and nothing
   * is dispatched until the user explicitly submits; cancellation or
   * dismissal creates neither a task nor a group. Uses the existing
   * confirm-dialog convention and fails closed when the host does not expose
   * it, before anything is submitted. */
  private async confirmStagedSubmission(
    ui: CommandUi,
    staged: { destination: string; kind: string; workspace: string; task: BackgroundTaskDefinition },
  ): Promise<boolean> {
    if (typeof ui.confirm !== "function") {
      throw new Error("interactive confirmation is unavailable; nothing was submitted; re-run in an interactive UI");
    }
    const message = [
      `destination: ${staged.destination}`,
      `kind: ${staged.kind}`,
      `workspace: ${staged.workspace}`,
      `title: ${staged.task.title}`,
      `instructions: ${staged.task.instructions}`,
      `acceptance criteria (${staged.task.acceptanceCriteria.length}): ${staged.task.acceptanceCriteria.join("; ")}`,
      ...(staged.task.relevantContext !== undefined ? [`relevant context: ${staged.task.relevantContext}`] : []),
    ].join("\n");
    return (await ui.confirm("Submit staged subtask?", message)) === true;
  }

  /** The staged task fields shared by both destinations: a required title,
   * instructions, and one or more acceptance criteria (one per line), plus
   * optional relevant context. Returns undefined when the user dismisses a
   * prompt; throws when a required field is blank, before anything is
   * submitted. */
  private async formTaskFields(ui: CommandUi): Promise<BackgroundTaskDefinition | undefined> {
    const title = await this.formPrompt(ui, "Task title");
    if (title === undefined) return undefined;
    if (!title.trim()) throw new Error("title is required; nothing was submitted");
    const instructions = await this.formPrompt(ui, "Task instructions");
    if (instructions === undefined) return undefined;
    if (!instructions.trim()) throw new Error("instructions are required; nothing was submitted");
    const criteriaText = await this.formPrompt(ui, "Acceptance criteria (one per line)");
    if (criteriaText === undefined) return undefined;
    const acceptanceCriteria = criteriaText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (acceptanceCriteria.length === 0) throw new Error("at least one acceptance criterion is required; nothing was submitted");
    const contextText = await this.formPrompt(ui, "Relevant context (optional; leave blank to omit)");
    if (contextText === undefined) return undefined;
    const relevantContext = contextText.trim() ? contextText.trim() : undefined;
    const [task] = normalizeTasks([{
      title,
      instructions,
      acceptanceCriteria,
      ...(relevantContext !== undefined ? { relevantContext } : {}),
    }]);
    return task;
  }

  /** One staged form prompt through the shared extension-field seam (issue
   * #26): in an interactive TUI the host-wired native editor bridge (the
   * host's own main-prompt editor, with native path completion for leading
   * `/` tokens and never slash-command items); on other hosts the multiline
   * editor, falling back to a single-line input only when no editor is
   * available — so cancelling the available prompt (undefined) is never
   * swallowed by a fallback prompt. */
  private async formPrompt(ui: CommandUi, title: string): Promise<string | undefined> {
    return editNativeTextField(ui, title, "");
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
        execute: async (toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) => {
          const result = await this.executeAction(action, name, toolCallId, params, ctx);
          if (result.isError === true) this.input.onNativeToolError?.(toolCallId, name);
          return result;
        },
        renderCall: (args: unknown, theme: ThemeLike) => renderCall(name, action, args, theme),
        // #93: the canonical collapsed callback (subtask-result-collapsed.ts)
        // is the shared helper's first argument and owns every non-expanded
        // state; the expanded detail callback (subtask-result-expanded.ts) is
        // the second. The native `options.expanded` flag selects between them,
        // the native `context.args` reaches both, and the shared wrapper adds
        // the single native-style hint to both states.
        // #93: the dispatch lifecycle preparation (watcher registration via
        // the native renderer context plus the live dispatch projection) runs
        // BEFORE routing to either renderer arm, so originally-expanded rows,
        // rows expanded later, and rows that stay expanded across a dispatch
        // all observe the refreshed projection identically.
        renderResult: this.lifecycleRoutedRenderResult(action, expandableResult(
          renderSubtaskResultCollapsed,
          renderSubtaskResultExpanded,
        )),
      });
    }
    this.registered = true;
  }

  /**
   * #93: wraps the shared expandableResult callback so Start/Add dispatch
   * lifecycle preparation runs before expansion routing:
   *
   * - Registers the rendered row once for dispatch-driven invalidation through
   *   Pi's native renderer context (`context.state` row-local guard plus
   *   `context.invalidate()`): when an actual dispatch event arrives, the row
   *   re-renders with the delivered prompt/worktree/base provenance — no extra
   *   inspection call, no expansion fetch, no polling, and no competing
   *   expansion state.
   * - Projects the controller's authoritative in-memory dispatch view into a
   *   renderer-only copy of the details (never mutating the model result) that
   *   reaches BOTH the collapsed and the expanded renderer, and refreshes
   *   `context.state.subtaskDispatchView` on every render so an expanded row
   *   never keeps a stale projection after invalidation.
   * - Every other action routes exactly as before.
   *
   * The wrapper is marked with the shared wiring marker because the shared
   * `expandableResult` mechanism remains the only expansion route underneath.
   */
  /**
   * Generic over the shared callback's native context type so the family
   * renderers' structural context (context.args et al.) flows through the
   * wrapper unchanged — no widening to `unknown` and no casts at the boundary.
   */
  private lifecycleRoutedRenderResult<TContext>(
    action: Action,
    expandable: ToolResultRenderCallback<ThemeLike, TContext>,
  ): ToolResultRenderCallback<ThemeLike, TContext> {
    const routed = (value: unknown, options: unknown, theme: ThemeLike, context?: TContext): unknown => {
      const prepared = this.prepareDispatchLifecycle(action, value, context);
      return expandable(prepared.value, options, theme, prepared.context);
    };
    (routed as unknown as Record<string, unknown>)[EXPANDABLE_RESULT_MARKER] = true;
    return routed;
  }

  /**
   * Presentation-only preparation for Start/Add rows. `context` is the native
   * renderer context of THIS row (Pi's ToolExecutionComponent passes a
   * per-row `state` object and a per-row `invalidate()` that re-runs this
   * exact renderResult); it is read structurally, never mutated beyond the
   * documented row-local keys, and returned as the same reference.
   */
  private prepareDispatchLifecycle<TContext>(
    action: Action,
    value: unknown,
    context?: TContext,
  ): { value: unknown; context?: TContext } {
    if (action !== "start" && action !== "add") return { value, context };
    const valueRecord = isRecord(value) ? value : undefined;
    const details = valueRecord && isRecord(valueRecord.details) ? valueRecord.details : undefined;
    const executionId = details && typeof details.executionId === "string" ? details.executionId : undefined;
    if (!executionId) return { value, context };
    const ctx = isRecord(context) ? context : undefined;
    const state = ctx && isRecord(ctx.state) ? ctx.state as Record<string, unknown> : undefined;
    // Subscribe this row to dispatch events for its execution. Row identity
    // is the renderer context's per-row `state` object (Pi keeps one per tool
    // row), tracked in a WeakMap of unsubscribe functions so two rows
    // rendered from the same result envelope never share or double a
    // listener. If the registry entry for this execution no longer exists
    // when the row renders again, the row re-subscribes: a card that can
    // still receive dispatch events always holds a live subscription. No
    // polling/fetching is introduced — refresh happens only when an actual
    // dispatch event fires.
    if (state) {
      const owned = ExecutionToolManager.rowUnsubscribes.get(state);
      const entryAlive = hasDispatchCardWatcher(executionId);
      if (!owned || !entryAlive) {
        if (owned) {
          try {
            owned();
          } catch {
            // A stale row subscription must never break rendering.
          }
        }
        state[DISPATCH_WATCH_STATE_KEY] = executionId;
        const invalidate = typeof ctx?.invalidate === "function" ? ctx.invalidate : undefined;
        if (invalidate) {
          rowInvalidators.set(state, invalidate);
          ExecutionToolManager.rowUnsubscribes.set(
            state,
            subscribeWeakRow(executionId, new WeakRef(state)),
          );
        }
      }
    }
    const live = this.controller.liveDispatchView(executionId);
    if (!live) return { value, context };
    if (state) state.subtaskDispatchView = live;
    return { value: { ...valueRecord, details: { ...details, dispatchView: live } }, context };
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
          const startCallFingerprint = this.input.submittedFingerprintFor
            ? this.input.submittedFingerprintFor(toolCallId, toolName)
            : toolCallFingerprint(toolName, params);
          if (!isToolCallFingerprint(startCallFingerprint)) {
            return result(
              "SubtasksStart failed closed: the submitted native call identity could not be verified; no group or tasks were created.",
              { diagnostic: "missing or invalid admitted native call identity" },
              true,
            );
          }
          const inspection = await this.controller.start(
            this.withParentTools(normalized.tasks!, kind),
            kind,
            normalized.workspace,
            { startCallFingerprint },
          );
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
            ...(normalized.inPlace === true ? { inPlace: true } : {}),
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
          // #117: the model's direct result confirms each validated landing, so
          // the controller folds the group aggregates in instead of waking.
          const cleared = await this.controller.markClean({ actor: "model" });
          const aggregates = (cleared.completionAggregates ?? [])
            .map((entry) => `Group aggregate for ${entry.executionId} / ${entry.taskId}:\n${entry.aggregate}`)
            .join("\n\n");
          return result(
            [
              cleared.cleared
                ? `Conflict gate cleared for ${cleared.paths.length} path(s); each landed task's group aggregate is included below instead of a separate completion notification.`
                : "No workspace conflict gate is active.",
              aggregates,
            ].filter((part) => part.length > 0).join("\n"),
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
    // #73: GitRead is a research-role capability. Research children inherit it
    // through the read-only intersection (and its conservative initial-active
    // subset) whenever the parent authorization carries it; execute children
    // never carry it in the durable allowed ceiling or initial set, and an
    // explicit child catalog naming it for an execute task fails closed at
    // subset validation below.
    const childTools = kind === "research"
      ? researchToolIntersection(allowedTools)
      : allowedTools.filter((tool) => tool !== GIT_READ_TOOL_NAME);
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
 *
 * #73: GitRead is the structured read-only Git-history tool. It enters the
 * research intersection (and, through DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER, the
 * conservative initial-active subset) so Pi research workers have it active
 * from the first request; execute-kind catalogs exclude it in withParentTools.
 */
export const RESEARCH_ALLOWED_TOOLS = new Set([
  "read", "grep", "glob", "find", "ls", GIT_READ_TOOL_NAME, "WebFetch", "WebSearch", "BrowserExtract",
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
      // #25: no minLength — an empty or whitespace-only string is a valid
      // input that normalizes to "omitted" (parent session's working directory).
      properties.workspace = {
        type: "string",
        description: "Optional existing directory (an explicitly authorized development checkout or Git worktree) that the group captures from and lands into. Omitted or blank uses the parent session's working directory. A leading ~ or ~/... expands against the user's home; other relative paths resolve against the parent session's working directory. Resolved once at start; SubtasksAdd inherits it and steering never changes it.",
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
      properties.inPlace = {
        type: "boolean",
        description: "Optional, execute tasks only. When true, continue a stopped task that has no verified checkpoint (for example after checkpoint staging failed) in exactly its retained managed worktree, without recreating, resetting, or cleaning it. Refused when the folder is missing or unsafe, a writer may be live, landing recovery or a conflict gate is outstanding, or the task failed critically for a reason other than checkpointing. A changed successful result still needs a verified candidate, configured subtask review if enabled, and ordinary landing gates. Omitted or false keeps strict checkpoint-verified continuation.",
      };
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
      properties.mergeAnyhow = { type: "boolean", description: "Retained for caller compatibility; it no longer changes behavior. An explicit force-merge always merges all identified work in one call: clean paths apply and ordinary text conflicts materialize standard diff3 markers that are then resolved and cleared with SubtasksMarkClean. Every force-merge attempt requires manual workspace inspection afterward." };
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
  if (value.workspace !== undefined) {
    // #25: start-only explicit execution target; a blank string is the same
    // as omitting it (parent session working directory).
    if (typeof value.workspace !== "string") throw new Error("workspace must be a string");
    const workspace = value.workspace.trim();
    if (workspace !== "") normalized.workspace = workspace;
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
  if (value.inPlace !== undefined) {
    if (typeof value.inPlace !== "boolean") throw new Error("inPlace must be boolean");
    normalized.inPlace = value.inPlace;
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
    case "start": return new Set(["kind", "tasks", "workspace"]);
    case "add": return new Set(["executionId", "tasks"]);
    case "inspect": return new Set(["executionId", "taskId", "offset", "lines", "evidence"]);
    case "watch": return new Set(["executionId", "after"]);
    case "continue": return new Set(["executionId", "taskId", "bundle", "instructions", "instructionId", "inPlace"]);
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
  let summary = action === "start" || action === "add"
    ? `${toolName} accepted: ${inspection.kind} group ${inspection.executionId} has ${active} active task(s).${startupDelay}${schedulingSummary} Queued state and stable task handles are included below. ${notificationContract} Internal progress stays available in SubtasksInspect and /subtasks-view without triggering turns. DO NOT POLL for task-state changes. Do not create a timer, sleep job, repeated inspect loop, or other waiting surrogate; continue other work or yield. Use SubtasksInspect only when a current diagnostic snapshot is independently useful for a decision.`
    : action === "force_merge"
      ? `${toolName}: execution ${inspection.executionId}, ${active} active task(s). Force-merge only reports a mechanical landing attempt; always inspect the main workspace manually because it does not prove the requested changes are present or correct.`
    : action === "interrupt" && inspection.tasks.some((task) => task.commands.some((command) => command.action === "interrupt" && command.mode === "interrupt_with_merge"))
      ? `${toolName}: execution ${inspection.executionId}, ${active} active task(s). Interrupt-with-merge only attempted a mechanical checkpoint landing; always inspect the main workspace manually because this status does not prove the requested changes are present or correct.`
      : `${toolName}: ${inspection.kind} group ${inspection.executionId}, ${active} active task(s).`;
  // #117: when the synchronous landing's completion wake was suppressed, its
  // group aggregate is folded into this direct result instead.
  if (inspection.completionAggregate) {
    summary += `\nGroup aggregate for this synchronous landing, folded into this result instead of a separate completion notification:\n${inspection.completionAggregate}`;
  }
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

/** #56: bounded, redacted display of one free-text evidence selector. Opaque
 * tokens (cursors, long ids) are clipped so a card never dumps them. */
function safeSelector(value: string, maxChars = 48): string {
  const redacted = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** #56: compact call-line summary for one SubtasksInspect request. It names the
 * task and the effective navigation mode using safe selectors only — the same
 * entryId > callId > cursor > find > range precedence the navigation read uses —
 * and never displays an opaque cursor token. */
function inspectCallSummary(args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof args.taskId === "string" && args.taskId.trim() !== "") parts.push(`task ${safeSelector(args.taskId)}`);
  const evidence = isRecord(args.evidence) ? args.evidence : undefined;
  if (evidence) {
    if (typeof evidence.entryId === "string" && evidence.entryId.trim() !== "") {
      const chunk = typeof evidence.chunkIndex === "number" ? ` chunk ${evidence.chunkIndex}` : "";
      parts.push(`entry ${safeSelector(evidence.entryId)}${chunk}`);
    } else if (typeof evidence.callId === "string" && evidence.callId.trim() !== "") {
      parts.push(`call ${safeSelector(evidence.callId)}`);
    } else if (typeof evidence.cursor === "string" && evidence.cursor.trim() !== "") {
      parts.push("cursor continuation");
    } else if (typeof evidence.find === "string" && evidence.find.trim() !== "") {
      const filter = typeof evidence.filter === "string" ? ` filter ${evidence.filter}` : "";
      parts.push(`find "${safeSelector(evidence.find)}"${filter}`);
    } else {
      const start = typeof evidence.index === "number" ? evidence.index : 0;
      const limit = typeof evidence.limit === "number" ? Math.min(Math.max(evidence.limit, 1), EVIDENCE_LIMIT_MAX) : EVIDENCE_LIMIT_DEFAULT;
      const filter = typeof evidence.filter === "string" ? ` filter ${evidence.filter}` : "";
      parts.push(`entries ${start}..${start + limit - 1}${filter}`);
    }
  } else if (args.offset !== undefined || args.lines !== undefined) {
    const offset = typeof args.offset === "number" ? args.offset : 0;
    const lines = typeof args.lines === "number" ? ` lines=${args.lines}` : "";
    parts.push(`activity offset=${offset}${lines}`);
  } else {
    parts.push("status");
  }
  return ` · ${parts.join(" · ")}`;
}

function renderCall(toolName: string, action: Action, args: unknown, theme: ThemeLike): unknown {
  // #56: inspection cards name the task and effective navigation mode so distinct
  // searches, ranged reads, deep reads, call resolutions, and cursor continuations
  // no longer look like repeated identical calls.
  if (action === "inspect") {
    return textComponent((width) => [clip(
      theme.fg("toolTitle", theme.bold(toolName)) + theme.fg("accent", inspectCallSummary(isRecord(args) ? args : {})),
      width,
    )]);
  }
  const taskCount = isRecord(args) && Array.isArray(args.tasks) ? ` · ${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}` : "";
  // #25: surface the explicit execution target at dispatch so the rendered
  // call shows which checkout/worktree the group will capture and land into.
  const workspace = isRecord(args) && typeof args.workspace === "string" && args.workspace.trim() !== ""
    ? ` · ${args.workspace.trim()}`
    : "";
  return textComponent((width) => [clip(theme.fg("toolTitle", theme.bold(toolName)) + theme.fg("accent", taskCount || ` · ${action}`) + workspace, width)]);
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

/** #120: defaults for the plain-text /subtask-add submission. The prompt is
 * preserved as the instructions with only the established command-argument
 * surrounding-whitespace trim (interior whitespace is untouched); the title
 * derives from it, and the single acceptance criterion restates the
 * instructions without inventing any additional task requirement. Kind
 * defaults to execute and the workspace to the current session workspace (the
 * SubtasksStart defaults). */
function plainTextSubtaskDefinition(prompt: string): BackgroundTaskDefinition {
  const instructions = prompt.trim();
  return {
    title: clipPlain(instructions, 80),
    instructions,
    acceptanceCriteria: ["The task instructions are completed as written."],
  };
}

function commandUi(ctx: unknown): CommandUi | undefined {
  if (!(isRecord(ctx) && isRecord(ctx.ui) && typeof ctx.ui.select === "function")) return undefined;
  // Delegate to the live host UI object (prototype chain) so members beyond
  // this interface — the native editor bridge seams the shared text field
  // seam drives — keep working, and carry the command context's run mode for
  // the interactive-TUI guard (issue #26).
  const ui = Object.create(ctx.ui) as CommandUi;
  if (typeof ctx.mode === "string") ui.mode = ctx.mode;
  return ui;
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
