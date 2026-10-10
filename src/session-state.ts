import { createHash, randomUUID } from "node:crypto";
import { canonicalStableJson as stableJson } from "./canonical-json";
import { link, open, readFile, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  duplicateReviewerSelectionsFor,
  resolveReviewers,
  unresolvedReviewerSelectionsFor,
  type DeciderConfig,
  type ReviewGateConfig,
} from "./config";
import type { EvidenceCandidate, EvidenceState } from "./evidence";
import type { ReattachmentBundle } from "./execution/operation-record";
import { decodeGitCheckpointDescriptor, GIT_CHECKPOINT_DESCRIPTOR_FORMAT, isSafeWindowId } from "./git-checkpoint";
import type { GitCheckpointDescriptor } from "./git-checkpoint";
import {
  isSafeCheckpointSessionId, loadReviewCheckpoint, RAW_CHECKPOINT_DAMAGE_PREFIX, RAW_REVIEW_CHECKPOINT_FORMAT,
  type ReviewCheckpointDescriptor, type ReviewCheckpointScope,
} from "./review-checkpoint";
import type { ChangedFile, FileSnapshot, SnapshotOmission, WorkspaceSnapshot } from "./capture";
import type { ReviewBaseline, ReviewGateState, ReviewWindow } from "./state";
import type { ReviewerSession } from "./adapters/types";
import { piAgentDir } from "./config-path";

export const SESSION_STATE_ENTRY_TYPE = "pi-review-gate-session-state";
const SESSION_STATE_VERSION = 4;
const CHECKPOINT_REFERENCE_FORMAT = "pi-review-gate-review-checkpoint";
const CHECKPOINT_REFERENCE_VERSION = 1;
const SNAPSHOT_REFERENCE_FORMAT = "pi-review-gate-workspace-snapshot";
const SNAPSHOT_REFERENCE_VERSION = 1;
const GIT_CHECKPOINT_REFERENCE_FORMAT = "pi-review-gate-git-checkpoint";
const GIT_CHECKPOINT_REFERENCE_VERSION = 1;

/** Marker embedded in every quarantine sibling name; unique per quarantine. */
export const SESSION_STATE_QUARANTINE_MARKER = ".quarantine-";

/**
 * Aggregate pending-delivery metadata safe to disclose in notices: counts by
 * status and kind only. Never includes message text or delivery identifiers.
 */
export interface PendingDeliverySummary {
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
}

/**
 * Typed restore failure for an otherwise authentic same-conversation sidecar
 * whose persisted cwd does not match the resumed cwd. Carries only safe
 * metadata (stored/current cwd, revision, aggregate pending-delivery counts)
 * so callers can quarantine and report without exposing message content.
 */
export class SessionStateCwdMismatchError extends Error {
  readonly storedCwd: string;
  readonly currentCwd: string;
  readonly revision: number;
  readonly pendingDeliveries: PendingDeliverySummary;

  constructor(input: {
    storedCwd: string;
    currentCwd: string;
    revision: number;
    pendingDeliveries: PendingDeliverySummary;
  }) {
    super(`Persisted review-gate cwd ${input.storedCwd} does not match resumed cwd ${input.currentCwd}.`);
    this.name = "SessionStateCwdMismatchError";
    this.storedCwd = input.storedCwd;
    this.currentCwd = input.currentCwd;
    this.revision = input.revision;
    this.pendingDeliveries = input.pendingDeliveries;
  }
}

/**
 * Typed restore failure: the sidecar file is not valid JSON. The message names
 * the sidecar path but never quotes the file's content, so it is safe to
 * classify for notices (content is disclosed only via trusted categories).
 */
export class SessionStateParseError extends Error {
  constructor(path: string) {
    super(`Persisted review-gate session state is not valid JSON: ${path}`);
    this.name = "SessionStateParseError";
  }
}

/**
 * Typed restore failure: the sidecar parsed but is not a valid persisted
 * review-gate state document. Never quotes the document's content.
 */
export class SessionStateInvalidStateError extends Error {
  constructor(path: string) {
    super(`Invalid persisted review-gate session state: ${path}`);
    this.name = "SessionStateInvalidStateError";
  }
}

/** Typed restore failure: the sidecar failed its integrity check. */
export class SessionStateIntegrityError extends Error {
  constructor(path: string) {
    super(`Persisted review-gate session state failed its integrity check: ${path}`);
    this.name = "SessionStateIntegrityError";
  }
}

/** Typed restore failure: the sidecar belongs to a different conversation. */
export class SessionStateConversationMismatchError extends Error {
  constructor() {
    super("Persisted review-gate state belongs to a different conversation.");
    this.name = "SessionStateConversationMismatchError";
  }
}

/**
 * Typed restore failure: the sidecar is authentic but predates the canonical
 * session format — its persisted snapshots lack the omission ledger — which
 * is no longer supported. The review portion of such a sidecar is explicitly
 * unrecoverable rather than guessed; never quotes the document's content.
 */
export class SessionStateUnsupportedFormatError extends Error {
  constructor() {
    super("Persisted review-gate session state predates the canonical snapshot format (missing omission ledger) and is no longer supported.");
    this.name = "SessionStateUnsupportedFormatError";
  }
}

/**
 * Typed restore failure: the sidecar is authentic but carries a persisted
 * review window without the reviewer-selection digest that current writers
 * always record. That shape predates selection tracking and is explicitly
 * unsupported: accepting it would upgrade it on read (the next save rewrites
 * the file with a freshly computed digest), so restore fails locally instead
 * of guessing and the sidecar is preserved untouched. Never quotes the
 * document's content.
 */
export class SessionStateMissingSelectionDigestError extends Error {
  constructor() {
    super("Persisted review-gate session state carries a review window without the reviewer-selection digest required by the current format and is no longer supported.");
    this.name = "SessionStateMissingSelectionDigestError";
  }
}

/**
 * Typed restore failure: the sidecar is authentic and structurally valid, but
 * one of its persisted Git checkpoint baselines failed fresh-process
 * verification (missing/corrupt record, missing or mismatched pin ref, wrong
 * repository, malformed descriptor). The restored state is never applied — a
 * Git baseline is never silently turned into a fresh snapshot — and the
 * sidecar is preserved untouched for manual recovery. Carries only the stable
 * checkpoint failure reason plus its bounded diagnostic.
 */
export class SessionStateGitBaselineError extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(`Persisted review-gate Git checkpoint baseline failed verification (${reason})${detail ? `: ${detail}` : ""}.`);
    this.name = "SessionStateGitBaselineError";
    this.reason = reason;
  }
}

