/**
 * Production Main + sidebar coverage for the separate native HOST ROW NAME lane
 * reached through the EXISTING shared Edit form (issue #277 network slice).
 *
 * A coordinator fake stands in for the network; the manager, sidebar, writer
 * receipts, and action routing are the real ones. What is pinned down:
 * - a remote row the owner TYPES with a native CLI backend is named through the
 *   same shared Edit form, and its submission names the exact owner run, row,
 *   OBSERVED backend, and bounded caption — never a Pi conversation tuple;
 * - a Pi remote row keeps its exact existing tuple-shaped request;
 * - the two intents are never both eligible for the same drawn card, and no
 *   backend is ever inferred from a caption or a missing status;
 * - an owner that does not report the separate native-name capability is refused
 *   truthfully, and neither a Pi rename, a local caption write, nor a reconnect
 *   is substituted;
 * - the owner's four persistence truths stay distinct here, and this side never
 *   claims a saved caption or optimistically rewrites the row's label.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type {
  OwnerNativeRenameFacts,
  OwnerNativeRenameRequest,
  PeerNativeRenameResult,
  PeerRenameController,
  PeerRenameOptions,
  PeerRenameResult,
  PeerRenameTarget,
} from "../src/session-host/network/peer-rename";
import type { PeerUiHost } from "../src/session-host/peer-ui-protocol";
import { remotePeerHost, remoteRosterRow } from "./helpers/session-host-main-remote";
import {
  ALT_LEFT, ENTER, FakePeerCoordinator, closeWithSignal, nextTurn, peerMainHarness, plain,
  type Harness,
} from "./helpers/session-host-main-harness";

const NATIVE_ROW_ID = "native-1";
const PI_ROW_ID = "pi-1";

class NamePeer extends FakePeerCoordinator {
  readonly piRequests: PeerRenameTarget[] = [];
  readonly nativeRequests: OwnerNativeRenameRequest[] = [];
  piHandler: (target: PeerRenameTarget) => Promise<PeerRenameResult> = async () => ({
    kind: "owner-result", facts: { kind: "renamed" },
  });

  nativeHandler: (request: OwnerNativeRenameRequest) => Promise<PeerNativeRenameResult> = async () => ({
    kind: "owner-result", facts: { kind: "renamed-durable" },
  });

  readonly ownerRename: PeerRenameController = {
    renameSession: async (target: PeerRenameTarget, options?: PeerRenameOptions) => {
      if (options?.stillCurrent?.() !== true) return { kind: "not-sent", reason: "target-unavailable" };
      this.piRequests.push(target);
      return this.piHandler(target);
    },
    renameNativeSession: async (
      request: OwnerNativeRenameRequest,
      options?: PeerRenameOptions,
    ) => {
      if (options?.stillCurrent?.() !== true) return { kind: "not-sent", reason: "target-unavailable" };
      this.nativeRequests.push(request);
      return this.nativeHandler(request);
    },
  };
}

/** One owner whose roster carries exactly one row, native-typed or Pi. */
function host(
  id = "owner-a",
  row: RemoteSessionMetadata = remoteRosterRow({
    id: NATIVE_ROW_ID,
    label: "Native owner row",
    backend: "claude",
    nativeSession: null,
  }),
  overrides: Partial<PeerUiHost> = {},
): PeerUiHost {
  return {
    ...remotePeerHost({ id, label: id, hostRunId: `run-${id}`, rows: [row] }),
    renameSupported: true,
    nativeNameSupported: true,
    ...overrides,
  };
}

/** The owner's Pi row, for the unchanged Pi conversation rename control cases. */
function piRow(): RemoteSessionMetadata {
  return remoteRosterRow({
    id: PI_ROW_ID,
    label: "Pi owner row",
    nativeSession: { sessionId: "conversation-pi-1", epoch: 3, name: "Pi owner row" },
  });
}

/**
 * Highlight one drawn remote card and press the shared Edit key.
 *
 * The scan is driven by the sidebar's OWN eligibility facts (`remoteEdit` for a Pi
 * row, `remoteNativeEdit` for a native-typed row) rather than by matching drawn
 * text, so a scan can never "find" a card the sidebar itself would not act on.
 */
/** Highlight one drawn remote card whose eligibility the sidebar currently reports. */
async function highlightOnly(harness: Harness, rowId: string): Promise<void> {
  if (harness.sidebar!.focus === "main") harness.terminal.emitInput(ALT_LEFT);
  const eligible = (): boolean => {
    const shown = harness.sidebar!.captureMousePresentation();
    return shown.remoteEdit?.rowId === rowId || shown.remoteNativeEdit?.rowId === rowId;
  };
  const scan = async (key: string): Promise<boolean> => {
    for (let step = 0; step < 24; step += 1) {
      if (eligible()) return true;
      harness.terminal.emitInput(key);
      await nextTurn();
    }
    return false;
  };
  if (!(await scan("\x1b[B")) && !(await scan("\x1b[A"))) {
    assert.fail(`no eligible drawn remote card ${rowId}: ${JSON.stringify(
      harness.sidebar!.captureMousePresentation().remoteEdit
      ?? harness.sidebar!.captureMousePresentation().remoteNativeEdit ?? null,
    )}`);
  }
}

