/**
 * Main remote native input / text copy.
 *
 * These cases exercise the default-on native IO bridge, per-viewer Remote
 * input/copy policy, actual-written input authority, and copy/resize/startup
 * behavior. All fixtures are controlled DTOs and owned fakes from the shared
 * Main harness; no real peer, transport, child, PTY, or physical clipboard is
 * involved. A "submitted" result is only ever local transport return, never
 * proof the remote child processed it.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import type { NativeInputSendResult } from "../src/session-host/network/session-content-client";
import {
  isNativeIoStartupSource,
  type NativeIoSource,
} from "../src/session-host/network/session-content-protocol";
import type { TerminalInputModes } from "../src/session-host/terminal-surface";

import { sidebarNoticeRows } from "./helpers/session-host-notice-witness";
import {
  ALT_LEFT,
  ENTER,
  ESC,
  closeWithSignal,
  emitMouse,
  nextTurn,
  peerMainHarness,
  plain,
  plainLine,
} from "./helpers/session-host-main-harness";
import {
  REMOTE_INPUT_MODES,
  REMOTE_INPUT_NOT_SENT_NOTICE,
  REMOTE_INPUT_PASTE_TOO_LARGE_NOTICE,
  REMOTE_INPUT_UNCERTAIN_NOTICE,
  REMOTE_INPUT_VIEWER_OFF_NOTICE,
  harnessManager,
  remoteContentMainHarness,
  remoteInputProof,
  remoteNativeInputHarness,
  remoteNativeSource,
  remotePeerHost,
  remoteRosterRow,
  remoteStartupInputHarness,
  remoteViewport,
} from "./helpers/session-host-main-remote";

test("production Main wires native IO by default and only the explicit-false legacy seam keeps it inert", async (t) => {
  const hosts = [
    remotePeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a", rows: [remoteRosterRow({ id: "row-a" })] }),
  ];
  // Absent dependency: the production default, with no injected opt-in at all.
  const defaulted = await remoteContentMainHarness(t, hosts);
  try {
    assert.equal(harnessManager(defaulted.harness).options.nativeInputOriginFraming, true,
      "children created by the production default use strict authenticated framing");
    assert.equal(typeof defaulted.peer.options?.nativeIo?.authorizeInput, "function",
      "the default supplies the coordinator's dynamic written-source proof");
    assert.equal(typeof defaulted.peer.options?.nativeIo?.onCopy, "function",
      "the default supplies the initiating-viewer copy callback");
  } finally {
    assert.equal(await closeWithSignal(defaulted.harness), 0);
  }

  const explicitOn = await remoteContentMainHarness(t, hosts, { nativeInputOriginFraming: true });
  try {
    assert.equal(harnessManager(explicitOn.harness).options.nativeInputOriginFraming, true);
    assert.equal(typeof explicitOn.peer.options?.nativeIo?.authorizeInput, "function");
  } finally {
    assert.equal(await closeWithSignal(explicitOn.harness), 0);
  }

  // The dependency-only legacy test seam: explicit false keeps the old shape.
  const legacy = await remoteContentMainHarness(t, hosts, { nativeInputOriginFraming: false });
  try {
    assert.equal(legacy.peer.options?.nativeIo, undefined,
      "the explicit-false seam gives the coordinator no native input/copy callbacks");
    assert.equal(harnessManager(legacy.harness).options.nativeInputOriginFraming, undefined,
      "the explicit-false seam keeps the legacy manager call shape");
  } finally {
    assert.equal(await closeWithSignal(legacy.harness), 0);
  }
});

test("viewer Remote input/copy Off refuses this viewer's input and copies while owner framing stays on", async (t) => {
  const { harness, peer, content, manager, source, generation, rect } = await remoteNativeInputHarness(t);
  try {
    assert.equal(content.deliveredInputs.length, 0);
    harness.terminal.emitInput("a");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1, "the production default forwards typing");

    // Only this viewer's saved preference changes; nothing restarts or reconnects.
    content.setViewerInput(false);
    peer.publish({ settings: { ...peer.snapshot.settings!, viewerNativeInputEnabled: false } });
    await nextTurn();
    const localWrites = manager.writes.length;
    const terminalWrites = harness.terminal.writes.length;
    harness.terminal.emitInput("b");
    harness.terminal.emitInput(`${ESC}[200~paste${ESC}[201~`);
    emitMouse(harness.terminal, rect.column + 2, rect.row + 3);
    await nextTurn();
    assert.equal(content.inputRequests.length, 1, "nothing is even offered to the delegate while Off");
    assert.equal(content.deliveredInputs.length, 1);
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame),
      REMOTE_INPUT_VIEWER_OFF_NOTICE) !== undefined,
    "the refusal is one brief fixed notice, not a dialog or a silent local fallback");
    assert.equal(harness.sidebar!.focus, "main", "Off never moves focus");
    assert.equal(manager.writes.length, localWrites, "Off never reroutes input to a local row");

    content.deliverCopy({
      subscriptionId: "sub-a",
      copyId: "copy-off",
      sequence: 1,
      source,
      dispatchId: 1,
      event: {
        kind: "copy",
        encoded: "b2Zm",
        sessionId: source.nativeSession.sessionId,
        sessionEpoch: source.nativeSession.epoch,
      },
      hostId: "lab-a",
      selectionGeneration: generation,
    });
    assert.equal(harness.terminal.writes.includes(`${ESC}]52;c;b2Zm\x07`), false,
      "a completed copy writes no clipboard request while Off");
    assert.equal(harness.terminal.writes.slice(terminalWrites).some((write) => write.includes("]52;")), false);

    // The owner-side bridge and the coordinator capability are immutable.
    assert.equal(manager.options.nativeInputOriginFraming, true, "owner framing is never toggled by the viewer");
    assert.equal(typeof peer.options?.nativeIo?.authorizeInput, "function");
    assert.equal(peer.commands.some((command) => command.type === "peer-disconnect"), false);
    assert.equal(peer.closeCalls, 0, "the coordinator is never restarted to apply the preference");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("Main forwards the two distinct Network setting actions to the one coordinator unchanged", async (t) => {
  const { harness, peer, dispatch } = await peerMainHarness(t);
  try {
    dispatch({ type: "peer-viewer-native-input", enabled: false });
    dispatch({ type: "peer-remote-history-delete", enabled: false });
    await nextTurn();
    assert.deepEqual(peer.commands, [
      { type: "peer-viewer-native-input", enabled: false },
      { type: "peer-remote-history-delete", enabled: false },
    ], "each setting is its own coordinator command, with no implied disconnect or restart");
    assert.equal(peer.closeCalls, 0);
    assert.equal(typeof peer.options?.nativeIo?.authorizeInput, "function",
      "the coordinator's callbacks were fixed at construction and never withdrawn");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("turning Remote input/copy back on needs a fresh actually written frame even when the pixels match", async (t) => {
  const { harness, peer, content, source, generation } = await remoteNativeInputHarness(t);
  try {
    // Nothing newer can be written until the test drains the sink, so the only
    // written receipt is the one composed under the ORIGINAL preference generation.
    harness.writer.holdWrites = true;
    const invalidations = harness.writer.invalidateCalls;
    content.setViewerInput(false);
    content.setViewerInput(true);
    // The settings change repaints identical pixels; it is still a writer
    // boundary, and the queued candidate is not a receipt.
    peer.publish({});
    await nextTurn();
    assert.ok(harness.writer.invalidateCalls > invalidations,
      "an actual preference change forces a real writer boundary with identical visible bytes");
    harness.terminal.emitInput("x");
    await nextTurn();
    assert.equal(content.inputRequests.length, 0, "an Off -> On return never revives the old written receipt");
    const copyWrites = harness.terminal.writes.length;
    content.deliverCopy({
      subscriptionId: "sub-a",
      copyId: "copy-aba",
      sequence: 1,
      source,
      dispatchId: 1,
      event: {
        kind: "copy",
        encoded: "YWJh",
        sessionId: source.nativeSession.sessionId,
        sessionEpoch: source.nativeSession.epoch,
      },
      hostId: "lab-a",
      selectionGeneration: generation,
    });
    assert.equal(harness.terminal.writes.length, copyWrites, "nor does a copy ride the stale receipt");
    harness.terminal.emitInput("y");
    await nextTurn();
    assert.equal(content.inputRequests.length, 0, "an unwritten candidate authorizes nothing");

    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput("z");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1, "the freshly written frame restores input");
    assert.equal(content.deliveredInputs[0]!.text, "z");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a preference Off -> On between admission and the protected write refuses that write", async (t) => {
  const { harness, content, manager } = await remoteNativeInputHarness(t);
  try {
    content.beforeWrite = () => {
      content.setViewerInput(false);
      content.setViewerInput(true);
    };
    harness.terminal.emitInput("x");
    await nextTurn();
    assert.equal(content.inputRequests.length, 1, "the admission proof ran");
    assert.equal(content.deliveredInputs.length, 0,
      "the re-proof sees a new preference generation and refuses even though it reads On");
    assert.equal(manager.writes.length, 0);
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_NOT_SENT_NOTICE) !== undefined);
    content.beforeWrite = undefined;
    // The refused attempt's notice repaint wrote a frame under the CURRENT
    // generation, so a fresh request is proven against it normally.
    harness.terminal.emitInput("y");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1);
    assert.equal(content.deliveredInputs[0]!.text, "y");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("one written remote source receives canonical keyboard, paste, and mouse submissions and no local fallback", async (t) => {
  const { harness, content, manager, source, generation, rect } = await remoteNativeInputHarness(t);
  try {
    const localWrites = manager.writes.length;
    const requestShape = (index: number) => {
      const request = content.inputRequests[index]!;
      return {
        kind: request.kind,
        text: request.text,
        hostId: request.hostId,
        selectionGeneration: request.selectionGeneration,
        subscriptionId: request.subscriptionId,
        source: request.source,
      };
    };
    const expectedTarget = {
      hostId: "lab-a",
      selectionGeneration: generation,
      subscriptionId: "sub-a",
      source,
    };

    // Keyboard is source-normalized under the ACTUAL public terminal state; the
    // owner (not Main) translates once for its own native modes.
    harness.terminal.kittyProtocolActive = true;
    harness.terminal.emitInput(`${ESC}\r`);
    await nextTurn();
    assert.deepEqual(requestShape(0), { ...expectedTarget, kind: "keyboard", text: `${ESC}[13;2u` },
      "a Kitty-active source reports Shift+Enter with its own canonical spelling");

    harness.terminal.kittyProtocolActive = false;
    harness.terminal.emitInput("ls\r");
    await nextTurn();
    assert.deepEqual(requestShape(1), { ...expectedTarget, kind: "keyboard", text: "ls\r" },
      "ordinary text is carried unchanged and claims no viewport");

    harness.terminal.emitInput(`${ESC}[200~h\u00e9llo${ESC}[201~`);
    await nextTurn();
    assert.deepEqual(requestShape(2), { ...expectedTarget, kind: "paste", text: "h\u00e9llo" },
      "a complete bracketed paste contributes only its TEXTBODY");

    // The pointer maps from the screen cell into the written content rectangle.
    emitMouse(harness.terminal, rect.column + 2, rect.row + 3);
    await nextTurn();
    assert.deepEqual(requestShape(3), { ...expectedTarget, kind: "mouse", text: `${ESC}[<0;3;4M` },
      "a press becomes one canonical content-space SGR report");

    emitMouse(harness.terminal, rect.column + 2, rect.row + 3, 0, "m");
    await nextTurn();
    assert.deepEqual(requestShape(4), { ...expectedTarget, kind: "mouse", text: `${ESC}[<0;3;4m` },
      "the release keeps its own final byte");

    const paddingColumn = rect.column + rect.cols + 1;
    emitMouse(harness.terminal, paddingColumn, rect.row + 1);
    await nextTurn();
    assert.equal(content.inputRequests.length, 5, "a pointer in host padding claims no content cell and sends nothing");

    assert.equal(content.deliveredInputs.length, 5, "every admitted packet reached the one delegate exactly once");
    assert.equal(manager.writes.length, localWrites, "no remote attempt ever reaches a local row's PTY");
    assert.equal(harness.sidebar!.focus, "main", "remote input never steals focus");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("remote Main forwards legacy LF as Ctrl+J with the exact written owner and no local fallback", async (t) => {
  const { harness, content, manager, source, generation } = await remoteNativeInputHarness(t);
  try {
    harness.terminal.kittyProtocolActive = false;
    harness.observer.setFlags(7);
    for (const text of ["first line", "\n", "second line", ENTER, `${ESC}[13;2u`]) {
      harness.terminal.emitInput(text);
      await nextTurn();
    }
    assert.deepEqual(content.deliveredInputs.map((request) => request.text),
      ["first line", `${ESC}[106;5u`, "second line", ENTER, `${ESC}[13;2u`]);
    for (const request of content.deliveredInputs) {
      assert.equal(request.kind, "keyboard");
      assert.equal(request.hostId, "lab-a");
      assert.equal(request.selectionGeneration, generation);
      assert.equal(request.subscriptionId, "sub-a");
      assert.deepEqual(request.source, source);
    }
    assert.equal(manager.writes.length, 0, "remote input never edits a local sibling");
    assert.equal(harness.sidebar?.focus, "main");
    const before = content.inputRequests.length;
    content.setViewerInput(false);
    harness.terminal.emitInput("\n");
    await nextTurn();
    assert.equal(content.inputRequests.length, before, "viewer Off still refuses before delegation");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("one host input batch of wheel reports is one logical operation per event and a queue-limit tail stays quiet and unsent", async (t) => {
  const { harness, content, manager, rect } = await remoteNativeInputHarness(t);
  try {
    const localWrites = manager.writes.length;
    const framesBefore = harness.writer.frames.length;
    // #500 host-boundary case. It pins what the host does with a batch of wheel
    // reports: each normalized report becomes exactly one request carrying exactly one
    // canonical report. The 128 admitted / 8 refused split is scripted on this fake
    // endpoint to mirror the real endpoint's finite pending bound at the explicitly
    // selected trial size of 128; it is not a measurement of the reported incident and
    // claims no operator success. The refused tail is THIS viewer's own pending-operation
    // (backpressure) bound, so it is presented quietly: the operations stay unsent, no
    // success is claimed, and no notice is raised for the tail.
    content.sendResults = [
      ...Array.from({ length: 128 }, (): NativeInputSendResult => ({ status: "submitted" })),
      ...Array.from({ length: 8 }, (): NativeInputSendResult => ({ status: "not-sent", reason: "busy" })),
    ];
    for (let index = 0; index < 136; index += 1) {
      emitMouse(harness.terminal, rect.column + 2, rect.row + 3, 64);
    }
    await nextTurn();
    assert.equal(content.inputRequests.length, 136,
      "one normalized wheel report is exactly one logical operation, never one per character or packet");
    assert.ok(content.inputRequests.every((request) => request.kind === "mouse"
      && request.text === `${ESC}[<64;3;4M`),
      "every request carries its own one canonical content-space SGR report");
    assert.equal(content.deliveredInputs.length, 128, "the admitted part of the burst was handed off exactly once each");
    const burstFrame = plain(harness.writer.frames.at(-1)?.frame);
    assert.equal(sidebarNoticeRows(burstFrame, REMOTE_INPUT_NOT_SENT_NOTICE), undefined,
      "the quiet queue-limit tail raises no refusal notice");
    assert.equal(sidebarNoticeRows(burstFrame, REMOTE_INPUT_UNCERTAIN_NOTICE), undefined,
      "a queue-limit refusal is never presented as an uncertain handoff");
    assert.equal(harness.writer.frames.slice(framesBefore)
      .every((frame) => sidebarNoticeRows(plain(frame.frame), REMOTE_INPUT_NOT_SENT_NOTICE) === undefined), true,
      "no repaint of the burst carries a queue-limit refusal notice");
    assert.equal(manager.writes.length, localWrites, "a refused remote wheel never reaches a local row");
    assert.equal(harness.sidebar!.focus, "main", "a remote burst never steals focus");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("remote input authority is the actual written source, never a queued candidate or a stale one", async (t) => {
  const { harness, content, manager, generation } = await remoteNativeInputHarness(t);
  try {
    harness.writer.holdWrites = true;
    const nextSession = { sessionId: "conversation-b", epoch: 4 };
    const nextSource = remoteNativeSource({
      hostRunId: "run-a", sessionId: "row-a", nativeSession: nextSession, cols: 40, rows: 20,
      revision: 2, viewerRevision: 2, sourceToken: "commit-b",
    });
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 2,
      cols: 40, rows: 20, revision: 2, marker: "REMOTE-NATIVE-IO-B",
      nativeSession: nextSession, inputSource: nextSource,
    }));
    await nextTurn();

    harness.terminal.emitInput("x");
    await nextTurn();
    assert.equal(content.inputRequests.length, 0, "a published-but-unwritten source authorizes nothing");
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_NOT_SENT_NOTICE) !== undefined,
      "the refusal is the existing brief non-modal notice, not a silent drop or a local fallback");

    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput("y");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1, "the new frame's own write establishes the next authority");
    assert.deepEqual(content.deliveredInputs[0]!.source, nextSource,
      "the submission carries the expected written source, never a re-read of owner facts");
    assert.equal(content.deliveredInputs[0]!.selectionGeneration, generation,
      "the deliberate selection generation is carried, not advanced");
    assert.equal(manager.writes.length, 0, "nothing was retargeted to the local row");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("ordinary remote output never stalls typing while a mode-only change needs its own written frame", async (t) => {
  const { harness, content, source } = await remoteNativeInputHarness(t);
  try {
    const nativeSession = { sessionId: "conversation-a", epoch: 3 };
    const invalidations = harness.writer.invalidateCalls;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 2,
      cols: 40, rows: 20, marker: "REMOTE-NATIVE-IO-TEXT", nativeSession, inputSource: source,
    }));
    await nextTurn();
    assert.equal(harness.writer.invalidateCalls, invalidations,
      "a fresh snapshot and sequence with the same written source is not a semantic boundary");
    harness.terminal.emitInput("k");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1, "typing continues across ordinary terminal output");

    const changedModes = { ...REMOTE_INPUT_MODES, kittyFlags: 1 };
    harness.writer.holdWrites = true;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 3,
      cols: 40, rows: 20, marker: "REMOTE-NATIVE-IO-TEXT", nativeSession, inputSource: source,
      inputModes: changedModes,
    }));
    await nextTurn();
    assert.ok(harness.writer.invalidateCalls > invalidations,
      "an observed mode-only change forces the writer boundary even with identical visible bytes");
    harness.terminal.emitInput("k");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1, "input waits for the new modes' own written frame");

    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput("k");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 2, "the written boundary restores input");
    assert.deepEqual(content.deliveredInputs[1]!.inputModes, changedModes,
      "the submission carries the modes it was actually written for");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("every protected remote input write re-proves current focus, coverage, and geometry", async (t) => {
  const { harness, content, manager } = await remoteNativeInputHarness(t);
  try {
    content.beforeWrite = () => { harness.terminal.setSize(100, 30); };
    harness.terminal.emitInput("x");
    await nextTurn();
    assert.equal(content.inputRequests.length, 1, "the admission proof ran for the held write");
    assert.equal(content.deliveredInputs.length, 0,
      "a geometry change between admission and the write refuses the write entirely");
    assert.equal(manager.writes.length, 0, "the refused write never falls back to a local row");
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_NOT_SENT_NOTICE) !== undefined,
      "the refusal is a brief, non-modal notice");

    content.beforeWrite = undefined;
    harness.terminal.emitInput("y");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1,
      "once the resized geometry has its own written frame, input resumes against it");
    assert.equal(content.deliveredInputs[0]!.text, "y");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("remote paste is bounded by decoded text bytes and never truncated, paged, or imaged", async (t) => {
  const { harness, content } = await remoteNativeInputHarness(t);
  try {
    harness.terminal.emitInput(`${ESC}[200~partial`);
    await nextTurn();
    assert.equal(content.inputRequests.length, 0, "an incomplete bracketed paste is never handed to the owner");

    const exact = "x".repeat(1024 * 1024);
    harness.terminal.emitInput(`${ESC}[200~${exact}${ESC}[201~`);
    await nextTurn();
    assert.equal(content.inputRequests.length, 1, "exactly 1 MiB of decoded text is accepted");
    assert.equal(Buffer.byteLength(content.inputRequests[0]!.text, "utf8"), 1024 * 1024);

    const over = "x".repeat(1024 * 1024 + 1);
    harness.terminal.emitInput(`${ESC}[200~${over}${ESC}[201~`);
    await nextTurn();
    assert.equal(content.inputRequests.length, 1, "an oversized paste is refused whole");
    assert.equal(content.deliveredInputs.length, 1);
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_PASTE_TOO_LARGE_NOTICE) !== undefined,
      "the fixed non-modal refusal notice says nothing was sent");

    // The bound is decoded bytes, not characters: 600k two-byte characters exceed it.
    harness.terminal.emitInput(`${ESC}[200~${"\u00e9".repeat(600_000)}${ESC}[201~`);
    await nextTurn();
    assert.equal(content.inputRequests.length, 1, "a multi-byte body is measured by its decoded size");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("remote input results stay truthful: refusal notices and UNCERTAIN, never a claimed submission", async (t) => {
  const { harness, content, manager } = await remoteNativeInputHarness(t);
  try {
    content.sendResult = { status: "not-sent", reason: "busy" };
    harness.terminal.emitInput("a");
    await nextTurn();
    const quietFrame = plain(harness.writer.frames.at(-1)?.frame);
    assert.equal(sidebarNoticeRows(quietFrame, REMOTE_INPUT_NOT_SENT_NOTICE), undefined,
      "this viewer's own queue-limit refusal is presented quietly instead of as a refusal notice");
    assert.equal(sidebarNoticeRows(quietFrame, REMOTE_INPUT_UNCERTAIN_NOTICE), undefined,
      "a quiet queue-limit refusal claims no handoff either");
    assert.equal(content.deliveredInputs.length, 0, "the queue-limited input stayed unsent");

    content.sendResult = { status: "unknown" };
    harness.terminal.emitInput("b");
    await nextTurn();
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_UNCERTAIN_NOTICE) !== undefined,
      "an unknown outcome is labelled UNCERTAIN instead of claiming nothing was sent");

    content.rejectNextInput = true;
    content.sendResult = { status: "submitted" };
    harness.terminal.emitInput("c");
    await nextTurn();
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_UNCERTAIN_NOTICE) !== undefined,
      "a rejected delegate is uncertain, not unsent");

    // The one quiet reason must never erase a notice that is already visible.
    content.sendResult = { status: "not-sent", reason: "busy" };
    harness.terminal.emitInput("d");
    await nextTurn();
    const afterQuiet = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(sidebarNoticeRows(afterQuiet, REMOTE_INPUT_UNCERTAIN_NOTICE) !== undefined,
      "a quiet queue-limit refusal leaves the earlier uncertainty notice exactly as drawn");
    assert.equal(sidebarNoticeRows(afterQuiet, REMOTE_INPUT_NOT_SENT_NOTICE), undefined,
      "the quiet refusal still raises no refusal wording of its own");

    assert.equal(content.deliveredInputs.length, 1, "only the outcome that may have been written counts as handed over");
    assert.equal(content.inputRequests.length, 4, "every attempt reached the one delegate once, with no retry");
    assert.equal(manager.writes.length, 0, "no outcome routes input to a local row");
    assert.equal(harness.sidebar!.focus, "main", "no result steals focus");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("only the local queue-limit refusal is quiet: every other remote-input outcome keeps its notice", async (t) => {
  const { harness, content, manager } = await remoteNativeInputHarness(t);
  try {
    const localWrites = manager.writes.length;
    // Requests the fake delegate actually recorded, so "no retry" stays checkable
    // across the delegates that never reach it.
    let calls = 0;
    // Every reason the endpoint can report besides this viewer's own pending-operation
    // bound, plus the outcomes whose truthfulness cannot rest on a fixed reason. Each
    // one keeps its existing visible notice; only `busy` is quiet, and only because the
    // refusal came from this client's own queue, never from an owner or server limit.
    const cases: Array<{ readonly label: string; readonly result: NativeInputSendResult; readonly notice: string }> = [
      { label: "not-negotiated", result: { status: "not-sent", reason: "not-negotiated" }, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "not-ready", result: { status: "not-sent", reason: "not-ready" }, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "stale-source", result: { status: "not-sent", reason: "stale-source" }, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "stale-modes", result: { status: "not-sent", reason: "stale-modes" }, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "unauthorized", result: { status: "not-sent", reason: "unauthorized" }, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "invalid-input", result: { status: "not-sent", reason: "invalid-input" }, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "stopped", result: { status: "not-sent", reason: "stopped" }, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "too-large", result: { status: "not-sent", reason: "too-large" }, notice: REMOTE_INPUT_PASTE_TOO_LARGE_NOTICE },
      { label: "an unrecognized not-sent reason", result: { status: "not-sent", reason: "throttled" } as unknown as NativeInputSendResult, notice: REMOTE_INPUT_NOT_SENT_NOTICE },
      { label: "an unrecognized status", result: { status: "refused" } as unknown as NativeInputSendResult, notice: REMOTE_INPUT_UNCERTAIN_NOTICE },
      { label: "a malformed result", result: {} as unknown as NativeInputSendResult, notice: REMOTE_INPUT_UNCERTAIN_NOTICE },
      { label: "an unknown outcome", result: { status: "unknown" }, notice: REMOTE_INPUT_UNCERTAIN_NOTICE },
    ];
    // Two notices used only to clear the slot, so each case proves it raised its own
    // notice over a DIFFERENT visible one instead of reading a leftover from the case
    // before it.
    const CLEAR_UNCERTAIN: NativeInputSendResult = { status: "unknown" };
    const CLEAR_REFUSED: NativeInputSendResult = { status: "not-sent", reason: "stale-source" };
    const notices = [REMOTE_INPUT_NOT_SENT_NOTICE, REMOTE_INPUT_PASTE_TOO_LARGE_NOTICE, REMOTE_INPUT_UNCERTAIN_NOTICE];
    const drawnNotices = (): string[] => {
      const frame = plain(harness.writer.frames.at(-1)?.frame);
      return notices.filter((message) => sidebarNoticeRows(frame, message) !== undefined);
    };
    for (const entry of cases) {
      const clearer = entry.notice === REMOTE_INPUT_UNCERTAIN_NOTICE ? CLEAR_REFUSED : CLEAR_UNCERTAIN;
      const clearerNotice = entry.notice === REMOTE_INPUT_UNCERTAIN_NOTICE
        ? REMOTE_INPUT_NOT_SENT_NOTICE
        : REMOTE_INPUT_UNCERTAIN_NOTICE;
      content.sendResult = clearer;
      harness.terminal.emitInput("x");
      calls += 1;
      await nextTurn();
      assert.deepEqual(drawnNotices(), [clearerNotice], `${entry.label}: the clearing notice is the only notice drawn`);

      content.sendResult = entry.result;
      harness.terminal.emitInput("x");
      calls += 1;
      await nextTurn();
      assert.deepEqual(drawnNotices(), [entry.notice],
        `${entry.label} replaces the earlier notice with its own rather than dropping silently`);
      assert.equal(content.inputRequests.length, calls, `${entry.label} was attempted once with no retry`);
    }

    // A delegate that throws, and one that hands back no outcome at all, both stay
    // visible uncertainty; the queue-limit quieting never reaches them.
    const original = content.sendNativeInput.bind(content);
    try {
      content.sendResult = CLEAR_REFUSED;
      harness.terminal.emitInput("p");
      calls += 1;
      await nextTurn();
      assert.deepEqual(drawnNotices(), [REMOTE_INPUT_NOT_SENT_NOTICE], "a refusal notice is visible before the throw");

      (content as unknown as { sendNativeInput: () => NativeInputSendResult }).sendNativeInput = () => {
        throw new Error("synthetic delegate throw");
      };
      harness.terminal.emitInput("y");
      await nextTurn();
      assert.deepEqual(drawnNotices(), [REMOTE_INPUT_UNCERTAIN_NOTICE],
        "a throwing delegate is uncertain, never quiet");
      assert.equal(content.inputRequests.length, calls,
        "a synchronous throw reached no delegate at all and was never retried");

      (content as unknown as { sendNativeInput: typeof content.sendNativeInput }).sendNativeInput = original;
      content.sendResult = CLEAR_REFUSED;
      harness.terminal.emitInput("p");
      calls += 1;
      await nextTurn();
      assert.deepEqual(drawnNotices(), [REMOTE_INPUT_NOT_SENT_NOTICE], "a refusal notice is visible again before the silence");

      (content as unknown as { sendNativeInput: () => undefined }).sendNativeInput = () => undefined;
      harness.terminal.emitInput("z");
      await nextTurn();
      assert.deepEqual(drawnNotices(), [REMOTE_INPUT_UNCERTAIN_NOTICE],
        "a delegate that produced no outcome is uncertain, never quiet");
      assert.equal(content.inputRequests.length, calls,
        "a delegate with no outcome was never retried either");
    } finally {
      (content as unknown as { sendNativeInput: typeof content.sendNativeInput }).sendNativeInput = original;
    }

    // And the quiet reason still refuses quietly AFTER a visible notice, without
    // claiming success or handing the input to a local row.
    content.sendResult = { status: "not-sent", reason: "busy" };
    harness.terminal.emitInput("q");
    calls += 1;
    await nextTurn();
    assert.deepEqual(drawnNotices(), [REMOTE_INPUT_UNCERTAIN_NOTICE],
      "the preceding uncertainty notice survives a quiet queue-limit refusal, which adds nothing of its own");
    assert.equal(content.inputRequests.length, calls, "the quiet refusal was attempted once, never retried");
    assert.equal(manager.writes.length, localWrites, "no outcome routes input to a local row");
    assert.equal(harness.sidebar!.focus, "main", "no result steals focus");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("native copies emit one outer OSC 52 only for the current initiating viewer's written source", async (t) => {
  const { harness, content, manager, source, generation } = await remoteNativeInputHarness(t);
  try {
    const deliver = (input: {
      copyId: string;
      sequence: number;
      dispatchId: number;
      encoded?: string;
      source?: NativeIoSource;
      sessionEpoch?: number;
    }): void => {
      const copySource = input.source ?? source;
      const copyTuple = copySource.nativeSession;
      content.deliverCopy({
        subscriptionId: "sub-a",
        copyId: input.copyId,
        sequence: input.sequence,
        source: copySource,
        dispatchId: input.dispatchId,
        event: input.encoded === undefined
          ? { kind: "unavailable", reason: "unsupported-runtime", sessionId: copyTuple.sessionId, sessionEpoch: copyTuple.epoch }
          : {
            kind: "copy",
            encoded: input.encoded,
            sessionId: copyTuple.sessionId,
            sessionEpoch: input.sessionEpoch ?? copyTuple.epoch,
          },
        hostId: "lab-a",
        selectionGeneration: generation,
      });
    };

    const writesBefore = harness.terminal.writes.length;
    // An asynchronous copy from an earlier input is still delivered: the copy
    // emission order, not an input dispatch id, orders copies.
    deliver({ copyId: "copy-b", sequence: 2, dispatchId: 7, encoded: "aGVsbG8=" });
    deliver({ copyId: "copy-a", sequence: 1, dispatchId: 3, encoded: "d29ybGQ=" });
    assert.deepEqual(harness.terminal.writes.slice(writesBefore),
      [`${ESC}]52;c;aGVsbG8=\x07`, `${ESC}]52;c;d29ybGQ=\x07`],
      "both copies of the same current scope are delivered exactly once each");

    const afterCopies = harness.terminal.writes.length;
    deliver({ copyId: "copy-unavailable", sequence: 3, dispatchId: 8 });
    assert.equal(harness.terminal.writes.length, afterCopies,
      "an unavailable copy never emits an outer sequence and claims no clipboard success");

    const staleSource = remoteNativeSource({
      hostRunId: "run-a", sessionId: "row-a",
      nativeSession: { sessionId: "conversation-a", epoch: 9 }, cols: 40, rows: 20,
    });
    deliver({ copyId: "copy-stale", sequence: 4, dispatchId: 9, encoded: "c3RhbGU=", source: staleSource });
    assert.equal(harness.terminal.writes.length, afterCopies, "an old source's copy is dropped, never replayed");

    deliver({ copyId: "copy-tuple", sequence: 5, dispatchId: 10, encoded: "dHVwbGU=", sessionEpoch: 99 });
    assert.equal(harness.terminal.writes.length, afterCopies, "a copy naming another native tuple is refused");

    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const afterFocus = harness.terminal.writes.length;
    deliver({ copyId: "copy-focus", sequence: 6, dispatchId: 11, encoded: "Zm9jdXM=" });
    assert.equal(harness.terminal.writes.length, afterFocus,
      "an uncovered, Main-focused written source is required; roster focus drops the copy");

    assert.equal(manager.writes.length, 0, "copies never reach a local child or the local clipboard route");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a full-length remote native copy is emitted once, whole, under the unchanged bound", async (t) => {
  const { harness, content, source, generation } = await remoteNativeInputHarness(t);
  try {
    const encoded = "A".repeat(100_000);
    const writesBefore = harness.terminal.writes.length;
    content.deliverCopy({
      subscriptionId: "sub-a",
      copyId: "copy-full",
      sequence: 1,
      source,
      dispatchId: 1,
      event: {
        kind: "copy",
        encoded,
        sessionId: source.nativeSession.sessionId,
        sessionEpoch: source.nativeSession.epoch,
      },
      hostId: "lab-a",
      selectionGeneration: generation,
    });
    const written = harness.terminal.writes.slice(writesBefore);
    assert.equal(written.length, 1, "the assembled copy is handed to the terminal exactly once");
    assert.equal(written[0], `${ESC}]52;c;${encoded}\x07`,
      "the full producer bound is carried whole, never shrunk or re-encoded");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a copy of the current written source is not gated by input modes", async (t) => {
  const { harness, content, source, generation } = await remoteNativeInputHarness(t);
  try {
    const nativeSession = { sessionId: "conversation-a", epoch: 3 };
    // A mode-only change with identical bytes: input needs the new written frame,
    // but a copy is text, so it gains no per-input-mode history or dispatch fence.
    harness.writer.holdWrites = true;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 2,
      cols: 40, rows: 20, marker: "REMOTE-NATIVE-IO", nativeSession, inputSource: source,
      inputModes: { ...REMOTE_INPUT_MODES, kittyFlags: 1 },
    }));
    await nextTurn();
    const writesBefore = harness.terminal.writes.length;
    content.deliverCopy({
      subscriptionId: "sub-a",
      copyId: "copy-modes",
      sequence: 1,
      source,
      dispatchId: 1,
      event: {
        kind: "copy",
        encoded: "bW9kZXM=",
        sessionId: nativeSession.sessionId,
        sessionEpoch: nativeSession.epoch,
      },
      hostId: "lab-a",
      selectionGeneration: generation,
    });
    assert.equal(harness.terminal.writes.length, writesBefore + 1,
      "the same written source still delivers its copy across a pending mode boundary");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a resize that returns to its original size revokes remote authority until a post-resize frame is written", async (t) => {
  const { harness, content, source, generation } = await remoteNativeInputHarness(t);
  try {
    harness.writer.holdWrites = true;
    // 80 -> 70 -> 80 before any replacement frame is written. Pane rectangles
    // match the pre-resize receipt again, but the physical screen may have
    // reflowed and nothing newer has been written.
    harness.terminal.setSize(70, 24);
    harness.terminal.setSize(80, 24);
    await nextTurn();
    assert.ok(harness.writer.heldSubmits > 0, "the post-resize candidate is queued, never written");

    harness.terminal.emitInput("x");
    await nextTurn();
    assert.equal(content.inputRequests.length, 0,
      "the pre-resize receipt never regains authority when the size returns to its old value");
    assert.equal(harness.sidebar!.focus, "main");

    const writesBefore = harness.terminal.writes.length;
    content.deliverCopy({
      subscriptionId: "sub-a",
      copyId: "copy-aba",
      sequence: 1,
      source,
      dispatchId: 1,
      event: {
        kind: "copy",
        encoded: "YWJh",
        sessionId: source.nativeSession.sessionId,
        sessionEpoch: source.nativeSession.epoch,
      },
      hostId: "lab-a",
      selectionGeneration: generation,
    });
    assert.equal(harness.terminal.writes.length, writesBefore,
      "a pre-resize copy emits nothing after the resize boundary");

    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput("y");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1,
      "only the post-resize written frame restores input authority");
    assert.equal(content.deliveredInputs[0]!.text, "y");
    content.deliverCopy({
      subscriptionId: "sub-a",
      copyId: "copy-post",
      sequence: 2,
      source,
      dispatchId: 2,
      event: {
        kind: "copy",
        encoded: "cG9zdA==",
        sessionId: source.nativeSession.sessionId,
        sessionEpoch: source.nativeSession.epoch,
      },
      hostId: "lab-a",
      selectionGeneration: generation,
    });
    assert.equal(harness.terminal.writes.length, writesBefore + 1,
      "the post-resize copy is delivered exactly once");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a written startup-phase source carries typing before the first tuple, never a copy, and its conversation successor needs its own written frame", async (t) => {
  const { harness, content, manager, startup, generation } = await remoteStartupInputHarness(t);
  try {
    const copyFrom = (source: NativeIoSource, copyId: string, sequence: number, encoded: string): void => {
      content.deliverCopy({
        subscriptionId: "sub-a",
        copyId,
        sequence,
        source,
        dispatchId: sequence,
        event: {
          kind: "copy",
          encoded,
          sessionId: source.nativeSession.sessionId,
          sessionEpoch: source.nativeSession.epoch,
        },
        hostId: "lab-a",
        selectionGeneration: generation,
      });
    };

    assert.equal(remoteInputProof(content, generation, startup), true,
      "the actually written startup receipt is the current input authority");
    harness.terminal.emitInput("1");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 1, "the startup dialog's answer reaches the one delegate once");
    const answered = content.deliveredInputs[0]!;
    assert.equal(answered.text, "1");
    assert.deepEqual(answered.source, startup, "the submission carries the written startup source unchanged");
    assert.ok(isNativeIoStartupSource(answered.source), "the startup phase is explicit on the request");
    assert.equal(Object.hasOwn(answered.source, "nativeSession"), false,
      "no conversation identity is fabricated for the startup phase");
    assert.equal(manager.writes.length, 0, "startup input never falls back to a local row");

    // A startup receipt is input-only: a copy is always conversation-sourced, so
    // no copy (not even one naming the startup source's own token) matches it.
    const conversation = { sessionId: "conversation-a", epoch: 1 };
    const conversationSource = remoteNativeSource({
      hostRunId: "run-a", sessionId: "row-a", nativeSession: conversation, cols: 40, rows: 20,
      sourceToken: "commit-a",
    });
    const beforeCopies = harness.terminal.writes.length;
    copyFrom(conversationSource, "copy-early", 1, "ZWFybHk=");
    copyFrom({ ...conversationSource, sourceToken: startup.sourceToken }, "copy-token", 2, "dG9rZW4=");
    assert.equal(harness.terminal.writes.slice(beforeCopies).some((write) => write.includes("]52;")), false,
      "no OSC 52 is written while the written receipt is the startup phase");

    // The first tuple arrives with identical pixels: a phase/source-only change is
    // still a writer boundary, and neither source authorizes until it is written.
    harness.writer.holdWrites = true;
    const invalidations = harness.writer.invalidateCalls;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 2,
      cols: 40, rows: 20, marker: "REMOTE-STARTUP-TRUST", nativeSession: conversation, inputSource: conversationSource,
    }));
    await nextTurn();
    assert.ok(harness.writer.invalidateCalls > invalidations,
      "a startup -> conversation change forces the real writer boundary with identical visible bytes");
    assert.equal(remoteInputProof(content, generation, startup), false,
      "the written startup receipt stops authorizing once the published view names a conversation");
    assert.equal(remoteInputProof(content, generation, conversationSource), false,
      "the published-but-unwritten conversation source authorizes nothing yet");
    harness.terminal.emitInput("2");
    await nextTurn();
    assert.equal(content.inputRequests.length, 1, "nothing is offered to the delegate across the unwritten boundary");
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_NOT_SENT_NOTICE) !== undefined,
      "the refusal is the existing brief non-modal notice");

    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput("3");
    await nextTurn();
    assert.equal(content.deliveredInputs.length, 2, "the conversation frame's own write restores input");
    assert.deepEqual(content.deliveredInputs[1]!.source, conversationSource,
      "the submission now carries the written conversation source");
    assert.equal(remoteInputProof(content, generation, startup), false,
      "the startup phase never authorizes again after the conversation frame is written");

    const beforeConversationCopy = harness.terminal.writes.length;
    copyFrom(conversationSource, "copy-conversation", 3, "Y29udg==");
    assert.deepEqual(harness.terminal.writes.slice(beforeConversationCopy), [`${ESC}]52;c;Y29udg==\x07`],
      "the written conversation source receives its copy exactly once");
    assert.equal(manager.writes.length, 0);
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a written startup-phase receipt is refused under roster focus, a resize, an Off -> On return, and a covering overlay", async (t) => {
  const { harness, peer, content, manager, startup, generation } = await remoteStartupInputHarness(t);
  try {
    // Roster focus: the startup receipt follows the same Main-focus rule.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "sidebar");
    assert.equal(remoteInputProof(content, generation, startup), false,
      "roster focus refuses the startup receipt");
    harness.terminal.emitInput(`${ESC}[1;3C`); // Alt+Right: return input ownership to Main.
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "main");
    assert.equal(remoteInputProof(content, generation, startup), true,
      "a written Main-focused frame of the same startup source authorizes again");

    // 80 -> 70 -> 80 before any replacement frame is written.
    harness.writer.holdWrites = true;
    harness.terminal.setSize(70, 24);
    harness.terminal.setSize(80, 24);
    await nextTurn();
    assert.equal(remoteInputProof(content, generation, startup), false,
      "a pre-resize startup receipt never regains authority when the size returns");
    const requestsBeforeResize = content.inputRequests.length;
    harness.terminal.emitInput("x");
    await nextTurn();
    assert.equal(content.inputRequests.length, requestsBeforeResize, "nothing is offered across the resize boundary");
    harness.writer.drainHeldWrites();
    await nextTurn();
    assert.equal(remoteInputProof(content, generation, startup), true,
      "only the post-resize written frame restores the startup source");

    // Off, then On while the sink is held: the old receipt is never revived.
    content.setViewerInput(false);
    peer.publish({ settings: { ...peer.snapshot.settings!, viewerNativeInputEnabled: false } });
    await nextTurn();
    assert.equal(remoteInputProof(content, generation, startup), false, "Off refuses the startup receipt");
    const requestsWhileOff = content.inputRequests.length;
    harness.terminal.emitInput("o");
    await nextTurn();
    assert.equal(content.inputRequests.length, requestsWhileOff, "nothing is offered while Off");
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), REMOTE_INPUT_VIEWER_OFF_NOTICE) !== undefined,
      "Off is the one brief fixed notice");
    harness.writer.holdWrites = true;
    content.setViewerInput(true);
    peer.publish({ settings: { ...peer.snapshot.settings!, viewerNativeInputEnabled: true } });
    await nextTurn();
    assert.equal(remoteInputProof(content, generation, startup), false,
      "an Off -> On return needs a fresh actually written frame for the startup source");
    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput("y");
    await nextTurn();
    assert.equal(content.deliveredInputs.at(-1)?.text, "y", "the freshly written frame restores startup input");
    assert.deepEqual(content.deliveredInputs.at(-1)?.source, startup);

    // Narrow Main: focused Main draws no sidebar rectangle, so the 40x20 startup
    // frame stays uncovered; a roster overlay drawn over Main refuses it.
    harness.terminal.setSize(50, 24);
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "main");
    assert.equal(remoteInputProof(content, generation, startup), true,
      "a narrow, uncovered, Main-focused written startup frame still authorizes");
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(remoteInputProof(content, generation, startup), false,
      "a roster overlay covering Main refuses the startup receipt");
    assert.equal(manager.writes.length, 0, "no refusal ever falls back to a local row");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("remote-enabled Main captures the displayed owner's own mouse reporting mode", async (t) => {
  const { harness, content, source } = await remoteNativeInputHarness(t);
  const nativeSession = { sessionId: "conversation-a", epoch: 3 };
  try {
    const dragModes: TerminalInputModes = { ...REMOTE_INPUT_MODES, mouseTracking: "drag", mouseEncoding: "sgr" };
    const anyModes: TerminalInputModes = { ...REMOTE_INPUT_MODES, mouseTracking: "any", mouseEncoding: "sgr" };

    const beforeDrag = harness.terminal.writes.length;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 2,
      cols: 40, rows: 20, marker: "REMOTE-MOUSE-DRAG", nativeSession, inputSource: source,
      inputModes: dragModes,
    }));
    await nextTurn();
    assert.deepEqual(harness.terminal.writes.slice(beforeDrag), [`${ESC}[?1000l`, `${ESC}[?1002h`],
      "the written owner's drag mode replaces the host's press-only capture");

    const beforeAny = harness.terminal.writes.length;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 3,
      cols: 40, rows: 20, marker: "REMOTE-MOUSE-ANY", nativeSession, inputSource: source,
      inputModes: anyModes,
    }));
    await nextTurn();
    assert.deepEqual(harness.terminal.writes.slice(beforeAny), [`${ESC}[?1002l`, `${ESC}[?1003h`],
      "a mode-only change resynchronizes capture immediately");

    // Narrow Main: no sidebar rectangle is drawn, so the host's own pane capture
    // is absent; the displayed owner's capture must survive.
    const beforeNarrow = harness.terminal.writes.length;
    harness.terminal.setSize(50, 24);
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "main");
    assert.deepEqual(harness.terminal.writes.slice(beforeNarrow), [],
      "a narrow Main pane keeps the owner's any-mode capture instead of dropping it");

    // Hidden sidebar: host focus drops to press-only capture, then returning to
    // the displayed owner restores its own any-mode capture.
    const beforeHide = harness.terminal.writes.length;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar!.visible, false);
    assert.equal(harness.sidebar!.focus, "main");
    assert.deepEqual(harness.terminal.writes.slice(beforeHide),
      [`${ESC}[?1003l`, `${ESC}[?1000h`, `${ESC}[?1000l`, `${ESC}[?1003h`],
      "a hidden sidebar returns to the owner's capture once Main is focused again");
    assert.equal(harness.terminal.writes.includes(`${ESC}[?1006l`), false,
      "cell-coordinate capture is never dropped while the owner is displayed");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("the explicit-false legacy seam keeps the host's press-only capture for published mouse modes", async (t) => {
  const { harness, content, dispatch } = await remoteContentMainHarness(t, [
    remotePeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a", rows: [remoteRosterRow({ id: "row-a" })] }),
  ], { nativeInputOriginFraming: false });
  try {
    dispatch({ type: "select-remote", hostId: "lab-a", hostRunId: "run-a", rowId: "row-a" });
    await nextTurn();
    const nativeSession = { sessionId: "conversation-a", epoch: 3 };
    const source = remoteNativeSource({ hostRunId: "run-a", sessionId: "row-a", nativeSession, cols: 40, rows: 20 });
    const dragModes: TerminalInputModes = { ...REMOTE_INPUT_MODES, mouseTracking: "drag", mouseEncoding: "sgr" };
    const before = harness.terminal.writes.length;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 1,
      cols: 40, rows: 20, marker: "REMOTE-OFF-MOUSE", nativeSession, inputSource: source,
      inputModes: dragModes,
    }));
    await nextTurn();
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("REMOTE-OFF-MOUSE"),
      "the legacy display-only path still paints the published view");
    assert.deepEqual(harness.terminal.writes.slice(before), [],
      "under the legacy seam a published mouse mode changes no outer capture");
    assert.equal(harness.terminal.writes.includes(`${ESC}[?1002h`), false);
    assert.equal(harness.terminal.writes.includes(`${ESC}[?1003h`), false);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a viewer with Remote input/copy Off keeps press-only capture even with Main focused", async (t) => {
  const { harness, peer, content, source } = await remoteNativeInputHarness(t);
  try {
    content.setViewerInput(false);
    peer.publish({ settings: { ...peer.snapshot.settings!, viewerNativeInputEnabled: false } });
    await nextTurn();
    const before = harness.terminal.writes.length;
    content.publish(remoteViewport({
      subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 2,
      cols: 40, rows: 20, marker: "REMOTE-OFF-DRAG", nativeSession: source.nativeSession, inputSource: source,
      inputModes: { ...REMOTE_INPUT_MODES, mouseTracking: "drag", mouseEncoding: "sgr" },
    }));
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "main");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("REMOTE-OFF-DRAG"), "viewing continues while Off");
    assert.equal(harness.terminal.writes.slice(before).includes(`${ESC}[?1002h`), false,
      "the owner's drag capture is not requested for a viewer that forwards nothing");

    // Turning it back on resynchronizes capture to the displayed owner's own mode.
    content.setViewerInput(true);
    peer.publish({ settings: { ...peer.snapshot.settings!, viewerNativeInputEnabled: true } });
    await nextTurn();
    assert.equal(harness.terminal.writes.slice(before).includes(`${ESC}[?1002h`), true);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a refused remote input notice stays visible when no sidebar pane is drawn", async (t) => {
  const { harness, content } = await remoteNativeInputHarness(t);
  try {
    // Hidden sidebar at 80 columns: Main owns the full width and no roster pane
    // exists, so only the composed header can carry the brief notice.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar!.visible, false);
    assert.equal(harness.sidebar!.focus, "main");
    harness.terminal.emitInput(`${ESC}[200~${"x".repeat(1024 * 1024 + 1)}${ESC}[201~`);
    await nextTurn();
    assert.ok(plainLine(harness.writer.frames.at(-1)?.frame, 0).includes(REMOTE_INPUT_PASTE_TOO_LARGE_NOTICE),
      "the header carries the oversized-paste refusal while the sidebar is hidden");

    // Unknown outcome at the ordinary 80-column width with no sidebar: the
    // uncertainty label must lead the one composed notice row so clipping cannot
    // remove the essential classification.
    content.sendResult = { status: "unknown" };
    harness.terminal.emitInput("k");
    await nextTurn();
    const hiddenUnknown = plainLine(harness.writer.frames.at(-1)?.frame, 0);
    assert.ok(hiddenUnknown.includes("UNCERTAIN"),
      "the uncertainty label survives header clipping at 80 columns");
    assert.equal(hiddenUnknown.includes("nothing was sent"), false,
      "an unknown outcome is never presented as nothing sent");

    // Also retain the complete uncertainty wording on a wider terminal.
    harness.terminal.setSize(120, 30);
    await nextTurn();
    assert.equal(harness.sidebar!.visible, false);
    content.sendResult = { status: "unknown" };
    harness.terminal.emitInput("k");
    await nextTurn();
    const hiddenUncertain = plainLine(harness.writer.frames.at(-1)?.frame, 0);
    assert.ok(hiddenUncertain.includes(REMOTE_INPUT_UNCERTAIN_NOTICE),
      "the complete UNCERTAIN wording is composed without a sidebar");
    assert.ok(hiddenUncertain.includes("UNCERTAIN"), "the uncertainty label is never dropped");
    assert.equal(hiddenUncertain.includes(REMOTE_INPUT_NOT_SENT_NOTICE), false,
      "an unknown outcome is never presented as nothing sent");

    // Narrow Main with the sidebar visible again: the overlay draws no sidebar
    // rectangle while Main owns focus, so the header still carries the notice.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.emitInput(`${ESC}[1;3C`); // Alt+Right: return input ownership to Main.
    await nextTurn();
    assert.equal(harness.sidebar!.visible, true);
    assert.equal(harness.sidebar!.focus, "main");
    harness.terminal.setSize(50, 24);
    await nextTurn();
    content.sendResult = { status: "unknown" };
    harness.terminal.emitInput("k");
    await nextTurn();
    const narrowUnknown = plainLine(harness.writer.frames.at(-1)?.frame, 0);
    assert.ok(narrowUnknown.includes("UNCERTAIN"),
      "the uncertainty label survives header clipping at 50 columns");
    assert.equal(narrowUnknown.includes("nothing was sent"), false,
      "a narrow unknown outcome is never presented as nothing sent");
    content.sendResult = { status: "not-sent", reason: "busy" };
    harness.terminal.emitInput("k");
    await nextTurn();
    const narrowQuiet = plainLine(harness.writer.frames.at(-1)?.frame, 0);
    assert.equal(narrowQuiet.includes("Remote input was refused"), false,
      "a narrow Main pane raises no notice for this viewer's own queue-limit refusal");
    assert.ok(narrowQuiet.includes("UNCERTAIN"),
      "the quiet queue-limit refusal leaves the earlier uncertainty notice visible instead of erasing it");

    harness.terminal.emitInput(`${ESC}[200~${"x".repeat(1024 * 1024 + 1)}${ESC}[201~`);
    await nextTurn();
    assert.ok(plainLine(harness.writer.frames.at(-1)?.frame, 0)
      .includes("That paste is larger than a remote session"),
      "a narrow Main pane still shows the oversized-paste refusal, which is never quieted");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});
