import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
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
import type { FileSnapshot, SnapshotOmission, WorkspaceSnapshot } from "./capture";
import type { ReviewGateState, ReviewWindow } from "./state";
import type { ReviewerSession } from "./adapters/types";

export const SESSION_STATE_ENTRY_TYPE = "pi-review-gate-session-state";
const SESSION_STATE_VERSION = 1;

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

export interface ExecutionAssociationsSnapshot {
  waveRoots: string[];
  bundles: ReattachmentBundle[];
  groupRoots?: string[];
  conflictGate?: {
    executionId: string;
    taskId: string;
    sourceRoot: string;
    paths: string[];
    activatedAt: string;
    manifestPath: string;
    reason: string;
  };
}

export interface SessionPersistenceIdentity {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

interface PersistedSessionState {
  version: 1;
  revision: number;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  savedAt: string;
  integritySha256: string;
  reviewConfigDigest?: string;
  /**
   * Digest of the reviewer selection that produced the persisted state. Older
   * sidecars predate the field; restore falls back to the broad
   * reviewConfigDigest comparison for them.
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
  baseline?: PersistedWorkspaceSnapshot;
  evidence: PersistedEvidenceState;
  reviewHistory: ReviewWindow["reviewHistory"];
  exchanges: ReviewWindow["exchanges"];
  activeExchange?: {
    sequence: number;
    startedAt: string;
    baseline?: PersistedWorkspaceSnapshot;
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
  reviewConfigurationError?: string;
}

interface PersistedWorkspaceSnapshot {
  cwd: string;
  capturedAt: string;
  files: Array<[string, FileSnapshot]>;
  omissions: SnapshotOmission[];
  omissionsTruncated: boolean;
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
  reviewConfigDigest?: string;
  reviewerSelectionDigest?: string;
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
      version: SESSION_STATE_VERSION as 1,
      revision,
      sessionId: this.identity.sessionId,
      sessionFile: this.identity.sessionFile,
      cwd: resolve(this.identity.cwd),
      savedAt: new Date().toISOString(),
      reviewConfigDigest: reviewConfig ? configDigest(reviewConfig) : undefined,
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

  async restore(currentCwd: string): Promise<RestoredSessionState | undefined> {
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
    this.revision = parsed.revision;
    return {
      revision: parsed.revision,
      state: deserializeState(parsed.state),
      execution: cloneExecutionAssociations(parsed.execution),
      reviewConfigDigest: parsed.reviewConfigDigest,
      reviewerSelectionDigest: parsed.reviewerSelectionDigest,
    };
  }
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
  // A prior process cannot still own an in-process review in this runtime.
  target.reviewInProgress = false;
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
  return {
    id: window.id,
    startedAt: window.startedAt,
    requestHistory: window.requestHistory.map((entry) => ({ ...entry })),
    correctionCycles: window.correctionCycles,
    lastCappedFollowUp: window.lastCappedFollowUp,
    lastCorrectionFeedback: window.lastCorrectionFeedback ? { ...window.lastCorrectionFeedback } : undefined,
    baseline: window.baseline ? serializeSnapshot(window.baseline) : undefined,
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
      workspaceChanges: entry.workspaceChanges.map((change) => ({ ...change })),
      sideEffectChanges: entry.sideEffectChanges.map((change) => ({ ...change })),
      evidenceEvents: entry.evidenceEvents.map((event) => ({ ...event, candidatePaths: [...event.candidatePaths], riskSignals: [...event.riskSignals] })),
      assistantSummaries: [...entry.assistantSummaries],
      userRequests: entry.userRequests.map((request) => ({ ...request })),
      actingUsage: entry.actingUsage ? { ...entry.actingUsage } : undefined,
    })),
    activeExchange: window.activeExchange ? {
      ...window.activeExchange,
      baseline: window.activeExchange.baseline ? serializeSnapshot(window.activeExchange.baseline) : undefined,
    } : undefined,
    nextExchangeSequence: window.nextExchangeSequence,
    bundleDir: window.bundleDir,
    nextReviewSequence: window.nextReviewSequence,
    reviewerSessions: [...window.reviewerSessions.entries()].map(([key, value]) => [key, { ...value }]),
    retainBundleAfterClose: window.retainBundleAfterClose,
    nextExchangeRequestIndex: window.nextExchangeRequestIndex,
    reviewConfigurationError: window.reviewConfigurationError,
  };
}

function deserializeWindow(window: PersistedReviewWindow): ReviewWindow {
  return {
    id: window.id,
    startedAt: window.startedAt,
    requestHistory: window.requestHistory.map((entry) => ({ ...entry })),
    correctionCycles: window.correctionCycles,
    lastCappedFollowUp: window.lastCappedFollowUp,
    lastCorrectionFeedback: window.lastCorrectionFeedback ? { ...window.lastCorrectionFeedback } : undefined,
    baseline: window.baseline ? deserializeSnapshot(window.baseline) : undefined,
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
      baseline: window.activeExchange.baseline ? deserializeSnapshot(window.activeExchange.baseline) : undefined,
    } : undefined,
    nextExchangeSequence: window.nextExchangeSequence,
    bundleDir: window.bundleDir,
    nextReviewSequence: window.nextReviewSequence,
    reviewerSessions: new Map(window.reviewerSessions.map(([key, value]) => [key, { ...value }])),
    retainBundleAfterClose: window.retainBundleAfterClose,
    nextExchangeRequestIndex: window.nextExchangeRequestIndex,
    reviewConfigurationError: window.reviewConfigurationError,
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

function deserializeSnapshot(snapshot: PersistedWorkspaceSnapshot): WorkspaceSnapshot {
  return {
    cwd: snapshot.cwd,
    capturedAt: snapshot.capturedAt,
    files: new Map(snapshot.files.map(([key, value]) => [key, { ...value }])),
    // Legacy persisted state predates the omission ledger; default to empty.
    omissions: (snapshot.omissions ?? []).map((omission) => ({ ...omission })),
    omissionsTruncated: snapshot.omissionsTruncated ?? false,
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
  };
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.tmp.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(body, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
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
  if (!isRecord(value) || value.version !== SESSION_STATE_VERSION) return false;
  if (!Number.isInteger(value.revision) || typeof value.sessionId !== "string" || typeof value.sessionFile !== "string") return false;
  if (typeof value.cwd !== "string" || typeof value.savedAt !== "string" || typeof value.integritySha256 !== "string") return false;
  if (!isRecord(value.state) || !isRecord(value.execution)) return false;
  if (!Number.isInteger(value.state.nextReviewWindowId)
    || !Array.isArray(value.state.pendingAcceptedReviewerQuestions)
    || typeof value.state.reviewsPaused !== "boolean"
    || !Array.isArray(value.state.queuedUserInputsDuringReview)
    || (value.state.pendingModelDeliveries !== undefined && !Array.isArray(value.state.pendingModelDeliveries))) return false;
  if (!Array.isArray(value.execution.waveRoots) || !Array.isArray(value.execution.bundles)) return false;
  if (value.execution.groupRoots !== undefined && !Array.isArray(value.execution.groupRoots)) return false;
  if (value.execution.conflictGate !== undefined) {
    const gate = value.execution.conflictGate;
    if (!isRecord(gate)
      || typeof gate.executionId !== "string"
      || typeof gate.taskId !== "string"
      || typeof gate.sourceRoot !== "string"
      || !Array.isArray(gate.paths)
      || typeof gate.activatedAt !== "string"
      || typeof gate.manifestPath !== "string"
      || typeof gate.reason !== "string") return false;
  }
  return true;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
