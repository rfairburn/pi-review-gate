/**
 * Evidence cursors (#33).
 *
 * A cursor names, per source, the last consumed record key plus a chained
 * sha256 digest over the raw lines of EVERY covered record (the consumed
 * prefix). Continuation is therefore stable across appends, restarts, and
 * attempt rotation: records appended after the named record are returned
 * exactly once, while any covered source whose watermark record is missing or
 * whose covered prefix changed in ANY position (rewrite, atomic replacement
 * preserving the final record, window rotation) is rejected explicitly instead
 * of silently skipping or duplicating evidence.
 *
 * Watermark semantics: issuing a cursor from a ranged read marks every entry
 * at or before that read's end (in global order) as consumed for its source.
 * Re-read without a cursor to revisit earlier evidence. Cursors are only
 * issued for unfiltered reads; find/call/entry reads return no cursor.
 */
import { createHash } from "node:crypto";
import type { SubtaskEvidenceEntryView, SubtaskEvidenceSnapshot } from "./types";

export interface CursorSourceState {
  last: string;
  /** Number of covered records in the source (prefix length). */
  count: number;
  /** Chained sha256 over the raw line digests of all covered records, in order. */
  chain: string;
}

export interface CursorPayload {
  v: 2;
  taskId: string;
  issuedAt: string;
  covered: Record<string, CursorSourceState>;
}

export type CursorErrorReason =
  | "malformed_cursor"
  | "cursor_task_mismatch"
  | "cursor_source_missing"
  | "cursor_record_missing"
  | "cursor_content_changed";

/** A cursor that can no longer be applied honestly (fail closed). */
export class EvidenceCursorError extends Error {
  constructor(readonly reason: CursorErrorReason, message: string) {
    super(message);
  }
}

const CURSOR_TOKEN_PREFIX = "ev1.";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Initial chain value for a source (binds the chain to the source identity). */
function initialChain(sourceId: string): string {
  return sha256Hex(`cursor-chain:${sourceId}`);
}

export function encodeCursor(taskId: string, covered: Record<string, CursorSourceState>): string {
  const payload: CursorPayload = { v: 2, taskId, issuedAt: new Date().toISOString(), covered };
  return `${CURSOR_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeCursor(token: string): CursorPayload {
  let payload: CursorPayload;
  try {
    if (typeof token !== "string" || !token.startsWith(CURSOR_TOKEN_PREFIX)) throw new Error("bad prefix");
    const decoded = JSON.parse(Buffer.from(token.slice(CURSOR_TOKEN_PREFIX.length), "base64url").toString("utf8"));
    // v1 cursors only bound the last record's digest; they cannot prove covered
    // prefix integrity and are rejected as expired rather than downgraded.
    if (typeof decoded !== "object" || decoded === null || decoded.v !== 2) throw new Error("bad version");
    if (typeof decoded.taskId !== "string" || typeof decoded.covered !== "object" || decoded.covered === null) throw new Error("bad shape");
    payload = decoded as CursorPayload;
  } catch {
    throw new EvidenceCursorError("malformed_cursor", "The cursor token is malformed, expired, or not an evidence cursor. Re-read without a cursor.");
  }
  for (const [sourceId, state] of Object.entries(payload.covered)) {
    if (typeof state?.last !== "string" || typeof state.count !== "number" || !Number.isSafeInteger(state.count) || state.count < 0 || typeof state.chain !== "string") {
      throw new EvidenceCursorError("malformed_cursor", `The cursor token has a malformed entry for source "${sourceId}".`);
    }
  }
  return payload;
}

/** Ordered raw-line digests per source, in global snapshot order. */
function buildSourceDigestLists(snapshot: SubtaskEvidenceSnapshot): Map<string, Array<{ recordKey: string; digest: string }>> {
  const lists = new Map<string, Array<{ recordKey: string; digest: string }>>();
  for (const entry of snapshot.entries) {
    const list = lists.get(entry.source.sourceId) ?? [];
    list.push({ recordKey: entry.source.recordKey!, digest: snapshot.digestByEntryId.get(entry.entryId) ?? "" });
    lists.set(entry.source.sourceId, list);
  }
  return lists;
}

/**
 * Folds the covered-prefix chain over a source's records from the beginning,
 * up to and including `recordKey`. Returns undefined when the key is absent.
 */
function foldCoveredPrefix(list: Array<{ recordKey: string; digest: string }>, sourceId: string, recordKey: string): { count: number; chain: string } | undefined {
  let chain = initialChain(sourceId);
  let count = 0;
  for (const item of list) {
    chain = sha256Hex(`${chain}:${item.digest}`);
    count += 1;
    if (item.recordKey === recordKey) return { count, chain };
  }
  return undefined;
}

/**
 * Validates a cursor against the current snapshot. Returns the ordinal of the
 * last covered record per source. Throws EvidenceCursorError when the cursor
 * is expired, replaced, or ambiguous — never silently resumes. The covered
 * prefix (every consumed record, not just the last) must match in count and
 * chained digest; any rewrite or replacement inside it is rejected.
 */
export function validateCursor(snapshot: SubtaskEvidenceSnapshot, token: string): Map<string, number> {
  const payload = decodeCursor(token);
  if (payload.taskId !== snapshot.taskId) {
    throw new EvidenceCursorError("cursor_task_mismatch", "The cursor belongs to a different task and cannot be applied here.");
  }
  const lists = buildSourceDigestLists(snapshot);
  const resume = new Map<string, number>();
  for (const [sourceId, state] of Object.entries(payload.covered)) {
    const list = lists.get(sourceId);
    if (!list) {
      throw new EvidenceCursorError("cursor_source_missing", `Evidence source "${sourceId}" no longer exists; the cursor is expired. Re-read without a cursor.`);
    }
    let ordinal: number | undefined;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i]!.recordKey === state.last) { ordinal = i; break; }
    }
    if (ordinal === undefined) {
      throw new EvidenceCursorError("cursor_record_missing", `The cursor's last record for source "${sourceId}" is no longer present (rotated out of the retained window or removed); the cursor is expired. Re-read without a cursor.`);
    }
    const folded = foldCoveredPrefix(list, sourceId, state.last);
    if (!folded || folded.count !== state.count || folded.chain !== state.chain) {
      throw new EvidenceCursorError("cursor_content_changed", `Source "${sourceId}" was rewritten, replaced, or rotated inside its covered range after the cursor was issued; the cursor is stale. Re-read without a cursor.`);
    }
    resume.set(sourceId, ordinal);
  }
  return resume;
}

