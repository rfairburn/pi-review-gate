/**
 * Wake/watch/launch-notice delivery mechanics (#222, #117, finding 14),
 * extracted from the background controller. This module owns the process-local
 * wake/delivery state — launch-notice gates, armed watch subscriptions, queued
 * checkpoint inspections, and the watch delivery timer — and sequences the
 * existing wake pipeline exactly: fault seam → watch housekeeping →
 * quiet/noisy lane decision → failure diagnostic or formatted event → the
 * Issue #222 launch-notice gate (awaited before any send) → pi message or
 * notify fallback.
 *
 * It owns no durable or admission state: the controller keeps command
 * admission (the identity/active-membership checks in watch()), every
 * authoritative group/task record, and pass live read projections in instead
 * of snapshots.
 */
import {
  buildWakeFailureDiagnostic,
  capNotificationText,
  formatExecutionEvent,
  formatWakeFailureDiagnostic,
  formatWakeFailurePreamble,
  formatWatchEvent,
  isActionableWakeKind,
  isQuietSuppressedWake,
  notificationLane,
  deliveryForLane,
  subtaskNotificationMode,
  watchCheckpointDelivery,
  WAKE_FAILURE_NOTIFICATION_CAP,
} from "./subtask-notifications";
import type { ConflictGate as BackgroundConflictGate } from "./conflict-gate-store";
import type { BackgroundExecutionGroup } from "./background-group-store";
import type { BackgroundTaskRecord } from "./task-state";
import type { BackgroundInspection, BackgroundFaultHooks, BackgroundSchedulingSnapshot, BackgroundWatchSubscription } from "./background-controller";

/**
 * Live environment projections for wake delivery. Config, pi transport, the
 * fault hook and every projection are read at each use — never captured — so
 * notification mode/config changes apply per send, exactly as before.
 */
export interface WakeDeliveryEnv {
  config(): import("../config").ReviewGateConfig;
  pi(): unknown;
  notify?(message: string): void | Promise<void>;
  faults?(): Pick<BackgroundFaultHooks, "wake"> | undefined;
  /** The group record that owns a task (by reference; the controller's map). */
  groupOf(taskId: string): BackgroundExecutionGroup | undefined;
  schedulingSnapshot(group: BackgroundExecutionGroup, releasingTask?: BackgroundTaskRecord): BackgroundSchedulingSnapshot;
  inspect(executionId: string): BackgroundInspection;
  /** #25 multi-target: only a task's own gate. */
  gateForTask(executionId: string, taskId: string): BackgroundConflictGate | undefined;
}

/**
 * Wake, watch, and launch-notice delivery. The controller delegates its
 * public watch()/wake() names here after its own admission/fence checks;
 * every timer and pending inspection lives in this module.
 */