/** Unified checkpoint restore failure (raw or Git). The sidecar is untouched. */
export class SessionStateCheckpointBaselineError extends Error {
  readonly reason: string;
  readonly detail: string | undefined;
  constructor(reason: string, detail?: string) {
    super(`Persisted review-gate checkpoint baseline failed verification (${reason})${detail ? `: ${detail}` : ""}.`);
    this.name = "SessionStateCheckpointBaselineError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Atomically move a session-state sidecar to a unique sibling path without
 * clobbering any existing file. link() fails with EEXIST if the target already
 * exists (no-clobber) and is atomic; unlink() then removes the original so the
 * quarantine is the only copy. On any failure the original path is left intact
 * and the caller must fail closed (never overwrite it).
 */
export async function quarantineSessionStateSidecar(path: string): Promise<string> {
  const target = `${path}${SESSION_STATE_QUARANTINE_MARKER}${Date.now()}-${randomUUID()}.json`;
  await link(path, target);
  // Establish the no-clobber sibling in the directory before removing the
  // authoritative name, reducing the crash window on filesystems that honor
  // directory fsync.
  await syncDirectoryBestEffort(dirname(path));
  try {
    await unlink(path);
    await syncDirectoryBestEffort(dirname(path));
  } catch (error) {
    // Roll back the quarantine copy so the original remains the only copy.
    try {
      await unlink(target);
      await syncDirectoryBestEffort(dirname(path));
    } catch {
      // Both copies remain; the original is intact. Fail closed at the caller.
    }
    throw error;
  }
  return target;
}

/** One durable conflict gate as persisted in the session-state sidecar. */
export interface PersistedConflictGate {
  executionId: string;
  taskId: string;
  sourceRoot: string;
  paths: string[];
  activatedAt: string;
  manifestPath: string;
  reason: string;
  /** #126 approved (explicit force-merge only): preserved conflicts whose gate
   * stays unresolved until manually resolved. Entries with a `sidecarPath` keep
   * the worker version alongside the intact target (markClean validates it);
   * entries without one record a worker-side deletion (no bytes fabricated).
   * Persisted so markClean keeps enforcing it after restore. */
  sidecars?: Array<{ path: string; sidecarPath?: string }>;
}

export interface ExecutionAssociationsSnapshot {
  waveRoots: string[];
  bundles: ReattachmentBundle[];
  groupRoots?: string[];
  /** Legacy single-gate field; recovered on restore, no longer written. */
  conflictGate?: PersistedConflictGate;
  /** #25 multi-target: every outstanding gate (one per source root). */
  conflictGates?: PersistedConflictGate[];
}

export interface SessionPersistenceIdentity {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

interface PersistedSessionState {
  version: 1 | 2 | 3 | 4;
  revision: number;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  savedAt: string;
  integritySha256: string;
  /**
   * Digest of the reviewer selection that produced the persisted state. Older
   * sidecars predate the field; reconciliation reports their saved selection
   * as unverifiable instead of guessing.
   */
  reviewerSelectionDigest?: string;
  state: PersistedReviewGateState;
  execution: ExecutionAssociationsSnapshot;
}

interface PersistedReviewGateState {
  nextReviewWindowId: number;
  reviewWindow?: PersistedReviewWindow;
  lastQuestionWindow?: PersistedReviewWindow;
  pendingAcceptedReviewerQuestions: ReviewGateState["pendingAcceptedReviewerQuestions"];
  reviewsPaused: boolean;
  queuedUserInputsDuringReview: string[];
  pendingModelDeliveries: ReviewGateState["pendingModelDeliveries"];
}

interface PersistedReviewWindow {
  id: number;
  startedAt: string;
  requestHistory: ReviewWindow["requestHistory"];
  correctionCycles: number;
  lastCappedFollowUp?: string;
  lastCorrectionFeedback?: ReviewWindow["lastCorrectionFeedback"];
  baseline?: PersistedBaseline;
  /** v4 arming marker distinguishes a valid not-yet-captured window from lost baseline data. */
  baselineArmed?: boolean;
  evidence: PersistedEvidenceState;
  reviewHistory: ReviewWindow["reviewHistory"];
  exchanges: ReviewWindow["exchanges"];
  activeExchange?: {
    sequence: number;
    startedAt: string;
    baseline?: PersistedBaseline | PersistedWorkspaceSnapshotReference | PersistedGitCheckpointReference | PersistedCheckpointReference;
    evidenceEventStart: number;
    assistantSummaryStart: number;
    requestHistoryStart: number;
    causedByReviewSequence?: number;
    causedByReviewVerdict?: "pass" | "needs_changes" | "error";
    reviewResponseMode?: "correction" | "observation" | "deferred";
  };
  nextExchangeSequence: number;
  bundleDir?: string;
  nextReviewSequence: number;
  reviewerSessions: Array<[string, ReviewerSession]>;
  retainBundleAfterClose: boolean;
  nextExchangeRequestIndex: number;
}

interface PersistedWorkspaceSnapshot {
  cwd: string;
  capturedAt: string;
  files: Array<[string, FileSnapshot]>;
  omissions: SnapshotOmission[];
  omissionsTruncated: boolean;
}

/**
 * Compact persisted form of a Git checkpoint baseline (version 3): the
 * durable descriptor plus the capture root and timestamp only. The full
 * checkpoint record — patches and untracked content — stays in the
 * repository's owned scratch directory and is reloaded and verified through
 * `loadGitCheckpoint` on every restore before any state is applied.
 */
interface PersistedGitBaseline {
  kind: "git";
  descriptor: GitCheckpointDescriptor;
  cwd: string;
  capturedAt: string;
}

/** The new parent's compact unified descriptor, never an inline checkpoint payload. */
interface PersistedCheckpointBaseline {
  kind: "checkpoint";
  descriptor: ReviewCheckpointDescriptor;
  cwd: string;
  capturedAt: string;
}

type PersistedBaseline = PersistedWorkspaceSnapshot | PersistedGitBaseline | PersistedCheckpointBaseline;

interface PersistedWorkspaceSnapshotReference {
  $snapshotRef: {
    format: typeof SNAPSHOT_REFERENCE_FORMAT;
    version: typeof SNAPSHOT_REFERENCE_VERSION;
    target: "window.baseline";
  };
}

/**
 * Version-3 dedup reference for an active-exchange baseline that is identical
 * to the window's Git checkpoint baseline: the descriptor is persisted once,
 * on the window. Strictly validated (exact keys, exact format/version/target)
 * and only accepted against a Git window baseline.
 */
interface PersistedGitCheckpointReference {
  $gitCheckpointRef: {
    format: typeof GIT_CHECKPOINT_REFERENCE_FORMAT;
    version: typeof GIT_CHECKPOINT_REFERENCE_VERSION;
    target: "window.baseline";
  };
}

interface PersistedCheckpointReference {
  $checkpointRef: {
    format: typeof CHECKPOINT_REFERENCE_FORMAT;
    version: typeof CHECKPOINT_REFERENCE_VERSION;
    target: "window.baseline";
  };
}

interface PersistedEvidenceState {
  nextSequence: number;
  events: EvidenceState["events"];
  candidates: Array<[string, Omit<EvidenceCandidate, "exchangeBaselines"> & {
    exchangeBaselines: Array<[number, { snapshot?: FileSnapshot; error?: string }]>;
  }]>;
  finalAssistantSummaries: string[];
  acceptedReviewerQuestions: EvidenceState["acceptedReviewerQuestions"];
}

export interface RestoredSessionState {
  revision: number;
  state: ReviewGateState;
  execution: ExecutionAssociationsSnapshot;
  reviewerSelectionDigest?: string;
  /** Pre-cutover review context was discarded, not passed or migrated. Existing
   * workspace edits become the next request's freshly captured baseline. */
  reviewCutover?: "fresh_review_required" | "damaged_checkpoint";
  /** Safe, fixed-category diagnostic for an authenticated damaged checkpoint. */
  damagedCheckpointReason?: string;
}

export class SessionStateStore {
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();
  private markerAppended = false;
  private unavailableReason: string | undefined;

  constructor(
    readonly identity: SessionPersistenceIdentity,
    private readonly appendEntry?: (customType: string, data: unknown) => void,
  ) {}

  get path(): string {
    return `${this.identity.sessionFile}.pi-review-gate-state.json`;
  }

  setRevision(revision: number): void {
    this.revision = Math.max(this.revision, revision);
  }

  /**
   * Fail-closed guard: after a restore failure that must not be overwritten,
   * mark the store unavailable so save() becomes a no-op that reports no
   * durable write. The authoritative prior sidecar is preserved in place.
   */
  markUnavailable(reason: string): void {
    this.unavailableReason = reason;
  }

  get unavailableReasonText(): string | undefined {
    return this.unavailableReason;
  }

  /**
   * Move the authoritative sidecar to a unique sibling path. Resolves with the
   * quarantine path; rejects (leaving the original untouched) on any failure.
   */
  async quarantine(): Promise<string> {
    return quarantineSessionStateSidecar(this.path);
  }

  /**
   * Persist state. Resolves true only when a real durable write happened;
   * resolves false without writing when the store is unavailable (fail closed).
   */
  async save(
    state: ReviewGateState,
    execution: ExecutionAssociationsSnapshot,
    reviewConfig?: ReviewGateConfig,
  ): Promise<boolean> {
    if (this.unavailableReason !== undefined) return false;
    const revision = ++this.revision;
    const unsigned = {
      version: SESSION_STATE_VERSION as 4,
      revision,
      sessionId: this.identity.sessionId,
      sessionFile: this.identity.sessionFile,
      cwd: resolve(this.identity.cwd),
      savedAt: new Date().toISOString(),
      reviewerSelectionDigest: reviewConfig ? reviewerSelectionDigest(reviewConfig) : undefined,
      state: serializeState(state),
      execution: cloneExecutionAssociations(execution),
    };
    const canonicalUnsigned = JSON.parse(JSON.stringify(unsigned)) as Omit<PersistedSessionState, "integritySha256">;
    const snapshot: PersistedSessionState = {
      ...canonicalUnsigned,
      integritySha256: createHash("sha256").update(stableJson(canonicalUnsigned)).digest("hex"),
    };
    const operation = this.tail.then(async () => {
      const body = `${JSON.stringify(snapshot)}\n`;
      await atomicWrite(this.path, body);
      if (!this.markerAppended && this.appendEntry) {
        this.markerAppended = true;
        this.appendEntry(SESSION_STATE_ENTRY_TYPE, {
          version: SESSION_STATE_VERSION,
          stateFile: this.path,
          sidecarIsAuthoritative: true,
          registeredAt: snapshot.savedAt,
        });
      }
    });
    this.tail = operation.catch(() => undefined);
    await operation;
    return true;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  /**
   * Restore and verify persisted state. `checkpointScope` is the trusted live
   * session scope (live session id + Pi agent-data directory) that locates raw
   * checkpoint records; it is never read from the sidecar. By default it is
   * this store's live-bound session identity with Pi's resolved agent dir.
   */
  async restore(
    currentCwd: string,
    checkpointScope: ReviewCheckpointScope | undefined = { agentDir: piAgentDir(process.env), sessionId: this.identity.sessionId },
  ): Promise<RestoredSessionState | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Replace JSON.parse's error (which quotes file content) with a typed
      // error so raw sidecar text can never reach callers or notices.
      throw new SessionStateParseError(this.path);
    }
    if (!isPersistedSessionState(parsed)) {
      throw new SessionStateInvalidStateError(this.path);
    }
    const { integritySha256, ...unsigned } = parsed;
    const actualIntegrity = createHash("sha256").update(stableJson(unsigned)).digest("hex");
    if (integritySha256 !== actualIntegrity) {
      throw new SessionStateIntegrityError(this.path);
    }
    if (parsed.sessionId !== this.identity.sessionId || parsed.sessionFile !== this.identity.sessionFile) {
      throw new SessionStateConversationMismatchError();
    }
    if (resolve(parsed.cwd) !== resolve(currentCwd)) {
      throw new SessionStateCwdMismatchError({
        storedCwd: parsed.cwd,
        currentCwd: resolve(currentCwd),
        revision: parsed.revision,
        pendingDeliveries: summarizePendingDeliveries(parsed.state.pendingModelDeliveries ?? []),
      });
    }
    // Old-only boundary: current writers always record reviewerSelectionDigest
    // when a review window is persisted. A window without it predates
    // selection tracking and is explicitly unsupported — reject before any
    // restored state is applied, rather than upgrading the file on read (the
    // next save would rewrite it with a freshly computed digest). Records
    // without a persisted review window have nothing to verify and remain
    // restorable.
    if (parsed.version === SESSION_STATE_VERSION
      && (isRecord(parsed.state.reviewWindow) || isRecord(parsed.state.lastQuestionWindow))
      && parsed.reviewerSelectionDigest === undefined) {
      throw new SessionStateMissingSelectionDigestError();
    }
    // Authentic pre-cutover sidecars keep execution associations and unrelated
    // state, but old review windows/verdicts are not migrated or deemed passed.
    // The next request opens a fresh window: edits already in the workspace
    // become its new baseline, with no old-review confirmation requirement.
    const preCutover = parsed.version !== SESSION_STATE_VERSION;
    const cutover = preCutover && Boolean(parsed.state.reviewWindow || parsed.state.lastQuestionWindow);
    const state = deserializeState(cutover
      ? { ...parsed.state, reviewWindow: undefined, lastQuestionWindow: undefined, pendingAcceptedReviewerQuestions: [] }
      : parsed.state);
    // Only an authentic current-format unified descriptor with a damaged
    // owned record/pin qualifies. Malformed sidecars, foreign descriptors and
    // legacy Git baselines remain fail-closed. No state is applied on failure.
    // Every distinct descriptor is verified before any cutover decision: one
    // recoverable failure can never mask another descriptor's or record's
    // non-recoverable (schema, binding, session, workspace) failure.
    let damagedCheckpointReason: string | undefined;
    const failures = await verifyCheckpointBaselines(state, checkpointScope);
    if (failures.length > 0) {
      if (preCutover) throw failures[0];
      for (const failure of failures) {
        if (!await hasRecoverableCheckpointDamage(state, currentCwd, failure, checkpointScope)) throw failure;
      }
      damagedCheckpointReason = failures[0]!.reason;
      state.reviewWindow = undefined;
      state.lastQuestionWindow = undefined;
      state.pendingAcceptedReviewerQuestions = [];
    }
    if (preCutover || damagedCheckpointReason) {
      for (const delivery of state.pendingModelDeliveries) {
        if (delivery.status === "queued" && delivery.kind !== "queued_user_input") {
          delivery.status = "cancelled";
          delivery.diagnostic = "Previous review delivery was cancelled; a fresh review is required.";
        }
      }
    }
    this.revision = parsed.revision;
    return {
      revision: parsed.revision,
      state,
      execution: cloneExecutionAssociations(parsed.execution),
      reviewerSelectionDigest: cutover || damagedCheckpointReason ? undefined : parsed.reviewerSelectionDigest,
      reviewCutover: damagedCheckpointReason ? "damaged_checkpoint" : cutover ? "fresh_review_required" : undefined,
      damagedCheckpointReason,
    };
  }
}

/** Restrict fresh-start eligibility to well-formed local unified descriptors and
 * owned evidence failures. Never treat a foreign/malformed descriptor as damage. */
async function hasRecoverableCheckpointDamage(
  state: ReviewGateState, currentCwd: string, error: SessionStateCheckpointBaselineError, checkpointScope: ReviewCheckpointScope | undefined,
): Promise<boolean> {
  const baselines = [state.reviewWindow, state.lastQuestionWindow]
    .flatMap((window) => [window?.baseline, window?.activeExchange?.baseline])
    .filter((baseline) => baseline?.kind === "checkpoint");
  if (!baselines.length) return false;
  for (const baseline of baselines) {
    if (!baseline || baseline.kind !== "checkpoint") return false;
    const captureRoot = await realpath(baseline.cwd).catch(() => undefined);
    if (captureRoot === undefined || captureRoot !== await realpath(currentCwd).catch(() => undefined)) return false;
    if (baseline.descriptor.kind === "git") {
      try { decodeGitCheckpointDescriptor(JSON.stringify(baseline.descriptor.checkpoint)); }
      catch { return false; }
    } else if (baseline.descriptor.format !== RAW_REVIEW_CHECKPOINT_FORMAT
      || !isSafeWindowId(baseline.descriptor.windowId)
      || !/^[0-9a-f]{32}$/.test(baseline.descriptor.owner)
      || !/^[0-9a-f]{64}$/.test(baseline.descriptor.digest)
      // Only the trusted live session and the current canonical workspace can
      // own a recoverable raw record; an identity mismatch is never damage.
      || !checkpointScope || !isSafeCheckpointSessionId(baseline.descriptor.sessionId)
      || baseline.descriptor.sessionId !== checkpointScope.sessionId
      || baseline.descriptor.root !== captureRoot) return false;
  }
  if (error.reason === "raw_checkpoint_failed") {
    // Only owned-record damage qualifies; descriptor, session, workspace,
    // storage-location and privacy failures carry no damage marker.
    return error.detail?.startsWith(RAW_CHECKPOINT_DAMAGE_PREFIX) === true;
  }
  return new Set([
    "checkpoint_data_missing", "checkpoint_digest_mismatch", "malformed_record",
    "descriptor_record_mismatch", "pin_ref_missing", "pin_ref_mismatch", "pin_object_missing",
    "pin_generation_mismatch",
  ]).has(error.reason);
}

/**
 * Reload and verify EVERY distinct unified raw/Git descriptor, returning all
 * unified failures (legacy Git baselines still throw immediately). Snapshot and typed legacy Git compatibility remain only
 * until the primary adapter has moved entirely to unified checkpoints.
 */
async function verifyCheckpointBaselines(
  state: ReviewGateState, checkpointScope: ReviewCheckpointScope | undefined,
): Promise<SessionStateCheckpointBaselineError[]> {
  const seen = new Set<string>();
  const failures: SessionStateCheckpointBaselineError[] = [];
  for (const window of [state.reviewWindow, state.lastQuestionWindow]) {
    if (!window) continue;
    for (const baseline of [window.baseline, window.activeExchange?.baseline]) {
      if (!baseline || (baseline.kind !== "checkpoint" && baseline.kind !== "git")) continue;
      const identity = baseline.kind === "checkpoint"
        ? reviewCheckpointDescriptorIdentity(baseline.cwd, baseline.descriptor)
        : stableJson({ cwd: baseline.cwd, kind: baseline.kind, descriptor: baseline.descriptor });
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (baseline.kind === "git") {
        const outcome = await loadReviewCheckpoint(baseline.cwd, { kind: "git", checkpoint: baseline.descriptor });
        if (outcome.status !== "ok") throw new SessionStateGitBaselineError(outcome.reason, outcome.detail);
      } else {
        const outcome = await loadReviewCheckpoint(baseline.cwd, baseline.descriptor, { scope: checkpointScope });
        if (outcome.status !== "ok") failures.push(new SessionStateCheckpointBaselineError(outcome.reason, outcome.detail));
      }
    }
  }
  return failures;
}

export function sessionPersistenceIdentity(ctx: unknown, fallbackCwd: string): SessionPersistenceIdentity | undefined {
  if (!isRecord(ctx) || !isRecord(ctx.sessionManager)) return undefined;
  const manager = ctx.sessionManager;
  const sessionId = callString(manager, "getSessionId");
  const sessionFile = callString(manager, "getSessionFile");
  const cwd = callString(manager, "getCwd") ?? fallbackCwd;
  if (!sessionId || !sessionFile) return undefined;
  return { sessionId, sessionFile, cwd };
}

export function replaceReviewGateState(target: ReviewGateState, restored: ReviewGateState): void {
  target.nextReviewWindowId = restored.nextReviewWindowId;
  target.reviewWindow = restored.reviewWindow;
  target.lastQuestionWindow = restored.lastQuestionWindow;
  target.ownedBundleDirs = restored.ownedBundleDirs;
  target.pendingAcceptedReviewerQuestions = restored.pendingAcceptedReviewerQuestions;
  target.reviewsPaused = restored.reviewsPaused;
  // Persisted metadata is not a live review owner. A same-process rebind may
  // still have an older run settling; only that run releases its captured token.
  target.reviewInProgress = false;
  target.reviewActivityToken = undefined;
  target.queuedUserInputsDuringReview = restored.queuedUserInputsDuringReview;
  target.pendingModelDeliveries = restored.pendingModelDeliveries;
}

export function configDigest(config: ReviewGateConfig): string {
  const { ui: _ui, ...reviewRelevantConfig } = config;
  if (!reviewRelevantConfig.execution) {
    return createHash("sha256").update(stableJson(reviewRelevantConfig)).digest("hex");
  }
  const { subtaskNotifications: _notifications, ...execution } = reviewRelevantConfig.execution;
  return createHash("sha256").update(stableJson({ ...reviewRelevantConfig, execution })).digest("hex");
}

/**
 * Digest of the reviewer selection a config resolves to: the resolvable
 * reviewers' full structural identity plus the typed unresolved/duplicated
 * selections and the enabled flag. Unlike configDigest this is insensitive to
 * unrelated settings (web tools, timeouts, patch limits), so reconciliation on
 * restore triggers only when the reviewer configuration itself changed.
 *
 * Persistence always digests materialized (frozen) configurations, which carry
 * only the resolvable subset; their unresolved and duplicated selections live
 * beside the config object and are folded in here at that frozen identity
 * boundary. Merging both sources keeps a live configuration and its
 * materialization of the same effective selection hashing identically, so an
 * unchanged reload never reports a change while swapping one unresolvable
 * selection for another (or a duplicate-only change) is visible.
 */
export function reviewerSelectionDigest(config: ReviewGateConfig): string {
  const resolution = resolveReviewers(config);
  return createHash("sha256").update(stableJson({
    enabled: config.enabled,
    // Canonicalize each reviewer's identity so live and frozen (materialized)
    // configurations with the same effective selection hash identically even
    // though materialization may add keys with undefined values.
    reviewers: resolution.reviewers.map(canonicalReviewerIdentity),
    unknownIds: [...new Set([...resolution.unknownIds, ...unresolvedReviewerSelectionsFor(config)])],
    duplicateEnabledIds: [...new Set([...resolution.duplicateEnabledIds, ...duplicateReviewerSelectionsFor(config)])],
  })).digest("hex");
}

function canonicalReviewerIdentity(reviewer: DeciderConfig): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reviewer)) {
    if (value !== undefined) canonical[key] = value;
  }
  return canonical;
}

