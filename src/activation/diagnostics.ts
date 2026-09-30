import { sendNotice } from "../pi";
import {
  SessionStateCwdMismatchError,
  SessionStateCheckpointBaselineError,
  SessionStateConversationMismatchError,
  SessionStateGitBaselineError,
  SessionStateIntegrityError,
  SessionStateInvalidStateError,
  SessionStateMissingSelectionDigestError,
  SessionStateParseError,
  SessionStateUnsupportedFormatError,
  type PendingDeliverySummary,
  type SessionStateStore,
} from "../session-state";

const MAX_DELIVERY_DIAGNOSTIC_CHARS = 200;

export function boundDeliveryDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_DELIVERY_DIAGNOSTIC_CHARS) {
    return singleLine;
  }
  const marker = "… (truncated)";
  return `${singleLine.slice(0, MAX_DELIVERY_DIAGNOSTIC_CHARS - marker.length)}${marker}`;
}

const SAFE_DIAGNOSTIC_ERRNO_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

/**
 * A trusted diagnostic for session-state restore/quarantine failures, derived
 * only from fixed categories or Node errno codes. Raw error message text is
 * never used: JSON.parse errors may quote sidecar content (including pending
 * message text) and filesystem/validation errors may repeat unbounded paths.
 * Paths must be disclosed separately, only through boundPath.
 */
export function safeRestoreFailureDiagnostic(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code === "string" && SAFE_DIAGNOSTIC_ERRNO_PATTERN.test(code)) return `errno ${code}`;
  if (error instanceof SessionStateParseError) return "invalid JSON";
  if (error instanceof SessionStateInvalidStateError) return "invalid persisted state";
  if (error instanceof SessionStateUnsupportedFormatError) return "unsupported pre-cutover session format (missing snapshot omission ledger)";
  if (error instanceof SessionStateMissingSelectionDigestError) return "unsupported pre-cutover session format (missing reviewer-selection digest)";
  if (error instanceof SessionStateGitBaselineError) return `Git checkpoint baseline verification failed (${error.reason})`;
  if (error instanceof SessionStateCheckpointBaselineError) return `checkpoint baseline verification failed (${error.reason})`;
  if (error instanceof SessionStateIntegrityError) return "integrity check failed";
  if (error instanceof SessionStateConversationMismatchError) return "conversation mismatch";
  return "validation failed";
}

/**
 * Send a notice best-effort: notification failures must never propagate into
 * persistence decisions (e.g. disabling a store whose quarantine succeeded).
 */
export async function sendNoticeUnlessItThrows(target: unknown, message: string): Promise<void> {
  try {
    await sendNotice(target, message);
  } catch {
    // Notification is best-effort; never let it affect persistence state.
  }
}

/**
 * Send a notice only while the session is still active; unlike
 * sendNoticeUnlessItThrows, send failures propagate to the caller.
 */
export async function sendNoticeWhileSessionActive(
  target: unknown,
  message: string,
  isSessionActive: () => boolean,
): Promise<void> {
  if (!isSessionActive()) {
    return;
  }
  await sendNotice(target, message);
}

const MAX_NOTICE_PATH_CHARS = 160;
const MAX_NOTICE_TOKEN_CHARS = 40;
const MAX_NOTICE_COUNT_ENTRIES = 8;

/** Bound a path disclosed in a notice so notices stay concise. */
export function boundPath(path: string): string {
  if (path.length <= MAX_NOTICE_PATH_CHARS) return path;
  const marker = "… (truncated)";
  return `${path.slice(0, MAX_NOTICE_PATH_CHARS - marker.length)}${marker}`;
}

/** Bound an arbitrary token (e.g. a status/kind label from a sidecar). */
function boundToken(token: string): string {
  if (token.length <= MAX_NOTICE_TOKEN_CHARS) return token;
  return `${token.slice(0, MAX_NOTICE_TOKEN_CHARS - 1)}…`;
}

/** Render aggregate counts with bounded entry count and token length. */
function formatCountEntries(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_NOTICE_COUNT_ENTRIES)
    .map(([key, count]) => `${boundToken(key)} ${count}`);
  const total = Object.keys(counts).length;
  if (total > MAX_NOTICE_COUNT_ENTRIES) entries.push(`+${total - MAX_NOTICE_COUNT_ENTRIES} more`);
  return entries.join(", ");
}

/**
 * Render the safe pending-delivery summary for a notice: counts only, never
 * message text or delivery identifiers.
 */
function formatPendingDeliverySummary(summary: PendingDeliverySummary): string {
  const parts = [`${summary.total} pending delivery record(s) preserved`];
  const statuses = formatCountEntries(summary.byStatus);
  if (statuses) parts.push(`status: ${statuses}`);
  const kinds = formatCountEntries(summary.byKind);
  if (kinds) parts.push(`kinds: ${kinds}`);
  return parts.join("; ");
}

/**
 * Handle a same-conversation/different-cwd restore rejection: quarantine the
 * authoritative sidecar to a unique sibling path before any fresh-state save,
 * then notify with the mismatch, quarantine path, and safe pending-record
 * summary. If quarantine fails, fail closed: leave the prior sidecar in place,
 * disable the store so the unconditional save cannot overwrite it, and emit an
 * actionable preservation notice.
 */
export async function handleCwdMismatchRestore(
  noticeTarget: unknown,
  stateStore: SessionStateStore,
  error: SessionStateCwdMismatchError,
  currentCwd: string,
): Promise<void> {
  let quarantinePath: string;
  try {
    // Only the quarantine operation is guarded: once it succeeds the prior
    // sidecar is safely preserved and persistence must stay enabled so the
    // unconditional fresh save for the new cwd can proceed.
    quarantinePath = await stateStore.quarantine();
  } catch (quarantineError) {
    stateStore.markUnavailable(`quarantine failed: ${safeRestoreFailureDiagnostic(quarantineError)}`);
    await sendNoticeUnlessItThrows(
      noticeTarget,
      `review gate: persisted conversation state belongs to a different working directory (stored: ${boundPath(error.storedCwd)}, current: ${boundPath(error.currentCwd)}) and could not be quarantined (${safeRestoreFailureDiagnostic(quarantineError)}); the prior state file was left untouched at ${boundPath(stateStore.path)}; review-gate persistence is disabled for this session to avoid overwriting it; resolve the mismatch manually and restart`,
    );
    return;
  }
  await sendNoticeUnlessItThrows(
    noticeTarget,
    `review gate: persisted conversation state belongs to a different working directory (stored: ${boundPath(error.storedCwd)}, current: ${boundPath(error.currentCwd)}); quarantined to ${boundPath(quarantinePath)}; ${formatPendingDeliverySummary(error.pendingDeliveries)}; starting fresh state for ${boundPath(currentCwd)}`,
  );
}
