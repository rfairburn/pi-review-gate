/** Real public Main -> framed native Pi -> Ctrl+G -> non-Node Vim acceptance.
 * macOS PTY evidence only: the shared Main harness requires kernel exit watchers.
 * Linux/SSH and remote-viewer evidence belongs to the separate bridge tiers.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { visibleWidth } from "pi-session-host-tui";

import {
  KEYS, MainPtyDriver, OUTER_COLS, OUTER_ROWS, TEST_TIMEOUT_MS,
  compileAndStageCandidate, createEditorLog, createOwnedScratchRoot, makeNativeAgentRoot,
  makeRuntimeEnvironment, makeWorkspace, removeOwnedScratchTree, resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";
import { NATIVE_PANE_START } from "./helpers/session-host-native-roster-witness";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The composed native pane of this test's wide, sidebar-visible Main frame. */
interface Pane {
  readonly column: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}
const nativePane: Pane = {
  column: NATIVE_PANE_START,
  row: 1,
  cols: OUTER_COLS - NATIVE_PANE_START,
  rows: OUTER_ROWS - 1,
};

/**
 * Where a drawn text run ENDS in outer-terminal frame cells.
 *
 * The frame serializes a wide cell as one character and skips its zero-width
 * continuation, so a string index is not a frame column. Both offsets are
 * therefore measured with `visibleWidth`, and the expectation comes from the
 * frame that actually shows the text rather than from an assumed layout.
 */
function drawnTextEnd(lines: readonly string[], text: string): { column: number; row: number } | undefined {
  for (let row = 0; row < lines.length; row += 1) {
    const index = lines[row]!.indexOf(text);
    if (index < 0) continue;
    return { column: visibleWidth(lines[row]!.slice(0, index)) + visibleWidth(text), row };
  }
  return undefined;
}

/** Where a drawn text run STARTS, in the same frame cells. */
function drawnTextStart(lines: readonly string[], text: string): { column: number; row: number } | undefined {
  for (let row = 0; row < lines.length; row += 1) {
    const index = lines[row]!.indexOf(text);
    if (index < 0) continue;
    return { column: visibleWidth(lines[row]!.slice(0, index)), row };
  }
  return undefined;
}