function serializeState(state: ReviewGateState): PersistedReviewGateState {
  return {
    nextReviewWindowId: state.nextReviewWindowId,
    reviewWindow: state.reviewWindow ? serializeWindow(state.reviewWindow) : undefined,
    lastQuestionWindow: state.lastQuestionWindow ? serializeWindow(state.lastQuestionWindow) : undefined,
    pendingAcceptedReviewerQuestions: state.pendingAcceptedReviewerQuestions.map((entry) => ({ ...entry })),
    reviewsPaused: state.reviewsPaused,
    queuedUserInputsDuringReview: [...state.queuedUserInputsDuringReview],
    pendingModelDeliveries: state.pendingModelDeliveries.map((delivery) => ({ ...delivery })),
  };
}

function deserializeState(state: PersistedReviewGateState): ReviewGateState {
  return {
    nextReviewWindowId: state.nextReviewWindowId,
    ownedBundleDirs: new Set(),
    reviewWindow: state.reviewWindow ? deserializeWindow(state.reviewWindow) : undefined,
    lastQuestionWindow: state.lastQuestionWindow ? deserializeWindow(state.lastQuestionWindow) : undefined,
    pendingAcceptedReviewerQuestions: state.pendingAcceptedReviewerQuestions.map((entry) => ({ ...entry })),
    reviewsPaused: state.reviewsPaused,
    reviewInProgress: false,
    queuedUserInputsDuringReview: [...state.queuedUserInputsDuringReview],
    pendingModelDeliveries: (state.pendingModelDeliveries ?? []).map((delivery) => ({ ...delivery })),
  };
}

