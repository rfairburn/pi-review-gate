/**
 * Issue #191: model-visible feedback for subtask interruptions.
 *
 * A human `/subtask-interrupt` previously reported its result only to the UI,
 * so the next model turn could not tell that the user had stopped the work.
 * This module renders that feedback from the durable command records of the
 * exact interrupt request (never from the requested mode or the task state
 * alone) and queues it through the host's ordinary custom-message lane as
 * steering, so it is delivered at the next supported boundary and triggers a
 * turn when the session is idle. It adds no queue, state machine, or lock of
 * its own.
 *
 * The user-intent line is always qualified as intent: it states what the user
 * asked for, while the stop and merge settlement are reported separately and
 * truthfully (acknowledged, stopped before this queued attempt's executor
 * startup, unconfirmed, failed, unrecorded, or rejected). A stop before
 * startup describes only the queued attempt: a queued continuation may follow
 * earlier attempts whose edits, session, or checkpoint are retained, so the
 * feedback never infers that no earlier work or checkpoint exists.
 * The same settlement lines are appended to a model `SubtasksInterrupt`
 * result with the model origin, never a user label.
 */
import type { BackgroundInspection } from "./background-controller";
import type { BackgroundTaskKind } from "./task-state";
import { capNotificationText } from "./subtask-notifications";
import { redactSensitiveText } from "../redaction";

export const SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE = "pi-review-subtask-interrupt";

/** Exact user-intent line; qualified as intent so it never claims a stop. */
export const USER_INTERRUPT_INTENT_LINE = "User intent: interrupted by user; do not restart without authorization.";

/** Hard cap on one delivered feedback note. */
export const SUBTASK_INTERRUPT_FEEDBACK_MAX_CHARS = 2_400;

export type InterruptMode = "interrupt_as_failure" | "interrupt_with_merge";
export type InterruptActor = "model" | "user" | "system";

/** How the stop half of one interrupt request settled, from its own command record. */
export type InterruptStopSettlement =
  /** No command record exists for this request: it did not take effect. */
  | "rejected"
  /**
   * The current queued attempt was stopped before its executor startup. Says
   * nothing about earlier attempts (a queued continuation may retain work).
   */
  | "stopped_before_start"
  /** The controller acknowledged the stop. */
  | "acknowledged"
  /** The command failed or is not yet acknowledged: the stop is not confirmed. */
  | "unconfirmed";

/**
 * How the merge half settled; only interrupt_with_merge requests a merge.
 * `unrecorded`: the request failed after its stop was acknowledged but no
 * force-merge record exists for it, so whether a merge was attempted at all is
 * unknown (the failure may precede the merge call, e.g. a persistence error).
 */
export type InterruptMergeSettlement = "not_requested" | "not_attempted" | "acknowledged" | "failed" | "pending" | "unrecorded";

export interface InterruptSettlement {
  executionId: string;
  kind: BackgroundTaskKind;
  taskId: string;
  title: string;
  mode: InterruptMode;
  /** The recorded actor of this request's command (falls back to the caller's actor). */
  actor: InterruptActor;
  stop: InterruptStopSettlement;
  stopDetail: string;
  merge: InterruptMergeSettlement;
  mergeDetail?: string;
  /** Interrupt-phase activity recorded at or after this request's command. */
  evidence: string[];
  state: string;
  summary?: string;
  requestError?: string;
}

/** Redact before bounding so a credential can never survive as a cut fragment. */
function clip(value: string, max: number): string {
  return capNotificationText(redactSensitiveText(value).replace(/\s+/g, " ").trim(), max);
}

/**
 * Classify one interrupt request from the durable command records in a
 * post-request inspection. Returns undefined when the task is not present.
 */
