import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  MAX_CANDIDATE_SOURCES,
  MAX_OBSERVED_ABSOLUTE_PATH_LENGTH,
  MAX_OBSERVED_CONTENT_CHARS,
  MAX_OBSERVED_PATHS_PER_EVENT,
  MAX_OBSERVED_PATH_LENGTH,
  isBoundedEvidenceText,
  MAX_OBSERVED_TOOL_EVENTS,
  MAX_OBSERVABILITY_NOTES,
  MAX_REVIEW_EVIDENCE_NOTES,
  restoreEvidenceState,
  serializeEvidenceState,
  type EvidenceState,
  type PersistedEvidenceState,
} from "../evidence";
import { isRecord } from "../record-guard";
import { atomicWrite } from "./durable-write";

export const OBSERVED_TOOL_EVIDENCE_FILE = "observed-tool-evidence.json";

export async function persistObservedToolEvidence(state: EvidenceState, artifactDir: string): Promise<void> {
  await atomicWrite(
    join(artifactDir, OBSERVED_TOOL_EVIDENCE_FILE),
    `${JSON.stringify(serializeEvidenceState(state), null, 2)}\n`,
  );
}

export async function restoreObservedToolEvidence(
  state: EvidenceState,
  artifactDir: string,
  workspaceRoot: string,
  options: { required?: boolean } = {},
): Promise<void> {
  const path = join(artifactDir, OBSERVED_TOOL_EVIDENCE_FILE);
  try {
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    assertPersistedEvidenceState(value);
    const priorEventCount = state.events.length;
    const priorCandidateCount = state.candidates.size;
    const priorSummaryCount = state.finalAssistantSummaries.length;
    const priorQuestionCount = state.acceptedReviewerQuestions.length;
    const priorNoteCount = state.toolObservabilityNotes?.length ?? 0;
    const priorReviewNoteCount = state.reviewEvidenceNotes?.length ?? 0;
    restoreEvidenceState(state, value, workspaceRoot);
    if (state.events.length - priorEventCount !== value.events.length
      || state.candidates.size - priorCandidateCount !== value.candidates.length
      || state.finalAssistantSummaries.length - priorSummaryCount !== value.finalAssistantSummaries.length
      || state.acceptedReviewerQuestions.length - priorQuestionCount !== value.acceptedReviewerQuestions.length
      || (state.toolObservabilityNotes?.length ?? 0) - priorNoteCount !== value.toolObservabilityNotes.length
      || (state.reviewEvidenceNotes?.length ?? 0) - priorReviewNoteCount !== (value.reviewEvidenceNotes?.length ?? 0)) {
      throw new Error("Persisted tool evidence contains malformed or out-of-scope entries.");
    }
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (missing && !options.required) return;
    const message = missing
      ? `Persisted tool evidence ${path} is missing; prior tool observations cannot be verified.`
      : `Persisted tool evidence could not be restored: ${error instanceof Error ? error.message : String(error)}`;
    throw new Error(message, { cause: error });
  }
}

