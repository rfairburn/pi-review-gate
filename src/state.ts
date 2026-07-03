import type { WorkspaceSnapshot } from "./capture";
import { createEvidenceState, type EvidenceState } from "./evidence";

export interface ReviewGateState {
  latestRequest: string;
  requestHistory: UserRequestContext[];
  correctionCycles: number;
  lastCappedFollowUp?: string;
  reviewInProgress: boolean;
  queuedUserInputsDuringReview: string[];
  baseline?: WorkspaceSnapshot;
  runActive: boolean;
  touchedPaths: Set<string>;
  evidence: EvidenceState;
}

export interface UserRequestContext {
  sequence: number;
  phase: "initial" | "mid_run";
  text: string;
}

export function createState(): ReviewGateState {
  return {
    latestRequest: "",
    requestHistory: [],
    correctionCycles: 0,
    lastCappedFollowUp: undefined,
    reviewInProgress: false,
    queuedUserInputsDuringReview: [],
    runActive: false,
    touchedPaths: new Set<string>(),
    evidence: createEvidenceState(),
  };
}

export function rememberUserRequest(state: ReviewGateState, request: string): void {
  const text = request.trim();
  if (!text) {
    return;
  }

  if (state.runActive) {
    state.requestHistory.push({
      sequence: state.requestHistory.length + 1,
      phase: "mid_run",
      text,
    });
    state.latestRequest = text;
    return;
  }

  state.latestRequest = text;
  state.requestHistory = [{
    sequence: 1,
    phase: "initial",
    text,
  }];
  state.correctionCycles = 0;
  state.lastCappedFollowUp = undefined;
  state.queuedUserInputsDuringReview = [];
  state.touchedPaths.clear();
  state.evidence = createEvidenceState();
}

export function recordTouchedPath(state: ReviewGateState, path: unknown): void {
  if (typeof path === "string" && path.trim()) {
    state.touchedPaths.add(path);
  }
}

export function resetRunEvidence(state: ReviewGateState): void {
  state.evidence = createEvidenceState();
  state.touchedPaths.clear();
}

export function beginAgentRun(state: ReviewGateState): "new" | "continuation" {
  if (state.runActive && state.baseline) {
    return "continuation";
  }
  state.runActive = true;
  resetRunEvidence(state);
  return "new";
}

export function buildRequestContext(state: ReviewGateState): string {
  if (state.requestHistory.length === 0) {
    return state.latestRequest || "No original request captured.";
  }
  if (state.requestHistory.length === 1) {
    return state.requestHistory[0]?.text || "No original request captured.";
  }

  const initial = state.requestHistory.find((item) => item.phase === "initial") ?? state.requestHistory[0];
  const midRun = state.requestHistory.filter((item) => item !== initial);
  return [
    "Initial user request:",
    initial?.text ?? "No original request captured.",
    "",
    "Additional user guidance during the same agent run:",
    ...midRun.map((item) => `${item.sequence}. ${item.text}`),
  ].join("\n");
}
