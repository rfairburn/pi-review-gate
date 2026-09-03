/**
 * Subtask notification contract (finding 14). This module is the single source
 * of truth for everything the execution subsystem tells the orchestrator about
 * background subtask lifecycle events:
 *
 * - wake eligibility: quiet mode keeps ordinary RUNNING/REVIEWING state
 *   transitions passive while completion, failure, conflict, and
 *   recovery-required events stay actionable in both modes; noisy mode
 *   additionally wakes for the interactive transitions;
 * - delivery lanes and trigger-turn behavior (completion is a follow-up,
 *   failures and state wakes are immediate, and no event is a passive
 *   next-turn insert);
 * - the model-facing lifecycle contract prose shared by tool guidance and
 *   start/add result summaries, derived from the same state tables as the
 *   wake policy so the prose cannot drift from behavior;
 * - event formatting: execution/research lifecycle events, one-shot watch
 *   checkpoints, and the dedicated no-action acknowledgement wording;
 * - the L8 curated, explicitly bounded failure-recovery diagnostic.
 *
 * Passive widget/UI telemetry (subtask-widget.ts, the controller's indicator)
 * never routes through this module: it does not start model turns.
 *
 * The controller delegates delivery decisions and all notification text to
 * this module instead of re-deriving the policy inline. Everything here is
 * pure: no I/O, no controller state, no scheduling side effects.
 */
import { DEFAULT_SUBTASK_NOTIFICATION_MODE, type ReviewGateConfig } from "../config";
import type { BackgroundExecutionGroup } from "./background-group-store";
import {
  clipActivity,
  isActiveTaskState,
  isInterruptibleTaskState,
  type BackgroundActivityEvent,
  type BackgroundTaskKind,
  type BackgroundTaskRecord,
  type BackgroundTaskState,
} from "./task-state";
import { executorDisplayLabel } from "./subtask-widget";

// ── Wake policy types ────────────────────────────────────────────────────────

/** Kinds of wakes the controller delivers to the orchestrator. */
export type SubtaskWakeKind = "completion" | "failure" | "state";

/** Quiet and noisy delivery modes (see execution.subtaskNotifications). */
export type SubtaskNotificationMode = "quiet" | "noisy";

/**
 * Delivery lanes. "now" wakes the orchestrator immediately (steer delivery);
 * "soon" delivers as a follow-up that still triggers a turn.
 */
export type SubtaskNotificationLane = "now" | "soon";

export interface SubtaskWakeDelivery {
  deliverAs: "steer" | "followUp";
  triggerTurn: boolean;
}

/**
 * State labels that wake the orchestrator even in quiet mode: successful
 * completion (LANDED for execute groups, REPORTED for research groups) plus
 * failure, conflict, and any other recovery-required outcome.
 */
export const QUIET_TURN_WAKE_STATE_LABELS = ["LANDED", "REPORTED", "FAILED", "CONFLICTED"] as const;

/**
 * Interactive transitions that wake only in noisy mode: they exist so the
 * orchestrator can steer, not because the task outcome changed.
 */
export const NOISY_INTERACTIVE_WAKE_STATES = [
  { label: "RUNNING", note: "steerable" },
  { label: "REVIEWING", note: "steering can supersede review" },
] as const;

/**
 * Progress states that never trigger model turns in either mode; they stay
 * visible through SubtasksInspect, /subtasks-view, and passive UI telemetry.
 */
export const PASSIVE_STATE_LABELS = ["CAPTURING", "ACCEPTED", "WAITING_TO_LAND", "LANDING"] as const;

/** Resolve the effective notification mode for a configuration. */
export function subtaskNotificationMode(config: Pick<ReviewGateConfig, "execution">): SubtaskNotificationMode {
  return config.execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE;
}

/** Completion and failure/conflict/recovery events are actionable in both modes. */
export function isActionableWakeKind(kind: SubtaskWakeKind): boolean {
  return kind === "completion" || kind === "failure";
}

/**
 * Quiet mode suppresses ordinary state transitions; every other wake kind is
 * actionable. Noisy mode wakes for state transitions too.
 */
