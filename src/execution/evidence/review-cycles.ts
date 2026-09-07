/**
 * Durable completed review cycle evidence (#50).
 *
 * Review-specific parsing, discovery helpers, and freshness/status semantics
 * for the per-cycle records the gate publishes at
 * `reviews/<waveId>/cycle-NNNN.json` when each cycle completes, plus the
 * publication-failure markers (`cycle-NNNN.json.unpublished`) it leaves when
 * that write fails. Freshness is never inferred from the absence of a newer
 * file: a completed cycle whose record was not published is reported through
 * its authoritative marker (or an explicit unavailable note), and earlier
 * readable cycles are superseded or qualified accordingly instead of being
 * asserted current. The official verdict stays visible, and a failed optional
 * evidence write never becomes a review bypass or an invented verdict.
 */
import { join } from "node:path";
import type { WaveResult } from "../wave-controller";
import { EvidenceRefusalError, capped, evidenceErrorMessage, finalizeSource, omittedNote, resolveReadableArtifact, sha256HexOf } from "./artifacts";
import { readBoundedTextFile } from "../../bounded-file";
import { compactJson } from "./parsers";
import { EVIDENCE_REVIEW_RECORD_BYTES, type IndexedSource, type RawEvidenceRecord, type RawRetentionBudget, type SubtaskEvidenceUnavailable } from "./types";

const REVIEW_AGGREGATES = new Set(["pass", "pass_with_warnings", "needs_changes", "error"]);

/** File name of one durable review cycle record under reviews/<waveId>/. */
export const REVIEW_CYCLE_RECORD_NAME = /^cycle-\d{6}\.json$/;
/** File name of a publication-failure marker for one completed cycle. */
export const REVIEW_CYCLE_MARKER_NAME = /^cycle-\d{6}\.json\.unpublished$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural validation and ownership check for one durable review cycle
 * record. Returns the record only when it is a valid v1 record that belongs
 * to this task AND whose wave identity matches the directory it was found
 * in; anything else is refused, never guessed at.
 */
function validateReviewCycleRecord(
  value: unknown,
  taskId: string,
  waveName: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.taskId !== "string" || value.taskId !== taskId) return undefined;
  if (typeof value.waveId !== "string" || value.waveId !== waveName) return undefined;
  if (!Number.isInteger(value.cycle) || (value.cycle as number) < 1) return undefined;
  if (!Number.isInteger(value.reviewSequence) || (value.reviewSequence as number) < 1) return undefined;
  if (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt))) return undefined;
  const candidate = value.candidate;
  if (!isRecord(candidate)
    || typeof candidate.commitSha !== "string"
    || typeof candidate.treeSha !== "string"
    || typeof candidate.ref !== "string") return undefined;
  if (typeof value.aggregate !== "string" || !REVIEW_AGGREGATES.has(value.aggregate)) return undefined;
  if (typeof value.summary !== "string") return undefined;
  if (!Array.isArray(value.reviewers) || value.reviewers.length === 0) return undefined;
  for (const reviewer of value.reviewers) {
    if (!isRecord(reviewer)
      || typeof reviewer.reviewerId !== "string"
      || typeof reviewer.verdict !== "string"
      || typeof reviewer.summary !== "string") return undefined;
    if (reviewer.guidance !== undefined && typeof reviewer.guidance !== "string") return undefined;
    if (!Array.isArray(reviewer.findings)) return undefined;
    for (const finding of reviewer.findings) {
      if (!isRecord(finding)
        || typeof finding.severity !== "string"
        || (finding.file !== null && typeof finding.file !== "string")
        || (finding.line !== null && !(typeof finding.line === "number" && Number.isInteger(finding.line)))
        || typeof finding.issue !== "string"
        || typeof finding.recommendation !== "string") return undefined;
    }
  }
  return value;
}

