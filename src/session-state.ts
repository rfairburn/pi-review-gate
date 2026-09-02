import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReviewGateConfig } from "./config";
import type { EvidenceCandidate, EvidenceState } from "./evidence";
import type { ReattachmentBundle } from "./execution/operation-record";
import type { FileSnapshot, SnapshotOmission, WorkspaceSnapshot } from "./capture";
import type { ReviewGateState, ReviewWindow } from "./state";
import type { ReviewerSession } from "./adapters/types";

export const SESSION_STATE_ENTRY_TYPE = "pi-review-gate-session-state";
const SESSION_STATE_VERSION = 1;

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
}

export class SessionStateStore {
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();
  private markerAppended = false;

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

  async save(
    state: ReviewGateState,
    execution: ExecutionAssociationsSnapshot,
    reviewConfig?: ReviewGateConfig,
  ): Promise<void> {
    const revision = ++this.revision;
    const unsigned = {
      version: SESSION_STATE_VERSION as 1,
      revision,
      sessionId: this.identity.sessionId,
      sessionFile: this.identity.sessionFile,
      cwd: resolve(this.identity.cwd),
      savedAt: new Date().toISOString(),
      reviewConfigDigest: reviewConfig ? configDigest(reviewConfig) : undefined,
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
    const parsed = JSON.parse(text) as unknown;
    if (!isPersistedSessionState(parsed)) {
      throw new Error(`Invalid persisted review-gate session state: ${this.path}`);
    }
    const { integritySha256, ...unsigned } = parsed;
    const actualIntegrity = createHash("sha256").update(stableJson(unsigned)).digest("hex");
    if (integritySha256 !== actualIntegrity) {
      throw new Error(`Persisted review-gate session state failed its integrity check: ${this.path}`);
    }
    if (parsed.sessionId !== this.identity.sessionId || parsed.sessionFile !== this.identity.sessionFile) {
      throw new Error("Persisted review-gate state belongs to a different conversation.");
    }
    if (resolve(parsed.cwd) !== resolve(currentCwd)) {
      throw new Error(`Persisted review-gate cwd ${parsed.cwd} does not match resumed cwd ${resolve(currentCwd)}.`);
    }
    this.revision = parsed.revision;
    return {
      revision: parsed.revision,
      state: deserializeState(parsed.state),
      execution: cloneExecutionAssociations(parsed.execution),
      reviewConfigDigest: parsed.reviewConfigDigest,
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
