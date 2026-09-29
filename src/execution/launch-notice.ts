/**
 * Issue #222 (partial #215 integration): the ONE shared delivery abstraction
 * for non-model-initiated subtask launch notices. A successful human
 * `/subtask-add` and a successful scheduled subtask admission both wake the
 * top-level model through this module — the same model-delivery lane, the
 * same redaction and bounds, the same non-interrupting behavior, and the same
 * causal ordering before a fast result notification. Only origin-specific
 * context differs; no scheduler-only or command-only model-notification path
 * exists beside it.
 *
 * Delivery shape: a followUp that still triggers a turn (the orchestrator
 * learns about the launch on its next turn; an already-active turn is never
 * interrupted by the notice). Ordering: the controller holds every result
 * notification for the launched execution behind a launch-notice gate
 * (see launchNoticeGate), so a subtask that settles in milliseconds can never
 * deliver a completion or failure event before the launch notice that names
 * it. The notice itself never dispatches a duplicate task and never implies
 * progress, completion, or a running state — it reports only the admission
 * and the handles, with a single short acknowledgement cue (issue #220).
 */
import type { BackgroundTaskKind } from "./task-state";
import { capNotificationText } from "./subtask-notifications";
import { redactSensitiveText } from "../redaction";

/** Origins that share this mechanism; recorded as notice metadata. */
export type SubtaskLaunchOrigin = "human-command" | "scheduled";

/** Bounded task handle carried in the notice. */
export interface SubtaskLaunchTaskHandle {
  taskId: string;
  title: string;
}

/** The origin metadata and handles of one non-model-initiated subtask launch. */
export interface SubtaskLaunchNotice {
  origin: SubtaskLaunchOrigin;
  executionId: string;
  kind: BackgroundTaskKind;
  tasks: readonly SubtaskLaunchTaskHandle[];
  /** Exact task ids created by this admission (human add-to-existing groups). */
  addedTaskIds?: readonly string[];
  /**
   * Origin-specific scheduled context, present only for origin "scheduled".
   * The due minute is the sampled occurrence identity, never the dispatch
   * instant.
   */
  scheduled?: { entryId: string; entryName: string; dueAt: Date; cron: string };
}

/** Hard cap on the delivered notice text; details fields are bounded too. */
export const SUBTASK_LAUNCH_NOTICE_MAX_CHARS = 2_000;
/** Maximum rendered task handles per notice. */
export const SUBTASK_LAUNCH_NOTICE_MAX_TASKS = 5;

/**
 * The causal-ordering gate between a launch notice and the launched
 * execution's result notifications. `pending` is passed to the controller
 * with the start/admission call; the controller holds every wake for that
 * execution until `resolve()` runs — and no caller resolves the gate before
 * its launch-notice delivery attempt has settled (or been reported as
 * unsettled). There is deliberately NO self-expiring watchdog here: a slow
 * admission (managed-image verification, workspace resolution) is never
 * allowed to pre-release an execution's result notifications. Bound the
 * delivery attempt itself instead (see deliverSubtaskLaunchNotice), report
 * the failure, and only then resolve the gate.
 */
export interface LaunchNoticeGate {
  readonly pending: Promise<void>;
  resolve(): void;
}

export function launchNoticeGate(): LaunchNoticeGate {
  let resolveGate!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  return { pending, resolve: resolveGate };
}

/** Bounded, redacted task description line. */
function launchTaskLine(handle: SubtaskLaunchTaskHandle): string {
  return `- ${handle.taskId} · ${clipRedacted(handle.title, 120)}`;
}

/**
 * Redact sensitive material first, then apply the bound: bounding first could
 * cut a credential at the limit, leaving a fragment that no longer matches
 * the token patterns and would be delivered to the model unredacted.
 */
function clipRedacted(value: string, max: number): string {
  return capNotificationText(redactSensitiveText(value), max);
}

/**
 * Pure renderer for the shared notice: bounded and redacted on every
 * model-controlled field, with origin metadata carried structurally in
 * `details`. Completes without I/O so tests can inspect the exact content.
 *
 * The content is deliberately concise (issue #220): factual admission
 * identity — origin, execution id and kind, task handles, and the scheduled
 * or human-command origin context — followed by one short acknowledgement
 * cue. No narrative about outcomes, required actions, duplicates, or the
 * delivery mechanics: those facts are either carried structurally in
 * `details` or belong to the ordinary result notifications.
 */
