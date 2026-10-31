/** Production Main and sidebar UI fences with a scripted coordinator, not TLS/native evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import type { PeerRenameController, PeerRenameOptions, PeerRenameResult, PeerRenameTarget } from "../src/session-host/network/peer-rename";
import type { PeerUiHost } from "../src/session-host/peer-ui-protocol";
import { remotePeerHost, remoteRosterRow } from "./helpers/session-host-main-remote";
import {
  ALT_LEFT, ENTER, FakePeerCoordinator, closeWithSignal, fillForm, nextTurn, peerMainHarness,
  plain, selectedRosterHostLine, type Harness,
} from "./helpers/session-host-main-harness";

class RenamePeer extends FakePeerCoordinator {
  readonly requests: PeerRenameTarget[] = [];
  handler: (target: PeerRenameTarget, options?: PeerRenameOptions) => Promise<PeerRenameResult> = async () => ({ kind: "owner-result", facts: { kind: "renamed" } });
  readonly ownerRename: PeerRenameController = {
    renameSession: async (target, options) => {
      if (options?.stillCurrent?.() !== true) return { kind: "not-sent", reason: "target-unavailable" };
      this.requests.push(target);
      return this.handler(target, options);
    },
  };
}

function host(id = "owner-a", overrides: Partial<PeerUiHost> = {}): PeerUiHost {
  return { ...remotePeerHost({ id, label: id, hostRunId: `run-${id}`, rows: [remoteRosterRow({ id: "native-1",
    label: "Original remote", nativeSession: { sessionId: "conversation-native-1", epoch: 1, name: "Original remote" },
  })] }), renameSupported: true, ...overrides };
}

async function highlight(harness: Harness, label: string): Promise<void> {
  if (harness.sidebar!.focus === "main") harness.terminal.emitInput(ALT_LEFT);
  for (let step = 0; step < 16; step++) {
    if (selectedRosterHostLine(harness).includes(label)) return;
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail(`no drawn ${label} row`);
}

async function open(harness: Harness, label = "owner-a"): Promise<void> {
  await highlight(harness, label);
  harness.terminal.emitInput("e");
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "form");
}

test("remote Edit uses one editor, cancellation changes no name, and success never invents metadata or touches a local collision", async (t) => {
  const peer = new RenamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  fillForm(harness.terminal, "/synthetic/local-collision");
  await nextTurn();
  const localName = harness.manager!.views[0]!.nativeSession!.name;
  peer.publish({ hosts: [host()] });
  await nextTurn();
  await open(harness);
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Original remote"));
  harness.terminal.emitInput("Cancelled");
  harness.terminal.emitInput("\x1b");
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "sidebar");
  assert.equal(peer.requests.length, 0);
  await open(harness);
  harness.terminal.emitInput("New remote");
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.deepEqual(peer.requests, [{ hostId: "owner-a", hostRunId: "run-owner-a", rowId: "native-1",
    expectedSessionId: "conversation-native-1", expectedSessionEpoch: 1, name: "New remote" }]);
  assert.equal(harness.sidebar!.focus, "sidebar");
  assert.equal(harness.manager!.views[0]!.nativeSession!.name, localName);
  assert.deepEqual(harness.manager!.renameCalls, []);
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Original remote"), "a reply alone is never an alias or metadata write");
  const updated = host();
  peer.publish({ hosts: [{ ...updated, roster: { ...updated.roster, rows: updated.roster.rows!.map((row) => ({
    ...row, label: "New remote", nativeSession: { ...row.nativeSession!, name: "New remote" },
  })) } }] });
  await nextTurn();
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("New remote"));
});

test("remote E and submit require actual writer receipts, not held or identical-but-unwritten frames", async (t) => {
  const peer = new RenamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();
  harness.writer.holdWrites = true;
  await highlight(harness, "owner-a");
  harness.terminal.emitInput("e");
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "sidebar", "queued highlight is not the written highlight");
  assert.equal(peer.requests.length, 0);
  harness.writer.drainHeldWrites();
  await nextTurn();
  harness.writer.holdWrites = true;
  const sameText = host();
  peer.publish({ hosts: [{ ...sameText, roster: { ...sameText.roster, rows: sameText.roster.rows!.map((row) => ({
    ...row, nativeSession: { ...row.nativeSession!, epoch: 2 },
  })) } }] });
  await nextTurn();
  harness.terminal.emitInput("e");
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "sidebar", "same rendered name with an unwritten new native tuple grants nothing");
  harness.writer.drainHeldWrites();
  await nextTurn();
  await open(harness);
  harness.writer.holdWrites = true;
  harness.terminal.emitInput("Unwritten draft");
  await nextTurn();
  harness.terminal.setSize(81, 24);
  harness.terminal.setSize(80, 24);
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(peer.requests.length, 0, "queued draft sends nothing");
  harness.writer.drainHeldWrites();
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(peer.requests.length, 1, "only a new deliberate submit of the written draft sends");
});

test("late replies cannot take another owner's draft or a changed selection", async (t) => {
  const peer = new RenamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  fillForm(harness.terminal, "/synthetic/local");
  await nextTurn();
  peer.publish({ hosts: [host(), host("owner-b")] });
  await nextTurn();
  let finish!: (result: PeerRenameResult) => void;
  peer.handler = async () => new Promise<PeerRenameResult>((resolve) => { finish = resolve; });
  await open(harness);
  harness.terminal.emitInput("Delayed A");
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(peer.requests.length, 1);
  harness.terminal.emitInput("\x1b");
  await nextTurn();
  await open(harness, "owner-b");
  harness.terminal.emitInput("B draft");
  await nextTurn();
  finish({ kind: "owner-result", facts: { kind: "renamed" } });
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "form");
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("B draft"));
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(peer.requests.length, 2);
  harness.sidebar!.select(harness.manager!.views[0]!.id);
  finish({ kind: "owner-result", facts: { kind: "renamed" } });
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "form", "a reply after selection changes cannot claim success and close the editor");
  assert.equal(harness.manager!.renameCalls.length, 0);
});

test("unsupported, disconnected, stale and replaced remote identities refuse rather than retarget", async (t) => {
  const peer = new RenamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  for (const patch of [
    { renameSupported: false },
    { state: "disconnected" as const },
    { roster: { ...host().roster, state: "stale" as const } },
    { roster: { ...host().roster, hostRunId: null } },
    { roster: { ...host().roster, rows: [remoteRosterRow({ id: "native-1", nativeSession: null })] } },
  ]) {
    peer.publish({ hosts: [host("owner-a", patch)] });
    await nextTurn();
    await highlight(harness, "owner-a");
    harness.terminal.emitInput("e");
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "sidebar");
    assert.equal(peer.requests.length, 0);
  }
  for (const replacement of [
    host("owner-a", { state: "disconnected" }),
    host("owner-a", { renameSupported: false }),
    host("owner-b"),
    host("owner-a", { roster: { ...host().roster, hostRunId: "replacement-run" } }),
    host("owner-a", { roster: { ...host().roster, rows: [] } }),
    host("owner-a", { roster: { ...host().roster, rows: [remoteRosterRow({ id: "native-1", nativeSession: {
      sessionId: "replacement-native", epoch: 2, name: "Replacement",
    } })] } }),
  ]) {
    peer.publish({ hosts: [host()] });
    await nextTurn();
    await open(harness);
    harness.terminal.emitInput("Must not retarget");
    await nextTurn();
    peer.publish({ hosts: [replacement] });
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(peer.requests.length, 0);
    assert.equal(harness.sidebar!.focus, "form");
    harness.terminal.emitInput("\x1b");
    await nextTurn();
  }
  assert.equal(harness.manager!.renameCalls.length, 0);
});

test("a settled remote refusal or uncertainty preserves the draft but requires a fresh written receipt for a deliberate retry", async (t) => {
  const peer = new RenamePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  peer.publish({ hosts: [host()] });
  await nextTurn();
  await open(harness);
  harness.terminal.emitInput("Retry draft");
  await nextTurn();
  const outcomes: PeerRenameResult[] = [
    { kind: "owner-result", facts: { kind: "refused" } },
    { kind: "owner-result", facts: { kind: "busy" } },
    { kind: "owner-result", facts: { kind: "stale-session" } },
    { kind: "unknown" },
    { kind: "owner-result", facts: { kind: "renamed" } },
  ];
  for (let index = 0; index < outcomes.length; index++) {
    const result = outcomes[index]!;
    peer.handler = async () => result;
    const previousToken = harness.sidebar!.captureEditFormPresentation()!.renderToken;
    harness.terminal.emitInput(ENTER); // a deliberate new attempt, never an automatic replay
    await nextTurn();
    assert.equal(peer.requests.length, index + 1, "unchanged draft is not silently dropped after a settled failure");
    if (index < outcomes.length - 1) {
      assert.equal(harness.sidebar!.focus, "form");
      const text = plain(harness.writer.frames.at(-1)?.frame);
      assert.ok(text.includes("Retry draft"), "the native field retains its draft");
      assert.match(text, /refused|already renaming|native session changed|UNCERTAIN/);
      assert.ok(harness.sidebar!.captureEditFormPresentation()!.renderToken > previousToken,
        "a consumed receipt is not recycled for another send");
      await nextTurn();
      assert.equal(peer.requests.length, index + 1, "no automatic retry after a refusal or uncertainty");
    }
  }
  assert.equal(harness.sidebar!.focus, "sidebar");
  assert.ok(peer.requests.every((request) => request.name === "Retry draft"));
  assert.equal(harness.manager!.renameCalls.length, 0);
});