/** Highlight one drawn remote card and press the shared Edit key. */
async function pressEdit(harness: Harness, rowId: string): Promise<void> {
  await highlightOnly(harness, rowId);
  harness.terminal.emitInput("e");
  await nextTurn();
}

/**
 * Every notice either pane currently draws, with its word wraps rejoined. The
 * shared Edit form draws its own notice inside the form, so both panes are read.
 */
function drawnNotices(harness: Harness): string {
  const rows = harness.writer.frames.at(-1)?.frame.lines
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? [];
  const notices: string[] = [];
  for (const pane of [0, 1] as const) {
    const lines = rows.map((line) => {
      const parts = line.split("\u2502");
      return (pane === 0 ? parts[0] : parts.slice(1).join("\u2502")).replace(/\s+$/, "");
    });
    for (let index = 0; index < lines.length; index += 1) {
      const head = lines[index]!.trim();
      if (!head.startsWith("! ")) continue;
      let joined = head.slice(2).trim();
      for (let next = index + 1; next < lines.length && lines[next]!.trim() !== ""; next += 1) {
        if (lines[next]!.trim().startsWith("! ")) break;
        joined = `${joined} ${lines[next]!.trim()}`;
      }
      notices.push(joined);
    }
  }
  return notices.join(" | ");
}

/** The sidebar pane's drawn text, so footer hints can be read as one string. */
function drawnSidebar(harness: Harness): string {
  const rows = harness.writer.frames.at(-1)?.frame.lines
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? [];
  return rows.map((line) => (line.split("\u2502")[0] ?? "").trimEnd()).join("\n");
}

test("an eligible native remote card advertises the edit-name affordance", async (t) => {
  const peer = new NamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();
  await highlightOnly(harness, NATIVE_ROW_ID);
  // The hint is the operator's only signal that `e` names THIS card, and the native
  // lane has its own eligibility, so it must advertise on its own facts.
  assert.ok(drawnSidebar(harness).includes("e edit name"),
    `a nameable native card shows the edit hint: ${JSON.stringify(drawnSidebar(harness))}`);

  // The same card, on an owner that does not report the separate native-name lane
  // and carries no Pi conversation tuple either, advertises nothing it would
  // refuse. Neither lane is inferred from the other or from the caption.
  peer.publish({ hosts: [host("owner-a", undefined, { nativeNameSupported: false })] });
  await nextTurn();
  assert.ok(!drawnSidebar(harness).includes("e edit name"),
    `an owner with neither naming lane shows no edit hint: ${JSON.stringify(drawnSidebar(harness))}`);
});

test("a native-typed remote row is named through the shared Edit form with no Pi tuple", async (t) => {
  const peer = new NamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();

  await pressEdit(harness, NATIVE_ROW_ID);
  assert.equal(harness.sidebar!.focus, "form", "the SAME shared Edit form opens");
  harness.terminal.emitInput("Renamed on the host");
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();

  assert.deepEqual(peer.nativeRequests, [{
    hostId: "owner-a",
    hostRunId: "run-owner-a",
    rowId: NATIVE_ROW_ID,
    backend: "claude",
    name: "Renamed on the host",
  }], "the exact run, row, OBSERVED backend, and verbatim caption are requested");
  assert.deepEqual(peer.piRequests, [], "a native row never becomes a Pi conversation rename");
  // This side never rewrites the caption from its own cache: only a later owner
  // observation can carry a renamed row.
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Native owner row"),
    `the caption stays the owner's until a new observation: ${plain(harness.writer.frames.at(-1)?.frame)}`);
});

test("a Pi remote row keeps its exact existing tuple-shaped request", async (t) => {
  const peer = new NamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host("owner-a", piRow())] });
  await nextTurn();

  await pressEdit(harness, PI_ROW_ID);
  assert.equal(harness.sidebar!.focus, "form");
  harness.terminal.emitInput("Renamed conversation");
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();

  assert.deepEqual(peer.piRequests, [{
    hostId: "owner-a",
    hostRunId: "run-owner-a",
    rowId: PI_ROW_ID,
    expectedSessionId: "conversation-pi-1",
    expectedSessionEpoch: 3,
    name: "Renamed conversation",
  }], "the Pi rename shape is unchanged");
  assert.deepEqual(peer.nativeRequests, [], "a Pi row is never a native host-name request");
});

