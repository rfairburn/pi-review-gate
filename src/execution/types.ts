import type { TokenUsage } from "../usage";
import type { PiLifecycleSummary } from "../usage";
import type { ExecutorToolCatalog } from "./tool-catalog";

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
  lifecycle?: PiLifecycleSummary;
  failure?: {
    category: "provider" | "stdin" | "protocol" | "process" | "interruption" | "compaction";
    message: string;
  };
}

export interface ExecutorRequest {
  cwd: string;
  prompt: string;
  artifactDir: string;
  turn: number;
  /** Filesystem capability assigned by the parent worker role. Defaults to workspace-write. */
  workspaceAccess?: "read-only" | "workspace-write";
  /** Canonical durable authorization and initial-activation contract. */
  executorToolCatalog?: ExecutorToolCatalog;
  /** @deprecated Compatibility mirror for adapters that consume only an allowlist. */
  allowedTools?: readonly string[];
  /** Compatibility mirror for durable future deferred-activation intent. */
  initialActiveTools?: readonly string[];
  signal?: AbortSignal;
  session?: ExecutorSession;
  recovery?: {
    kind: "retry" | "compaction";
    /** Reopen the durable session and finish compaction before prompting. */
    compactBeforePrompt?: boolean;
  };
  onUpdate?: (text: string) => void;
  onProcessStart?: (process: { pid: number; processGroupId?: number }) => void | Promise<void>;
  onProcessExit?: (process: { pid: number; processGroupId?: number; code: number | null; signal: NodeJS.Signals | null }) => void | Promise<void>;
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
}

export interface ExecutorInteractionAcknowledgement {
  status: "acknowledged" | "blocked" | "failed";
  message: string;
  turnId?: string;
}

export interface ExecutorLiveControl {
  adapter: string;
  generation: number;
  /** Adapter-negotiated protocol or harness identity for diagnostics. */
  protocol?: string;
  capabilities: {
    steer: boolean;
    interrupt: boolean;
  };
  steer(instruction: string, instructionId: string): Promise<ExecutorInteractionAcknowledgement>;
  interrupt(): Promise<ExecutorInteractionAcknowledgement>;
}

export interface ExecutorAdapter {
  readonly kind: string;
  readonly model?: string;
  run(request: ExecutorRequest): Promise<ExecutorTurn>;
}

export class ExecutorLifecycleError extends Error {
  constructor(
    readonly category: "compaction" | "interruption" | "protocol" | "process",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutorLifecycleError";
  }
}

export type SubtaskProgressPhase =
  | "starting"
  | "executing"
  | "reviewing"
  | "correcting"
  | "confirming"
  | "completing";

export interface SubtaskProgressUpdate {
  phase: SubtaskProgressPhase;
  message: string;
  subtaskId?: string;
  artifactDir?: string;
  adapter?: string;
  model?: string;
  executorTurn?: number;
  reviewCycle?: number;
  reviewers?: string[];
}

export type ContinuationProgressPhase =
  | SubtaskProgressPhase
  | "accepted"
  | "integrating"
  | "landing";

/** Typed progress emitted while a durable operation is continued and landed. */
export interface ContinuationProgressUpdate extends Omit<SubtaskProgressUpdate, "phase"> {
  phase: ContinuationProgressPhase;
}