function serializeWindow(window: ReviewWindow): PersistedReviewWindow {
  // Same-kind invariant at the persistence boundary: a window whose two
  // baselines disagree on kind would restore as an invalid document (the
  // store rejects it), so refuse to persist one rather than write a sidecar
  // that fails closed on its own next read.
  const exchangeBaseline = window.activeExchange?.baseline;
  if (window.baseline && exchangeBaseline && window.baseline.kind !== exchangeBaseline.kind) {
    throw new Error("review gate: refusing to persist a review window with mixed baseline kinds");
  }
  // A Git window's completed exchanges may carry Git-derived workspace change
  // data: their inline old/new file contents are the very payloads a compact
  // descriptor sidecar must not duplicate (the checkpoint record durably holds
  // them). Path, status, omission, mode, tracking, and rename metadata plus
  // the bounded patches stay; only the unbounded content fields are stripped.
  //
  // Deliberately asymmetric: `sideEffectChanges` are out-of-workspace changes
  // with NO Git checkpoint fallback, so their inline content is preserved for
  // Git windows exactly as for snapshot windows — dropping it would make a
  // restored Git window unable to reconstruct side effects once the transient
  // review bundle is gone.
  const stripWorkspaceContent = window.baseline?.kind === "git" || window.baseline?.kind === "checkpoint";
  const baseline = window.baseline ? serializeBaseline(window.baseline) : undefined;
  const sharesWindowBaseline = window.baseline !== undefined
    && exchangeBaseline !== undefined
    && sameBaselineIdentity(window.baseline, exchangeBaseline);
  return {
    id: window.id,
    startedAt: window.startedAt,
    requestHistory: window.requestHistory.map((entry) => ({ ...entry })),
    correctionCycles: window.correctionCycles,
    lastCappedFollowUp: window.lastCappedFollowUp,
    lastCorrectionFeedback: window.lastCorrectionFeedback ? { ...window.lastCorrectionFeedback } : undefined,
    baseline,
    baselineArmed: Boolean(window.baseline || exchangeBaseline),
    evidence: serializeEvidence(window.evidence),
    reviewHistory: window.reviewHistory.map((entry) => ({
      ...entry,
      reviewerResults: entry.reviewerResults.map((result) => ({
        ...result,
        findings: result.findings.map((finding) => ({ ...finding })),
        usage: result.usage ? { ...result.usage } : undefined,
      })),
    })),
    exchanges: window.exchanges.map((entry) => ({
      ...entry,
      workspaceChanges: entry.workspaceChanges.map((change) => serializeChangedFile(change, stripWorkspaceContent)),
      // Side effects are always persisted in full (see the asymmetry note
      // above): they have no durable checkpoint fallback.
      sideEffectChanges: entry.sideEffectChanges.map((change) => ({ ...change })),
      evidenceEvents: entry.evidenceEvents.map((event) => ({ ...event, candidatePaths: [...event.candidatePaths], riskSignals: [...event.riskSignals] })),
      assistantSummaries: [...entry.assistantSummaries],
      userRequests: entry.userRequests.map((request) => ({ ...request })),
      actingUsage: entry.actingUsage ? { ...entry.actingUsage } : undefined,
    })),
    activeExchange: window.activeExchange ? {
      ...window.activeExchange,
      baseline: sharesWindowBaseline
        ? (window.baseline?.kind === "checkpoint" ? createCheckpointReference()
          : window.baseline?.kind === "git" ? createGitCheckpointReference() : createSnapshotReference())
        : exchangeBaseline ? serializeBaseline(exchangeBaseline) : undefined,
    } : undefined,
    nextExchangeSequence: window.nextExchangeSequence,
    bundleDir: window.bundleDir,
    nextReviewSequence: window.nextReviewSequence,
    reviewerSessions: [...window.reviewerSessions.entries()].map(([key, value]) => [key, { ...value }]),
    retainBundleAfterClose: window.retainBundleAfterClose,
    nextExchangeRequestIndex: window.nextExchangeRequestIndex,
  };
}