export function isTurnWake(kind: SubtaskWakeKind, mode: SubtaskNotificationMode): boolean {
  return kind !== "state" || mode === "noisy";
}

/** Inverse predicate kept explicit because the controller early-returns on it. */
export function isQuietSuppressedWake(kind: SubtaskWakeKind, mode: SubtaskNotificationMode): boolean {
  return !isTurnWake(kind, mode);
}

/** Lane for a wake: completion is a follow-up; failures and state wakes are immediate. */
export function notificationLane(kind: SubtaskWakeKind): SubtaskNotificationLane {
  return kind === "completion" ? "soon" : "now";
}

/** Delivery shape for a lane. State and failure wakes steer now; completions follow up. */
export function deliveryForLane(lane: SubtaskNotificationLane): SubtaskWakeDelivery {
  return lane === "now"
    ? { deliverAs: "steer", triggerTurn: true }
    : { deliverAs: "followUp", triggerTurn: true };
}

/**
 * One-shot watch checkpoints are deliberate follow-ups: they trigger a turn
 * but never steer, exactly like a completion lane delivery.
 */
export function watchCheckpointDelivery(): SubtaskWakeDelivery {
  return deliveryForLane("soon");
}

// ── Model-facing lifecycle contract prose (derived from the policy above) ────

/** "LANDED, REPORTED, FAILED, CONFLICTED" — the quiet-mode wake set, in prose order. */
export function quietTurnWakeStateList(): string {
  return QUIET_TURN_WAKE_STATE_LABELS.join(", ");
}

/** "RUNNING and REVIEWING" — the noisy-only interactive wake set. */
export function interactiveWakeStateList(): string {
  return NOISY_INTERACTIVE_WAKE_STATES.map((state) => state.label).join(" and ");
}

