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
  // #54: chunk boundaries follow the fixed grid, except a boundary that would
  // split a UTF-16 surrogate pair is pushed past it — a lone surrogate in
  // either half would corrupt both chunks' text even though concatenation
  // still reconstructs the retained content. A chunk starts exactly at the
  // (capped) boundary after the previous one, so every chunkIndex resolves in
  // constant time as a pure function of the snapshot and continued chunks
  // remain lossless.
  const start = chunkIndex === 0 ? 0 : Math.min(chunkBoundary(content, chunkIndex - 1), content.length);
  const end = Math.min(chunkBoundary(content, chunkIndex), content.length);
  const chunk = content.slice(start, end);
  const hasMore = end < content.length;
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

/** Grid boundary after chunk `chunkIndex`, pushed past a split surrogate pair. */
function chunkBoundary(content: string, chunkIndex: number): number {
  const candidate = (chunkIndex + 1) * EVIDENCE_DEEP_CHUNK_CHARS;
  const high = content.charCodeAt(candidate - 1);
  const low = content.charCodeAt(candidate);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? candidate + 1 : candidate;
}

function readCall(bundle: SubtaskEvidenceBundle, selector: SubtaskEvidenceSelector): SubtaskEvidenceRead {
  const { snapshot } = bundle;
  const callId = selector.callId!;
  const calls = snapshot.entries.filter((entry) => entry.kind === "tool_call" && entry.callId === callId);
  const results = snapshot.entries.filter((entry) => entry.kind === "tool_result" && entry.callId === callId);
  if (calls.length === 0 && results.length === 0) {
    throw new EvidenceNavigationError("call_not_found", `No tool call or result with pairing id "${callId}" exists in this task's current snapshot.`);
  }

  const scoped = [...calls, ...results].some((entry) => entry.pairingScopedToSource === true);
  if (scoped && (calls.length > 1 || results.length > 1)) {
    throw new EvidenceNavigationError(
      "call_ambiguous",
      `Pairing id "${callId}" identifies multiple source-scoped records; use an entryId to select the intended source.`,
    );
  }

  // A validated bidirectional link (set by the source parser or the snapshot
  // pairing pass) is the only basis for reporting a pair.
  let linkedCall: SubtaskEvidenceEntryView | undefined;
  let linkedResult: SubtaskEvidenceEntryView | undefined;
  for (const candidate of calls) {
    const sibling = snapshot.entries.find((entry) => entry.entryId === candidate.pairedWith && entry.kind === "tool_result");
    if (sibling !== undefined && sibling.pairedWith === candidate.entryId) {
      linkedCall = candidate;
      linkedResult = sibling;
      break;
    }
  }
  if (linkedCall && linkedResult) {
    return {
      taskId: snapshot.taskId,
      mode: "call",
      snapshot: snapshotSummary(snapshot),
      ...(bundle.context ? { context: bundle.context } : {}),
      callPair: { call: linkedCall, result: linkedResult, status: "returned" },
    };
  }

  // No validated pair. Source-scoped observed identities (e.g. Codex item ids)
  // must never be guessed: a single unlinked entry is reported honestly, and an
  // id shared by several unlinked entries is refused explicitly.
  if (scoped) {
    if (calls.length + results.length > 1) {
      throw new EvidenceNavigationError(
        "call_ambiguous",
        `Pairing id "${callId}" appears on ${calls.length} tool call(s) and ${results.length} tool result(s) without a validated pair; refusing to guess which records belong together.`,
      );
    }
    const only = calls[0] ?? results[0]!;
    return {
      taskId: snapshot.taskId,
      mode: "call",
      snapshot: snapshotSummary(snapshot),
      ...(bundle.context ? { context: bundle.context } : {}),
      // No validated pair exists in this snapshot: the pair state is
      // unresolved (never "returned"); the entry's own observed status stays
      // visible on the entry itself.
      callPair: only.kind === "tool_call" ? { call: only, status: "in_flight" } : { result: only, status: "in_flight" },
    };
  }

  // Global identities (Pi/Claude tool ids): legacy bare-id behavior — the
  // snapshot pairing pass is their pairing authority.
  const call = calls[0];
  const result = results[0];
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