function deserializeWindow(window: PersistedReviewWindow): ReviewWindow {
  const baseline = window.baseline ? deserializeBaseline(window.baseline) : undefined;
  const persistedExchangeBaseline = window.activeExchange?.baseline;
  const exchangeBaseline = persistedExchangeBaseline === undefined
    ? undefined
    : isPersistedWorkspaceSnapshotReference(persistedExchangeBaseline)
      || isPersistedGitCheckpointReference(persistedExchangeBaseline)
      || isPersistedCheckpointReference(persistedExchangeBaseline)
      ? baseline
      : deserializeBaseline(persistedExchangeBaseline);
  return {
    id: window.id,
    startedAt: window.startedAt,
    requestHistory: window.requestHistory.map((entry) => ({ ...entry })),
    correctionCycles: window.correctionCycles,
    lastCappedFollowUp: window.lastCappedFollowUp,
    lastCorrectionFeedback: window.lastCorrectionFeedback ? { ...window.lastCorrectionFeedback } : undefined,
    baseline,
    evidence: deserializeEvidence(window.evidence),
    reviewHistory: window.reviewHistory.map((entry) => ({
      ...entry,
      reviewerResults: entry.reviewerResults.map((result) => ({
        ...result,
        findings: result.findings.map((finding) => ({ ...finding })),
        usage: result.usage ? { ...result.usage } : undefined,
      })),
    })),
    exchanges: window.exchanges.map((entry) => ({
      ...entry,
      workspaceChanges: entry.workspaceChanges.map((change) => ({ ...change })),
      sideEffectChanges: entry.sideEffectChanges.map((change) => ({ ...change })),
      evidenceEvents: entry.evidenceEvents.map((event) => ({ ...event, candidatePaths: [...event.candidatePaths], riskSignals: [...event.riskSignals] })),
      assistantSummaries: [...entry.assistantSummaries],
      userRequests: entry.userRequests.map((request) => ({ ...request })),
      actingUsage: entry.actingUsage ? { ...entry.actingUsage } : undefined,
    })),
    activeExchange: window.activeExchange ? {
      ...window.activeExchange,
      baseline: exchangeBaseline,
    } : undefined,
    nextExchangeSequence: window.nextExchangeSequence,
    bundleDir: window.bundleDir,
    nextReviewSequence: window.nextReviewSequence,
    reviewerSessions: new Map(window.reviewerSessions.map(([key, value]) => [key, { ...value }])),
    retainBundleAfterClose: window.retainBundleAfterClose,
    nextExchangeRequestIndex: window.nextExchangeRequestIndex,
  };
}

