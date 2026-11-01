/**
 * Production Main wiring for the #477 session-card pointer reorder.
 *
 * Every case drives the REAL terminal-input callback of the running host with
 * synthetic SGR/X10 mouse packets through the harness's fake terminal, and
 * asserts against what the production frame writer actually emitted: the bytes
 * are replayed through a real `TerminalSurface`, so "visible order" means the
 * screen the operator has, not a fixture. Roster persistence is captured from
 * the persist call Main itself makes. No physical terminal, PTY, peer,
 * credential, or SSH is involved — this proves which dispatch production Main
 * performs for given bytes and which frames actually reached the sink.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import { createSessionHostFrameWriter } from "../src/session-host/frame-writer";
import type { SavedSessionCatalog } from "../src/session-host/saved-sessions";
import { TerminalSurface, type TerminalFrame } from "../src/session-host/terminal-surface";
import type { MainTestDependencies } from "./helpers/session-host-main-harness";
import {
  ALT_LEFT,
  ENTER,
  ESC,
  type FakeManager,
  type FakeTerminal,
  type Harness,
  QueuedFrameOutput,
  closeWithSignal,
  completeForm,
  createHarness,
  emitMouse,
  fillForm,
  makeMainTestDirectory,
  nextTurn,
  peerMainHarness,
  ready,
} from "./helpers/session-host-main-harness";
import {
  harnessManager,
  remoteContentMainHarness,
  remotePeerHost,
  remoteRosterRow,
  type RemotePeerUiHost,
} from "./helpers/session-host-main-remote";

const SGR = /\x1b\[[0-9;]*m/g;
const SIDEBAR_COLS = 32;
const DRAG_MOTION = 32;

// ---------------------------------------------------------------------------
// Shared local helpers (owned here; the base harness stays the only DI owner).
// ---------------------------------------------------------------------------

/** One real roster persistence Main asked the owning-host state to write. */
function recordingHostState(persisted: string[]): MainTestDependencies["openHostState"] {
  return ({ agentDir: ownedDir, hostId }) => ({
    status: "opened",
    state: {
      agentDir: ownedDir,
      hostId,
      ownershipPath: `${ownedDir}/synthetic-owner`,
      roster: undefined,
      problem: undefined,
      persist: (roster) => { persisted.push(JSON.stringify(roster)); return true; },
      release: () => true,
    },
  });
}

/** The stored identity sequence of one persisted projection, in document order. */
function persistedSequence(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const doc = JSON.parse(raw) as { entries: unknown[] };
  return doc.entries.map((entry) => {
    const record = entry as { slotId?: string; hostId?: string; owner?: { kind: string; id: string } };
    if (record.slotId !== undefined) return `local:${record.slotId}`;
    return `remote:${record.hostId}:${record.owner?.kind ?? "?"}:${record.owner?.id ?? "?"}`;
  });
}

/** The same projection with one entry moved next to another, as the store would hold it. */
function movedSequence(
  sequence: readonly string[],
  source: string,
  target: string,
  placement: "before" | "after",
): string[] {
  const from = sequence.indexOf(source);
  assert.notEqual(from, -1, `the saved sequence names the moved entry: ${JSON.stringify(sequence)}`);
  const rest = sequence.filter((_, index) => index !== from);
  const at = rest.indexOf(target);
  assert.notEqual(at, -1, `the saved sequence names the destination entry: ${JSON.stringify(sequence)}`);
  rest.splice(placement === "before" ? at : at + 1, 0, source);
  return rest;
}

/**
 * A Main harness whose frames cross the REAL frame writer into a recording sink.
 * When `persisted` is supplied the host also owns a real owning-host state handle
 * (native setup on, owned synthetic agent directory), so the persist calls Main
 * itself makes are captured.
 */
function realWriterHarness(options: {
  persisted?: string[];
  extra?: MainTestDependencies;
} = {}): {
  harness: Harness;
  output: QueuedFrameOutput;
  submitted: ComposedHostFrame[];
  lastFrame(): ComposedHostFrame | undefined;
} {
  const output = new QueuedFrameOutput();
  const submitted: ComposedHostFrame[] = [];
  const agentDir = options.persisted === undefined ? undefined : makeMainTestDirectory("pointer-agent");
  if (agentDir !== undefined) writeFileSync(join(agentDir, "keybindings.json"), "{}", "utf8");
  const persisting: MainTestDependencies = agentDir === undefined || options.persisted === undefined
    ? {}
    : {
      createSessionSetup: () => ({
        nativeSetup: true,
        nativeAgentDir: agentDir,
        profileRegistry: { prepare: () => { throw new Error("the synthetic pointer manager prepares no profile"); } },
      }),
      openHostState: recordingHostState(options.persisted),
    };
  const harness = createHarness({}, {
    ...persisting,
    ...options.extra,
    ...realWriterDependencies(output, submitted),
  });
  return { harness, output, submitted, lastFrame: () => submitted.at(-1) };
}

/**
 * The dependency override that routes Main's frames through the REAL frame
 * writer into a recording sink, keeping every submitted candidate for the
 * written-vs-queued distinction these tests assert on.
 */
function realWriterDependencies(
  output: QueuedFrameOutput,
  submitted: ComposedHostFrame[],
): MainTestDependencies {
  return {
    createWriter: (_stdout, writerOptions) => {
      const driver = createSessionHostFrameWriter(output as unknown as Writable, {
        ...writerOptions,
        redrawIntervalMs: 0,
      });
      return {
        start: () => driver.start(),
        submit: (frame, cols, rows, settle) => {
          submitted.push(frame);
          driver.submit(frame, cols, rows, settle);
        },
        invalidate: () => driver.invalidate(),
        close: () => driver.close(),
      };
    },
  };
}

/** The screen a real terminal would show from the bytes the production writer emitted. */
async function emittedScreen(
  output: QueuedFrameOutput,
  harness: Harness,
  includeQueued = false,
): Promise<TerminalFrame> {
  const surface = new TerminalSurface(harness.terminal.columns, harness.terminal.rows);
  try {
    const writes = [...output.writes, ...(includeQueued ? output.queuedTexts.map((text) => Buffer.from(text)) : [])];
    for (const bytes of writes) surface.write(bytes.toString("utf8"));
    await surface.flush();
    return surface.frame();
  } finally {
    surface.dispose();
  }
}

/** The emitted screen row that first shows this text inside the roster pane. */
function screenRowOf(frame: TerminalFrame, text: string): number {
  return frame.lines.findIndex((line, row) => row >= 1
    && line.replace(SGR, "").slice(0, SIDEBAR_COLS).includes(text));
}

/** The named cards in the vertical order the emitted screen actually shows them. */
function visibleOrder(frame: TerminalFrame, titles: readonly string[]): string[] {
  const placed = titles
    .map((title) => ({ title, row: screenRowOf(frame, title) }))
    .filter((entry) => entry.row >= 0)
    .sort((left, right) => left.row - right.row);
  assert.equal(placed.length, titles.length,
    `every named card is drawn on screen: ${JSON.stringify(frame.lines.slice(0, 24))}`);
  return placed.map((entry) => entry.title);
}

