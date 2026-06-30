import type { WorkspaceSnapshot } from "./capture";

export interface ReviewGateState {
  latestRequest: string;
  correctionCycles: number;
  baseline?: WorkspaceSnapshot;
  touchedPaths: Set<string>;
}

export function createState(): ReviewGateState {
  return {
    latestRequest: "",
    correctionCycles: 0,
    touchedPaths: new Set<string>(),
  };
}

export function rememberUserRequest(state: ReviewGateState, request: string): void {
  if (request.trim()) {
    state.latestRequest = request;
    state.correctionCycles = 0;
    state.touchedPaths.clear();
  }
}

export function recordTouchedPath(state: ReviewGateState, path: unknown): void {
  if (typeof path === "string" && path.trim()) {
    state.touchedPaths.add(path);
  }
}