function serializeSnapshot(snapshot: WorkspaceSnapshot): PersistedWorkspaceSnapshot {
  return {
    cwd: snapshot.cwd,
    capturedAt: snapshot.capturedAt,
    files: [...snapshot.files.entries()].map(([key, value]) => [key, { ...value }]),
    omissions: snapshot.omissions.map((omission) => ({ ...omission })),
    omissionsTruncated: snapshot.omissionsTruncated,
  };
}

function serializeBaseline(baseline: ReviewBaseline): PersistedBaseline {
  if (baseline.kind === "snapshot") return serializeSnapshot(baseline.snapshot);
  // Compact by contract: descriptor plus capture root/timestamp only.
  if (baseline.kind === "checkpoint") {
    return { kind: "checkpoint", descriptor: { ...baseline.descriptor }, cwd: baseline.cwd, capturedAt: baseline.capturedAt };
  }
  return { kind: "git", descriptor: { ...baseline.descriptor }, cwd: baseline.cwd, capturedAt: baseline.capturedAt };
}

function deserializeBaseline(baseline: PersistedBaseline): ReviewBaseline {
  if (isPersistedCheckpointBaseline(baseline)) {
    return { kind: "checkpoint", descriptor: { ...baseline.descriptor }, cwd: baseline.cwd, capturedAt: baseline.capturedAt };
  }
  if (isPersistedGitBaseline(baseline)) {
    return {
      kind: "git",
      descriptor: { ...baseline.descriptor },
      cwd: baseline.cwd,
      capturedAt: baseline.capturedAt,
    };
  }
  return { kind: "snapshot", snapshot: deserializeSnapshot(baseline) };
}

/**
 * Identity used to deduplicate a window's active-exchange baseline against
 * the window baseline itself. Snapshots keep the existing reference-identity
 * rule; Git baselines are identical when descriptor, capture root, and
 * timestamp all agree (the reference then aliases the window baseline on
 * restore exactly like the snapshot reference does).
 */
function sameBaselineIdentity(a: ReviewBaseline, b: ReviewBaseline): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "snapshot" && b.kind === "snapshot") return a.snapshot === b.snapshot;
  if (a.kind === "checkpoint" && b.kind === "checkpoint") {
    return reviewCheckpointDescriptorIdentity(a.cwd, a.descriptor)
      === reviewCheckpointDescriptorIdentity(b.cwd, b.descriptor);
  }
  if (a.kind === "git" && b.kind === "git") {
    return stableJson({ descriptor: a.descriptor, cwd: a.cwd, capturedAt: a.capturedAt })
      === stableJson({ descriptor: b.descriptor, cwd: b.cwd, capturedAt: b.capturedAt });
  }
  return false;
}

/**
 * Copy one persisted exchange WORKSPACE change entry. For Git windows the
 * unbounded inline file contents are stripped because the durable checkpoint
 * record already holds them (the bounded patch and every decision field —
 * path, status, omission, mode, tracking, rename — are preserved); snapshot
 * windows persist the full entry as before. Side-effect changes never pass
 * through this strip: they have no checkpoint fallback (see serializeWindow).
 */
function serializeChangedFile(change: ChangedFile, stripContent: boolean): ChangedFile {
  if (!stripContent) return { ...change };
  const { oldContent: _oldContent, newContent: _newContent, ...rest } = change;
  return rest;
}

function deserializeSnapshot(snapshot: PersistedWorkspaceSnapshot): WorkspaceSnapshot {
  // Sidecars predating the omission ledger are old-only and unsupported:
  // fail explicitly instead of guessing an empty ledger, so a preserved
  // baseline can never claim a completeness it was never recorded with.
  if (!Array.isArray(snapshot.omissions) || typeof snapshot.omissionsTruncated !== "boolean") {
    throw new SessionStateUnsupportedFormatError();
  }
  return {
    cwd: snapshot.cwd,
    capturedAt: snapshot.capturedAt,
    files: new Map(snapshot.files.map(([key, value]) => [key, { ...value }])),
    omissions: snapshot.omissions.map((omission) => ({ ...omission })),
    omissionsTruncated: snapshot.omissionsTruncated,
  };
}

function createSnapshotReference(): PersistedWorkspaceSnapshotReference {
  return {
    $snapshotRef: {
      format: SNAPSHOT_REFERENCE_FORMAT,
      version: SNAPSHOT_REFERENCE_VERSION,
      target: "window.baseline",
    },
  };
}

function createCheckpointReference(): PersistedCheckpointReference {
  return { $checkpointRef: { format: CHECKPOINT_REFERENCE_FORMAT, version: CHECKPOINT_REFERENCE_VERSION, target: "window.baseline" } };
}

function createGitCheckpointReference(): PersistedGitCheckpointReference {
  return {
    $gitCheckpointRef: {
      format: GIT_CHECKPOINT_REFERENCE_FORMAT,
      version: GIT_CHECKPOINT_REFERENCE_VERSION,
      target: "window.baseline",
    },
  };
}

function serializeEvidence(evidence: EvidenceState): PersistedEvidenceState {
  return {
    nextSequence: evidence.nextSequence,
    events: evidence.events.map((event) => ({ ...event, candidatePaths: [...event.candidatePaths], riskSignals: [...event.riskSignals] })),
    candidates: [...evidence.candidates.entries()].map(([key, candidate]) => [key, {
      ...candidate,
      sources: [...candidate.sources],
      baseline: candidate.baseline ? { ...candidate.baseline } : undefined,
      exchangeBaselines: [...candidate.exchangeBaselines.entries()].map(([sequence, entry]) => [sequence, {
        ...entry,
        snapshot: entry.snapshot ? { ...entry.snapshot } : undefined,
      }]),
    }]),
    finalAssistantSummaries: [...evidence.finalAssistantSummaries],
    acceptedReviewerQuestions: evidence.acceptedReviewerQuestions.map((entry) => ({ ...entry })),
  };
}

