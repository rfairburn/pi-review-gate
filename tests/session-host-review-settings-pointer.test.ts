/**
 * Issue #723: native row clicks and wheel routing on the session-host sidebar's
 * Review settings surface, driven through the PRODUCTION host input-routing path.
 *
 * Every case runs the real `main.ts` controller over the focused fake
 * terminal/writer/manager harness with the real shared persisted settings
 * transaction behind the sidebar's own Review settings host. Pointer packets are
 * synthetic SGR reports delivered through the terminal input callback — input
 * protocol evidence, not physical-device evidence — and every assertion reads
 * the ACTUAL frame the writer reported WRITTEN, so a route that ran against a
 * frame the operator never saw can never pass.
 *
 * What is proven here:
 * - a left press on a drawn Review settings row highlights exactly that row and
 *   activates nothing; the matching stationary release completes the native
 *   click and activates that row exactly once;
 * - the whole gesture belongs to the host: while the press is held the outer
 *   capture is raised to drag reporting (and back down afterwards), motion and
 *   release never reach a child, and no other route sees them;
 * - a drag away and back can never activate, a release on another row can never
 *   activate, and the next ordinary click still works;
 * - one vertical wheel report over the drawn rows steps the highlight exactly
 *   one row, clamped at both ends, and activates nothing; a report anywhere else
 *   in the pane stays the existing consumed no-op;
 * - a press against a frame the writer never wrote is refused;
 * - keyboard input while a press is held retires it, so a later release at the
 *   same coordinates and labels still cannot activate;
 * - the narrow overlay (the form replacing the roster) routes the identical
 *   gesture, and keyboard navigation, Escape, and Save keep working after any
 *   pointer use.
 *
 * The left-roster implicit-cancel/discard policy is deliberately NOT part of
 * this file: it is unchanged and lives at the shared sidebar boundary.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { openLocalReviewSettings } from "../src/session-host/review-settings";
import type { ReviewSettingsCatalog } from "../src/session-host/review-settings-catalog";
import type { PeerUiConsent } from "../src/session-host/peer-ui-protocol";
import {
  closeWithSignal,
  createHarness,
  emitMouse,
  FakePeerCoordinator,
  makeMainTestDirectory,
  nextTurn,
  ready,
  type Harness,
} from "./helpers/session-host-main-harness";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_S = "\x13";
/** The SGR motion bit: the same left button with motion reported. */
const DRAG_MOTION = 32;
/** SGR wheel reports: button 64 is the up notch, 65 the down notch. */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
/** The wide layout's form slot begins just right of the 35-column roster. */
const WIDE_FORM_COLUMN = 35;

function fakeCatalog(): ReviewSettingsCatalog {
  return {
    scoped: [],
    tools: [{ name: "bash", description: "Execute a command." }],
    warnings: [],
    modelScope: { source: "enabledModels", patterns: [] },
  };
}

/** A synthetic agent directory holding one real review-gate.json. */
function ownedAgentDir(t: TestContext): string {
  const dir = makeMainTestDirectory("review-settings-pointer-agent");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "keybindings.json"), "{}", "utf8");
  writeFileSync(join(dir, "review-gate.json"), JSON.stringify({ operatingMode: "execute" }, null, 2), "utf8");
  return dir;
}

/**
 * The real host with the real LOCAL Review settings service: no transport, no
 * provider, no real Pi session, and every path owned by this test.
 */
function reviewHarness(t: TestContext): { harness: Harness; configPath: string; peer: FakePeerCoordinator } {
  const agentDir = ownedAgentDir(t);
  const root = mkdtempSync(join(tmpdir(), "rs-pointer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  // The band a peer request adds is the ONLY thing that can reflow this pane
  // without a terminal resize, so the host owns one fake coordinator it can
  // drive directly. With no consents published it draws nothing and changes
  // nothing else in these cases.
  const peer = new FakePeerCoordinator();
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home } }, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("the synthetic harness prepares no profile"); } },
    }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({ status: "opened", state: {
      agentDir: ownedDir, hostId, ownershipPath: join(ownedDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => true,
    } }),
    openLocalReviewSettings: (input) => openLocalReviewSettings(input, { loadChoices: async () => fakeCatalog() }),
    createPeerCoordinator: (options) => { peer.options = options; return peer; },
  });
  return { harness, configPath: join(agentDir, "review-gate.json"), peer };
}

/** One synthetic incoming peer request: the sole input to the roster's alert band. */
function syntheticConsent(id: string, requestedAt = Date.now()): PeerUiConsent {
  return {
    id, kind: "incoming", label: "Expected peer", fingerprint: "A".repeat(43), endpoint: null,
    requestedAt, expiresAt: requestedAt + 120_000,
  };
}

