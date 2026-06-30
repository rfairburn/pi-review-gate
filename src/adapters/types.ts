import type { ReviewResult } from "../schema";

export interface ModelAdapterRequest {
  id: string;
  cwd: string;
  prompt: string;
  bundleDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelAdapter {
  kind: string;
  run(req: ModelAdapterRequest): Promise<ReviewResult>;
}
