import assert from "node:assert/strict";
import test from "node:test";

import {
  PresentationRoster,
  type LocalPresentationIdentity,
  type PresentationEntry,
  type PresentationIdentity,
  type RemotePresentationIdentity,
  type RemotePresentationOwnerKind,
} from "../src/session-host/presentation-roster";

/**
 * Focused hermetic tests for the canonical mixed presentation roster model.
 * The model is pure: no IO, no processes, no fixtures on disk, no ambient
 * configuration. Local payloads here are synthetic records shaped like Main's
 * remembered roster records.
 */

interface TestRecord {
  readonly slotId: string;
  rowId?: string;
  name?: string;
  persistence?: "saved" | "unsaved" | "unknown";
}

function localRecord(slotId: string, extra: Omit<TestRecord, "slotId"> = {}): TestRecord {
  return { slotId, ...extra };
}

function local(slotId: string): LocalPresentationIdentity {
  return { kind: "local", slotId };
}

function remote(hostId: string, kind: RemotePresentationOwnerKind, id: string): RemotePresentationIdentity {
  return { kind: "remote", hostId, owner: { kind, id } };
}

/** Human-readable canonical order: kind-qualified so kinds never blur together. */
function order(roster: PresentationRoster<TestRecord>): string[] {
  return roster.identities().map((identity) => identity.kind === "local"
    ? `local:${identity.slotId}`
    : `remote:${identity.hostId}/${identity.owner.kind}:${identity.owner.id}`);
}

function build(initial: readonly string[]): PresentationRoster<TestRecord> {
  const roster = new PresentationRoster<TestRecord>();
  for (const slotId of initial) assert.equal(roster.setLocal(localRecord(slotId)), true);
  return roster;
}

test("local slots and multiple remote hosts interleave in one sequence", () => {
  const roster = new PresentationRoster<TestRecord>();
  roster.setLocal(localRecord("A"));
  roster.rememberRemote(remote("host-1", "slot", "B"));
  roster.setLocal(localRecord("C"));
  roster.rememberRemote(remote("host-2", "slot", "D"));
  assert.deepEqual(order(roster), ["local:A", "remote:host-1/slot:B", "local:C", "remote:host-2/slot:D"]);

  // The agreed example: B moves before A, host-independent of any grouping.
  assert.equal(roster.move(remote("host-1", "slot", "B"), local("A"), "before"), true);
  assert.deepEqual(order(roster), ["remote:host-1/slot:B", "local:A", "local:C", "remote:host-2/slot:D"]);
  assert.equal(roster.size, 4);
});

test("movement is host-independent in both directions, never wraps, never duplicates", () => {
  const roster = new PresentationRoster<TestRecord>();
  roster.setLocal(localRecord("A"));
  roster.rememberRemote(remote("host-1", "slot", "B"));
  roster.setLocal(localRecord("C"));
  roster.rememberRemote(remote("host-2", "slot", "D"));

  // Remote entry moves across a local entry and past another host's entry.
  assert.equal(roster.move(remote("host-2", "slot", "D"), remote("host-1", "slot", "B"), "after"), true);
  assert.deepEqual(order(roster), ["local:A", "remote:host-1/slot:B", "remote:host-2/slot:D", "local:C"]);

  // Local entry moves after a remote entry on a different host.
  assert.equal(roster.move(local("A"), remote("host-2", "slot", "D"), "after"), true);
  assert.deepEqual(order(roster), ["remote:host-1/slot:B", "remote:host-2/slot:D", "local:A", "local:C"]);

  // Last to front and front to back: no wrapping, no phantom positions.
  assert.equal(roster.move(local("C"), remote("host-1", "slot", "B"), "before"), true);
  assert.deepEqual(order(roster), ["local:C", "remote:host-1/slot:B", "remote:host-2/slot:D", "local:A"]);
  assert.equal(roster.move(local("C"), local("A"), "after"), true);
  assert.deepEqual(order(roster), ["remote:host-1/slot:B", "remote:host-2/slot:D", "local:A", "local:C"]);

  // Moving an entry next to itself is a refusal, not a rotation.
  assert.equal(roster.move(local("A"), local("A"), "before"), false);
  assert.equal(roster.move(remote("host-1", "slot", "B"), remote("host-1", "slot", "B"), "after"), false);
  assert.deepEqual(order(roster), ["remote:host-1/slot:B", "remote:host-2/slot:D", "local:A", "local:C"]);
  assert.equal(roster.size, 4);
});

