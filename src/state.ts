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
import type { ReviewFinding, ReviewResult } from "./schema";
import type { TokenUsage } from "./usage";

export type ReviewWindowStatus = "pending" | "active" | "paused_at_cap" | "paused";
export type ReviewFeedbackSource = "automatic" | "manual";
export type ReviewFeedbackDisposition = "sent_for_correction" | "held_at_cap" | "held_then_sent" | "reported_only";

export interface ReviewWindow {
  id: number;
  startedAt: string;
  status: ReviewWindowStatus;
  latestRequest: string;
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
}

export interface ActiveReviewExchange {
  sequence: number;
  startedAt: string;
  baseline?: WorkspaceSnapshot;
  evidenceEventStart: number;
  assistantSummaryStart: number;
  requestHistoryStart: number;
  causedByReviewSequence?: number;
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
  actingUsage?: TokenUsage;
}

export interface ReviewGateState {
  nextReviewWindowId: number;
  reviewWindow?: ReviewWindow;
  lastQuestionWindow?: ReviewWindow;
  pendingAcceptedReviewerQuestions: AcceptedReviewerQuestion[];
  reviewInProgress: boolean;
  queuedUserInputsDuringReview: string[];
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
  summary: string;
  findings: ReviewFinding[];
  followUpMessage?: string;
}

export function createState(): ReviewGateState {
  return {
    nextReviewWindowId: 1,
    pendingAcceptedReviewerQuestions: [],
    reviewInProgress: false,
    queuedUserInputsDuringReview: [],
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
  window.latestRequest = text;
}

export function beginAgentRun(state: ReviewGateState): "new" | "continuation" {
  const window = state.reviewWindow ?? openReviewWindow(state);
  window.status = "active";
  if (!window.activeExchange) {
    window.activeExchange = {
      sequence: window.nextExchangeSequence++,
      startedAt: new Date().toISOString(),
      evidenceEventStart: window.evidence.events.length,
      assistantSummaryStart: window.evidence.finalAssistantSummaries.length,
      requestHistoryStart: window.nextExchangeRequestIndex,
      causedByReviewSequence: [...window.reviewHistory].reverse().find((feedback) => feedback.verdict === "needs_changes")?.sequence,
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
  window.status = "active";
}

export function activeExchangeHasBaseline(state: ReviewGateState): boolean {
  return Boolean(state.reviewWindow?.activeExchange?.baseline);
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
  return window.reviewHistory.some((feedback) => feedback.verdict === "needs_changes");
}

export function closeReviewWindow(state: ReviewGateState, preserveForReviewerQuestions = false): void {
  state.lastQuestionWindow = preserveForReviewerQuestions ? state.reviewWindow : undefined;
  state.reviewWindow = undefined;
}

export function clearReviewState(state: ReviewGateState): void {
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
): void {
  const window = contextWindow ?? state.reviewWindow ?? openReviewWindow(state);
  recordAcceptedQuestionEvidence(window.evidence, input);
  if (!state.reviewWindow && window === state.lastQuestionWindow) {
    state.pendingAcceptedReviewerQuestions = window.evidence.acceptedReviewerQuestions.map((entry) => ({ ...entry }));
  }
}

export function pauseReviewWindow(state: ReviewGateState, status: "paused_at_cap" | "paused"): void {
  if (state.reviewWindow) {
    state.reviewWindow.status = status;
  }
}

export function recordReviewerFeedback(
  state: ReviewGateState,
  input: {
    result: ReviewResult;
    source: ReviewFeedbackSource;
    disposition: ReviewFeedbackDisposition;
    followUpMessage?: string;
  },
): void {
  const window = state.reviewWindow;
  if (!window) {
    return;
  }
  window.reviewHistory.push({
    sequence: window.reviewHistory.length + 1,
    source: input.source,
    disposition: input.disposition,
    verdict: input.result.verdict,
    summary: input.result.summary,
    findings: input.result.findings.map((finding) => ({ ...finding })),
    followUpMessage: input.followUpMessage,
  });
}

export function markCappedFeedbackSent(state: ReviewGateState, followUpMessage: string): void {
  const history = state.reviewWindow?.reviewHistory;
  if (!history) {
    return;
  }
  const feedback = [...history].reverse().find((item) =>
    item.disposition === "held_at_cap" && item.followUpMessage === followUpMessage
  );
  if (feedback) {
    feedback.disposition = "held_then_sent";
  }
}

export function buildRequestContext(state: ReviewGateState, window = state.reviewWindow): string {
  if (!window) {
    return "No active review window or original request captured.";
  }

  const lines = [
    `Review window: ${window.id}`,
    `Review window started: ${window.startedAt}`,
    "",
    ...renderUserRequestContext(window),
  ];

  if (window.reviewHistory.length > 0) {
    lines.push(
      "",
      "Historical prior review feedback from this same review window:",
      "These findings describe earlier workspace states. Do not assume they remain unresolved; reconcile each one against the current workspace.",
    );
    for (const feedback of window.reviewHistory) {
      lines.push(
        "",
        `Review ${feedback.sequence} (${feedback.source}; ${feedback.verdict}; ${formatDisposition(feedback.disposition)}):`,
        `Summary: ${feedback.summary}`,
      );
      for (const finding of feedback.findings) {
        const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
        lines.push(`- ${finding.severity} ${location}: ${finding.issue} ${finding.recommendation}`);
      }
      if (feedback.followUpMessage) {
        lines.push("Correction feedback:", feedback.followUpMessage);
      }
    }
  }

  return lines.join("\n");
}

function openReviewWindow(state: ReviewGateState): ReviewWindow {
  const carriedQuestions = state.pendingAcceptedReviewerQuestions.splice(0);
  state.lastQuestionWindow = undefined;
  const evidence = createEvidenceState();
  evidence.acceptedReviewerQuestions.push(...carriedQuestions.map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  })));
  const window: ReviewWindow = {
    id: state.nextReviewWindowId++,
    startedAt: new Date().toISOString(),
    status: "pending",
    latestRequest: "",
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

function renderUserRequestContext(window: ReviewWindow): string[] {
  if (window.requestHistory.length === 0) {
    return [window.latestRequest || "No original request captured."];
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
  if (disposition === "held_at_cap") {
    return "feedback held at the correction cap";
  }
  if (disposition === "sent_for_correction") {
    return "feedback sent for correction";
  }
  if (disposition === "held_then_sent") {
    return "feedback held at the correction cap, then sent by /review-continue";
  }
  return "reported without automatic correction";
}
