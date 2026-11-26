/**
 * #736 slice 3a: the host-side automatic primary review for one native row.
 *
 * A hosted native Claude Code or Codex row has no Pi process to attach the
 * activation coordinator in ../activation/review-turn to. What it has is the
 * blocking hook lane (./native-review-hook-relay + ./native-review-hook-protocol):
 * one `UserPromptSubmit` request when the user submits a prompt and one `Stop`
 * request when the provider finishes a turn, each held open until the host
 * answers. This module is the host side of that pair: it turns those two
 * requests into the SAME automatic primary review a Pi turn gets, and turns the
 * review's outcome into the verdict the provider acts on.
 *
 * It is deliberately Pi-free (no `@earendil-works/pi-*`, no `../index`, no
 * `../activation/*`) so the row's own host process — which is not a Pi process —
 * can construct it, and so the review semantics it mirrors stay inspectable:
 * everything below is the same `../state`, `../review`, `../review-evidence`,
 * `../review-checkpoint`, and `../transmission` machinery the Pi path drives,
 * reused rather than reimplemented.
 *
 * What is mirrored from `../activation/review-turn`, and what cannot be:
 *
 *   - The toggle: master `config.enabled` AND the backend-specific
 *     `effectiveReviewSettings(...).primaryClaudeCodeEnabled` /
 *     `primaryCodexEnabled` per-row switch. Off means no reviewer runs and no
 *     notice, and an open window is closed rather than left holding pins.
 *   - Arming: `UserPromptSubmit` remembers the request and captures the
 *     baseline exactly where `armAgentRun` does — evidence policy honored, but
 *     a configured Tools only selection arms NOTHING: no baseline is captured,
 *     the window is disabled, and the user is warned once per conversation that
 *     these turns are not reviewed, because a native row records no tool
 *     evidence a Tools only review could read. Otherwise one
 *     `captureReviewCheckpoint`, the window's configuration frozen for the whole
 *     window, and a capture failure that is not fallback-eligible failing
 *     CLOSED. This lane never latches Tools only after a snapshot failure: Tools
 *     only cannot review a native row, so a latch would silently end review for
 *     the conversation. A window whose arm did fail to attach a
 *     baseline is never armed by a later prompt either — not by a prompt the host
 *     answered before its slot ever ran — as Pi's `reviewDisabledWindow`
 *     guarantees.
 *   - Settlement: `Stop` is the row's `agent_settled`. It runs one
 *     `runReview` over the window baseline and maps the run output to a verdict
 *     with the same branches, the same transmission dispositions and actions,
 *     and the same correction-cap and repeated-no-progress guards. A window that
 *     never got a baseline closes quietly there, as it does in Pi, so a later
 *     prompt opens a fresh window instead of piling into an unreviewable one.
 *
 * What differs because a native row is not a Pi session, stated plainly:
 *
 *   - State is in-memory only. Nothing is persisted or restored, so a host
 *     restart loses windows; every descriptor and bundle this module owns is
 *     released at `dispose()` instead.
 *   - There is no manual surface (`/review-now`, `/review-continue`,
 *     `/review-clear`, `/ask-reviewer`) and no terminal Escape or
 *     `/review-cancel` path, so a deferral that Pi would follow up on just
 *     stands, and the only user channel is the verdict's `userMessage`.
 *   - A completed review closes its window outright. Pi keeps a finished
   *     window reachable for `/ask-reviewer`; a native row has no such question
 *     to ask, so an accepted turn's window is closed and its baseline
 *     released, and the next prompt opens a fresh window with a fresh
 *     baseline, request history, frozen configuration, and correction count
 *     instead of inheriting an already-passed delta. Windows that are still
 *     unresolved — deferred at the correction cap, or waiting on a repeated
 *     no-progress decision — stay open exactly as they do in Pi.
 *   - `requireNewToolActivity` is TRUE, with the row's own qualifying-activity
 *     fact supplied as `qualifyingToolActivity`: a native row reports a tool
 *     call only as a name plus a read-only flag, so it has no evidence events
 *     for Pi's evidence-derived check to read. Zero reported activity is never
 *     a review, and a turn that does not qualify still settles through
 *     `runReview`, which returns the no-review outcome and decides whether the
 *     window closes.
 *   - Cancellation is the provider hanging up: the broker aborts the handler's
 *     signal when the row's socket closes, and `dispose()` aborts in-flight
 *     reviews. An aborted review keeps its baseline so the next `Stop`
 *     re-reviews, and returns `allow` because the relay is gone and nothing can
 *     be delivered.
 *   - Every request also carries an OVERALL deadline a little inside the
 *     provider's own hook timeout (see `deadlineMs`). A review that outlives the
 *     hook answering it would starve this conversation's serialized queue and
 *     answer nobody, so the deadline aborts it through the SAME cancellation
 *     path — baseline kept, this turn's qualifying activity unspent, the change
 *     still pending for the next `Stop` — and the one thing it adds over a
 *     hang-up is a bounded notice saying the turn was not reviewed in time. That
 *     notice travels on a reply promise of its own: a stage that is awaiting the
 *     filesystem rather than a process cannot be interrupted by an abort, so the
 *     provider must not be held behind one, while the cancelled settlement keeps
 *     its place in the conversation's chain so it can never overlap a later
 *     request's window.
 *   - The evidence method is the workspace checkpoint, full stop. A native row
 *     reports a tool call only as a name plus a read-only flag (the transport
 *     refuses tool arguments and results by contract), so a configured Tools
 *     only selection arms no window at all: `armConversation` captures no
 *     baseline and warns once per conversation with a native-specific notice,
 *     and the unarmed window closes quietly at its `Stop` with the turn allowed
 *     — never a review that found nothing, and never a pass. Arming still
 *     honors that policy and still discloses it, exactly as specified; what a
 *     native row cannot do is turn a tool name into evidence.
 *
 * Two invariants this lane holds itself, because nothing above it would:
 *
 *   - OWNERSHIP. A review's reviewed after-baseline is reachable only from the
 *     active exchange, and `runReview` retires that exchange as the turn
 *     settles. A host that released only what state still lists would strand
 *     that record or Git pin with no owner left to find it, so every descriptor
 *     this module takes is remembered per conversation and retired as soon as
 *     settlement makes it unreachable — on every exit, including cancellation
 *     and a thrown failure. Descriptors a retry still needs stay reachable, so
 *     they are never touched.
 *   - DELIVERABILITY. A verdict's `reason` and `userMessage` are bounded
 *     transport fields, and a verdict the broker cannot encode answers the
 *     closed `failed` code — which would unreview a turn this host did review.
 *     So the reviewer's own text is normalized and bounded BEFORE its feedback
 *     is recorded and a response exchange is armed, and a request that has
 *     already been cancelled records nothing. Complete reviewer text is never
 *     dropped or silently cut: an oversized transmission is replaced by a
 *     bounded form that points at the immutable bundle holding all of it.
 *
 * `onReviewRequest` never throws. Any unexpected failure becomes an `allow`
 * with a notice: a review that could not run must never strand a user's turn,
 * and only the two documented fail-closed arms (an unusable baseline capture,
 * and a reviewer verdict) ever block.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { removeReviewBundle, removeTransientWindowBundle } from "../bundle";
import { effectiveReviewSettings, resolveReviewers, type ReviewGateConfig } from "../config";
import { createCorrectionFeedbackMarker, isRepeatedNoProgressFeedback } from "../correction-feedback";
import { rememberFinalAssistantSummaryText } from "../evidence";
import { raceNativeDetachedWork, runReview, type ReviewRunOutput } from "../review";
import {
  captureReviewCheckpoint,
  isSafeCheckpointSessionId,
  releaseReviewCheckpoint,
  type ReviewCheckpointDescriptor,
  type ReviewCheckpointScope,
} from "../review-checkpoint";
import {
  evidenceMethodNotice,
  isEligibleReviewCaptureFailure,
  isReviewableToolObservation,
  ReviewEvidenceCaptureFailure,
  primaryEvidencePolicy,
  type ReviewEvidencePolicy,
} from "../review-evidence";
import {
  recordReviewTransmissionPass,
  renderReviewTransmissionMessage,
} from "../review-transmission-pass";
import { reviewCheckpointDescriptorIdentity, reviewerSelectionDigest } from "../session-state";
import {
  activeExchangeHasBaseline,
  armReviewResponseExchange,
  beginAgentRun,
  buildRequestContext,
  closeReviewWindow,
  createState,
  freezeReviewWindowConfig,
  getCorrectionAttemptCount,
  hasUnresolvedReview,
  markCappedFeedbackSent,
  ownedReviewCheckpointDescriptors,
  reconcileWindowReviewerSelection,
  rememberUserRequest,
  setReviewWindowCheckpointBaseline,
  type ReviewGateState,
  type ReviewWindow,
} from "../state";
import {
  buildReviewAuthorizationMessage,
  type ReviewTransmissionAction,
} from "../transmission";
import { formatTokenUsage } from "../usage";
import {
  MAX_NATIVE_REVIEW_REASON_BYTES,
  MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES,
  NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS,
  type NativeReviewRequest,
  type NativeReviewVerdict,
} from "./native-review-hook-protocol";

/**
 * The coordinator's overall review deadline, derived from the provider's own
 * hook timeout with room to answer before the provider kills the hook: the
 * host's abort has to land, settle, and travel back while the relay is still
 * waiting. A config `reviewerTimeoutMs` longer than this is never capped — the
 * deadline simply wins.
 */
export const NATIVE_REVIEW_DEADLINE_MS = NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS * 1000 - 300_000;

/** The provider family this coordinator answers; decides the per-row toggle. */
export type NativeReviewCoordinatorBackend = "claude" | "codex";

/**
 * The row's background work, as the host can actually see it. `idle` is a
 * positive observation that nothing is in flight; `running` defers the review;
 * `unknown` blocks it, because reviewing while work this row started is still
 * landing would review a workspace that is not finished.
 */
export type NativeReviewBackgroundState =
  | { readonly state: "idle" }
  | { readonly state: "running"; readonly count: number }
  | { readonly state: "unknown"; readonly detail: string };

/** One completed tool call the provider reported for this row's conversation. */
export interface NativeReviewToolActivity {
  readonly toolName: string;
  readonly readOnly: boolean;
}

export interface NativeReviewCoordinatorDependencies {
  readonly backend: NativeReviewCoordinatorBackend;
  /** Absolute workspace this row works in; the review capture root. */
  readonly workspace: string;
  /** Host agent-data directory that locates raw (non-Git) checkpoint records. */
  readonly checkpointAgentDir: string;
  /** Current Review configuration, or undefined when it cannot be read. */
  readConfig(): ReviewGateConfig | undefined;
  /** Background state for the row, consulted only at settlement. */
  backgroundState(request: NativeReviewRequest): Promise<NativeReviewBackgroundState>;
  /** Host-admitted Pi executable for canonical Pi model reviewers. */
  readonly admittedPiCommand?: string;
  readonly now?: () => Date;
  /**
   * Overall deadline for ONE request, from the moment it is accepted until its
   * verdict is produced, in milliseconds; defaults to
   * {@linkcode NATIVE_REVIEW_DEADLINE_MS}. It is injectable so a focused test
   * can prove the timeout without waiting an hour. `0` or less disables it.
   */
  readonly deadlineMs?: number;
  /**
   * Focused-test seam for the read-only baseline verification await only: passed
   * straight to {@linkcode ReviewRunInput.onBaselineVerification} so one test can
   * hold that load unresolved and prove the conversation's queue still advances.
   * Production omits it and the verification runs uninterrupted.
   */
  readonly observeBaselineVerification?: () => void | Promise<void>;
  /**
   * Focused-test seam for the checkpoint comparison await only, passed to
   * {@linkcode ReviewRunInput.onCheckpointComparison}. Production omits it.
   */
  readonly observeCheckpointComparison?: () => void | Promise<void>;
  /**
   * Focused-test seam awaited after the prompt's baseline capture resolves, so
   * a test can hold a completed capture past the request's deadline.
   * Production omits it.
   */
  readonly observeBaselineCapture?: () => void | Promise<void>;
  /**
   * Focused-test seam for the arm's publish of a captured baseline into its
   * window only: awaited INSIDE the publish step, before the baseline is stored,
   * so one test can make the publish fail and reach the release of a capture
   * that must never be published. Production omits it and the publish runs
   * uninterrupted; the seam replaces no capture, no review, and no answer.
   */
  readonly observeBaselinePublish?: () => void | Promise<void>;
  /**
   * Focused-test seam for the release of a baseline capture this lane never
   * published: awaited with whether that REAL release succeeded, so one test can
   * prove a failed release is disclosed rather than swallowed and know when the
   * release ran — a detached cleanup otherwise has no observable completion.
   * Production omits it; it observes only and changes no release, capture, or
   * answer.
   */
  readonly observeUnpublishedCheckpointRelease?: (released: boolean) => void | Promise<void>;
  /**
   * Focused-test seam for the settlement's outcome mapping only: called with the
   * completed {@linkcode ReviewRunOutput} immediately before that outcome is
   * mapped, and what it returns is what the settlement maps. Production omits it
   * and maps the real run unchanged, so this can never replace a review — the
   * reviewer, its bundle, and its checkpoint all really ran. One test answers a
   * completed run with no `result` at all, which is the closed
   * `No reviewers configured.` run shape: the only run output that records no
   * verdict, and one a native settlement with a resolvable reviewer can never
   * produce by itself.
   */
  readonly reviewOutputForTests?: (output: ReviewRunOutput) => ReviewRunOutput;
  /**
   * The host's Pi-scoped models for `pi` reviewers (see the lane owner's
   * `scopedModels`). Absent is an empty scope.
   */
  readonly scopedModels?: readonly string[];
}

