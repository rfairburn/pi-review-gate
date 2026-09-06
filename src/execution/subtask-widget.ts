/**
 * Subtask widget view-model rendering (finding 13). The controller supplies
 * plain snapshots (task/handle data, executor assignment, recent activity) and
 * this module owns every widget rendering detail: expanded live-view lines,
 * the compact indicator line, executor display labels, and the below-editor
 * live-view component. Watch/event message formatting and delivery policy stay
 * in the controller (finding 14). No controller state, scheduling, or delivery
 * policy lives here.
 */
import { externalAgentCatalog, resolvedWorkerResources, resolvedWorkerRoute, type ExecutorSelection, type ReviewGateConfig } from "../config";
import {
  clipActivity,
  type BackgroundActivityEvent,
  type BackgroundTaskKind,
  type BackgroundTaskState,
} from "./task-state";

const SHORT_LINE_EXPANDED_LIMIT = 16;
const SHORT_LINE_COMPACT_LIMIT = 3;

export function executorDisplayLabel(
  task: { executorEntryId?: string; executorSelection?: ExecutorSelection; executorModel?: string },
  config: ReviewGateConfig,
  kind: BackgroundTaskKind = "execute",
): string {
  // The model reported by the actual invocation is immutable identity: it
  // tracks failovers, shows execution-level model overrides exactly as
  // executed, and can never be relabeled by later catalog or settings changes.
  if (task.executorModel) return task.executorModel;
  // A recorded selection is authoritative identity for the task even before
  // (or without) a reported model: a pi selection carries its own model, and
  // an external selection keeps the recorded catalog handle — the handle was
  // what actually served the task, while a current-config lookup could
  // resolve the same entry id to a model that never did.
  const selection = task.executorSelection;
  if (selection) {
    if (selection.source === "pi") return selection.model;
    return selection.id || "unknown";
  }
  // Legacy fallback only (tasks recorded before selections were durable): an
  // entry id resolved against current configuration.
  if (!task.executorEntryId) return "executor pending";
  const entry = resolvedWorkerRoute(config, kind).find((candidate) => candidate.entryId === task.executorEntryId)
    ?? resolvedWorkerResources(config).find((candidate) => candidate.entryId === task.executorEntryId);
  if (!entry) return task.executorEntryId;
  if (entry.selection.source === "pi") return entry.selection.model;
  const externalId = entry.selection.id;
  const agent = externalAgentCatalog(config).find((candidate) => candidate.id === externalId);
  return agent && "model" in agent && typeof agent.model === "string" && agent.model
    ? agent.model
    : externalId;
}

/** One active task as the widget needs it; the controller fills runtime knowledge. */
export interface SubtaskWidgetTaskSnapshot {
  kind: BackgroundTaskKind;
  taskId: string;
  title: string;
  state: BackgroundTaskState;
  updatedAt: string;
  executorEntryId?: string;
  /** Authoritative selection of the executor actually serving this task. */
  executorSelection?: ExecutorSelection;
  /** Model reported by the actual adapter invocation that last served it. */
  executorModel?: string;
  reviewStatus?: { phase: string; reviewers: string[] };
  latestCommand?: { action: string; status: string };
  /** Queued task whose executor was already assigned and is starting up. */
  queuedExecutorAssigned: boolean;
}

export interface SubtaskWidgetSnapshot {
  expanded: boolean;
  conflictPaths?: string[];
  /** Active tasks across all groups; the widget sorts and bounds them. */
  tasks: SubtaskWidgetTaskSnapshot[];
  recent: Array<{ title: string; event: BackgroundActivityEvent }>;
}

export interface SubtaskWidgetRender {
  /** Expanded view component factory; takes precedence over `lines` when present. */
  component?: () => { render(width: number): string[]; invalidate(): void };
  /** Compact view lines, or undefined when the widget should be cleared. */
  lines?: string[];
}

/**
 * Render the below-editor subtask widget from a snapshot. Expanded mode always
 * produces a component (even with zero active tasks); compact mode produces a
 * single line, or undefined when nothing is active and no conflict gate exists.
 */
export function renderSubtaskWidget(snapshot: SubtaskWidgetSnapshot, config: ReviewGateConfig): SubtaskWidgetRender {
  if (snapshot.expanded) {
    return { component: () => liveViewComponent(buildExpandedWidgetLines(snapshot, config)) };
  }
  if (snapshot.tasks.length === 0 && !snapshot.conflictPaths) {
    return { lines: undefined };
  }
  return { lines: [buildCompactWidgetLine(snapshot)] };
}

function buildExpandedWidgetLines(snapshot: SubtaskWidgetSnapshot, config: ReviewGateConfig): string[] {
  const liveCount = snapshot.tasks.length;
  const activeTasks = [...snapshot.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const shown = activeTasks.slice(0, SHORT_LINE_EXPANDED_LIMIT);
  const lines = [
    `⟳ ${liveCount} active background subtask${liveCount === 1 ? "" : "s"} — expanded live view (/subtasks-view to collapse)`,
  ];
  if (snapshot.conflictPaths) lines.push(`CRITICAL conflict: ${snapshot.conflictPaths.join(", ")}`);
  if (shown.length === 0) lines.push("  No active background subtasks.");
  for (const task of shown) {
    const reviewers = task.reviewStatus
      ? ` · reviewers ${task.reviewStatus.reviewers.join(", ") || "none"} (${task.reviewStatus.phase})`
      : "";
    const latestCommand = task.latestCommand ? ` · ${task.latestCommand.action} ${task.latestCommand.status}` : "";
    lines.push(`  ${task.kind} · ${task.title} [${task.state}] · ${executorDisplayLabel(task, config, task.kind)}${reviewers}${latestCommand}`);
  }
  if (activeTasks.length > shown.length) lines.push(`  … ${activeTasks.length - shown.length} additional active task${activeTasks.length - shown.length === 1 ? "" : "s"} omitted`);
  const recent = snapshot.recent;
  lines.push("  Recent activity (10 newest events across all tasks):");
  if (recent.length === 0) lines.push("    no activity recorded yet");
  for (const { title, event } of recent) {
    lines.push(`    ${title} · ${event.phase} · ${clipActivity(event.message)}`);
  }
  return lines;
}

function buildCompactWidgetLine(snapshot: SubtaskWidgetSnapshot): string {
  const liveCount = snapshot.tasks.length;
  const detail = snapshot.conflictPaths
    ? `CRITICAL conflict: ${snapshot.conflictPaths.join(", ")}`
    : [
        ...snapshot.tasks.slice(0, SHORT_LINE_COMPACT_LIMIT).map((task) => `${task.title} (${task.state === "queued"
          ? task.queuedExecutorAssigned ? "queued: executor assigned/startup" : "queued: executor capacity wait"
          : task.state})`),
        ...(snapshot.tasks.length > SHORT_LINE_COMPACT_LIMIT ? [`+${snapshot.tasks.length - SHORT_LINE_COMPACT_LIMIT} more`] : []),
      ].join(", ");
  return `⟳ ${liveCount} background subtask${liveCount === 1 ? "" : "s"} — ${detail}`;
}

function liveViewComponent(lines: readonly string[]): { render(width: number): string[]; invalidate(): void } {
  return {
    render: (width) => lines.map((line) => clipWidgetLine(line, Math.max(1, width))),
    invalidate() {},
  };
}

function clipWidgetLine(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`;
}
