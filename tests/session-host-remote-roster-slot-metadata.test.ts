/**
 * Focused coverage for the OPTIONAL owner roster-slot presentation metadata on
 * the remote roster row boundary (#477).
 *
 * Everything here is pure: an in-memory owner row stands in for one manager
 * view, and the only functions under test are the DTO projection and the strict
 * wire decoder. No channel, listener, process, filesystem, or product state is
 * touched.
 *
 * The contract being pinned down:
 * - an unrequested projection is exactly the pre-#477 row, so a peer that never
 *   negotiated the roster-slot capability can never be handed an unknown field;
 * - a negotiated projection carries the owner's existing slot WITHOUT touching
 *   the runtime host/run/row tuple that selection, input, and actions route by;
 * - the slot is bounded opaque text: malformed or out-of-bound slots are refused
 *   whole, never truncated into a different slot;
 * - the closed row schema still refuses every other unknown key.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NativeInstanceView } from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import {
  MAX_REMOTE_ROSTER_SLOT_ID_BYTES,
  MAX_REMOTE_ROSTER_SLOT_ID_CHARS,
  RemoteSessionMetadataError,
  isRemoteSessionMetadataError,
  parseRemoteSessionMetadata,
  toRemoteSessionMetadata,
  type RemoteSessionMetadata,
} from "../src/session-host/network/roster-metadata";

const SECRET_AGENT_DIR = "/Users/owner/.pi/agent";

function nativeSession(id: string, epoch = 2): SessionHostNativeSession {
  return { sessionId: `conversation-${id}`, epoch, name: `Conversation ${id}`, persistence: "saved" };
}

/**
 * One full owner row, including the private fields the boundary must never copy
 * and — when the owner's roster authority has one for this row — the durable
 * roster slot the host already holds (#477).
 */
function ownerRow(
  id: string,
  overrides: Partial<NativeInstanceView> & { rosterSlotId?: string } = {},
): NativeInstanceView {
  const { rosterSlotId, ...rest } = overrides;
  return {
    id,
    label: `Row ${id}`,
    workspace: `/srv/owner/work-${id}`,
    agentDir: SECRET_AGENT_DIR,
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    nativeSession: nativeSession(id),
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    hasLiveProcess: true,
    activity: [],
    ...rest,
    // A real owner row also carries the retained restart binding and the private
    // agent directory; only the allowlisted facts may be copied out.
    lastNativeSession: nativeSession(id),
    ...(rosterSlotId === undefined ? {} : { rosterSlotId }),
  } as NativeInstanceView;
}

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** One projected row as the plain wire-shaped record a decoder would receive. */
function rowRecord(row: RemoteSessionMetadata): Record<string, unknown> {
  return jsonRoundTrip(row) as Record<string, unknown>;
}

function hasSlotKey(row: object): boolean {
  return Object.prototype.hasOwnProperty.call(row, "rosterSlotId");
}

test("an unrequested projection is byte-for-byte the pre-#477 row even when the owner row has a slot", () => {
  const legacy = toRemoteSessionMetadata(ownerRow("row-1"));
  const withSlotAvailable = toRemoteSessionMetadata(ownerRow("row-1", { rosterSlotId: "slot-1" }));
  const explicitFalse = toRemoteSessionMetadata(ownerRow("row-1", { rosterSlotId: "slot-1" }), { rosterSlotId: false });

  assert.equal(hasSlotKey(legacy), false, "no slot key by default");
  assert.equal(hasSlotKey(withSlotAvailable), false, "an owner-side slot never rides along uninvited");
  assert.equal(hasSlotKey(explicitFalse), false, "an unnegotiated channel never carries the field");
  assert.equal(
    JSON.stringify(withSlotAvailable),
    JSON.stringify(legacy),
    "a strict old decoder receives the exact legacy row shape",
  );
});

test("a negotiated projection carries the owner's existing slot and leaves the runtime tuple alone", () => {
  const legacy = toRemoteSessionMetadata(ownerRow("row-1"));
  const negotiated = toRemoteSessionMetadata(ownerRow("row-1", { rosterSlotId: "slot-1" }), { rosterSlotId: true });

  assert.equal(negotiated.rosterSlotId, "slot-1");
  // The runtime host/run/row tuple, the display facts, and every observation are
  // unchanged: the slot is metadata, not a new identity.
  assert.equal(negotiated.id, legacy.id);
  assert.deepEqual({ ...negotiated, rosterSlotId: undefined }, { ...legacy, rosterSlotId: undefined });
  assert.deepEqual(
    Object.keys(negotiated).filter((key) => key !== "rosterSlotId"),
    Object.keys(legacy),
    "the negotiated row is the legacy row plus exactly one optional key",
  );
});

