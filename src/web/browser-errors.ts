import { classifyPublicUrlError, PublicUrlValidationError } from "./network.js";
import { asError, bounded } from "./browser-primitives.js";

/**
 * Manager-owned browser error identity and classification (issue #153).
 * Every message here is fixed manager-authored text; page, network, and
 * caller-controlled content only ever flows through bounded fields or the
 * cause chain. These classes are the single authoritative definitions: the
 * interactive-browser manager re-exports them so historical imports and
 * error identities (instanceof, name) stay unchanged.
 */

export interface BrowserClosureReason {
  kind: "explicit_close" | "session_shutdown" | "fatal_error" | "idle_expiry" | "visibility_reconfigure";
  message: string;
  /**
   * Issue #632: the safe manager-computed cause of a fatal closure, when the
   * manager computed one. Fixed enum values only — never page, Playwright, or
   * network text — and never a claim that the operating-system process died:
   * an authoritative browser disconnect is loss of the session, not process
   * evidence.
   */
  category?: BrowserFailureCategory;
}

/** Typed capture rejection; page text cannot manufacture this classification. */
export class BrowserCaptureInvalidatedError extends Error {}

export class BrowserIdleExpiredError extends Error {
  constructor() { super("Browser session expired from tool inactivity. Use BrowserOpen to reopen; previous state is lost."); }
}

/** Only issued for a handle authenticated by this manager, never guesses. */
export class BrowserSessionClosedError extends Error {
  constructor(readonly closure: BrowserClosureReason | undefined) {
    super(`Browser session is closed${closure ? ` (${closure.kind}: ${closure.message})` : ""}. Use BrowserOpen to start a new browser; do not replay uncertain actions automatically.`);
    this.name = "BrowserSessionClosedError";
  }
}

export type BrowserRecoveryKind =
  | "duplicate_open"
  | "session_unknown"
  | "tabs"
  | "cancelled"
  | "unconfirmed_cleanup";

export interface BrowserRecoveryMetadata {
  kind: BrowserRecoveryKind;
  /** Dispatch phase at cancellation: no page effect, page effect possible, or unknowable. */
  phase?: "not_started" | "dispatched" | "unknown";
  /** Whether the manager proved resource cleanup; never claimed without proof. */
  cleanup?: "confirmed" | "unconfirmed";
  /** Authenticated live session revealed by a duplicate open after a lost result. */
  existingSession?: string;
  existingTab?: string;
  /** Authenticated session owning the listed tabs. */
  session?: string;
  /** Real owned tab handles, never generated placeholders. */
  ownedTabs?: readonly string[];
  /** Whether the caller may retry the same tool or must reopen via BrowserOpen. */
  recovery?: "retry" | "reopen";
}

/**
 * Structured, manager-authored recovery state for cancellation, stale-handle,
 * duplicate-open, and teardown outcomes. The message is fixed owned guidance;
 * public sanitization classifies from these fields instead of parsing
 * arbitrary exception text.
 */
export class BrowserRecoveryError extends Error {
  constructor(message: string, readonly recovery: BrowserRecoveryMetadata) {
    super(message);
    this.name = "BrowserRecoveryError";
  }
}

/**
 * Issue #632: external cancellation (BrowserClose, Pi session shutdown, a
 * visibility change, or the caller) of a read-only `BrowserWait` observation.
 * The containment policy and the structured recovery metadata are exactly
 * `operationCancellationError`'s and `operationTeardownUncertainError`'s; only
 * the fixed sentence differs, because a read-only observation cannot have
 * changed the page: it names no page or network effect and claims no rollback, and
 * it still states an unconfirmed teardown with restart recovery.
 */
export class BrowserWaitCancellationError extends BrowserRecoveryError {
  constructor(message: string, recovery: BrowserRecoveryMetadata) {
    super(message, recovery);
    this.name = "BrowserWaitCancellationError";
  }
}

/** Bounded failure phase for structured browser tool errors. */
export type BrowserFailurePhase =
  | "url_validation"
  | "broker_admission"
  | "broker_startup"
  | "chromium_startup"
  | "context_creation"
  | "navigation"
  | "teardown";