test("movement with a missing or malformed source or target leaves the order untouched", () => {
  const roster = build(["A", "C"]);
  roster.rememberRemote(remote("host-1", "slot", "B"));
  const before = order(roster);

  assert.equal(roster.move(local("missing"), local("A"), "before"), false);
  assert.equal(roster.move(local("A"), local("missing"), "after"), false);
  assert.equal(roster.move(remote("host-9", "slot", "B"), local("A"), "before"), false);
  assert.equal(roster.move(local("A"), remote("host-1", "runtime", "B"), "after"), false);
  assert.equal(roster.move({ kind: "local", slotId: "" }, local("A"), "before"), false);
  assert.equal(roster.move(local("A"), { kind: "remote", hostId: "host-1", owner: { kind: "unknown" as RemotePresentationOwnerKind, id: "B" } }, "before"), false);
  assert.equal(roster.move(local("A"), local("C"), "sideways" as "before"), false);

  assert.deepEqual(order(roster), before);
  assert.equal(roster.size, 3);
});

test("a new identity appends once and an existing identity keeps its exact location", () => {
  const roster = build(["A"]);
  roster.rememberRemote(remote("host-1", "slot", "B"));
  roster.setLocal(localRecord("C"));

  // New local slot appends at the end.
  assert.equal(roster.setLocal(localRecord("D")), true);
  assert.deepEqual(order(roster), ["local:A", "remote:host-1/slot:B", "local:C", "local:D"]);

  // Same local slot: payload updated, position unchanged.
  assert.equal(roster.setLocal(localRecord("A", { name: "renamed" })), true);
  assert.deepEqual(order(roster), ["local:A", "remote:host-1/slot:B", "local:C", "local:D"]);
  assert.equal(roster.getLocal("A")?.name, "renamed");
  assert.equal(roster.size, 4);

  // Same durable remote slot: matching return changes nothing at all.
  assert.equal(roster.rememberRemote(remote("host-1", "slot", "B")), false);
  assert.deepEqual(order(roster), ["local:A", "remote:host-1/slot:B", "local:C", "local:D"]);
  assert.equal(roster.size, 4);
});

test("local payloads stay mutable by reference and remote entries carry identity only", () => {
  const roster = new PresentationRoster<TestRecord>();
  const record = localRecord("A", { rowId: "row-1" });
  roster.setLocal(record);
  roster.rememberRemote(remote("host-1", "slot", "B"));

  // Existing Main record usage mutates fields in place; the roster sees it.
  record.rowId = "row-2";
  record.persistence = "saved";
  assert.equal(roster.getLocal("A"), record);
  assert.equal(roster.localRecords()[0], record);
  const entries = roster.entries();
  const localEntry = entries[0];
  assert.equal(localEntry.kind, "local");
  if (localEntry.kind === "local") {
    assert.equal(localEntry.identity.slotId, "A");
    assert.equal(localEntry.record, record);
    assert.equal(localEntry.record.rowId, "row-2");
  }

  // A remote entry has no cached roster facts, runtime row, or action tuple.
  assert.deepEqual(Object.keys(entries[1]).sort(), ["identity", "kind"]);
  assert.deepEqual(entries[1], {
    kind: "remote",
    identity: { kind: "remote", hostId: "host-1", owner: { kind: "slot", id: "B" } },
  });
  assert.deepEqual(roster.localEntries().map((entry) => entry.identity.slotId), ["A"]);
});

