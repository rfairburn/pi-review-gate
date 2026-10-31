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
import { randomUUID } from "node:crypto";
import {
  buildWakeFailureDiagnostic,
  capNotificationText,
  formatExecutionEvent,
  formatWakeFailureDiagnostic,
  formatWakeFailurePreamble,
  formatWatchEvent,
  isActionableWakeKind,
  isQuietSuppressedWake,
  isSubtaskWatchMessage,
  notificationLane,
  deliveryForLane,
  retainSubtaskWatchExecutions,
  subtaskNotificationMode,
  subtaskWatchIdentitiesOf,
  watchCheckpointDelivery,
  SUBTASK_WATCH_CUSTOM_TYPE,
  WAKE_FAILURE_NOTIFICATION_CAP,
  type SubtaskWatchDeliveryIdentity,
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
  /**
   * Issue #452 residual: the exact session-persistence identity of the owning
   * session (`sessionPersistenceIdentity`, the same identity the human-command
   * origin guard uses), evaluated live. An armed watch is bound to it, and a
   * queued checkpoint is only fresh while that binding still holds. An
   * unavailable identity never becomes a cross-session fallback: it fails
   * closed to suppression of this origin's own pending checkpoint.
   */
  sessionOriginId?(): string | undefined;
}

/**
 * Issue #452 residual: one entry of the single canonical watch lifecycle store.
 * The store keeps the exact pending identity of a generation across its own
 * firing, retirement by an actionable wake, and replacement, so consumption-
 * time freshness is decidable without a second registry or a task mirror.
 */
export type WatchRecordPhase = "armed" | "fired" | "retired";

export interface WatchRecord {
  /** Absent once the one-shot deadline fired or the watch was retired. */
  timer?: ReturnType<typeof setTimeout>;
  subscription: BackgroundWatchSubscription;
  phase: WatchRecordPhase;
  /**
   * True once this generation's content was found obsolete in a built model
   * request. It keeps the generation suppressed even if a later transcript
   * shape would otherwise read as a consumed historical checkpoint.
   */
  omissionProposed?: boolean;
}

/**
 * Request-local, nonauthoritative boundary work list (#452): the watch
 * payloads whose obsolete content was left out of a built request and still
 * need Pi's supported append-only `context_edit` so the suppression cannot
 * heal in a later request. It is a temporary transformation queue, never a
 * delivery receipt store or a second task/watch registry.
 */
export interface PendingWatchOmission {
  watchIds: string[];
  /**
   * A checkpoint persisted before this identity existed has no `watchId` to
   * match. Its exact native source entry (captured from Pi's supported session
   * projection while building the request) identifies the target instead, so
   * identical rendered text never collapses two entries into one edit or
   * points an edit at protected consumed history.
   */
  legacyEntryId?: string;
  /** "omit": the whole payload was obsolete. "replace": only some executions were. */
  mode: "omit" | "replace";
  keptExecutionIds: string[];
}

/**
 * Wake, watch, and launch-notice delivery. The controller delegates its
 * public watch()/wake() names here after its own admission/fence checks;
 * every timer and pending inspection lives in this module.
 */
