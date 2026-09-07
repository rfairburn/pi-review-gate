/**
 * Evidence navigation (#33): bounded find, ranged index/limit pagination,
 * call pairing, deep-read continuation, and cursor continuation over an
 * assembled snapshot. Every read is served from redacted retained content.
 */
import { coverageAfterCursor, coverageAfterRange, decodeCursor, encodeCursor, entriesAfterCursor } from "./cursor";
import {
  EVIDENCE_COMMAND_TOOL_NAMES,
  EVIDENCE_DEEP_CHUNK_CHARS,
  EVIDENCE_FIND_MATCHES_MAX,
  EVIDENCE_LIMIT_DEFAULT,
  EVIDENCE_LIMIT_MAX,
  type SubtaskEvidenceBundle,
  type SubtaskEvidenceEntryView,
  type SubtaskEvidenceFilter,
  type SubtaskEvidenceRead,
  type SubtaskEvidenceSelector,
  type SubtaskEvidenceSnapshot,
} from "./types";

/** Invalid navigation request (bad selector values, missing targets). */
export class EvidenceNavigationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function requireNonNegativeInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceNavigationError("invalid_selector", `${name} must be a non-negative integer.`);
  }
  return value;
}

function matchesFilter(entry: SubtaskEvidenceEntryView, filter: SubtaskEvidenceFilter | undefined): boolean {
  if (!filter) return true;
  switch (filter) {
    case "tool_call":
      return entry.kind === "tool_call";
    case "tool_result":
      return entry.kind === "tool_result";
    case "command":
      return entry.toolName !== undefined && EVIDENCE_COMMAND_TOOL_NAMES.has(entry.toolName);
    case "lifecycle":
      return entry.kind === "lifecycle";
    case "claim":
      return entry.kind === "claim";
    case "review":
      return entry.kind === "review";
  }
}

function snapshotSummary(snapshot: SubtaskEvidenceSnapshot): SubtaskEvidenceRead["snapshot"] {
  return {
    totalEntries: snapshot.totalEntries,
    sources: snapshot.sources,
    unavailable: snapshot.unavailable,
    capability: snapshot.capability,
    diagnostics: snapshot.diagnostics,
  };
}

function readEntry(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  const { snapshot } = bundle;
  const entryId = selector.entryId!;
  const chunkIndex = requireNonNegativeInt(selector.chunkIndex, "chunkIndex") ?? 0;
  const entry = snapshot.entries.find((candidate) => candidate.entryId === entryId);
  if (!entry) {
    throw new EvidenceNavigationError("entry_not_found", `No evidence entry "${entryId}" exists in this task's current snapshot.`);
  }
  const content = snapshot.contentByEntryId.get(entryId) ?? "";
  const start = chunkIndex * EVIDENCE_DEEP_CHUNK_CHARS;
  const chunk = content.slice(start, start + EVIDENCE_DEEP_CHUNK_CHARS);
  const hasMore = start + EVIDENCE_DEEP_CHUNK_CHARS < content.length;
  return {
    taskId: snapshot.taskId,
    mode: "entry",
    snapshot: snapshotSummary(snapshot),
    ...(bundle.context ? { context: bundle.context } : {}),
    deepContent: {
      entryId,
      chunkIndex,
      content: chunk,
      hasMore,
      ...(hasMore ? { nextChunk: chunkIndex + 1 } : {}),
      contentBytes: entry.contentBytes,
      ...(entry.truncatedContent ? { truncatedContent: true } : {}),
      note: entry.truncatedContent
        ? "The source record exceeded the retention cap; retained content may end mid-record."
        : chunk.length === 0 && chunkIndex > 0
          ? "No retained content at this chunk; use an earlier chunkIndex."
          : undefined,
    },
  };
}

function readCall(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  const { snapshot } = bundle;
  const callId = selector.callId!;
  const call = snapshot.entries.find((entry) => entry.kind === "tool_call" && entry.callId === callId);
  const result = snapshot.entries.find((entry) => entry.kind === "tool_result" && entry.callId === callId);
  if (!call && !result) {
    throw new EvidenceNavigationError("call_not_found", `No tool call or result with pairing id "${callId}" exists in this task's current snapshot.`);
  }
  return {
    taskId: snapshot.taskId,
    mode: "call",
    snapshot: snapshotSummary(snapshot),
    ...(bundle.context ? { context: bundle.context } : {}),
    callPair: {
      ...(call ? { call } : {}),
      ...(result ? { result } : {}),
      status: result ? "returned" : "in_flight",
    },
  };
}