/** The frame the writer last reported, with styling removed. */
function written(harness: Harness): string[] {
  return (harness.writer.frames.at(-1)?.frame.lines ?? []).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

/**
 * The column the Review settings pane is drawn in: the form slot beside the
 * roster when the roster is still drawn, or column 0 when a narrow overlay
 * replaced the roster with the form.
 */
function paneColumn(harness: Harness): number {
  return written(harness)[1]?.includes("Sessions (") === true ? WIDE_FORM_COLUMN : 0;
}

/** The Review settings pane's own lines from the WRITTEN frame, divider removed. */
function paneLines(harness: Harness): string[] {
  const column = paneColumn(harness);
  return written(harness).map((line) => line.slice(column).replace(/^[│|]+/, ""));
}

/** The row this WRITTEN frame drew the given Review settings text on. */
function drawnRow(harness: Harness, label: string): number {
  const row = paneLines(harness).findIndex((line) => line.includes(label));
  assert.ok(row >= 0, `the written frame draws ${label}:\n${written(harness).join("\n")}`);
  return row;
}

/** A column inside the drawn row this WRITTEN frame put the given text on. */
function drawnColumn(harness: Harness, label: string): number {
  const column = paneColumn(harness);
  const line = written(harness)[drawnRow(harness, label)] ?? "";
  return column + line.slice(column).indexOf(label) + 1;
}

/** The row this WRITTEN frame marks as selected inside the Review settings pane. */
function highlighted(harness: Harness): string {
  const line = paneLines(harness).find((value) => value.includes("→ "));
  return line === undefined ? "" : line.trim();
}

/** True while the WRITTEN frame is the shared root list rather than a submenu. */
function atRootList(harness: Harness): boolean {
  return paneLines(harness).some((line) => line.trim() === "Review settings");
}

/**
 * The row this WRITTEN frame drew the root list's title on: one number that
 * says where the whole Review settings pane sits, so a reflow that moved the
 * pane is visible without depending on which rows the list windowed.
 */
function paneTitleRow(harness: Harness): number {
  const row = paneLines(harness).findIndex((line) => line.trim() === "Review settings");
  assert.ok(row >= 0, `the written frame draws the root list's title:\n${written(harness).join("\n")}`);
  return row;
}

/** The row this WRITTEN frame drew a whole-row choice ("Yes", "No", "Back") on. */
function drawnChoiceRow(harness: Harness, choice: string): number {
  const row = paneLines(harness).findIndex((line) => line.trim().replace(/^→\s*/, "") === choice);
  assert.ok(row >= 0, `the written frame offers the ${choice} choice:\n${written(harness).join("\n")}`);
  return row;
}

/** Keyboard-step the pane's own list until it marks the given row. */
async function keyboardTo(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    if (highlighted(harness).startsWith(`→ ${label}`)) return;
    harness.terminal.emitInput(DOWN);
    await nextTurn();
  }
  assert.fail(`the pane never highlighted ${label}:\n${written(harness).join("\n")}`);
}