/** Indexes one durable review cycle record (reviews/<waveId>/cycle-NNNN.json). */
export async function indexReviewCycleSource(
  artifactRoot: string,
  waveName: string,
  cycleName: string,
  taskId: string,
  budget: RawRetentionBudget,
): Promise<IndexedSource> {
  const rel = join("reviews", waveName, cycleName);
  const sourceId = `review:${waveName}:${cycleName.replace(/\.json$/, "")}`;
  const unavailable: SubtaskEvidenceUnavailable[] = [];
  const records: RawEvidenceRecord[] = [];
  const digests = new Map<string, string>();
  let omitted = 0;

  const retain = (recordKey: string, kind: "review" | "lifecycle", at: string, content: string): void => {
    const bounded = capped(content);
    const bytes = Buffer.byteLength(bounded.content, "utf8");
    if (budget.exhausted || budget.remainingBytes < bytes) {
      budget.exhausted = true;
      omitted += 1;
      return;
    }
    budget.remainingBytes -= bytes;
    records.push({ recordKey, kind, provenance: "reviewer_verdict", at, ...bounded });
    digests.set(recordKey, sha256HexOf(content));
  };

  const base = {
    sourceId,
    adapter: "record" as const,
    stream: "artifact" as const,
    file: rel,
    unavailable,
  };

  let real: string | undefined;
  try {
    real = await resolveReadableArtifact(artifactRoot, join(artifactRoot, rel));
  } catch (error) {
    if (error instanceof EvidenceRefusalError) {
      unavailable.push({ source: rel, reason: error.reason, detail: evidenceErrorMessage(error) });
      return finalizeSource({ ...base, orderKey: "9999-12-31T23:59:59.999Z", records, digests, stats: { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0 } });
    }
    throw error;
  }
  if (!real) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle record ${rel} disappeared or is unreadable.` });
    return finalizeSource({ ...base, orderKey: "9999-12-31T23:59:59.999Z", records, digests, stats: { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0 } });
  }

  const { text, truncated } = await readBoundedTextFile(real, EVIDENCE_REVIEW_RECORD_BYTES);
  if (truncated) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle record ${rel} exceeds the ${EVIDENCE_REVIEW_RECORD_BYTES}-byte bounded review record size; it was not indexed.` });
    return finalizeSource({ ...base, orderKey: "9999-12-31T23:59:59.999Z", records, digests, stats: { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0 } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle record ${rel} is not valid JSON; it was not indexed.` });
    return finalizeSource({ ...base, orderKey: "9999-12-31T23:59:59.999Z", records, digests, stats: { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0 } });
  }
  const owner = isRecord(parsed) && typeof parsed.taskId === "string" ? parsed.taskId : undefined;
  if (owner !== undefined && owner !== taskId) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle record ${rel} belongs to task "${owner}", not "${taskId}"; it was not indexed.` });
    return finalizeSource({ ...base, orderKey: "9999-12-31T23:59:59.999Z", records, digests, stats: { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0 } });
  }
  const record = validateReviewCycleRecord(parsed, taskId, waveName);
  if (!record) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle record ${rel} is not a valid v1 review cycle record owned by task "${taskId}"; it was not indexed.` });
    return finalizeSource({ ...base, orderKey: "9999-12-31T23:59:59.999Z", records, digests, stats: { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0 } });
  }

  const at = record.completedAt as string;
  const candidate = record.candidate as Record<string, unknown>;
  retain("cycle", "lifecycle", at, compactJson({
    source: "official_review",
    cycle: record.cycle,
    waveId: record.waveId,
    reviewSequence: record.reviewSequence,
    aggregate: record.aggregate,
    summary: record.summary,
    completedAt: at,
    candidateRef: candidate.ref,
    candidateCommit: candidate.commitSha,
  }));
  for (const reviewer of record.reviewers as Array<Record<string, unknown>>) {
    const findings = (reviewer.findings as Array<Record<string, unknown>>).map((finding, index) => ({
      id: `F${index + 1}`,
      severity: finding.severity,
      file: finding.file ?? null,
      line: finding.line ?? null,
      issue: finding.issue,
      recommendation: finding.recommendation,
    }));
    retain(`reviewer:${reviewer.reviewerId}`, "review", at, compactJson({
      source: "official_review",
      cycle: record.cycle,
      waveId: record.waveId,
      reviewSequence: record.reviewSequence,
      candidateRef: candidate.ref,
      candidateCommit: candidate.commitSha,
      aggregate: record.aggregate,
      reviewer: {
        id: reviewer.reviewerId,
        ...(typeof reviewer.displayLabel === "string" ? { label: reviewer.displayLabel } : {}),
        verdict: reviewer.verdict,
      },
      summary: reviewer.summary,
      ...(typeof reviewer.guidance === "string" ? { guidance: reviewer.guidance } : {}),
      ...(reviewer.verdict === "error" && typeof reviewer.error === "string" ? { error: reviewer.error } : {}),
      findings,
    }));
  }

  for (const item of omittedNote(sourceId, omitted)) unavailable.push(item);
  return finalizeSource({ ...base, orderKey: at, records, digests, stats: { recordsScanned: records.length, oversizedRecords: 0, skippedRecords: 0 } });
}

// ---------------------------------------------------------------------------
// Publication-failure markers (cycle-NNNN.json.unpublished)
// ---------------------------------------------------------------------------

/**
 * Structural validation and ownership check for one publication-failure
 * marker. The marker is written by the gate itself when a completed cycle's
 * record could not be published, so it carries authoritative lifecycle
 * metadata: which cycle completed, its official gate verdict, and why the
 * record is missing. Anything that does not validate is refused, never
 * guessed at.
 */
function validateReviewCycleUnpublishedMarker(
  value: unknown,
  taskId: string,
  waveName: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.taskId !== "string" || value.taskId !== taskId) return undefined;
  if (typeof value.waveId !== "string" || value.waveId !== waveName) return undefined;
  if (!Number.isInteger(value.cycle) || (value.cycle as number) < 1) return undefined;
  if (!Number.isInteger(value.reviewSequence) || (value.reviewSequence as number) < 1) return undefined;
  if (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt))) return undefined;
  if (typeof value.aggregate !== "string" || !REVIEW_AGGREGATES.has(value.aggregate)) return undefined;
  if (typeof value.summary !== "string") return undefined;
  return value;
}

/**
 * Indexes one publication-failure marker
 * (reviews/<waveId>/cycle-NNNN.json.unpublished): explicit evidence that the
 * named cycle completed without a persisted record. It contributes an
 * unavailable note and one bounded lifecycle entry carrying the official gate
 * verdict — never per-reviewer findings, which exist only in the missing
 * record.
 */
export async function indexReviewCycleUnpublishedSource(
  artifactRoot: string,
  waveName: string,
  markerName: string,
  taskId: string,
  budget: RawRetentionBudget,
): Promise<IndexedSource> {
  const rel = join("reviews", waveName, markerName);
  const sourceId = `review:${waveName}:${markerName.replace(/\.json\.unpublished$/, "")}-unpublished`;
  const unavailable: SubtaskEvidenceUnavailable[] = [];
  const records: RawEvidenceRecord[] = [];
  const digests = new Map<string, string>();
  let omitted = 0;

  const retain = (recordKey: string, kind: "review" | "lifecycle", at: string, content: string): void => {
    const bounded = capped(content);
    const bytes = Buffer.byteLength(bounded.content, "utf8");
    if (budget.exhausted || budget.remainingBytes < bytes) {
      budget.exhausted = true;
      omitted += 1;
      return;
    }
    budget.remainingBytes -= bytes;
    records.push({ recordKey, kind, provenance: "reviewer_verdict", at, ...bounded });
    digests.set(recordKey, sha256HexOf(content));
  };

  const base = {
    sourceId,
    adapter: "record" as const,
    stream: "artifact" as const,
    file: rel,
    unavailable,
  };
  const emptySource = (): IndexedSource => finalizeSource({ ...base, orderKey: "9999-12-31T23:59:59.999Z", records, digests, stats: { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0 } });

  let real: string | undefined;
  try {
    real = await resolveReadableArtifact(artifactRoot, join(artifactRoot, rel));
  } catch (error) {
    if (error instanceof EvidenceRefusalError) {
      unavailable.push({ source: rel, reason: error.reason, detail: evidenceErrorMessage(error) });
      return emptySource();
    }
    throw error;
  }
  if (!real) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle publication-failure marker ${rel} disappeared or is unreadable.` });
    return emptySource();
  }

  const { text, truncated } = await readBoundedTextFile(real, EVIDENCE_REVIEW_RECORD_BYTES);
  if (truncated) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle publication-failure marker ${rel} exceeds the ${EVIDENCE_REVIEW_RECORD_BYTES}-byte bounded review record size; it was not indexed.` });
    return emptySource();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle publication-failure marker ${rel} is not valid JSON; it was not indexed.` });
    return emptySource();
  }
  const owner = isRecord(parsed) && typeof parsed.taskId === "string" ? parsed.taskId : undefined;
  if (owner !== undefined && owner !== taskId) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle publication-failure marker ${rel} belongs to task "${owner}", not "${taskId}"; it was not indexed.` });
    return emptySource();
  }
  const marker = validateReviewCycleUnpublishedMarker(parsed, taskId, waveName);
  if (!marker) {
    unavailable.push({ source: rel, reason: "unreadable", detail: `Review cycle publication-failure marker ${rel} is not a valid v1 marker owned by task "${taskId}"; it was not indexed.` });
    return emptySource();
  }

  const at = marker.completedAt as string;
  unavailable.push({
    source: rel,
    reason: "unpublished",
    detail: `Review cycle ${String(marker.cycle)} (wave ${waveName}) completed but its durable record was never published; no findings are available for this cycle.`,
  });
  retain("unpublished", "lifecycle", at, compactJson({
    source: "official_review",
    cycle: marker.cycle,
    waveId: marker.waveId,
    reviewSequence: marker.reviewSequence,
    aggregate: marker.aggregate,
    summary: marker.summary,
    completedAt: at,
    published: false,
    ...(typeof marker.reason === "string" ? { reason: marker.reason } : {}),
  }));

  for (const item of omittedNote(sourceId, omitted)) unavailable.push(item);
  return finalizeSource({ ...base, orderKey: at, records, digests, stats: { recordsScanned: records.length, oversizedRecords: 0, skippedRecords: 0 } });
}

// ---------------------------------------------------------------------------
// Cycle identity, freshness, and status semantics
// ---------------------------------------------------------------------------

/** Parsed identity of a durable review cycle source (from its "cycle" record). */
export interface DurableReviewCycleMeta {
  sourceId: string;
  waveId: string;
  cycle: number;
  reviewSequence: number;
  aggregate: string;
  summary: string;
  completedAt: string;
}

function cycleMetaOf(source: IndexedSource): Omit<DurableReviewCycleMeta, "sourceId"> | undefined {
  const record = source.records.find((candidate) => candidate.recordKey === "cycle");
  if (!record) return undefined;
  try {
    const parsed: unknown = JSON.parse(record.content);
    if (!isRecord(parsed)
      || !Number.isInteger(parsed.cycle)
      || typeof parsed.waveId !== "string"
      || !Number.isInteger(parsed.reviewSequence)
      || typeof parsed.aggregate !== "string"
      || typeof parsed.summary !== "string"
      || typeof parsed.completedAt !== "string") return undefined;
    return {
      waveId: parsed.waveId,
      cycle: parsed.cycle as number,
      reviewSequence: parsed.reviewSequence as number,
      aggregate: parsed.aggregate,
      summary: parsed.summary,
      completedAt: parsed.completedAt,
    };
  } catch {
    return undefined;
  }
}

/** Authoritative identity of a cycle that completed without a persisted record. */
export interface UnpublishedReviewCycleMeta {
  waveId: string;
  cycle: number;
  reviewSequence: number;
  aggregate: string;
  summary: string;
  completedAt: string;
}

function unpublishedMetaOf(source: IndexedSource): UnpublishedReviewCycleMeta | undefined {
  const record = source.records.find((candidate) => candidate.recordKey === "unpublished");
  if (!record) return undefined;
  try {
    const parsed: unknown = JSON.parse(record.content);
    if (!isRecord(parsed)
      || !Number.isInteger(parsed.cycle)
      || typeof parsed.waveId !== "string"
      || !Number.isInteger(parsed.reviewSequence)
      || typeof parsed.aggregate !== "string"
      || typeof parsed.summary !== "string"
      || typeof parsed.completedAt !== "string") return undefined;
    return {
      waveId: parsed.waveId,
      cycle: parsed.cycle as number,
      reviewSequence: parsed.reviewSequence as number,
      aggregate: parsed.aggregate,
      summary: parsed.summary,
      completedAt: parsed.completedAt,
    };
  } catch {
    return undefined;
  }
}

/** Every completed-but-unpublished cycle with a validated authoritative marker. */
export function unpublishedReviewCycles(sources: IndexedSource[]): UnpublishedReviewCycleMeta[] {
  const out: UnpublishedReviewCycleMeta[] = [];
  for (const source of sources) {
    if (!source.sourceId.startsWith("review:")) continue;
    const meta = unpublishedMetaOf(source);
    if (meta) out.push(meta);
  }
  return out;
}

/**
 * The most recently completed durable review cycle among sources that parsed
 * successfully. Sources whose records failed validation (and therefore carry
 * their own unavailable notes, and a max-date order key) never count as the
 * current cycle — including publication-failure markers, which prove a cycle
 * completed but carry no readable record.
 */
function latestDurableCycle(sources: IndexedSource[]): { source: IndexedSource; meta: Omit<DurableReviewCycleMeta, "sourceId"> } | undefined {
  const withMeta = sources
    .filter((source) => source.sourceId.startsWith("review:"))
    .map((source) => ({ source, meta: cycleMetaOf(source) }))
    .filter((entry): entry is { source: IndexedSource; meta: Omit<DurableReviewCycleMeta, "sourceId"> } => entry.meta !== undefined);
  if (withMeta.length === 0) return undefined;
  const latest = [...withMeta].sort((a, b) => a.source.orderKey === b.source.orderKey
    ? a.source.sourceId.localeCompare(b.source.sourceId)
    : a.source.orderKey < b.source.orderKey ? 1 : -1)[0]!;
  return { source: latest.source, meta: latest.meta };
}

/** The highest review sequence among usable durable cycles (identity for dedupe). */
export function latestDurableReviewSequence(sources: IndexedSource[]): number | undefined {
  let max: number | undefined;
  for (const source of sources) {
    if (!source.sourceId.startsWith("review:") || source.records.length === 0) continue;
    const meta = cycleMetaOf(source);
    if (!meta) continue;
    max = Math.max(max ?? meta.reviewSequence, meta.reviewSequence);
  }
  return max;
}

/** True when a review cycle source exists but has no usable record (unreadable file or marker). */
function hasUnusableReviewCycle(sources: IndexedSource[]): boolean {
  return sources.some((source) => source.sourceId.startsWith("review:") && cycleMetaOf(source) === undefined);
}

/**
 * Marks each durable review cycle source's relationship to its siblings (#50).
 * Freshness is only ever established by authoritative metadata — a settled
 * final report supersedes every cycle, and an explicit marker identifies a
 * later completed-but-unpublished cycle. The absence of a newer file is never
 * treated as proof: while no report has settled, the newest readable cycle is
 * at most "the latest available review evidence" with unknown completeness,
 * because a later cycle's record and its failure marker can both fail to
 * publish (shared faults such as ENOSPC). A later unusable sibling — an
 * unreadable or refused record, or a publication-failure marker — supersedes
 * earlier readable cycles explicitly. Every other earlier cycle is marked
 * superseded so a historical blocker is never presented as the current
 * verdict. Adds one bounded lifecycle record per usable cycle source.
 */
export function annotateReviewCycleStatus(sources: IndexedSource[], reportSequence?: number): void {
  const reviewSources = sources.filter((source) => source.sourceId.startsWith("review:"));
  if (reviewSources.length === 0) return;
  const latest = latestDurableCycle(sources);
  // The settled report is only indexed when it covers a review newer than every
  // usable durable cycle, so its presence supersedes all of them.
  const reportSupersedes = sources.some((source) => source.sourceId === "report:result.json");
  const unusableSibling = hasUnusableReviewCycle(sources);
  for (const source of reviewSources) {
    const meta = cycleMetaOf(source);
    if (!meta) continue; // unparseable source already carries its own note
    let content: string;
    if (reportSupersedes) {
      content = `Review cycle ${meta.cycle} (wave ${meta.waveId}) was superseded by the final review report${reportSequence !== undefined ? ` (review sequence ${reportSequence})` : ""}; its findings are historical and no longer the current verdict.`;
    } else if (source === latest?.source && !unusableSibling) {
      // No sibling proves a later cycle — but absence of a newer file is not
      // proof of freshness: a later cycle's record and its failure marker can
      // both fail to publish. Qualify as latest available, never current.
      content = `Review cycle ${meta.cycle} (wave ${meta.waveId}) is the most recently completed review with a persisted record; it is the latest available review evidence, but its completeness cannot be confirmed because a later cycle's record could have failed to publish without leaving a trace.`;
    } else if (source === latest?.source) {
      const laterUnpublished = unpublishedReviewCycles(sources).find((u) => u.waveId === meta.waveId && u.cycle > meta.cycle);
      content = laterUnpublished !== undefined
        ? `Review cycle ${meta.cycle} (wave ${meta.waveId}) was superseded by review cycle ${laterUnpublished.cycle} (wave ${laterUnpublished.waveId}), which completed without a persisted record (see unavailable notes); its findings are historical and no longer the current review state.`
        : `Review cycle ${meta.cycle} (wave ${meta.waveId}) is the most recently completed readable review, but at least one other review cycle record could not be read or was not published (see unavailable notes); it cannot be confirmed to be the current review state.`;
    } else {
      content = `Review cycle ${meta.cycle} (wave ${meta.waveId}) was superseded by review cycle ${latest?.meta.cycle ?? "a later"} (wave ${latest?.meta.waveId ?? "unknown"}); its findings are historical and no longer the current verdict.`;
    }
    source.records.push({ recordKey: "status", kind: "lifecycle", provenance: "reviewer_verdict", at: source.orderKey, content });
    source.digests.set("status", sha256HexOf(content));
  }
}