/** Safe error category: fixed codes only, never raw network or page text. */
export type BrowserFailureCategory =
  | "invalid_url"
  | "dns_resolution_failed"
  | "non_public_address_denied"
  | "policy_refused"
  | "budget_exhausted"
  | "browser_network_failure"
  | "browser_process_failure"
  | "timeout"
  | "internal_error";

/**
 * Structured, manager-owned failure state for browser tool errors. Phase and
 * category are the public contract: sanitization emits fixed bounded text
 * from them and never parses arbitrary exception text. The original error
 * stays internally attributable through the cause chain; no rollback or
 * cleanup is ever claimed from it.
 */
export class BrowserFailureError extends Error {
  constructor(
    message: string,
    readonly phase: BrowserFailurePhase,
    readonly category: BrowserFailureCategory,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BrowserFailureError";
  }
}

/** Issue #27 model credential capabilities enforced on the tool-action path. */
export type BrowserCredentialCapability = "model_credential_entry" | "model_credential_submission";

/** Issue #27 model file-transfer capabilities enforced on the tool-action path. */
export type BrowserFileTransferCapability = "model_uploads" | "model_download_saving";

/** Issue #27 model clipboard capability enforced on the tool-action path. */
export type BrowserClipboardCapability = "model_clipboard";

/**
 * Typed denial of a disabled model capability (issue #27). The message is
 * fixed manager-owned text: it names no target, value, URL, or page content,
 * and the tool boundary renders one fixed sentence per capability. Human
 * browser input never passes through this path.
 */
export class BrowserCapabilityDeniedError extends Error {
  constructor(readonly capability: BrowserCredentialCapability | BrowserFileTransferCapability | BrowserClipboardCapability) {
    super(capability === "model_credential_entry"
      ? "not_started: this target is a password or credential field and model credential entry is disabled by the managed-browser permissions; nothing was entered."
      : capability === "model_credential_submission"
        ? "not_started: this action submits a form that contains credentials and model credential submission is disabled by the managed-browser permissions; nothing was submitted."
        : capability === "model_uploads"
          ? "not_started: model file uploads are disabled by the managed-browser permissions; no file was read or sent."
          : capability === "model_clipboard"
            ? "not_started: model clipboard read/write is disabled by the managed-browser permissions; nothing was read from or written to the clipboard."
            : "not_started: model download saving is disabled by the managed-browser permissions; no file was written.");
    this.name = "BrowserCapabilityDeniedError";
  }
}

/**
 * Minimal structural view of a live session for manager-authored handle
 * errors; the full Session state never leaves the manager.
 */
export interface BrowserSessionHandleView {
  readonly handle: string;
  readonly activeTab: string;
  readonly tabs: ReadonlyMap<string, unknown>;
}

/** Fixed manager-owned cancellation reasons; never caller-controlled text. */
export const BROWSER_CLOSE_CANCEL_REASON = "Browser operation cancelled by BrowserClose.";
export const SESSION_SHUTDOWN_CANCEL_REASON = "Browser operation cancelled by Pi session shutdown/replacement/reload.";
export const VISIBILITY_CANCEL_REASON = "Browser operation cancelled by a browser visibility settings change; the browser is being replaced.";

export type BrowserCancellationKind = "close" | "shutdown" | "caller" | "visibility";

export function cancellationKind(signal: AbortSignal): BrowserCancellationKind | undefined {
  if (!signal.aborted) return undefined;
  // Classify only against fixed manager-owned reason strings; arbitrary
  // caller or page exception text is never parsed for meaning.
  const reasonMessage = signal.reason instanceof Error ? signal.reason.message : "";
  if (reasonMessage === BROWSER_CLOSE_CANCEL_REASON) return "close";
  if (reasonMessage === SESSION_SHUTDOWN_CANCEL_REASON) return "shutdown";
  if (reasonMessage === VISIBILITY_CANCEL_REASON) return "visibility";
  return "caller";
}

/** Internal marker: the page completed and reported an effect-free clipboard
 * outcome. It is rethrown precisely without session containment because the
 * browser proved no read/write happened. */
export class BrowserClipboardOutcomeError extends Error {}

export class BrowserValidationError extends Error {}

