/**
 * Focused pure contract and codec tests for the optional Saved catalog exchange
 * on the roster metadata lane. Nothing here opens a socket, starts a timer, or
 * touches the filesystem: it exercises the pure guards in `peer-saved.ts` and the
 * Saved frames and window packer in `roster-bridge-protocol.ts`. The RPC paths
 * over the loopback channel live in `session-host-network-roster-bridge.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isOwnerSavedDeleteFacts,
  isOwnerSavedEntry,
  isOwnerSavedQuery,
  isOwnerSavedResumeFacts,
  isOwnerSavedText,
  isOwnerSavedWindowFacts,
  isOwnerSavedWindowOutcome,
  type OwnerSavedEntry,
} from "../src/session-host/network/peer-saved";
import {
  DEFAULT_ROSTER_BRIDGE_BOUNDS,
  buildRosterBridgeSavedWindowTransfer,
  decodeRosterBridgeFrame,
  decodeRosterBridgeSavedEntryText,
  encodeRosterBridgeFrame,
  isRosterBridgeProtocolError,
  packRosterBridgePages,
  resolveRosterBridgeBounds,
  rosterBridgeSavedWindowMaxFrames,
  type RosterBridgeFrame,
} from "../src/session-host/network/roster-bridge-protocol";
import { toRemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { NativeInstanceView } from "../src/session-host/instances";

const RUN = "11111111-1111-4111-8111-111111111111";

function entry(index: number, overrides: Partial<OwnerSavedEntry> = {}): OwnerSavedEntry {
  return {
    entryId: `entry-${index}`,
    sessionId: `0190a1b2-0000-7000-8000-${String(index).padStart(12, "0")}`,
    file: `/srv/owner/agent/sessions/--srv-owner--/2026-10-22T00-00-00-000Z_${index}.jsonl`,
    caption: `Saved ${index}`,
    cwd: `/srv/owner/project ${index}`,
    ...overrides,
  };
}

/** True only for the protocol's own fixed refusal of a frame it cannot carry. */
function refusedOnDecode(frame: unknown): boolean {
  try {
    decodeRosterBridgeFrame(Buffer.from(JSON.stringify(frame), "utf8"));
    return false;
  } catch (error) {
    return isRosterBridgeProtocolError(error) && (error.code === "bad_frame" || error.code === "frame_too_large");
  }
}

function roundTrip(frame: RosterBridgeFrame): RosterBridgeFrame {
  return decodeRosterBridgeFrame(encodeRosterBridgeFrame(frame));
}

// --- entry and fact guards ----------------------------------------------------

test("an entry carries the owner's exact native Saved display data and nothing else", () => {
  assert.equal(isOwnerSavedEntry(entry(1)), true);
  // Exact owner data is accepted as-is: a Windows owner path on any viewer, a
  // long path, an empty cwd, astral text, spaces, and even raw control text the
  // existing UI formatter (not the wire) is responsible for presenting.
  for (const overrides of [
    { file: "C:\\Users\\owner\\.pi\\agent\\sessions\\x\\a b.jsonl" },
    { file: `/srv/${"d/".repeat(5_000)}x.jsonl` },
    { cwd: "" },
    { cwd: "/srv/\u{1f5c2} owner" },
    { caption: "x".repeat(10_000) },
    { caption: "bell\u0007 and line\u2028sep" },
    { sessionId: "" },
  ]) {
    assert.equal(isOwnerSavedEntry(entry(1, overrides)), true, `${JSON.stringify(overrides).slice(0, 60)} is exact owner data`);
  }
  // Only what cannot cross the wire exactly, or is outside the closed shape, is refused.
  for (const bad of [
    { ...entry(1), projectDir: "/srv/owner/agent/sessions" },
    { ...entry(1), transcript: "secret" },
    { entryId: "entry-1", caption: "x", cwd: "/" },
    entry(1, { entryId: "" }),
    entry(1, { entryId: "x".repeat(65) }),
    entry(1, { entryId: "has space" }),
    entry(1, { file: "\ud800" }),
    entry(1, { cwd: 7 as never }),
    entry(1, { caption: null as never }),
  ]) {
    assert.equal(isOwnerSavedEntry(bad), false, `${JSON.stringify(bad).slice(0, 60)} must be refused`);
  }
  assert.equal(isOwnerSavedText("plain"), true);
  assert.equal(isOwnerSavedText("\udc00lone"), false);
  assert.equal(isOwnerSavedQuery("  spaced  query  "), true);
  assert.equal(isOwnerSavedQuery(""), true);
  assert.equal(isOwnerSavedQuery("q".repeat(100_000)), true, "no invented query length cap");
  assert.equal(isOwnerSavedQuery("\ud800"), false);
});