export function interruptSettlementOf(input: {
  inspection: BackgroundInspection;
  taskId: string;
  instructionId: string;
  mode: InterruptMode;
  actor: InterruptActor;
  requestError?: string;
}): InterruptSettlement | undefined {
  const task = input.inspection.tasks.find((candidate) => candidate.taskId === input.taskId);
  if (!task) return undefined;
  const command = task.commands.find((candidate) => candidate.action === "interrupt" && candidate.instructionId === input.instructionId);
  const forceMerge = task.commands.find((candidate) => candidate.action === "force_merge" && candidate.instructionId === `${input.instructionId}-force-merge`);
  let stop: InterruptStopSettlement;
  let stopDetail: string;
  if (!command) {
    stop = "rejected";
    stopDetail = "this request was not recorded for the task, so it did not stop anything.";
  } else if (command.status === "acknowledged" && !command.deliveredAt) {
    stop = "stopped_before_start";
    stopDetail = "acknowledged before executor startup of the current queued attempt; that queued attempt never started. This says nothing about earlier attempts or any work, session, or checkpoint they retained.";
  } else if (command.status === "acknowledged") {
    stop = "acknowledged";
    stopDetail = "acknowledged.";
  } else {
    stop = "unconfirmed";
    stopDetail = command.status === "failed"
      ? `NOT confirmed; the interrupt command failed: ${clip(command.error ?? "no error recorded", 400)}`
      : `NOT confirmed; the interrupt command is still ${command.status}.`;
  }
  let merge: InterruptMergeSettlement = "not_requested";
  let mergeDetail: string | undefined;
  if (input.mode === "interrupt_with_merge") {
    if (forceMerge?.status === "acknowledged") {
      merge = "acknowledged";
      mergeDetail = `the mechanical merge attempt was acknowledged; the task state is now ${task.state}. This does not verify that the requested changes are present or correct; inspect the main workspace manually.`;
    } else if (forceMerge?.status === "failed") {
      merge = "failed";
      mergeDetail = `the mechanical merge failed: ${clip(forceMerge.error ?? "no error recorded", 400)}`;
    } else if (forceMerge) {
      merge = "pending";
      mergeDetail = `the mechanical merge is not settled (command ${forceMerge.status}).`;
    } else if (stop === "acknowledged" && input.requestError) {
      // No force-merge record correlates with this request: the error may have
      // occurred before any merge was called (for example a persistence failure
      // after quiescence), so never claim that a merge was attempted or failed.
      merge = "unrecorded";
      mergeDetail = "no merge record exists for this request; it failed after the stop was acknowledged, so whether a merge was attempted is unknown and no landing is confirmed. See the request error.";
    } else {
      merge = "not_attempted";
      mergeDetail = stop === "stopped_before_start"
        ? "no merge was attempted by this request for the current queued attempt; this does not indicate whether earlier work or a retained checkpoint exists."
        : stop === "unconfirmed"
          ? "no merge was attempted because the stop was not confirmed."
          : "no merge was attempted by this request.";
    }
  }
  // A stop before executor startup records only the controller's own
  // pre-start summary as interrupt activity; that legacy wording can claim no
  // checkpoint exists even when a queued continuation retains earlier work, so
  // it is never echoed here (the Stop/Merge lines carry the proved outcome).
  const evidence = command && stop !== "stopped_before_start"
    ? task.activity
      .filter((event) => event.phase === "interrupt" && event.at >= command.createdAt)
      .slice(-3)
      .map((event) => clip(event.message, 300))
    : [];
  return {
    executionId: input.inspection.executionId,
    kind: input.inspection.kind,
    taskId: task.taskId,
    title: task.definition.title,
    mode: input.mode,
    actor: command?.actor ?? input.actor,
    stop,
    stopDetail,
    merge,
    ...(mergeDetail ? { mergeDetail } : {}),
    evidence,
    state: task.state,
    ...(task.summary ? { summary: task.summary } : {}),
    ...(input.requestError ? { requestError: input.requestError } : {}),
  };
}

function settlementLines(settlement: InterruptSettlement): string[] {
  const lines = [`Stop: ${settlement.stopDetail}`];
  for (const event of settlement.evidence) lines.push(`Recorded interrupt activity: ${event}`);
  if (settlement.mergeDetail) lines.push(`Merge: ${settlement.mergeDetail}`);
  return lines;
}

function taskLine(target: { executionId: string; kind: BackgroundTaskKind; taskId: string; title: string; mode: InterruptMode }): string {
  return `Task ${target.taskId} (${clip(target.title, 120)}) in ${target.kind} execution ${target.executionId}; requested mode ${target.mode}.`;
}

