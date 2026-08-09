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

export interface ReviewerSession {
  adapter: string;
  id: string;
}

export interface ModelAdapter {
  kind: string;
  run(req: ModelAdapterRequest): Promise<ReviewResult>;
}