function assertPersistedEvidenceState(value: unknown): asserts value is PersistedEvidenceState {
  const invalid = (): never => { throw new Error("Persisted tool evidence has an invalid format."); };
  const safeInteger = (candidate: unknown, minimum: number): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= minimum;
  const strings = (candidate: unknown, maximumCount: number, maximumLength: number): candidate is string[] =>
    Array.isArray(candidate) && candidate.length <= maximumCount
      && candidate.every((item) => isBoundedEvidenceText(item, maximumLength));
  if (!isRecord(value)
    || value.version !== 1
    || !safeInteger(value.nextSequence, 1)
    || !Array.isArray(value.events)
    || value.events.length > MAX_OBSERVED_TOOL_EVENTS
    || !Array.isArray(value.candidates)
    || value.candidates.length > MAX_OBSERVED_TOOL_EVENTS / 2
    || !strings(value.finalAssistantSummaries, 10, 4000)
    || !Array.isArray(value.acceptedReviewerQuestions)
    || value.acceptedReviewerQuestions.length > 20
    || !strings(value.toolObservabilityNotes, MAX_OBSERVABILITY_NOTES, 1000)
    || (value.reviewEvidenceNotes !== undefined && !strings(value.reviewEvidenceNotes, MAX_REVIEW_EVIDENCE_NOTES, 1000))
    || (value.reviewEvidenceNotesTruncated !== undefined && typeof value.reviewEvidenceNotesTruncated !== "boolean")
    || typeof value.toolObservationsTruncated !== "boolean"
    || typeof value.requiresReview !== "boolean"
    || (value.externalObservationRevision !== undefined && !safeInteger(value.externalObservationRevision, 0))
    || (value.toolObservationRevision !== undefined && !safeInteger(value.toolObservationRevision, 0))) invalid();

  const persisted = value as PersistedEvidenceState;
  let previousSequence = 0;
  for (const event of persisted.events) {
    if (!isRecord(event)
      || !safeInteger(event.sequence, 1)
      || event.sequence <= previousSequence
      || event.sequence >= persisted.nextSequence
      || (event.exchangeSequence !== undefined && !safeInteger(event.exchangeSequence, 1))
      || (event.phase !== "tool_call" && event.phase !== "tool_result")
      || !isBoundedEvidenceText(event.toolName, 200)
      || (event.adapter !== undefined && !isBoundedEvidenceText(event.adapter, 100))
      || (event.observationId !== undefined && !isBoundedEvidenceText(event.observationId, 200))
      || !isBoundedEvidenceText(event.summary, 1000)
      || (event.detail !== undefined && !isBoundedEvidenceText(event.detail, 50_000))
      || !strings(event.candidatePaths, MAX_OBSERVED_PATHS_PER_EVENT, MAX_OBSERVED_PATH_LENGTH)
      || !strings(event.riskSignals, 100, 200)
      || (event.isError !== undefined && typeof event.isError !== "boolean")) invalid();
    previousSequence = event.sequence;
  }

  const candidatePaths = new Set<string>();
  for (const candidate of persisted.candidates) {
    // Version-1 InPlace checkpoints may mark externalSideEffect without the
    // newer toolObserved field; restoreEvidenceState normalizes that legacy form.
    if (!isRecord(candidate)
      || (candidate.toolObserved !== undefined && candidate.toolObserved !== true)
      || (candidate.externalSideEffect !== undefined && candidate.externalSideEffect !== true)
      || (candidate.toolObserved !== true && candidate.externalSideEffect !== true)
      || (candidate.prestateUnverified !== undefined && typeof candidate.prestateUnverified !== "boolean")
      || !isBoundedEvidenceText(candidate.path, MAX_OBSERVED_PATH_LENGTH)
      || typeof candidate.absolutePath !== "string" || candidate.absolutePath.length > MAX_OBSERVED_ABSOLUTE_PATH_LENGTH
      || !isAbsolute(candidate.absolutePath)
      || !strings(candidate.sources, MAX_CANDIDATE_SOURCES, 300)
      || (candidate.baseline !== undefined && !isPersistedFileSnapshot(candidate.baseline))
      || (candidate.baselineError !== undefined && !isBoundedEvidenceText(candidate.baselineError, 500))
      || (candidate.afterContentTruncated !== undefined && typeof candidate.afterContentTruncated !== "boolean")
      || (candidate.afterError !== undefined && !isBoundedEvidenceText(candidate.afterError, 500))) invalid();
    if (candidatePaths.has(candidate.absolutePath)) invalid();
    candidatePaths.add(candidate.absolutePath);
    if (candidate.afterSnapshot !== undefined
      && (!isPersistedFileSnapshot(candidate.afterSnapshot) || candidate.afterSnapshot.absolutePath !== candidate.absolutePath)) invalid();
  }
  for (const question of persisted.acceptedReviewerQuestions) {
    if (!isRecord(question)
      || !safeInteger(question.sequence, 1)
      || !isBoundedEvidenceText(question.question, 20_000)
      || !isBoundedEvidenceText(question.acceptedAnswer, 20_000)
      || !isBoundedEvidenceText(question.acceptedAt, 100)) invalid();
  }
}

function isPersistedFileSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.relativePath === "string" && value.relativePath.length <= MAX_OBSERVED_ABSOLUTE_PATH_LENGTH * 2
    && typeof value.absolutePath === "string" && value.absolutePath.length <= MAX_OBSERVED_ABSOLUTE_PATH_LENGTH
    && isAbsolute(value.absolutePath)
    && typeof value.exists === "boolean"
    && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
    && typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs)
    && (value.sha256 === null || (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.sha256)))
    && typeof value.isBinary === "boolean"
    && (value.content === undefined || isBoundedEvidenceText(value.content, MAX_OBSERVED_CONTENT_CHARS))
    && (value.linkTarget === undefined || isBoundedEvidenceText(value.linkTarget, MAX_OBSERVED_CONTENT_CHARS))
    && (value.omittedReason === undefined || ["binary", "oversized", "snapshot_limit", "outside_workspace", "missing", "unreadable"].includes(String(value.omittedReason)))
    && (value.entryType === undefined || ["file", "symlink", "gitlink"].includes(String(value.entryType)));
}