export class WakeDelivery {
  /**
   * Issue #222: pending launch-notice gates by execution id. Set only by a
   * non-model-initiated start/add (human command or scheduler), or human steer,
   * that carries a notice; process-local and never persisted, cleared when the
   * group retires or the controller detaches. A restored group never
   * resurrects its gate — restarts deliver the ordinary notifications without
   * one.
   */
  readonly launchNoticeGates = new Map<string, Promise<void>>();
  readonly watches = new Map<string, WatchRecord>();
  pendingWatchInspections: BackgroundInspection[] = [];
  pendingWatchOmissions: PendingWatchOmission[] = [];
  watchDeliveryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly env: WakeDeliveryEnv) {}

  setLaunchNoticeGate(executionId: string, gate: Promise<void>): void {
    const prior = this.launchNoticeGates.get(executionId);
    // Concurrent add/steer requests share this one ordering lane; none may
    // replace another pending notice and release its dependent outcomes early.
    const pending = prior ? Promise.all([prior, gate]).then(() => undefined) : gate;
    this.launchNoticeGates.set(executionId, pending);
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

  /**
   * The store's opaque origin. It is rotated at the actual detach/reset
   * boundary (`clearWatches`), never once per process, so a runtime that
   * survives `session_start` still cannot read a retired origin's queued
   * checkpoint as live work.
   */
  private watchOriginTokenValue = randomUUID();

  get watchOriginToken(): string {
    return this.watchOriginTokenValue;
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
      watchId: randomUUID(),
      originId: this.env.sessionOriginId?.() ?? "",
      originToken: this.watchOriginTokenValue,
    };
    const timer = setTimeout(() => this.queueWatchDelivery(executionId, subscription), afterMs);
    timer.unref?.();
    this.watches.set(executionId, { timer, subscription, phase: "armed" });
    return subscription;
  }

  cancelWatch(executionId: string): boolean {
    const current = this.watches.get(executionId);
    if (!current) return false;
    // The observable cancel semantics are unchanged: only an armed
    // subscription counts as cancelled. The record itself is retained in the
    // SAME store so a checkpoint that already fired keeps its exact pending
    // identity (and an active sibling keeps being distinguishable) until
    // consumption or origin rotation decides its lifecycle.
    const wasArmed = current.phase === "armed";
    if (current.timer) clearTimeout(current.timer);
    current.timer = undefined;
    current.phase = "retired";
    this.pendingWatchInspections = this.pendingWatchInspections.filter((inspection) => inspection.executionId !== executionId);
    return wasArmed;
  }

  clearWatches(): void {
    for (const record of this.watches.values()) if (record.timer) clearTimeout(record.timer);
    this.watches.clear();
    this.pendingWatchInspections = [];
    this.pendingWatchOmissions = [];
    // Rotating the opaque origin at the actual boundary is what makes an old
    // origin's queued or persisted checkpoint content undecidable-as-fresh in
    // the new one; nothing here mirrors a session or manager generation.
    this.watchOriginTokenValue = randomUUID();
    if (this.watchDeliveryTimer) clearTimeout(this.watchDeliveryTimer);
    this.watchDeliveryTimer = undefined;
  }

  /**
   * Issue #452: a run that ended aborted or errored consumed nothing. Retire
   * every generation that fired but was not proven consumed, so an old run can
   * never assert active work in a later run even while sibling tasks are still
   * active and the checkpoint's own deadline already passed.
   */
  retireUnconsumedWatchGenerations(): void {
    for (const record of this.watches.values()) {
      if (record.phase === "fired" && !record.omissionProposed) record.phase = "retired";
    }
  }

  private queueWatchDelivery(executionId: string, expected: BackgroundWatchSubscription): void {
    const current = this.watches.get(executionId);
    // The one-shot subscription is consumed by its own firing: the record
    // stays (same watchId, phase "fired") and a second release of the same
    // deadline is inert.
    if (!current || current.subscription !== expected || current.phase !== "armed") return;
    current.phase = "fired";
    current.timer = undefined;
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
      const identities = inspections
        .flatMap((inspection): SubtaskWatchDeliveryIdentity[] => {
          // Cancellation/replacement removes the pending inspection before a
          // send. Read its generation from the sole canonical watch store;
          // never keep a parallel identity cache synchronized with it.
          const record = this.watches.get(inspection.executionId);
          if (record?.phase !== "fired") return [];
          const { executionId, watchId, originId, originToken, armedAt, dueAt } = record.subscription;
          return [{ executionId, watchId, originId, originToken, armedAt, dueAt }];
        });
      pi.sendMessage({
        customType: SUBTASK_WATCH_CUSTOM_TYPE,
        content,
        display: true,
        // One identity per coalesced execution: a multi-execution payload must
        // never collapse to one generation discriminator.
        details: { executions: inspections, watches: identities },
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

  /**
   * Issue #452 residual: consume-side freshness for one BUILT model request.
   * The existing fire-time check (`activeCount === 0` at the deadline) cannot
   * cover the window between the send and the model actually reading the
   * steered content: a checkpoint can be injected while valid and then have
   * its work settle, be replaced by a rearm, be retired by an actionable wake,
   * or be drained into an aborted run's teardown without any provider request.
   * This guard re-decides each payload's exact generation from the canonical
   * lifecycle store only, and can only ever REDUCE a claim: it never enables a
   * delivery, arms anything, or settles anything. It returns a replacement
   * message list only when something was left out; the request's message copy
   * is never mutated in place, and the raw session history stays intact.
   */
  filterWatchCheckpointsForConsumption(messages: readonly unknown[], projectionEntries: readonly unknown[] = []): { messages?: unknown[] } {
    if (messages.length === 0) return {};
    // Entry provenance for payloads this gate cannot attribute to a generation:
    // Pi's supported projection pairs each model-visible message with the raw
    // entry that owns it, so a pending legacy claim is targeted by EXACT entry
    // id rather than by matching rendered text.
    const projected: Array<{ message: unknown; entryId: string }> = [];
    for (const item of projectionEntries) {
      if (!isRecord(item) || !isRecord(item.sourceEntry)
        || typeof item.sourceEntry.id !== "string" || !Array.isArray(item.messages)) continue;
      for (const message of item.messages) projected.push({ message, entryId: item.sourceEntry.id });
    }
    const projectedMessages = projected.map((item) => item.message);
    for (let index = 0; index < projected.length; index += 1) {
      const item = projected[index]!;
      if (isSubtaskWatchMessage(item.message) && !subtaskWatchIdentitiesOf(item.message)
        && this.watchConsumptionEvidence(projectedMessages, index) !== "consumed") {
        this.noteLegacyWatchOmission(item.entryId);
      }
    }
    let next: unknown[] | undefined;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      // Any other notification type (subtask event, launch/steer notice,
      // background-shell wake, scheduled turn) is left exactly as it is.
      if (!isSubtaskWatchMessage(message)) continue;
      const identities = subtaskWatchIdentitiesOf(message);
      if (!identities) {
        // A checkpoint persisted before this identity existed (or any own-type
        // payload whose generation cannot be attributed): a demonstrably
        // consumed one is preserved history and stays untouched, while an
        // unattributable PENDING claim fails closed to omission and still gets
        // its durable entry-targeted edit, so no later successful response can
        // rehabilitate it.
        if (this.watchConsumptionEvidence(messages, index) === "consumed") continue;
        next ??= [...messages];
        next[index] = undefined;
        continue;
      }
      const verdicts = identities.map((identity) => this.watchGenerationVerdict(identity, messages, index));
      const kept = identities.filter((_, position) => verdicts[position] === "keep");
      if (kept.length === identities.length) continue;
      const omitted = identities.filter((_, position) => verdicts[position] === "omit");
      next ??= [...messages];
      const content = isRecord(message) ? message.content : undefined;
      const retained = typeof content === "string"
        ? retainSubtaskWatchExecutions(content, kept.map((identity) => identity.executionId))
        : undefined;
      if (retained === undefined) {
        next[index] = undefined;
        this.noteWatchOmission(omitted, "omit", []);
        continue;
      }
      next[index] = { ...(message as Record<string, unknown>), content: retained };
      this.noteWatchOmission(omitted, "replace", kept.map((identity) => identity.executionId));
    }
    if (!next) return {};
    return { messages: next.filter((message) => message !== undefined) };
  }

  /**
   * One payload entry's verdict, decided only from the canonical store, the
   * current session binding, and the live task projection. A generation whose
   * content was already omitted stays omitted, so a later successful response
   * cannot heal a suppressed checkpoint into a fresh active-work claim.
   */
  private watchGenerationVerdict(
    identity: SubtaskWatchDeliveryIdentity,
    messages: readonly unknown[],
    index: number,
  ): "keep" | "omit" {
    const record = this.watches.get(identity.executionId);
    const matches = record !== undefined
      && record.subscription.watchId === identity.watchId
      && record.subscription.originId === identity.originId
      && record.subscription.originToken === identity.originToken;
    if (matches && record.omissionProposed) return "omit";
    const evidence = this.watchConsumptionEvidence(messages, index);
    if (evidence === "consumed") {
      // A truly consumed historical checkpoint keeps its content: the raw
      // record and what the model already acted on are never rewritten.
      return "keep";
    }
    const currentOrigin = this.env.sessionOriginId?.();
    const originBound = typeof currentOrigin === "string" && currentOrigin.length > 0
      && currentOrigin === identity.originId
      && identity.originToken === this.watchOriginTokenValue;
    const liveBacking = matches && originBound
      && record.phase === "fired"
      && this.watchWorkStillActive(identity.executionId) === true;
    if (evidence === "consuming") {
      // This request is the content's only consumption opportunity so far, so
      // the canonical lifecycle decides: a generation that already settled,
      // was retired by an actionable wake, was superseded by a rearm, or lost
      // its session/origin binding cannot assert active work.
      return liveBacking ? "keep" : "omit";
    }
    // Injected into an earlier request that never consumed it (aborted or
    // errored teardown, or an intervening new turn): retire the generation in
    // the SAME canonical store so no later run can present it as fresh work,
    // even while sibling tasks stay active.
    if (matches) record.phase = "retired";
    return "omit";
  }

  /** Live active-task count for the execution; an unreadable projection is
   * treated as not-active (fail closed on the stale claim). */
  private watchWorkStillActive(executionId: string): boolean | undefined {
    try {
      return this.env.inspect(executionId).activeCount > 0;
    } catch {
      return undefined;
    }
  }

  /**
   * Consumption evidence from the built list itself — no receipt store, and no
   * claim that a context build proves a provider request (the probe observed a
   * teardown drain where the build ran and no provider request followed).
   * Pi 1.4 agent-loop.streamAssistantResponse calls transformContext BEFORE
   * convertToLlm: this hook sees custom AgentMessages, not the user messages
   * that coding-agent/messages.convertToLlm later supplies to the provider.
   *
   * - "consuming": nothing but same-drain custom messages follows, so this
   *   very request is the content's first chance to be read.
   * - "consumed": the first following response completed (`stop`, `toolUse`,
   *   or `length`), so the owning model read the content.
   * - "unconsumed": the following response was non-completing, or a new user
   *   turn intervened before any response.
   */
  private watchConsumptionEvidence(messages: readonly unknown[], index: number): "consuming" | "consumed" | "unconsumed" {
    for (let position = index + 1; position < messages.length; position += 1) {
      const message = messages[position];
      if (!isRecord(message)) continue;
      if (message.role === "custom") continue;
      if (message.role === "assistant") {
        return message.stopReason === "stop" || message.stopReason === "toolUse" || message.stopReason === "length"
          ? "consumed"
          : "unconsumed";
      }
      return "unconsumed";
    }
    return "consuming";
  }

  /** Record the boundary work for the OBSOLETE payload entries whose content
   * was left out, so the suppression becomes durable instead of request-local.
   * A kept (valid or consumed) entry is never marked, so it cannot be
   * suppressed by a later build. */
  private noteWatchOmission(
    omittedIdentities: readonly SubtaskWatchDeliveryIdentity[],
    mode: "omit" | "replace",
    keptExecutionIds: string[],
  ): void {
    for (const identity of omittedIdentities) {
      const record = this.watches.get(identity.executionId);
      if (record && record.subscription.watchId === identity.watchId) record.omissionProposed = true;
    }
    const watchIds = omittedIdentities.map((identity) => identity.watchId);
    if (this.pendingWatchOmissions.some((pending) => pending.watchIds.join("|") === watchIds.join("|"))) return;
    this.pendingWatchOmissions.push({ watchIds, mode, keptExecutionIds });
  }

  /** The same durable boundary work for an own-type payload that carries no
   * generation identity (persisted before #452), targeted by its exact native
   * source entry id. Without projection provenance no legacy edit is proposed;
   * the request-local suppression above still applies on every request. */
  private noteLegacyWatchOmission(entryId: string): void {
    if (this.pendingWatchOmissions.some((pending) => pending.legacyEntryId === entryId)) return;
    this.pendingWatchOmissions.push({ watchIds: [], legacyEntryId: entryId, mode: "omit", keptExecutionIds: [] });
  }

  /**
   * Pi's supported append-only boundary drafts (#452): for each payload whose
   * obsolete content was omitted from a request, one `context_edit` on the
   * active branch. `replacement: null` omits the entry from FUTURE model
   * context; a replacement of the retained subset keeps the still-valid
   * coalesced executions' original snapshot text. Raw history, UI, exports,
   * and session accounting stay unchanged, and applying the edit before the
   * next request is what stops a suppressed checkpoint from healing. A target
   * is only re-proposed when the branch does not already yield the projection
   * this guard needs, so a partial reduction can later be strengthened to a
   * full omission on the same exact entry, and no entry is ever mutated.
   */
  watchOmissionEntryDrafts(branchEntries: readonly unknown[]): Array<{ type: "context_edit"; targetId: string; replacement: { content: string } | null }> {
    if (this.pendingWatchOmissions.length === 0) return [];
    // Pi applies the LATEST edit for a target on the active branch, so an
    // existing edit never disqualifies a stronger later one. What the branch
    // already yields is compared against the projection this guard needs:
    // an already-satisfied proposal is dropped instead of requeued forever.
    const effective = new Map<string, { content: string } | null>();
    const candidates: Array<{ entryId: string; entry: Record<string, unknown>; identities: SubtaskWatchDeliveryIdentity[] | undefined }> = [];
    for (const entry of branchEntries) {
      if (!isRecord(entry)) continue;
      if (entry.type === "context_edit" && typeof entry.targetId === "string") {
        effective.set(entry.targetId, isRecord(entry.replacement) && typeof entry.replacement.content === "string"
          ? { content: entry.replacement.content }
          : null);
        continue;
      }
      if (entry.type !== "custom_message" || entry.customType !== SUBTASK_WATCH_CUSTOM_TYPE) continue;
      if (typeof entry.id !== "string") continue;
      candidates.push({ entryId: entry.id, entry, identities: subtaskWatchIdentitiesOf(entry) });
    }
    const drafts: Array<{ type: "context_edit"; targetId: string; replacement: { content: string } | null }> = [];
    const resolved: PendingWatchOmission[] = [];
    for (const pending of this.pendingWatchOmissions) {
      const candidate = candidates.find(({ entryId, identities }) => pending.legacyEntryId !== undefined
        ? entryId === pending.legacyEntryId
        : identities?.some((identity) => pending.watchIds.includes(identity.watchId)) === true);
      if (!candidate) continue;
      let desired: { content: string } | null;
      if (pending.mode === "omit") {
        desired = null;
      } else {
        const raw = typeof candidate.entry.content === "string" ? candidate.entry.content : undefined;
        const retained = raw === undefined ? undefined : retainSubtaskWatchExecutions(raw, pending.keptExecutionIds);
        if (retained === undefined) desired = null;
        else if (retained === raw) { resolved.push(pending); continue; }
        else desired = { content: retained };
      }
      const current = effective.get(candidate.entryId);
      const alreadyApplied = effective.has(candidate.entryId)
        && (desired === null
          ? current === null
          : current !== undefined && current !== null && current.content === desired.content);
      if (alreadyApplied) {
        // The branch already projects exactly what this guard needs; the
        // request-local re-evaluation of the unchanged raw entry is satisfied.
        resolved.push(pending);
        continue;
      }
      drafts.push({ type: "context_edit", targetId: candidate.entryId, replacement: desired });
      effective.set(candidate.entryId, desired);
      resolved.push(pending);
    }
    if (resolved.length > 0) {
      this.pendingWatchOmissions = this.pendingWatchOmissions.filter((pending) => !resolved.includes(pending));
    }
    return drafts;
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
    let pending: Promise<void> | undefined;
    do {
      pending = this.launchNoticeGateOf(eventOwner ?? owner);
      await pending;
      // A new human action may install its gate while this wake awaits an
      // earlier notice. Recheck the same canonical lane before sending.
    } while (pending !== this.launchNoticeGateOf(eventOwner ?? owner));
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