/**
 * Issue #632: one bounded outcome of a read-only `BrowserWait` observation.
 * A wait only reads the page, so these outcomes never describe page-effect or
 * rollback uncertainty; the tool boundary renders fixed observation text from
 * the kind. The manager only issues `deadline`, `condition_error`, and
 * `document_changed` after it proved the owning session and tab stayed live,
 * and only issues the unsettled kinds after the fail-closed containment path.
 * `unsettled` is the internal hand-off kind: containment always replaces it
 * with `unsettled_contained` or `unsettled_unconfirmed` before it escapes.
 * Each loss kind carries the one recovery that works in that state:
 * `session_unavailable` is whole-browser/session loss recovered by `BrowserOpen`,
 * `tab_unavailable` is one closed observed tab inside a still-live session
 * recovered by `BrowserTabs operation=list` on that session, and
 * `session_unavailable_unconfirmed` means containment could not confirm
 * quiescence, so the Pi session must be restarted. Each keeps observation
 * wording: a settled read-only observation is never described as unsettled page
 * work, and no loss kind offers a choice of two recoveries.
 */
export type BrowserWaitFailureKind =
  | "deadline"
  | "condition_error"
  | "document_changed"
  | "tab_unavailable"
  | "session_unavailable"
  | "session_unavailable_unconfirmed"
  | "unsettled"
  | "unsettled_contained"
  | "unsettled_unconfirmed";

export class BrowserWaitFailureError extends Error {
  constructor(readonly kind: BrowserWaitFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserWaitFailureError";
  }
}

export function invalidSessionHandleError(): BrowserRecoveryError {
  return new BrowserRecoveryError(
    "Invalid or stale browser session handle: it was not issued by this manager, or a different owner holds it. Use BrowserOpen to start a browser for this Pi session; BrowserSnapshot cannot recover an unknown session.",
    { kind: "session_unknown" },
  );
}

export function invalidTabHandleError(view: BrowserSessionHandleView): BrowserRecoveryError {
  const ownedTabs = [...view.tabs.keys()];
  const listing = ownedTabs.length > 0
    ? `Current owned tabs: ${ownedTabs.join(", ")}.`
    : "No other tabs are currently owned by this session.";
  return new BrowserRecoveryError(
    `Invalid or stale browser tab handle for this session. ${listing} Take a fresh BrowserSnapshot on an owned tab, or switch with BrowserTabs.`,
    { kind: "tabs", session: view.handle, ownedTabs },
  );
}

export function duplicateOpenError(existing: BrowserSessionHandleView): BrowserRecoveryError {
  return new BrowserRecoveryError(
    `A live browser is already open for this Pi session: session=${existing.handle} with active tab=${existing.activeTab}. An earlier successful BrowserOpen result may have been lost to a rewind or Escape. Use BrowserTabs operation=list on that session to recover its handles, then BrowserNavigate or BrowserClose; this BrowserOpen preserved the live session and opened no new browser.`,
    { kind: "duplicate_open", existingSession: existing.handle, existingTab: existing.activeTab },
  );
}

export function openCancellationError(cancellation: BrowserCancellationKind, dispatched: boolean): BrowserRecoveryError {
  const by = cancellation === "shutdown"
    ? " by Pi session shutdown/replacement/reload"
    : cancellation === "close" ? " by BrowserClose"
    : cancellation === "visibility" ? " by a browser visibility settings change" : "";
  if (!dispatched) {
    return new BrowserRecoveryError(
      `BrowserOpen was cancelled${by} before navigation dispatch; no page effects occurred and cleanup was confirmed. It is safe to retry BrowserOpen.`,
      { kind: "cancelled", phase: "not_started", cleanup: "confirmed", recovery: "retry" },
    );
  }
  return new BrowserRecoveryError(
    `BrowserOpen was cancelled${by} after navigation dispatch; network effects may have occurred, effect status is unknown, and no rollback is claimed. Cleanup was confirmed; use BrowserOpen to start a new browser session.`,
    { kind: "cancelled", phase: "dispatched", cleanup: "confirmed", recovery: "reopen" },
  );
}

export function unconfirmedOpenCleanupError(): BrowserRecoveryError {
  return new BrowserRecoveryError(
    "BrowserOpen failed and teardown could not be confirmed; browser resources may remain. This browser manager is fail-closed: recover by restarting the Pi session (terminal restart or reload) before further browser use. Effect status is unknown; no rollback is claimed.",
    { kind: "unconfirmed_cleanup", phase: "unknown", cleanup: "unconfirmed" },
  );
}

