import type { ChangedFile, WorkspaceSnapshot } from "./capture";
import type { CorrectionFeedbackMarker } from "./correction-feedback";
import {
  createEvidenceState,
  recordAcceptedReviewerQuestion as recordAcceptedQuestionEvidence,
  type AcceptedReviewerQuestion,
  type EvidenceEvent,
  type EvidenceState,
} from "./evidence";
import type { ReviewerSession } from "./adapters/types";
import type { ReviewResult } from "./schema";
import type { TokenUsage } from "./usage";
import {
  automaticReviewEnabled,
  configWithReviewers,
  resolveReviewers,
  reviewerDisplayLabels,
  type ReviewGateConfig,
} from "./config";

export type ReviewFeedbackSource = "automatic" | "manual";
export type ReviewFeedbackDisposition =
  | "sent_for_correction"
  | "sent_for_observation"
  | "sent_at_cap"
  | "sent_review_error"
  | "held_then_sent";

export interface ReviewWindow {
  id: number;
  startedAt: string;
  requestHistory: UserRequestContext[];
  correctionCycles: number;
  lastCappedFollowUp?: string;
  lastCorrectionFeedback?: CorrectionFeedbackMarker;
  baseline?: WorkspaceSnapshot;
  evidence: EvidenceState;
  reviewHistory: ReviewFeedbackContext[];
  exchanges: ReviewExchangeContext[];
  activeExchange?: ActiveReviewExchange;
  nextExchangeSequence: number;
  bundleDir?: string;
  nextReviewSequence: number;
  reviewerSessions: Map<string, ReviewerSession>;
  retainBundleAfterClose: boolean;
  nextExchangeRequestIndex: number;
  reviewConfig?: ReviewGateConfig;
  reviewConfigurationError?: string;
}

export interface ActiveReviewExchange {
  sequence: number;
  startedAt: string;
  baseline?: WorkspaceSnapshot;
  evidenceEventStart: number;
  assistantSummaryStart: number;
  requestHistoryStart: number;
  causedByReviewSequence?: number;
  causedByReviewVerdict?: ReviewResult["verdict"];
  reviewResponseMode?: "correction" | "observation" | "deferred";
}

export interface ReviewExchangeContext {
  sequence: number;
  startedAt: string;
  endedAt: string;
  workspaceChanges: ChangedFile[];
  sideEffectChanges: ChangedFile[];
  workspacePatch: string;
  sideEffectPatch: string;
  evidenceEvents: EvidenceEvent[];
  assistantSummaries: string[];
  userRequests: UserRequestContext[];
  causedByReviewSequence?: number;
  causedByReviewVerdict?: ReviewResult["verdict"];
  reviewResponseMode?: "correction" | "observation" | "deferred";
  actingUsage?: TokenUsage;
}

export interface ReviewGateState {
  nextReviewWindowId: number;
  reviewWindow?: ReviewWindow;
  lastQuestionWindow?: ReviewWindow;
  /** Runtime-only ownership registry used to remove superseded bundles at application shutdown. */
  ownedBundleDirs: Set<string>;
  pendingAcceptedReviewerQuestions: AcceptedReviewerQuestion[];
  reviewsPaused: boolean;
  reviewInProgress: boolean;
  queuedUserInputsDuringReview: string[];
  pendingModelDeliveries: PendingModelDelivery[];
}

export interface PendingModelDelivery {
  deliveryId: string;
  kind: "review_transmission" | "review_authorization" | "reviewer_answer" | "queued_user_input";
  channel: "follow_up" | "steer";
  message: string;
  status: "queued" | "dispatching" | "delivered" | "uncertain" | "cancelled";
  invocationDir?: string;
  action?: "correction_required" | "passed" | "deferred" | "review_error";
  createdAt: string;
  dispatchStartedAt?: string;
  deliveredAt?: string;
  diagnostic?: string;
}

export interface UserRequestContext {
  sequence: number;
  phase: "initial" | "mid_run";
  text: string;
}

export interface ReviewFeedbackContext {
  sequence: number;
  source: ReviewFeedbackSource;
  disposition: ReviewFeedbackDisposition;
  verdict: ReviewResult["verdict"];
  reviewerResults: ReviewResult[];
}

export function createState(): ReviewGateState {
  return {
    nextReviewWindowId: 1,
    ownedBundleDirs: new Set(),
    pendingAcceptedReviewerQuestions: [],
    reviewsPaused: false,
    reviewInProgress: false,
    queuedUserInputsDuringReview: [],
    pendingModelDeliveries: [],
  };
}

