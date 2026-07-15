import type { WorkspaceSnapshot } from "./capture";
import type { CorrectionFeedbackMarker } from "./correction-feedback";
import { createEvidenceState, type EvidenceState } from "./evidence";
import type { ReviewFinding, ReviewResult } from "./schema";

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
}

export interface ReviewGateState {
  nextReviewWindowId: number;
  reviewWindow?: ReviewWindow;
  lastQuestionWindow?: ReviewWindow;
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
  return window.baseline ? "continuation" : "new";
}

export function setReviewWindowBaseline(state: ReviewGateState, baseline: WorkspaceSnapshot): void {
  const window = state.reviewWindow ?? openReviewWindow(state);
  window.baseline = baseline;
  window.status = "active";
}

export function closeReviewWindow(state: ReviewGateState, preserveForReviewerQuestions = false): void {
  state.lastQuestionWindow = preserveForReviewerQuestions ? state.reviewWindow : undefined;
  state.reviewWindow = undefined;
}

export function getReviewerQuestionWindow(state: ReviewGateState): ReviewWindow | undefined {
  return state.reviewWindow ?? state.lastQuestionWindow;
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
    lines.push("", "Prior review feedback from this same review window:");
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
  const window: ReviewWindow = {
    id: state.nextReviewWindowId++,
    startedAt: new Date().toISOString(),
    status: "pending",
    latestRequest: "",
    requestHistory: [],
    correctionCycles: 0,
    evidence: createEvidenceState(),
    reviewHistory: [],
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