test("production Main Ctrl+G edits through real Vim and restores the native draft after save, cancel and failure", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return;
  if (!existsSync("/usr/bin/vim")) {
    if (process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1") throw new Error("real Vim is required for external-editor acceptance");
    t.skip("real Vim is unavailable");
    return;
  }
  const scratch = createOwnedScratchRoot();
  let driver: MainPtyDriver | undefined;
  let assertionsCompleted = false;
  t.after(async () => {
    let cleanup: Awaited<ReturnType<MainPtyDriver["boundedCleanup"]>> | undefined;
    if (driver) {
      try { cleanup = await driver.boundedCleanup(); }
      catch { cleanup = await driver.forceCleanupAndObserve(); }
      finally { driver.dispose(); }
    }
    if (assertionsCompleted && cleanup?.childrenExited && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit && !cleanup.forced) {
      if (!removeOwnedScratchTree(scratch)) process.stderr.write("preserved owned external-editor fixture: ownership receipts unavailable\n");
    } else {
      process.stderr.write(`preserved owned external-editor fixture ${scratch}: assertionsCompleted=${assertionsCompleted}; childrenExited=${cleanup?.childrenExited}; gracefulHostExit=${cleanup?.gracefulHostExit}; forced=${cleanup?.forced}\n`);
    }
    if (assertionsCompleted) {
      assert.ok(cleanup?.childrenExited && cleanup.shutdownEventsObserved
        && cleanup.gracefulHostExit && !cleanup.forced, "all owned native processes settled and Main restored the outer terminal");
    }
  });

  const workspace = makeWorkspace(scratch, "editor-workspace");
  const nativeAgentDir = makeNativeAgentRoot(scratch);
  const editorLog = createEditorLog(scratch);
  const observerFile = join(scratch, "observer", "editor-native.jsonl");
  const modeFile = join(scratch, "editor-mode");
  const editor = join(scratch, "owned-vim");
  // Neither the wrapper nor Vim is Node: no inherited Node decoder can mask fd-0
  // leakage. Pi still chooses and launches its configured editor normally.
  writeFileSync(editor, `#!/bin/sh
mode=$(/bin/cat ${quote(modeFile)})
/bin/cp "$1" ${quote(join(scratch, "before-"))}"$mode"
if [ "$mode" = failure ]; then exit 17; fi
/usr/bin/vim -u NONE -i NONE -n -N -X -c 'set encoding=utf-8 nobackup nowritebackup noswapfile laststatus=2 statusline=PRG499-VIM' "$1"
status=$?
/bin/cp "$1" ${quote(join(scratch, "after-"))}"$mode"
printf '%s\\n' "$status" > ${quote(join(scratch, "exit-"))}"$mode"
exit "$status"
`, { mode: 0o700, flag: "wx" });
  writeFileSync(modeFile, "save", { mode: 0o600, flag: "wx" });
  const candidate = compileAndStageCandidate(scratch);
  const env = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  driver = await MainPtyDriver.start({
    ptyModule: runtime.pty, scratchRoot: scratch, candidate, runtime, observerFile,
    editor, editorLog, editorValue: "", env,
    // No injected framing switch: exercise production Main's default-on bridge.
  });
  const active = driver;

  /* ------------------------------------------------------------------ *
   * Native cursor observation seam.
   *
   * `MainPtyDriver.surface` is a real terminal emulator fed with the bytes
   * production Main actually writes to the owned outer PTY, and its frame's
   * `cursor` is the same `TerminalFrame.cursor` the product compositor owns.
   * This test reads that one authority; it never keeps a second cursor, never
   * asks the host to force one visible, and never accepts a rendered glyph as
   * a cursor substitute.
   * ------------------------------------------------------------------ */
  const observedCursor = () => active.surface.frame().cursor;
  const cursorState = (cursor: ReturnType<typeof observedCursor>) =>
    ({ column: cursor.column, row: cursor.row, visible: cursor.visible });
  const frameLines = () => active.currentText().split("\n");
  const cursorInside = (pane: Pane, cursor: ReturnType<typeof observedCursor>): boolean =>
    cursor.column >= pane.column && cursor.column < pane.column + pane.cols
    && cursor.row >= pane.row && cursor.row < pane.row + pane.rows;

  /**
   * The child's own full-screen TUI hides the hardware cursor while it owns the
   * terminal, so composition must not fabricate, force, or leave behind a
   * cursor of its own. Only visibility is asserted at this seam: the writer
   * emits a cursor-hide with NO coordinates, which leaves the outer hardware
   * cursor at its resting position, and the emulator keeps those coordinates
   * while hidden. Asserting them would test the writer's resting position, not
   * the product's cursor authority. Exact positions are asserted only for the
   * visible editor cursors below.
   */
  // Editor exit can expose an old draft while Pi is still restarting its TUI.
  // Wait for Pi's own cursor-hide before sending the next ordinary input.
  const waitForPiReturn = (draft: string, what: string): Promise<void> =>
    active.waitFrame((text) => text.includes(draft) && !observedCursor().visible, what);

  const assertHostHidesNoSubstituteCursor = (what: string): void => {
    assert.equal(observedCursor().visible, false,
      `${what}: the host leaves a visible cursor the child never showed\nActual owned Main frame:\n${active.currentText()}`);
  };

  /** An editor-owned state: the visible native cursor sits at the drawn text's end. */
  const assertCursorAtDrawnTextEnd = (draft: string, pane: Pane, what: string): void => {
    const end = drawnTextEnd(frameLines(), draft);
    assert.ok(end !== undefined, `${what}: the owned Main frame never draws ${JSON.stringify(draft)}\n${active.currentText()}`);
    const cursor = observedCursor();
    assert.deepEqual(cursorState(cursor), { column: end.column, row: end.row, visible: true },
      `${what}: the outer terminal's native cursor is not at the end of the drawn text\nActual owned Main frame:\n${active.currentText()}`);
    assert.ok(cursorInside(nativePane, cursor), `${what}: the native cursor stays inside the composed native pane`);
  };

  await active.waitFrame((text) => text.includes("Welcome") && text.includes("New session"), "public Main starts empty");
  const session = await active.createNativeSession(workspace);
  assert.equal(session.record.tty, true);

  const original = "PRG499-original-draft";
  const edited = "PRG499-edited-café-雪";
  await active.writeAndWait(original, (text) => text.includes(original), "native Pi receives the original framed draft");
  // Pi's own framed editor hides the hardware cursor; nothing may stand in for it.
  assertHostHidesNoSubstituteCursor("the framed Pi editor owns the terminal before any handoff");
  const piCursorBeforeHandoff = observedCursor();
  await active.writeAndWait("\x07", (text) => text.includes("PRG499-VIM"), "actual Ctrl+G opens configured real Vim");
  assert.equal(readFileSync(join(scratch, "before-save"), "utf8"), original, "Pi's own launcher prefills the exact draft");
  // Cursor ENTRY: the outer terminal's cursor is now Vim's own cursor, still
  // visible, still inside the composed native pane, and on the row where Vim
  // drew the prefilled draft — at Vim's own column-0 edit position rather than
  // where Pi's editor had left it.
  const vimDraftStart = drawnTextStart(frameLines(), original);
  assert.ok(vimDraftStart !== undefined, `Vim never draws the prefilled draft\n${active.currentText()}`);
  const vimEntryCursor = observedCursor();
  assert.deepEqual(cursorState(vimEntryCursor), { column: vimDraftStart.column, row: vimDraftStart.row, visible: true },
    `Ctrl+G hands the native cursor to the configured editor at its own edit position (Pi's was ${JSON.stringify(cursorState(piCursorBeforeHandoff))})\nActual owned Main frame:\n${active.currentText()}`);
  assert.ok(cursorInside(nativePane, vimEntryCursor), "the editor's native cursor stays inside the composed native pane");
  const vimTextRow = vimDraftStart.row;
  await active.writeAndWait("ggdGi", (text) => text.includes("INSERT"), "ordinary Vim commands reach Vim rather than Pi");
  // `gg` inside the editor moves the real cursor: the frame's cursor follows it
  // to the pane's first text row and leftmost column, with no host substitute.
  assert.deepEqual(cursorState(observedCursor()), { column: nativePane.column, row: vimTextRow, visible: true },
    `editor navigation moves the native cursor to the editor's own top-of-text cell\nActual owned Main frame:\n${active.currentText()}`);
  const beforePasteCursor = observedCursor();
  await active.writeAndWait(`\x1b[200~${edited}\x1b[201~`, (text) => text.includes(edited), "Unicode bracketed paste reaches the editor");
  assert.equal(active.currentText().includes("prg-ni-v2;"), false, "no unintended input frames are rendered in Vim");
  // The cursor travelled with the actual edit: same text row, now exactly at the
  // end of the drawn Unicode run (wide cells counted in frame space).
  assert.ok(observedCursor().column > beforePasteCursor.column && observedCursor().row === beforePasteCursor.row,
    `the native cursor advanced with the editor's own insertion\nActual owned Main frame:\n${active.currentText()}`);
  assertCursorAtDrawnTextEnd(edited, nativePane, "the editor's native cursor sits at the end of the pasted run");
  // Separate Escape from the following command: ESC+Z in one terminal packet is
  // also the legacy Alt+Z encoding, not an unambiguous Escape followed by Z.
  await active.writeAndWait("\x1b", (text) => !text.includes("INSERT"), "Escape leaves editor insert mode");
  // In-editor navigation with a content-neutral round trip: Vim's command line
  // moves the real cursor to the bottom of the editor's screen, and cancelling
  // it returns the cursor to the exact cell it occupied before. Nothing here
  // changes a byte of the draft or the assertions around it.
  const normalModeCursor = observedCursor();
  assert.ok(normalModeCursor.visible && cursorInside(nativePane, normalModeCursor) && normalModeCursor.row === vimTextRow,
    `the native cursor stays visible on the editor's text row after leaving insert mode\nActual owned Main frame:\n${active.currentText()}`);
  await active.writeKeys(":", "the editor opens its own command line");
  await active.waitForFrameQuiet("the editor's command line finishes repainting before its cursor is read");
  const commandLineCursor = observedCursor();
  assert.ok(commandLineCursor.visible && commandLineCursor.row > normalModeCursor.row
    && cursorInside(nativePane, commandLineCursor),
    `the native cursor follows the editor's own navigation to its command line\nActual owned Main frame:\n${active.currentText()}`);
  await active.writeKeys("\x1b", "the editor cancels its command line without editing the buffer");
  // Vim repositions its cursor only when it next repaints, so the settled frame
  // is what this comparison reads.
  await active.waitForFrameQuiet("the editor's text screen finishes repainting before its cursor is read");
  assert.deepEqual(cursorState(observedCursor()), cursorState(normalModeCursor),
    `the native cursor returns to the exact edit cell after the editor navigation\nActual owned Main frame:\n${active.currentText()}`);
  await active.writeAndWait("ZZ", (text) => text.includes(edited) && !text.includes("PRG499-VIM"), "save returns the edited draft to Pi");
  assert.equal(readFileSync(join(scratch, "after-save"), "utf8"), `${edited}\n`, "the non-Node editor saved the exact intended bytes");
  assert.equal(readFileSync(join(scratch, "exit-save"), "utf8"), "0\n", "owned editor wrapper observed Vim exit before native return");
  // Cursor RETURN: the editor's own cursor is gone and the composed frame is
  // back to the child's hidden-cursor state, not left at the cell the exiting
  // editor last used. The saved bytes themselves are proved just below.
  await waitForPiReturn(edited, "Pi redraws its native editor and cursor state after save");
  await active.writeAndWait("-after-save", (text) => text.includes(`${edited}-after-save`), "normal Pi typing resumes after save");
  assertHostHidesNoSubstituteCursor("Pi's editor owns the terminal again after the editor save and resumed input");

  writeFileSync(modeFile, "cancel");
  await active.writeAndWait("\x07", (text) => text.includes("PRG499-VIM"), "a second Ctrl+G opens a new editor ownership episode");
  const preserved = `${edited}-after-save`;
  assert.equal(readFileSync(join(scratch, "before-cancel"), "utf8"), preserved);
  await active.writeAndWait("ggdGiDISCARD-499", (text) => text.includes("DISCARD-499"), "cancel control makes a distinct unsaved edit");
  await active.writeAndWait("\x1b", (text) => !text.includes("INSERT"), "Escape leaves insert mode before cancellation");
  await active.writeAndWait("ZQ", (text) => text.includes(preserved) && !text.includes("PRG499-VIM"), "Vim quit-without-save restores the original draft");
  assert.equal(readFileSync(join(scratch, "after-cancel"), "utf8"), preserved, "unsaved changes never overwrite the draft file");
  assert.equal(readFileSync(join(scratch, "exit-cancel"), "utf8"), "0\n");
  await waitForPiReturn(preserved, "Pi redraws its native editor and cursor state after cancellation");
  await active.writeAndWait("-after-cancel", (text) => text.includes(`${preserved}-after-cancel`), "normal Pi input resumes after cancellation");
  assertHostHidesNoSubstituteCursor("Pi's editor owns the terminal again after cancellation and resumed input");

  writeFileSync(modeFile, "failure");
  const beforeFailure = `${preserved}-after-cancel`;
  await active.writeKeys("\x07", "Ctrl+G invokes the configured failing editor");
  await active.waitFrame((text) => text.includes(beforeFailure) && existsSync(join(scratch, "before-failure")), "failed editor restores the unchanged draft");
  assert.equal(readFileSync(join(scratch, "before-failure"), "utf8"), beforeFailure);
  await waitForPiReturn(beforeFailure, "Pi redraws its native editor and cursor state after editor failure");
  await active.writeAndWait("-after-failure", (text) => text.includes(`${beforeFailure}-after-failure`), "normal Pi input resumes after editor failure");
  assertHostHidesNoSubstituteCursor("Pi's editor owns the terminal again after failure and resumed input");
  // A fresh editor prefill observes Pi's actual expanded draft, not merely a
  // matching stale rendered fragment, and proves there was exactly one return.
  writeFileSync(modeFile, "verify");
  await active.writeAndWait("\x07", (text) => text.includes("PRG499-VIM"), "final native prefill observes the returned draft exactly");
  assert.equal(readFileSync(join(scratch, "before-verify"), "utf8"), `${beforeFailure}-after-failure`);
  await active.writeAndWait("ZQ", (text) => text.includes("-after-failure") && !text.includes("PRG499-VIM"), "final owned editor exits without saving");
  assert.equal(readFileSync(join(scratch, "exit-verify"), "utf8"), "0\n");
  await waitForPiReturn(`${beforeFailure}-after-failure`, "Pi redraws its native editor and cursor state after the final exit");
  await active.writeAndWait(KEYS.ctrlC, (text) => !text.includes("-after-failure"), "native clear works after all handoffs");
  assertHostHidesNoSubstituteCursor("Pi's editor owns the terminal again after the final editor exit and native clear");

  /* ------------------------------------------------------------------ *
   * Padded-frame (#474) cursor projection is deliberately NOT asserted here,
   * because this owned local Main fixture cannot reach it.
   *
   * For the row this host displays locally, the manager applies the new pane
   * geometry to the row's own PTY AND surface inside the same reconcileLayout()
   * call that schedules the next composition (InstanceManager.#applyGeometry via
   * updateViewer), so the frame composed for this host's displayed row always
   * matches the pane. A canonical frame smaller than its pane needs another
   * viewer holding a smaller minimum - the remote content lane - which this
   * local fixture never opens. An outer resize here therefore only re-lays out a
   * matching frame: extra blank pane rows and a lagging child resize receipt are
   * not evidence that a smaller TerminalFrame was composed, so no padded-cursor
   * regression claim is made at this seam. Padded projection is pinned where the
   * geometry is actually smaller: the compositor tests.
   * ------------------------------------------------------------------ */
  assert.equal(active.records().filter((record) => record.type === "agent_start" || record.type === "tool_call").length, 0,
    "all editor acceptance runs without a model/provider call or native tool invocation");
  await active.closeNativeNormally(session);
  await active.finishHostNormally();
  assertionsCompleted = true;
});