export function rememberUserRequest(state: ReviewGateState, request: string): void {
  const text = request.trim();
  if (!text) {
    return;
  }

  const window = state.reviewWindow ?? openReviewWindow(state);
  if (window.requestHistory.length === 0) {
    window.requestHistory.push({
      sequence: 1,
      phase: "initial",
      text,
    });
  } else {
    window.requestHistory.push({
      sequence: window.requestHistory.length + 1,
      phase: "mid_run",
      text,
    });
  }
}

export function beginAgentRun(state: ReviewGateState): "new" | "continuation" {
  const window = state.reviewWindow ?? openReviewWindow(state);
  if (!window.activeExchange) {
    const feedback = [...window.reviewHistory].reverse().find((item) => reviewResponseMode(item.disposition) !== undefined);
    window.activeExchange = {
      sequence: window.nextExchangeSequence++,
      startedAt: new Date().toISOString(),
      evidenceEventStart: window.evidence.events.length,
      assistantSummaryStart: window.evidence.finalAssistantSummaries.length,
      requestHistoryStart: window.nextExchangeRequestIndex,
      causedByReviewSequence: feedback?.sequence,
      causedByReviewVerdict: feedback?.verdict,
      reviewResponseMode: feedback ? reviewResponseMode(feedback.disposition) : undefined,
    };
  }
  return window.baseline ? "continuation" : "new";
}

export function setReviewWindowBaseline(state: ReviewGateState, baseline: WorkspaceSnapshot): void {
  const window = state.reviewWindow ?? openReviewWindow(state);
  window.baseline ??= baseline;
  if (window.activeExchange && !window.activeExchange.baseline) {
    window.activeExchange.baseline = baseline;
  }
}

export function armReviewResponseExchange(state: ReviewGateState, reviewedSnapshot: WorkspaceSnapshot): void {
  beginAgentRun(state);
  const window = state.reviewWindow;
  const active = state.reviewWindow?.activeExchange;
  if (!active || !window) {
    return;
  }
  active.baseline ??= reviewedSnapshot;
  const feedback = [...window.reviewHistory].reverse().find((item) => reviewResponseMode(item.disposition) !== undefined);
  if (feedback) {
    active.causedByReviewSequence = feedback.sequence;
    active.causedByReviewVerdict = feedback.verdict;
    active.reviewResponseMode = reviewResponseMode(feedback.disposition);
  }
}

export function activeExchangeHasBaseline(state: ReviewGateState): boolean {
  return Boolean(state.reviewWindow?.activeExchange?.baseline);
}

export function activeExchangeBaseline(state: ReviewGateState): WorkspaceSnapshot | undefined {
  return state.reviewWindow?.activeExchange?.baseline;
}

export function freezeReviewWindowConfig(state: ReviewGateState, config: ReviewGateConfig, scopedModels: string[] = []): ReviewGateConfig {
  const window = state.reviewWindow ?? openReviewWindow(state);
  if (window.reviewConfig) {
    return window.reviewConfig;
  }
  const resolution = resolveReviewers(config, scopedModels);
  const issues = [
    resolution.unknownIds.length > 0 ? `unknown enabled reviewer ids: ${resolution.unknownIds.join(", ")}` : "",
    resolution.duplicateEnabledIds.length > 0
      ? `duplicate enabled reviewer ids: ${resolution.duplicateEnabledIds.join(", ")}`
      : "",
  ].filter(Boolean);
  window.reviewConfigurationError = config.enabled && issues.length > 0 ? issues.join("; ") : undefined;
  window.reviewConfig = configWithReviewers(
    config,
    resolution.reviewers,
    automaticReviewEnabled(config, scopedModels),
  );
  return window.reviewConfig;
}

export function checkpointReviewWindow(state: ReviewGateState, snapshot: WorkspaceSnapshot): void {
  const window = state.reviewWindow;
  if (!window) {
    return;
  }
  window.baseline = snapshot;
  if (window.activeExchange) {
    window.activeExchange.baseline = snapshot;
    window.activeExchange.evidenceEventStart = window.evidence.events.length;
    window.activeExchange.assistantSummaryStart = window.evidence.finalAssistantSummaries.length;
    window.activeExchange.requestHistoryStart = window.requestHistory.length;
  }
}