/**
 * Summarizes the latest durable review cycle for the authoritative context
 * (#50), so completed reviews are visible before any final task result exists.
 */
export function durableReviewSummary(
  sources: IndexedSource[],
): { aggregate: string; cycles: number; latestSequence: number; reviewers: Array<{ reviewerId: string; verdict: string; summary: string }>; caveat?: string } | undefined {
  const reviewSources = sources.filter((source) => source.sourceId.startsWith("review:"));
  if (reviewSources.length === 0) return undefined;
  const latest = latestDurableCycle(sources);
  if (!latest) return undefined;
  const { meta } = latest;
  // Without a settled report, freshness is never proven by absence: an
  // unusable sibling names a known gap, and even with no visible sibling a
  // later cycle's record and its failure marker can both have failed to
  // publish. Say so explicitly instead of asserting a possibly superseded
  // verdict.
  const laterUnpublished = unpublishedReviewCycles(sources).find((u) => u.waveId === meta.waveId && u.cycle > meta.cycle);
  const caveat = !sources.some((source) => source.sourceId === "report:result.json")
    ? laterUnpublished !== undefined
      ? `Review cycle ${laterUnpublished.cycle} (wave ${laterUnpublished.waveId}) completed without a persisted record (see unavailable notes); this summarizes the most recent readable cycle and may no longer be the current review state.`
      : hasUnusableReviewCycle(sources)
        ? "At least one review cycle record could not be read or was not published (see unavailable notes); this summarizes the most recent readable cycle and may no longer be the current review state."
        : "This summarizes the latest available durable review cycle; a later cycle's record could have failed to publish without leaving a trace, so review completeness cannot be confirmed until settlement."
    : undefined;
  const reviewers: Array<{ reviewerId: string; verdict: string; summary: string }> = [];
  for (const record of latest.source.records) {
    if (record.kind !== "review") continue;
    try {
      const parsed: unknown = JSON.parse(record.content);
      if (!isRecord(parsed) || !isRecord(parsed.reviewer)) continue;
      reviewers.push({
        reviewerId: typeof parsed.reviewer.id === "string" ? parsed.reviewer.id : "unknown",
        verdict: typeof parsed.reviewer.verdict === "string" ? parsed.reviewer.verdict : "unknown",
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
      });
    } catch {
      // Not our record shape; skip rather than render partial data.
    }
  }
  return {
    aggregate: meta.aggregate,
    cycles: sources.filter((source) => source.sourceId.startsWith("review:") && (cycleMetaOf(source) !== undefined || unpublishedMetaOf(source) !== undefined)).length,
    latestSequence: meta.reviewSequence,
    reviewers,
    ...(caveat ? { caveat } : {}),
  };
}

