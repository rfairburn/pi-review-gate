/**
 * Native bounded evidence inspection for background subtasks (#33).
 *
 * Thin controller-facing facade over the `./evidence` modules:
 * - `evidence/types.ts`      shared types and budgets
 * - `evidence/artifacts.ts`  confined, bounded artifact reading
 * - `evidence/parsers.ts`    per-adapter record parsers (privacy-filtered)
 * - `evidence/sources.ts`    source discovery, indexing, snapshot assembly
 * - `evidence/cursor.ts`     stable cursor codec and watermark semantics
 * - `evidence/context.ts`    authoritative supervisory context
 * - `evidence/navigation.ts` find / range / call / entry / cursor reads
 *
 * Replaces ad-hoc transcript parsing with indexed, read-only evidence
 * navigation. Legacy activity offset/lines behavior is untouched; this module
 * only adds the optional `evidence` navigation surface to SubtasksInspect.
 */
import type { ExecutorSelection } from "../config";
import type { OperationRecord } from "./operation-record";
import type { WaveResult } from "./wave-controller";
import type { BackgroundCommandRecord, BackgroundTaskState } from "./task-state";
import { EvidenceRefusalError, evidenceErrorMessage } from "./evidence/artifacts";
import { buildSubtaskEvidenceContext } from "./evidence/context";
import { readSubtaskEvidence as navigateEvidence } from "./evidence/navigation";
import { assembleSnapshot, buildReviewSource, discoverAndIndexSources, readConfinedOperationRecord, resolveArtifactRoot } from "./evidence/sources";

export { readConfinedOperationRecord };
import { EVIDENCE_RAW_SNAPSHOT_BUDGET_BYTES, type IndexedSource, type RawRetentionBudget, type SubtaskEvidenceBundle, type SubtaskEvidenceRead, type SubtaskEvidenceSelector, type SubtaskEvidenceUnavailable } from "./evidence/types";

export interface SubtaskEvidenceBuildInput {
  taskId: string;
  /** Derived from the durable task record (waveRoot + taskId); never caller-supplied. */
  artifactDir?: string;
  /** Wave root used to confine every read under the owned artifact tree. */
  waveRoot?: string;
  operation?: OperationRecord;
  /** Explicit unavailability notes for optional context sources (e.g. a refused operation record). */
  contextUnavailable?: SubtaskEvidenceUnavailable[];
  result?: WaveResult;
  state?: BackgroundTaskState;
  commands?: BackgroundCommandRecord[];
  executorSelection?: ExecutorSelection;
  updatedAt?: string;
  /** Live isolated worktree, when it still exists (untracked enumeration). */
  worktreeRoot?: string;
}

/** Builds the bounded evidence snapshot and authoritative context for one task. */
export async function buildSubtaskEvidence(input: SubtaskEvidenceBuildInput): Promise<SubtaskEvidenceBundle> {
  const unavailable: SubtaskEvidenceUnavailable[] = [...(input.contextUnavailable ?? [])];
  let sources: IndexedSource[] = [];
  // Shared pre-redaction raw retention budget enforced during discovery so total
  // retained memory stays bounded across every source, not just per entry.
  const rawBudget: RawRetentionBudget = { remainingBytes: EVIDENCE_RAW_SNAPSHOT_BUDGET_BYTES, exhausted: false };

  if (input.artifactDir) {
    const artifactRoot = await resolveArtifactRoot(input.waveRoot, input.artifactDir, unavailable);
    if (artifactRoot) {
      try {
        sources = await discoverAndIndexSources(artifactRoot, unavailable, rawBudget);
      } catch (error) {
        if (error instanceof EvidenceRefusalError) throw error; // fail closed on confinement violations
        unavailable.push({ reason: "unreadable", detail: `Evidence discovery failed: ${evidenceErrorMessage(error)}` });
      }
    }
  } else {
    unavailable.push({ reason: "artifact_dir_missing", detail: "The task has no artifact directory (no wave root recorded)." });
  }

  const reviewSource = buildReviewSource(input.result, input.updatedAt, rawBudget);
  if (reviewSource) sources = [...sources, reviewSource];

  const snapshot = assembleSnapshot(input.taskId, sources, unavailable, rawBudget);
  const context = await buildSubtaskEvidenceContext(
    {
      taskId: input.taskId,
      state: input.state,
      operation: input.operation,
      result: input.result,
      commands: input.commands,
      executorSelection: input.executorSelection,
      worktreeRoot: input.worktreeRoot,
      waveRoot: input.waveRoot,
    },
    snapshot,
  );
  return { snapshot, context };
}

/** Executes one bounded evidence read (see evidence/navigation.ts). */
export function readSubtaskEvidence(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  return navigateEvidence(bundle, selector);
}

export { EvidenceCursorError } from "./evidence/cursor";
export { EvidenceNavigationError } from "./evidence/navigation";
export {
  EVIDENCE_COMMAND_TOOL_NAMES,
  EVIDENCE_DEEP_CHUNK_CHARS,
  EVIDENCE_FILTERS,
  EVIDENCE_FIND_MATCHES_MAX,
  EVIDENCE_LIMIT_DEFAULT,
  EVIDENCE_LIMIT_MAX,
} from "./evidence/types";
export type {
  IndexedSource,
  RawEvidenceRecord,
  SubtaskEvidenceAssignmentRecord,
  SubtaskEvidenceAttemptRecord,
  SubtaskEvidenceBundle,
  SubtaskEvidenceCapability,
  SubtaskEvidenceChangedFiles,
  SubtaskEvidenceCommandRecord,
  SubtaskEvidenceContext,
  SubtaskEvidenceCurrentCommand,
  SubtaskEvidenceDiagnostics,
  SubtaskEvidenceEntryView,
  SubtaskEvidenceFilter,
  SubtaskEvidenceKind,
  SubtaskEvidenceProvenance,
  SubtaskEvidenceRead,
  SubtaskEvidenceReviewSummary,
  SubtaskEvidenceSelector,
  SubtaskEvidenceSnapshot,
  SubtaskEvidenceSourceRef,
  SubtaskEvidenceSourceSummary,
  SubtaskEvidenceStatus,
  SubtaskEvidenceStream,
  SubtaskEvidenceUnavailable,
} from "./evidence/types";