export function completeActiveExchange(
  window: ReviewWindow,
  input: {
    workspaceChanges: ChangedFile[];
    sideEffectChanges: ChangedFile[];
    workspacePatch: string;
    sideEffectPatch: string;
    actingUsage?: TokenUsage;
  },
): ReviewExchangeContext | undefined {
  const active = window.activeExchange;
  if (!active) {
    return undefined;
  }
  const exchange: ReviewExchangeContext = {
    sequence: active.sequence,
    startedAt: active.startedAt,
    endedAt: new Date().toISOString(),
    workspaceChanges: input.workspaceChanges,
    sideEffectChanges: input.sideEffectChanges,
    workspacePatch: input.workspacePatch,
    sideEffectPatch: input.sideEffectPatch,
    evidenceEvents: window.evidence.events.slice(active.evidenceEventStart),
    assistantSummaries: window.evidence.finalAssistantSummaries.slice(active.assistantSummaryStart),
    userRequests: window.requestHistory.slice(active.requestHistoryStart).map((request) => ({ ...request })),
    causedByReviewSequence: active.causedByReviewSequence,
    causedByReviewVerdict: active.causedByReviewVerdict,
    reviewResponseMode: active.reviewResponseMode,
    actingUsage: input.actingUsage,
  };
  window.exchanges.push(exchange);
  window.nextExchangeRequestIndex = window.requestHistory.length;
  window.activeExchange = undefined;
  return exchange;
}

export function hasUnresolvedReview(window: ReviewWindow | undefined): boolean {
  if (!window) {
    return false;
  }
  return window.reviewHistory.at(-1)?.verdict === "needs_changes";
}

export function closeReviewWindow(state: ReviewGateState, preserveForReviewerQuestions = false): void {
  rememberOwnedBundle(state, state.lastQuestionWindow);
  if (!preserveForReviewerQuestions) rememberOwnedBundle(state, state.reviewWindow);
  state.lastQuestionWindow = preserveForReviewerQuestions ? state.reviewWindow : undefined;
  state.reviewWindow = undefined;
}

export function clearReviewState(state: ReviewGateState): void {
  rememberOwnedBundle(state, state.reviewWindow);
  rememberOwnedBundle(state, state.lastQuestionWindow);
  for (const delivery of state.pendingModelDeliveries) {
    if (delivery.status !== "queued") continue;
    delivery.status = "cancelled";
    delivery.diagnostic = "The review state was explicitly cleared before this queued delivery was released.";
  }
  state.reviewWindow = undefined;
  state.lastQuestionWindow = undefined;
  state.pendingAcceptedReviewerQuestions.splice(0);
  state.queuedUserInputsDuringReview.splice(0);
}

export function getReviewerQuestionWindow(state: ReviewGateState): ReviewWindow | undefined {
  return state.reviewWindow ?? state.lastQuestionWindow;
}

export function getCorrectionAttemptCount(window: ReviewWindow | undefined): number {
  return window?.reviewHistory.filter((feedback) =>
    feedback.disposition === "sent_for_correction" || feedback.disposition === "held_then_sent"
  ).length ?? 0;
}

export function recordAcceptedReviewerQuestion(
  state: ReviewGateState,
  contextWindow: ReviewWindow | undefined,
  input: { question: string; acceptedAnswer: string },
): AcceptedReviewerQuestion {
  const window = contextWindow ?? state.reviewWindow ?? openReviewWindow(state);
  const accepted = recordAcceptedQuestionEvidence(window.evidence, input);
  if (!state.reviewWindow && window === state.lastQuestionWindow) {
    state.pendingAcceptedReviewerQuestions = window.evidence.acceptedReviewerQuestions.map((entry) => ({ ...entry }));
  }
  return accepted;
}

export function recordReviewerFeedback(
  state: ReviewGateState,
  input: {
    result: ReviewResult;
    reviewerResults?: ReviewResult[];
    reviewSequence?: number;
    source: ReviewFeedbackSource;
    disposition: ReviewFeedbackDisposition;
  },
): void {
  const window = state.reviewWindow;
  if (!window) {
    return;
  }
  window.reviewHistory.push({
    sequence: input.reviewSequence ?? window.reviewHistory.length + 1,
    source: input.source,
    disposition: input.disposition,
    verdict: input.result.verdict,
    reviewerResults: (input.reviewerResults ?? [input.result]).map(cloneReviewResult),
  });
}

export function recordReviewerFeedbackAndArmExchange(
  state: ReviewGateState,
  input: {
    result: ReviewResult;
    reviewerResults?: ReviewResult[];
    reviewSequence?: number;
    source: ReviewFeedbackSource;
    disposition: ReviewFeedbackDisposition;
    reviewedSnapshot: WorkspaceSnapshot;
  },
): void {
  recordReviewerFeedback(state, input);
  armReviewResponseExchange(state, input.reviewedSnapshot);
}

export function markCappedFeedbackSent(
  state: ReviewGateState,
): ReviewFeedbackContext | undefined {
  const history = state.reviewWindow?.reviewHistory;
  if (!history) {
    return;
  }
  const feedback = [...history].reverse().find((item) =>
    item.disposition === "sent_at_cap"
  );
  if (feedback) {
    feedback.disposition = "held_then_sent";
  }
  return feedback;
}