function deserializeEvidence(evidence: PersistedEvidenceState): EvidenceState {
  return {
    nextSequence: evidence.nextSequence,
    events: evidence.events.map((event) => ({ ...event, candidatePaths: [...event.candidatePaths], riskSignals: [...event.riskSignals] })),
    candidates: new Map(evidence.candidates.map(([key, candidate]) => [key, {
      ...candidate,
      sources: [...candidate.sources],
      baseline: candidate.baseline ? { ...candidate.baseline } : undefined,
      exchangeBaselines: new Map(candidate.exchangeBaselines.map(([sequence, entry]) => [sequence, {
        ...entry,
        snapshot: entry.snapshot ? { ...entry.snapshot } : undefined,
      }])),
    }])),
    finalAssistantSummaries: [...evidence.finalAssistantSummaries],
    acceptedReviewerQuestions: evidence.acceptedReviewerQuestions.map((entry) => ({ ...entry })),
  };
}

function cloneExecutionAssociations(value: ExecutionAssociationsSnapshot): ExecutionAssociationsSnapshot {
  return {
    waveRoots: [...new Set(value.waveRoots)],
    bundles: value.bundles.map((bundle) => ({ ...bundle })),
    groupRoots: value.groupRoots ? [...new Set(value.groupRoots)] : undefined,
    conflictGate: value.conflictGate ? { ...value.conflictGate, paths: [...value.conflictGate.paths] } : undefined,
    conflictGates: value.conflictGates?.map((gate) => ({ ...gate, paths: [...gate.paths] })),
  };
}

/**
 * Atomically publish the sidecar: stage it in a same-directory exclusive temp
 * file (mode 0600), write and fsync it, close, then rename it over the final
 * path with a best-effort directory fsync.
 *
 * The temporary file is removed on any pre-publication failure — and only
 * when this invocation created it: ownership begins when the exclusive open
 * succeeds (a pre-existing collision at the temp path fails before ownership
 * and is never removed), the rename is the commit point, and another
 * writer's temp files are never touched. Cleanup is best-effort so it never
 * masks or replaces the publication failure. If cleanup succeeds, the owned
 * unpublished temp is gone; if it fails, the publication still fails truthfully.
 * The previous committed sidecar stays intact before rename succeeds.
 */