/** The roster pane row of one drawn text in the last frame handed to the writer. */
function composedRowOf(frame: ComposedHostFrame | undefined, text: string): number {
  return frame?.lines.findIndex((line, row) => row >= 1
    && line.replace(SGR, "").slice(0, SIDEBAR_COLS).includes(text)) ?? -1;
}

const press = (harness: Harness, row: number): void => emitMouse(harness.terminal, 1, row);
const moveTo = (harness: Harness, row: number): void => emitMouse(harness.terminal, 1, row, DRAG_MOTION);
const releaseAt = (harness: Harness, row: number): void => emitMouse(harness.terminal, 1, row, 0, "m");

/**
 * The mouse-tracking modes this host currently has enabled, folded from its own
 * owned `?100Nh` / `?100Nl` writes in order. Only modes the host itself wrote
 * appear, so a pre-existing terminal mode is never guessed at.
 */
function enabledTrackingModes(writes: readonly string[]): string[] {
  const on = new Set<string>();
  for (const value of writes) {
    const match = /^\x1b\[\?(\d{4})([hl])$/.exec(value);
    if (match === null || !(match[1] === "1000" || match[1] === "1002" || match[1] === "1003")) continue;
    if (match[2] === "h") on.add(match[1]!);
    else on.delete(match[1]!);
  }
  return [...on].sort();
}

/** Press, drag to `toRow`, let the preview frame be written, then release there. */
async function dragCard(harness: Harness, fromRow: number, toRow: number): Promise<void> {
  press(harness, fromRow);
  moveTo(harness, fromRow + 1);
  moveTo(harness, toRow);
  await nextTurn();
  releaseAt(harness, toRow);
  await nextTurn();
}

/** Opens the New-session form with a press on the drawn action row (unchanged press path). */
function openNewByPress(harness: Harness, frame: ComposedHostFrame | undefined): void {
  const row = composedRowOf(frame, "New session");
  assert.ok(row > 0, `the drawn roster keeps its unchanged New session action row: ${JSON.stringify(frame?.lines ?? [])}`);
  emitMouse(harness.terminal, 1, row);
  assert.equal(harness.sidebar?.focus, "form", "a host action row still activates on press");
}

/** `count` live local rows, created through the unchanged action-row press path. */
async function startLocalRows(
  harness: Harness,
  count: number,
  lastFrame: () => ComposedHostFrame | undefined,
): Promise<FakeManager> {
  const manager = await ready(harness);
  for (let index = 0; index < count; index += 1) {
    openNewByPress(harness, lastFrame());
    completeForm(harness.terminal, `/pointer/ws-${index + 1}`);
    await nextTurn();
    if (index + 1 < count) {
      harness.terminal.emitInput(ALT_LEFT); // the completed New owns Main; return to the roster
      await nextTurn();
    }
  }
  assert.deepEqual(manager.views.map((view) => view.id),
    Array.from({ length: count }, (_unused, index) => `native-${index + 1}`));
  return manager;
}

/**
 * Guarantees the host shuts down even when a case fails, so a failing assertion
 * surfaces as a failure instead of a hung test.
 */
function ensureShutdown(harness: Harness, closed: boolean): Promise<number | undefined> {
  if (!closed) harness.signals.emit("SIGTERM");
  return harness.result.catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Press semantics: the session-card press is held; the release decides.
// ---------------------------------------------------------------------------

test("a session-card press is held, activates once on release over the same card, and never after motion or a release elsewhere", async () => {
  let closed = false;
  const { harness, output, lastFrame } = realWriterHarness();
  try {
    const manager = await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT); // roster focus; both cards stay live
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const rowB = screenRowOf(screen, "Native native-2");
    assert.ok(rowA > 0 && rowB > rowA, "the emitted screen shows both session cards in roster order");
    const ownerBefore = harness.sidebar?.activeMainOwnerID;
    const writesBefore = manager.writes.length;

    press(harness, rowA);
    assert.equal(harness.sidebar?.selectedId, "native-2", "the held press does not move the highlight");
    assert.equal(harness.sidebar?.focus, "sidebar", "the held press does not take Main focus");
    assert.equal(manager.writes.length, writesBefore, "the press is not forwarded to any session");

    // Motion makes this a drag: no release can activate either card.
    moveTo(harness, rowB + 4);
    await nextTurn();
    const preview = await emittedScreen(output, harness);
    assert.deepEqual(visibleOrder(preview, ["Native native-1", "Native native-2"]),
      ["Native native-2", "Native native-1"], "the written preview shows the moved card at its drop position");
    assert.equal(harness.sidebar?.sessionPointerActive, true, "the drag is still in flight");
    releaseAt(harness, rowB + 4);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar",
    "a drag release activates neither the source nor the destination: focus and input ownership stay");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "the displayed owner is unchanged");
    assert.equal(manager.writes.length, writesBefore, "and no input follows a drag");
    assert.equal(harness.sidebar?.selectedId, "native-1",
    "the roster highlight simply follows the card that moved");

    // A stray release with no press, and a press+release on a blank row, are
    // consumed without activating anything.
    const dragged = await emittedScreen(output, harness);
    releaseAt(harness, screenRowOf(dragged, "Native native-1"));
    const blank = dragged.lines.findIndex((line, index) => index > rowB + 6
      && line.replace(SGR, "").slice(0, SIDEBAR_COLS).trim() === "");
    assert.ok(blank > 0);
    press(harness, blank);
    releaseAt(harness, blank);
    assert.equal(harness.sidebar?.focus, "sidebar", "a blank row activates nothing");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "and takes no ownership");
    assert.equal(manager.writes.length, writesBefore, "no part of any host gesture reached a session");

    // The ordinary click still activates, on release over the same card.
    const clickedRow = screenRowOf(dragged, "Native native-1");
    press(harness, clickedRow);
    assert.equal(harness.sidebar?.focus, "sidebar", "still pending before the release");
    releaseAt(harness, clickedRow);
    assert.equal(harness.sidebar?.selectedId, "native-1", "the release over the pressed card activates it");
    assert.equal(harness.sidebar?.focus, "main");
    harness.terminal.emitInput("after-click");
    assert.equal(manager.writes.at(-1)?.id, "native-1", "input follows the activated card");

    // Existing native behaviour around the gesture stays intact: a child that
    // asks for mouse reports keeps its other buttons, motion, wheel, and paste.
    const surface = manager.surface("native-1");
    assert.ok(surface);
    surface.modes = { ...surface.modes, mouseTracking: "drag", mouseEncoding: "sgr" };
    manager.notify("child-drag-mode");
    await nextTurn();
    const beforeNative = manager.writes.length;
    emitMouse(harness.terminal, 40, 4, 1); // independent middle-button press inside Main
    emitMouse(harness.terminal, 41, 5, 33); // its motion stays native
    emitMouse(harness.terminal, 41, 5, 1, "m");
    emitMouse(harness.terminal, 40, 4, 64); // wheel keeps its existing route (#439)
    emitMouse(harness.terminal, 40, 4, 65, "m");
    harness.terminal.emitInput("\x1b[200~pasted\x1b[201~");
    const forwarded = manager.writes.slice(beforeNative);
    assert.deepEqual(forwarded.map((entry) => entry.id),
      ["native-1", "native-1", "native-1", "native-1", "native-1", "native-1"],
    "every unrelated native packet still reaches the displayed owner");
    assert.deepEqual(forwarded.slice(0, 5).map((entry) => /^\x1b\[<(\d+)/.exec(String(entry.data))?.[1]),
      ["1", "33", "1", "64", "65"],
    "its other-button press, motion, release, and wheel reports keep their existing translation (#439)");
    assert.equal(String(forwarded.at(-1)?.data), "pasted", "bracketed paste keeps its ordinary path");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a host action row keeps press activation, and a drag released on it cancels with no reorder and no picker", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const savedRow = screenRowOf(screen, "Saved conversations");
    assert.ok(savedRow > 0, "the unchanged host action rows stay drawn after every session card");
    const persistsBefore = persisted.length;

    await dragCard(harness, rowA, savedRow);
    assert.equal(harness.sidebar?.focus, "sidebar", "a release on an action row does not open it");
    assert.equal(persisted.length, persistsBefore, "and it commits no order change");
    assert.deepEqual(visibleOrder(await emittedScreen(output, harness),
      ["Native native-1", "Native native-2"]), ["Native native-1", "Native native-2"],
    "a cancelled drag leaves the committed visible order alone");

    emitMouse(harness.terminal, 1, savedRow);
    assert.equal(harness.sidebar?.focus, "form", "the action row still activates on press, as before");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

// ---------------------------------------------------------------------------
// The one canonical mixed order: visible on screen, saved once, stable identity.
// ---------------------------------------------------------------------------

/**
 * Local rows plus three owner projections with deliberate identity collisions:
 * the same remote row id on two hosts, a remote row id equal to a LOCAL row id,
 * and a legacy owner run (`null`) naming no durable roster slot.
 */
function collisionHosts(): RemotePeerUiHost[] {
  return [
    remotePeerHost({
      id: "lab-a", label: "Lab Alpha", hostRunId: "run-a",
      rows: [
        remoteRosterRow({ id: "row-1", label: "Alpha one", workspace: "/remote/ws/alpha-one", rosterSlotId: "slot-alpha-1" }),
        remoteRosterRow({ id: "native-1", label: "Alpha twin", workspace: "/remote/ws/alpha-twin", rosterSlotId: "slot-alpha-twin" }),
      ],
    }),
    remotePeerHost({
      id: "lab-b", label: "Lab Beta", hostRunId: "run-b",
      rows: [
        remoteRosterRow({ id: "row-1", label: "Beta one", workspace: "/remote/ws/beta-one", rosterSlotId: "slot-beta-1" }),
      ],
    }),
    remotePeerHost({
      id: "lab-c", label: "Lab Gamma", hostRunId: null,
      rows: [remoteRosterRow({ id: "legacy-row", label: "Legacy card", workspace: "/remote/ws/legacy" })],
    }),
  ];
}

test("pointer drags reorder the actually visible roster across local rows, two owner runs, and a legacy null-run card, saving one canonical sequence each time", async (t) => {
  const persisted: string[] = [];
  const output = new QueuedFrameOutput();
  const submitted: ComposedHostFrame[] = [];
  let closed = false;
  const { harness, content } = await remoteContentMainHarness(t, collisionHosts(), {
    openHostState: recordingHostState(persisted),
    createWriter: (_stdout, writerOptions) => {
      const driver = createSessionHostFrameWriter(output as unknown as Writable, { ...writerOptions, redrawIntervalMs: 0 });
      return {
        start: () => driver.start(),
        submit: (frame, cols, rows, settle) => {
          submitted.push(frame);
          driver.submit(frame, cols, rows, settle);
        },
        invalidate: () => driver.invalidate(),
        close: () => driver.close(),
      };
    },
  });
  const manager = harnessManager(harness);
  fillForm(harness.terminal, "/pointer/ws-a");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  harness.terminal.setSize(100, 60); // every card fits, so the visible order is unambiguous
  await nextTurn();

  const titles = ["Native native-1", "Alpha one", "Alpha twin", "Beta one", "Legacy card"];
  const first = await emittedScreen(output, harness);
  assert.deepEqual(visibleOrder(first, titles),
    ["Alpha one", "Alpha twin", "Beta one", "Legacy card", "Native native-1"],
  "the emitted screen shows ONE mixed order: the owner cards observed first, then the local row");
  let saved = persistedSequence(persisted.at(-1));
  assert.equal(saved.length, 5, "the saved sequence is the same five-card mixed list the screen shows");
  assert.equal(saved.filter((entry) => entry.startsWith("remote:")).length, 4,
  "first-observed remote identities joined that one sequence");
  const localBefore = saved.filter((entry) => entry.startsWith("local:"));
  const writesBefore = manager.writes.length;
  const remoteInputBefore = content.inputRequests.length;
  const ownerBefore = harness.sidebar?.activeMainOwnerID;

  // 1. The local card onto the UPPER half of the SECOND host's remote card.
  await dragCard(harness, screenRowOf(first, "Native native-1"), screenRowOf(first, "Beta one") + 1);
  const afterFirst = await emittedScreen(output, harness);
  assert.deepEqual(visibleOrder(afterFirst, titles),
    ["Alpha one", "Alpha twin", "Native native-1", "Beta one", "Legacy card"],
  "the emitted screen shows the moved card before that host's card");
  const firstSave = persistedSequence(persisted.at(-1));
  assert.equal(firstSave.length, 5);
  assert.deepEqual(firstSave, movedSequence(saved, saved[4]!, "remote:lab-b:slot:slot-beta-1", "before"),
  "exactly one canonical save moved that entry before that exact host/slot identity");
  saved = firstSave;

  // 2. The legacy null-run card onto the local card: its identity names the exact
  // observed owner run and row, never a local row of the same position.
  await dragCard(harness, screenRowOf(afterFirst, "Legacy card"), screenRowOf(afterFirst, "Native native-1") + 4);
  const afterSecond = await emittedScreen(output, harness);
  assert.deepEqual(visibleOrder(afterSecond, titles),
    ["Alpha one", "Alpha twin", "Native native-1", "Legacy card", "Beta one"],
  "a legacy null-run card lands where it was dropped");
  const secondSave = persistedSequence(persisted.at(-1));
  const legacy = secondSave.filter((entry) => entry.startsWith("remote:lab-c:"));
  assert.equal(legacy.length, 1);
  assert.match(legacy[0]!, /^remote:lab-c:runtime:/,
  "a null owner run is remembered as its exact run and row, not aliased to anything local");
  assert.deepEqual(secondSave.filter((entry) => entry.startsWith("local:")), localBefore,
  "the local rows' own durable identities are untouched by a remote move");
  saved = secondSave;

  // 3. The remote card whose row id equals a LOCAL row id moves without touching
  // the local row of that id, and the two hosts' same-id rows stay distinct.
  await dragCard(harness, screenRowOf(afterSecond, "Alpha twin"), screenRowOf(afterSecond, "Alpha one") + 1);
  const afterThird = await emittedScreen(output, harness);
  assert.deepEqual(visibleOrder(afterThird, titles),
    ["Alpha twin", "Alpha one", "Native native-1", "Legacy card", "Beta one"],
  "a remote row id that collides with a local row id reorders the remote card only");
  const thirdSave = persistedSequence(persisted.at(-1));
  assert.ok(thirdSave.includes("remote:lab-a:slot:slot-alpha-twin"), "the colliding remote card keeps its host and slot");
  assert.ok(thirdSave.includes("remote:lab-b:slot:slot-beta-1"), "the same row id on another host is a different entry");
  assert.deepEqual(thirdSave.filter((entry) => entry.startsWith("local:")), localBefore,
  "and the local rows still name their own slots");

  // Nothing else moved: same session objects, same runtime identities, same owner.
  assert.deepEqual(manager.views.map((view) => [view.id, view.hasLiveProcess, view.lifecycle]),
    [["native-1", true, "alive"]], "the drags created, removed, stopped, or replaced nothing");
  assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "the displayed owner is unchanged");
  assert.equal(harness.sidebar?.focus, "sidebar", "and focus is unchanged");
  assert.equal(manager.writes.length, writesBefore, "no pointer packet reached a local session");
  assert.equal(content.inputRequests.length, remoteInputBefore, "and none reached a remote session");

  // Routing after the moves: clicking a moved card activates that same row.
  const moved = await emittedScreen(output, harness);
  const localRow = screenRowOf(moved, "Native native-1");
  const writesBeforeClick = manager.writes.length;
  press(harness, localRow);
  assert.equal(harness.sidebar?.sessionPointerActive, true, "the press is still pending");
  assert.equal(manager.writes.length, writesBeforeClick, "and it activated nothing on the way in");
  releaseAt(harness, localRow);
  assert.equal(harness.sidebar?.selectedId, "native-1", "the moved card still names its own row");
  harness.terminal.emitInput("after-moved-click");
  assert.equal(manager.writes.at(-1)?.id, "native-1", "and input follows it");
  closed = true;
    assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Exited and error placeholders, and a stale owner projection, are cards too.
// ---------------------------------------------------------------------------

test("exited, errored, and stale-projection cards reorder through real Main without touching their lifecycle", async (t) => {
  const persisted: string[] = [];
  const output = new QueuedFrameOutput();
  const submitted: ComposedHostFrame[] = [];
  const hosts: RemotePeerUiHost[] = [remotePeerHost({
    id: "lab-a", label: "Lab Alpha", hostRunId: "run-a", rosterState: "stale",
    rows: [remoteRosterRow({
      id: "stale-row", label: "Stale card", workspace: "/remote/ws/stale",
      rosterSlotId: "slot-stale", lifecycle: "exited", hasLiveProcess: false, nativeSession: null, exitCode: 0,
    })],
  })];
  let closed = false;
  const { harness } = await remoteContentMainHarness(t, hosts, {
    openHostState: recordingHostState(persisted),
    createWriter: (_stdout, writerOptions) => {
      const driver = createSessionHostFrameWriter(output as unknown as Writable, { ...writerOptions, redrawIntervalMs: 0 });
      return {
        start: () => driver.start(),
        submit: (frame, cols, rows, settle) => {
          submitted.push(frame);
          driver.submit(frame, cols, rows, settle);
        },
        invalidate: () => driver.invalidate(),
        close: () => driver.close(),
      };
    },
  });
  const manager = harnessManager(harness);
  fillForm(harness.terminal, "/pointer/ws-live");
  await nextTurn();
  openNewByPress(harness, submitted.at(-1));
  completeForm(harness.terminal, "/pointer/ws-gone");
  await nextTurn();
  harness.terminal.setSize(100, 60);
  await nextTurn();
  // The second local row exits, and its placeholder card stays in the SAME list.
  const goneIndex = manager.views.findIndex((view) => view.id === "native-2");
  manager.views[goneIndex] = {
    ...manager.views[goneIndex]!,
    lifecycle: "exited", hasLiveProcess: false, busy: null, pendingInput: null, activity: [], backgroundTasks: 0,
  };
  manager.notify("native-2-exited");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  assert.deepEqual(manager.views.map((view) => view.lifecycle), ["alive", "exited"],
  "one live row and one exited placeholder are both roster cards");

  const screen = await emittedScreen(output, harness);
  assert.ok(screenRowOf(screen, "Stale card") > 0,
    `the stale owner projection is still a drawn card: ${JSON.stringify(screen.lines.slice(0, 24))}`);
  const titles = ["Native native-1", "Native native-2", "Stale card"];
  assert.deepEqual(visibleOrder(screen, titles), ["Stale card", "Native native-1", "Native native-2"],
  "the drawn list holds the stale owner card and both local cards");
  const saved = persistedSequence(persisted.at(-1));
  assert.equal(saved.filter((entry) => entry.startsWith("remote:")).length, 1);

  // The exited placeholder is dragged onto the UPPER half of the stale remote card.
  const exitedRow = screenRowOf(screen, "Native native-2");
  assert.ok(exitedRow > 0, "the exited placeholder is drawn as its own card");
  await dragCard(harness, exitedRow, screenRowOf(screen, "Stale card"));
  const after = await emittedScreen(output, harness);
  assert.deepEqual(visibleOrder(after, titles), ["Native native-2", "Stale card", "Native native-1"],
  "the emitted screen shows the exited placeholder before that stale remote card");
  const savedAfter = persistedSequence(persisted.at(-1));
  assert.equal(savedAfter.length, saved.length, "one canonical save, same cards");
  assert.deepEqual([...savedAfter].sort(), [...saved].sort(), "the move re-ordered the same identities");
  assert.ok(savedAfter.indexOf("local:native-2") < savedAfter.indexOf("remote:lab-a:slot:slot-stale"),
  "the exited placeholder now sits before that stale owner card in the one sequence");

  // Lifecycle and identity survive the move: the exited row is still an exited
  // row, the stale owner card is still that owner's stale card, and nothing started.
  assert.deepEqual(manager.views.map((view) => view.lifecycle), ["alive", "exited"],
  "reordering never restarted, removed, or re-created a row");
  assert.equal(manager.spawnCount, 2, "the drag spawned nothing");
  assert.equal(harness.sidebar?.focus, "sidebar", "and it activated nothing");

  // The exited remote card of the stale projection is still the same card, and a
  // click on it keeps its own existing behaviour rather than a reorder side effect.
  const staleRow = screenRowOf(after, "Stale card");
  press(harness, staleRow);
  releaseAt(harness, staleRow);
  assert.equal(persistedSequence(persisted.at(-1)).join(), savedAfter.join(),
  "the click committed no further order change");
  closed = true;
    assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Written-frame authority, geometry, and lifecycle.
// ---------------------------------------------------------------------------

test("a refused frame cannot retarget a drop: the release commits against the order the writer actually emitted", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const rowB = screenRowOf(screen, "Native native-2");
    const saved = persistedSequence(persisted.at(-1));
    const persistsBefore = persisted.length;

    press(harness, rowA);
    moveTo(harness, rowA + 1);
    // Refuse the preview frame: the newer mutable map already shows the moved
    // card, but the SCREEN still shows the original order.
    output.refuseNextWrite();
    moveTo(harness, rowB + 4);
    await nextTurn();
    assert.equal(output.queuedCount, 1, "the preview frame never reached the sink");
    assert.deepEqual(visibleOrder(await emittedScreen(output, harness),
      ["Native native-1", "Native native-2"]), ["Native native-1", "Native native-2"],
    "the emitted screen still shows the pre-drag order");
    assert.deepEqual(visibleOrder(await emittedScreen(output, harness, true),
      ["Native native-1", "Native native-2"]), ["Native native-2", "Native native-1"],
    "the queued, unwritten candidate is the only place the preview exists");

    releaseAt(harness, rowB + 4);
    await nextTurn();
    assert.equal(persisted.length, persistsBefore + 1, "one canonical save, made on the written order");
    assert.deepEqual(persistedSequence(persisted.at(-1)),
      movedSequence(saved, saved[0]!, saved[1]!, "after"),
    "the drop used the written map's destination, not the refused preview frame");
    assert.equal(harness.sidebar?.sessionPointerActive, false, "the gesture retired exactly once");
    assert.equal(harness.sidebar?.focus, "sidebar",
    "and it activated nothing on the way out: focus and input ownership stay");

    output.drain();
    await nextTurn();
    assert.deepEqual(visibleOrder(await emittedScreen(output, harness),
      ["Native native-1", "Native native-2"]), ["Native native-2", "Native native-1"],
    "the committed order is what the screen shows once the pending frames settle");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    if (output.queuedCount > 0) output.drain();
    await ensureShutdown(harness, closed);
  }
});

test("a resize, a hide, and a roster membership change each abandon the drag; live status updates do not", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    const manager = await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const rowB = screenRowOf(screen, "Native native-2");
    const startSaves = persisted.length;
    const startSequence = persistedSequence(persisted.at(-1));
    assert.equal(startSequence.length, 2, "the two local rows are the one canonical sequence");

    // A reflow — including one that returns to the same size — retires the maps.
    press(harness, rowA);
    moveTo(harness, rowB + 4);
    await nextTurn();
    assert.equal(harness.sidebar?.sessionMoveActive, true, "a preview exists before the reflow");
    harness.terminal.setSize(80, 24);
    harness.terminal.setSize(80, 24);
    await nextTurn();
    releaseAt(harness, rowB + 4);
    assert.equal(persisted.length, startSaves, "the reflowed drag committed nothing");
    assert.equal(harness.sidebar?.focus, "sidebar", "and its release activated nothing");

    // Hiding the roster mid-drag abandons it the same way.
    // The hide case needs the wide layout, so return to it first.
    harness.terminal.setSize(100, 40);
    await nextTurn();
    const shownAgain = await emittedScreen(output, harness);
    const againA = screenRowOf(shownAgain, "Native native-1");
    const againB = screenRowOf(shownAgain, "Native native-2");
    press(harness, againA);
    moveTo(harness, againB + 4);
    await nextTurn();
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    if (harness.sidebar?.visible !== false) {
      harness.terminal.emitInput(ALT_LEFT); // the other toggle step hides the host pane
      await nextTurn();
    }
    assert.equal(harness.sidebar?.visible, false, "the roster is hidden");
    assert.equal(harness.sidebar?.sessionPointerActive, false, "a hidden roster abandons the press");
    releaseAt(harness, againB + 4);
    assert.equal(persisted.length, startSaves, "and its release commits nothing");

    // A live status/activity update keeps the unfinished preview, and the release
    // then commits it.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const live = await emittedScreen(output, harness);
    const stillA = screenRowOf(live, "Native native-1");
    const stillB = screenRowOf(live, "Native native-2");
    press(harness, stillA);
    moveTo(harness, stillB + 4);
    await nextTurn();
    const index = manager.views.findIndex((view) => view.id === "native-1");
    manager.views[index] = {
      ...manager.views[index]!, busy: true, activity: ["working"], backgroundTasks: 2,
    };
    manager.notify("live-status-and-name-only");
    await nextTurn();
    assert.equal(harness.sidebar?.sessionPointerActive, true, "status, activity, and label changes keep the press");
    assert.equal(harness.sidebar?.sessionMoveActive, true, "and keep the previewed position");
    releaseAt(harness, stillB + 4);
    await nextTurn();
    assert.equal(persisted.length, startSaves + 1, "the drag committed exactly one canonical save");
    assert.deepEqual(persistedSequence(persisted.at(-1)),
      movedSequence(startSequence, startSequence[0]!, startSequence[1]!, "after"),
    "and it is the same single sequence with the pressed card after the other");

    // A membership change retires the next unfinished drag and keeps the order
    // that was already committed.
    const current = await emittedScreen(output, harness);
    const srcRow = screenRowOf(current, "Native native-2");
    const dstRow = screenRowOf(current, "Native native-1");
    assert.ok(srcRow > 0 && dstRow > 0, "both committed cards are drawn after the move");
    press(harness, srcRow);
    moveTo(harness, dstRow + 1);
    await nextTurn();
    assert.equal(harness.sidebar?.sessionMoveActive, true, "a new preview exists");
    manager.views.push({
      id: "native-9", label: "Native native-9", workspace: "/pointer/ws-joined", agentDir: "/private-profile/native-9",
      lifecycle: "alive", hasLiveProcess: true, busy: null, pendingInput: null, inputSurface: false,
      activity: [], nativeSession: { sessionId: "conversation-native-9", epoch: 1, name: "Native native-9" },
    });
    manager.notify("row-joined");
    await nextTurn();
    const savesAfterJoin = persisted.length;
    assert.equal(harness.sidebar?.sessionPointerActive, false,
    "a roster membership change cancels the unfinished move");
    releaseAt(harness, dstRow + 1);
    assert.equal(persisted.length, savesAfterJoin, "the cancelled drag itself saved nothing new");
    assert.deepEqual(visibleOrder(await emittedScreen(output, harness),
      ["Native native-2", "Native native-1"]), ["Native native-2", "Native native-1"],
    "the previously committed order is what stays on screen");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

// ---------------------------------------------------------------------------
// Outer mouse reporting for the held gesture.
// ---------------------------------------------------------------------------

test("the outer capture reports drag motion only while the session press is held and never downgrades a stronger mode", async () => {
  let closed = false;
  const { harness, lastFrame } = realWriterHarness();
  try {
    const manager = await startLocalRows(harness, 2, lastFrame);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main", "Main owns input while the roster stays visible beside it");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"],
      "the visible host pane already asks for press reports");

    const surface = manager.surface("native-2");
    assert.ok(surface);
    surface.modes = { ...surface.modes, mouseTracking: "drag", mouseEncoding: "sgr" };
    manager.notify("child-drag-mode");
    await nextTurn();
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"],
      "the live child's own drag mode is honoured");
    const rowA = composedRowOf(lastFrame(), "Native native-1");
    assert.ok(rowA > 0);

    // The child is back to press-only, so the held session press must raise it.
    surface.modes = { ...surface.modes, mouseTracking: "vt200" };
    manager.notify("child-vt200-mode");
    await nextTurn();
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"]);
    const beforePress = harness.terminal.writes.length;
    press(harness, rowA);
    assert.deepEqual(harness.terminal.writes.slice(beforePress), ["\x1b[?1000l", "\x1b[?1002h"],
    "the held session press raises the host capture to drag reporting with SGR already on");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"],
    "motion really is reportable while the session press is held");
    const beforeHold = harness.terminal.writes.length;
    moveTo(harness, rowA + 6);
    assert.deepEqual(harness.terminal.writes.slice(beforeHold), [], "no mode churn while the drag runs");
    const beforeRelease = harness.terminal.writes.length;
    releaseAt(harness, rowA + 6);
    assert.deepEqual(harness.terminal.writes.slice(beforeRelease), ["\x1b[?1002l", "\x1b[?1000h"],
    "the release returns to the ordinary press capture, nothing else");

    // A child's stronger "any" mode is never downgraded by the gesture.
    surface.modes = { ...surface.modes, mouseTracking: "any" };
    manager.notify("child-any-mode");
    await nextTurn();
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1003"]);
    const beforeAny = harness.terminal.writes.length;
    press(harness, rowA);
    moveTo(harness, rowA + 6);
    releaseAt(harness, rowA + 6);
    assert.deepEqual(harness.terminal.writes.slice(beforeAny), [],
    "a native 1003 request is preserved untouched through a session drag");

    // A held gesture ends cleanly at a resize and at a hide: no drag capture is
    // left enabled, and the ordinary desired reporting is what remains.
    press(harness, rowA);
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1003"], "the stronger mode still stands");
    harness.terminal.setSize(100, 40);
    await nextTurn();
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1003"],
    "the resize retired the gesture and kept the child's own mode, with no 1002 left");
    press(harness, rowA);
    harness.terminal.emitInput(ALT_LEFT); // Main -> roster
    harness.terminal.emitInput(ALT_LEFT); // hide the host pane
    await nextTurn();
    assert.equal(harness.sidebar?.visible, false);
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1003"],
    "hiding the roster leaves no drag capture behind");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), [],
    "shutdown disables exactly the modes this host enabled");
  } finally {
    await ensureShutdown(harness, closed);
  }
});