export function buildRequestContext(
  state: ReviewGateState,
  window = state.reviewWindow,
  options: { priorFeedback?: "all" | "latest" } = {},
): string {
  if (!window) {
    return "No active review window or original request captured.";
  }

  const lines = [
    `Review window: ${window.id}`,
    `Review window started: ${window.startedAt}`,
    "",
    ...renderUserRequestContext(window),
  ];
  const displayLabels = new Map(
    Object.entries(reviewerDisplayLabels(
      window.reviewConfig ? resolveReviewers(window.reviewConfig).reviewers : [],
    )),
  );

  if (window.reviewHistory.length > 0) {
    lines.push(
      "",
      "Historical prior review feedback from this same review window:",
      "These findings describe earlier workspace states. Do not assume they remain unresolved; reconcile each one against the current workspace.",
    );
    const feedbackHistory = options.priorFeedback === "latest"
      ? window.reviewHistory.slice(-1)
      : window.reviewHistory;
    for (const feedback of feedbackHistory) {
      lines.push(
        "",
        `Review ${feedback.sequence} (${feedback.source}; ${feedback.verdict}; ${formatDisposition(feedback.disposition)}):`,
      );
      if (feedback.reviewerResults.length > 0) {
        lines.push("Complete individual reviewer results delivered to the implementing model:");
        for (const reviewer of feedback.reviewerResults) {
          const displayLabel = displayLabels.get(reviewer.reviewerId) ?? reviewer.reviewerId;
          lines.push(`- ${displayLabel} (${reviewer.verdict}): ${reviewer.summary}`);
          if (reviewer.guidance) {
            lines.push(`  Guidance: ${reviewer.guidance}`);
          }
          for (const finding of reviewer.findings) {
            const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
            lines.push(`  - ${finding.severity} ${location}: ${finding.issue} ${finding.recommendation}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

function openReviewWindow(state: ReviewGateState): ReviewWindow {
  const carriedQuestions = state.pendingAcceptedReviewerQuestions.splice(0);
  rememberOwnedBundle(state, state.lastQuestionWindow);
  state.lastQuestionWindow = undefined;
  const evidence = createEvidenceState();
  evidence.acceptedReviewerQuestions.push(...carriedQuestions.map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  })));
  const window: ReviewWindow = {
    id: state.nextReviewWindowId++,
    startedAt: new Date().toISOString(),
    requestHistory: [],
    correctionCycles: 0,
    evidence,
    reviewHistory: [],
    exchanges: [],
    nextExchangeSequence: 1,
    nextReviewSequence: 1,
    reviewerSessions: new Map(),
    retainBundleAfterClose: false,
    nextExchangeRequestIndex: 0,
  };
  state.reviewWindow = window;
  return window;
}

function rememberOwnedBundle(state: ReviewGateState, window: ReviewWindow | undefined): void {
  if (window?.bundleDir) state.ownedBundleDirs.add(window.bundleDir);
}

function renderUserRequestContext(window: ReviewWindow): string[] {
  if (window.requestHistory.length === 0) {
    return ["No original request captured."];
  }
  if (window.requestHistory.length === 1) {
    return [window.requestHistory[0]?.text || "No original request captured."];
  }

  const initial = window.requestHistory.find((item) => item.phase === "initial") ?? window.requestHistory[0];
  const midRun = window.requestHistory.filter((item) => item !== initial);
  return [
    "Initial user request:",
    initial?.text ?? "No original request captured.",
    "",
    "Additional user guidance during the same review window:",
    ...midRun.map((item) => `${item.sequence}. ${item.text}`),
  ];
}

function formatDisposition(disposition: ReviewFeedbackDisposition): string {
  if (disposition === "sent_for_observation") {
    return "complete passing review transmitted to the implementing model";
  }
  if (disposition === "sent_at_cap") {
    return "complete feedback transmitted to the implementing model with correction deferred at the cap";
  }
  if (disposition === "sent_review_error") {
    return "review failure details transmitted to the implementing model";
  }
  if (disposition === "sent_for_correction") {
    return "feedback sent for correction";
  }
  if (disposition === "held_then_sent") {
    return "feedback held at the correction cap, then sent by /review-continue";
  }
  return "reported without automatic correction";
}

function reviewResponseMode(
  disposition: ReviewFeedbackDisposition,
): ActiveReviewExchange["reviewResponseMode"] {
  if (disposition === "sent_for_correction" || disposition === "held_then_sent") {
    return "correction";
  }
  if (disposition === "sent_for_observation") {
    return "observation";
  }
  if (disposition === "sent_at_cap" || disposition === "sent_review_error") {
    return "deferred";
  }
  return undefined;
}

function cloneReviewResult(result: ReviewResult): ReviewResult {
  return {
    ...result,
    findings: result.findings.map((finding) => ({ ...finding })),
    usage: result.usage ? { ...result.usage } : undefined,
  };
}