/** Entries strictly after the cursor's per-source watermark (global order). */
export function entriesAfterCursor(snapshot: SubtaskEvidenceSnapshot, token: string): SubtaskEvidenceEntryView[] {
  const resume = validateCursor(snapshot, token);
  const lists = buildSourceDigestLists(snapshot);
  return snapshot.entries.filter((entry) => {
    const coveredOrdinal = resume.get(entry.source.sourceId);
    if (coveredOrdinal === undefined) return true; // new source: read from the start
    const list = lists.get(entry.source.sourceId)!;
    let ordinal = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i]!.recordKey === entry.source.recordKey) { ordinal = i; break; }
    }
    return ordinal > coveredOrdinal;
  });
}

/** Watermark coverage after a ranged read ending at `endGlobalIndex`. */
export function coverageAfterRange(snapshot: SubtaskEvidenceSnapshot, endGlobalIndex: number): Record<string, CursorSourceState> {
  const covered: Record<string, CursorSourceState> = {};
  for (const entry of snapshot.entries.slice(0, endGlobalIndex + 1)) {
    const sourceId = entry.source.sourceId;
    const state = covered[sourceId] ?? { last: "", count: 0, chain: initialChain(sourceId) };
    state.chain = sha256Hex(`${state.chain}:${snapshot.digestByEntryId.get(entry.entryId) ?? ""}`);
    state.count += 1;
    state.last = entry.source.recordKey!;
    covered[sourceId] = state;
  }
  return covered;
}
/** Extends a previously validated coverage with the entries returned by a cursor read. */
export function coverageAfterCursor(previous: Record<string, CursorSourceState>, snapshot: SubtaskEvidenceSnapshot, returned: SubtaskEvidenceEntryView[]): Record<string, CursorSourceState> {
  const covered: Record<string, CursorSourceState> = {};
  for (const [sourceId, state] of Object.entries(previous)) covered[sourceId] = { ...state };
  for (const entry of returned) {
    const sourceId = entry.source.sourceId;
    const state = covered[sourceId] ?? { last: "", count: 0, chain: initialChain(sourceId) };
    state.chain = sha256Hex(`${state.chain}:${snapshot.digestByEntryId.get(entry.entryId) ?? ""}`);
    state.count += 1;
    state.last = entry.source.recordKey!;
    covered[sourceId] = state;
  }
  return covered;
}
