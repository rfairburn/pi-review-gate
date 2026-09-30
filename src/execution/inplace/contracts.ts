import type { ChangedFile } from "../../capture";
import type { ExecutorSelection, ReviewGateConfig } from "../../config";
import type { ExecutorAdapter, ExecutorLiveControl, ExecutorSession, ExecutorTurn, SubtaskProgressUpdate } from "../types";
import type { ExecutorPoolAssignment } from "../executor-pool";
import type { ExecutionIncident, OperationDiagnostics } from "../operation-record";
import type { WaveWorkerTask } from "../wave-worker";
import type { ReviewRunOutput } from "../../review";
import type { SubtaskReviewReport } from "../../review-report";
import type { InPlaceBaseline } from "./basis";

export interface InPlaceRunInput {
  taskId: string;
  task: WaveWorkerTask;
  /** Launch-selected workspace root the worker runs and writes in. */
  workspaceRoot: string;
  /** Durable artifact directory for this task; must be OUTSIDE the workspace. */
  artifactDir: string;
  config: ReviewGateConfig;
  scopedModels?: string[];
  signal?: AbortSignal;
  onUpdate?: (update: SubtaskProgressUpdate) => void;
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
  /** Atomically claim steering that could not reach the completed live turn. */
  takeDeferredSteering?: () => Promise<Array<{ instruction: string; instructionId: string }>>;
  /** Capacity lease selected by the group scheduler. */
  executorAssignment?: ExecutorPoolAssignment;
  /** Acquire the next eligible configured executor after retry recovery is exhausted. */
  acquireFailover?: (current: ExecutorPoolAssignment) => Promise<ExecutorPoolAssignment | undefined>;
  /** Optional adapter factory for embedding/tests; normal dispatch uses the configured factory. */
  adapterFactory?: (config: ReviewGateConfig, selection: ExecutorSelection) => ExecutorAdapter;
}

export interface InPlaceWorkerResult {
  status: "completed" | "executor_error" | "timeout" | "cancelled";
  taskId: string;
  title: string;
  summary: string;
  session?: ExecutorSession;
  turn?: ExecutorTurn;
  adapter: string;
  model?: string;
  usage?: ExecutorTurn["usage"];
  error?: string;
  operationRecord: string;
  incidents: ExecutionIncident[];
  attempts: number;
  lastExecutorTurn?: number;
  effectiveAssignment?: ExecutorPoolAssignment;
  /** A failover route was attempted but had no successor lease; do not retry on the released assignment. */
  failoverExhausted?: boolean;
}

// ── lifecycle types ──────────────────────────────────────────────────────────

/** Status of a complete in-place worker lifecycle (#220). No landing states exist. */
export type InPlaceLifecycleStatus =
  | "reviewed"
  | "unreviewed"
  | "no_changes"
  | "review_error"
  | "correction_cap"
  | "executor_error"
  | "timeout"
  | "cancelled"
  | "reviewer_blocked";

/** One in-place review cycle; the recorded workspace delta is the reviewed identity. */
export interface InPlaceReviewCycle {
  cycle: number;
  /** External-path evidence revision reviewed in this cycle; not a content identity. */
  externalObservationRevision?: number;
  verdict: import("../../schema").ReviewResult["verdict"];
  reviewOutput: ReviewRunOutput;
  /** Workspace delta that was under review in this cycle. */
  changedSinceLaunch: ChangedFile[];
  /**
   * Content-anchored identity of the delta under review (#220 pass-1):
   * per-path launch/current content identities, not path names. A pass is
   * bound to THIS identity; any later content change re-enters review.
   */
  identity: string;
}

export interface InPlaceLifecycleResult {
  status: InPlaceLifecycleStatus;
  taskId: string;
  title: string;
  summary: string;
  adapter: string;
  model?: string;
  usage?: ExecutorTurn["usage"];
  error?: string;
  /** The workspace the worker ran and wrote in. */
  workspaceRoot: string;
  /** Launch-time attribution basis, retained for inspection and continuation flows. */
  baseline: InPlaceBaseline;
  /** Final recorded delta at lifecycle settlement. */
  changedSinceLaunch: Array<{ status: ChangedFile["status"]; path: string }>;
  /** Absolute tool-observed external path candidates, separate from the selected-root delta. */
  observedExternalPaths?: string[];
  /** Adapter/stream limitations; absence of an event is not evidence of no external action. */
  toolObservabilityNotes?: string[];
  toolObservationsTruncated?: boolean;
  /**
   * Set when the stop-time attribution could not be inspected against the
   * launch baseline: the workspace delta is then UNKNOWN, never zero, and
   * durable summaries/notices disclose the failure instead of claiming no
   * changes.
   */
  attributionError?: string;
  reviewCycles: InPlaceReviewCycle[];
  reviewReport?: SubtaskReviewReport;
  artifactDir: string;
  operationRecord: string;
  incidents?: ExecutionIncident[];
  attempts?: number;
  diagnostics?: OperationDiagnostics;
  lastExecutorTurn?: number;
  session?: ExecutorSession;
}

export interface InPlaceLifecycleInput extends InPlaceRunInput {
  /** Maximum correction cycles before settling. Defaults to config.maxCorrectionCycles. */
  maxCorrectionCycles?: number;
  /**
   * Pre-existing executor result: PRIOR-TURN CONTEXT ONLY (#220 pass-1). It
   * never satisfies a newly admitted continuation by itself — the requested
   * continuation is always dispatched; a non-completed prior result is
   * retained turn/session context, not this run's outcome.
   */
  initialResult?: InPlaceWorkerResult;
  /**
   * The verified launch-time attribution basis. A continuation must supply
   * the restored original basis; an omitted value means the lifecycle captures
   * and persists one (fresh dispatch or direct lifecycle use).
   */
  baseline?: InPlaceBaseline;
  /**
   * Authoritative continuation instructions for this dispatch (an admitted
   * in-place continuation, or a restored auto-resume). With a prior durable
   * result they resume the retained executor session before review; without
   * one they are folded into the initial dispatch prompt.
   */
  continuation?: { instructions: string };
}