test("identity snapshots are frozen and independent of the caller's objects", () => {
  const roster = new PresentationRoster<TestRecord>();
  const owner = { kind: "slot" as RemotePresentationOwnerKind, id: "B" };
  const identity = { kind: "remote" as const, hostId: "host-1", owner };
  roster.rememberRemote(identity);

  // A later mutation of the caller's own objects cannot rewrite the roster.
  owner.id = "mutated";
  (identity as { hostId: string }).hostId = "host-9";
  assert.deepEqual(order(roster), ["remote:host-1/slot:B"]);
  assert.equal(roster.has(remote("host-1", "slot", "B")), true);
  assert.equal(roster.has(remote("host-9", "slot", "mutated")), false);

  for (const entry of roster.entries()) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.identity), true);
    if (entry.kind === "remote") assert.equal(Object.isFrozen(entry.identity.owner), true);
  }
});

test("local, remote, multi-host, and owner-kind identities can never collide", () => {
  const roster = new PresentationRoster<TestRecord>();
  const slotIds = [
    "x",
    // The literal JSON text of another identity's key must stay a plain local id.
    '["remote","host-1","slot","x"]',
    'host-1","slot","x',
    'host-1","slot","x","junk',
    "a,b",
    "a:b:c",
    "host-1/slot/x",
    "😀",
    "  ",
    "line\nseparator",
    "rtl-\u202e-id",
  ];
  for (const slotId of slotIds) assert.equal(roster.setLocal(localRecord(slotId)), true);

  const identities: RemotePresentationIdentity[] = [
    remote("host-1", "slot", "x"),
    remote("host-1", "runtime", "x"),
    remote("host-2", "slot", "x"),
    remote("host-2", "runtime", "x"),
    // Separator and quote content inside host and owner ids.
    remote('host-1","slot', "slot", 'x","runtime'),
    remote("host-1", "slot", '["local","x"]'),
    remote("😀host", "slot", "😀id"),
    remote("rtl-\u202ehost", "runtime", "rtl-\u202eid"),
  ];
  for (const identity of identities) assert.equal(roster.rememberRemote(identity), true);

  // One empty host id is refused outright rather than folded into another entry.
  assert.equal(roster.rememberRemote(remote("", "slot", "x")), false);

  assert.equal(roster.size, slotIds.length + identities.length);
  for (const slotId of slotIds) {
    assert.equal(roster.has(local(slotId)), true);
    assert.equal(roster.getLocal(slotId)?.slotId, slotId);
  }
  for (const identity of identities) assert.equal(roster.has(identity), true);

  // Keys are per-identity and distinct across every kind combination.
  const keys = new Set<string>();
  for (const identity of [...slotIds.map(local), ...identities]) {
    const key = roster.keyOf(identity);
    assert.equal(typeof key, "string");
    assert.equal(keys.has(key as string), false);
    keys.add(key as string);
  }
  assert.equal(keys.size, slotIds.length + identities.length);
  assert.notStrictEqual(roster.keyOf(local("x")), roster.keyOf(remote("host-1", "slot", "x")));
  assert.notStrictEqual(roster.keyOf(remote("host-1", "slot", "x")), roster.keyOf(remote("host-1", "runtime", "x")));
  assert.notStrictEqual(roster.keyOf(remote("host-1", "slot", "x")), roster.keyOf(remote("host-2", "slot", "x")));

  // Removing one local slot touches only that local slot.
  assert.equal(roster.deleteLocal("x"), true);
  assert.equal(roster.deleteLocal('["remote","host-1","slot","x"]'), true);
  assert.equal(roster.deleteLocal("x"), false);
  assert.equal(roster.has(local("x")), false);
  assert.equal(roster.has(remote("host-1", "slot", "x")), true);
  assert.equal(roster.has(remote("host-2", "runtime", "x")), true);
  assert.equal(roster.size, slotIds.length + identities.length - 2);
  assert.equal(roster.keyOf(local("x")), undefined);
});