/** Fixed owned text plus structured fields; the original stays in the cause. */
export function browserFailure(cause: Error, phase: BrowserFailurePhase, category: BrowserFailureCategory): BrowserFailureError {
  return new BrowserFailureError(bounded(cause.message, 500), phase, category, { cause });
}

export const DEADLINE_ERROR_PATTERN = /exceeded its \d{1,8}ms total deadline/;

/** Classify one failed BrowserOpen startup stage; the outcome is unchanged. */
export function classifySetupFailure(error: Error, stage: BrowserFailurePhase): BrowserFailureError {
  if (error instanceof BrowserFailureError) return error;
  let category: BrowserFailureCategory;
  // Site-assigned typed categories are authoritative and cannot be shadowed
  // by caller-controlled text in the message.
  if (error instanceof PublicUrlValidationError) category = error.category;
  else if (DEADLINE_ERROR_PATTERN.test(error.message)) category = "timeout";
  else if (stage === "url_validation") category = classifyPublicUrlError(error);
  else category = "internal_error";
  return browserFailure(error, stage, category);
}

/**
 * Classify manager-owned session-fatal errors from their fixed strings. These
 * messages are owned constants, not page or network content; the original
 * error remains internally attributable through the cause chain.
 */
export function classifyFatalSessionError(error: Error): Error {
  if (error instanceof BrowserFailureError || error instanceof BrowserRecoveryError) return error;
  let category: BrowserFailureCategory = "internal_error";
  if (/disconnected unexpectedly|tab crashed|Last browser tab closed unexpectedly/i.test(error.message)) {
    category = "browser_process_failure";
  } else if (/redirect hops|main-document request limit/i.test(error.message)) {
    category = "budget_exhausted";
  }
  return browserFailure(error, "navigation", category);
}

/** Safe category for one failed Chromium navigation (fixed net tokens only).
 * The leading Chromium token is checked first: it precedes any URL in the
 * message, so caller-controlled text cannot shadow it. */
export function classifyNavigationError(error: Error): BrowserFailureCategory {
  const token = /\bnet::ERR_[A-Z0-9_]{1,64}\b/u.exec(error.message)?.[0];
  switch (token) {
    case "net::ERR_NAME_NOT_RESOLVED":
    case "net::ERR_NAME_RESOLUTION_FAILED":
      return "dns_resolution_failed";
    case "net::ERR_TIMED_OUT":
      return "timeout";
    default:
      break;
  }
  if (DEADLINE_ERROR_PATTERN.test(error.message)) return "timeout";
  return "browser_network_failure";
}

export function operationCancellationError(cancellation: BrowserCancellationKind, phase: "not_started" | "dispatched" | "unknown"): BrowserRecoveryError {
  const by = cancellation === "close"
    ? " by BrowserClose"
    : cancellation === "shutdown" ? " by Pi session shutdown/replacement/reload" : "";
  if (cancellation === "visibility") {
    const effect = phase === "not_started"
      ? "No page effects occurred."
      : "Page or network effects may have occurred, effect status is unknown, and no rollback is claimed.";
    return new BrowserRecoveryError(
      `Browser operation was cancelled by a browser visibility settings change; the live browser is being replaced and every old session/tab/ref handle is invalidated. ${effect} A replacement browser with new handles is issued by the settings save when restoration succeeds; otherwise use BrowserOpen.`,
      { kind: "cancelled", phase, cleanup: "confirmed", recovery: "reopen" },
    );
  }
  if (phase === "not_started") {
    return new BrowserRecoveryError(
      `Browser operation was cancelled${by} before dispatch; effect status is not_started and no page effects occurred. Session teardown was confirmed; use BrowserOpen to start a new browser session.`,
      { kind: "cancelled", phase: "not_started", cleanup: "confirmed", recovery: "reopen" },
    );
  }
  if (phase === "dispatched") {
    return new BrowserRecoveryError(
      `Browser operation was cancelled${by} after dispatch; page or network effects may have occurred, effect status is unknown, and no rollback is claimed. Cleanup was confirmed; use BrowserOpen to start a new browser session.`,
      { kind: "cancelled", phase: "dispatched", cleanup: "confirmed", recovery: "reopen" },
    );
  }
  return new BrowserRecoveryError(
    `Browser operation was cancelled${by}; effect status is unknown and no rollback is claimed. Session teardown was confirmed; use BrowserOpen to start a new browser session.`,
    { kind: "cancelled", phase: "unknown", cleanup: "confirmed", recovery: "reopen" },
  );
}