// ---------------------------------------------------------------------------
// Overflow: edge dragging and the frame-bound stationary hold.
// ---------------------------------------------------------------------------

test("edge dragging and a stationary hold reveal an offscreen card, and the drop lands on it", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  harness.terminal.rows = 14; // the list window fits one and a half expanded cards
  harness.stdout.rows = 14;
  try {
    const manager = await startLocalRows(harness, 3, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    harness.terminal.emitInput("\x1b[A"); // highlight the FIRST card, so the window shows the top
    harness.terminal.emitInput("\x1b[A");
    await nextTurn();
    let screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    assert.ok(rowA > 0, `the first card is drawn at the top of the window: ${JSON.stringify(screen.lines)}`);
    assert.equal(screenRowOf(screen, "Native native-3"), -1, "the tail card starts offscreen");
    const startSequence = persistedSequence(persisted.at(-1));
    assert.equal(startSequence.length, 3);

    const footerRow = screen.lines.findIndex((line, index) => index > 0
      && line.replace(SGR, "").slice(0, SIDEBAR_COLS).includes("toggle"));
    assert.ok(footerRow > 0, "the roster footer is drawn");
    const edgeRow = footerRow - 1; // the last row of the drawn list window

    press(harness, rowA);
    moveTo(harness, edgeRow);
    await nextTurn();
    screen = await emittedScreen(output, harness);
    assert.notEqual(screenRowOf(screen, "Native native-1"), rowA, "the first edge step scrolled the window");

    // Stationary hold: no further mouse motion at all, one bounded step per
    // actually-written frame.
    const writesBeforeHold = output.writes.length;
    const deadline = Date.now() + 2000;
    let revealed = -1;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      screen = await emittedScreen(output, harness);
      revealed = screenRowOf(screen, "Native native-3");
      if (revealed > 0) break;
    }
    assert.ok(revealed > 0, "the stationary hold revealed the offscreen card without further mouse motion");
    const stepsDuringHold = output.writes.length - writesBeforeHold;
    assert.ok(stepsDuringHold <= 8, `the hold advanced one bounded step per written frame, saw ${stepsDuringHold}`);

    // Drop on the revealed tail card: the row that was offscreen before the
    // hold is now a real drop target.
    const dropRow = Math.min(revealed + 4, edgeRow);
    moveTo(harness, dropRow);
    await nextTurn();
    releaseAt(harness, dropRow);
    await nextTurn();
    const saved = persistedSequence(persisted.at(-1));
    assert.equal(saved.length, 3, "one canonical sequence for three local rows");
    assert.deepEqual([...saved].sort(), [...startSequence].sort(), "the same three cards, re-ordered");
    assert.ok(saved.indexOf(startSequence[0]!) > saved.indexOf(startSequence[2]!),
    `the position that was offscreen became a real drop behind the tail row: ${JSON.stringify(saved)}`);
    assert.equal(harness.sidebar?.sessionPointerActive, false);
    assert.equal(manager.views.filter((view) => view.hasLiveProcess).length, 3,
    "scrolling and dropping never touched a live session");

    // The finished gesture leaves no edge timer behind: the frame sink goes quiet.
    let quiesced = false;
    const settleDeadline = Date.now() + 3000;
    while (Date.now() < settleDeadline) {
      const before = output.writes.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      if (output.writes.length === before) { quiesced = true; break; }
    }
    assert.ok(quiesced, "the edge hold terminates once the gesture ends");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("blank space inside the list ends the session list, and the host action rows keep their rows", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    await startLocalRows(harness, 2, lastFrame);
    harness.terminal.setSize(100, 40);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const savedRow = screenRowOf(screen, "Saved conversations");
    const settingsRow = screenRowOf(screen, "Host shortcuts");
    assert.ok(savedRow > 0 && settingsRow > 0, "the action rows stay drawn after every session card");
    const endRow = screen.lines.findIndex((line, index) => index > settingsRow
      && line.replace(SGR, "").slice(0, SIDEBAR_COLS).trim() === "");
    assert.ok(endRow > 0, "blank space inside the list window follows the drawn entries");
    const saved = persistedSequence(persisted.at(-1));

    await dragCard(harness, rowA, endRow);
    const endSaved = persistedSequence(persisted.at(-1));
    assert.deepEqual(endSaved, movedSequence(saved, saved[0]!, saved[1]!, "after"),
    "the end position appends after the LAST session card, never after an action row");
    const after = await emittedScreen(output, harness);
    assert.equal(screenRowOf(after, "Saved conversations") > screenRowOf(after, "Native native-2"), true,
    "the action rows stay after every session card");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

/** Legacy X10 mouse report: three bytes, and a release names no button at all. */
function emitX10(terminal: FakeTerminal, column: number, row: number, button = 0): void {
  terminal.emitInput(`${ESC}[M${String.fromCharCode(button + 32, column + 33, row + 33)}`);
}

test("a legacy X10 session-card press is held too, and its unidentified release activates exactly once", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    const manager = await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const sequenceBefore = persistedSequence(persisted.at(-1));
    assert.equal(sequenceBefore.length, 2, "the two local rows are the one canonical sequence");
    const writesBefore = manager.writes.length;

    emitX10(harness.terminal, 1, rowA);
    assert.equal(harness.sidebar?.sessionPointerActive, true, "the legacy press is held, not activated");
    assert.equal(manager.writes.length, writesBefore, "and nothing reached a session on press");

    // X10 reports a release as button 3 without saying which button ended. The
    // host owns that ambiguous release because it owns the press.
    emitX10(harness.terminal, 1, rowA, 3);
    assert.equal(harness.sidebar?.selectedId, "native-1", "the unidentified release activates that card once");
    assert.equal(harness.sidebar?.sessionPointerActive, false, "and retires the gesture");
    assert.deepEqual(persistedSequence(persisted.at(-1)), sequenceBefore, "a click commits no order change");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

// ---------------------------------------------------------------------------
// Review pass 1 corrections: unrelated wheel input, revoked written maps,
// post-reflow pointer authority, and the fence a hide must not drop.
// ---------------------------------------------------------------------------

const EMPTY_SAVED_CATALOG: SavedSessionCatalog = {
  agentDir: "/synthetic-agent",
  sessionsRoot: "/synthetic-agent/sessions",
  revision: 1,
  rows: [],
  issues: [],
  issueCount: 0,
};

test("a wheel report never ends a held session gesture and never drops its button fence", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    const manager = await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const rowB = screenRowOf(screen, "Native native-2");
    const saved = persistedSequence(persisted.at(-1));
    const savesBefore = persisted.length;
    const writesBefore = manager.writes.length;

    press(harness, rowA);
    assert.equal(harness.sidebar?.sessionPointerActive, true, "the card click is held");
    const selection = harness.sidebar?.selectedId;
    // A wheel press AND a wheel release carry no button id at all. Neither may
    // finish the held card gesture, activate the card, or drop its fence.
    emitMouse(harness.terminal, 1, rowA, 64, "m");
    emitMouse(harness.terminal, 1, rowA, 65, "m");
    assert.equal(harness.sidebar?.sessionPointerActive, true, "wheel reports leave the click held");
    assert.equal(harness.sidebar?.selectedId, selection, "and they activate nothing");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"],
    "the gesture's drag reporting stays up across wheel input");

    moveTo(harness, rowB + 4);
    await nextTurn();
    assert.equal(harness.sidebar?.sessionMoveActive, true, "the drag previews a move");
    emitMouse(harness.terminal, 1, rowB + 4, 64);
    emitMouse(harness.terminal, 1, rowB + 4, 65, "m");
    assert.equal(harness.sidebar?.sessionPointerActive, true, "the drag survives wheel input");
    assert.equal(harness.sidebar?.sessionMoveActive, true, "and keeps its previewed position");

    releaseAt(harness, rowB + 4);
    await nextTurn();
    assert.equal(persisted.length, savesBefore + 1, "the real release commits exactly one reorder");
    assert.deepEqual(persistedSequence(persisted.at(-1)), movedSequence(saved, saved[0]!, saved[1]!, "after"),
    "and it is the dragged card after the other");
    assert.equal(manager.writes.length, writesBefore, "no wheel or button packet reached a session");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a Saved listing that revokes the written maps abandons the held drag completely", async (t) => {
  let closed = false;
  const persisted: string[] = [];
  const output = new QueuedFrameOutput();
  const submitted: ComposedHostFrame[] = [];
  let releaseListing: (() => void) | undefined;
  const listingGate = new Promise<void>((resolve) => { releaseListing = resolve; });
  const { harness } = await peerMainHarness(t, undefined, {
    ...realWriterDependencies(output, submitted),
    openHostState: recordingHostState(persisted),
    listSavedCatalog: async () => { await listingGate; return EMPTY_SAVED_CATALOG; },
  });
  try {
    const manager = harnessManager(harness);
    fillForm(harness.terminal, "/pointer/saved-1");
    await nextTurn();
    openNewByPress(harness, submitted.at(-1));
    completeForm(harness.terminal, "/pointer/saved-2");
    await nextTurn();
    harness.terminal.setSize(100, 40);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    // Open the Saved picker with the keyboard; its listing stays in flight.
    harness.terminal.emitInput("\x1b[B"); // selection -> Saved conversations
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "the Saved picker is open beside the visible roster");
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const rowB = screenRowOf(screen, "Native native-2");
    assert.ok(rowA > 0 && rowB > 0, `both cards stay drawn beside the picker: ${JSON.stringify(screen.lines.slice(0, 20))}`);
    const savesBefore = persisted.length;
    const focusBefore = harness.sidebar?.focus;
    const writesBefore = manager.writes.length;

    press(harness, rowA);
    moveTo(harness, rowA + 1);
    moveTo(harness, rowB + 4);
    await nextTurn();
    assert.equal(harness.sidebar?.sessionPointerActive, true, "a card beside the picker holds the press");
    assert.equal(harness.sidebar?.sessionMoveActive, true, "and previews a move");

    // The asynchronous listing completes and revokes the draw-derived maps.
    releaseListing?.();
    await nextTurn();
    await nextTurn();
    assert.equal(harness.sidebar?.sessionPointerActive, false,
    "the revoked maps abandon the held press instead of leaving it pending");
    assert.equal(enabledTrackingModes(harness.terminal.writes).includes("1002"), false,
    "and the temporary drag reporting comes back down");

    // Later motion and the physical release of that abandoned press do nothing.
    moveTo(harness, rowB + 4);
    releaseAt(harness, rowB + 4);
    await nextTurn();
    assert.equal(persisted.length, savesBefore, "nothing was committed");
    assert.equal(harness.sidebar?.focus, focusBefore, "and nothing was activated");
    assert.equal(manager.writes.length, writesBefore, "and no packet reached a session");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a roundtrip resize revokes session-pointer authority until a post-resize frame is written", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    harness.terminal.emitInput("n"); // no session displayed: no native receipt can mask stale roster authority
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const rowB = screenRowOf(screen, "Native native-2");
    const savesBefore = persisted.length;
    const focusBefore = harness.sidebar?.focus;
    const selectionBefore = harness.sidebar?.selectedId;
    const ownerBefore = harness.sidebar?.activeMainOwnerID;
    assert.equal(ownerBefore, undefined, "Main is detached, so only the roster maps could authorize this press");

    // The reflow's repaint is backpressured: nothing post-resize reaches the
    // sink, yet the reflow's candidate stays authorization-equal to the last
    // written frame because the geometry roundtrips to the same size.
    output.refuseNextWrite();
    harness.terminal.setSize(60, 30);
    harness.terminal.setSize(80, 24); // a true roundtrip back to the starting geometry
    await nextTurn();
    assert.ok(output.queuedCount >= 1, "the post-reflow repaint is still unwritten");

    press(harness, rowA);
    assert.equal(harness.sidebar?.focus, focusBefore, "stale maps cannot activate on press");
    assert.equal(harness.sidebar?.selectedId, selectionBefore, "stale maps cannot select on press");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "stale maps cannot adopt an owner");
    assert.equal(harness.sidebar?.sessionPointerActive, false,
    "a fresh press cannot begin a card gesture from pre-reflow maps");
    moveTo(harness, rowB + 4);
    releaseAt(harness, rowB + 4);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, focusBefore, "and the matching release activates nothing either");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "and adopts no owner");
    assert.equal(persisted.length, savesBefore, "and no reorder is committed against stale maps");

    // Once a post-reflow frame actually reaches the sink, the gesture works again.
    output.drain();
    await nextTurn();
    const after = await emittedScreen(output, harness);
    const stillA = screenRowOf(after, "Native native-1");
    const stillB = screenRowOf(after, "Native native-2");
    assert.ok(stillA > 0 && stillB > 0, "both cards are drawn again after the reflow");
    press(harness, stillA);
    assert.equal(harness.sidebar?.sessionPointerActive, true,
    "the written post-reflow frame restores session-pointer authority");
    releaseAt(harness, stillA);
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a canceled capture's release is fenced exactly once and leaves no held button behind", async () => {
  let closed = false;
  const persisted: string[] = [];
  const { harness, output, lastFrame } = realWriterHarness({ persisted });
  try {
    const manager = await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const screen = await emittedScreen(output, harness);
    const rowA = screenRowOf(screen, "Native native-1");
    const rowB = screenRowOf(screen, "Native native-2");
    assert.ok(rowA > 0 && rowB > 0, "both cards are drawn on the written screen");
    const saved = persistedSequence(persisted.at(-1));
    const savesBefore = persisted.length;
    const selectionBefore = harness.sidebar?.selectedId;

    press(harness, rowA);
    assert.equal(harness.sidebar?.sessionPointerActive, true, "the card press is captured");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"],
      "the held gesture raises drag reporting");

    // A reflow abandons the gesture. The pressed button stays owned ONCE, as the
    // retired state of that one button, and the temporary reporting comes down.
    harness.terminal.setSize(60, 30);
    await nextTurn();
    assert.equal(harness.sidebar?.sessionPointerActive, false, "the reflow abandons the held press");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"],
      "and the drag reporting comes back down");

    // The motion and the physical release of that abandoned press are consumed:
    // no activation, no reorder, and nothing reaches a session.
    const writesBefore = manager.writes.length;
    moveTo(harness, rowA + 1);
    releaseAt(harness, rowA);
    await nextTurn();
    assert.equal(harness.sidebar?.selectedId, selectionBefore, "the fenced release activates nothing");
    assert.equal(persisted.length, savesBefore, "and it commits no reorder");
    assert.equal(manager.writes.length, writesBefore, "and no packet reached a session");

    // And nothing of that press is held any more. With Main owning the native
    // pane and the displayed owner asking for its own reporting, a SECOND release
    // of the same button has no press behind it, so it keeps its ordinary native
    // route: a retired fence that outlived its release would swallow it here.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    if (harness.sidebar?.visible !== false) {
      harness.terminal.emitInput(ALT_LEFT);
      await nextTurn();
    }
    assert.equal(harness.sidebar?.visible, false, "the roster is hidden, so nothing covers the native pane");
    const surface = manager.surface("native-2");
    assert.ok(surface, "the displayed owner has its own observed surface");
    surface.modes = { ...surface.modes, mouseTracking: "drag", mouseEncoding: "sgr" };
    manager.notify("child-enables-reporting");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main", "Main owns the native viewport");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"],
      "the child's own drag reporting is what is on now");

    const nativeWritesBefore = manager.writes.length;
    emitMouse(harness.terminal, 45, 5, 0, "m");
    await nextTurn();
    assert.ok(manager.writes.length > nativeWritesBefore,
      "an extra release of the abandoned button is not swallowed by a stale fence");

    // The native press/motion/release sequence reaches its owner intact.
    const sequenceBefore = manager.writes.length;
    emitMouse(harness.terminal, 45, 5);
    emitMouse(harness.terminal, 45, 6, DRAG_MOTION);
    emitMouse(harness.terminal, 45, 6, 0, "m");
    await nextTurn();
    assert.equal(manager.writes.length, sequenceBefore + 3,
      "the owner's own press, motion, and release all arrive");

    // A fresh host capture afterwards is a new generation, not a resumption of
    // the abandoned one: it holds, previews, and commits exactly one reorder.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar?.visible, true, "the roster is drawn again");
    const again = await emittedScreen(output, harness);
    const freshA = screenRowOf(again, "Native native-1");
    const freshB = screenRowOf(again, "Native native-2");
    assert.ok(freshA > 0 && freshB > 0, "both cards are drawn after the roster returns");
    press(harness, freshA);
    assert.equal(harness.sidebar?.sessionPointerActive, true, "the next press is captured anew");
    moveTo(harness, freshA + 1);
    moveTo(harness, freshB + 4);
    await nextTurn();
    assert.equal(harness.sidebar?.sessionMoveActive, true, "and previews its move");
    releaseAt(harness, freshB + 4);
    await nextTurn();
    assert.equal(persisted.length, savesBefore + 1, "and its release commits exactly one reorder");
    assert.deepEqual(persistedSequence(persisted.at(-1)), movedSequence(saved, saved[0]!, saved[1]!, "after"),
      "which is the dragged card after the other");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a release after a hide during capture never reaches a child that enabled reporting meanwhile", async () => {
  let closed = false;
  const { harness, lastFrame } = realWriterHarness();
  try {
    const manager = await startLocalRows(harness, 2, lastFrame);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const rowA = composedRowOf(lastFrame(), "Native native-1");
    assert.ok(rowA > 0, "the card is drawn in the written frame");
    const surface = manager.surface("native-2");
    assert.ok(surface, "the displayed owner has its own observed surface");
    surface.modes = { ...surface.modes, mouseTracking: "none" };
    manager.notify("child-reporting-off");
    await nextTurn();
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"],
      "only the host pane's own press reporting is on");

    press(harness, rowA);
    assert.equal(harness.sidebar?.sessionPointerActive, true, "the card press is captured");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"],
      "the held gesture raises drag reporting");

    // Hide the roster mid-capture. With no host pane and no release-capable
    // native mode the ordinary rules discard their press bookkeeping; the
    // session-owned button has to stay fenced regardless.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    if (harness.sidebar?.visible !== false) {
      harness.terminal.emitInput(ALT_LEFT);
      await nextTurn();
    }
    assert.equal(harness.sidebar?.visible, false, "the roster is hidden");
    assert.equal(harness.sidebar?.sessionPointerActive, false, "and the captured gesture is abandoned");

    // The native owner enables its own mouse reporting before the physical release.
    surface.modes = { ...surface.modes, mouseTracking: "vt200", mouseEncoding: "sgr" };
    manager.notify("child-enables-reporting");
    await nextTurn();
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"],
      "the child's own press reporting is now on");
    const writesBefore = manager.writes.length;
    releaseAt(harness, rowA);
    assert.equal(manager.writes.length, writesBefore,
    "the late release never reaches the child without its press");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});
