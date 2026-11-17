/**
 * Pure contract tests for the applicability declaration on a remote roster row
 * (issue #277 native status slice).
 *
 * Fake owner rows are typed as the real `NativeInstanceView` and every wire value is
 * a real JSON-shaped value; there is no transport, socket, process, filesystem, or
 * provider here. What is pinned: the field is carried ONLY when the owner says the
 * peer negotiated the lane; a negotiated transfer round-trips through the strict
 * decoder; a row with no declaration stays exactly the legacy row; a foreign or
 * malformed declaration is a malformed row rather than a silently dropped field; and
 * an un-negotiated projection is byte-for-byte the pre-native shape, so an older
 * peer's decoder never meets an unknown key and never gains a capability.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NativeInstanceView } from "../src/session-host/instances";
import {
  parseRemoteSessionMetadata,
  toRemoteSessionMetadata,
} from "../src/session-host/network/roster-metadata";

function ownerView(overrides: Partial<NativeInstanceView> = {}): NativeInstanceView {
  return {
    id: "row-1",
    label: "Claude",
    backend: "claude",
    workspace: "/owner/work",
    agentDir: "/owner/.claude",
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    nativeSession: null,
    hasLiveProcess: true,
    activity: [],
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    ...overrides,
  };
}

function jsonRoundTrip(row: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

test("the declaration is carried only when the owner says the peer negotiated it", () => {
  const view = ownerView({
    statusSupport: { input: "unsupported", tasks: "unsupported", shells: "unsupported" },
  });

  // An un-negotiated projection is exactly the pre-native row: no new key at all.
  const legacy = toRemoteSessionMetadata(view);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, "statusSupport"), false,
    JSON.stringify(legacy));
  assert.deepEqual(legacy, toRemoteSessionMetadata(ownerView()),
    "an un-negotiated projection of a declared row is byte-identical to a row with nothing to say");

  // A negotiated projection copies the declaration exactly, with nothing added.
  const carried = toRemoteSessionMetadata(view, { statusSupport: true });
  assert.deepEqual(carried.statusSupport, { input: "unsupported", tasks: "unsupported", shells: "unsupported" });
  assert.ok(Object.isFrozen(carried.statusSupport), "a published declaration cannot be mutated downstream");

  // A row whose observer declared nothing still omits the field on a negotiated
  // channel: absence is honest absence, never an inferred capability.
  const silent = toRemoteSessionMetadata(ownerView(), { statusSupport: true });
  assert.equal(Object.prototype.hasOwnProperty.call(silent, "statusSupport"), false);
});

test("a negotiated declaration round-trips through the strict decoder", () => {
  const row = toRemoteSessionMetadata(ownerView({
    busy: false,
    pendingInput: null,
    activeTasks: 0,
    activeShells: null,
    statusSupport: { agent: "supported", input: "unsupported", tasks: "supported", shells: "unsupported", activity: "unsupported" },
  }), { backend: true, statusSupport: true });
  const decoded = parseRemoteSessionMetadata(jsonRoundTrip(row));
  assert.deepEqual(decoded, row);
  assert.deepEqual(decoded?.statusSupport, {
    agent: "supported", input: "unsupported", tasks: "supported", shells: "unsupported", activity: "unsupported",
  });
  // The observed values keep their own honesty beside the declaration.
  assert.equal(decoded?.busy, false);
  assert.equal(decoded?.pendingInput, null);
  assert.equal(decoded?.activeTasks, 0);
  assert.equal(decoded?.activeShells, null);
});

test("an automatic provider title publishes on the existing label field, with no new protocol", () => {
  // The three states a native row's effective label can be in (issue #690): the
  // provider default, an automatic provider title, and an operator caption. They are
  // the SAME field, so the published row — negotiated or not — has the same keys.
  const providerDefault = toRemoteSessionMetadata(ownerView());
  const automatic = toRemoteSessionMetadata(ownerView({ label: "Investigate the flaky census" }));
  const captioned = toRemoteSessionMetadata(ownerView({ label: "Fleet work" }));

  assert.deepEqual(Object.keys(automatic).sort(), Object.keys(providerDefault).sort(),
    "a provider title adds no field to the published row");
  assert.deepEqual(Object.keys(captioned).sort(), Object.keys(providerDefault).sort(),
    "and neither does a caption");
  assert.equal(automatic.label, "Investigate the flaky census");
  assert.deepEqual(parseRemoteSessionMetadata(jsonRoundTrip(automatic)), automatic,
    "the existing strict decoder accepts the titled row unchanged");

  // A provider title longer than the operator's own caption bound is publishable text:
  // it travels on the label a peer already accepts, whole and unclipped, and the
  // existing strict decoder round-trips it. This is exactly why the manual caption's
  // narrower input bound could not be reused as the title bound.
  const longTitle = "Investigating the census read that raced the " + "generation".repeat(8) + " boundary";
  assert.ok(longTitle.length > 80, "the fixture really is over the manual caption bound");
  const titled = toRemoteSessionMetadata(ownerView({ label: longTitle }));
  assert.deepEqual(Object.keys(titled).sort(), Object.keys(providerDefault).sort());
  assert.deepEqual(parseRemoteSessionMetadata(jsonRoundTrip(titled)), titled,
    "a peer's decoder accepts a long provider title on the existing label field");
  assert.equal(titled.label, longTitle, "and nothing about it is clipped on the way out");

  // A peer that tried to widen the row with a separate title field is refused, not
  // accommodated — the label stays the only name a peer ever receives.
  assert.equal(parseRemoteSessionMetadata({
    ...jsonRoundTrip(automatic),
    conversationTitle: "Investigate the flaky census",
  }), null);
});

test("a legacy row without the field decodes unchanged, and an unknown key still fails closed", () => {
  const legacy = toRemoteSessionMetadata(ownerView());
  const decoded = parseRemoteSessionMetadata(jsonRoundTrip(legacy));
  assert.deepEqual(decoded, legacy);
  assert.equal(decoded?.statusSupport, undefined);

  // A peer that widened the row without negotiating it is caught, not accommodated:
  // the strict decoder rejects the unknown key rather than ignoring it.
  assert.equal(parseRemoteSessionMetadata({
    ...jsonRoundTrip(legacy),
    nativeStatus: { tasks: "unsupported" },
  }), null);
});

test("a malformed declaration is a malformed row, never a field dropped into absence", () => {
  const base = toRemoteSessionMetadata(ownerView(), { statusSupport: true });
  for (const bad of [
    null,
    "unsupported",
    [],
    { tasks: "no" },
    { tasks: null },
    { tasks: 0 },
    { backgroundTasks: "unsupported" },
    { TASKS: "unsupported" },
  ]) {
    const wire = { ...jsonRoundTrip(base), statusSupport: bad };
    assert.equal(parseRemoteSessionMetadata(wire), null,
      `${JSON.stringify(bad)} decoded instead of being refused`);
  }
  // An honest empty declaration is well-formed and decodes as an empty map.
  const empty = parseRemoteSessionMetadata({ ...jsonRoundTrip(base), statusSupport: {} });
  assert.deepEqual(empty?.statusSupport, {});
});