/** The mouse-tracking modes this host currently has enabled, in order of write. */
function enabledTrackingModes(harness: Harness): string[] {
  const on = new Set<string>();
  for (const value of harness.terminal.writes) {
    const match = /^\x1b\[\?(\d{4})([hl])$/.exec(value);
    if (match === null || !(match[1] === "1000" || match[1] === "1002" || match[1] === "1003")) continue;
    if (match[2] === "h") on.add(match[1]!);
    else on.delete(match[1]!);
  }
  return [...on].sort();
}

const pressRow = (harness: Harness, column: number, row: number): void => emitMouse(harness.terminal, column, row);
const releaseRow = (harness: Harness, column: number, row: number): void => emitMouse(harness.terminal, column, row, 0, "m");
const motionRow = (harness: Harness, column: number, row: number): void => emitMouse(harness.terminal, column, row, DRAG_MOTION);
const wheelRow = (harness: Harness, column: number, row: number, notch: number): void => {
  harness.terminal.emitInput(`\x1b[<${notch};${column + 1};${row + 1}M`);
};
/** A non-primary (right) button press and its matching release. */
const rightClick = (harness: Harness, column: number, row: number): void => {
  emitMouse(harness.terminal, column, row, 2);
  emitMouse(harness.terminal, column, row, 2, "m");
};
/** A horizontal wheel report (button 66): never a vertical scroll notch. */
const horizontalWheel = (harness: Harness, column: number, row: number): void => {
  harness.terminal.emitInput(`\x1b[<66;${column + 1};${row + 1}M`);
};
/**
 * One legacy X10 report. Its release form (button code 3) identifies NO button,
 * which is exactly why an anonymous release can only be matched to a held press
 * when that press's button was the only one reported down (#723).
 */
const legacyReport = (harness: Harness, column: number, row: number, button: number): void => {
  harness.terminal.emitInput(`\x1b[M${String.fromCharCode(32 + button, 33 + column, 33 + row)}`);
};
const legacyPress = (harness: Harness, column: number, row: number, button = 0): void => {
  legacyReport(harness, column, row, button);
};
const legacyRelease = (harness: Harness, column: number, row: number): void => {
  legacyReport(harness, column, row, 3);
};

/**
 * The rows this WRITTEN frame drew the root list's ITEMS on, top to bottom:
 * between the list's own title and its scroll cue.
 */
function drawnItemRows(harness: Harness): number[] {
  const lines = paneLines(harness);
  const title = lines.findIndex((line) => line.trim() === "Review settings");
  const cue = lines.findIndex((line, index) => index > title && /^\s*\(\d+\/\d+\)\s*$/.test(line));
  assert.ok(title >= 0 && cue > title + 1, `the written frame draws a bounded list:\n${written(harness).join("\n")}`);
  return Array.from({ length: cue - title - 1 }, (_unused, index) => title + 1 + index);
}

/** Keyboard-navigate the written roster into the shared Review settings root list. */
async function openReviewRoot(harness: Harness): Promise<void> {
  await ready(harness);
  await nextTurn();
  // The roster marks its highlighted host row with "> " at column 0; the
  // Settings menu and the shared Review settings menus mark theirs the same way
  // inside the form pane, so the pane rows are matched anywhere in the line.
  for (let step = 0; step < 40; step += 1) {
    if (written(harness).some((line) => line.startsWith("> Settings"))) break;
    harness.terminal.emitInput(DOWN);
    await nextTurn();
  }
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  for (let step = 0; step < 40; step += 1) {
    if (written(harness).some((line) => line.includes("> Review settings"))) break;
    harness.terminal.emitInput(DOWN);
    await nextTurn();
  }
  harness.terminal.emitInput(ENTER);
  await settle(harness, (text) => text.includes("→ Operating mode"), "the shared root menu");
  assert.equal(harness.sidebar?.focus, "form", "the Review settings pane owns the form slot");
}

/** Wait in bounded wall-clock steps: the shared persistence settles on the loop. */
async function settle(harness: Harness, predicate: (text: string) => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate(written(harness).join("\n"))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}:\n${written(harness).join("\n")}`);
}

/** Guarantees the host shuts down even when a case fails, so a failure never hangs. */
async function ensureShutdown(harness: Harness, closed: boolean): Promise<void> {
  if (!closed) harness.signals.emit("SIGTERM");
}

test("a Review settings press highlights the drawn row, and its stationary release activates it exactly once", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    assert.equal(highlighted(harness), "→ Operating mode      Prefer execution");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"],
      "the visible host pane already asks for press reports");

    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);
    const modesBeforePress = harness.terminal.writes.length;

    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(highlighted(harness), `→ ${label}    0 models · 0 slots`,
      "the press highlighted exactly the drawn row under the pointer");
    assert.ok(atRootList(harness), "a press activates nothing");
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the host holds this press");
    assert.deepEqual(enabledTrackingModes(harness), ["1002"],
      "the held row press raises the outer capture to drag reporting, for this gesture only");
    assert.deepEqual(harness.terminal.writes.slice(modesBeforePress).filter((value) => /^\x1b\[\?100\d[hl]$/.test(value)),
      ["\x1b[?1000l", "\x1b[?1002h"], "the capture change is exactly the temporary drag claim");

    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(!atRootList(harness), "the stationary release completed the native click");
    assert.ok(written(harness).some((line) => line.includes("Add worker resource")),
      `the click opened the row it highlighted:\n${written(harness).join("\n")}`);
    assert.equal(harness.sidebar?.reviewPointerActive, false, "the press ended with its release");
    assert.equal(harness.sidebar?.focus, "form", "the pane still owns the form slot");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"],
      "the release returns to the ordinary press capture");

    // Nothing else activates: a release with no press of its own is inert.
    const opened = written(harness).join("\n");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.equal(written(harness).join("\n"), opened, "a release without a press changes nothing");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a drag away and back never activates, and the next stationary click still does", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    pressRow(harness, column, row);
    await nextTurn();
    assert.ok(highlighted(harness).startsWith(`→ ${label}`));
    assert.ok(atRootList(harness));

    // The pointer leaves the row and returns to the very same cell. Every motion
    // packet is host-owned: none of it reaches a child, and the press's own
    // highlight is the only visible change.
    motionRow(harness, column, row - 3);
    await nextTurn();
    motionRow(harness, column + 4, row - 1);
    await nextTurn();
    motionRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the gesture is still the host's");
    assert.ok(highlighted(harness).startsWith(`→ ${label}`), "motion moves no highlight");
    assert.ok(atRootList(harness), "motion activates nothing");

    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(atRootList(harness), "a pointer that wandered away cannot activate the row it left");
    assert.equal(harness.sidebar?.reviewPointerActive, false, "the retired press is gone, not held");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"],
      "the abandoned press leaves no drag capture behind");

    // The button is not fenced past its release: the next ordinary click acts.
    pressRow(harness, column, row);
    await nextTurn();
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(!atRootList(harness), "the next stationary click activates");
    assert.ok(written(harness).some((line) => line.includes("Add worker resource")));
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a release on another row activates nothing, and keyboard input while held retires the press", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    // A release elsewhere never completes the click.
    pressRow(harness, column, row);
    await nextTurn();
    assert.ok(highlighted(harness).startsWith(`→ ${label}`));
    releaseRow(harness, column, row + 2);
    await nextTurn();
    assert.ok(atRootList(harness), "a release on a different row activates nothing");
    assert.equal(harness.sidebar?.reviewPointerActive, false);
    assert.deepEqual(enabledTrackingModes(harness), ["1000"]);

    // Unrelated keyboard input retires the held press even though the pointer
    // never moved: the release that follows cannot activate it.
    pressRow(harness, column, row);
    await nextTurn();
    assert.ok(highlighted(harness).startsWith(`→ ${label}`));
    harness.terminal.emitInput(UP);
    await nextTurn();
    assert.ok(atRootList(harness), "the keystroke moved the highlight, it did not open a row");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(atRootList(harness), "a release after unrelated input cannot activate the pressed row");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"]);
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("one wheel report steps one clamped row over the drawn rows and activates nothing", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const column = drawnColumn(harness, "Operating mode");
    const row = drawnRow(harness, "Operating mode");
    assert.equal(highlighted(harness), "→ Operating mode      Prefer execution");

    // Each report is exactly one row down, then one row up.
    for (const expected of ["→ Mode cycle hotkey   alt+m", "→ Worker resources    0 models · 0 slots"]) {
      wheelRow(harness, column, row, WHEEL_DOWN);
      await nextTurn();
      assert.equal(highlighted(harness), expected, "one report is one row");
    }
    wheelRow(harness, column, row, WHEEL_UP);
    await nextTurn();
    assert.equal(highlighted(harness), "→ Mode cycle hotkey   alt+m");

    // Clamped at the first row.
    for (let step = 0; step < 6; step += 1) {
      wheelRow(harness, column, row, WHEEL_UP);
      await nextTurn();
    }
    assert.equal(highlighted(harness), "→ Operating mode      Prefer execution");

    // Clamped at the last row of the whole list, not merely the last drawn one.
    for (let step = 0; step < 30; step += 1) {
      wheelRow(harness, column, row, WHEEL_DOWN);
      await nextTurn();
    }
    assert.ok(highlighted(harness).startsWith("→ Cancel"), highlighted(harness));
    assert.ok(atRootList(harness), "a wheel activates nothing");

    // A report over the hint line (below the drawn rows) is the existing
    // consumed no-op: the highlight stays exactly where the list left it.
    const hintRow = drawnRow(harness, "↑↓ navigate");
    const before = highlighted(harness);
    wheelRow(harness, column, hintRow, WHEEL_DOWN);
    await nextTurn();
    assert.equal(highlighted(harness), before, "a report off the rows moves nothing");
    assert.ok(atRootList(harness));
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a press against a frame the writer never wrote cannot activate", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    // The keystroke is composed into a new frame the writer holds back: the
    // frame the operator was shown still highlights the old row, and a press
    // mapped from it authorizes nothing.
    harness.writer.holdWrites = true;
    harness.terminal.emitInput(DOWN);
    await nextTurn();
    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, false, "an unwritten frame holds no row authority");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(atRootList(harness), "no part of an unwritten frame activates a row");

    // Once the new frame is actually written, the same gesture works again.
    harness.writer.drainHeldWrites();
    await nextTurn();
    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the written frame authorizes the press");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(!atRootList(harness), "the click acts against the frame that was written");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("the narrow overlay routes the same press, release, and wheel reports", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    // Narrow enough that the form replaces the roster instead of sitting beside it.
    harness.terminal.setSize(50, 24);
    await settle(harness, (text) => !text.includes("Sessions ("), "the narrow overlay");
    assert.equal(paneColumn(harness), 0, "the overlay drew the Review settings pane at column 0");

    const label = "Timeouts";
    // Clamp at the first row so the overlay's own window is where the test says
    // it is, then take exactly one report: one row, in the overlay too.
    for (let step = 0; step < 20; step += 1) {
      wheelRow(harness, drawnColumn(harness, "Operating mode"), drawnRow(harness, "Operating mode"), WHEEL_UP);
      await nextTurn();
    }
    assert.equal(highlighted(harness), "→ Operating mode      Prefer execution");
    wheelRow(harness, drawnColumn(harness, "Operating mode"), drawnRow(harness, "Operating mode"), WHEEL_DOWN);
    await nextTurn();
    assert.equal(highlighted(harness), "→ Mode cycle hotkey   alt+m", "one report is one row in the overlay");

    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);
    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the overlay press is held like the wide one");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(!atRootList(harness), "the overlay release completes the same native click");
    assert.equal(harness.sidebar?.focus, "form");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a pointer cannot answer a confirmation whose disclosure is not shown whole", async (t) => {
  const { harness, configPath } = reviewHarness(t);
  const bytesA = readFileSync(configPath, "utf8");
  let closed = false;
  try {
    await openReviewRoot(harness);
    // A tall enough pane that the whole disclosure and its choices can be drawn.
    harness.terminal.setSize(80, 34);
    await settle(harness, (text) => !text.includes("too small"), "the taller pane");
    await keyboardTo(harness, "Tools");
    harness.terminal.emitInput(ENTER);
    await settle(harness, (text) => text.includes("Tool protection"), "the Tools submenu");
    await keyboardTo(harness, "Tool protection");
    harness.terminal.emitInput(ENTER);
    await settle(harness, (text) => text.includes("Save auditor sessions"), "Tool protection");
    await keyboardTo(harness, "Save auditor sessions");
    harness.terminal.emitInput(ENTER);
    await settle(harness, (text) => text.includes("Save every auditor session?") && text.includes("→ No"),
      "the retention confirmation with its whole disclosure");

    // A pane too short for the disclosure with its choices draws no choice and
    // writes nothing that could authorize an answer: the pointer gets nothing to
    // press, and no part of a press answers the confirmation.
    harness.terminal.setSize(80, 14);
    await settle(harness, (text) => /enlarge the pane/.test(text), "the clipped confirmation");
    assert.equal(harness.sidebar?.captureReviewSettingsPresentation(), undefined,
      "no frame is written that could authorize Yes");
    const clipped = written(harness).join("\n");
    pressRow(harness, 40, 6);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, false, "a clipped confirmation holds no row press");
    releaseRow(harness, 40, 6);
    await nextTurn();
    assert.equal(written(harness).join("\n"), clipped, "the clipped confirmation answers nothing");

    // Restored to a pane that shows the whole disclosure with its choices, the
    // same gesture answers exactly the row it lands on: Yes highlights on the
    // press and confirms once on the stationary release.
    harness.terminal.setSize(80, 34);
    await settle(harness, (text) => text.includes("→ No") && !/enlarge the pane/.test(text),
      "the confirmation with its whole disclosure again");
    const yesRow = drawnChoiceRow(harness, "Yes");
    pressRow(harness, 40, yesRow);
    await nextTurn();
    assert.ok(highlighted(harness).startsWith("→ Yes"), highlighted(harness));
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the press is held");
    releaseRow(harness, 40, yesRow);
    await nextTurn();
    assert.ok(written(harness).some((line) => /→ Save auditor sessions\s+On/.test(line)),
      `the release answered the confirmation once:\n${written(harness).join("\n")}`);

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
    assert.equal(readFileSync(configPath, "utf8"), bytesA, "a staged confirmation never saves itself");
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("keyboard navigation, Escape, and Save keep working after pointer use", async (t) => {
  const { harness, configPath } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    pressRow(harness, drawnColumn(harness, label), drawnRow(harness, label));
    await nextTurn();
    releaseRow(harness, drawnColumn(harness, label), drawnRow(harness, label));
    await nextTurn();
    assert.ok(!atRootList(harness), "the pointer opened the row");

    // Escape (keyboard) still backs out of the row the pointer opened.
    harness.terminal.emitInput(ESCAPE);
    await nextTurn();
    assert.ok(atRootList(harness), "Escape still returns to the root list");

    // Keyboard selection and Enter still act on the rows the pane drew.
    for (let step = 0; step < 40; step += 1) {
      if (highlighted(harness).startsWith("→ Timeouts")) break;
      harness.terminal.emitInput(DOWN);
      await nextTurn();
    }
    assert.ok(highlighted(harness).startsWith("→ Timeouts"), highlighted(harness));
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.ok(!atRootList(harness), "Enter still opens the highlighted row");
    harness.terminal.emitInput(ESCAPE);
    await nextTurn();
    assert.ok(atRootList(harness));

    // The shared Save transaction still runs end to end after any pointer use.
    for (let step = 0; step < 40; step += 1) {
      if (highlighted(harness).startsWith("→ Save changes")) break;
      harness.terminal.emitInput(DOWN);
      await nextTurn();
    }
    assert.ok(highlighted(harness).startsWith("→ Save changes"), highlighted(harness));
    harness.terminal.emitInput(CTRL_S);
    await settle(harness, (text) => /Review settings saved/.test(text), "the save notice");
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as { operatingMode?: string };
    assert.equal(saved.operatingMode, "execute", "the unchanged draft saved exactly what it loaded");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a press and its release delivered in one input turn still open the pressed row exactly once", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    // Both reports arrive inside one stdin read: the highlight's own repaint has
    // not been composed yet, and the receipt still standing is the frame the
    // press was authorized against. That is the press's own redraw, not an
    // unrelated change, so the stationary release still completes.
    pressRow(harness, column, row);
    releaseRow(harness, column, row);
    await settle(harness, () => !atRootList(harness), "the row the press highlighted");
    assert.ok(written(harness).some((line) => line.includes("Add worker resource")),
      `the same-turn release opened the pressed row:\n${written(harness).join("\n")}`);
    assert.equal(harness.sidebar?.reviewPointerActive, false, "the gesture ended with its release");

    // It answered exactly once: the submenu is on screen and a stray release of
    // the same button changes nothing further.
    const opened = written(harness).join("\n");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.equal(written(harness).join("\n"), opened, "the same-turn click answered exactly once");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a burst of wheel reports in one input turn steps every notch", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const column = drawnColumn(harness, "Operating mode");
    const row = drawnRow(harness, "Operating mode");

    // Three down reports with no turn between them: a real terminal delivers a
    // burst inside one read, before the intermediate repaints.
    wheelRow(harness, column, row, WHEEL_DOWN);
    wheelRow(harness, column, row, WHEEL_DOWN);
    wheelRow(harness, column, row, WHEEL_DOWN);
    await settle(harness, (text) => text.includes("→ External workers"), "all three notches");
    assert.equal(highlighted(harness), "→ External workers    0 defined");
    assert.ok(atRootList(harness), "a wheel activates nothing");

    // A clamped burst followed immediately by a down report in the same turn:
    // the clamped reports change nothing and are never counted, and the down
    // report still steps exactly one row from where the clamps left the list.
    for (let step = 0; step < 6; step += 1) wheelRow(harness, column, row, WHEEL_UP);
    wheelRow(harness, column, row, WHEEL_DOWN);
    await settle(harness, (text) => text.includes("→ Mode cycle hotkey"), "the down report after the clamps");
    assert.equal(highlighted(harness), "→ Mode cycle hotkey   alt+m");
    assert.ok(atRootList(harness));
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("unrelated pointer input retires a held press so its later release cannot activate", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    // A right-button click inside the pane keeps its own (inert) route, and it
    // retires the held left press: the left release that follows cannot activate.
    pressRow(harness, column, row);
    await nextTurn();
    assert.ok(highlighted(harness).startsWith(`→ ${label}`));
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the left press is held");
    rightClick(harness, column + 3, row + 1);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, false, "the unrelated click retired the press");
    assert.ok(atRootList(harness), "the right click activated nothing");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(atRootList(harness), "the retired press's release activates nothing");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"], "no drag capture is left behind");

    // The same for a horizontal wheel report, which is not a scroll notch at all.
    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true);
    horizontalWheel(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, false, "the horizontal wheel retired the press");
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(atRootList(harness), "its release activates nothing either");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a press whose highlight recenters the bounded list still activates the row it landed on", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    // A pane short enough that the notice-sizing measurement and the final fit
    // bound the SAME list twice: the press's own highlight then moves the drawn
    // window, so the released cell no longer holds the pressed row.
    harness.terminal.setSize(80, 20);
    await settle(harness, (text) => /\(\d+\/\d+\)/.test(text), "the bounded list");
    const rows = drawnItemRows(harness);
    assert.ok(rows.length >= 3, `the bounded pane must draw at least three rows:\n${written(harness).join("\n")}`);
    const row = rows[rows.length - 1]!;
    const label = (line: string): string => line.trim().replace(/^→\s*/, "").split(/\s{2,}/)[0]!;
    const pressed = label(paneLines(harness)[row] ?? "");
    assert.ok(pressed.length > 0, written(harness).join("\n"));

    pressRow(harness, 40, row);
    await nextTurn();
    const movedTo = paneLines(harness).findIndex((line) => line.includes("\u2192 "));
    assert.ok(movedTo >= 0 && label(paneLines(harness)[movedTo] ?? "") === pressed,
      `the press highlights the row under it:\n${written(harness).join("\n")}`);
    // The window moved: the released cell now holds a DIFFERENT row, so only the
    // identity the press established can answer correctly.
    assert.notEqual(movedTo, row, `the press's highlight recentered the drawn window:\n${written(harness).join("\n")}`);
    const nowAtRow = label(paneLines(harness)[row] ?? "");
    assert.notEqual(nowAtRow, pressed, "a different row occupies the pressed cell");

    releaseRow(harness, 40, row);
    await settle(harness, () => !atRootList(harness), "the pressed row's own screen");
    assert.ok(paneLines(harness).some((line) => {
      const title = line.trim();
      return title === pressed || title.startsWith(`${pressed} `);
    }),
      `the release activated the row the press highlighted (${pressed}), not the row now drawn in its cell (${nowAtRow}):\n${written(harness).join("\n")}`);
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

/**
 * The newest frame the writer RECEIVED. While `holdWrites` is on this is a
 * composed candidate the operator has NOT been shown: the frame on screen stays
 * the last one the writer reported written, which is exactly what the next
 * report has to be authorized against.
 */
function received(harness: Harness): string[] {
  return written(harness);
}

/** Wait until the blocked writer has received another composed candidate. */
async function receivedMore(harness: Harness, count: number, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (harness.writer.frames.length > count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}; the writer received ${harness.writer.frames.length} frames`);
}

test("a notch composed but not yet written still admits the next notch of the same burst", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const column = drawnColumn(harness, "Operating mode");
    const row = drawnRow(harness, "Operating mode");
    const onScreen = written(harness).join("\n");

    // The writer is blocked, as it is under real backpressure: each notch
    // composes a new candidate, and none of them reaches the screen. The frame
    // the operator is looking at is still the one the burst started from, so the
    // following notches must be admitted rather than dropped.
    harness.writer.holdWrites = true;
    const receivedBefore = harness.writer.frames.length;
    wheelRow(harness, column, row, WHEEL_DOWN);
    await receivedMore(harness, receivedBefore, "the first notch's unwritten composition");
    assert.ok(harness.writer.heldSubmits >= 1, "the writer is holding the burst's first frame");
    assert.equal(received(harness).join("\n").includes("→ Mode cycle hotkey"), true,
      "the first notch composed");

    // The baseline is taken BEFORE each report: the composition a notch causes
    // arrives in a queued microtask, so a baseline read afterwards would already
    // be satisfied by the frame the previous notch composed.
    const beforeSecond = harness.writer.frames.length;
    wheelRow(harness, column, row, WHEEL_DOWN);
    await receivedMore(harness, beforeSecond, "the second notch");
    assert.equal(received(harness).join("\n").includes("→ Worker resources"), true,
      "the second notch was admitted, not dropped");

    const beforeThird = harness.writer.frames.length;
    wheelRow(harness, column, row, WHEEL_DOWN);
    await receivedMore(harness, beforeThird, "the third notch");
    assert.equal(received(harness).join("\n").includes("→ External workers"), true,
      "the third notch was admitted, not dropped");

    // Drain the blocked sink: what the operator is finally shown is the whole
    // burst, and every notch in it moved the highlight exactly one row.
    harness.writer.drainHeldWrites();
    await settle(harness, () => !harness.writer.holdWrites, "the writer to drain");
    await settle(harness, (text) => text.includes("→ External workers"), "the drained frame");
    assert.equal(highlighted(harness), "→ External workers    0 defined");
    assert.ok(atRootList(harness), "a wheel activates nothing");
    // The pane the operator kept looking at never changed underneath them, so
    // the burst was rooted in a frame they actually saw.
    assert.notEqual(written(harness).join("\n"), onScreen, "the burst's frames are on screen now");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a key between wheel reports revokes the frame the burst was rooted in", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const column = drawnColumn(harness, "Operating mode");
    const row = drawnRow(harness, "Operating mode");

    // One notch, composed but unwritten: the burst is now rooted in the frame
    // still on screen.
    harness.writer.holdWrites = true;
    const receivedBefore = harness.writer.frames.length;
    wheelRow(harness, column, row, WHEEL_DOWN);
    await receivedMore(harness, receivedBefore, "the first notch's unwritten composition");
    assert.equal(received(harness).join("\n").includes("→ Mode cycle hotkey"), true);

    // An unrelated key: it moves nothing visible, but the screen's own view
    // changed, so the frame the burst started from no longer describes it.
    const heldBefore = harness.writer.frames.length;
    harness.terminal.emitInput(RIGHT);
    await receivedMore(harness, heldBefore, "the key's own composition");
    assert.equal(received(harness).join("\n").includes("→ Mode cycle hotkey"), true,
      "the key itself moved no highlight");

    // The next notch is refused: it would have to be authorized by a frame the
    // operator was shown before something else happened.
    const refusedAt = harness.writer.frames.length;
    wheelRow(harness, column, row, WHEEL_DOWN);
    await nextTurn();
    await nextTurn();
    assert.equal(harness.writer.frames.length, refusedAt,
      "the refused report composes nothing: the old frame no longer authorizes it");

    harness.writer.drainHeldWrites();
    await settle(harness, () => !harness.writer.holdWrites, "the writer to drain");
    await settle(harness, (text) => text.includes("→ Mode cycle hotkey"), "the drained frame");
    assert.equal(highlighted(harness), "→ Mode cycle hotkey   alt+m",
      "only the admitted notch moved the highlight");
    assert.ok(atRootList(harness));
    // A fresh written receipt authorizes the wheel again.
    wheelRow(harness, column, row, WHEEL_DOWN);
    await settle(harness, (text) => text.includes("→ Worker resources"), "the wheel after a fresh frame");
    assert.equal(highlighted(harness), "→ Worker resources    0 models · 0 slots");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a fenced held-key release retires a held press while no frame can be written", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    // Opening a submenu with the keyboard is a PERFORMED action: the fresh Enter
    // claims the cross-focus held-action fence, so its held repeat or release can
    // never replay into the re-shown menu, the roster, or the child.
    await keyboardTo(harness, "Worker resources");
    harness.terminal.emitInput(ENTER);
    await settle(harness, (text) => text.includes("Add worker resource"), "the submenu");
    const submenu = written(harness).join("\n");
    const label = "Add worker resource";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    // From here nothing this pane composes can reach the screen, exactly as
    // under real backpressure: the operator keeps looking at the submenu.
    harness.writer.holdWrites = true;
    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the row press is held");
    assert.deepEqual(enabledTrackingModes(harness), ["1002"],
      "the held press raises this host's temporary drag claim");

    // The prior Enter's release, as the terminal reports it. The fence consumes
    // it before this pane ever sees it — and it is still unrelated input.
    harness.terminal.emitInput("\x1b[13;1:3u");
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, false,
      "the fenced release retired the press, with no frame delivered");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"],
      "the temporary drag claim came back down without waiting for a written frame");

    releaseRow(harness, column, row);
    await nextTurn();
    assert.deepEqual(enabledTrackingModes(harness), ["1000"]);
    harness.writer.drainHeldWrites();
    await settle(harness, () => !harness.writer.holdWrites, "the writer to drain");
    assert.equal(written(harness).join("\n"), submenu,
      "the retired press's release opened nothing at all");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a legacy press and its anonymous legacy release complete the drawn row", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    // The positive control for the legacy path: this terminal reported only the
    // pressed button down, so its anonymous release can only belong to that press.
    legacyPress(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the legacy press is held");
    assert.ok(highlighted(harness).startsWith(`→ ${label}`),
      "the legacy press highlighted exactly the drawn row under it");
    assert.ok(atRootList(harness), "a press activates nothing");

    legacyRelease(harness, column, row);
    await settle(harness, () => !atRootList(harness), "the row the legacy release completed");
    assert.ok(written(harness).some((line) => line.includes("Add worker resource")),
      `the anonymous legacy release completed the pressed row:\n${written(harness).join("\n")}`);
    assert.equal(harness.sidebar?.reviewPointerActive, false, "the gesture ended with its release");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("an anonymous legacy release with another button down retires the press", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const label = "Worker resources";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);

    // A second button goes down first and stays down.
    emitMouse(harness.terminal, column + 4, row + 1, 2);
    await nextTurn();
    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true,
      "the left press is held while the right button is still down");
    assert.ok(highlighted(harness).startsWith(`→ ${label}`));

    // A legacy release names no button. With two buttons reported down it cannot
    // be shown to be the left button's, so it retires the gesture instead of
    // completing the click the left press alone would have earned.
    legacyRelease(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, false,
      "the ambiguous release retired the press instead of completing it");
    assert.ok(atRootList(harness), "the ambiguous legacy release activated nothing");

    // The real left release cannot complete it either: the button stays fenced.
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(atRootList(harness), "the retired press's own release activates nothing");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"], "no drag capture is left behind");

    emitMouse(harness.terminal, column + 4, row + 1, 2, "m");
    await nextTurn();
    assert.ok(atRootList(harness), "releasing the other button activates nothing either");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a replacement press of the held button ends the gesture the first press began", async (t) => {
  const { harness } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    const first = "Worker resources";
    const second = "External workers";
    const column = drawnColumn(harness, first);
    const rowA = drawnRow(harness, first);
    const rowB = drawnRow(harness, second);
    assert.notEqual(rowA, rowB);

    // The writer is blocked: the first press's highlight is composed but never
    // shown, so the replacement press cannot be authorized against a newer frame
    // either. It still ENDS the first gesture: a press Main is holding cannot be
    // the press this packet began, so no later release may complete it.
    harness.writer.holdWrites = true;
    pressRow(harness, column, rowA);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the first press is held");

    pressRow(harness, column, rowB);
    await nextTurn();

    releaseRow(harness, column, rowA);
    await nextTurn();
    assert.ok(atRootList(harness),
      "a release at the first press's cell completes nothing after the replacement press");

    harness.writer.drainHeldWrites();
    await settle(harness, () => !harness.writer.holdWrites, "the writer to drain");
    assert.ok(atRootList(harness), "nothing opened once the blocked frames landed");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a peer alert band that moves the pane retires the held press, and the cell still works after", async (t) => {
  const { harness, peer } = reviewHarness(t);
  let closed = false;
  try {
    await openReviewRoot(harness);
    // Narrow overlay: the form replaces the roster, so the band an incoming peer
    // request reserves sits above the pane this press was authorized against.
    harness.terminal.setSize(50, 24);
    await settle(harness, (text) => !text.includes("Sessions ("), "the narrow overlay");
    assert.equal(paneColumn(harness), 0, "the overlay drew the Review settings pane at column 0");
    const label = "Timeouts";
    const row = drawnRow(harness, label);
    const column = drawnColumn(harness, label);
    const titleBefore = paneTitleRow(harness);

    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "the press is held");
    assert.deepEqual(enabledTrackingModes(harness), ["1002"], "the held press raised the temporary drag claim");

    // The request adds the six-row alert band. No terminal resize, no focus
    // change, no new screen, and no new view revision — only the rectangle the
    // press was drawn in moved, so the transition itself has to retire it.
    peer.incoming(syntheticConsent("band-A"));
    await settle(harness, (text) => text.includes("! Incoming connection request"), "the alert band");
    assert.equal(harness.sidebar?.focus, "form", "the alert band takes no focus");
    assert.notEqual(paneTitleRow(harness), titleBefore, "the band moved the pane the press was drawn in");
    assert.equal(harness.sidebar?.reviewPointerActive, false, "the reflow retired the press");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"],
      "the temporary drag claim stopped as soon as the band moved the pane");

    // The band clears, and the pane returns to the very rectangle it had.
    peer.decideConsent("band-A", "deny");
    await settle(harness, (text) => !text.includes("! Incoming connection request"), "the band to clear");
    assert.equal(paneTitleRow(harness), titleBefore, "the pane is back where the press was authorized");

    // The release of the retired press completes nothing, even though every
    // coordinate, screen, and revision now matches the original press again.
    releaseRow(harness, column, row);
    await nextTurn();
    assert.ok(atRootList(harness), "the release after the round trip activates nothing");
    assert.deepEqual(enabledTrackingModes(harness), ["1000"], "no drag capture is left behind");

    // The same cell still answers a fresh click.
    pressRow(harness, column, row);
    await nextTurn();
    assert.equal(harness.sidebar?.reviewPointerActive, true, "a fresh press is accepted again");
    releaseRow(harness, column, row);
    await settle(harness, () => !atRootList(harness), "the fresh click at the same cell");
    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});