export function formatSubtaskLaunchNotice(notice: SubtaskLaunchNotice): { content: string; details: Record<string, unknown> } {
  const scheduled = notice.origin === "scheduled" && notice.scheduled !== undefined;
  const lines: string[] = scheduled
    ? [
      `Scheduled task ${notice.scheduled!.entryId} (${clipRedacted(notice.scheduled!.entryName, 160)}) was admitted as execution ${notice.executionId} (${notice.kind}).`,
      `Due occurrence: ${formatLaunchDueLabel(notice.scheduled!.dueAt)} for cron "${notice.scheduled!.cron}".`,
    ]
    : [
      `A new background ${notice.kind} execution ${notice.executionId} was admitted from a human /subtask-add command.`,
    ];
  const handles = notice.tasks.slice(0, SUBTASK_LAUNCH_NOTICE_MAX_TASKS);
  for (const handle of handles) lines.push(launchTaskLine(handle));
  if (notice.tasks.length > handles.length) {
    lines.push(`- ${notice.tasks.length - handles.length} more task(s); handles are bounded to ${SUBTASK_LAUNCH_NOTICE_MAX_TASKS} lines.`);
  }
  if (!scheduled && notice.addedTaskIds !== undefined) {
    lines.push(`Added in this submission: ${notice.addedTaskIds.slice(0, SUBTASK_LAUNCH_NOTICE_MAX_TASKS).join(", ")}`);
  }
  // The delivery still triggers a turn, so one brief cue replaces the former
  // no-outcome/lifecycle/quiet-noisy/progress/duplicate/empty-response prose:
  // the model must not return an empty response, and nothing else is known
  // here beyond the admission itself.
  lines.push("Acknowledge briefly.");
  const content = capNotificationText(lines.join("\n"), SUBTASK_LAUNCH_NOTICE_MAX_CHARS);
  const details: Record<string, unknown> = {
    origin: notice.origin,
    executionId: notice.executionId,
    kind: notice.kind,
    tasks: notice.tasks.slice(0, SUBTASK_LAUNCH_NOTICE_MAX_TASKS).map((handle) => ({
      taskId: handle.taskId,
      title: clipRedacted(handle.title, 200),
    })),
    ...(notice.addedTaskIds !== undefined ? { addedTaskIds: [...notice.addedTaskIds] } : {}),
    ...(scheduled
      ? {
        scheduled: {
          entryId: notice.scheduled!.entryId,
          entryName: clipRedacted(notice.scheduled!.entryName, 160),
          dueAt: notice.scheduled!.dueAt.toISOString(),
          cron: notice.scheduled!.cron,
        },
      }
      : {}),
  };
  return { content, details };
}

/** Local-time label of the exact sampled due minute (shared with scheduler events). */
function formatLaunchDueLabel(dueAt: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offsetMinutes = -dueAt.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${dueAt.getFullYear()}-${pad(dueAt.getMonth() + 1)}-${pad(dueAt.getDate())} `
    + `${pad(dueAt.getHours())}:${pad(dueAt.getMinutes())} ${offset} (local)`;
}

/** The delivered message shape asserted by tests and produced by both call sites. */
export interface SubtaskLaunchMessage {
  customType: "pi-review-subtask-launch";
  content: string;
  display: true;
  details: Record<string, unknown>;
}

/**
 * Deliver one launch notice through the shared lane: a non-interrupting
 * followUp that still triggers a turn. Returns "unavailable" when the host
 * has no sendMessage channel or definitively rejected the send, and
 * "uncertain" when the host's send promise did not settle within the bounded
 * delivery window (the send may still enqueue or resolve later) — the caller
 * reports exactly what is and is not known through the honest-reporting paths
 * and only then releases the result notifications. Never a silent success
 * claim, and never a false claim of definite non-delivery. A synchronously
 * throwing host sendMessage is caught and converted to "unavailable" as well
 * (the caller's report names the failure), because throwing across an
 * admission boundary would misreport an admitted execution as failed.
 */
export async function deliverSubtaskLaunchNotice(
  pi: unknown,
  notice: SubtaskLaunchNotice,
  options?: { timeoutMs?: number },
): Promise<"delivered" | "unavailable" | "uncertain"> {
  if (!isRecord(pi) || typeof pi.sendMessage !== "function") return "unavailable";
  try {
    const { content, details } = formatSubtaskLaunchNotice(notice);
    const sent = pi.sendMessage(
      {
        customType: "pi-review-subtask-launch",
        content,
        display: true,
        details,
      } satisfies SubtaskLaunchMessage,
      { deliverAs: "followUp", triggerTurn: true },
    );
    // A synchronous void send is accepted immediately; a host that returns a
    // promise for the send participates in the bounded delivery attempt, so
    // a wedged message channel can never hold result notifications forever.
    if (!isPromiseLike(sent)) return "delivered";
    const outcome = await Promise.race([
      sent.then(() => "delivered" as const, () => "unavailable" as const),
      new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), options?.timeoutMs ?? LAUNCH_NOTICE_DELIVERY_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (outcome === "timeout") {
      // A timed-out send is UNCERTAIN, not failed: the host may still enqueue
      // or later acknowledge the notice. Suppress the late settle and let the
      // caller report exactly what is and is not known before releasing the
      // result notifications.
      Promise.resolve(sent).catch(() => undefined);
      return "uncertain";
    }
    return outcome;
  } catch {
    return "unavailable";
  }
}

/** Longest wait for a host's send promise before the delivery is reported failed. */
export const LAUNCH_NOTICE_DELIVERY_TIMEOUT_MS = 10_000;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}