test("durable remote slot identity and legacy runtime row identity stay distinct", () => {
  const roster = new PresentationRoster<TestRecord>();
  roster.setLocal(localRecord("A"));
  roster.rememberRemote(remote("host-1", "runtime", "row-1"));
  roster.rememberRemote(remote("host-1", "slot", "row-1"));
  assert.deepEqual(order(roster), ["local:A", "remote:host-1/runtime:row-1", "remote:host-1/slot:row-1"]);

  // Moving one of them never moves the other.
  assert.equal(roster.move(remote("host-1", "slot", "row-1"), local("A"), "before"), true);
  assert.deepEqual(order(roster), ["remote:host-1/slot:row-1", "local:A", "remote:host-1/runtime:row-1"]);

  // A regenerated runtime row id is a NEW appended entry; nothing is guessed
  // onto the durable slot or the retired runtime entry.
  assert.equal(roster.rememberRemote(remote("host-1", "runtime", "row-2")), true);
  assert.deepEqual(order(roster), [
    "remote:host-1/slot:row-1",
    "local:A",
    "remote:host-1/runtime:row-1",
    "remote:host-1/runtime:row-2",
  ]);

  // A native /new or /resume keeps the local slot's position.
  roster.setLocal(localRecord("A", { rowId: "row-9", name: "after resume" }));
  assert.deepEqual(order(roster), [
    "remote:host-1/slot:row-1",
    "local:A",
    "remote:host-1/runtime:row-1",
    "remote:host-1/runtime:row-2",
  ]);
});

test("absent remote identities stay in the canonical sequence", () => {
  const roster = build(["A"]);
  roster.rememberRemote(remote("host-1", "slot", "B"));
  roster.setLocal(localRecord("C"));
  const before = order(roster);

  // Nothing in this model removes a remote identity: no expiry, no cleanup, no
  // hiding it because no row currently matches.
  assert.equal(roster.deleteLocal("B"), false);
  assert.equal(roster.has(remote("host-1", "slot", "B")), true);
  assert.deepEqual(order(roster), before);
  assert.deepEqual(roster.localRecords().map((record) => record.slotId), ["A", "C"]);

  // A removed local slot is gone; re-observing it is a new first observation
  // and therefore appends.
  assert.equal(roster.deleteLocal("A"), true);
  assert.deepEqual(order(roster), ["remote:host-1/slot:B", "local:C"]);
  assert.equal(roster.setLocal(localRecord("A")), true);
  assert.deepEqual(order(roster), ["remote:host-1/slot:B", "local:C", "local:A"]);
});

test("hydrate replaces the sequence from ordered entries and round-trips exactly", () => {
  const source = new PresentationRoster<TestRecord>();
  const recordA = localRecord("A", { rowId: "row-A" });
  const recordC = localRecord("C");
  source.setLocal(recordA);
  source.rememberRemote(remote("host-1", "slot", "B"));
  source.setLocal(recordC);
  source.rememberRemote(remote("host-2", "runtime", "D"));
  assert.equal(source.move(local("C"), remote("host-1", "slot", "B"), "before"), true);
  const snapshot = source.entries();

  const restored = new PresentationRoster<TestRecord>();
  restored.setLocal(localRecord("stale"));
  assert.equal(restored.hydrate(snapshot), true);
  assert.deepEqual(order(restored), order(source));
  assert.equal(restored.size, 4);
  // Records are adopted by reference: the original caller objects stay canonical.
  assert.equal(restored.getLocal("A"), recordA);
  assert.equal(restored.getLocal("C"), recordC);
  assert.equal(restored.has(remote("host-2", "runtime", "D")), true);
  assert.equal(restored.has(local("stale")), false);

  // Round-trip stability: hydrating the restored projection changes nothing.
  assert.equal(restored.hydrate(restored.entries()), true);
  assert.deepEqual(order(restored), order(source));
  assert.deepEqual(restored.entries(), snapshot);

  // Empty hydration is a legitimate empty sequence.
  const cleared = new PresentationRoster<TestRecord>();
  cleared.setLocal(localRecord("A"));
  assert.equal(cleared.hydrate([]), true);
  assert.equal(cleared.size, 0);
});