export interface NativeReviewCoordinator {
  onReviewRequest(request: NativeReviewRequest, signal: AbortSignal): Promise<NativeReviewVerdict>;
  noteToolActivity(sessionId: string, activity: NativeReviewToolActivity): void;
  /** True once this row has reported any tool activity at all. */
  readonly activityTracked: boolean;
  dispose(): Promise<{ unreviewedConversations: number }>;
}

/** One checkpoint descriptor this coordinator has taken responsibility for. */
interface OwnedDescriptor {
  readonly cwd: string;
  readonly descriptor: ReviewCheckpointDescriptor;
}

/**
 * Why one prompt failed to arm its window, and why no later prompt may capture
 * into that window either (see `Conversation.reviewDisabled`).
 * `tools_only` is the configured method a native row can never review,
 * `capture` is an eligible snapshot failure, and `aborted` is a prompt arm the
 * provider hang-up or the request's own deadline ended before it armed.
 */
type ReviewDisabledReason = "tools_only" | "capture" | "aborted";

/** One conversation's review state, owned entirely by this module. */
interface Conversation {
  readonly sessionId: string;
  readonly scope: ReviewCheckpointScope;
  readonly state: ReviewGateState;
  /** This conversation's serialized request chain; never shared across ids. */
  chain: Promise<unknown>;
  /**
   * Every in-flight request of this conversation. Superseding a conversation
   * aborts them: a session switch ENDS the old review, it does not merely
   * prevent it from spending the incoming conversation's disclosure.
   */
  readonly controllers: Set<AbortController>;
  /** True once superseded by another conversation; no new request joins it. */
  closed: boolean;
  /**
   * #736 U6: the non-read-only activity count as of this window's LAST RECORDED
   * review — Pi's watermark, which `hasNewQualifyingToolCall` measures from
   * `window.reviewHistory.at(-1)`. It is set when a window first gets its
   * baseline and advances only when a verdict is recorded, so a review that
   * recorded nothing (aborted, deadline, thrown, no verdict, undeliverable
   * transmission) is retried by the next `Stop` with no new tool call, and a
   * later prompt of an armed window never spends pending activity.
   */
  mark: number;
  /** True once the configured-Tools-only notice was shown for this conversation. */
  toolsOnlyNoticed?: boolean;
  /**
   * True once a snapshot-failure notice (fallback On) was shown for this
   * conversation; cleared when a snapshot succeeds, so a later failure warns again.
   */
  captureFailureNoticed?: boolean;
  /**
   * #736 R-fix: a reconcile notice this conversation's window composed but could
   * not deliver. A `Stop` that reconciled its window and then answered a quiet
   * allow carries no user notice, and the window's frozen selection is already
   * swapped, so no later `Stop` recomputes the notice — without this the change
   * would never be disclosed. Kept per window, delivered once by the next `Stop`
   * that can carry a notice, and cleared when the window closes.
   */
  pendingReconcileNotice?: { readonly window: ReviewWindow; readonly notice: string };
  /**
   * The window whose prompt arm failed to attach a baseline, mirroring Pi's
   * `reviewDisabledWindow`: a later arm of THAT window never captures, so work
   * the failed turn left unreviewed can never be certified by a later baseline.
   * Per window, so once the window closes (its `Stop` retires a window with no
   * baseline) the next window arms normally. Runtime-only, like Pi's.
   */
  reviewDisabled?: { readonly window: ReviewWindow; readonly reason: ReviewDisabledReason };
  /** Memoized artifact release, so dispose and supersede never double-free. */
  release?: Promise<void>;
  /**
   * Every checkpoint descriptor identity this coordinator has owned for this
   * conversation, reachable or not. `runReview` retires the active exchange as
   * a turn settles, which drops the reviewed after-baseline out of
   * `ownedReviewCheckpointDescriptors`' reach; a coordinator that only ever
   * releases what state still lists would leave that raw record or Git pin
   * behind forever. This ledger is what makes the last owner explicit.
   */
  readonly owners: Map<string, OwnedDescriptor>;
}

/** Notices the host shows the user; the row has no other user channel. */
const UNSAFE_SESSION_NOTICE
  = "review gate: automatic review is unavailable for this conversation";
const UNREADABLE_CONFIG_NOTICE
  = "review gate: automatic review is unavailable because the Review configuration could not be read; this turn was not reviewed";
const SUPERSEDED_NOTICE
  = "review gate: the previous conversation's automatic review window closed without reviewing its latest changes";
const NO_REVIEWER_NOTICE
  = "review gate: automatic review deferred because no configured reviewer is currently available; the preserved review window stays open until a reviewer can run";
const DISPOSED_NOTICE = "review gate: automatic review is unavailable because the host session ended; this turn was not reviewed";
const CAPTURE_FAILED_NOTICE = "review gate: automatic review could not capture the workspace baseline; this turn was not reviewed";
/**
 * #736 R-fix: a baseline capture this request never published could not be
 * released either, so a raw checkpoint record is left with no owner to remove
 * it. Pi's lane raises `orphan release failed` there; a native row has no such
 * channel, so this is the one bounded line the user is told. It never blocks and
 * never fails the turn: cleanup that could not run is disclosed, not made into
 * the provider's problem. The request that hit the failure may be unable to
 * carry it — already answered by its own deadline, disconnected, or superseded
 * altogether — so it is retained at coordinator scope until an answer can deliver
 * it. See {@linkcode pendingOrphanReleaseNotice}.
 */
const ORPHAN_RELEASE_NOTICE = "review gate: a temporary review checkpoint could not be removed";
/**
 * #736 U15: the two review-START progress lines `runReview` announces through
 * its `notify` callback — see `runReview` in `src/review.ts`, which sends
 * `review gate: ${verb} ${target}` with `verb` = "reviewing changes with" for a
 * review and "asking reviewers" for a reviewer question. In Pi that is a LIVE
 * progress notice shown while the reviewer runs; a native row has no live
 * channel, so collecting it would append a stale "reviewing changes with X"
 * line AFTER the verdict the user is already reading. Only these start lines are
 * dropped — every other `notify` message (the evidence-method warnings) still
 * travels with the verdict.
 */
const REVIEW_START_PROGRESS_PREFIXES: readonly string[] = [
  "review gate: reviewing changes with",
  "review gate: asking reviewers",
];

/** True for `runReview`'s review-start progress line (see above). */
function isReviewStartProgress(message: string): boolean {
  return REVIEW_START_PROGRESS_PREFIXES.some((prefix) => message.startsWith(prefix));
}
/**
 * #736 U19: how many conversation ids may remember that the CURRENT unreadable
 * settings stretch was already warned. A long-lived lane can be handed many
 * conversation ids while its settings document stays unreadable, so the memory of
 * who has been warned is bounded; evicting the oldest id can only ever repeat one
 * notice, never block or unreview a turn.
 */
const MAX_CONFIG_UNREADABLE_WARNED_SESSIONS = 64;

/**
 * The ONE thing a timed-out review says beyond a plain cancellation: the wait
 * is over, the turn was NOT reviewed, and the change is still pending, so the
 * next turn of this conversation still earns a review.
 */
const DEADLINE_NOTICE
  = "review gate: automatic review hit its time limit and was cancelled; this turn was not reviewed"
    + " and its changes stay pending for a later turn";
/** Eligible capture failure with the fallback Off: Pi's warning, minus its Tools only advice. */
const NATIVE_REVIEW_DISABLED_NOTICE
  = "WARNING: Review disabled for this turn: the workspace snapshot could not be captured and the snapshot-failure"
    + " fallback is Off. This turn's work will not be reviewed or reported as reviewed. The next prompt tries a snapshot again.";
/** Eligible capture failure with the fallback On: said once per conversation until a snapshot succeeds. */
const NATIVE_SNAPSHOT_FALLBACK_NOTICE
  = "WARNING: the workspace snapshot could not be captured, so this session's turns are not reviewed until one succeeds;"
    + " each prompt retries the snapshot quietly";
/** Configured Tools only, said once per conversation (see `armConversation`). */
const NATIVE_TOOLS_ONLY_NOTICE
  = "review gate: Primary review evidence is set to Tools only, which cannot see a hosted native session's tool calls,"
    + " so this session's turns are not reviewed; choose Workspace changes in Review settings to review them";
/**
 * Prepended to every native review request. A native row's tool calls are
 * counted for the review trigger but never recorded as structured tool events,
 * so the bundle's empty tool-event record must not read as "nothing ran".
 */
const NATIVE_TOOL_EVIDENCE_NOTE
  = "Evidence note: this work was done in a hosted native coding-agent session. Its tool calls (edits, commands,"
    + " checks) are not recorded as structured tool events, so an empty tool-event record means those calls were not"
    + " observed, not that none were made. The captured workspace change is the reviewed evidence; the assistant's"
    + " statements about what it ran are unverified claims, neither confirmed nor contradicted by that empty record.";
/** The prompt-side counterpart: setup, not review, ran out of time. */
const PROMPT_DEADLINE_NOTICE
  = "review gate: automatic review could not prepare this turn in time; this turn will not be reviewed";
/**
 * A native row has no `/review-continue`, `/review-now`, or `/review-clear`, so
 * every deferral has to say what the user can actually do here.
 */
const NATIVE_CONTINUATION_GUIDANCE
  = "Ask the assistant to continue, or turn this provider's automatic review Off in Review settings to continue unreviewed.";
/**
 * #736 U16: the correction CAP deferral says something the general guidance
 * cannot: a hosted native row has no `/review-continue`, so the user's NEXT
 * prompt into the same window is what resumes automatic correction (see
 * `continueCappedCorrection`). `NATIVE_CONTINUATION_GUIDANCE` stays on the
 * repeated-no-progress deferral, which no prompt resumes.
 */
const NATIVE_CAP_CONTINUATION_GUIDANCE
  = "Prompt the assistant again to resume automatic correction with a fresh correction budget,"
    + " or turn this provider's automatic review Off in Review settings to continue unreviewed.";
/**
 * #736 U4: Pi's notice that an automatic review was skipped while earlier
 * requested changes are still unresolved, minus its `/review-now` sentence — a
 * hosted native row has no such command (see `NATIVE_CONTINUATION_GUIDANCE`).
 */
export const NATIVE_UNRESOLVED_FEEDBACK_NOTICE
  = "review gate: automatic review skipped because no new qualifying tool call was recorded since the last review; the earlier requested changes remain unresolved.";