test("window facts state a coherent full total and never allocate from it", () => {
  const window = {
    kind: "window", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: Number.MAX_SAFE_INTEGER, issueCount: 3, offset: 10, entries: [entry(10), entry(11)],
  };
  assert.equal(isOwnerSavedWindowFacts(window), true);
  assert.equal(isOwnerSavedWindowFacts({ ...window, total: 0, offset: 0, entries: [] }), true, "an empty result is real");
  for (const bad of [
    { ...window, offset: 5, total: 4 },
    { ...window, total: 11, offset: 10 },
    { ...window, entries: [entry(10), entry(10)] },
    { ...window, total: -1 },
    { ...window, total: 1.5 },
    { ...window, issueCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...window, extra: true },
    { ...window, catalogId: "" },
  ]) {
    assert.equal(isOwnerSavedWindowFacts(bad), false, `${JSON.stringify(bad).slice(0, 80)} must be refused`);
  }
  assert.equal(isOwnerSavedWindowOutcome({ kind: "refused" }), true);
  assert.equal(isOwnerSavedWindowOutcome({ kind: "refused", reason: "range" }), true);
  assert.equal(isOwnerSavedWindowOutcome({ kind: "refused", reason: "policy" }), false);
  assert.equal(isOwnerSavedWindowOutcome({ kind: "window" }), false);
  assert.equal(isOwnerSavedWindowOutcome({ kind: "unknown", error: "boom" }), false);

  assert.equal(isOwnerSavedResumeFacts({ kind: "started", hostRunId: RUN, rowId: "native-1" }), true);
  assert.equal(isOwnerSavedResumeFacts({ kind: "refused", reason: "duplicate" }), true);
  assert.equal(isOwnerSavedResumeFacts({ kind: "refused" }), false, "a resume refusal names its fixed reason");
  assert.equal(isOwnerSavedResumeFacts({ kind: "started", hostRunId: RUN, rowId: "native-1", path: "/x" }), false);
  assert.equal(isOwnerSavedDeleteFacts({ kind: "deleted", method: "trash" }), true);
  assert.equal(isOwnerSavedDeleteFacts({ kind: "deleted", method: "unlink" }), true);
  assert.equal(isOwnerSavedDeleteFacts({ kind: "deleted", method: "shred" }), false);
  assert.equal(isOwnerSavedDeleteFacts({ kind: "confirmation-required" }), true);
  assert.equal(isOwnerSavedDeleteFacts({ kind: "refused", reason: "active" }), true);
  assert.equal(isOwnerSavedDeleteFacts({ kind: "unknown", error: "EACCES" }), false, "no raw error is representable");
});

// --- codec --------------------------------------------------------------------