test("an owner without the native-name capability is refused, and no Pi rename is substituted", async (t) => {
  const peer = new NamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();
  // Establish the highlight while the owner still reports the lane, then withdraw
  // the description: the SAME highlighted card must now refuse.
  await highlightOnly(harness, NATIVE_ROW_ID);
  peer.publish({ hosts: [host("owner-a", undefined, { nativeNameSupported: false })] });
  await nextTurn();
  harness.terminal.emitInput("e");
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "sidebar", "no editor opens for a refused intent");
  assert.deepEqual(peer.nativeRequests, []);
  assert.deepEqual(peer.piRequests, [], "the Pi conversation rename is never a fallback");
  assert.ok(drawnNotices(harness).includes("does not offer naming a native session row"),
    `the refusal is stated: ${drawnNotices(harness)}`);
});

test("a row with no reported backend is never treated as native from its caption", async (t) => {
  const peer = new NamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  const untyped = host();
  const rows = untyped.roster.rows!.map((row) => ({ ...row, backend: undefined }));
  peer.publish({ hosts: [host()] });
  await nextTurn();
  // Highlight while the row IS typed, then withdraw the owner's backend fact on the
  // very same row: eligibility must come from the current typed observation only.
  await highlightOnly(harness, NATIVE_ROW_ID);
  peer.publish({ hosts: [{ ...untyped, roster: { ...untyped.roster, rows } }] });
  await nextTurn();
  harness.terminal.emitInput("e");
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "sidebar",
    "a missing backend is not a native row, and it has no Pi tuple either");
  assert.deepEqual(peer.nativeRequests, []);
  assert.deepEqual(peer.piRequests, []);
});

test("the owner's four persistence truths stay distinct and never claim a saved caption", async (t) => {
  const cases: readonly {
    readonly facts: OwnerNativeRenameFacts;
    readonly expects: string;
    readonly forbids?: string;
    readonly closes: boolean;
  }[] = [
    { facts: { kind: "renamed-durable" }, expects: "", closes: true },
    {
      facts: { kind: "renamed-in-memory" },
      expects: "Named on the host, but the host could not confirm it was saved",
      closes: true,
    },
    { facts: { kind: "refused" }, expects: "refused this row name", closes: false },
    { facts: { kind: "unknown" }, expects: "UNCERTAIN", closes: false },
  ];
  for (const testCase of cases) {
    const peer = new NamePeer();
    peer.nativeHandler = async () => ({ kind: "owner-result", facts: testCase.facts });
    const { harness } = await peerMainHarness(t, undefined, {}, peer);
    t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
    peer.publish({ hosts: [host()] });
    await nextTurn();
    await pressEdit(harness, NATIVE_ROW_ID);
    harness.terminal.emitInput("A caption");
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(peer.nativeRequests.length, 1, `${testCase.facts.kind}: sent once`);
    assert.equal(harness.sidebar!.focus, testCase.closes ? "sidebar" : "form",
      `${testCase.facts.kind}: ${testCase.closes ? "closes" : "keeps the draft"}`);
    const notices = drawnNotices(harness);
    if (testCase.expects.length > 0) {
      assert.ok(notices.includes(testCase.expects),
        `${testCase.facts.kind}: ${testCase.expects} — ${notices}`);
    } else {
      assert.equal(notices, "", `${testCase.facts.kind}: a durable fact needs no extra notice`);
    }
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Native owner row"),
      `${testCase.facts.kind}: this side never optimistically rewrites the caption`);
    // Nothing is replayed by this side on its own.
    await nextTurn();
    assert.equal(peer.nativeRequests.length, 1, `${testCase.facts.kind}: never replayed`);
  }
});

test("a native host name that was never sent keeps the draft and sends nothing", async (t) => {
  const peer = new NamePeer();
  peer.nativeHandler = async () => ({ kind: "not-sent", reason: "capability-unsupported" });
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();
  await pressEdit(harness, NATIVE_ROW_ID);
  harness.terminal.emitInput("Held draft");
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "form", "a not-sent answer keeps the operator's draft");
  assert.equal(peer.nativeRequests.length, 1);
  // The narrow form pane truncates, so the assertion uses the longest prefix the
  // operator can actually read.
  assert.ok(drawnNotices(harness).includes("does not offer naming a native"),
    drawnNotices(harness));
});

test("a native Edit target that moved while the form was open submits nothing", async (t) => {
  const peer = new NamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();
  await pressEdit(harness, NATIVE_ROW_ID);
  harness.terminal.emitInput("Draft");
  await nextTurn();
  // The owner replaces its run: the frozen target is no longer a current row.
  const moved = host();
  peer.publish({ hosts: [{ ...moved, roster: { ...moved.roster, hostRunId: "run-owner-b" } }] });
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.deepEqual(peer.nativeRequests, [], "a replaced owner run never receives the caption");
  assert.deepEqual(peer.piRequests, [], "and it is never answered by a Pi rename");
});

test("cancelling a native Edit changes no name and requests nothing", async (t) => {
  const peer = new NamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();
  await pressEdit(harness, NATIVE_ROW_ID);
  harness.terminal.emitInput("Discarded");
  await nextTurn();
  harness.terminal.emitInput("\x1b");
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "sidebar");
  assert.deepEqual(peer.nativeRequests, []);
  assert.deepEqual(peer.piRequests, []);
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Native owner row"));
});
