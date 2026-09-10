/**
 * Native bounded evidence inspection for background subtasks (#33).
 *
 * Thin controller-facing facade over the `./evidence` modules:
 * - `evidence/types.ts`      shared types and budgets
 * - `evidence/artifacts.ts`  confined, bounded artifact reading
 * - `evidence/parsers.ts`    per-adapter record parsers (privacy-filtered)
 * - `evidence/sources.ts`    source discovery, indexing, snapshot assembly
 * - `evidence/review-cycles.ts` durable review cycle records/markers (#50)
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
import { assembleSnapshot, discoverAndIndexSources, readConfinedOperationRecord, resolveArtifactRoot } from "./evidence/sources";
import { annotateReviewCycleStatus, buildReviewSource, durableReviewSummary, latestDurableReviewSequence, unpublishedReviewCycles } from "./evidence/review-cycles";

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
        // Per-turn adapter provenance (#69): turns whose own process-result.json
        // did not record an adapter are resolved from the durable operation
        // record's canonical per-turn evidence (the attempt that ran the turn
        // and the assignment that served it) — never from the record's current
        // adapter field alone, which later reassignments overwrite.
        sources = await discoverAndIndexSources(input.taskId, artifactRoot, unavailable, rawBudget, input.operation);
      } catch (error) {
        if (error instanceof EvidenceRefusalError) throw error; // fail closed on confinement violations
        unavailable.push({ reason: "unreadable", detail: `Evidence discovery failed: ${evidenceErrorMessage(error)}` });
      }
    }
  } else {
    unavailable.push({ reason: "artifact_dir_missing", detail: "The task has no artifact directory (no wave root recorded)." });
  }

  // Durable completed review cycles (#50) are the live source of truth for
  // reviewer evidence while a worker is still correcting: they exist from the
  // moment a cycle completes, before any final task result. Once a final
  // result exists, dedupe by review identity instead of blanket suppression:
  // durable persistence is best-effort, so the latest cycle's record can be
  // missing or unreadable while its official verdict settles into the report.
  // Index the settled report whenever it covers a review newer than every
  // usable durable cycle (or when no usable cycles exist at all — legacy runs,
  // GC'd artifacts); otherwise the durable cycles already represent the same
  // reviews and the report must not be counted twice.
  const report = input.result?.taskResults?.[0]?.reviewReport;
  const reviewSource = buildReviewSource(input.result, input.updatedAt, rawBudget);
  if (reviewSource) {
    const durableMaxSequence = latestDurableReviewSequence(sources);
    if (durableMaxSequence === undefined
      || (typeof report?.latestReviewSequence === "number" && report.latestReviewSequence > durableMaxSequence)) {
      sources = [...sources, reviewSource];
    }
  }
  annotateReviewCycleStatus(sources, report?.latestReviewSequence);

  // A review-filtered read must never be a silent empty success: when no
  // completed review evidence exists at all, say so explicitly.
  const hasReviewEvidence = sources.some((source) => source.records.some((record) => record.kind === "review"));
  if (!hasReviewEvidence) {
    unavailable.push({
      source: "reviews",
      reason: "review_unavailable",
      detail: unpublishedReviewCycles(sources).length > 0
        ? "No persisted review findings are available for this task: at least one completed cycle's record was not published (see its unavailable note) and no final review report exists yet."
        : "No completed review evidence is available for this task: no persisted review cycle records and no final review report. A review in flight appears when its cycle completes; a disabled or unreviewed run has none by design.",
    });
  }

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
      durableReview: durableReviewSummary(sources),
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