test("hydration refuses malformed or duplicate input atomically", () => {
  const roster = new PresentationRoster<TestRecord>();
  roster.setLocal(localRecord("A"));
  roster.rememberRemote(remote("host-1", "slot", "B"));
  const before = order(roster);

  const duplicates: PresentationEntry<TestRecord>[] = [
    { kind: "local", identity: local("A"), record: localRecord("A") },
    { kind: "local", identity: local("A"), record: localRecord("A", { name: "second" }) },
  ];
  assert.equal(roster.hydrate(duplicates), false);

  const crossKind: PresentationEntry<TestRecord>[] = [
    { kind: "local", identity: local("x"), record: localRecord("x") },
    { kind: "remote", identity: remote("host-1", "slot", "x") },
    { kind: "remote", identity: remote("host-1", "slot", "x") },
  ];
  assert.equal(roster.hydrate(crossKind), false);

  const malformed = [
    { kind: "local", identity: local("A"), record: { slotId: "" } },
    { kind: "remote", identity: { kind: "remote", hostId: "", owner: { kind: "slot", id: "B" } } },
    { kind: "remote", identity: { kind: "remote", hostId: "host-1", owner: { kind: "bogus", id: "B" } } },
    { kind: "remote", identity: { kind: "remote", hostId: "host-1" } },
    { kind: "bogus" },
  ];
  for (const entry of malformed) {
    assert.equal(roster.hydrate([entry] as unknown as PresentationEntry<TestRecord>[]), false);
  }

  // A refused hydration is total: nothing partial was applied.
  assert.deepEqual(order(roster), before);
  assert.equal(roster.size, 2);
});

test("malformed local records and remote identities are refused without change", () => {
  const roster = build(["A"]);
  roster.rememberRemote(remote("host-1", "slot", "B"));
  const before = order(roster);

  assert.equal(roster.setLocal({ slotId: "" }), false);
  assert.equal(roster.setLocal({} as TestRecord), false);
  assert.equal(roster.setLocal(undefined as unknown as TestRecord), false);
  assert.equal(roster.rememberRemote({ kind: "remote", hostId: "host-1", owner: { kind: "slot", id: "" } }), false);
  assert.equal(roster.rememberRemote({ kind: "remote", hostId: "host-1", owner: { kind: "slot" } } as unknown as RemotePresentationIdentity), false);
  assert.equal(roster.rememberRemote({ kind: "remote", hostId: "host-1" } as unknown as RemotePresentationIdentity), false);
  assert.equal(roster.rememberRemote({ kind: "local", slotId: "B" } as unknown as RemotePresentationIdentity), false);
  assert.equal(roster.getLocal(""), undefined);
  assert.equal(roster.deleteLocal(""), false);
  assert.equal(roster.has({ kind: "bogus" } as unknown as PresentationIdentity), false);

  assert.deepEqual(order(roster), before);
  assert.equal(roster.size, 2);
});

test("ordered projections are derived, never a second stored sequence", () => {
  const roster = new PresentationRoster<TestRecord>();
  roster.setLocal(localRecord("A"));
  roster.rememberRemote(remote("host-1", "slot", "B"));
  roster.setLocal(localRecord("C"));

  const first = order(roster);
  const firstEntries = roster.entries();
  const firstLocal = roster.localEntries();
  const firstRecords = roster.localRecords();

  assert.equal(roster.move(local("C"), local("A"), "before"), true);

  // Every projection reflects the one canonical sequence; previously returned
  // snapshots are caller-owned values, not live views of a second store.
  assert.deepEqual(order(roster), ["local:C", "local:A", "remote:host-1/slot:B"]);
  assert.deepEqual(roster.localEntries().map((entry) => entry.identity.slotId), ["C", "A"]);
  assert.deepEqual(roster.localRecords().map((record) => record.slotId), ["C", "A"]);
  assert.deepEqual(first, ["local:A", "remote:host-1/slot:B", "local:C"]);
  assert.equal(firstEntries.length, 3);
  assert.deepEqual(firstLocal.map((entry) => entry.identity.slotId), ["A", "C"]);
  assert.deepEqual(firstRecords.map((record) => record.slotId), ["A", "C"]);
  assert.equal(roster.size, 3);
});
