import type { TokenUsage } from "../usage";

export interface ExecutorSession {
  adapter: string;
  id: string;
}

export interface ExecutorTurn {
  text: string;
  session: ExecutorSession;
  usage?: TokenUsage;
  stdoutPath: string;
  stderrPath: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface ExecutorRequest {
  cwd: string;
  prompt: string;
  artifactDir: string;
  turn: number;
  signal?: AbortSignal;
  session?: ExecutorSession;
  onUpdate?: (text: string) => void;
}

export interface ExecutorAdapter {
  readonly kind: string;
  readonly model?: string;
  run(request: ExecutorRequest): Promise<ExecutorTurn>;
}
