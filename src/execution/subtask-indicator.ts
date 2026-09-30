/**
 * Subtask indicator presentation (finding 13/finding 15), extracted from the
 * background controller. The controller feeds live projections only; this
 * module owns the UI context, the expanded-view preference, and the exact
 * snapshot assembly → renderSubtaskWidget → setWidget sequencing with its
 * headless-safe error swallow. Reads of the controller-wide active-task
 * index, runtime assignment, conflict-gate paths, and recent activity happen
 * at render time — never captured.
 */
import type { ReviewGateConfig } from "../config";
import type { BackgroundExecutionGroup } from "./background-group-store";
import { isActiveTaskState, type BackgroundActivityEvent, type BackgroundTaskRecord } from "./task-state";
import { renderSubtaskWidget } from "./subtask-widget";

/** Live read-only projections the renderer needs, read at each render. */
export interface SubtaskIndicatorSource {
  /** Live configuration (read at each render). */
  config(): ReviewGateConfig;
  /** The controller-wide active-task index (live entries, by reference). */
  activeTaskEntries(): Array<{ group: BackgroundExecutionGroup; task: BackgroundTaskRecord }>;
  /** Live runtime-assignment check for one task. */
  isRuntimeActive(taskId: string): boolean;
  /** Every active gate's paths flattened, or undefined when no gate is active. */
  conflictGatePaths(): string[] | undefined;
  /** Recent activity entries (bounded recency window, by reference). */
  recentActivity(): Array<{ taskId: string; title: string; event: BackgroundActivityEvent }>;
}

export class SubtaskIndicator {
  private uiContext: unknown;
  private expandedView: boolean;

  constructor(source: SubtaskIndicatorSource, initialExpanded: boolean) {
    this.source = source;
    this.expandedView = initialExpanded;
  }

  private readonly source: SubtaskIndicatorSource;

  /** Current expanded-view preference. */
  get expanded(): boolean {
    return this.expandedView;
  }

  /** Adopt a UI context without rendering (toggle-expansion path). */
  useContext(ctx: unknown): void {
    this.uiContext = ctx;
  }

  /** Adopt a UI context and render immediately (setUiContext path). */
  setContext(ctx: unknown): void {
    this.uiContext = ctx;
    this.render();
  }

  /** Store a new expanded-view preference and render. */
  setExpanded(expanded: boolean): void {
    this.expandedView = expanded;
    this.render();
  }

  /**
   * Assemble the snapshot (active tasks, runtime assignment, conflict gate,
   * recent activity) and render it through the subtask-widget module.
   * Finding 15 (review pass 3): widget work reads the controller-wide
   * active-task index — bounded by the live population across all attached
   * groups — and never traverses settled history or detached groups.
   */
  render(): void {
    const ctx = this.uiContext;
    if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.setWidget !== "function") return;
    const tasks = this.source.activeTaskEntries()
      .filter(({ task }) => isActiveTaskState(task.state))
      .map(({ group, task }) => ({
        kind: group.kind,
        taskId: task.taskId,
        title: task.definition.title,
        state: task.state,
        updatedAt: task.updatedAt,
        executorEntryId: task.executorEntryId,
        executorSelection: task.executorSelection,
        executorModel: task.executorModel,
        reviewStatus: task.reviewStatus
          ? { phase: task.reviewStatus.phase, reviewers: [...task.reviewStatus.reviewers] }
          : undefined,
        latestCommand: task.commands.at(-1)
          ? { action: task.commands.at(-1)!.action, status: task.commands.at(-1)!.status }
          : undefined,
        queuedExecutorAssigned: this.source.isRuntimeActive(task.taskId),
      }));
    try {
      const rendered = renderSubtaskWidget({
        expanded: this.expandedView,
        // #25 multi-target: the indicator flattens every active gate's paths;
        // per-target ownership stays in inspect and the persisted snapshot.
        conflictPaths: this.source.conflictGatePaths(),
        tasks,
        recent: this.source.recentActivity().map((entry) => ({ title: entry.title, event: entry.event })),
      }, this.source.config());
      if (rendered.component) {
        ctx.ui.setWidget("review-gate-subtasks", rendered.component, { placement: "belowEditor" });
      } else {
        ctx.ui.setWidget("review-gate-subtasks", rendered.lines, { placement: "belowEditor" });
      }
    } catch {
      // UI surfaces are optional in print/headless harnesses.
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}