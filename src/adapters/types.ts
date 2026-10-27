import type { ReviewResult } from "../schema";

export interface ModelAdapterRequest {
  id: string;
  cwd: string;
  prompt: string;
  evidenceBundleDir?: string;
  bundleDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  session?: ReviewerSession;
  onSession?: (session: ReviewerSession) => void;
  onUpdate?: (message: string) => void;
}

/**
 * Reviewer pass identity: adapter plus session id only.
 *
 * #533: a pass's native session file and workspace live in exactly one place —
 * the canonical reference this owner records at
 * `<bundleDir>/pi-sessions/<id>.json`. Reviewer passes are always fresh, so
 * this struct is an identity reference for artifacts, never a continuation
 * handle, and it deliberately carries no second copy of the path state.
 */
export interface ReviewerSession {
  adapter: string;
  id: string;
}

export interface ModelAdapter {
  kind: string;
  run(req: ModelAdapterRequest): Promise<ReviewResult>;
}