test("every Saved frame round-trips through a closed schema, and the query is exact", () => {
  const frames: RosterBridgeFrame[] = [
    { type: "saved_list_request", requestId: "r-1", hostRunId: RUN, query: "  fix  \u{1f5c2}  ", offset: 0, count: 4_096, sequence: 1 },
    { type: "saved_search_request", requestId: "r-2", hostRunId: RUN, catalogId: "cat-1", query: "", offset: 9_999_999, count: 1, sequence: 2 },
    { type: "saved_window_request", requestId: "r-3", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1", offset: 4_096, count: 32, sequence: 3 },
    { type: "saved_resume_request", requestId: "r-4", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1", entryId: "entry-1", sequence: 4 },
    { type: "saved_delete_request", requestId: "r-5", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1", entryId: "entry-1", confirmed: false, sequence: 5 },
    { type: "saved_window_result", requestId: "r-1", outcome: { kind: "refused", reason: "busy" } },
    { type: "saved_window_result", requestId: "r-1", outcome: { kind: "unavailable" } },
    {
      type: "saved_window_begin", requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
      total: 10_000, issueCount: 2, offset: 4_096, rows: 2, pageCount: 1,
    },
    { type: "saved_window_page", requestId: "r-1", pageIndex: 0, entries: [entry(1), entry(2, { file: "C:\\owner\\x.jsonl" })] },
    { type: "saved_window_fragment", requestId: "r-1", pageIndex: 1, part: 0, parts: 2, text: "{\"entryId\":" },
    { type: "saved_window_end", requestId: "r-1", rows: 2, pageCount: 1 },
    { type: "saved_resume_result", requestId: "r-4", outcome: { kind: "started", hostRunId: RUN, rowId: "native-1" } },
    { type: "saved_delete_result", requestId: "r-5", outcome: { kind: "deleted", method: "trash" } },
    { type: "saved_policy", hostRunId: RUN, deleteExposed: true },
  ];
  for (const frame of frames) {
    assert.deepEqual(roundTrip(frame), frame, `${frame.type} round-trips exactly`);
  }
  // A query beyond any invented cap still crosses as long as its frame fits.
  const long = { type: "saved_list_request", requestId: "r-6", hostRunId: RUN, query: "q".repeat(10_000), offset: 0, count: 1, sequence: 6 } as const;
  assert.equal((roundTrip(long) as typeof long).query.length, 10_000);
  // The ONLY query bound is the existing frame bound.
  assert.throws(() => encodeRosterBridgeFrame({ ...long, query: "q".repeat(70_000) }),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "frame_too_large");
});

test("Saved frames refuse anything outside their closed schema and bounds", () => {
  const list = { type: "saved_list_request", requestId: "r-1", hostRunId: RUN, query: "", offset: 0, count: 1, sequence: 1 };
  for (const bad of [
    { ...list, path: "/srv/owner" },
    { ...list, query: "\ud800" },
    { ...list, query: 7 },
    { ...list, count: 0 },
    { ...list, count: DEFAULT_ROSTER_BRIDGE_BOUNDS.maxSnapshotRows + 1 },
    { ...list, offset: -1 },
    { ...list, offset: 1.5 },
    { ...list, sequence: 0 },
    { ...list, hostRunId: "" },
    { ...list, requestId: "x".repeat(65) },
    { ...list, file: "C:\\owner\\x.jsonl" },
  ]) {
    assert.equal(refusedOnDecode(bad), true, `${JSON.stringify(bad).slice(0, 80)} must never decode`);
  }
  // A requester-side path can never be expressed in a resume or delete request.
  assert.equal(refusedOnDecode({
    type: "saved_resume_request", requestId: "r", hostRunId: RUN, catalogId: "c", resultId: "r", entryId: "e", sequence: 1,
    file: "/srv/owner/x.jsonl",
  }), true);
  assert.equal(refusedOnDecode({
    type: "saved_delete_request", requestId: "r", hostRunId: RUN, catalogId: "c", resultId: "r", entryId: "e", sequence: 1,
    confirmed: "yes",
  }), true);
  const begin = {
    type: "saved_window_begin", requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 10, issueCount: 0, offset: 8, rows: 2, pageCount: 1,
  };
  for (const bad of [
    { ...begin, rows: 3 },
    { ...begin, offset: 11 },
    { ...begin, rows: 0, pageCount: 1 },
    { ...begin, rows: 2, pageCount: 0 },
    { ...begin, total: Number.MAX_SAFE_INTEGER + 2 },
    { ...begin, pageCount: rosterBridgeSavedWindowMaxFrames() + 1 },
  ]) {
    assert.equal(refusedOnDecode(bad), true, `${JSON.stringify(bad).slice(0, 80)} is incoherent`);
  }
  const page = { type: "saved_window_page", requestId: "r-1", pageIndex: 0, entries: [entry(1)] };
  for (const bad of [
    { ...page, entries: [entry(1), entry(1)] },
    { ...page, entries: [{ ...entry(1), projectDir: "/x" }] },
    { ...page, entries: Array.from({ length: DEFAULT_ROSTER_BRIDGE_BOUNDS.maxRowsPerPage + 1 }, (_unused, index) => entry(index)) },
  ]) {
    assert.equal(refusedOnDecode(bad), true);
  }
  const fragment = { type: "saved_window_fragment", requestId: "r-1", pageIndex: 0, part: 0, parts: 2, text: "{" };
  for (const bad of [
    { ...fragment, part: 2 },
    { ...fragment, parts: 0 },
    { ...fragment, text: "" },
    { ...fragment, text: "\ud800" },
  ]) {
    assert.equal(refusedOnDecode(bad), true);
  }
  for (const outcome of [{ kind: "window" }, { kind: "refused", reason: "policy" }, { kind: "unknown", error: "x" }]) {
    assert.equal(refusedOnDecode({ type: "saved_window_result", requestId: "r-1", outcome }), true);
  }
  assert.equal(refusedOnDecode({ type: "saved_policy", hostRunId: RUN, deleteExposed: "true" }), true);
  assert.throws(() => encodeRosterBridgeFrame({ ...list, query: "\ud800" } as never),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_frame");
});

test("a fragmented entry must reassemble to exactly one canonical entry", () => {
  const exact = entry(3, { file: "C:\\owner\\\"quoted\".jsonl" });
  const text = JSON.stringify(exact);
  assert.deepEqual(decodeRosterBridgeSavedEntryText(text), exact);
  for (const bad of [
    text.slice(0, -1),
    JSON.stringify({ ...exact, extra: 1 }),
    JSON.stringify({ cwd: exact.cwd, caption: exact.caption, file: exact.file, sessionId: exact.sessionId, entryId: exact.entryId }),
    ` ${text}`,
  ]) {
    assert.throws(() => decodeRosterBridgeSavedEntryText(bad),
      (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame",
      "only the canonical encoding of one valid entry is accepted");
  }
});

// --- window packing -----------------------------------------------------------

test("a window carries the longest contiguous prefix and never softens the roster packer", () => {
  const bounds = resolveRosterBridgeBounds({ maxRowsPerPage: 2, maxSnapshotRows: 4 });
  const entries = Array.from({ length: 10 }, (_unused, index) => entry(index));
  const built = buildRosterBridgeSavedWindowTransfer({
    requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 10, issueCount: 0, offset: 0, entries, bounds,
  });
  assert.equal(built.rows, 4, "the existing per-transfer row bound limits the window, honestly stated");
  assert.equal(built.pageCount, 2);
  const decoded = built.frames.map((bytes) => decodeRosterBridgeFrame(bytes, bounds));
  assert.deepEqual(decoded.map((frame) => frame.type), ["saved_window_begin", "saved_window_page", "saved_window_page", "saved_window_end"]);
  const begin = decoded[0];
  assert.ok(begin?.type === "saved_window_begin");
  assert.equal(begin.total, 10, "the full total is stated even though only a prefix is carried");
  assert.equal(begin.rows, 4);
  const carried = decoded.flatMap((frame) => (frame.type === "saved_window_page" ? frame.entries.map((item) => item.entryId) : []));
  assert.deepEqual(carried, ["entry-0", "entry-1", "entry-2", "entry-3"]);

  // The roster packer with the SAME bounds still refuses an over-large snapshot whole.
  const rosterRows = Array.from({ length: 10 }, (_unused, index) => toRemoteSessionMetadata({
    id: `row-${index}`, label: `Row ${index}`, workspace: "/srv/owner", agentDir: "/srv/owner/agent", lifecycle: "alive",
    busy: null, pendingInput: null, inputSurface: false, nativeSession: null, backgroundTasks: null, backgroundShells: null,
    activeTasks: null, activeShells: null, hasLiveProcess: true, activity: [],
  } as unknown as NativeInstanceView));
  assert.throws(() => packRosterBridgePages({ subscriptionId: "s", transferId: "t", rows: rosterRows, bounds }),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "snapshot_too_large");
});

test("an unrepresentable entry ends the prefix instead of being skipped", () => {
  const entries = [entry(0), entry(1), { ...entry(2), cwd: "\ud800" }, entry(3)];
  const built = buildRosterBridgeSavedWindowTransfer({
    requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 4, issueCount: 0, offset: 0, entries,
  });
  assert.equal(built.rows, 2, "entry-3 is never carried past the gap");
  assert.throws(() => buildRosterBridgeSavedWindowTransfer({
    requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 1, issueCount: 0, offset: 0, entries: [{ ...entry(0), file: "\udc00" }],
  }), (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "row_unrepresentable",
  "a window whose first row cannot be carried is refused, never presented as empty");
  assert.throws(() => buildRosterBridgeSavedWindowTransfer({
    requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 1, issueCount: 0, offset: 0, entries: [entry(0), entry(1)],
  }), (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_frame",
  "a window can never claim more rows than its own total allows");

  const empty = buildRosterBridgeSavedWindowTransfer({
    requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 0, issueCount: 0, offset: 0, entries: [],
  });
  assert.equal(empty.rows, 0);
  assert.equal(empty.pageCount, 0);
  assert.equal(empty.frames.length, 2, "an empty result is begin + end, a real fact");
});

test("a legal row too large for one frame is fragmented whole, within the existing bounds", () => {
  const huge = entry(1, {
    file: `C:\\Users\\owner\\${"\\seg \"q\"".repeat(20_000)}.jsonl`,
    cwd: `/srv/${"\u{1f5c2}".repeat(20_000)}`,
    caption: "\u0001control\u2028kept",
  });
  const built = buildRosterBridgeSavedWindowTransfer({
    requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 3, issueCount: 0, offset: 0, entries: [entry(0), huge, entry(2)],
  });
  assert.equal(built.rows, 3);
  assert.ok(built.frames.every((bytes) => bytes.length <= DEFAULT_ROSTER_BRIDGE_BOUNDS.maxFrameBytes));
  const decoded = built.frames.map((bytes) => decodeRosterBridgeFrame(bytes));
  const fragments = decoded.filter((frame) => frame.type === "saved_window_fragment");
  assert.ok(fragments.length >= 2, `the row needed several fragments (${fragments.length})`);
  // Indices are consecutive across pages and fragments, and parts are ordered.
  const indices = decoded.flatMap((frame) =>
    (frame.type === "saved_window_page" || frame.type === "saved_window_fragment" ? [frame.pageIndex] : []));
  assert.deepEqual(indices, Array.from({ length: built.pageCount }, (_unused, index) => index));
  const text = fragments.map((frame) => (frame.type === "saved_window_fragment" ? frame.text : "")).join("");
  assert.deepEqual(decodeRosterBridgeSavedEntryText(text), huge, "the reassembled row is exact and unclipped");

  // A row beyond the whole window byte budget is honestly unrepresentable.
  const small = resolveRosterBridgeBounds({ maxSnapshotBytes: 65_536 });
  assert.throws(() => buildRosterBridgeSavedWindowTransfer({
    requestId: "r-1", hostRunId: RUN, catalogId: "cat-1", resultId: "res-1",
    total: 1, issueCount: 0, offset: 0, entries: [huge], bounds: small,
  }), (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "row_unrepresentable");
});