export class WakeDelivery {
  /**
   * Issue #222: pending launch-notice gates by execution id. Set only by a
   * non-model-initiated start/add (human command or scheduler) that carries
   * the shared notice; process-local and never persisted, cleared when the
   * group retires or the controller detaches. A restored group never
   * resurrects its gate — restarts deliver the ordinary notifications without
   * one.
   */
  readonly launchNoticeGates = new Map<string, Promise<void>>();
  readonly watches = new Map<string, { timer: ReturnType<typeof setTimeout>; subscription: BackgroundWatchSubscription }>();
  pendingWatchInspections: BackgroundInspection[] = [];
  watchDeliveryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly env: WakeDeliveryEnv) {}

  setLaunchNoticeGate(executionId: string, gate: Promise<void>): void {
    this.launchNoticeGates.set(executionId, gate);
  }

  clearLaunchNoticeGate(executionId: string): void {
    this.launchNoticeGates.delete(executionId);
  }

  clearLaunchNoticeGates(): void {
    this.launchNoticeGates.clear();
  }

  /**
   * Issue #222 / Issue #26: the pending launch-notice gate of one execution,
   * undefined when the execution was launched by the model (no notice) or its
   * notice already resolved. Always resolves; the bounded window guarantees a
   * wedged or failed delivery can never strand result notifications.
   */
  private launchNoticeGateOf(group: BackgroundExecutionGroup | undefined): Promise<void> | undefined {
    if (!group) return undefined;
    return this.launchNoticeGates.get(group.executionId);
  }

  /** Arm a one-shot watch checkpoint subscription for an inspected execution.
   * The controller has already resolved the admission identity/active checks. */
  armWatch(executionId: string, afterMs: number): BackgroundWatchSubscription {
    const replaced = this.cancelWatch(executionId);
    const armedAt = new Date().toISOString();
    const subscription: BackgroundWatchSubscription = {
      executionId,
      afterMs,
      armedAt,
      dueAt: new Date(Date.parse(armedAt) + afterMs).toISOString(),
      replaced,
    };
    const timer = setTimeout(() => this.queueWatchDelivery(executionId, subscription), afterMs);
    timer.unref?.();
    this.watches.set(executionId, { timer, subscription });
    return subscription;
  }

  cancelWatch(executionId: string): boolean {
    const current = this.watches.get(executionId);
    if (current) clearTimeout(current.timer);
    this.watches.delete(executionId);
    this.pendingWatchInspections = this.pendingWatchInspections.filter((inspection) => inspection.executionId !== executionId);
    return current !== undefined;
  }

  clearWatches(): void {
    for (const watch of this.watches.values()) clearTimeout(watch.timer);
    this.watches.clear();
    this.pendingWatchInspections = [];
    if (this.watchDeliveryTimer) clearTimeout(this.watchDeliveryTimer);
    this.watchDeliveryTimer = undefined;
  }

  private queueWatchDelivery(executionId: string, expected: BackgroundWatchSubscription): void {
    const current = this.watches.get(executionId);
    if (!current || current.subscription !== expected) return;
    this.watches.delete(executionId);
    let inspection: BackgroundInspection;
    try {
      inspection = this.env.inspect(executionId);
    } catch {
      return;
    }
    if (inspection.activeCount === 0) return;
    this.pendingWatchInspections.push(inspection);
    if (this.watchDeliveryTimer) return;
    this.watchDeliveryTimer = setTimeout(() => {
      this.watchDeliveryTimer = undefined;
      const pending = this.pendingWatchInspections.splice(0);
      if (pending.length > 0) void this.deliverWatchInspections(pending);
    }, 25);
    this.watchDeliveryTimer.unref?.();
  }

  private async deliverWatchInspections(inspections: BackgroundInspection[]): Promise<void> {
    const content = formatWatchEvent(inspections, this.env.config());
    const pi = this.env.pi();
    if (!isRecord(pi) || typeof pi.sendMessage !== "function") {
      await this.env.notify?.(content);
      return;
    }
    try {
      pi.sendMessage({
        customType: "pi-review-subtask-watch",
        content,
        display: true,
        details: { executions: inspections },
      }, watchCheckpointDelivery());
    } catch (error) {
      await this.env.notify?.(`review gate: subtask watch notification could not be delivered: ${messageOf(error)}`);
    }
  }

  /**
   * #117 review fix: wake-side watch housekeeping, separated from notification
   * delivery. An actionable wake kind retires the owning group's one-shot
   * watch — both the armed checkpoint timer and any queued checkpoint
   * inspection — so a stale checkpoint can never fire after the event it was
   * watching for. Tool-result-suppressed completions (model force-merge /
   * mark-clean) run this same housekeeping; only the notification itself is
   * folded into the caller's direct result instead of being delivered.
   */
  retireWakeWatch(
    task: BackgroundTaskRecord,
    kind: "completion" | "failure" | "state",
    eventSnapshot?: { group: BackgroundExecutionGroup; task: BackgroundTaskRecord },
  ): void {
    if (!isActionableWakeKind(kind)) return;
    const owner = eventSnapshot?.group ?? this.env.groupOf(task.taskId);
    if (owner) this.cancelWatch(owner.executionId);
  }

  async wake(
    task: BackgroundTaskRecord,
    kind: "completion" | "failure" | "state",
    content: string,
    eventSnapshot?: { group: BackgroundExecutionGroup; task: BackgroundTaskRecord },
  ): Promise<void> {
    const env = this.env;
    await env.faults?.()?.wake?.({ taskId: task.taskId, taskState: task.state, kind });
    // Finding 14: wake eligibility, lanes, and delivery shapes are policy owned
    // by ./subtask-notifications; this method only sequences the fault seam,
    // watch housekeeping (retireWakeWatch), persistence-aware snapshots, and
    // delivery.
    this.retireWakeWatch(task, kind, eventSnapshot);
    const mode = subtaskNotificationMode(env.config());
    if (isQuietSuppressedWake(kind, mode)) return;
    const lane = notificationLane(kind);
    const owner = env.groupOf(task.taskId);
    const eventOwner = eventSnapshot?.group ?? owner;
    const eventTask = eventSnapshot?.task ?? task;
    const scheduling = eventOwner
      ? env.schedulingSnapshot(eventOwner, kind === "completion" ? eventTask : undefined)
      : undefined;
    // Failures never reuse the generic event body: it embeds raw wake content,
    // task titles, landed paths, and the incomplete-task list. Failures get a
    // dedicated preamble built only from the curated diagnostic, so every
    // model-controlled character passes through field-level bounding first.
    const diagnostic = kind === "failure" && owner
      ? buildWakeFailureDiagnostic({
        group: owner,
        task: eventTask,
        content,
        // #25 multi-target: only this exact task's own gate.
        conflictGate: env.gateForTask(owner.executionId, eventTask.taskId),
      })
      : undefined;
    const deliveredContent = diagnostic
      ? capNotificationText(
        `${formatWakeFailurePreamble(diagnostic)}\n\nFailure recovery diagnostic (curated and bounded; use SubtasksInspect for the full current snapshot):\n${formatWakeFailureDiagnostic(diagnostic)}`,
        WAKE_FAILURE_NOTIFICATION_CAP,
      )
      : eventOwner
        ? formatExecutionEvent(eventOwner, eventTask, kind, content, scheduling)
        : content;
    const delivery = deliveryForLane(lane);
    // Issue #222: every result notification for a non-model-initiated launch
    // waits behind that launch's notice first (auto-resolving bounded gate),
    // so a fast completion can never precede the notice that names the task.
    await this.launchNoticeGateOf(eventOwner ?? owner);
    const pi = env.pi();
    if (!isRecord(pi) || typeof pi.sendMessage !== "function") {
      await env.notify?.(deliveredContent);
      return;
    }
    try {
      pi.sendMessage({
        customType: "pi-review-subtask-event",
        content: deliveredContent,
        display: true,
        details: { executionId: eventOwner?.executionId, taskId: eventTask.taskId, state: eventTask.state, diagnostic },
      }, delivery);
    } catch (error) {
      await env.notify?.(`review gate: task notification could not be delivered: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}