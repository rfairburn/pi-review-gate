/**
 * Main pointer routing for sidebar text carets (#714).
 *
 * Main keeps its existing host-owned press route for the form pane: only an
 * initial left press against the ACTUALLY WRITTEN presentation may act, and the
 * matching release/motion stay host-owned. These end-to-end tests drive real
 * Main input parsing with the fake terminal/writer/manager harness and prove
 * that a written press places the native caret (by where the next keystroke
 * lands), an unwritten frame refuses, release/motion alone never act, and no
 * pointer byte reaches the live child.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  ALT_LEFT,
  ENTER,
  closeWithSignal,
  createHarness,
  emitMouse,
  fillForm,
  nextTurn,
  ready,
  type Harness,
} from "./helpers/session-host-main-harness";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CTRL_U = "\x15";
const WORKSPACE = "> Workspace: ";

function plainLines(harness: Harness): string[] {
  return (harness.writer.frames.at(-1)?.frame.lines ?? []).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

/** The written Workspace row and the absolute column of a value cell in it. */
function workspaceCell(harness: Harness, valueColumn: number): { row: number; column: number; value: string } {
  const lines = plainLines(harness);
  const row = lines.findIndex((line) => line.includes(WORKSPACE));
  assert.ok(row >= 0, `the written frame draws the Workspace field:\n${lines.join("\n")}`);
  const line = lines[row] ?? "";
  const start = line.indexOf(WORKSPACE);
  const valueStart = visibleWidth(line.slice(0, start)) + visibleWidth(WORKSPACE);
  return { row, column: valueStart + valueColumn, value: line.slice(start + WORKSPACE.length).trimEnd() };
}

async function openNewForm(harness: Harness): Promise<void> {
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  for (let step = 0; step <= 12; step += 1) {
    const selected = plainLines(harness).find((line) => line.includes("> New session"));
    if (selected !== undefined) {
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      assert.equal(harness.sidebar?.focus, "form");
      return;
    }
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail("the written roster never offered New session");
}

test("a written Workspace press places the native caret; unwritten frames and release/motion never do", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  try {
    fillForm(harness.terminal, "/first/workspace"); // a live child now owns Main
    await nextTurn();
    await openNewForm(harness);
    harness.terminal.emitInput(CTRL_U);
    harness.terminal.emitInput(`${PASTE_START}/srv/example${PASTE_END}`);
    await nextTurn();
    assert.equal(workspaceCell(harness, 0).value, "/srv/example");
    const childWritesBefore = manager.writes.length;

    // Unwritten frame: the typed Z is composed but the writer holds it.
    const stale = workspaceCell(harness, 5);
    harness.writer.holdWrites = true;
    harness.terminal.emitInput("Z");
    await nextTurn();
    emitMouse(harness.terminal, stale.column, stale.row, 0, "M");
    emitMouse(harness.terminal, stale.column, stale.row, 0, "m");
    await nextTurn();
    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput("Y");
    await nextTurn();
    assert.equal(workspaceCell(harness, 0).value, "/srv/exampleZY",
      "a press against a frame Main has not written never moved the caret");

    // Motion and a release alone are host-owned and inert.
    const cell = workspaceCell(harness, 0);
    emitMouse(harness.terminal, cell.column, cell.row, 32, "M"); // left-button motion
    emitMouse(harness.terminal, cell.column, cell.row, 0, "m");
    await nextTurn();
    harness.terminal.emitInput("!");
    await nextTurn();
    assert.equal(workspaceCell(harness, 0).value, "/srv/exampleZY!", "motion/release never place the caret");

    // A non-primary press does not place the caret either.
    const right = workspaceCell(harness, 2);
    emitMouse(harness.terminal, right.column, right.row, 2, "M");
    emitMouse(harness.terminal, right.column, right.row, 2, "m");
    await nextTurn();
    harness.terminal.emitInput("?");
    await nextTurn();
    assert.equal(workspaceCell(harness, 0).value, "/srv/exampleZY!?");

    // The written frame: press after /srv/ then X.
    const written = workspaceCell(harness, 5);
    emitMouse(harness.terminal, written.column, written.row, 0, "M");
    emitMouse(harness.terminal, written.column, written.row, 0, "m");
    await nextTurn();
    harness.terminal.emitInput("X");
    await nextTurn();
    assert.equal(workspaceCell(harness, 0).value, "/srv/XexampleZY!?");
    assert.equal(harness.sidebar?.focus, "form", "the caret press changes no focus");
    assert.equal(manager.writes.length, childWritesBefore, "no pointer byte reached the live child");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});