/** #736 U5: Pi's unattributed-changes warning, naming the review that passed. */
function unattributedChangesNotice(reviewSequence: number): string {
  return `WARNING: review gate: Unattributed changes were detected after review ${reviewSequence} passed.`
    + " They could not be attributed to the running model and were not subject to further review.";
}

/**
 * Provider-visible text this module composes out of host or reviewer strings.
 * The transport refuses a `userMessage` or `reason` carrying a C0/DEL/C1
 * control, and a refused verdict answers the closed `failed` code — which would
 * unreview a turn this host actually reviewed. So the characters that could
 * make a notice unsendable are folded out here, and newlines are kept only
 * where a notice is deliberately multi-line.
 */
function noticeText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f\u2028\u2029]/g, " ");
}

function closedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = noticeText(message).replace(/[\r\n]+/g, " ").trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
}

/** Cut UTF-8 text to a byte bound on a character boundary, never mid-sequence. */
function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const cut = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  return cut.endsWith("\ufffd") ? cut.slice(0, -1) : cut;
}

/**
 * Join the notices one verdict carries into the ONE bounded line the provider
 * shows. The transport refuses an over-bound `userMessage` and answers the
 * closed `failed` code, which would unreview a turn this host did review, so
 * the bound is enforced here instead — whole entries first, then a byte cut.
 */
function boundedUserMessage(parts: readonly (string | undefined)[]): string | undefined {
  const kept: string[] = [];
  for (const part of parts) {
    const text = part === undefined ? "" : noticeText(part).trim();
    if (text && !kept.includes(text)) kept.push(text);
  }
  if (kept.length === 0) return undefined;
  // Whole notices first: the earliest one is the reason a turn was not
  // reviewed, so it is the last one worth shortening.
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES) kept.pop();
  return boundedText(kept.join("\n"), MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES);
}

/**
 * #736 U8: Pi's settings-save reconcile notice in this lane's one-window form.
 * Native has no settings-save event, so the same reconcile runs inside a `Stop`
 * and the same notice travels on that `Stop`'s verdict.
 */
function reconcileNoticeText(reviewerCount: number): string {
  return `review gate: 1 review window(s) reconciled to the updated reviewer settings (${reviewerCount} configured reviewer(s)); preserved evidence and history are unchanged`;
}

/**
 * What the model is told when a real transmission cannot travel inline. The
 * complete text is never dropped and never silently truncated: it stays in the
 * immutable bundle this message points at.
 */
const OVERSIZED_REASON_HEADLINE: Record<ReviewTransmissionAction, string> = {
  passed: "review gate: this pass passed, but the complete transmission is larger than this provider's inline limit.",
  correction_required:
    "review gate: the reviewer requested changes, but the complete transmission is larger than this provider's inline limit.",
  deferred:
    "review gate: automatic correction is deferred. Do not make a correction solely from this message unless the user authorizes continuation. The complete transmission is larger than this provider's inline limit.",
  review_error:
    "review gate: the reviewer failed, and the complete transmission is larger than this provider's inline limit.",
};

/**
 * The exact model-visible text this host may send for one rendered transmission.
 * Reviewer text is arbitrary, so the inline form is normalized and bounded here,
 * BEFORE the reviewer's feedback is recorded: a host must never arm a response
 * exchange for a correction it cannot actually deliver.
 */
function nativeBlockReason(rendered: string, output: ReviewRunOutput, action: ReviewTransmissionAction): string {
  const normalized = noticeText(rendered);
  if (Buffer.byteLength(normalized, "utf8") <= MAX_NATIVE_REVIEW_REASON_BYTES) return normalized;
  const headline = OVERSIZED_REASON_HEADLINE[action];
  // This pass's own transmission, never the shared window directory: at the
  // correction cap that directory holds several passes whose actions conflict.
  const pointer = output.invocationDir
    ? ` Read the complete immutable transmission at ${noticeText(join(output.invocationDir, "implementing-model-transmission.md"))}.`
    : " Read the complete immutable transmission for this pass in this host's review bundle directory.";
  const room = MAX_NATIVE_REVIEW_REASON_BYTES - Buffer.byteLength(headline, "utf8") - 1;
  return `${headline}${boundedText(pointer, Math.max(0, room))}`;
}

/**
 * One conversation's automatic primary review, driven by the two hook events.
 * See the module comment for the Pi path this mirrors and the documented
 * differences.
 */