/**
 * Issue #632: cancellation of the read-only `BrowserWait` observation. The
 * recovery metadata is identical to `operationCancellationError`'s (confirmed
 * teardown) or `operationTeardownUncertainError`'s (unconfirmed teardown), so
 * the containment policy and every structured field stay unchanged; only the
 * fixed sentence differs, because a wait cannot change the page.
 */
export function waitCancellationError(
  cancellation: BrowserCancellationKind,
  phase: "not_started" | "dispatched" | "unknown",
  teardown: "confirmed" | "unconfirmed",
): BrowserWaitCancellationError {
  const by = cancellation === "shutdown"
    ? " by Pi session shutdown/replacement/reload"
    : cancellation === "close" ? " by BrowserClose"
    : cancellation === "visibility" ? " by a browser visibility settings change" : "";
  if (teardown === "unconfirmed") {
    return new BrowserWaitCancellationError(
      `BrowserWait was cancelled${by} during its bounded read-only observation; the call cannot change the page, so no page effect occurred and no rollback applies. Session teardown could not be confirmed and browser resources may remain: recover by restarting the Pi session (terminal restart or reload) before further browser use.`,
      { kind: "unconfirmed_cleanup", phase: "unknown", cleanup: "unconfirmed" },
    );
  }
  return new BrowserWaitCancellationError(
    `BrowserWait was cancelled${by} during its bounded read-only observation; the call cannot change the page, so no page effect occurred and no rollback applies. Session teardown was confirmed; use BrowserOpen to start a new browser for this Pi session.`,
    { kind: "cancelled", phase, cleanup: "confirmed", recovery: "reopen" },
  );
}

export function operationTeardownUncertainError(): BrowserRecoveryError {
  return new BrowserRecoveryError(
    "Browser operation failed and teardown could not be confirmed; browser resources may remain. This browser manager is fail-closed: recover by restarting the Pi session (terminal restart or reload) before further browser use. Effect status is unknown; no rollback is claimed.",
    { kind: "unconfirmed_cleanup", phase: "unknown", cleanup: "unconfirmed" },
  );
}

export function invalidRefError(): Error {
  return new BrowserValidationError("Invalid or stale browser semantic ref; take a fresh BrowserSnapshot for the current session, tab, and document.");
}

export function normalizedInteractionFailure(
  name: "BrowserHover" | "BrowserClick" | "BrowserFill" | "BrowserType" | "BrowserSelect" | "BrowserPress" | "BrowserUpload" | "BrowserDownloadSave" | "BrowserClipboard",
  error: unknown,
): Error {
  if (error instanceof BrowserSessionClosedError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/\b(?:not_started|effect status is (?:started|completed|unknown))\b/i.test(message)) return asError(error);
  if (/Invalid or stale browser session handle|Browser session is closed/.test(message)) {
    return new Error(`${name} not_started: browser session is closed or unknown; use BrowserOpen to start a browser for this Pi session (BrowserSnapshot cannot recover it).`);
  }
  if (/Invalid or stale browser tab handle/.test(message)) {
    return new Error(`${name} not_started: invalid or stale owned tab capability; list owned tabs with BrowserTabs and take a fresh BrowserSnapshot.`);
  }
  if (/Invalid or stale browser semantic ref/.test(message)) {
    return new Error(`${name} not_started: invalid or stale owned semantic capability; take a fresh BrowserSnapshot.`);
  }
  if (/Invalid or stale browser download handle/.test(message)) {
    return new Error(`${name} not_started: invalid or stale owned download capability; list this tab's pending downloads with BrowserDownloadSave (no destination) and retry with a current handle.`);
  }
  return new Error(`${name} failed before dispatch; effect status is not_started.`);
}