function readFind(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  const { snapshot } = bundle;
  const query = (selector.find ?? "").toLowerCase();
  if (!query.trim()) throw new EvidenceNavigationError("invalid_selector", "find requires a non-empty search string.");
  const matches: NonNullable<SubtaskEvidenceRead["matches"]> = [];
  let totalMatches = 0;
  for (const entry of snapshot.entries) {
    if (!matchesFilter(entry, selector.filter)) continue;
    const retained = snapshot.contentByEntryId.get(entry.entryId) ?? "";
    // Both search and snippets operate on the redacted, retention-capped
    // content: private or unredacted bytes never reach a match view.
    const position = retained.toLowerCase().indexOf(query);
    if (position < 0) continue;
    totalMatches += 1;
    if (matches.length < EVIDENCE_FIND_MATCHES_MAX) {
      const rawStart = Math.max(0, position - 80);
      const snippet = retained.slice(rawStart, position + query.length + 120).replace(/\s+/g, " ").trim();
      matches.push({ index: entry.index, entryId: entry.entryId, kind: entry.kind, snippet: (rawStart > 0 ? "…" : "") + snippet });
    }
  }
  return {
    taskId: snapshot.taskId,
    mode: "find",
    snapshot: snapshotSummary(snapshot),
    ...(bundle.context ? { context: bundle.context } : {}),
    matches,
    matchSummary: { query: selector.find!, totalMatches, matchesTruncated: totalMatches > matches.length },
  };
}

function readCursor(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  const { snapshot } = bundle;
  if (selector.filter) {
    throw new EvidenceNavigationError("invalid_selector", "Cursors are unfiltered reads; drop the filter to continue from a cursor.");
  }
  const limit = clampLimit(selector.limit);
  const returnedAll = entriesAfterCursor(snapshot, selector.cursor!);
  const selected = returnedAll.slice(0, limit);
  const previousCovered = decodeCursor(selector.cursor!).covered;
  return {
    taskId: snapshot.taskId,
    mode: "cursor",
    snapshot: snapshotSummary(snapshot),
    ...(bundle.context ? { context: bundle.context } : {}),
    ...(selected.length > 0 ? { entries: selected } : {}),
    cursor: encodeCursor(snapshot.taskId, coverageAfterCursor(previousCovered, snapshot, selected)),
  };
}

function readRange(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  const { snapshot } = bundle;
  const start = requireNonNegativeInt(selector.index, "index") ?? 0;
  const limit = clampLimit(selector.limit);
  const base = selector.filter ? snapshot.entries.filter((entry) => matchesFilter(entry, selector.filter)) : snapshot.entries;
  if (start > 0 && start >= base.length) {
    throw new EvidenceNavigationError("index_out_of_range", `index ${start} is beyond the end of the evidence sequence (${base.length} entries).`);
  }
  const selected = base.slice(start, start + limit);
  const nextIndex = start + selected.length < base.length ? start + selected.length : undefined;
  let cursor: string | undefined;
  if (!selector.filter && selected.length > 0) {
    // Watermark: every entry at or before this read's end is consumed.
    cursor = encodeCursor(snapshot.taskId, coverageAfterRange(snapshot, start + selected.length - 1));
  }
  return {
    taskId: snapshot.taskId,
    mode: "range",
    snapshot: snapshotSummary(snapshot),
    ...(bundle.context ? { context: bundle.context } : {}),
    ...(selected.length > 0 ? { entries: selected } : {}),
    ...(nextIndex !== undefined ? { nextIndex } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return EVIDENCE_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new EvidenceNavigationError("invalid_selector", "limit must be a positive integer.");
  return Math.min(limit, EVIDENCE_LIMIT_MAX);
}

/**
 * Executes one evidence read against an assembled bundle. Precedence:
 * entryId (deep read) > callId (pair) > cursor (continuation) > find > range.
 */
export function readSubtaskEvidence(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  if (selector.entryId) return readEntry(bundle, selector);
  if (selector.callId) return readCall(bundle, selector);
  if (selector.cursor) return readCursor(bundle, selector);
  if (selector.find !== undefined) return readFind(bundle, selector);
  return readRange(bundle, selector);
}