/** "CAPTURING, ACCEPTED, WAITING_TO_LAND, and LANDING" — the passive set. */
export function passiveStateList(): string {
  const labels = [...PASSIVE_STATE_LABELS];
  return labels.length <= 1
    ? labels.join("")
    : `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

/** Shared prompt-guidance sentence describing quiet/noisy wake behavior. */
export function lifecycleWakeGuidanceLine(): string {
  const interactive = NOISY_INTERACTIVE_WAKE_STATES
    .map((state) => `${state.label} (${state.note})`)
    .join(" and ");
  return [
    "The start/add result reports queued tasks.",
    `Quiet mode (the default) triggers orchestrator turns for each ${quietTurnWakeStateList()}, or other recovery-required task; Noisy mode additionally triggers ${interactive}.`,
    `${passiveStateList()} remain visible in SubtasksInspect and /subtasks-view but do not trigger turns.`,
    "DO NOT POLL for task-state changes and do not create a timer, sleep job, repeated inspect loop, or other waiting surrogate.",
    "Use SubtasksInspect only when a current diagnostic snapshot is independently useful for a decision.",
  ].join(" ");
}

/** Shared prompt-guidance sentence about terminal wakes versus passive polling. */
export function terminalWakeGuidanceLine(): string {
  return [
    "Each task completion, failure, and critical conflict triggers a model notification.",
    `Ordinary ${NOISY_INTERACTIVE_WAKE_STATES.map((state) => state.label.toLowerCase()).join("/") } transitions do so only in noisy mode.`,
    "Use SubtasksInspect whenever you need current status or diagnostics; avoid tight repetitive polling.",
  ].join(" ");
}

/**
 * Kind-neutral completion guidance: execute groups land, research groups
 * report, and both completions wake the orchestrator even in quiet mode and
 * list incomplete siblings.
 */
export function completionNotificationGuidanceLine(): string {
  return [
    `Every task completion (an execute task landing or a research task reporting) triggers a notification and lists every sibling that has not completed, even in quiet mode, so freed capacity can be topped off immediately.`,
    "Do not verify aggregate outputs until the execution-complete notification.",
  ].join(" ");
}

/**
 * Start/add result prose describing the active notification mode. successVerb
 * is "lands" (execute) or "reports" (research), matching the group kind.
 */
export function notificationModeContractProse(mode: SubtaskNotificationMode, successVerb: string): string {
  const interactive = interactiveWakeStateList();
  return mode === "quiet"
    ? `Quiet notification mode is active: ordinary ${interactive} transitions remain passive UI telemetry. Every task still triggers a turn when it ${successVerb}, fails, conflicts, or requires recovery, and completion events identify siblings that remain active.`
    : `Noisy notification mode is active: ${interactive} transitions trigger turns in addition to every successful, failed, conflicted, or recovery-required task.`;
}

// ── No-action acknowledgement ────────────────────────────────────────────────

/**
 * Acknowledgement wording appended to informational state wakes. Tested
 * separately from transition selection: it is response guidance, not policy.
 */
export function noActionResponseNotice(task: Pick<BackgroundTaskRecord, "taskId" | "state">): string {
  return `NO TOOL ACTION IS NECESSARY unless you want to steer this task or the reported state requires recovery. This notification triggered a harness turn, so do not return an empty response. If no action is needed, reply briefly with: No action for ${task.taskId} at ${task.state.toUpperCase()}. Do not call inspect merely to acknowledge this event.`;
}

// ── Transition notices ───────────────────────────────────────────────────────

/**
 * Human/model-facing prose for an ordinary state transition. Only the
 * steerable interactive states carry guidance; passive progress states
 * (CAPTURING/ACCEPTED/WAITING_TO_LAND/LANDING) produce no notification text,
 * so they stay passive even in noisy mode.
 */
export function stateTransitionNotice(
  task: BackgroundTaskRecord,
  previous: BackgroundTaskState,
  next: BackgroundTaskState,
): string | undefined {
  if (previous === next) return undefined;
  const transition = `Task ${task.taskId} changed state: ${previous.toUpperCase()} -> ${next.toUpperCase()}.`;
  if (next === "running") {
    return `${transition} The task is ACTIVE. Steering is available now; if live control is still starting or a long-running command is in progress, the instruction remains durably queued for the next executor handoff.`;
  }
  if (next === "reviewing") {
    return `${transition} The task is REVIEWING. A new steer takes priority: it interrupts the in-flight review and resumes the executor with the changed request before review restarts.`;
  }
  return undefined;
}

// ── Execution/research lifecycle event formatting ────────────────────────────

/** Scheduling fields the completion formatter needs from a scheduling snapshot. */
export interface SubtaskEventScheduling {
  estimatedImmediatelyAvailableSlots: number;
  globallyDispatchPending: number;
}

export function formatExecutionEvent(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  kind: SubtaskWakeKind,
  content: string,
  scheduling?: SubtaskEventScheduling,
): string {
  const successState: BackgroundTaskState = group.kind === "research" ? "reported" : "landed";
  const successVerb = group.kind === "research" ? "reported" : "landed";
  // Finding 15: totals come from the persisted aggregate counts so they stay
  // truthful after settled tasks are evicted from the bounded inline window;
  // the inline incomplete list is exhaustive because every unsettled task
  // stays inline (bounded by the per-execution admission cap).
  const archivedSettled = group.settledArchivedCount ?? 0;
  const successful = group.tasks.filter((candidate) => candidate.state === successState).length + archivedSettled;
  const total = group.totalTaskCount ?? group.tasks.length;
  const incomplete = group.tasks.filter((candidate) => candidate.state !== successState);
  const active = group.tasks.filter((candidate) => isActiveTaskState(candidate.state));
  const title = task.definition.title;
  const lines = [
    content,
    "",
    `Task: ${task.taskId} · ${title} · ${task.state}`,
  ];
  if (archivedSettled > 0) {
    lines.push(`${archivedSettled} earlier task(s) ${successVerb} and are archived; use SubtasksInspect with their taskId for exact history.`);
  }
  if (kind !== "completion") lines.push(`Execution revision: ${group.revision}`);
  const landedPaths = [
    ...(task.result?.landing?.appliedPaths ?? []),
    ...(task.result?.landing?.alreadyAppliedPaths ?? []),
  ];
  if (landedPaths.length > 0) lines.push(`Landed paths: ${[...new Set(landedPaths)].join(", ")}`);
  if (kind === "completion") {
    if (scheduling) {
      const topOff = Math.max(0, scheduling.estimatedImmediatelyAvailableSlots - scheduling.globallyDispatchPending);
      lines.push(`Top-off opportunity: up to ${topOff} additional task(s) may be submitted with SubtasksAdd if planned work remains.`);
    }
  }
  if (incomplete.length === 0) {
    if (kind === "completion") {
      lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} COMPLETE: ${successful}/${total} tasks ${successVerb}.`);
      lines.push(group.kind === "research"
        ? "All requested research reports are available; synthesis is now appropriate. Main was not modified by this research group."
        : "All requested task outputs have landed; aggregate verification is now appropriate.");
    } else if (kind === "failure") {
      lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} has ${successful}/${total} tasks ${successVerb}, but this interaction reported a failure.`);
      lines.push(`Inspect the failed command and verify the ${group.kind === "research" ? "reports" : "landed output"} before treating the group as successful.`);
    } else {
      lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} currently has ${successful}/${total} tasks ${successVerb}.`);
      lines.push("This is an informational state update; rely on the separate completion or failure event for the execution outcome.");
    }
    if (kind === "state") lines.push(noActionResponseNotice(task));
    return lines.join("\n");
  }
  const disposition = active.length > 0 ? "IN PROGRESS" : "INCOMPLETE";
  lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} ${disposition}: ${successful}/${total} ${successVerb}; ${incomplete.length} not ${successVerb}.`);
  if (kind === "completion") {
    lines.push(`This is a partial task completion, not completion of the whole group. Do not claim outputs from tasks that have not ${successVerb}.`);
  } else if (kind === "failure") {
    lines.push("The whole execution is not successfully complete. Use the task handles and states below to recover deliberately.");
  }
  lines.push(`Tasks not yet ${successVerb}:`);
  for (const candidate of incomplete) {
    lines.push(`- ${candidate.taskId} · ${candidate.definition.title} · ${candidate.state}`);
  }
  if (kind === "state") lines.push(noActionResponseNotice(task));
  return lines.join("\n");
}

export const SHORT_RESEARCH_REPORT_MAX_CHARS = 900;
export const RESEARCH_SUMMARY_MAX_CHARS = 240;

export function formatResearchCompletion(taskId: string, report: string, reportPath: string): string {
  const trimmed = report.trim();
  const lines = [
    `Research task ${taskId} completed without workspace changes.`,
    `Full report: ${reportPath}`,
  ];
  if (trimmed.length <= SHORT_RESEARCH_REPORT_MAX_CHARS) {
    lines.push("Complete report:", trimmed);
    return lines.join("\n");
  }
  const declaredSummary = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^Summary:\s+\S/i.test(line) && line.length <= RESEARCH_SUMMARY_MAX_CHARS + "Summary: ".length);
  lines.push("The report is too long to inline completely; no partial report excerpt is included.");
  if (declaredSummary) lines.push(declaredSummary);
  else lines.push("No bounded standalone summary was supplied; read the full report when its details are needed for synthesis.");
  return lines.join("\n");
}

// ── Watch-checkpoint event formatting ────────────────────────────────────────

/** One execution snapshot as the watch formatter needs it. */
export interface SubtaskWatchTaskSnapshot {
  taskId: string;
  definition: { title: string };
  state: BackgroundTaskState;
  updatedAt: string;
  executorEntryId?: string;
  activity: BackgroundActivityEvent[];
  timing: { totalMs: number };
  liveControl?: { steer: boolean };
}

/** One execution as the watch formatter needs it. */
export interface SubtaskWatchInspectionSnapshot {
  executionId: string;
  kind: BackgroundTaskKind;
  revision: number;
  tasks: SubtaskWatchTaskSnapshot[];
}

/**
 * Deliberate one-shot checkpoint text. Reports active tasks only; landed and
 * otherwise settled tasks are omitted because they already produced (or will
 * produce) their own actionable event.
 */
export function formatWatchEvent(inspections: SubtaskWatchInspectionSnapshot[], config: ReviewGateConfig): string {
  const lines = [
    "[pi-review-subtask-watch]",
    inspections.length === 1
      ? `The requested one-shot checkpoint for execution ${inspections[0]!.executionId} is due while work remains active.`
      : `${inspections.length} requested one-shot subtask checkpoints became due together while work remains active.`,
    "This is a deliberate checkpoint, not a completion or failure event. Act only if the snapshot warrants it; call SubtasksWatch again to request another checkpoint.",
  ];
  const now = Date.now();
  for (const inspection of inspections) {
    const active = inspection.tasks.filter((task) => isActiveTaskState(task.state));
    lines.push("", `${inspection.kind === "research" ? "Research" : "Execution"} ${inspection.executionId}: ${active.length} active task(s), revision ${inspection.revision}.`);
    for (const task of active) {
      const lastActivity = task.activity.at(-1);
      const lastAt = lastActivity?.at ?? task.updatedAt;
      const live = task.liveControl;
      lines.push(`- ${task.taskId} · ${task.definition.title} · ${task.state} · ${executorDisplayLabel(task, config, inspection.kind)}`);
      lines.push(`  elapsed ${formatElapsed(task.timing.totalMs)}; last recorded activity ${formatElapsedSince(lastAt, now)}; controls: inspect yes, steer yes (live ${live?.steer === true ? "yes" : "no"}), interrupt ${isInterruptibleTaskState(task.state) ? "yes" : "no"}`);
      lines.push(lastActivity
        ? `  recent: ${lastActivity.phase} · ${clipActivity(lastActivity.message, 240)}`
        : "  recent: no recorded activity yet");
    }
  }
  return lines.join("\n");
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
}

function formatElapsedSince(at: string, now: number): string {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? `${formatElapsed(Math.max(0, now - parsed))} ago` : "unknown";
}

// ── L8 curated bounded failure diagnostic ────────────────────────────────────

/**
 * L8: wake failure notifications carry a curated, explicitly bounded diagnostic
 * subset — never a full inspect() clone. Every attacker/model-controlled field
 * is capped with a visible truncation marker, and the serialized diagnostic and
 * the final notification have hard character caps.
 */
export const WAKE_FAILURE_MAX_TITLE = 200;
export const WAKE_FAILURE_MAX_SUMMARY = 600;
export const WAKE_FAILURE_MAX_ERROR = 800;
export const WAKE_FAILURE_MAX_ACTIVITY_EVENTS = 8;
export const WAKE_FAILURE_MAX_ACTIVITY_MESSAGE = 300;
export const WAKE_FAILURE_MAX_PHASE = 100;
export const WAKE_FAILURE_MAX_EXECUTOR_ENTRY = 120;
export const WAKE_FAILURE_MAX_CONFLICT_PATHS = 10;
export const WAKE_FAILURE_MAX_CONFLICT_PATH = 200;
export const WAKE_FAILURE_MAX_CONFLICT_REASON = 300;
export const WAKE_FAILURE_MAX_ACTION = 600;
export const WAKE_FAILURE_JSON_CAP = 7_000;
export const WAKE_FAILURE_NOTIFICATION_CAP = 16_000;
export const TRUNCATION_MARKER = "…[truncated]";

/** Curated, bounded failure diagnostic delivered with wake failure notifications (L8). */
export interface WakeFailureDiagnostic {
  executionId: string;
  kind: BackgroundTaskKind;
  revision: number;
  taskId: string;
  taskState: BackgroundTaskState;
  /** Bounded wake content (notice text); never the raw unbounded string. */
  message: string;
  groupSummary: { taskCount: number; settled: number; active: number };
  recovery: {
    hasDurableBundle: boolean;
    bundleWaveRoot?: string;
    executorEntryId?: string;
    conflictGate?: { paths: string[]; manifestPath: string; reason: string };
    suggestedActions: string[];
  };
  title: string;
  summary?: string;
  error?: string;
  activity: Array<{ sequence: number; phase: string; message: string }>;
}

/** The conflict-gate fields the diagnostic needs; scoped by the controller. */
export interface WakeDiagnosticConflictGate {
  paths: string[];
  manifestPath: string;
  reason: string;
}

export interface WakeFailureDiagnosticInput {
  group: BackgroundExecutionGroup;
  task: BackgroundTaskRecord;
  /** Raw wake content; bounded into the diagnostic message field. */
  content: string;
  /** Conflict gate already scoped to this execution/task, if active. */
  conflictGate?: WakeDiagnosticConflictGate;
}

/**
 * Pure builder for the L8 curated recovery subset. Contains only stable
 * handles, current state, bounded summary/error/activity, and recovery
 * actions. Task instructions, acceptance criteria, command text, model
 * output, and full group/task arrays are never included.
 */
export function buildWakeFailureDiagnostic(input: WakeFailureDiagnosticInput): WakeFailureDiagnostic {
  const { group, task, content, conflictGate } = input;
  const live = group.tasks.find((candidate) => candidate.taskId === task.taskId) ?? task;
  const successState: BackgroundTaskState = group.kind === "research" ? "reported" : "landed";
  const conflictManifestPath = conflictGate
    ? boundDiagnosticText(conflictGate.manifestPath, WAKE_FAILURE_MAX_CONFLICT_PATH) ?? ""
    : undefined;
  const suggestedActions = [
    `SubtasksInspect (executionId ${group.executionId}, taskId ${task.taskId}) for the current bounded snapshot`,
  ];
  if (conflictGate) {
    suggestedActions.push(`Resolve the conflict markers in recovery.conflictGate.paths (manifest: ${conflictManifestPath}), verify the workspace, then call SubtasksMarkClean (executionId ${group.executionId}, taskId ${task.taskId}); automatic landings stay blocked until then`);
  }
  if (live.bundle) {
    suggestedActions.push(`SubtasksContinue (executionId ${group.executionId}, taskId ${task.taskId}) to resume from the durable checkpoint`);
    if (group.kind === "execute" && !isActiveTaskState(live.state)) {
      suggestedActions.push(`SubtasksForceMerge (executionId ${group.executionId}, taskId ${task.taskId}) to land the checkpoint mechanically; manual workspace inspection is still required afterward`);
    }
  } else {
    suggestedActions.push("No durable continuation bundle is available; inspect the execution record and restart the task with SubtasksAdd if its outcome is still needed");
  }
  suggestedActions.push(`SubtasksInterrupt (executionId ${group.executionId}, taskId ${task.taskId}, interrupt_as_failure) to quiesce any live writer`);
  // Recovery handles are serialized first so any final JSON truncation hits
  // the verbose summary/error/activity tail, never the recovery block. Every
  // field is individually bounded so the structured object passed via
  // sendMessage details is bounded by construction, not only the rendered text.
  return fitWakeFailureDiagnostic({
    executionId: group.executionId,
    kind: group.kind,
    revision: group.revision,
    taskId: task.taskId,
    taskState: live.state,
    message: boundDiagnosticText(content, WAKE_FAILURE_MAX_SUMMARY) ?? "",
    groupSummary: {
      taskCount: group.totalTaskCount ?? group.tasks.length,
      settled: (group.settledArchivedCount ?? 0) + group.tasks.filter((candidate) => candidate.state === successState).length,
      active: group.tasks.filter((candidate) => isActiveTaskState(candidate.state)).length,
    },
    recovery: {
      hasDurableBundle: Boolean(live.bundle),
      bundleWaveRoot: live.bundle ? boundDiagnosticText(live.bundle.waveRoot, WAKE_FAILURE_MAX_CONFLICT_PATH) : undefined,
      executorEntryId: live.executorEntryId
        ? boundDiagnosticText(live.executorEntryId, WAKE_FAILURE_MAX_EXECUTOR_ENTRY)
        : undefined,
      conflictGate: conflictGate
        ? {
          paths: conflictGate.paths
            .slice(0, WAKE_FAILURE_MAX_CONFLICT_PATHS)
            .map((path) => boundDiagnosticText(path, WAKE_FAILURE_MAX_CONFLICT_PATH) ?? ""),
          manifestPath: conflictManifestPath ?? "",
          reason: boundDiagnosticText(conflictGate.reason, WAKE_FAILURE_MAX_CONFLICT_REASON) ?? "",
        }
        : undefined,
      suggestedActions: suggestedActions.map((action) => boundDiagnosticText(action, WAKE_FAILURE_MAX_ACTION) ?? ""),
    },
    title: boundDiagnosticText(task.definition.title, WAKE_FAILURE_MAX_TITLE) ?? "",
    summary: boundDiagnosticText(live.summary, WAKE_FAILURE_MAX_SUMMARY),
    error: boundDiagnosticText(live.error, WAKE_FAILURE_MAX_ERROR),
    activity: live.activity
      .slice(-WAKE_FAILURE_MAX_ACTIVITY_EVENTS)
      .map((event) => ({
        sequence: event.sequence,
        phase: boundDiagnosticText(event.phase, WAKE_FAILURE_MAX_PHASE) ?? "",
        message: boundDiagnosticText(event.message, WAKE_FAILURE_MAX_ACTIVITY_MESSAGE) ?? "",
      })),
  });
}

/** JSON-encoded length of a string's content, excluding the surrounding quotes. */
function jsonEncodedTextLength(value: string): number {
  // Control characters, quotes, and backslashes expand during JSON.stringify;
  // field budgets apply to the encoded form so the serialized diagnostic cap
  // cannot be bypassed with escape-heavy adversarial content.
  return JSON.stringify(value).length - 2;
}

export function boundDiagnosticText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (jsonEncodedTextLength(flat) <= max) return flat;
  // Binary-search the longest raw prefix whose JSON encoding (plus the visible
  // truncation marker) still fits the encoded budget.
  let low = 0;
  let high = flat.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonEncodedTextLength(`${flat.slice(0, mid)}${TRUNCATION_MARKER}`) <= max) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${flat.slice(0, low)}${TRUNCATION_MARKER}`;
}

