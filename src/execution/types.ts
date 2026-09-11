import type { TokenUsage } from "../usage";
import type { PiLifecycleSummary } from "../usage";
import type { ExecutorSelection } from "../config";
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
  /**
   * #93: invoked by the adapter at its actual prompt write/enqueue boundary —
   * after the transport accepted this prompt's write (stdin flush, queue
   * enqueue, or RPC acceptance) — and never for validation, adapter-creation,
   * or compaction failures that occur before delivery. Distinct from the turn
   * acknowledgement and from task compliance.
   */
  onPromptDelivery?: (delivery: { prompt: string }) => void;
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
}

export interface ExecutorInteractionAcknowledgement {
  status: "acknowledged" | "blocked" | "failed";
  message: string;
  turnId?: string;
}

/** Optional steering delivery modifiers (issue #63). */
export interface ExecutorSteerOptions {
  /**
   * Interrupt the active executor turn before delivering the instruction to
   * the same session and workspace. Non-terminal: the task, its workspace,
   * and prior work are preserved. Adapters without this capability must
   * report a concrete unsupported/failed status instead of claiming it.
   */
  interrupt?: boolean;
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
  steer(instruction: string, instructionId: string, options?: ExecutorSteerOptions): Promise<ExecutorInteractionAcknowledgement>;
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

/**
 * Provenance marker for dispatch records: the record was captured at the
 * actual executor transport boundary, never reconstructed from later
 * configuration or reassembled task state.
 */
export type SubtaskDispatchProvenance = "captured_at_dispatch";

/**
 * Minimal per-task record of one actual executor dispatch (#93).
 *
 * Captured at the adapter's actual prompt write/enqueue boundary — after the
 * transport accepted the prompt's write (pipe flush, queue enqueue, or RPC
 * acceptance) — never at request validation, adapter creation, or compaction
 * time. A failure before delivery therefore never publishes a record or
 * updates a card. This is the exact model-visible message — it is never
 * reconstructed from the task definition or later configuration, and it is
 * not claimed to equal the submitted task instructions (which remain recorded
 * separately on the task definition).
 *
 * Transport acceptance, turn ACK, and task compliance are separate facts and
 * are intentionally NOT claimed by this record: `delivery` covers only the
 * transport write/enqueue boundary.
 */
export interface SubtaskDispatchRecord {
  provenance: SubtaskDispatchProvenance;
  /**
   * Truthful delivery status, distinct from turn ACK and task compliance:
   * the transport accepted the prompt's write/enqueue at the adapter's
   * delivery boundary.
   */
  delivery: "written_to_transport";
  /** ISO timestamp of the delivery-boundary moment. */
  dispatchedAt: string;
  /** Exact prompt text handed to the executor transport. */
  sentPrompt: string;
  /** Isolated worker worktree the dispatched prompt's paths were rewritten to. */
  worktreeRoot: string;
  /** Captured base commit the isolated worktree was created from (target checkout captured this base). */
  baseCommit: string;
  /** Executor turn this prompt was sent for (1 for the initial dispatch). */
  executorTurn: number;
  /** Adapter that delivered the prompt, when known at the boundary. */
  adapter?: string;
  /** Model reported by the adapter that delivered the prompt, when known. */
  model?: string;
}

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
  /** Pool entry actually serving this update (tracks failovers). */
  executorEntryId?: string;
  /** Authoritative selection of the executor actually serving this update. */
  executorSelection?: ExecutorSelection;
  /**
   * Actual dispatch data captured at the executor transport boundary
   * (#93). Original SubtasksStart/SubtasksAdd tool cards consume this via the
   * existing dispatch event path; absent means not yet sent — no prompt,
   * worktree, or base is fabricated for queued tasks.
   */
  dispatch?: SubtaskDispatchRecord;
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