async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.tmp.${randomUUID()}`;
  let file: FileHandle | undefined;
  let ownsTemp = false;
  try {
    file = await open(temporary, "wx", 0o600);
    ownsTemp = true;
    try {
      await file.writeFile(body, "utf8");
      await file.sync();
    } finally {
      // Preserve the existing close-error precedence if writing or syncing
      // also failed. Cleanup must not change which publication error escapes.
      await file.close();
      file = undefined;
    }
    await rename(temporary, path);
    ownsTemp = false;
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    if (ownsTemp) await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some platforms/filesystems do not permit directory fsync.
  }
}

function isPersistedSessionState(value: unknown): value is PersistedSessionState {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== SESSION_STATE_VERSION)) return false;
  if (!Number.isInteger(value.revision) || typeof value.sessionId !== "string" || typeof value.sessionFile !== "string") return false;
  if (typeof value.cwd !== "string" || typeof value.savedAt !== "string" || typeof value.integritySha256 !== "string") return false;
  if (!isRecord(value.state) || !isRecord(value.execution)) return false;
  if (value.state.reviewWindow !== undefined && !isValidPersistedReviewWindow(value.state.reviewWindow, value.version)) return false;
  if (value.state.lastQuestionWindow !== undefined && !isValidPersistedReviewWindow(value.state.lastQuestionWindow, value.version)) return false;
  if (!Number.isInteger(value.state.nextReviewWindowId)
    || !Array.isArray(value.state.pendingAcceptedReviewerQuestions)
    || typeof value.state.reviewsPaused !== "boolean"
    || !Array.isArray(value.state.queuedUserInputsDuringReview)
    || (value.state.pendingModelDeliveries !== undefined && !Array.isArray(value.state.pendingModelDeliveries))) return false;
  if (!Array.isArray(value.execution.waveRoots) || value.execution.waveRoots.some((root) => typeof root !== "string")
    || !Array.isArray(value.execution.bundles) || value.execution.bundles.some((bundle) =>
      !isRecord(bundle) || bundle.version !== 1 || typeof bundle.operationId !== "string"
      || typeof bundle.waveId !== "string" || typeof bundle.taskId !== "string"
      || typeof bundle.waveRoot !== "string" || !Number.isInteger(bundle.expectedRevision))) return false;
  if (value.execution.groupRoots !== undefined
    && (!Array.isArray(value.execution.groupRoots) || value.execution.groupRoots.some((root) => typeof root !== "string"))) return false;
  if (value.execution.conflictGate !== undefined && !isValidConflictGate(value.execution.conflictGate)) return false;
  if (value.execution.conflictGates !== undefined
    && (!Array.isArray(value.execution.conflictGates) || value.execution.conflictGates.some((gate) => !isValidConflictGate(gate)))) return false;
  return true;
}

function isValidPersistedReviewWindow(value: unknown, version: 1 | 2 | 3 | 4): boolean {
  if (!isRecord(value)) return false;
  if (value.baseline !== undefined && !isPersistedBaseline(value.baseline, version)) return false;
  if (version === SESSION_STATE_VERSION && (typeof value.baselineArmed !== "boolean"
    || (value.baselineArmed && value.baseline === undefined)
    || (!value.baselineArmed && value.baseline !== undefined))) return false;
  if (version === SESSION_STATE_VERSION && value.baseline === undefined
    && (Array.isArray(value.reviewHistory) && value.reviewHistory.length > 0
      || Array.isArray(value.exchanges) && value.exchanges.length > 0
      || isRecord(value.evidence) && Array.isArray(value.evidence.events) && value.evidence.events.length > 0)) return false;
  if (value.activeExchange === undefined) return true;
  if (!isRecord(value.activeExchange)) return false;
  const exchangeBaseline = value.activeExchange.baseline;
  if (exchangeBaseline === undefined) return true;
  if (isRecord(exchangeBaseline) && Object.hasOwn(exchangeBaseline, "$snapshotRef")) {
    // The provisional v2 dedup reference remains restorable by the v3 writer.
    return isPersistedWorkspaceSnapshotReference(exchangeBaseline)
      && version !== 1
      && isPersistedWorkspaceSnapshot(value.baseline);
  }
  if (isRecord(exchangeBaseline) && Object.hasOwn(exchangeBaseline, "$checkpointRef")) {
    return isPersistedCheckpointReference(exchangeBaseline)
      && version === SESSION_STATE_VERSION
      && isPersistedCheckpointBaseline(value.baseline);
  }
  if (isRecord(exchangeBaseline) && Object.hasOwn(exchangeBaseline, "$gitCheckpointRef")) {
    // Git dedup references only exist in v3 documents, and only against a
    // Git window baseline of the same kind.
    return isPersistedGitCheckpointReference(exchangeBaseline)
      && (version === 3 || version === SESSION_STATE_VERSION)
      && isPersistedGitBaseline(value.baseline);
  }
  if (!isPersistedBaseline(exchangeBaseline, version)) return false;
  if (version === SESSION_STATE_VERSION && value.baseline === undefined) return false;
  // Same-kind invariant: an inline exchange baseline must match the window
  // baseline's kind (references pin their kind by construction above). A
  // mixed pair is rejected before any restored state is applied.
  return persistedBaselineKind(value.baseline) === persistedBaselineKind(exchangeBaseline);
}

function isPersistedBaseline(value: unknown, version: 1 | 2 | 3 | 4): value is PersistedBaseline {
  if (isRecord(value) && value.kind === "checkpoint") {
    return version === SESSION_STATE_VERSION && isPersistedCheckpointBaseline(value);
  }
  if (isRecord(value) && value.kind === "git") {
    // Git baselines are a v3 shape; older documents never carried them.
    return (version === 3 || version === SESSION_STATE_VERSION) && isPersistedGitBaseline(value);
  }
  return isPersistedWorkspaceSnapshot(value);
}

function persistedBaselineKind(baseline: PersistedBaseline): "snapshot" | "git" | "checkpoint" {
  return isPersistedCheckpointBaseline(baseline) ? "checkpoint" : isPersistedGitBaseline(baseline) ? "git" : "snapshot";
}

/**
 * Structural shape check for a persisted Git baseline. Deep descriptor
 * validation (safe ids, oid/ref consistency, digest shape) happens in
 * `loadGitCheckpoint`'s first gate on every restore; this rejects documents
 * whose shape is wrong before any state is materialized.
 */
function isPersistedCheckpointBaseline(value: unknown): value is PersistedCheckpointBaseline {
  if (!isRecord(value) || value.kind !== "checkpoint"
    || typeof value.cwd !== "string" || typeof value.capturedAt !== "string" || !isRecord(value.descriptor)) return false;
  const d = value.descriptor;
  // Deeper descriptor validity, record digest and pin are verified by the
  // backend. Reject absent/wrong-shaped descriptors before materialization.
  if (d.kind === "git") return isRecord(d.checkpoint)
    && d.checkpoint.format === GIT_CHECKPOINT_DESCRIPTOR_FORMAT
    && typeof d.checkpoint.windowId === "string" && typeof d.checkpoint.armId === "string"
    && typeof d.checkpoint.gitDir === "string" && typeof d.checkpoint.base === "string"
    && typeof d.checkpoint.ref === "string" && typeof d.checkpoint.digest === "string"
    && (d.checkpoint.objectFormat === "sha1" || d.checkpoint.objectFormat === "sha256");
  // Forward-only: raw descriptors must carry the current storage-bound format
  // (#301). Earlier raw formats are rejected, never migrated.
  return d.kind === "raw" && d.format === RAW_REVIEW_CHECKPOINT_FORMAT
    && typeof d.sessionId === "string" && typeof d.root === "string" && typeof d.windowId === "string"
    && typeof d.owner === "string" && typeof d.digest === "string";
}

function isPersistedGitBaseline(value: unknown): value is PersistedGitBaseline {
  if (!isRecord(value) || value.kind !== "git") return false;
  if (typeof value.cwd !== "string" || typeof value.capturedAt !== "string") return false;
  const descriptor = value.descriptor;
  return isRecord(descriptor)
    && descriptor.format === GIT_CHECKPOINT_DESCRIPTOR_FORMAT
    && typeof descriptor.windowId === "string"
    && typeof descriptor.armId === "string"
    && typeof descriptor.gitDir === "string"
    && typeof descriptor.base === "string"
    && typeof descriptor.ref === "string"
    && (descriptor.objectFormat === "sha1" || descriptor.objectFormat === "sha256")
    && typeof descriptor.digest === "string";
}

function isPersistedWorkspaceSnapshot(value: unknown): value is PersistedWorkspaceSnapshot {
  return isRecord(value)
    && typeof value.cwd === "string"
    && typeof value.capturedAt === "string"
    && Array.isArray(value.files);
}

function isPersistedWorkspaceSnapshotReference(value: unknown): value is PersistedWorkspaceSnapshotReference {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.$snapshotRef)) return false;
  const reference = value.$snapshotRef;
  return Object.keys(reference).length === 3
    && reference.format === SNAPSHOT_REFERENCE_FORMAT
    && reference.version === SNAPSHOT_REFERENCE_VERSION
    && reference.target === "window.baseline";
}

/** Strict reference shape: exactly one key, exact format/version/target. */
function isPersistedGitCheckpointReference(value: unknown): value is PersistedGitCheckpointReference {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.$gitCheckpointRef)) return false;
  const reference = value.$gitCheckpointRef;
  return Object.keys(reference).length === 3
    && reference.format === GIT_CHECKPOINT_REFERENCE_FORMAT
    && reference.version === GIT_CHECKPOINT_REFERENCE_VERSION
    && reference.target === "window.baseline";
}

function isPersistedCheckpointReference(value: unknown): value is PersistedCheckpointReference {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.$checkpointRef)) return false;
  const reference = value.$checkpointRef;
  return Object.keys(reference).length === 3 && reference.format === CHECKPOINT_REFERENCE_FORMAT
    && reference.version === CHECKPOINT_REFERENCE_VERSION && reference.target === "window.baseline";
}

function isValidConflictGate(value: unknown): value is PersistedConflictGate {
  return isRecord(value)
    && typeof value.executionId === "string"
    && typeof value.taskId === "string"
    && typeof value.sourceRoot === "string"
    && Array.isArray(value.paths) && value.paths.every((path) => typeof path === "string")
    && typeof value.activatedAt === "string"
    && typeof value.manifestPath === "string"
    && typeof value.reason === "string"
    // A malformed sidecar entry must reject the snapshot rather than be
    // dropped: a restored gate without it could clear a sidecar conflict
    // while the worker version still sits alongside.
    && (value.sidecars === undefined || isValidSidecarList(value.sidecars));
}

function isValidSidecarList(value: unknown): value is Array<{ path: string; sidecarPath?: string }> {
  // A malformed entry must reject the snapshot rather than be dropped. The
  // sidecar path is optional (worker-side deletion records carry none) but, when
  // present, must be a string — never a number, object, or other type.
  return Array.isArray(value)
    && value.every((entry) =>
      isRecord(entry)
      && typeof entry.path === "string"
      && (entry.sidecarPath === undefined || typeof entry.sidecarPath === "string"),
    );
}

function summarizePendingDeliveries(deliveries: ReadonlyArray<{ status?: unknown; kind?: unknown }>): PendingDeliverySummary {
  const byStatus = new Map<string, number>();
  const byKind = new Map<string, number>();
  for (const delivery of deliveries) {
    if (delivery && typeof delivery.status === "string") {
      byStatus.set(delivery.status, (byStatus.get(delivery.status) ?? 0) + 1);
    }
    if (delivery && typeof delivery.kind === "string") {
      byKind.set(delivery.kind, (byKind.get(delivery.kind) ?? 0) + 1);
    }
  }
  // Object.fromEntries uses own data properties even for adversarial keys such
  // as "__proto__", unlike assignment into a normal object accumulator.
  return {
    total: deliveries.length,
    byStatus: Object.fromEntries(byStatus),
    byKind: Object.fromEntries(byKind),
  };
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some supported platforms and filesystems reject directory handles/fsync.
  }
}

/** Canonical descriptor identity shared by persistence refs and runtime ownership.
 * Field insertion order does not change ownership or create duplicate pins. */
export function reviewCheckpointDescriptorIdentity(cwd: string, descriptor: ReviewCheckpointDescriptor): string {
  return stableJson({ cwd, descriptor });
}

function callString(target: Record<string, unknown>, name: string): string | undefined {
  const fn = target[name];
  if (typeof fn !== "function") return undefined;
  const value = fn.call(target);
  return typeof value === "string" && value ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