export interface InterruptFeedbackMessage {
  content: string;
  details: Record<string, unknown>;
}

/**
 * The note queued when a human interrupt_with_merge starts, before any
 * landing or conflict notification that merge may itself trigger. It states
 * only the user's intent and never claims that anything stopped or landed.
 */
export function formatUserInterruptRequestedFeedback(target: {
  executionId: string;
  kind: BackgroundTaskKind;
  taskId: string;
  title: string;
  mode: InterruptMode;
}): InterruptFeedbackMessage {
  const content = capNotificationText([
    "Subtask interrupt requested from the human /subtask-interrupt command (context only).",
    taskLine(target),
    USER_INTERRUPT_INTENT_LINE,
    "Settlement is pending: this note does not claim that the task stopped or that anything landed; the stop and merge outcome are reported separately.",
  ].join("\n"), SUBTASK_INTERRUPT_FEEDBACK_MAX_CHARS);
  return {
    content,
    details: {
      origin: "human-command",
      actor: "user",
      phase: "requested",
      executionId: target.executionId,
      kind: target.kind,
      taskId: target.taskId,
      mode: target.mode,
    },
  };
}

/**
 * The settlement note for one human /subtask-interrupt request. A stop before
 * executor startup omits the carried task summary: the controller's pre-start
 * wording may claim that no checkpoint exists, which a queued continuation
 * with retained earlier work would contradict; the Stop/Merge lines already
 * state everything proved about the current queued attempt.
 */
export function formatUserInterruptSettlementFeedback(settlement: InterruptSettlement): InterruptFeedbackMessage {
  const outcome = settlement.summary && settlement.stop !== "stopped_before_start"
    ? ` Authoritative outcome: ${clip(settlement.summary, 500)}`
    : "";
  const lines = [
    "Subtask interrupt result from the human /subtask-interrupt command (context only).",
    taskLine(settlement),
    USER_INTERRUPT_INTENT_LINE,
    ...settlementLines(settlement),
    `Current task state: ${settlement.state}.${outcome}`,
  ];
  if (settlement.requestError) lines.push(`Request error: ${clip(settlement.requestError, 400)}`);
  return {
    content: capNotificationText(lines.join("\n"), SUBTASK_INTERRUPT_FEEDBACK_MAX_CHARS),
    details: {
      origin: "human-command",
      actor: settlement.actor,
      phase: "settled",
      executionId: settlement.executionId,
      kind: settlement.kind,
      taskId: settlement.taskId,
      mode: settlement.mode,
      stop: settlement.stop,
      merge: settlement.merge,
      state: settlement.state,
    },
  };
}

/**
 * Settlement lines for a model SubtasksInterrupt result. The origin is the
 * recorded actor of the request, so no user label is ever applied here.
 */
export function formatInterruptSettlementForTool(settlement: InterruptSettlement): string {
  return capNotificationText([
    `Interrupt settlement for this request (origin: ${settlement.actor === "model" ? "model SubtasksInterrupt call" : `${settlement.actor} request`}; task ${settlement.taskId}; mode ${settlement.mode}):`,
    ...settlementLines(settlement),
  ].join("\n"), SUBTASK_INTERRUPT_FEEDBACK_MAX_CHARS);
}

/**
 * Queue one feedback note through the host's ordinary custom-message lane as
 * steering, so it is never left waiting for a turn that may not come: a
 * streaming session delivers it at that turn's next supported boundary, and an
 * idle session starts a turn. Returns false when the host has no channel or
 * rejected the send synchronously (for example a stale extension context after
 * session replacement), so it is never delivered to another session.
 */
export function deliverInterruptFeedback(pi: unknown, message: InterruptFeedbackMessage): boolean {
  if (typeof pi !== "object" || pi === null) return false;
  const send = (pi as { sendMessage?: unknown }).sendMessage;
  if (typeof send !== "function") return false;
  try {
    const sent = send.call(pi, {
      customType: SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE,
      content: message.content,
      display: true,
      details: message.details,
    }, { deliverAs: "steer", triggerTurn: true });
    if (typeof (sent as PromiseLike<unknown> | undefined)?.then === "function") {
      Promise.resolve(sent).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}