/**
 * Shed trailing activity entries until the serialized diagnostic fits the JSON
 * cap, so the delivered diagnostic (and the structured object sent via
 * sendMessage details) stays parseable JSON instead of a character-sliced tail.
 */
export function fitWakeFailureDiagnostic(diagnostic: WakeFailureDiagnostic): WakeFailureDiagnostic {
  let payload = diagnostic;
  let text = JSON.stringify(payload, null, 2);
  while (text.length > WAKE_FAILURE_JSON_CAP && payload.activity.length > 0) {
    payload = { ...payload, activity: payload.activity.slice(0, -1) };
    text = JSON.stringify(payload, null, 2);
  }
  return payload;
}

export function formatWakeFailureDiagnostic(diagnostic: WakeFailureDiagnostic): string {
  const text = JSON.stringify(diagnostic, null, 2);
  if (text.length <= WAKE_FAILURE_JSON_CAP) return text;
  return `${text.slice(0, Math.max(1, WAKE_FAILURE_JSON_CAP - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

/** Dedicated bounded preamble for failure notifications; built only from the curated diagnostic. */
export function formatWakeFailurePreamble(diagnostic: WakeFailureDiagnostic): string {
  const successVerb = diagnostic.kind === "research" ? "reported" : "landed";
  const lines = [
    `Task ${diagnostic.taskId} requires recovery attention at state ${diagnostic.taskState.toUpperCase()} in ${diagnostic.kind} execution ${diagnostic.executionId} (revision ${diagnostic.revision}).`,
    `Execution progress: ${diagnostic.groupSummary.settled}/${diagnostic.groupSummary.taskCount} task(s) ${successVerb}, ${diagnostic.groupSummary.active} active.`,
  ];
  if (diagnostic.message) lines.push(`Notice: ${diagnostic.message}`);
  if (diagnostic.summary) lines.push(`Summary: ${diagnostic.summary}`);
  if (diagnostic.error) lines.push(`Error: ${diagnostic.error}`);
  return lines.join("\n");
}

export function capNotificationText(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, Math.max(1, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}