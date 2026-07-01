import type { WorkspaceSnapshot } from "./capture";
import { createEvidenceState, type EvidenceState } from "./evidence";

export interface ReviewGateState {
  latestRequest: string;
  correctionCycles: number;
  baseline?: WorkspaceSnapshot;
  touchedPaths: Set<string>;
  evidence: EvidenceState;
}

export function createState(): ReviewGateState {
  return {
    latestRequest: "",
    correctionCycles: 0,
    touchedPaths: new Set<string>(),
    evidence: createEvidenceState(),
  };
}

export function rememberUserRequest(state: ReviewGateState, request: string): void {
  if (request.trim()) {
    state.latestRequest = request;
    state.correctionCycles = 0;
    state.touchedPaths.clear();
    state.evidence = createEvidenceState();
  }
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