/** Reviewer verdicts/findings from the durable review report (reviewer_verdict provenance). */
export function buildReviewSource(result: WaveResult | undefined, updatedAt: string | undefined, budget: RawRetentionBudget): IndexedSource | undefined {
  const report = result?.taskResults?.[0]?.reviewReport;
  if (!report) return undefined;
  const sourceId = "report:result.json";
  const records: RawEvidenceRecord[] = [];
  const digests = new Map<string, string>();
  const unavailable: SubtaskEvidenceUnavailable[] = [];
  let omitted = 0;
  const retain = (recordKey: string, kind: "review" | "lifecycle", content: string): void => {
    const bounded = capped(content);
    const bytes = Buffer.byteLength(bounded.content, "utf8");
    if (budget.exhausted || budget.remainingBytes < bytes) {
      budget.exhausted = true;
      omitted += 1;
      return;
    }
    budget.remainingBytes -= bytes;
    records.push({ recordKey, kind, provenance: "reviewer_verdict", ...bounded });
    digests.set(recordKey, sha256HexOf(content));
  };
  const latestCycle = report.history.at(-1);
  for (const reviewer of (latestCycle?.reviewers ?? report.reviewers)) {
    const recordKey = `cycle:${latestCycle?.reviewSequence ?? report.latestReviewSequence}:${reviewer.reviewerId}`;
    retain(recordKey, "review", compactJson({
      verdict: reviewer.verdict,
      summary: reviewer.summary,
      ...(reviewer.guidance ? { guidance: reviewer.guidance } : {}),
      findings: reviewer.findings,
    }));
  }
  if (report.history.length > 1) {
    retain("cycles", "lifecycle", `review history: ${report.history.map((cycle) => `cycle ${cycle.reviewSequence} ${cycle.aggregate}`).join("; ")}`);
  }
  if (records.length === 0) return undefined;
  for (const item of omittedNote(sourceId, omitted)) unavailable.push(item);
  return finalizeSource({
    sourceId,
    adapter: "record",
    stream: "result",
    file: "result.json",
    orderKey: updatedAt ?? "9999-12-31T23:59:59.999Z",
    records,
    digests,
    unavailable,
    stats: { recordsScanned: records.length, oversizedRecords: 0, skippedRecords: 0 },
  });
}