export function createNativeReviewCoordinator(
  deps: NativeReviewCoordinatorDependencies,
): NativeReviewCoordinator {
  const now = deps.now ?? ((): Date => new Date());
  const conversations = new Map<string, Conversation>();
  /** Non-read-only tool calls reported per provider conversation id. */
  const nonReadOnlyActivity = new Map<string, number>();
  /**
   * EVERY tool call reported per provider conversation id, read-only included.
   * Pi's no-progress check reads `window.evidence.events.length`, which records
   * every tool call; a native row records no evidence events at all, so that
   * expression is a constant here and a correction turn that ran tools would be
   * judged "no new correction evidence" on its unchanged fingerprint alone.
   * This count is the native stand-in for the same fact.
   */
  const allActivity = new Map<string, number>();
  /** Every in-flight review's controller, so dispose can abort all of them. */
  const inFlight = new Set<AbortController>();
  /**
   * Releases scheduled for a superseded conversation. They live outside
   * `conversations` on purpose (the conversation is already closed), and
   * dispose still waits for them so no owned descriptor can outlive the
   * coordinator.
   */
  const pendingReleases = new Set<Promise<void>>();
  /**
   * The one-time disclosure that a previous conversation's window was closed
   * without reviewing its latest changes. It lives here rather than on a
   * conversation because the request that triggered the switch may already be
   * gone (aborted, or never able to carry a notice), and a disclosure nobody
   * saw is not a disclosure made.
   */
  let pendingDisclosure: string | undefined;
  /**
   * #736 R-fix (review pass 2): the same argument, for the disclosure that a
   * baseline capture this lane never published ALSO failed to release. It lives
   * here rather than on a conversation because the cleanup that failed can run
   * DETACHED, after the conversation whose capture it was has been superseded and
   * dropped — a warning stored on a dropped object is a warning no later request
   * can ever reach. A leaked record is a fact about this lane's checkpoint store,
   * so any conversation's next answer that can be told says it, and only that
   * delivery clears it.
   */
  let pendingOrphanReleaseNotice: string | undefined;
  let currentSessionId: string | undefined;
  let activityTracked = false;
  let disposed = false;
  /**
   * #736 U19: the two lane-wide availability notices — an unsafe conversation id
   * and a host session that has ended — are properties of THIS coordinator, not
   * of one turn, so each is said once here and every later request answers the
   * same quiet allow. Pi has no counterpart to either notice; repeating them on
   * every request made a native row noisier than Pi without saying anything new.
   * The action never changes: both paths still allow.
   */
  let unsafeSessionNoticed = false;
  let disposedNoticed = false;
  /**
   * #736 U19: the conversation ids whose CURRENT unreadable-settings stretch has
   * already been warned. It is keyed by session id and kept OUTSIDE the live
   * `Conversation` on purpose: superseding a conversation drops that object, so
   * a flag carried on it would let a provider that switches from A to B and back
   * to A hear the same warning twice inside one unreadable stretch. The whole set
   * is cleared by any request that reads the settings successfully — the settings
   * document is one lane-wide thing, so a successful read ends the stretch for
   * every conversation and the next failure warns again.
   */
  const configUnreadableWarned = new Set<string>();

  /** Record that THIS conversation's unreadable-settings stretch was disclosed. */
  function markConfigUnreadableWarned(sessionId: string): void {
    if (configUnreadableWarned.size >= MAX_CONFIG_UNREADABLE_WARNED_SESSIONS) {
      // Sets iterate in insertion order, so this drops the oldest id. The most
      // this can ever cost is one repeated notice; it never changes an action.
      const oldest = configUnreadableWarned.values().next();
      if (!oldest.done) configUnreadableWarned.delete(oldest.value);
    }
    configUnreadableWarned.add(sessionId);
  }

  const activityCount = (sessionId: string): number => nonReadOnlyActivity.get(sessionId) ?? 0;

  const allActivityCount = (sessionId: string): number => allActivity.get(sessionId) ?? 0;

  function openConversation(sessionId: string): Conversation {
    const state = createState();
    const scope: ReviewCheckpointScope = { agentDir: deps.checkpointAgentDir, sessionId };
    // The scope is the raw (non-Git) checkpoint location for THIS conversation
    // only; a window never carries it to another session id.
    state.checkpointScope = scope;
    const conversation: Conversation = {
      sessionId,
      scope,
      state,
      chain: Promise.resolve(),
      controllers: new Set(),
      closed: false,
      mark: activityCount(sessionId),
      owners: new Map(),
    };
    conversations.set(sessionId, conversation);
    return conversation;
  }

  /** Add every descriptor state currently reaches to this conversation's ledger. */
  function trackOwners(conversation: Conversation): void {
    for (const owner of ownedReviewCheckpointDescriptors(conversation.state)) {
      conversation.owners.set(reviewCheckpointDescriptorIdentity(owner.cwd, owner.descriptor), owner);
    }
  }

  /**
   * Release every ledger entry state no longer reaches. Descriptors a retry
   * still needs are still reachable, so they are never touched; this retires
   * only what settlement made orphaned.
   */
  async function retireUnreachableOwners(conversation: Conversation): Promise<void> {
    const reachable = new Set(ownedReviewCheckpointDescriptors(conversation.state)
      .map((owner) => reviewCheckpointDescriptorIdentity(owner.cwd, owner.descriptor)));
    for (const [identity, owner] of [...conversation.owners]) {
      if (reachable.has(identity)) continue;
      conversation.owners.delete(identity);
      try {
        await releaseReviewCheckpoint(owner.cwd, owner.descriptor, { scope: conversation.scope });
      } catch {
        // A failed verification deletes nothing and is never retried here.
      }
    }
  }

  /**
   * #736 R-fix: release a baseline capture that was never published into a
   * window. The release itself never throws — the provider's answer stays
   * whatever the arm decided — and it answers whether the record really went
   * away, because a rejected call and a non-`ok` result both leave a raw
   * checkpoint with no owner left to release it. A release that failed is
   * retained on the coordinator as the one user-only line it owes, for the first
   * answer that can actually deliver it.
   */
  async function releaseUnpublishedCapture(
    conversation: Conversation,
    descriptor: ReviewCheckpointDescriptor,
  ): Promise<boolean> {
    let released: boolean;
    try {
      released = (await releaseReviewCheckpoint(deps.workspace, descriptor, { scope: conversation.scope })).status === "ok";
    } catch {
      released = false;
    }
    if (!released) {
      // #736 R-fix (review pass 1): the record is still there with no owner left
      // to remove it, and whoever was releasing it may be unable to say so — the
      // notice is retained for the next answer that can carry it.
      pendingOrphanReleaseNotice = ORPHAN_RELEASE_NOTICE;
    }
    await deps.observeUnpublishedCheckpointRelease?.(released);
    return released;
  }

  /**
   * Release everything this module owns for one conversation: the live review
   * bundle (unless the run retained it deliberately), every bundle the closed
   * window remembered, and every checkpoint descriptor still reachable from the
   * window or its armed response exchange. Memoized: a superseded conversation
   * and dispose must never release the same pin twice.
   */
  function releaseConversation(conversation: Conversation, endConversation = true): Promise<void> {
    conversation.release ??= (async (): Promise<void> => {
      const state = conversation.state;
      // Everything this conversation ever owned, whether or not the closed
      // window still lists it.
      trackOwners(conversation);
      const owned = [...conversation.owners.values()];
      conversation.owners.clear();
      // The transient bundle goes first, while the window still says whether
      // the run asked to retain it; then the window closes and remembers any
      // remaining dir, and those are removed as owned shutdown artifacts.
      try {
        await removeTransientWindowBundle(state.reviewWindow);
      } catch {
        // A bundle that cannot be removed is a leaked directory, never a
        // reason to stop releasing the descriptors that pin a workspace.
      }
      closeReviewWindow(state);
      // A retained bundle outlives its window, as in Pi, whose retained
      // bundles are removed only at session end: here, when the conversation
      // itself ends (superseded or disposed), never when one window closes.
      if (endConversation) {
        for (const dir of state.ownedBundleDirs) {
          try {
            await removeReviewBundle(dir);
          } catch {
            // Same: cleanup is best-effort and never throws out of dispose.
          }
        }
        state.ownedBundleDirs.clear();
      }
      for (const owner of owned) {
        try {
          await releaseReviewCheckpoint(owner.cwd, owner.descriptor, { scope: conversation.scope });
        } catch {
          // A failed verification deletes nothing; it is never retried here.
        }
      }
    })();
    return conversation.release;
  }

  /**
   * Close this conversation's window and release what it owns, keeping the
   * conversation itself alive: a completed review and a toggle that went Off
   * both end the window, and the next prompt has to open a fresh one with a
   * fresh baseline, request history, frozen configuration, and correction
   * count. The release is deliberately not left memoized, so the artifacts of
   * that next window are still releasable.
   */
  async function retireWindow(conversation: Conversation): Promise<void> {
    // The window this conversation's arm-failure marker names is the one closing
    // here, so the marker closes with it: the next window arms normally.
    conversation.reviewDisabled = undefined;
    // #736 R-fix: so is a reconcile notice that window never got to say. The
    // next window opens with its own frozen selection and its own notice.
    conversation.pendingReconcileNotice = undefined;
    conversation.release = undefined;
    try {
      await releaseConversation(conversation, false);
    } finally {
      // The memo belongs to the window that just closed. Leaving its resolved
      // promise behind would make the NEXT window's release a no-op, and that
      // window's checkpoint and bundle would outlive the conversation.
      conversation.release = undefined;
    }
  }

  /**
   * Supersede the live conversation: it is closed AND every request still in
   * flight on it is cancelled, so a review cannot resume after its session is
   * gone and report a verdict for a turn nobody is waiting for. The release is
   * still serialized BEHIND its chain — cancelling a request must not race an
   * in-flight capture for a descriptor that capture is about to own.
   */
  function supersedeConversation(conversation: Conversation): void {
    conversation.closed = true;
    if (conversations.get(conversation.sessionId) === conversation) conversations.delete(conversation.sessionId);
    if (conversation.state.reviewWindow?.baseline !== undefined) pendingDisclosure = SUPERSEDED_NOTICE;
    for (const controller of conversation.controllers) {
      controller.abort(new Error("review gate: the conversation changed"));
    }
    const release = conversation.chain
      .catch(() => undefined)
      .then(() => releaseConversation(conversation))
      .catch(() => undefined);
    pendingReleases.add(release);
    void release.then(() => pendingReleases.delete(release));
    nonReadOnlyActivity.delete(conversation.sessionId);
    allActivity.delete(conversation.sessionId);
  }

  /**
   * Route one request to its conversation. Synchronous on purpose: the switch
   * and the chain handoff must both happen before any await, or a second
   * request could join a stale chain.
   */
  function route(sessionId: string): Conversation {
    const live = conversations.get(sessionId);
    if (live && !live.closed) {
      currentSessionId = sessionId;
      return live;
    }
    if (currentSessionId !== undefined && currentSessionId !== sessionId) {
      const previous = conversations.get(currentSessionId);
      if (previous) supersedeConversation(previous);
    }
    currentSessionId = sessionId;
    return openConversation(sessionId);
  }

  /**
   * The model scope a window's reviewers are resolved against: the host's
   * Pi-scoped models, exactly as a Pi session resolves against its own. A
   * configured Pi reviewer outside it is unresolved, as in Pi; absent is empty.
   */
  function reviewerScope(): string[] {
    return [...(deps.scopedModels ?? [])];
  }

  /**
   * Mark the window a prompt just failed to arm, so no later arm captures into
   * it. A window that already owns a baseline is never marked: the later prompts
   * of an armed window must keep reusing that baseline, which is what they do.
   * The FIRST reason is kept for the window's whole life — nothing in a disabled
   * window retries the capture, so a later prompt under different settings can
   * only answer for the failure this window actually had.
   */
  function disableWindow(conversation: Conversation, reason: ReviewDisabledReason): void {
    const window = conversation.state.reviewWindow;
    if (window && window.baseline === undefined && conversation.reviewDisabled?.window !== window) {
      conversation.reviewDisabled = { window, reason };
    }
  }

  /**
   * The disclosure for a turn this conversation cannot review because its
   * snapshot failed, chosen by the CURRENT setting and this conversation's
   * notice flags: with the fallback Off every such turn warns, as Pi does, and
   * with it On the conversation is warned once until a snapshot succeeds again.
   * `detail` is the closed capture reason, which only an arm that actually ran a
   * capture has; a prompt that skipped the capture says the same thing without it.
   */
  function captureFailureAnswer(
    conversation: Conversation,
    policy: ReviewEvidencePolicy,
    detail?: string,
  ): NativeReviewVerdict {
    if (!policy.snapshotFailureFallback) {
      return { action: "allow", userMessage: boundedUserMessage([NATIVE_REVIEW_DISABLED_NOTICE]) };
    }
    if (conversation.captureFailureNoticed) return { action: "allow" };
    conversation.captureFailureNoticed = true;
    const notice = detail === undefined
      ? NATIVE_SNAPSHOT_FALLBACK_NOTICE
      : `${NATIVE_SNAPSHOT_FALLBACK_NOTICE} (${detail})`;
    return { action: "allow", userMessage: boundedUserMessage([notice]) };
  }

  /** The master setting AND this backend's own per-row switch, as one rule. */
  function primaryReviewEnabled(config: ReviewGateConfig): boolean {
    const settings = effectiveReviewSettings(config);
    return config.enabled && (deps.backend === "claude" ? settings.primaryClaudeCodeEnabled : settings.primaryCodexEnabled);
  }

  /**
   * Take the serialized slot of a prompt the host had already answered — on its
   * own deadline, or because the row hung up. The provider proceeded with no
   * baseline, so the slot still records that this turn ran unreviewed: it opens
   * (or reuses) the conversation's window and marks it review-disabled, capturing
   * nothing. Without this, a later prompt arriving before that turn's `Stop` could
   * capture a baseline over work the lost turn's model is already doing — exactly
   * what a disabled window exists to prevent. What the prompt asked for is
   * remembered only for a window that already owns a baseline (#736 R-fix): that
   * window is still going to be reviewed, so its cancelled prompt is mid-run
   * guidance like any other prompt of that window, and it is remembered BEFORE this
   * slot reads the settings, because a settings document that cannot be read THIS
   * time neither un-asks the question nor closes the armed window — the next
   * `Stop` reviews it under whatever settings exist then. A window with no baseline
   * is never shown to a reviewer, and it closes at its own `Stop`, so its prompt
   * text stays unrecorded, as it was.
   */
  function abandonUnarmedPrompt(conversation: Conversation, request: NativeReviewRequest): void {
    // #736 R-fix: recorded first, whatever the settings turn out to say. Gated on
    // an existing baseline so this never opens a window that was never opened.
    if (conversation.state.reviewWindow?.baseline !== undefined) {
      rememberUserRequest(conversation.state, request.prompt ?? "");
    }
    let config: ReviewGateConfig | undefined;
    try {
      config = deps.readConfig();
    } catch {
      config = undefined;
    }
    // #736 U19: this is the OTHER read of the same lane-wide settings document,
    // and it runs in this prompt's serialized slot even though the prompt itself
    // was cancelled. Reading the settings successfully here ends the current
    // unreadable stretch just as it does anywhere else, so a settings document
    // that breaks again before the next live request is a NEW failure and warns.
    // A failed read consumes nothing: this path shows no notice.
    if (config !== undefined) configUnreadableWarned.clear();
    // Off, or unreadable settings, never arm a window a later prompt could
    // capture into, so there is nothing to protect.
    if (config === undefined || !primaryReviewEnabled(config)) return;
    beginAgentRun(conversation.state);
    disableWindow(conversation, "aborted");
  }

  /**
   * The row's `armAgentRun`: remember what the user asked for and make sure the
   * window owns a baseline before the provider's model starts working. Returns
   * a verdict only when arming itself must block the prompt.
   */
  async function armConversation(
    conversation: Conversation,
    config: ReviewGateConfig,
    signal: AbortSignal,
  ): Promise<NativeReviewVerdict | undefined> {
    const state = conversation.state;
    beginAgentRun(state);
    // Idempotent for a run that is already armed (a queued follow-up shares the
    // exchange its predecessor armed): never a second capture for one window.
    if (activeExchangeHasBaseline(state)) return undefined;
    const window = state.reviewWindow;
    const existing = window?.baseline;
    // No session latch: Pi switches a session to Tools only after a snapshot
    // failure, but Tools only cannot review a native row, so the latch would
    // silently end review for the conversation. Only the configured method
    // counts here; a failed snapshot is retried by each new window instead.
    const policy = primaryEvidencePolicy(config);
    const capturedAt = now().toISOString();
    if (!existing && policy.toolOnly) {
      // Configured Tools only. Pi's Tools only reviews from recorded tool calls
      // and results; a native row reports only a tool's name, never the call,
      // so a Tools only window here would have nothing a reviewer could read.
      // No window is armed, and the user is told once per conversation that
      // this setting means these turns are not reviewed — never a silent skip.
      // This runs for a disabled window too: what the current method means for a
      // native row is disclosed whether or not an earlier setting already spent
      // the window's one capture attempt.
      disableWindow(conversation, "tools_only");
      if (conversation.toolsOnlyNoticed) return undefined;
      conversation.toolsOnlyNoticed = true;
      return { action: "allow", userMessage: boundedUserMessage([NATIVE_TOOLS_ONLY_NOTICE]) };
    }
    // Pi's `reviewDisabledWindow` in this lane's shape: once a prompt failed to
    // arm THIS window, no later prompt captures into it — a baseline taken now
    // would certify the work that failed turn left unreviewed. Only the capture
    // is skipped: the prompt still gets the disclosure its CURRENT settings call
    // for, so a method or fallback switched since that failed arm is disclosed by
    // the rules above and by `captureFailureAnswer`, not silenced. The mark is
    // per window, and a window with no baseline closes at its `Stop`, so the next
    // window arms normally.
    const disabled = conversation.reviewDisabled;
    if (window && disabled?.window === window) {
      return disabled.reason === "capture"
        ? captureFailureAnswer(conversation, policy)
        : { action: "allow" };
    }
    if (existing && existing.kind !== "checkpoint") {
      // A window that already carries a non-checkpoint baseline keeps it; this
      // module never creates one, so this only guards against mixing kinds.
      if (window?.activeExchange && !window.activeExchange.baseline) window.activeExchange.baseline = existing;
      freezeReviewWindowConfig(state, config, reviewerScope());
      return undefined;
    }
    if (signal.aborted) {
      // The provider proceeds with no baseline at all, so a later prompt must
      // not capture one over the work this turn is about to do.
      disableWindow(conversation, "aborted");
      return { action: "allow" };
    }
    let captured: Awaited<ReturnType<typeof captureReviewCheckpoint>> | undefined;
    if (!existing) {
      try {
        // Raced against this request's cancellation: a capture awaiting the
        // filesystem cannot be interrupted, and the deadline must release the
        // conversation's queue rather than leave later requests behind it. A
        // late success is released, never published.
        captured = await raceNativeDetachedWork(
          signal,
          async () => {
            const result = await captureReviewCheckpoint(deps.workspace, `window-${window?.id ?? 0}-${randomUUID()}`, {
              scope: conversation.scope,
              signal,
            });
            await deps.observeBaselineCapture?.();
            return result;
          },
          async (late) => {
            // #736 R-fix (review pass 1): this cleanup runs detached, after the
            // request that captured was already answered, so a release that failed
            // is retained on the coordinator for the next deliverable answer.
            if (late.status === "ok") await releaseUnpublishedCapture(conversation, late.value);
          },
          (cleanup) => {
            pendingReleases.add(cleanup);
            const forget = (): void => { pendingReleases.delete(cleanup); };
            void cleanup.then(forget, forget);
          },
        );
      } catch (error) {
        if (signal.aborted) {
          disableWindow(conversation, "aborted");
          return { action: "allow" };
        }
        throw error;
      }
      if (signal.aborted) {
        // Finished, but after this request was cancelled: the provider already
        // proceeded without this baseline, so publishing it (or sampling the
        // activity watermark now) would claim coverage of writes it never saw.
        // #736 R-fix (review pass 1): this answer can never carry a notice, so a
        // release that failed here is retained for the next request that can.
        if (captured.status === "ok") await releaseUnpublishedCapture(conversation, captured.value);
        disableWindow(conversation, "aborted");
        return { action: "allow" };
      }
    }
    if (captured && captured.status !== "ok") {
      if (!signal.aborted && isEligibleReviewCaptureFailure(captured)) {
        // Pi's behavior for an eligible capture failure: the turn continues
        // unreviewed rather than being blocked, nothing is armed, and this
        // window is never armed afterwards — the snapshot is retried by the next
        // window, once this one closes at its `Stop`. The notice follows Pi's
        // noise rules for the current setting (see `captureFailureAnswer`).
        disableWindow(conversation, "capture");
        return captureFailureAnswer(conversation, policy, `${captured.reason}: ${closedReason(captured.detail)}`);
      }
      // FAIL CLOSED. There is no baseline, so nothing this turn produces could
      // be reviewed, and a native row has no manual review to fall back to.
      // The prompt is blocked with the closed short detail and the one way out.
      return {
        action: "block",
        reason: [
          "review gate: automatic review could not capture the workspace baseline,",
          `so this turn cannot be reviewed (${captured.reason}: ${closedReason(captured.detail)}).`,
          "Turn the provider's automatic review Off in Review settings to continue unreviewed.",
        ].join(" "),
        userMessage: boundedUserMessage([CAPTURE_FAILED_NOTICE]),
      };
    }
    const baseline = existing ?? (captured?.status === "ok"
      ? { kind: "checkpoint" as const, descriptor: captured.value, cwd: deps.workspace, capturedAt }
      : undefined);
    if (!baseline) {
      return {
        action: "block",
        reason: "review gate: automatic review could not capture the workspace baseline, so this turn cannot be reviewed."
          + " Turn the provider's automatic review Off in Review settings to continue unreviewed.",
        userMessage: boundedUserMessage([CAPTURE_FAILED_NOTICE]),
      };
    }
    try {
      // Focused-test seam for this publish step only (see
      // `observeBaselinePublish`): awaited ONLY when a test installed it, because an
      // absent observer must not cost this step a yield — a yield here is a window
      // in which a cancellation can land between the check above and the publish.
      if (deps.observeBaselinePublish !== undefined) await deps.observeBaselinePublish();
      if (signal.aborted) {
        // #736 R-fix (review pass 2): the cancellation landed in that window. The
        // capture is released rather than attached — the provider already proceeded
        // without this baseline, so publishing it (or sampling the activity
        // watermark below, which this return skips) would claim coverage of writes
        // it never saw — and the window is marked so no later prompt certifies this
        // turn's work with a baseline of its own.
        if (captured?.status === "ok") await releaseUnpublishedCapture(conversation, captured.value);
        disableWindow(conversation, "aborted");
        return { action: "allow" };
      }
      setReviewWindowCheckpointBaseline(state, baseline);
      freezeReviewWindowConfig(state, config, reviewerScope());
      // From this moment the coordinator, not the capture call, owns it.
      trackOwners(conversation);
    } catch (error) {
      // The descriptor never became reachable from state: release it here
      // rather than leaving the capture it pinned orphaned.
      if (captured?.status === "ok" && state.reviewWindow?.baseline !== baseline
        && state.reviewWindow?.activeExchange?.baseline !== baseline) {
        // #736 R-fix: the rethrow still answers the provider, so a release that
        // failed here is carried to that answer instead of dropped: the record
        // has no owner left, and only the user can be told. The disclosure is
        // retained on the coordinator and travels with this request's failure
        // answer, or with the next one if this request cannot be told.
        await releaseUnpublishedCapture(conversation, captured.value);
      }
      throw error;
    }
    // U6: the watermark moves only for a window's FIRST baseline. A later prompt
    // of an already-armed window reuses that baseline and must NOT resample: the
    // activity it reports since the last recorded review is still unspent, and
    // resampling here would silently consume an aborted, timed-out, or
    // no-verdict review's only qualifying call — the retry Pi still grants at its
    // next settlement.
    if (existing === undefined) conversation.mark = activityCount(conversation.sessionId);
    if (captured?.status === "ok") conversation.captureFailureNoticed = false;
    return undefined;
  }

  /**
   * #736 U16: Pi's `/review-continue` for a hosted native row, which has no
   * slash commands. A cap deferral left `window.lastCappedFollowUp` set and
   * `correctionCycles` at the cap, so every later needs_changes was deferred
   * again and automatic correction never resumed. Here the user's NEXT prompt
   * into that same window IS the continuation: the capped feedback is marked
   * sent, the marker is cleared, and the budget is reset, so the arm that
   * follows runs a fresh correction cycle against a fresh exchange basis.
   *
   * Only a cap deferral ever sets `lastCappedFollowUp` — a repeated-no-progress
   * deferral does not — so only the capped correction resumes, exactly as in Pi.
   * The feedback text is never re-sent: the cap transmission already delivered
   * it, and this is a user-only notice on an allow, never a block.
   *
   * Returns the notice for the prompt's verdict, or undefined when the window
   * holds no capped feedback and this prompt changes nothing.
   */
  function continueCappedCorrection(
    conversation: Conversation,
    config: ReviewGateConfig,
  ): string | undefined {
    const window = conversation.state.reviewWindow;
    if (!window?.lastCappedFollowUp) return undefined;
    // The window's OWN frozen budget, so the reset is the budget the reviews of
    // this window were measured against, not whatever settings say now.
    const maxCorrectionCycles = (window.reviewConfig ?? config).maxCorrectionCycles;
    markCappedFeedbackSent(conversation.state);
    window.lastCappedFollowUp = undefined;
    window.correctionCycles = 0;
    // The cap transmission already armed this window's response exchange, and
    // it armed it as a DEFERRED response — which is what lets a later turn with
    // no net workspace change settle quietly instead of proving the resumed
    // correction. The prompt arm below returns early for an exchange that
    // already has a baseline, so the mode is refreshed HERE: re-arming against
    // the exchange's own retained baseline re-reads the feedback the line above
    // just marked sent, and the exchange becomes a correction response.
    const retained = window.activeExchange?.baseline ?? window.baseline;
    if (retained !== undefined) armReviewResponseExchange(conversation.state, retained);
    return `review gate: continuing review; correction budget reset to ${maxCorrectionCycles}`;
  }

  /**
   * The row's `agent_settled`: gate, run one review, and map its output to the
   * verdict the provider acts on. Branches, dispositions, actions and notices
   * mirror the Pi settlement path; the verdict shape is this lane's own.
   */
  async function settleConversation(
    conversation: Conversation,
    request: NativeReviewRequest,
    config: ReviewGateConfig,
    signal: AbortSignal,
    // #736 U8: the per-request holder `handleRequest` also reads when its own
    // deadline answers, so a `Stop` that reconciled and then stalled still tells
    // the user. Written here, read there; never awaited, so no reply is delayed.
    reconcile: { notice?: string },
  ): Promise<NativeReviewVerdict> {
    const state = conversation.state;
    const window = state.reviewWindow;
    // The provider's own final answer is this row's assistant summary: recorded
    // into the window's evidence exactly where Pi records it at agent_end — at
    // the top of settlement, before any gate or early return — so the reviewer
    // sees the same statement of what the turn claims it did even when this
    // `Stop` runs no reviewer: a turn deferred by running background work, one
    // blocked because that state could not be verified, or one turned away
    // because no reviewer is available still leaves its claim in the window for
    // the review a later turn earns. Once per `Stop`, before any branch below
    // can return.
    if (window && request.lastAssistantMessage !== undefined) {
      rememberFinalAssistantSummaryText(window.evidence, request.lastAssistantMessage);
    }
    // Nothing was armed for this conversation: the provider may continue.
    if (!window?.baseline) {
      // A window that exists but never got a baseline — configured Tools only,
      // an eligible snapshot failure, or a prompt arm the hang-up or the
      // request's deadline ended first — can never be reviewed, so it closes
      // quietly here exactly as Pi's settlement closes a window with no baseline.
      // Leaving it open would let a later prompt pile into it: that prompt's own
      // request would arrive behind the stale first one the reviewer was told to
      // check, and the window's review-disabled mark would keep it unarmed. The
      // next prompt opens a fresh window and arms it normally.
      if (window) await retireWindow(conversation);
      return { action: "allow" };
    }

    // #736 U8: native has no settings-save event, but every request reads fresh
    // settings, so an open window picks up a Review-settings reviewer change at
    // its next `Stop` instead of staying frozen on a selection the user has since
    // fixed. Pi's own reconcile is reused verbatim: it replaces the window's
    // frozen config OBJECT without mutating it, so the evidence-affecting frozen
    // settings (snapshot and patch limits, timeouts), every captured baseline,
    // evidence event, and completed history entry survive, and a review that
    // already started under the previous object keeps its own reviewers. The
    // reconciled object is what the no-reviewer check and the run below use.
    // This runs BEFORE the background gate on purpose: a `Stop` deferred by
    // running background work, or blocked because that state could not be
    // verified, still notifies the user, so it reports the settings it just picked
    // up too — and still launches no reviewer, which the gate below keeps.
    // The digest pair decides only whether the user is told, because Pi calls
    // this from a settings-save event and this lane calls it at every `Stop`: a
    // `Stop` whose selection is unchanged stays silent. Compare frozen configs
    // because the live config has not had the reviewer scope applied.
    const frozenSelectionDigest = window.reviewConfig === undefined
      ? undefined
      : reviewerSelectionDigest(window.reviewConfig);
    reconcileWindowReviewerSelection(window, config, reviewerScope());
    const reconcileNotice = window.reviewConfig !== undefined
      && reviewerSelectionDigest(window.reviewConfig) !== frozenSelectionDigest
      ? reconcileNoticeText(resolveReviewers(config, reviewerScope()).reviewers.length)
      : undefined;
    // Reachable from this request's deadline reply, which may answer while this
    // settlement is still held by a stage an abort cannot interrupt.
    if (reconcileNotice !== undefined) {
      reconcile.notice = reconcileNotice;
      // #736 R-fix: the window's selection is swapped NOW, so no later `Stop`
      // computes this notice again. If this verdict cannot carry it — the
      // quieter rule that keeps a quiet allow quiet — it stays pending on the
      // window, and the next `Stop` that notifies or reviews says it once.
      conversation.pendingReconcileNotice = { window, notice: reconcileNotice };
    }

    // #736 U21: this lane's qualifying-activity fact, from the tool calls the
    // row reported itself. A review is earned by a reported non-read-only call
    // since the last recorded review; a workspace change alone (runtime, an
    // external writer, or a background task) never starts one, which is Pi's
    // #461 rule. Zero reported activity is not qualifying either — the mark
    // starts at zero — so a conversation that never reported a call is never
    // reviewed, whatever its workspace looks like.
    //
    // #736 U3: the fact never short-circuits the settlement. Like Pi, this lane
    // always reaches `runReview` with `requireNewToolActivity` and hands it the
    // fact, so the no-review outcome completes the exchange and decides the
    // window's fate instead of an early return leaving both open.
    const qualifying = activityCount(conversation.sessionId) > conversation.mark;
    if (qualifying) {
      // Background gate: reviewing a workspace this row is still changing would
      // certify a state that is not finished. The census is INJECTED and need
      // not honor the broker's signal, so it is raced rather than awaited: a
      // host that never answers must not hold this conversation's serialized
      // chain — later requests would queue behind it and dispose would wait
      // forever on a checkpoint it owns.
      if (signal.aborted) return { action: "allow" };
      let cancelBackground!: () => void;
      const cancelled = new Promise<undefined>((resolve) => {
        cancelBackground = () => resolve(undefined);
      });
      signal.addEventListener("abort", cancelBackground, { once: true });
      // Detached so a census that rejects AFTER the race settled is never an
      // unhandled rejection in the host process.
      const census = Promise.resolve().then(() => deps.backgroundState(request));
      census.catch(() => undefined);
      let background: NativeReviewBackgroundState | undefined;
      try {
        background = await Promise.race([census, cancelled]);
      } catch (error) {
        background = { state: "unknown", detail: closedReason(error) };
      } finally {
        signal.removeEventListener("abort", cancelBackground);
      }
      // A census that never answered is not a verified idle state, and nothing
      // this turn produced has been reviewed: allow, and review no workspace.
      if (signal.aborted || background === undefined) return { action: "allow" };
      if (background.state === "unknown") {
        return {
          action: "allow",
          userMessage: boundedUserMessage([`review gate: automatic review blocked because background state could not be verified: ${noticeText(background.detail)}`]),
        };
      }
      if (background.state === "running") {
        return {
          action: "allow",
          userMessage: boundedUserMessage([`review gate: automatic review deferred while ${background.count} background task(s) remain active`]),
        };
      }
    }

    // The window's frozen selection, now reconciled above, and frozen here on
    // the first `Stop` of a window that somehow reaches settlement unfrozen.
    const reviewConfig = window.reviewConfig ?? freezeReviewWindowConfig(state, config, reviewerScope());

    // K1: the no-reviewer notice belongs to a turn that was going to review. A
    // non-qualifying turn runs no reviewer either way and settles into one of
    // runReview's no-review outcomes, so it is never told a reviewer is
    // missing. The configuration is still resolved because the run below needs
    // it; every no-review outcome returns before a reviewer is resolved or
    // launched, so an unresolvable selection cannot turn a quiet turn into a
    // reviewer failure.
    if (qualifying && !reviewConfig.enabled) {
      // Enabled gate with no resolvable reviewer: keep the window, its
      // baseline, and its evidence open so a later turn can still be reviewed.
      return { action: "allow", userMessage: boundedUserMessage([NO_REVIEWER_NOTICE]) };
    }

    // runReview forwards evidence-method warnings through `notify`; for a
    // native row the verdict's userMessage is the only user channel.
    const notices: string[] = [];
    // #736 U14: a native row records NO tool evidence (tool-event parity is
    // #772), so runReview's snapshot-failure fallback would review an empty
    // Tools-only record, end as `no_initial_changes`, and retire this window
    // with its baseline released — while Pi's warning claimed "current tool
    // evidence is kept". The turn's change would go unreviewed behind a false
    // line. So the fallback is turned OFF for THIS call only, derived from the
    // shared Primary policy (which stays as Pi defines it): an eligible capture
    // failure surfaces as runReview's own capture-failure error and is handled
    // in the catch below exactly as an arm-time failure is — warn per the
    // setting, keep the window pending, and retry the comparison at the next
    // `Stop`.
    const evidencePolicy = primaryEvidencePolicy(config);
    const settlementEvidencePolicy: ReviewEvidencePolicy = { ...evidencePolicy, snapshotFailureFallback: false };
    // Snapshot the ledger before settlement: `runReview` retires the active
    // exchange as it completes, and the reviewed after-baseline that exchange
    // carried is exactly the owned descriptor that would otherwise vanish from
    // state's reach mid-settlement and leak.
    trackOwners(conversation);
    // Sampled BEFORE the reviewer runs, because the checkpoint it reviews is
    // captured at invocation: a write reported while the reviewer is running is
    // not in that checkpoint and must still earn the next Stop a review. The
    // sample is committed only once a transmission is proven deliverable;
    // advancing it earlier would let an abort that lands during rendering
    // consume the only qualifying activity, exactly the failure a cancellation
    // must not cause.
    const settledActivity = activityCount(conversation.sessionId);
    try {
      state.reviewInProgress = true;
      let output: ReviewRunOutput;
      // #736 U14: whether THIS run acquired a real after-checkpoint, recorded
      // locally and applied in the `finally` below. The reset belongs to a
      // successful CAPTURE, not to a completed review: a run that compared the
      // workspace and then lost its reviewer to the deadline or an abort still
      // proved the snapshot works again, and a later eligible failure must not
      // be silenced by a warning this conversation already spent. It is a local
      // fact rather than a direct write because the checkpoint settlement can be
      // detached: a capture that finishes after this request was cancelled must
      // not reach back and change conversation state. Nothing else moves — no
      // verdict, no activity mark, no published baseline.
      let capturedCheckpoint = false;
      try {
        output = await runReview({
          // No session latch here either (see `armConversation`).
          evidencePolicy: settlementEvidencePolicy,
          cwd: deps.workspace,
          checkpointScope: conversation.scope,
          request: `${NATIVE_TOOL_EVIDENCE_NOTE}\n\n${buildRequestContext(state, window, { priorFeedback: "latest" })}`,
          before: window.baseline,
          config: reviewConfig,
          evidence: window.evidence,
          correctionAttemptCount: getCorrectionAttemptCount(window),
          window,
          signal,
          ...(deps.admittedPiCommand === undefined ? {} : { admittedPiCommand: deps.admittedPiCommand }),
          ...(deps.observeBaselineVerification === undefined
            ? {}
            : { onBaselineVerification: deps.observeBaselineVerification }),
          // `runReview` reaches this only once the after-checkpoint is captured,
          // before comparing it; a capture that landed after the abort proves
          // nothing (see above), and the injected observer still runs unchanged.
          onCheckpointComparison: () => {
            if (!signal.aborted) capturedCheckpoint = true;
            return deps.observeCheckpointComparison?.();
          },
          // This lane is the caller that can afford an interrupted checkpoint
          // settlement: the race releases the conversation's queue, and the late
          // settlement's after-checkpoint is released rather than published. The
          // cleanup is tracked here so dispose still waits for it — nothing this
          // row captured can outlive the coordinator.
          onDetachedCheckpointSettlement(cleanup: Promise<void>): void {
            pendingReleases.add(cleanup);
            const forget = (): void => { pendingReleases.delete(cleanup); };
            void cleanup.then(forget, forget);
          },
          // #736: the Pi activity gate is ON here too, but a native row records
          // no tool evidence, so the qualifying-call fact it decides from is the
          // one sampled above rather than the window's evidence events.
          requireNewToolActivity: true,
          qualifyingToolActivity: qualifying,
          // #736 U15: `runReview`'s review-START progress line is dropped here
          // (see `REVIEW_START_PROGRESS_PREFIXES`); everything else it notifies —
          // the evidence-method warnings — still travels with the verdict, which
          // is this row's only user channel.
          notify: (message) => {
            if (isReviewStartProgress(message)) return;
            if (notices.length < 4) notices.push(message);
          },
        });
      } catch (error) {
        if (signal.aborted) {
          // The row hung up (or dispose ran): nothing can be delivered, so the
          // baseline and window survive for the next Stop to re-review.
          return { action: "allow" };
        }
        if (error instanceof ReviewEvidenceCaptureFailure) {
          // #736 U14: the settlement could not compare the workspace, and the
          // Tools-only fallback is off for this lane (see above). Like the
          // arm-time failure it mirrors, the turn continues unreviewed: the
          // window, its baseline and its exchange stay open, the activity
          // watermark stays put (so the next `Stop` retries the comparison even
          // with no new tool call, per U6/A4), and the disclosure follows the
          // CURRENT fallback setting through the same notice rules.
          return captureFailureAnswer(conversation, evidencePolicy, closedReason(error));
        }
        return {
          action: "allow",
          userMessage: boundedUserMessage([
            `review gate: automatic review failed (${closedReason(error)}); this turn was not reviewed`,
            ...notices,
          ]),
        };
      } finally {
        if (capturedCheckpoint) conversation.captureFailureNoticed = false;
        state.reviewInProgress = false;
      }

      // Focused-test seam only (see `reviewOutputForTests`); production omits it
      // and maps the run the reviewer actually produced.
      if (deps.reviewOutputForTests !== undefined) output = deps.reviewOutputForTests(output);

      // Cancellation first, and it does NOT consume this turn's activity: the
      // same unreviewed change has to earn a review on the next Stop, so the
      // watermark stays where it was and the baseline survives.
      if (signal.aborted || output.result?.error === "aborted") {
        // An after-checkpoint this run handed off was never recorded as
        // reviewed; nothing else can reach it, so it is released, not kept.
        if (window.activeExchange?.baseline !== output.reviewedBaseline) await output.releaseReviewedBaseline?.();
        return { action: "allow" };
      }

      // Also recognize successful snapshot evidence from a non-checkpoint basis,
      // which reports no checkpoint comparison to observe.
      if (output.evidenceMethod === "snapshot") conversation.captureFailureNoticed = false;

      /**
       * Render, make deliverable, and only then record one transmission. The
       * inline limit and the control-character rule are enforced on the
       * reviewer's own text BEFORE its feedback counts as delivered: arming a
       * response exchange for a correction the provider could not carry would
       * make the next turn look like an answered correction that never happened.
       */
      const transmit = async (
        disposition: "sent_for_correction" | "sent_for_observation" | "sent_at_cap" | "sent_review_error",
        action: ReviewTransmissionAction,
      ): Promise<string | undefined> => {
        let rendered: string;
        try {
          rendered = await renderReviewTransmissionMessage({ output, action });
          // Retire the previous exchange's detached checkpoint HERE, before the
          // last cancellation check: this releases files, so it is the other
          // place a cancel can land. Nothing is committed after a check that
          // passed.
          await retireUnreachableOwners(conversation);
        } catch (error) {
          // Nothing was recorded, so the after descriptor this run handed off
          // is still ours; once state reaches it, retain instead of deleting.
          if (window.activeExchange?.baseline !== output.reviewedBaseline) await output.releaseReviewedBaseline?.();
          throw error;
        }
        if (signal.aborted) {
          if (window.activeExchange?.baseline !== output.reviewedBaseline) await output.releaseReviewedBaseline?.();
          return undefined;
        }
        const reason = nativeBlockReason(rendered, output, action);
        recordReviewTransmissionPass({ state, output, source: "automatic", disposition });
        // A newer delivered review supersedes the old cap. Only the cap
        // branch below installs a new continuation marker.
        window.lastCappedFollowUp = undefined;
        // U6: this is the ONLY place the watermark advances — a verdict is now
        // recorded in `window.reviewHistory`, so this turn's activity is spent.
        // Every path that records no verdict leaves `mark` where it is.
        conversation.mark = settledActivity;
        // The exchange now owns the reviewed after-baseline; ledger it now so a
        // later settlement can retire it.
        trackOwners(conversation);
        return reason;
      };

      // Nothing to review (unchanged response turn, no initial change). The
      // evidence-method warnings runReview just collected must still reach the
      // user — losing review coverage is exactly what they disclose — and a
      // completed window must not survive its own review: a later prompt in a
      // window that still carried the old baseline, request history, frozen
      // configuration, and correction count could re-review an already-passed
      // delta or answer a request nobody made. Deferred or otherwise unresolved
      // windows are the exception, and stay open, as do the two #736 outcomes
      // below that disclose work nobody has reviewed.
      if (!output.changed) {
        // The no-review outcomes map as Pi maps them: `no_new_tool_activity`
        // and a deferred response keep the window, its baseline and its
        // evidence open for a later qualifying turn, while `no_initial_changes`
        // and a pass's `no_new_reviewable_activity` complete the review and
        // close it, so a later prompt never inherits an accepted baseline, the
        // spent request history, or a spent correction budget — with the one
        // exception Pi applies and this now matches: a response exchange that
        // carries a delta or fresh reviewable observations stays open.
        // Qualifying activity reported after the reviewed checkpoint was frozen
        // is work nobody has reviewed, so that window survives too.
        //
        // Both notices are read from the window BEFORE any retire: closing the
        // window is what clears the exchange whose delta decides them, and both
        // travel as a `userMessage` on an allow — a native `userMessage` is the
        // user's channel alone, and neither outcome is ever a `block` reason
        // that would put a user notice in front of the model.
        const unresolvedFeedback = output.noReviewReason === "no_new_tool_activity" && hasUnresolvedReview(window);
        const pass = output.noReviewReason === "no_new_reviewable_activity" ? window.reviewHistory.at(-1) : undefined;
        const passExchange = output.noReviewReason === "no_new_reviewable_activity" ? window.exchanges.at(-1) : undefined;
        // The exchange delta is the post-pass comparison, never the window's
        // cumulative workspace diff: an unchanged confirmation is not itself a
        // new safety problem, so it stays quiet.
        const unattributedChanges = pass !== undefined
          && passExchange !== undefined
          && (passExchange.workspaceChanges.length > 0 || passExchange.sideEffectChanges.length > 0);
        // Pi closes a pass's window only when its response exchange is
        // genuinely unchanged; drift or fresh incomplete observations keep it
        // open, so work nobody has reviewed is never closed over. Native retired
        // the window on every `no_new_reviewable_activity`, so this matches Pi.
        const passExchangeIsUnchanged = passExchange !== undefined
          && passExchange.workspaceChanges.length === 0
          && passExchange.sideEffectChanges.length === 0
          && !passExchange.evidenceEvents.some(isReviewableToolObservation);
        const newerActivity = activityTracked && activityCount(conversation.sessionId) > settledActivity;
        const unresolved = output.noReviewReason === "unchanged_deferred_response"
          || output.noReviewReason === "no_new_tool_activity"
          || newerActivity
          || hasUnresolvedReview(window);
        const keepWindow = unresolved
          || (output.noReviewReason === "no_new_reviewable_activity" && !passExchangeIsUnchanged);
        if (!keepWindow) await retireWindow(conversation);
        // Retiring a window releases files and yields, so this path re-checks
        // cancellation before it commits anything either.
        if (signal.aborted) return { action: "allow" };
        // U6: no verdict was recorded here — a no-review outcome is not a review —
        // so the watermark stays where it is, as in Pi, where the activity gate
        // still measures from the window's last recorded review. The activity
        // this turn reported therefore still earns a later `Stop` a review, and
        // a window that closed above is re-watermarked by its successor's first
        // baseline.
        const warned = boundedUserMessage([
          ...(unresolvedFeedback ? [NATIVE_UNRESOLVED_FEEDBACK_NOTICE] : []),
          ...(pass !== undefined && unattributedChanges ? [unattributedChangesNotice(pass.sequence)] : []),
          ...notices,
        ]);
        return warned === undefined ? { action: "allow" } : { action: "allow", userMessage: warned };
      }

      const notice = (base: string): string | undefined => boundedUserMessage([base, ...notices]);
      /** A transmission that could not be delivered re-arms nothing; continue. */
      const hungUp = (): NativeReviewVerdict => ({ action: "allow" });

      if (output.result?.verdict === "pass") {
        const transmission = await transmit("sent_for_observation", "passed");
        if (transmission === undefined) return hungUp();
        return {
          action: "block",
          reason: transmission,
          userMessage: notice(`review gate: ${output.result.error === "partial_reviewer_error" ? "passed with reviewer warnings" : "passed"} (${formatTokenUsage(output.result.usage)})${output.evidenceMethod && output.evidenceMethod !== "snapshot" ? ` — ${evidenceMethodNotice(output.evidenceMethod)}` : ""}`),
        };
      }

      if (output.result?.verdict === "needs_changes") {
        if (isRepeatedNoProgressFeedback({
          previous: window.lastCorrectionFeedback,
          result: output.result,
          changes: output.changes,
          // Native has no evidence events to count, so the reported-tool-activity
          // count stands in for Pi's `window.evidence.events.length`: a correction
          // turn that ran tools made progress, whatever its fingerprint looks like.
          evidenceEventCount: allActivityCount(conversation.sessionId),
        })) {
          const transmission = await transmit("sent_at_cap", "deferred");
          if (transmission === undefined) return hungUp();
          return {
            action: "block",
            reason: transmission,
            userMessage: notice([
              `review gate: repeated changes requested with no new correction evidence (${formatTokenUsage(output.result.usage)})`,
              "Reviewer feedback matched the previous blocking feedback, and the correction turn produced no new tool evidence or file-change fingerprint.",
              "Stopping automatic correction to avoid a loop.",
              NATIVE_CONTINUATION_GUIDANCE,
            ].join("\n")),
          };
        }

        // Built before the transmission, committed only after one: a marker or
        // a cycle count recorded for feedback the model never received would
        // make the next turn answer a correction that never happened, or reach
        // the cap without any correction having been delivered.
        const correctionMarker = createCorrectionFeedbackMarker({
          result: output.result,
          changes: output.changes,
          // The same stand-in count, read live here as Pi reads its event list
          // live, so the next turn's activity is what raises the bar.
          evidenceEventCount: allActivityCount(conversation.sessionId),
        });
        if (window.correctionCycles >= reviewConfig.maxCorrectionCycles) {
          const transmission = await transmit("sent_at_cap", "deferred");
          if (transmission === undefined) return hungUp();
          window.lastCorrectionFeedback = correctionMarker;
          window.lastCappedFollowUp = buildReviewAuthorizationMessage({
            reviewSequence: output.reviewSequence!,
            bundleDir: output.bundleDir!,
          });
          return {
            action: "block",
            reason: transmission,
            userMessage: notice([
              `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`,
              "Complete reviewer feedback was transmitted to the implementing model, but automatic correction is deferred.",
              NATIVE_CAP_CONTINUATION_GUIDANCE,
            ].join("\n")),
          };
        }
        const transmission = await transmit("sent_for_correction", "correction_required");
        if (transmission === undefined) return hungUp();
        window.lastCorrectionFeedback = correctionMarker;
        window.correctionCycles += 1;
        return {
          action: "block",
          reason: transmission,
          userMessage: notice(`review gate: changes requested (${formatTokenUsage(output.result.usage)})`),
        };
      }

      const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
      if (output.result) {
        const transmission = await transmit("sent_review_error", "review_error");
        if (transmission === undefined) return hungUp();
        return { action: "block", reason: transmission, userMessage: notice(failed) };
      }
      // No verdict at all: nothing was transmitted, so the provider may
      // continue — with whatever review-coverage warning was collected.
      return { action: "allow", userMessage: notice(failed) };
    } finally {
      // No exit — success, no-change, cancellation, reviewer failure, or a
      // throw — may leave a descriptor this settlement made unreachable behind.
      trackOwners(conversation);
      await retireUnreachableOwners(conversation);
    }
  }

  /**
   * Retire a different conversation's window when this request belongs to a
   * new conversation. Decided BEFORE the incoming id's own checkpoint-path
   * safety is considered: a wire-valid id that cannot be a directory name still
   * ends the previous conversation, and returning early first would leave that
   * window open holding an unreviewed baseline that pins the workspace with no
   * conversation left to ever review it.
   */
  function retirePreviousConversation(sessionId: string): void {
    if (currentSessionId === undefined || currentSessionId === sessionId) return;
    const previous = conversations.get(currentSessionId);
    if (previous) supersedeConversation(previous);
    currentSessionId = undefined;
  }

  /**
   * #736 R-fix: the reconcile notice this conversation's window still owes the
   * user, if it owes one — composed by an earlier `Stop` whose verdict had no
   * user notice to travel with. Tied to the window that produced it, so a window
   * that closed or was replaced never delivers a notice about a selection nobody
   * is reviewing. Read without clearing: only an actual delivery clears it.
   */
  function pendingReconcileNotice(conversation: Conversation | undefined): string | undefined {
    if (conversation === undefined) return undefined;
    const pending = conversation.pendingReconcileNotice;
    if (pending === undefined) return undefined;
    if (conversation.state.reviewWindow !== pending.window) {
      conversation.pendingReconcileNotice = undefined;
      return undefined;
    }
    return pending.notice;
  }

  /**
   * Attach a pending disclosure and this request's reconciliation notice to a
   * verdict that can actually deliver it. A request that is already cancelled
   * can never show a notice, so it must not consume the one-time disclosure it
   * would have carried, and a silent cancellation never gains one.
   *
   * #736 U8: the reconcile notice is composed HERE, at the one delivery point,
   * rather than in the individual settlement branches: a branch's own message may
   * already fill the transport's byte bound, and a failure raised after the
   * settlement (a transmission that could not be created) answers from outside
   * it entirely — both would otherwise lose the notice for a window that really
   * did change. The notice is fixed text, so its budget is reserved first and the
   * existing message is shortened only when it has to; the substantive headline
   * stays first. A verdict with no message of its own never carries the notice
   * alone, which is what keeps a quiet allow quiet.
   *
   * #736 R-fix: the notice is read here rather than only from this request's own
   * settlement, because a `Stop` that reconciled its window and then answered a
   * quiet allow could not say it and never gets a second chance — the window's
   * frozen selection is already swapped, so no later `Stop` computes the notice
   * again. Such a notice stays pending on the window (see
   * `Conversation.pendingReconcileNotice`) until a verdict that already carries a
   * user notice, or that runs a review and so always carries one, delivers it.
   * Nothing is consumed by a delivery that could not happen: a cancelled request
   * returns above, and a quiet allow returns below.
   *
   * #736 R-fix (review pass 1): a cleanup that failed is owed the same way, and
   * any request of any conversation may be the one that finally says it — the
   * request that hit the failure may have been answered by its own deadline, or
   * disconnected, or the release may have run in a detached cleanup after its own
   * conversation was superseded. Unlike the reconcile notice, this one is said even
   * on an otherwise quiet allow: a checkpoint record with no owner left is a fact
   * the user has to hear once.
   *
   * #736 R-fix (review pass 2): both owed lines are composed BEFORE the ordinary
   * message is shortened, and their bytes are reserved out of the transport's
   * bound first, so neither can be trimmed out of the very reply that spent it.
   */
  function deliverable(
    signal: AbortSignal,
    verdict: NativeReviewVerdict,
    reconcileNotice?: string,
    // The conversation this request belongs to, when it reached one. Only a `Stop`
    // can owe the user a reconcile notice, because it describes a reviewer
    // selection a settlement swapped in. A failed cleanup is owed by the lane
    // instead — the cleanup can outlive the conversation whose capture it was — so
    // that one is read from coordinator scope.
    owner?: { readonly conversation: Conversation; readonly settles: boolean },
  ): NativeReviewVerdict {
    if (disposed || signal.aborted) return verdict;
    const notice = reconcileNotice ?? (owner?.settles ? pendingReconcileNotice(owner.conversation) : undefined);
    const disclosure = pendingDisclosure;
    const orphan = pendingOrphanReleaseNotice;
    if (disclosure === undefined && orphan === undefined && (verdict.userMessage === undefined || notice === undefined)) return verdict;
    pendingDisclosure = undefined;
    const message = boundedUserMessage([disclosure, verdict.userMessage]);
    // A verdict with no message of its own never carries the reconcile notice
    // alone; a cleanup line makes the answer non-quiet, so both may travel.
    const carried = message === undefined && orphan === undefined ? undefined : notice;
    const suffix = boundedUserMessage([orphan, carried]);
    const room = MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES
      - (suffix === undefined ? 0 : Buffer.byteLength(suffix, "utf8") + 1);
    const head = message === undefined || suffix === undefined ? undefined : boundedText(message, Math.max(0, room));
    const userMessage = head === undefined
      ? message ?? suffix
      : head.length === 0
        ? suffix
        : `${head}\n${suffix}`;
    // Spent only when it really travelled.
    if (orphan !== undefined && userMessage?.includes(orphan) === true) pendingOrphanReleaseNotice = undefined;
    if (carried !== undefined
      && userMessage?.includes(carried) === true
      && owner?.conversation.pendingReconcileNotice?.notice === carried) {
      owner.conversation.pendingReconcileNotice = undefined;
    }
    return { ...verdict, userMessage };
  }

  /**
   * Hand one already-routed request to its conversation's serialized chain.
   */
  function handleRequest(
    conversation: Conversation,
    request: NativeReviewRequest,
    signal: AbortSignal,
  ): Promise<NativeReviewVerdict> {
    // The broker's signal ends when the row hangs up; dispose aborts the
    // derived controller instead. The reason object is carried through so a
    // cancellation stays PROVEN to runReview rather than merely observed.
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", relayAbort, { once: true });
    inFlight.add(controller);
    conversation.controllers.add(controller);

    // The overall deadline. It starts when the request is ACCEPTED, queued
    // behind its conversation's chain included, because what has to stay bounded
    // is how long one held provider hook can be held at all — not merely how
    // long its own reviewer runs. When it fires, the request is cancelled through
    // the SAME path a hang-up takes: runReview's signal aborts, the window keeps
    // its baseline, and this turn's qualifying activity is NOT spent, so the next
    // `Stop` re-reviews the very same change.
    const deadlineMs = deps.deadlineMs ?? NATIVE_REVIEW_DEADLINE_MS;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let answerDeadline: ((verdict: NativeReviewVerdict) => void) | undefined;
    /**
     * #736 U8: the reconcile notice this request's settlement computed, if it got
     * that far. A `Stop` that reconciled its window and then stalled past this
     * host's deadline is answered here rather than by that settlement, and the
     * window HAS changed — without this the change would go unreported forever,
     * because the next `Stop` sees an already-reconciled selection. Read, never
     * awaited: the reply is never delayed, and a settlement that computed nothing
     * (including one cancelled before it reached the reconcile) leaves it out.
     */
    const reconciled: { notice?: string } = {};
    /**
     * #736 R-fix: what this request may still owe the user on its conversation's
     * behalf — a reconcile notice an earlier quiet `Stop` of this same window
     * composed and could not deliver (which only a `Stop` carries, because it
     * describes a reviewer selection a settlement swapped in), and a checkpoint
     * cleanup this conversation could not report, which any request may carry.
     */
    const owner = { conversation, settles: request.event === "Stop" };
    /**
     * The timed-out turn's reply, on its OWN promise, separate from the
     * settlement (#736 review pass 1). An abort cannot interrupt a stage that is
     * awaiting the filesystem rather than a process — provider launch discovery
     * is one — so a stalled stage can keep the settlement open past the deadline,
     * and the provider holding this connection must not be kept waiting with it.
     */
    const deadlineAnswer: Promise<NativeReviewVerdict> | undefined = deadlineMs > 0
      ? new Promise<NativeReviewVerdict>((resolve) => {
        answerDeadline = resolve;
      })
      : undefined;
    if (deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined;
        controller.abort(new Error("review gate: automatic review exceeded its time limit"));
        // The provider is still holding this connection open for exactly one
        // answer, and the deadline is this host's own promise that it gets one —
        // delivered now, whether or not the cancelled work ever finishes.
        answerDeadline?.(deliverable(signal, {
          action: "allow",
          userMessage: boundedUserMessage([request.event === "UserPromptSubmit" ? PROMPT_DEADLINE_NOTICE : DEADLINE_NOTICE]),
        }, reconciled.notice, owner));
      }, deadlineMs);
      // Never a reason for the host process to stay alive, and never a handle
      // this coordinator leaks past its own request.
      deadlineTimer.unref?.();
    }
    const clearDeadline = (): void => {
      const timer = deadlineTimer;
      if (timer === undefined) return;
      clearTimeout(timer);
      deadlineTimer = undefined;
    };

    /**
     * #736 U19: set by the unreadable-settings branch when THIS request could not
     * read the lane's settings. The warning is deliberately NOT chosen or recorded
     * there: that branch and `finish` are separate promise reactions, so a
     * cancellation can land between them, and a verdict `finish` discards must
     * spend nothing. Both the decision and the record therefore belong to
     * `finish`, after its own cancellation check.
     */
    let configUnreadable = false;
    const finish = (verdict: NativeReviewVerdict): NativeReviewVerdict => {
      // A verdict nobody can see consumed nothing: the disclosure that a
      // previous conversation's window was closed unreviewed stays pending for
      // the next request that can actually carry it. A superseded conversation
      // is always cancelled above, so its late verdict is suppressed here rather
      // than reaching a provider that stopped asking for it. A deadline-cancelled
      // request was already answered above, on `deadlineAnswer`, from the host's
      // own notice — and a late settlement may never commit anything: every
      // committing step below re-checks the aborted signal first.
      if (controller.signal.aborted) return { action: "allow" as const };
      // #736 U19: the unreadable-settings warning describes the SETTINGS DOCUMENT,
      // not this turn, so it is warned once per conversation while that stretch
      // lasts, and it is recorded at THIS point — the first one at which it is
      // known that whoever asked can actually be told. The action is the same
      // either way: an unreadable configuration never blocks.
      if (configUnreadable && !configUnreadableWarned.has(conversation.sessionId)) {
        markConfigUnreadableWarned(conversation.sessionId);
        return deliverable(controller.signal, {
          action: "allow",
          userMessage: boundedUserMessage([UNREADABLE_CONFIG_NOTICE]),
        }, reconciled.notice, owner);
      }
      return deliverable(controller.signal, verdict, reconciled.notice, owner);
    };

    const run = conversation.chain
      .catch(() => undefined)
      .then(async (): Promise<NativeReviewVerdict> => {
        if (disposed || conversation.closed) return { action: "allow" };
        if (controller.signal.aborted) {
          // This request's own deadline (or a hang-up) was answered from
          // `deadlineAnswer` or by the broker, and the provider already moved on.
          // The slot still records the turn, in request order: a prompt that never
          // armed marks its window so no later prompt certifies this turn's work,
          // and a Stop closes a window that had no baseline to review — otherwise
          // the next prompt joins that dead window and runs unreviewed even though
          // this turn already sent its Stop. An armed window is left alone, so a
          // later settlement can still retry its review. Neither changes the reply
          // the deadline already sent.
          if (request.event === "UserPromptSubmit") {
            abandonUnarmedPrompt(conversation, request);
          } else {
            const window = conversation.state.reviewWindow;
            if (window && !window.baseline) await retireWindow(conversation);
          }
          return { action: "allow" };
        }
        let config: ReviewGateConfig | undefined;
        try {
          config = deps.readConfig();
        } catch {
          config = undefined;
        }
        if (config === undefined) {
          // An unreadable configuration never blocks a user's turn — and it never
          // carries a frozen window across the gap either. The window's baseline,
          // its frozen configuration, and the checkpoint pins behind them belong
          // to a settings document that no longer exists, and keeping them alive
          // would let a later Stop review work that happened while the row was
          // not configured at all. Retiring it releases those artifacts now; the
          // turn's change is still unreviewed, and the next armed prompt captures
          // a fresh baseline under whatever settings exist then.
          if (conversation.state.reviewWindow) await retireWindow(conversation);
          // #736 U19: this request found the lane's settings unreadable. Nothing is
          // warned or recorded here — `finish` owns that, after its cancellation
          // check — and the action is unchanged either way: an unreadable
          // configuration never blocks.
          configUnreadable = true;
          return { action: "allow" };
        }
        // Settings read successfully again, so this unreadable stretch is over for
        // EVERY conversation and the next failure earns the warning again
        // (#736 U19).
        configUnreadableWarned.clear();
        const primaryEnabled = primaryReviewEnabled(config);
        if (!primaryEnabled) {
          // Off is off: no reviewer, no notice, and no window left holding
          // checkpoint pins for a conversation nobody is reviewing. The
          // release is deliberately not memoized for this path: the toggle
          // can come back On, and the next window this conversation opens
          // owns artifacts that still have to be releasable.
          if (conversation.state.reviewWindow) await retireWindow(conversation);
          return { action: "allow" };
        }
        if (request.event === "UserPromptSubmit") {
          rememberUserRequest(conversation.state, request.prompt ?? "");
          // #736 U16: a prompt into a window whose correction was capped IS
          // this lane's `/review-continue` (see `continueCappedCorrection`).
          // Applied BEFORE the arm so the arm runs the resumed cycle; the arm's
          // own notice, when it has one, travels with the continuation notice.
          const continuation = continueCappedCorrection(conversation, config);
          const blocked = await armConversation(conversation, config, controller.signal);
          if (blocked === undefined) {
            return continuation === undefined
              ? { action: "allow" }
              : { action: "allow", userMessage: boundedUserMessage([continuation]) };
          }
          return continuation === undefined
            ? blocked
            : { ...blocked, userMessage: boundedUserMessage([continuation, blocked.userMessage]) };
        }
        return await settleConversation(conversation, request, config, controller.signal, reconciled);
      })
      .then(finish)
      .catch((error: unknown) => finish({
        // Never throw at the broker: an unreviewed turn is always the
        // provider's to continue.
        action: "allow",
        userMessage: boundedUserMessage([`review gate: automatic review failed (${closedReason(error)}); this turn was not reviewed`]),
      }));

    // The chain carries the settled verdict so a second request for this
    // conversation cannot observe half-applied window state, and so a
    // deadline-cancelled request's late work can never overlap the window a later
    // request is using. The CALLER is answered separately: `deadlineAnswer` wins
    // the race the moment the host's own deadline fires, which is what keeps a
    // stalled stage from holding the provider's hook past that deadline.
    conversation.chain = run;
    void run.then(() => {
      clearDeadline();
      signal.removeEventListener("abort", relayAbort);
      inFlight.delete(controller);
      conversation.controllers.delete(controller);
    }, () => {
      clearDeadline();
      signal.removeEventListener("abort", relayAbort);
      inFlight.delete(controller);
      conversation.controllers.delete(controller);
    });
    return deadlineAnswer === undefined ? run : Promise.race([run, deadlineAnswer]);
  }

  return {
    onReviewRequest(request, signal) {
      try {
        if (disposed) {
          // #736 U19: the host session ending is a fact about this coordinator,
          // so it is said once; every later request answers the same quiet allow.
          if (disposedNoticed) return Promise.resolve(deliverable(signal, { action: "allow" }));
          disposedNoticed = true;
          return Promise.resolve(deliverable(signal, { action: "allow", userMessage: boundedUserMessage([DISPOSED_NOTICE]) }));
        }
        retirePreviousConversation(request.sessionId);
        // A conversation id is a directory name here (raw checkpoint store), so
        // an unsafe one never captures and never opens a window at all.
        if (!isSafeCheckpointSessionId(request.sessionId)) {
          // #736 U19: an id that cannot be a checkpoint directory is not going to
          // become one, so this is said once per coordinator and every later
          // request of any id answers the same quiet allow.
          if (unsafeSessionNoticed) {
            return Promise.resolve(deliverable(signal, { action: "allow" }));
          }
          unsafeSessionNoticed = true;
          return Promise.resolve(deliverable(signal, { action: "allow", userMessage: boundedUserMessage([UNSAFE_SESSION_NOTICE]) }));
        }
        return handleRequest(route(request.sessionId), request, signal);
      } catch (error) {
        return Promise.resolve({
          action: "allow",
          userMessage: boundedUserMessage([`review gate: automatic review failed (${closedReason(error)}); this turn was not reviewed`]),
        });
      }
    },

    noteToolActivity(sessionId, activity) {
      activityTracked = true;
      if (disposed) return;
      allActivity.set(sessionId, (allActivity.get(sessionId) ?? 0) + 1);
      if (activity.readOnly) return;
      nonReadOnlyActivity.set(sessionId, (nonReadOnlyActivity.get(sessionId) ?? 0) + 1);
    },

    get activityTracked(): boolean {
      return activityTracked;
    },

    async dispose() {
      disposed = true;
      const shutdown = new Error("review gate: the host session ended");
      for (const controller of inFlight) controller.abort(shutdown);
      const owned = [...conversations.values()];
      for (const conversation of owned) conversation.closed = true;
      conversations.clear();
      // Every in-flight review settles on its own chain before its artifacts go.
      await Promise.all(owned.map((conversation) => conversation.chain.catch(() => undefined)));
      let unreviewedConversations = 0;
      for (const conversation of owned) {
        if (conversation.state.reviewWindow?.baseline) unreviewedConversations += 1;
        await releaseConversation(conversation);
      }
      // A superseded conversation's release may still be in flight; it owns
      // descriptors too, and nothing this module created is left behind.
      await Promise.all([...pendingReleases]);
      nonReadOnlyActivity.clear();
      allActivity.clear();
      return { unreviewedConversations };
    },
  };
}