test("a row whose owner has no slot honestly carries none", () => {
  const row = toRemoteSessionMetadata(ownerRow("row-9"), { rosterSlotId: true });
  assert.equal(row.rosterSlotId, undefined);
  assert.equal(hasSlotKey(row), false, "absence is never filled in with a guess or a placeholder");
});

test("the slot survives the strict decoder and a JSON round trip", () => {
  const row = toRemoteSessionMetadata(ownerRow("row-1", { rosterSlotId: "slot-1" }), { rosterSlotId: true });
  const decoded = parseRemoteSessionMetadata(jsonRoundTrip(row));
  assert.ok(decoded);
  assert.deepEqual(decoded, row);
  assert.equal(decoded.rosterSlotId, "slot-1");
  assert.equal(decoded.id, "row-1", "the decoded runtime row id is still the routing identity");
});

test("an absent or null slot decodes as honest absence", () => {
  const base = toRemoteSessionMetadata(ownerRow("row-1"));
  for (const slot of [undefined, null]) {
    const source: Record<string, unknown> = rowRecord(base);
    if (slot === undefined) delete source.rosterSlotId;
    else source.rosterSlotId = null;
    const decoded = parseRemoteSessionMetadata(source);
    assert.ok(decoded, `${String(slot)} is a legal absent slot`);
    assert.equal(hasSlotKey(decoded), false);
    assert.equal(decoded.rosterSlotId, undefined);
  }
});

test("the slot bound is explicit, and the boundary edge is accepted whole", () => {
  assert.equal(MAX_REMOTE_ROSTER_SLOT_ID_CHARS, 128);
  assert.equal(MAX_REMOTE_ROSTER_SLOT_ID_BYTES, MAX_REMOTE_ROSTER_SLOT_ID_CHARS * 4);
  const atBound = "s".repeat(MAX_REMOTE_ROSTER_SLOT_ID_CHARS);
  const row = toRemoteSessionMetadata(ownerRow("row-1", { rosterSlotId: atBound }), { rosterSlotId: true });
  assert.equal(row.rosterSlotId, atBound);
  assert.deepEqual(parseRemoteSessionMetadata(jsonRoundTrip(row)), row, "a legal slot is never clipped");
});

test("an oversized slot is refused whole rather than truncated into a different slot", () => {
  const tooLong = "s".repeat(MAX_REMOTE_ROSTER_SLOT_ID_CHARS + 1);
  let code: string | undefined;
  try {
    toRemoteSessionMetadata(ownerRow("row-1", { rosterSlotId: tooLong }), { rosterSlotId: true });
  } catch (error) {
    assert.ok(isRemoteSessionMetadataError(error));
    code = (error as RemoteSessionMetadataError).code;
  }
  assert.equal(code, "ROSTER_ROW_TOO_LARGE");
  assert.equal(parseRemoteSessionMetadata({
    ...rowRecord(toRemoteSessionMetadata(ownerRow("row-1"))),
    rosterSlotId: tooLong,
  }), null, "the decoder refuses an oversized slot instead of shortening it");
});

test("a malformed slot is refused by both the projection and the decoder", () => {
  const base = rowRecord(toRemoteSessionMetadata(ownerRow("row-1")));
  const malformed: readonly unknown[] = [
    "",
    0,
    42,
    true,
    [],
    {},
    { slotId: "slot-1" },
    "slot\u0007-1",
    "slot\n1",
    "slot\u001f1",
    "slot\u20281",
  ];
  for (const slot of malformed) {
    const label = JSON.stringify(slot);
    assert.equal(parseRemoteSessionMetadata({ ...base, rosterSlotId: slot }), null,
      `the decoder refuses a malformed slot (${label})`);
    let code: string | undefined;
    try {
      toRemoteSessionMetadata(ownerRow("row-1", { rosterSlotId: slot as string }), { rosterSlotId: true });
    } catch (error) {
      assert.ok(isRemoteSessionMetadataError(error), `projection fails with a fixed code (${label})`);
      code = (error as RemoteSessionMetadataError).code;
    }
    assert.equal(code, "ROSTER_ROW_INVALID", `the projection refuses it too (${label})`);
  }
});

test("the closed row schema still refuses every other unknown key", () => {
  const base = rowRecord(toRemoteSessionMetadata(ownerRow("row-1"), { rosterSlotId: true }));
  for (const key of ["rosterSlot", "roster_slot_id", "slotId", "currentFile", "agentDir", "lastNativeSession"]) {
    assert.equal(parseRemoteSessionMetadata({ ...base, [key]: "synthetic" }), null,
      `${key} is not part of the closed schema`);
  }
});

test("slot metadata never makes an otherwise unrepresentable row representable", () => {
  const missingRequired = {
    id: "row-1",
    rosterSlotId: "slot-1",
    label: "Row 1",
    workspace: "/srv/owner/work-1",
  };
  assert.equal(parseRemoteSessionMetadata(missingRequired), null);
});
