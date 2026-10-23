/**
 * Production tests for the pure keyboard sidebar controller (#323 alpha).
 *
 * The keyboard paths are exercised with REAL pinned pi-tui key matching —
 * legacy sequences, xterm modifyOtherKeys, and Kitty CSI-u packets including
 * modifier packets and key releases — never mock key algorithms. Renderer
 * assertions pin row SGR hygiene (only the generated allowlist, explicit
 * resets, no untrusted ESC/OSC payloads, bounded widths) and truthful
 * lifecycle/input badges. Everything is pure frontend: no process, PTY,
 * filesystem, config, or Git work, and UI actions never stop an instance.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CURSOR_MARKER,
  isKittyProtocolActive,
  matchesKey,
  setKittyProtocolActive,
  visibleWidth,
} from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  createPlainOwnerWorkspaceField,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
  SidebarController,
} from "../src/session-host/sidebar";
import { createSessionHostTextField } from "../src/session-host/field-editor";
import type { PeerUiHost, PeerUiSettings, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT_LEGACY = "\x1b[1;3D";
const ALT_LEFT_ALTCHAT_LEGACY = "\x1bb";
const F8_LEGACY = "\x1b[19~";
const F9_LEGACY = "\x1b[20~";
const FUNCTION_KEY_EVENT_CASES = [
  ["f1", "11", "P"],
  ["f2", "12", "Q"],
  ["f3", "13", "R"],
  ["f4", "14", "S"],
  ["f5", "15"],
  ["f6", "17"],
  ["f7", "18"],
  ["f8", "19"],
  ["f9", "20"],
  ["f10", "21"],
  ["f11", "23"],
  ["f12", "24"],
] as const;
const KITTY_ALT_LEFT_PRESS = "\x1b[1;3:1D";
const KITTY_ALT_LEFT_REPEAT = "\x1b[1;3:2D";
const KITTY_ALT_LEFT_RELEASE = "\x1b[1;3:3D";
const KITTY_ALT_RIGHT_PRESS = "\x1b[1;3:1C";
const KITTY_ALT_RIGHT_REPEAT = "\x1b[1;3:2C";
const KITTY_ALT_RIGHT_RELEASE = "\x1b[1;3:3C";
const KITTY_F9_PRESS = "\x1b[20;1:1~";
const KITTY_F9_REPEAT = "\x1b[20;1:2~";
const KITTY_F9_RELEASE = "\x1b[20;1:3~";
const KITTY_Q = "\x1b[113u";
const KITTY_ENTER = "\x1b[13u";
const KITTY_Q_REPEAT = "\x1b[113;1:2u";
const KITTY_Q_RELEASE = "\x1b[113;1:3u";
const KITTY_ESCAPE_REPEAT = "\x1b[27;1:2u";
const KITTY_ESCAPE_RELEASE = "\x1b[27;1:3u";
const KITTY_CTRL_C_REPEAT = "\x1b[99;5:2u";
const KITTY_CTRL_C_RELEASE = "\x1b[99;5:3u";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ENTER = "\r";
const DELETE = "\x1b[3~";
const ESC = "\x1b";

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  /** Index into actions captured after test setup completed. */
  baseline: number;
  send(data: string): void;
  /** Actions emitted after the setup baseline. */
  sinceActions(): SidebarAction[];
  /** Actions emitted after the baseline except forwarded raw data. */
  focusedActions(): SidebarAction[];
}

interface RosterHarness extends Harness {}

function makeItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: `label-${overrides.id}`,
    workspace: `/ws/${overrides.id}`,
    agentDir: `/agents/${overrides.id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    ...overrides,
  };
}

function makeController(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  const harness: Harness = {
    controller,
    actions,
    baseline: 0,
    send: (data: string) => controller.handleInput(data),
    sinceActions: () => actions.slice(harness.baseline),
    focusedActions: () =>
      actions
        .slice(harness.baseline)
        .filter((action) => action.type !== "forward"),
  };
  return harness;
}

/** Toggle packet matching the configured chord (defaults to alt+left). */
function togglePacketFor(options: SidebarControllerOptions): string {
  switch (options.toggleKey?.toLowerCase()) {
    case "pageup":
      return "\x1b[5~";
    case "pagedown":
      return "\x1b[6~";
    case "ctrl+pagedown":
      return "\x1b[6^";
    default: {
      const functionKey = FUNCTION_KEY_EVENT_CASES.find(
        ([key]) => key === options.toggleKey?.toLowerCase(),
      );
      return functionKey === undefined ? ALT_LEFT_LEGACY : `\x1b[${functionKey[1]}~`;
    }
  }
}

/** Builds a roster and moves focus to the sidebar pane (one toggle show). */
function makeRoster(ids: string[], options: SidebarControllerOptions = {}): RosterHarness {
  const harness = makeController({ initialVisible: false, ...options });
  harness.controller.updateItems(ids.map((id) => makeItem({ id })));
  harness.send(togglePacketFor(options)); // show -> focus sidebar
  assert.equal(harness.controller.focus, "sidebar");
  // Draw the whole small roster once: selection keys only act on entries
  // the last roster render actually displayed.
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
  return harness;
}

/** Opens the New session form: hidden start, toggle show, Enter on New. */
function formWith(
  overrides: { cols?: number; rows?: number; options?: SidebarControllerOptions } = {},
): Harness {
  const harness = makeController({
    initialVisible: false,
    workspaceBasePath: join(process.cwd(), ".pi-session-host-test-missing-workspace"),
    ...(overrides.options ?? {}),
  });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(togglePacketFor(overrides.options ?? {})); // show -> focus sidebar (New default)
  void harness.controller.render(40, 20); // the New row is displayed before Enter
  harness.send(ENTER); // Enter on New session -> form focus
  assert.equal(harness.controller.focus, "form");
  // Touch the form geometry so every later render is fresh.
  void harness.controller.render(overrides.cols ?? 40, overrides.rows ?? 8);
  harness.baseline = harness.actions.length;
  return harness;
}

function assertPaneSafe(
  lines: string[],
  cols: number,
  rowCount?: number,
): string[] {
  for (const line of lines) {
    const sgrs = line.match(SGR_PATTERN) ?? [];
    for (const sgr of sgrs) {
      assert.ok(
        SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in line ${JSON.stringify(line)}`,
      );
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(
      !/[\u0000-\u001f\u007f-\u009f]/.test(text),
      `control byte outside generated SGR: ${JSON.stringify(line)}`,
    );
    assert.ok(
      visibleWidth(text) <= cols,
      `rendered row wider than pane: ${visibleWidth(text)} > ${cols}`,
    );
  }
  if (rowCount !== undefined) {
    assert.equal(lines.length, rowCount, "pane must fill the supplied geometry");
  }
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

function rosterView(
  controller: SidebarController,
  cols = 40,
  rows = 10,
): { texts: string[]; lines: string[] } {
  const lines = controller.render(cols, rows).lines;
  return { texts: assertPaneSafe(lines, cols, rows), lines };
}

function createOf(action: SidebarAction | undefined): Extract<SidebarAction, { type: "create" }> {
  assert.ok(action !== undefined && action.type === "create", `expected create, got ${JSON.stringify(action)}`);
  return action;
}

// ---------------------------------------------------------------------------
// Construction, visibility, and the reserved toggle
// ---------------------------------------------------------------------------

test("constructor opens a usable visible welcome picker", () => {
  const harness = makeController();
  const { controller } = harness;
  assert.equal(controller.visible, true);
  assert.equal(controller.focus, "sidebar");
  assert.equal(controller.selectedId, undefined);
  assert.equal(controller.items.length, 0);
  const texts = rosterView(controller).texts;
  assert.ok(texts[0].includes("Sessions (0)"));
  assert.ok(texts.some((line) => line.includes("New session")));
  assert.ok(texts.some((line) => line.includes("Quit host")));
  // The footer wraps across reserved rows at this width; every hint must
  // survive the wrap, never an ellipsis.
  const footer = texts.join(" ");
  for (const hint of ["toggle", "enter open", "e edit name", "d stop/remove", "esc hide", "q quit"]) {
    assert.ok(footer.includes(hint), `missing hint ${JSON.stringify(hint)} in ${JSON.stringify(texts)}`);
  }
  assert.ok(!texts.some((line) => line.includes("...")), "no ellipsized hints");
  harness.send(DOWN);
  harness.send(UP);
  assert.equal(controller.focus, "sidebar");
  assert.deepEqual(harness.actions.filter((action) => action.type === "forward"), []);
  harness.send(ENTER); // immediate Enter opens the default New session row
  assert.equal(controller.focus, "form");
  assert.deepEqual(harness.actions.filter((action) => action.type === "forward"), []);
});

test("draw-derived roster mouse activation targets only current complete entry regions", () => {
  const harness = makeRoster(["a", "b"]);
  const view = rosterView(harness.controller, 40, 30);
  const rowA = view.texts.findIndex((line) => line.trim() === "label-a");
  assert.ok(rowA > 0, "the first card was drawn below the header");
  assert.equal(harness.controller.activateRosterAt(0, rowA, 40, 30), true);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.selectedId, "a");
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }]);

  const offTarget = makeRoster(["a"]);
  const rows = rosterView(offTarget.controller, 40, 20).texts;
  const newRow = rows.findIndex((line) => line.includes("New session"));
  const savedRow = rows.findIndex((line) => line.includes("Saved conversations"));
  assert.equal(offTarget.controller.activateRosterAt(0, 0, 40, 20), false, "the header is not an entry");
  assert.equal(offTarget.controller.activateRosterAt(40, newRow, 40, 20), false, "the right pane edge is exclusive");
  assert.equal(offTarget.controller.activateRosterAt(0, rows.length - 1, 40, 20), false, "footer hints are not entries");
  assert.equal(offTarget.controller.activateRosterAt(0, savedRow, 40, 20), true, "Saved uses its existing open action");
  assert.equal(offTarget.controller.focus, "form");
  assert.equal(offTarget.focusedActions().at(-1)?.type, "saved-list");

  const stale = makeRoster(["a", "b"]);
  const staleView = rosterView(stale.controller, 40, 30).texts;
  const staleRow = staleView.findIndex((line) => line.trim() === "label-a");
  stale.controller.updateItems([makeItem({ id: "b" }), makeItem({ id: "a" })]);
  assert.equal(stale.controller.activateRosterAt(0, staleRow, 40, 30), false,
    "an item update/reorder invalidates the exact entries captured by the old draw");
  assert.deepEqual(stale.focusedActions(), []);

  const clipped = makeRoster(["a", "b", "c"]);
  const clippedView = rosterView(clipped.controller, 40, 10).texts;
  assert.ok(!clippedView.some((line) => line.includes("label-a")), "the scrolled card is not drawn");
  const quitRow = clippedView.findIndex((line) => line.includes("Quit host"));
  const blankRow = clippedView.findIndex((line, index) => index > quitRow && line.trim() === "");
  assert.ok(blankRow > quitRow, "the remaining list space is blank, not an entry");
  assert.equal(clipped.controller.activateRosterAt(0, blankRow, 40, 10), false,
    "undrawn/clipped entries and blank rows have no hit region");

  const tiny = makeRoster(["a"]);
  const tinyView = rosterView(tiny.controller, 40, 3).texts;
  assert.ok(tinyView.some((line) => line.includes("too small")));
  assert.equal(tiny.controller.activateRosterAt(0, 1, 40, 3), false, "too-small fallback exposes no hit regions");
  tiny.send(ALT_LEFT_LEGACY);
  assert.equal(tiny.controller.activateRosterAt(0, 1, 40, 30), false, "hidden roster regions are forgotten");
});

test("draw-derived action-row mouse activation reuses New and Quit behavior", () => {
  const newAction = makeRoster([]);
  const newRows = rosterView(newAction.controller, 40, 20).texts;
  const newRow = newRows.findIndex((line) => line.includes("New session"));
  assert.equal(newAction.controller.activateRosterAt(0, newRow, 40, 20), true);
  assert.equal(newAction.controller.focus, "form");
  assert.deepEqual(newAction.focusedActions(), [], "opening the existing New form does not submit a create");

  const quitAction = makeRoster(["live"]);
  const quitRows = rosterView(quitAction.controller, 40, 30).texts;
  const quitRow = quitRows.findIndex((line) => line.includes("Quit host"));
  assert.equal(quitAction.controller.activateRosterAt(0, quitRow, 40, 30), true);
  assert.equal(quitAction.controller.focus, "confirm", "live rows keep the existing Quit confirmation");
  assert.deepEqual(quitAction.focusedActions(), []);
});

/**
 * Draws the wide two-pane frame exactly as Main does — the left roster beside
 * the right-hand host UI — and returns the plain roster rows with the geometry
 * that written frame authorizes.
 */
function widePanes(harness: Harness, rows = 24): { roster: string[]; rows: number } {
  const roster = assertPaneSafe(harness.controller.renderRoster(32, rows).lines, 32, rows);
  void harness.controller.renderForm(47, rows);
  return { roster, rows };
}

/** The written roster row that begins the entry containing `text`. */
function wideRosterRow(roster: readonly string[], text: string): number {
  const row = roster.findIndex((line) => line.includes(text));
  assert.ok(row > 0, `the written roster drew no ${JSON.stringify(text)} row: ${JSON.stringify(roster)}`);
  return row;
}

/** Plain text of the right-hand pane at the wide geometry. */
function wideFormText(harness: Harness, rows = 24): string {
  return assertPaneSafe(harness.controller.renderForm(47, rows).lines, 47, rows).join("\n");
}

test("a left-roster click beside an open right-hand UI cancels it and activates the clicked row once", () => {
  // New session with a dirty draft: a different row abandons the form through
  // its own cancellation route and then performs only the clicked row's action.
  const newForm = makeRoster(["a"]);
  newForm.send(ENTER); // the default New row opens its form; the highlight stays on New
  assert.equal(newForm.controller.focus, "form");
  newForm.send("/dirty-draft");
  newForm.baseline = newForm.actions.length;
  const newView = widePanes(newForm);
  assert.equal(newForm.controller.activateRosterAt(1, wideRosterRow(newView.roster, "label-a"), 32, newView.rows), true);
  assert.equal(newForm.controller.focus, "main");
  assert.deepEqual(newForm.focusedActions(), [{ type: "select", id: "a" }],
    "the click cancels the form and performs the clicked row's ordinary action exactly once");
  const reopened = widePanes(newForm);
  assert.equal(newForm.controller.activateRosterAt(1, wideRosterRow(reopened.roster, "New session"), 32, reopened.rows), true);
  assert.equal(newForm.controller.focus, "form");
  assert.ok(wideFormText(newForm).includes("/dirty-draft"), "the abandoned New draft keeps its existing retention");
  assert.deepEqual(newForm.focusedActions().filter((action) => action.type === "create"), [],
    "cancelling a form never submits it");

  // A click on the row that already holds the left highlight is a pure no-op:
  // right pane, dirty draft, focus, selection, and actions all unchanged.
  const same = makeRoster(["a"]);
  same.send(ENTER);
  same.send("/keep-me");
  same.baseline = same.actions.length;
  const sameView = widePanes(same);
  assert.equal(same.controller.activateRosterAt(1, wideRosterRow(sameView.roster, "New session"), 32, sameView.rows), true);
  assert.deepEqual(same.focusedActions(), [], "the highlighted row neither cancels nor re-activates");
  assert.equal(same.controller.focus, "form", "the right-hand form stays open");
  assert.ok(wideFormText(same).includes("/keep-me"), "the dirty draft survives the same-row click");

  // Saved picker: a different row runs the picker's own dismissal first, then
  // activates the clicked row; the same row keeps the picker open untouched.
  const saved = savedPaneWith(["a"]);
  const list = saved.actions.at(-1);
  assert.ok(list !== undefined && list.type === "saved-list");
  saved.controller.completeSavedList(list.requestId, [...SAVED_ROWS], 0);
  saved.baseline = saved.actions.length;
  const savedView = widePanes(saved);
  assert.equal(saved.controller.activateRosterAt(1, wideRosterRow(savedView.roster, "label-a"), 32, savedView.rows), true);
  assert.equal(saved.controller.focus, "main");
  assert.deepEqual(saved.focusedActions(), [
    { type: "saved-dismiss", pickerId: list.requestId },
    { type: "select", id: "a" },
  ], "the picker's own dismissal runs first, then the clicked row acts once");
  assert.equal(saved.controller.savedPickerRequestId, undefined, "the dismissed picker owns nothing afterwards");

  const savedSame = savedPaneWith(["a"]);
  const savedSameList = savedSame.actions.at(-1);
  assert.ok(savedSameList !== undefined && savedSameList.type === "saved-list");
  savedSame.controller.completeSavedList(savedSameList.requestId, [...SAVED_ROWS], 0);
  savedSame.baseline = savedSame.actions.length;
  const savedSameView = widePanes(savedSame);
  assert.equal(savedSame.controller.activateRosterAt(
    1, wideRosterRow(savedSameView.roster, "Saved conversations"), 32, savedSameView.rows), true);
  assert.deepEqual(savedSame.focusedActions(), [], "a click on the highlighted Saved row emits nothing");
  assert.equal(savedSame.controller.focus, "form", "the picker stays open under the same-row click");
  assert.equal(savedSame.controller.savedPickerRequestId, savedSameList.requestId, "the same picker is retained");

  // Host shortcuts: a different row closes the editor through its own cancel
  // route without saving anything, and the clicked row acts normally.
  const shortcuts = makeRoster(["a"], { settingsAvailable: true });
  const shortcutsRoster = assertPaneSafe(shortcuts.controller.renderRoster(32, 24).lines, 32, 24);
  assert.equal(shortcuts.controller.activateRosterAt(1, wideRosterRow(shortcutsRoster, "Host shortcuts"), 32, 24), true);
  assert.equal(shortcuts.controller.focus, "form");
  shortcuts.baseline = shortcuts.actions.length;
  const shortcutView = widePanes(shortcuts);
  assert.equal(shortcuts.controller.activateRosterAt(1, wideRosterRow(shortcutView.roster, "label-a"), 32, shortcutView.rows), true);
  assert.equal(shortcuts.controller.focus, "main");
  assert.deepEqual(shortcuts.focusedActions(), [{ type: "select", id: "a" }],
    "the shortcuts editor closes through its cancel route and never saves");
  const closedShortcuts = wideFormText(shortcuts);
  assert.equal(closedShortcuts.includes("Host shortcuts"), false,
    "no hidden shortcuts editor survives the click");
});

test("a left-roster click cancels nested and divergent right-hand UI without deciding anything", () => {
  // Nested Saved delete over its picker: the click dismisses BOTH the
  // confirmation and the picker with their existing routes and never deletes.
  const nested = savedPaneWith(["a"]);
  const nestedList = nested.actions.at(-1);
  assert.ok(nestedList !== undefined && nestedList.type === "saved-list");
  nested.controller.completeSavedList(nestedList.requestId, [...SAVED_ROWS], 0);
  savedView(nested, 40, 16);
  nested.send("\x04"); // native default app.session.delete
  const prepare = nested.actions.at(-1);
  assert.ok(prepare !== undefined && prepare.type === "saved-delete-prepare");
  assert.equal(nested.controller.completeSavedDeleteCheck(prepare.requestId, true), true);
  assert.equal(nested.controller.focus, "confirm");
  nested.baseline = nested.actions.length;
  const nestedRoster = assertPaneSafe(nested.controller.renderRoster(32, 20).lines, 32, 20);
  void nested.controller.renderSavedDeleteConfirmation(47, 20);
  assert.equal(nested.controller.activateRosterAt(1, wideRosterRow(nestedRoster, "label-a"), 32, 20), true);
  assert.equal(nested.controller.focus, "main");
  assert.deepEqual(nested.focusedActions(), [
    { type: "saved-dismiss", pickerId: nestedList.requestId },
    { type: "select", id: "a" },
  ], "the confirmation and its containing picker both close, then the clicked row acts once");
  assert.equal(nested.actions.some((action) => action.type === "saved-delete"), false,
    "a pointer gesture never confirms a deletion");
  assert.equal(nested.controller.savedDeleteConfirmationActive, false);
  assert.equal(nested.controller.savedPickerRequestId, undefined, "no hidden picker state survives the click");
  assert.deepEqual(nested.controller.renderSavedDeleteConfirmation(47, 20).lines, [],
    "the closed confirmation cannot resurrect itself in the right-hand slot");

  // Edit whose target is NOT the left highlight: the left selection decides.
  const tupleA = { sessionId: "session-a", epoch: 7, name: "Left card" };
  const tupleB = { sessionId: "session-b", epoch: 8, name: "Edited card" };
  const edit = makeRoster(["a", "b"]);
  edit.controller.updateItems([
    makeItem({ id: "a", nativeSession: tupleA }),
    makeItem({ id: "b", nativeSession: tupleB }),
  ]);
  assert.equal(edit.controller.openEdit({ id: "b", nativeSession: tupleB, currentName: tupleB.name }), true);
  assert.equal(edit.controller.selectedId, undefined, "the Edit target is not the left highlight");
  edit.baseline = edit.actions.length;
  const editView = widePanes(edit);
  assert.equal(edit.controller.activateRosterAt(1, wideRosterRow(editView.roster, "New session"), 32, editView.rows), true);
  assert.deepEqual(edit.focusedActions(), [], "the highlighted row is a pure no-op even when the pane targets another row");
  assert.equal(edit.controller.focus, "form", "the Edit form stays open under the same-row click");
  assert.ok(wideFormText(edit).includes("New name:"), "the open Edit form is preserved");
  const editAgain = widePanes(edit);
  assert.equal(edit.controller.activateRosterAt(1, wideRosterRow(editAgain.roster, "Left card"), 32, editAgain.rows), true);
  assert.equal(edit.controller.focus, "main");
  assert.deepEqual(edit.focusedActions(), [{ type: "select", id: "a" }],
    "a different row abandons the Edit and activates the clicked row once");
  assert.equal(edit.actions.some((action) => action.type === "rename"), false,
    "a pointer gesture never submits a rename");
  assert.equal(wideFormText(edit).includes("New name:"), false, "no hidden Edit form survives the click");

  // The native Main owner never decides "same": with a live owner elsewhere,
  // the highlighted row is still a no-op and another row still acts.
  const owner = makeRoster(["a", "b"]);
  owner.controller.setActiveMainOwner("a");
  owner.send(ENTER); // New form opens while owner A keeps native input
  assert.equal(owner.controller.focus, "form");
  assert.equal(owner.controller.activeMainOwnerID, "a", "the native owner differs from the highlighted New row");
  owner.baseline = owner.actions.length;
  const ownerView = widePanes(owner);
  assert.equal(owner.controller.activateRosterAt(1, wideRosterRow(ownerView.roster, "New session"), 32, ownerView.rows), true);
  assert.deepEqual(owner.focusedActions(), [], "a divergent native owner does not turn the highlighted row into an action");
  assert.equal(owner.controller.focus, "form");
  const ownerAgain = widePanes(owner);
  assert.equal(owner.controller.activateRosterAt(1, wideRosterRow(ownerAgain.roster, "label-b"), 32, ownerAgain.rows), true);
  assert.deepEqual(owner.focusedActions(), [{ type: "select", id: "b" }]);
  assert.equal(owner.controller.activeMainOwnerID, "a", "the click only selects; Main reassigns ownership on completion");

  // A changed row identity is refused silently, exactly like any stale draw:
  // nothing is cancelled and the open pane keeps its own state.
  const stale = savedPaneWith(["a", "b"]);
  const staleList = stale.actions.at(-1);
  assert.ok(staleList !== undefined && staleList.type === "saved-list");
  stale.controller.completeSavedList(staleList.requestId, [...SAVED_ROWS], 0);
  stale.baseline = stale.actions.length;
  const staleView = widePanes(stale);
  const staleRow = wideRosterRow(staleView.roster, "label-b");
  stale.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "b", lifecycle: "exited" })]);
  assert.equal(stale.controller.activateRosterAt(1, staleRow, 32, staleView.rows), false,
    "a row whose activation identity changed after the draw is refused");
  assert.deepEqual(stale.focusedActions(), [], "a refused click cancels nothing");
  assert.equal(stale.controller.focus, "form", "the open picker is left to its own rules");
  assert.equal(stale.controller.savedPickerRequestId, staleList.requestId);

  // Only the roster actually written at this geometry authorizes the click.
  const unwritten = savedPaneWith(["a"]);
  const unwrittenList = unwritten.actions.at(-1);
  assert.ok(unwrittenList !== undefined && unwrittenList.type === "saved-list");
  unwritten.controller.completeSavedList(unwrittenList.requestId, [...SAVED_ROWS], 0);
  unwritten.baseline = unwritten.actions.length;
  const unwrittenView = widePanes(unwritten);
  const unwrittenRow = wideRosterRow(unwrittenView.roster, "label-a");
  assert.equal(unwritten.controller.activateRosterAt(1, unwrittenRow, 40, 30), false,
    "a click at another pane geometry matches no written region");
  void unwritten.controller.render(40, 16); // the narrow full-pane render replaces the roster
  assert.equal(unwritten.controller.activateRosterAt(1, unwrittenRow, 32, unwrittenView.rows), false,
    "a roster that is not actually on screen authorizes nothing");
  assert.deepEqual(unwritten.focusedActions(), [], "neither refused click cancels the open picker");
  assert.equal(unwritten.controller.savedPickerRequestId, unwrittenList.requestId);

  // With no right-hand UI open, the ordinary row action is unchanged: even a
  // click on the highlighted row performs its normal action.
  const plainRoster = makeRoster(["a"]);
  plainRoster.baseline = plainRoster.actions.length;
  const plainView = assertPaneSafe(plainRoster.controller.renderRoster(32, 24).lines, 32, 24);
  assert.equal(plainRoster.controller.activateRosterAt(1, wideRosterRow(plainView, "New session"), 32, 24), true);
  assert.equal(plainRoster.controller.focus, "form",
    "the no-op applies only while a right-hand UI is open");
});

for (const clicked of ["drawn-highlight", "live-highlight"] as const) {
  test(`a captured right-pane roster refuses a changed drawn selection (${clicked})`, () => {
    const harness = savedPaneWith(["a", "b"]);
    const list = harness.actions.at(-1);
    assert.ok(list !== undefined && list.type === "saved-list");
    harness.controller.completeSavedList(list.requestId, [...SAVED_ROWS], 0);
    const written = widePanes(harness);
    const capture = harness.controller.captureMousePresentation();
    const savedRow = wideRosterRow(written.roster, "Saved conversations");
    const localRow = wideRosterRow(written.roster, "label-a");
    harness.baseline = harness.actions.length;

    // Exercise the controller's backend-selection seam directly: current Main
    // does not wire a selection-only change while this picker remains open.
    harness.controller.select("a");
    assert.equal(harness.controller.focus, "form");
    assert.equal(harness.controller.selectedId, "a");
    const row = clicked === "drawn-highlight" ? savedRow : localRow;
    assert.equal(capture.activateRosterAt(1, row, 32, written.rows), false,
      "an old drawn highlight cannot be reinterpreted as cancellation or a no-op");
    assert.deepEqual(harness.focusedActions(), [], "the stale click cancels and activates nothing");
    assert.equal(harness.controller.savedPickerRequestId, list.requestId);

    const current = widePanes(harness);
    const fresh = harness.controller.captureMousePresentation();
    assert.equal(capture.activateRosterAt(1, row, 32, written.rows), false,
      "another render cannot update the immutable old presentation's highlight");
    assert.equal(fresh.activateRosterAt(1, wideRosterRow(current.roster, "label-a"), 32, current.rows), true);
    assert.deepEqual(harness.focusedActions(), [], "the newly drawn highlight is now a genuine no-op");
    assert.equal(harness.controller.savedPickerRequestId, list.requestId);
    assert.equal(fresh.activateRosterAt(1, wideRosterRow(current.roster, "label-b"), 32, current.rows), true);
    assert.deepEqual(harness.focusedActions(), [
      { type: "saved-dismiss", pickerId: list.requestId },
      { type: "select", id: "b" },
    ], "a different row in the fresh presentation retains ordinary cancel-and-activate behavior");
  });
}

test("initialVisible is honored in both directions", () => {
  const hidden = makeController({ initialVisible: false });
  assert.equal(hidden.controller.visible, false);
  assert.deepEqual(hidden.controller.render(40, 8).lines, []);
  assert.equal(hidden.controller.focus, "main");
  const shown = makeController({ initialVisible: true });
  assert.equal(shown.controller.visible, true);
  assert.equal(shown.controller.focus, "sidebar");
});

test("default toggle (Alt+Left legacy packets) hides/shows with visibility actions", () => {
  const { controller, actions } = makeController();
  controller.handleInput(ALT_LEFT_LEGACY);
  assert.equal(controller.visible, false);
  assert.equal(controller.focus, "main");
  assert.deepEqual(actions, [{ type: "visibility", visible: false }]);
  controller.handleInput(ALT_LEFT_ALTCHAT_LEGACY);
  assert.equal(controller.visible, true);
  // Opening gives sidebar focus.
  assert.equal(controller.focus, "sidebar");
  assert.deepEqual(actions, [
    { type: "visibility", visible: false },
    { type: "visibility", visible: true },
  ]);
  // Hidden panes render nothing.
  controller.handleInput(ALT_LEFT_LEGACY);
  assert.deepEqual(controller.render(40, 8).lines, []);
});

test("main input keeps working while the pane is hidden", () => {
  const { controller, actions } = makeController({ initialVisible: false });
  controller.handleInput("x");
  assert.deepEqual(actions, [{ type: "forward", data: "x" }]);
  assert.equal(controller.visible, false);
});

test("configured F8 toggle toggles; the default chord is plain main-focus data", () => {
  const harness = makeController({ toggleKey: "f8", initialVisible: false });
  harness.send(F8_LEGACY); // show -> focus sidebar
  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(F8_LEGACY); // toggle also works from the sidebar focus
  assert.equal(harness.controller.visible, false);
  // With F8 configured, the default alt+left packet is plain forwarded data
  // when MAIN is focused.
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.visible, false);
  assert.deepEqual(harness.sinceActions(), [
    { type: "visibility", visible: true },
    { type: "visibility", visible: false },
    { type: "forward", data: ALT_LEFT_LEGACY },
  ]);
  harness.send(F8_LEGACY); // show again
  assert.equal(harness.controller.visible, true);
  assert.deepEqual(harness.sinceActions(), [
    { type: "visibility", visible: true },
    { type: "visibility", visible: false },
    { type: "forward", data: ALT_LEFT_LEGACY },
    { type: "visibility", visible: true },
  ]);
});

test("Shift-only navigation chords are valid host bindings and match pinned packets", () => {
  const harness = makeController({ toggleKey: "shift+left", initialVisible: false });
  harness.send("\x1b[d"); // pinned xterm Shift+Left legacy packet
  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.actions, [{ type: "visibility", visible: true }]);
});

test("Enter aliases cannot replace either host action", () => {
  for (const chord of ["ctrl+m", "ctrl+j"]) {
    assert.throws(() => new SidebarController({ toggleKey: chord }), /native Enter/);
    assert.throws(() => new SidebarController({ returnToMainKey: chord }), /native Enter/);
  }
});

test("configured return-to-Main is roster-only and its held F-key events stay fenced", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeRoster(["active", "sibling"], { toggleKey: "f8", returnToMainKey: "f9" });
    harness.controller.select("active");
    harness.controller.setActiveMainOwner("active");
    rosterView(harness.controller, 50, 24);
    harness.baseline = harness.actions.length;

    harness.send("\x1b[20;1:1~"); // roster-only F9 return
    assert.equal(harness.controller.focus, "main");
    assert.equal(harness.controller.visible, true);
    assert.equal(harness.controller.selectedId, "active");
    assert.equal(harness.controller.activeMainOwnerID, "active");
    assert.deepEqual(harness.sinceActions(), [], "return does not select or change the active identity");
    harness.send("\x1b[20;1:2~"); // held repeat stays claimed after focus transfer
    harness.send("\x1b[20;1:3~"); // release clears the fence
    assert.deepEqual(harness.sinceActions(), []);

    harness.send("\x1b[20;1:1~"); // fresh F9 in Main is ordinary native input
    assert.deepEqual(harness.sinceActions(), [{ type: "forward", data: "\x1b[20;1:1~" }]);
    harness.send(ALT_LEFT_LEGACY); // old default toggle chord is ordinary native input
    assert.equal(harness.controller.visible, true);
    assert.deepEqual(harness.sinceActions().slice(-2), [
      { type: "forward", data: "\x1b[20;1:1~" },
      { type: "forward", data: ALT_LEFT_LEGACY },
    ]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("the configured return chord is consumed in host forms and confirmations", () => {
  const form = formWith({ options: { toggleKey: "f8", returnToMainKey: "f9" } });
  form.send(F9_LEGACY);
  assert.equal(form.controller.focus, "form");
  assert.deepEqual(form.sinceActions(), []);

  const saved = makeRoster([], { toggleKey: "f8", returnToMainKey: "f9" });
  saved.send(UP); // New -> Saved conversations
  void saved.controller.render(50, 24);
  saved.send(ENTER);
  assert.equal(saved.controller.focus, "form");
  saved.baseline = saved.actions.length;
  saved.send(F9_LEGACY);
  assert.equal(saved.controller.focus, "form", "Saved picker consumes return rather than taking focus");
  assert.deepEqual(saved.focusedActions(), []);

  const confirmation = makeRoster(["live"], { toggleKey: "f8", returnToMainKey: "f9" });
  confirmation.controller.updateItems([makeItem({ id: "live", busy: true, hasLiveProcess: true })]);
  confirmation.controller.select("live");
  rosterView(confirmation.controller, 50, 24);
  confirmation.send("d");
  assert.equal(confirmation.controller.focus, "confirm");
  confirmation.send(F9_LEGACY);
  assert.equal(confirmation.controller.focus, "confirm");
  assert.deepEqual(confirmation.focusedActions(), []);
});

test("both Host shortcuts labels stay beside their real editable body row", () => {
  const harness = makeController({ settingsAvailable: true });
  void harness.controller.render(60, 20);
  harness.send(DOWN);
  harness.send(DOWN);
  void harness.controller.render(60, 20);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  for (const [index, prefix, value, inactive] of [
    [0, "> Toggle (stored): ", "f8", "  Return to Main: "],
    [1, "> Return to Main: ", "f9", "  Toggle (stored): f8"],
  ] as const) {
    if (index === 1) harness.send("\t");
    harness.send("\x15");
    harness.send(value);
    const frame = harness.controller.render(60, 20);
    const rows = assertPaneSafe(frame.lines, 60, 20);
    assert.ok(frame.cursor);
    const { row, column } = frame.cursor;
    assert.equal(rows[row]?.slice(0, prefix.length), prefix,
      "the active shortcut label is on the native text row, not its top rule");
    assert.equal(rows[row]?.slice(prefix.length, column), value);
    assert.equal(rows[row - 1]?.slice(0, prefix.length), " ".repeat(prefix.length));
    assert.match(rows[row - 1]?.slice(prefix.length) ?? "", /^─+$/);
    assert.ok(rows.some((line) => line.startsWith(inactive)),
      "the inactive sibling keeps its draft beside its own inline label");
  }
  harness.send(ESC);
  assert.deepEqual(harness.focusedActions(), [], "alignment changes commit no settings");
});

test("host shortcut settings edit configured bindings and Cancel leaves active bindings unchanged", () => {
  const harness = makeController({ settingsAvailable: true });
  const open = (): void => {
    void harness.controller.render(60, 20);
    harness.send(DOWN); // New -> Quit host
    harness.send(DOWN); // -> Host shortcuts
    void harness.controller.render(60, 20);
    harness.send(ENTER);
    assert.equal(harness.controller.focus, "form");
  };
  open();
  harness.send("\x15");
  harness.send("f8");
  harness.send("\t");
  harness.send("\x15");
  harness.send("f9");
  harness.send(ESC); // Cancel is local and emits no save action
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focusedActions(), []);
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.visible, false, "the old active toggle remains in force after Cancel");
});

test("host shortcut Save validates the pair and applies only after successful completion", () => {
  const harness = makeController({ settingsAvailable: true });
  void harness.controller.render(60, 20);
  harness.send(DOWN);
  harness.send(DOWN);
  void harness.controller.render(60, 20);
  harness.send(ENTER);
  harness.send("\x15");
  harness.send("f8");
  harness.send("\t");
  harness.send("\x15");
  harness.send("f9");
  harness.send(ENTER);
  const save = harness.sinceActions().find((action) => action.type === "host-shortcuts-save");
  assert.ok(save && save.type === "host-shortcuts-save");
  assert.deepEqual(save.bindings, { toggle: "f8", returnToMain: "f9" });
  assert.equal(harness.controller.focus, "form", "the editor waits for its Save result");
  assert.equal(harness.controller.completeHostShortcutSave(save.requestId, save.bindings), true);
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(F8_LEGACY);
  assert.equal(harness.controller.visible, false, "the successful Save immediately activates F8");
});

test("a held old toggle chord stays fenced across Save and its fresh press remains native", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeController({ initialVisible: false, settingsAvailable: true });
    harness.send(KITTY_ALT_LEFT_PRESS); // show the sidebar and claim Alt+Left
    assert.equal(harness.controller.visible, true);
    assert.equal(harness.controller.focus, "sidebar");
    void harness.controller.render(60, 20);
    harness.send(DOWN); // New -> Quit host
    harness.send(DOWN); // -> Host shortcuts
    void harness.controller.render(60, 20);
    harness.send(ENTER);
    harness.send("\x15");
    harness.send("f8");
    harness.send("\t");
    harness.send("\x15");
    harness.send("f9");
    harness.send(ENTER);
    const save = harness.sinceActions().find((action) => action.type === "host-shortcuts-save");
    assert.ok(save && save.type === "host-shortcuts-save");
    assert.equal(harness.controller.completeHostShortcutSave(save.requestId, save.bindings), true);
    harness.baseline = harness.actions.length;

    harness.send(F8_LEGACY); // hide to Main while the original Alt+Left is held
    assert.equal(harness.controller.focus, "main");
    harness.send(KITTY_ALT_LEFT_REPEAT);
    harness.send(KITTY_ALT_LEFT_RELEASE);
    assert.deepEqual(harness.sinceActions(), [{ type: "visibility", visible: false }],
      "the old toggle's held repeat/release must not leak to Main");
    harness.send(KITTY_ALT_LEFT_PRESS); // retired binding is fresh native input
    assert.deepEqual(harness.sinceActions(), [
      { type: "visibility", visible: false },
      { type: "forward", data: KITTY_ALT_LEFT_PRESS },
    ]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("a held return chord keeps its original repeat/release fence through Save and Main transfer", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeController({
      toggleKey: "f8",
      returnToMainKey: "alt+right",
      configuredShortcuts: { toggle: "f8", returnToMain: "alt+right" },
      settingsAvailable: true,
    });
    void harness.controller.render(60, 20);
    harness.send(DOWN); // New -> Quit host
    harness.send(DOWN); // -> Host shortcuts
    void harness.controller.render(60, 20);
    harness.send(ENTER);
    harness.send(KITTY_ALT_RIGHT_PRESS); // old return binding is claimed by the editor
    harness.send("\x15");
    harness.send("f8");
    harness.send("\t");
    harness.send("\x15");
    harness.send("f9");
    harness.send(ENTER);
    const save = harness.sinceActions().find((action) => action.type === "host-shortcuts-save");
    assert.ok(save && save.type === "host-shortcuts-save");
    assert.equal(harness.controller.completeHostShortcutSave(save.requestId, save.bindings), true);
    harness.baseline = harness.actions.length;

    harness.send(F8_LEGACY); // hide to Main while Alt+Right remains held
    assert.equal(harness.controller.focus, "main");
    harness.send(KITTY_ALT_RIGHT_REPEAT);
    harness.send(KITTY_ALT_RIGHT_RELEASE);
    assert.deepEqual(harness.sinceActions(), [{ type: "visibility", visible: false }],
      "the held old chord cannot leak after the configured return binding changes");
    harness.send(KITTY_ALT_RIGHT_PRESS); // a fresh old chord is native in Main
    assert.deepEqual(harness.sinceActions().slice(-1), [{ type: "forward", data: KITTY_ALT_RIGHT_PRESS }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("a fresh press of the originally claimed return chord clears its old fence", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeController({
      toggleKey: "f8",
      returnToMainKey: "f9",
      configuredShortcuts: { toggle: "f8", returnToMain: "f9" },
      settingsAvailable: true,
    });
    void harness.controller.render(60, 20);
    harness.send(DOWN);
    harness.send(DOWN);
    void harness.controller.render(60, 20);
    harness.send(ENTER);
    harness.send(KITTY_F9_PRESS); // claimed by the editor before rebinding
    harness.send("\t");
    harness.send("\x15");
    harness.send("alt+right");
    harness.send(ENTER);
    const save = harness.sinceActions().find((action) => action.type === "host-shortcuts-save");
    assert.ok(save && save.type === "host-shortcuts-save");
    assert.equal(harness.controller.completeHostShortcutSave(save.requestId, save.bindings), true);
    harness.baseline = harness.actions.length;

    harness.send(F8_LEGACY);
    harness.send(KITTY_F9_PRESS); // new press of the old chord clears its prior claim
    harness.send(KITTY_F9_REPEAT);
    harness.send(KITTY_F9_RELEASE);
    assert.deepEqual(harness.sinceActions(), [
      { type: "visibility", visible: false },
      { type: "forward", data: KITTY_F9_PRESS },
      { type: "forward", data: KITTY_F9_REPEAT },
      { type: "forward", data: KITTY_F9_RELEASE },
    ]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("bare F1-F12 CSI event packets consume press/repeat/release without double-toggle", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    for (const [key, tildeCode, letterFinal] of FUNCTION_KEY_EVENT_CASES) {
      const forms: Array<{ prefix: string; suffix: string }> = [
        { prefix: `\x1b[${tildeCode};1:`, suffix: "~" },
      ];
      if (letterFinal !== undefined) {
        forms.push({ prefix: "\x1b[1;1:", suffix: letterFinal });
      }
      for (const { prefix, suffix } of forms) {
        const harness = makeController({ toggleKey: key });
        harness.send(`${prefix}1${suffix}`); // press closes the picker
        harness.send(`${prefix}2${suffix}`); // repeat in main is consumed
        harness.send(`${prefix}3${suffix}`); // reserved release stays consumed
        assert.equal(harness.controller.visible, false, `${key} ${JSON.stringify(suffix)}`);
        assert.deepEqual(harness.actions, [{ type: "visibility", visible: false }]);
      }
    }

    for (const modifier of [65, 129, 193]) { // Caps, Num, and both lock bits only
      const locked = makeController({ toggleKey: "f9" });
      locked.send(`\x1b[20;${modifier}:1~`);
      locked.send(`\x1b[20;${modifier}:2~`);
      locked.send(`\x1b[20;${modifier}:3~`);
      assert.equal(locked.controller.visible, false);
      assert.deepEqual(locked.actions, [{ type: "visibility", visible: false }]);
    }
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("implicit F1-F12 function-key presses toggle before repeat/release", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    for (const [key, tildeCode, letterFinal] of FUNCTION_KEY_EVENT_CASES) {
      const forms: Array<{ implicitPress: string; eventPrefix: string; suffix: string }> = [
        {
          implicitPress: `\x1b[${tildeCode};1~`,
          eventPrefix: `\x1b[${tildeCode};1:`,
          suffix: "~",
        },
      ];
      if (letterFinal !== undefined && letterFinal !== "R") {
        forms.push({
          implicitPress: `\x1b[1;1${letterFinal}`,
          eventPrefix: "\x1b[1;1:",
          suffix: letterFinal,
        });
      }
      for (const { implicitPress, eventPrefix, suffix } of forms) {
        const harness = makeController({ toggleKey: key, initialVisible: false });
        harness.send(implicitPress); // implicit event type is an initial press
        assert.equal(harness.controller.visible, true, `${key} ${JSON.stringify(implicitPress)}`);
        harness.send(`${eventPrefix}2${suffix}`);
        harness.send(`${eventPrefix}3${suffix}`);
        assert.deepEqual(harness.actions, [{ type: "visibility", visible: true }]);
      }
    }
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("eventful function-key routing is consistent from main, form, and confirmation", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const press = "\x1b[20;1:1~";
    const repeat = "\x1b[20;1:2~";
    const release = "\x1b[20;1:3~";

    const main = makeController({ toggleKey: "f9", initialVisible: false });
    main.send(press);
    main.send(repeat);
    main.send(release);
    assert.deepEqual(main.actions, [{ type: "visibility", visible: true }]);

    const form = formWith({ options: { toggleKey: "f9" } });
    form.send(press);
    form.send(repeat);
    form.send(release);
    assert.deepEqual(form.focusedActions(), [{ type: "visibility", visible: false }]);
    assert.deepEqual(form.actions.filter((action) => action.type === "forward"), []);

    const confirmation = makeRoster(["live"], { toggleKey: "f9" });
    confirmation.send("q");
    confirmation.send(press);
    confirmation.send(repeat);
    confirmation.send(release);
    assert.deepEqual(confirmation.focusedActions(), [{ type: "visibility", visible: false }]);
    assert.deepEqual(confirmation.actions.filter((action) => action.type === "forward"), []);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("different, modified, malformed, DSR, and pasted F-key packets stay native in main", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeController({ toggleKey: "f9", initialVisible: false });
    const packets = [
      "\x1b[19;1:2~", // F8 repeat is not the reserved F9
      "\x1b[20;2:3~", // Shift+F9 is not the unmodified toggle
      "\x1b[20;5:3~", // Ctrl+F9 is not the unmodified toggle
      "\x1b[20;1:4~", // unsupported event type is not a reserved packet
      "\x1b[1;1R", // ambiguous DSR is not treated as an implicit F3 press
      "\x1b[6;1R", // unrelated DSR rows are not function-key codes
      "\x1b[200~\x1b[20;1:3~\x1b[201~", // paste framing prevents event matching
    ];
    for (const packet of packets) {
      harness.send(packet);
    }
    assert.deepEqual(
      harness.actions,
      packets.map((data) => ({ type: "forward", data })),
    );

    const dsr = makeController({ toggleKey: "f3", initialVisible: false });
    const dsrPackets = ["\x1b[1;1R", "\x1b[6;1R"];
    for (const packet of dsrPackets) {
      dsr.send(packet);
    }
    assert.deepEqual(
      dsr.actions,
      dsrPackets.map((data) => ({ type: "forward", data })),
    );
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("invalid toggle chords fail construction instead of going silently dead", () => {
  for (const bad of ["", "bogus", "ctrl+bogus", "f8+ctrl", "alt+alt+left", "ctrl+ctrl+a"]) {
    assert.throws(
      () => new SidebarController({ toggleKey: bad }),
      /toggleKey/,
      `expected throw for ${JSON.stringify(bad)}`,
    );
  }
  // Bounded known alternatives stay accepted, including F8 and combined chords.
  for (const good of [
    "f8",
    "ctrl+k",
    "super+k",
    "ctrl+shift+alt+left",
    "alt+q",
    "ctrl+q",
    "super+q",
    "ctrl+shift+c",
    "ctrl+pageUp",
    "ctrl+pageDown",
  ]) {
    assert.doesNotThrow(
      () => new SidebarController({ toggleKey: good }),
      `expected acceptance for ${JSON.stringify(good)}`,
    );
  }
});

test("protected native Escape, q/Q, and Ctrl+C chords cannot be reserved toggles", () => {
  for (const bad of [
    "escape",
    "ESCAPE",
    "esc",
    "ESC",
    "q",
    "Q",
    "shift+q",
    "SHIFT+Q",
    "ctrl+c",
    "CTRL+C",
    "Ctrl+C",
    "ctrl+[",
    "CTRL+[",
    "Ctrl+[",
  ]) {
    assert.throws(
      () => new SidebarController({ toggleKey: bad }),
      /toggleKey conflicts with native/,
      `expected native key protection for ${JSON.stringify(bad)}`,
    );
  }
});

test("Ctrl+[ cannot alias Escape, which stays native in both Kitty protocol states", () => {
  const previous = isKittyProtocolActive();
  try {
    for (const kittyActive of [false, true]) {
      setKittyProtocolActive(kittyActive);
      assert.equal(matchesKey(ESC, "ctrl+["), true);
      assert.throws(
        () => new SidebarController({ toggleKey: kittyActive ? "CTRL+[" : "ctrl+[" }),
        /toggleKey conflicts with native Escape/,
      );
      const harness = makeController({ initialVisible: false });
      harness.send(ESC);
      assert.deepEqual(harness.actions, [{ type: "forward", data: ESC }]);
      assert.equal(harness.controller.visible, false);
      assert.equal(harness.controller.focus, "main");
    }
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("modified Escape toggle chords fail construction", () => {
  for (const base of ["escape", "esc"]) {
    for (const modifier of ["ctrl", "shift", "alt", "super"]) {
      assert.throws(
        () => new SidebarController({ toggleKey: `${modifier}+${base}` }),
        /toggleKey/,
      );
    }
  }
});

test("unmatchable modified function and unsupported special-key toggles fail construction", () => {
  const modifiers = ["ctrl", "shift", "alt", "super"];
  for (let mask = 1; mask < 16; mask += 1) {
    const selected = modifiers.filter((_, index) => (mask & (1 << index)) !== 0);
    const prefix = selected.join("+");
    for (let number = 1; number <= 12; number += 1) {
      assert.throws(
        () => new SidebarController({ toggleKey: `${prefix}+f${number}` }),
        /toggleKey/,
      );
    }
    assert.throws(
      () => new SidebarController({ toggleKey: `${prefix}+clear` }),
      /toggleKey/,
    );
  }
  for (const key of ["a", "shift+a", "left", "up", "enter", "return", "space", "ctrl+enter", "ctrl+space", "clear", "delete"]) {
    assert.throws(() => new SidebarController({ toggleKey: key }), /toggleKey/);
  }
});

test("modified page-navigation toggle matches pinned packets", () => {
  const cases = [
    ["ctrl+pageDown", "\x1b[6^"],
  ] as const;
  for (const [toggleKey, packet] of cases) {
    const harness = makeController({ toggleKey, initialVisible: false });
    harness.send(packet);
    assert.equal(harness.controller.visible, true, `${toggleKey} legacy packet should toggle`);
    assert.equal(harness.controller.focus, "sidebar");
    assert.deepEqual(harness.actions, [{ type: "visibility", visible: true }]);
  }

  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const kitty = makeController({ toggleKey: "ctrl+pageDown", initialVisible: false });
    kitty.send("\x1b[57422;5u"); // Kitty Ctrl+PageDown, real pinned matcher
    assert.equal(kitty.controller.visible, true);
    assert.deepEqual(kitty.actions, [{ type: "visibility", visible: true }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("reserved Kitty toggle repeats/releases are consumed across focus changes", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const { controller, actions } = makeController({ initialVisible: false });
    controller.handleInput(KITTY_ALT_LEFT_PRESS); // main -> visible sidebar
    assert.equal(controller.visible, true);
    assert.equal(controller.focus, "sidebar");
    controller.handleInput(KITTY_ALT_LEFT_REPEAT);
    controller.handleInput(KITTY_ALT_LEFT_RELEASE);
    assert.equal(controller.visible, true); // one press, one transition
    assert.deepEqual(actions, [{ type: "visibility", visible: true }]);

    controller.handleInput(KITTY_ALT_LEFT_PRESS); // sidebar -> hidden main
    assert.equal(controller.visible, false);
    controller.handleInput(KITTY_ALT_LEFT_REPEAT);
    controller.handleInput(KITTY_ALT_LEFT_RELEASE);
    assert.equal(controller.visible, false);
    assert.deepEqual(actions, [
      { type: "visibility", visible: true },
      { type: "visibility", visible: false },
    ]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

// ---------------------------------------------------------------------------
// Main focus: data forwarded unchanged except the reserved toggle
// ---------------------------------------------------------------------------

test("reserved Kitty toggle repeats/releases are consumed in form and quit confirmation", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const form = formWith();
    form.send(KITTY_ALT_LEFT_PRESS);
    assert.equal(form.controller.visible, false);
    form.send(KITTY_ALT_LEFT_REPEAT);
    form.send(KITTY_ALT_LEFT_RELEASE);
    assert.equal(form.controller.visible, false);
    assert.deepEqual(form.focusedActions(), [{ type: "visibility", visible: false }]);

    const confirmation = makeRoster(["alive"]);
    confirmation.send("q");
    assert.equal(confirmation.controller.focus, "confirm");
    confirmation.send(KITTY_ALT_LEFT_PRESS);
    assert.equal(confirmation.controller.visible, false);
    confirmation.send(KITTY_ALT_LEFT_REPEAT);
    confirmation.send(KITTY_ALT_LEFT_RELEASE);
    assert.equal(confirmation.controller.visible, false);
    assert.deepEqual(confirmation.focusedActions(), [
      { type: "visibility", visible: false },
    ]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("main focus forwards ordinary press, repeat and release packets unchanged", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeController({ initialVisible: false });
    harness.controller.updateItems([makeItem({ id: "a" })]);
    harness.controller.select("a"); // backend-driven: focus main, no action
    const chunks = [
      "q",
      "Q",
      "\x03",
      ESC,
      KITTY_Q_REPEAT,
      KITTY_Q_RELEASE,
      KITTY_ESCAPE_REPEAT,
      KITTY_ESCAPE_RELEASE,
      KITTY_CTRL_C_REPEAT,
      KITTY_CTRL_C_RELEASE,
      "\x1b[200~-p hello\nworld\x1b[201~",
      "\x1b[27u",
      DELETE, // Delete is native in Main focus, not the sidebar removal action.
    ];
    for (const chunk of chunks) {
      harness.send(chunk);
    }
    assert.deepEqual(
      harness.actions.map((action) => (action.type === "forward" ? action.data : action.type)),
      chunks,
    );
    // No visibility or navigation side effects: pure forwarding.
    assert.deepEqual(
      harness.actions.filter((action) => action.type !== "forward"),
      [],
    );
    assert.equal(harness.controller.visible, false);
    assert.equal(harness.controller.focus, "main");
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("native Ctrl+C in main focus never quits the whole host", () => {
  const harness = makeController({ initialVisible: false });
  harness.send("\x03");
  assert.deepEqual(harness.actions, [{ type: "forward", data: "\x03" }]);
  assert.equal(harness.controller.focus, "main");
});

// ---------------------------------------------------------------------------
// Roster selection: id-based continuity, reorder, vanishing rows
// ---------------------------------------------------------------------------

test("sidebar Delete visibly requests removal using the selected row's stable id", () => {
  const id = "owned:opaque/session-42";
  const harness = makeRoster([id]);
  harness.controller.updateItems([
    makeItem({ id, label: "friendly label", lifecycle: "exited", hasLiveProcess: false }),
  ]);
  harness.send(DOWN); // New session -> Quit host
  harness.send(DOWN); // wrap to the exited row
  assert.equal(harness.controller.selectedId, id);
  const texts = rosterView(harness.controller, 40, 10).texts;
  assert.ok(texts.join(" ").includes("d stop/remove"), JSON.stringify(texts));
  harness.send(DELETE);
  assert.deepEqual(harness.focusedActions(), [{ type: "remove", id }]);
  assert.equal(harness.controller.selectedId, id, "the UI waits for the backend roster confirmation");
  assert.equal(harness.controller.focus, "sidebar");
});

test("Delete is not accepted as a remapped host shortcut", () => {
  assert.throws(() => new SidebarController({ toggleKey: "delete" }), /toggleKey/);
});

test("arrows select roster items then Saved conversations, New session, and Quit host with wrap", () => {
  const harness = makeRoster(["a", "b"]);
  harness.send(DOWN); // New session -> Quit host
  assert.equal(harness.controller.selectedId, undefined); // on quit row
  harness.send(DOWN); // wraps to the first roster item
  assert.deepEqual(harness.controller.selectedId, "a");
  harness.send(DOWN);
  assert.deepEqual(harness.controller.selectedId, "b");
  harness.send(DOWN); // b -> Saved conversations
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(DOWN); // -> New session
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(DOWN); // -> Quit host
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(DOWN); // wraps past Quit to the first item again
  assert.deepEqual(harness.controller.selectedId, "a");
  harness.send(UP); // a wraps backwards to Quit host
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(UP); // Quit -> New session
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(UP); // New -> Saved conversations
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(UP); // Saved -> b
  assert.deepEqual(harness.controller.selectedId, "b");
});

test("enter on a roster item emits select(id), focuses main, sidebar stays visible", () => {
  const harness = makeRoster(["a", "b"]);
  harness.send(DOWN); // New -> Quit
  harness.send(DOWN); // -> a
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }]);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.visible, true); // still composited
  assert.ok(!rosterView(harness.controller, 40, 10).texts.join(" ").includes("d stop/remove"));
  // Typing now goes to the main instance, not any other row.
  harness.send("pwd");
  assert.deepEqual(harness.sinceActions(), [
    { type: "select", id: "a" },
    { type: "forward", data: "pwd" },
  ]);
});

test("selection follows ids across metadata updates and reorders", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.select("b");
  assert.deepEqual(harness.controller.selectedId, "b");
  harness.controller.updateItems([
    makeItem({ id: "a", busy: true }),
    makeItem({ id: "b", busy: true, activity: ["working"] }),
  ]);
  harness.controller.updateItems([
    makeItem({ id: "b", busy: false }),
    makeItem({ id: "a", busy: false }),
  ]);
  assert.deepEqual(harness.controller.selectedId, "b");
});

test("roster items are copied: later mutation of the source never leaks in", () => {
  const mutable = {
    id: "a",
    label: "safe",
    workspace: "/ws/a",
    agentDir: "/agents/a",
    lifecycle: "alive" as const,
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: ["fine"] as string[],
  };
  const harness = makeController();
  harness.controller.updateItems([mutable]);
  mutable.label = "\x1b]0;evil\x07poison";
  mutable.activity.push("\x1b[31mred");
  // Tall enough for the complete 5-row card above the highlighted New row.
  const texts = rosterView(harness.controller, 40, 14).texts;
  assert.ok(texts.some((line) => line.includes("safe")));
  assert.ok(texts.every((text) => !text.includes("poison")));
  assert.ok(texts.every((text) => !text.includes("evil")));
  assert.ok(texts.every((text) => !text.includes("red")));
});

test("hidden vanished selection reopens the picker until explicit selection", () => {
  const harness = makeController({ initialVisible: false });
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "b" })]);
  harness.controller.select("a");
  harness.send("x");
  assert.deepEqual(harness.actions, [{ type: "forward", data: "x" }]);
  harness.controller.updateItems([makeItem({ id: "b" })]);
  assert.equal(harness.controller.selectedId, undefined);
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
  assert.deepEqual(harness.actions.at(-1), { type: "visibility", visible: true });
  assert.ok(rosterView(harness.controller).texts.some((line) => line.includes("label-b")));
  const before = harness.actions.length;
  harness.send("x"); // visible picker consumes input; never forwards to a replacement row
  assert.equal(harness.actions.length, before);
  harness.send(ESC); // escape deliberately restores native main focus
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.actions.length, before + 1); // only visibility, not input forwarding
  assert.equal(harness.actions.at(-1)?.type, "visibility");
  harness.send(ALT_LEFT_LEGACY); // reopen the picker before selecting a target
  harness.send(DOWN); // cleared selection -> first row
  assert.deepEqual(harness.controller.selectedId, "b");
  harness.send(ENTER); // hiding forgot the drawn roster: nothing activates unseen
  assert.equal(harness.controller.focus, "sidebar");
  assert.ok(!harness.focusedActions().some((action) => action.type === "select"));
  rosterView(harness.controller); // the reopened picker is drawn
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().slice(-1), [{ type: "select", id: "b" }]);
  assert.equal(harness.controller.focus, "main");
  harness.send("x");
  assert.deepEqual(harness.actions.at(-1), { type: "forward", data: "x" });
});

test("backend select() works before the row arrives (initial spawn) and applies later", () => {
  const harness = makeController({ initialVisible: false });
  harness.controller.select("spawn-1");
  assert.equal(harness.controller.selectedId, undefined);
  harness.controller.updateItems([
    makeItem({ id: "other" }),
    makeItem({ id: "spawn-1" }),
  ]);
  assert.deepEqual(harness.controller.selectedId, "spawn-1");
});

// ---------------------------------------------------------------------------
// Quit: explicit action only, confirmation for starting/alive or host-owned rows
// ---------------------------------------------------------------------------

test("exited rows without an owned process can quit immediately", () => {
  const harness = makeRoster(["done"]);
  harness.controller.updateItems([
    makeItem({
      id: "done",
      lifecycle: "exited",
      exitCode: 0,
      busy: null,
      pendingInput: null,
    }),
  ]);
  harness.send(DOWN); // New session -> Quit host
  assert.equal(harness.controller.selectedId, undefined); // on the quit row
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "quit" }]);
  assert.equal(harness.controller.focus, "sidebar");
});

test("owned error process requires confirmation until backend reports exit", () => {
  const harness = makeRoster(["broken"]);
  harness.controller.updateItems([
    makeItem({
      id: "broken",
      lifecycle: "error",
      busy: null,
      pendingInput: null,
      hasLiveProcess: true,
    }),
  ]);
  assert.equal(harness.controller.items[0]?.hasLiveProcess, true);
  harness.send(DOWN); // New session -> Quit host
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "confirm");
  assert.deepEqual(harness.focusedActions(), []);
  harness.send("n"); // cancel leaves the owned child and row snapshot untouched
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focusedActions(), []);
  assert.equal(harness.controller.items[0]?.hasLiveProcess, true);

  harness.controller.updateItems([
    makeItem({
      id: "broken",
      lifecycle: "error",
      busy: null,
      pendingInput: null,
      hasLiveProcess: false,
    }),
  ]);
  assert.equal(harness.controller.items[0]?.hasLiveProcess, false);
  rosterView(harness.controller); // the confirmation had replaced the roster
  harness.send(ENTER); // Error without an owned process needs no confirmation.
  assert.deepEqual(harness.focusedActions(), [{ type: "quit" }]);
});

test("starting and alive rows require confirmation even when idle and no handle is reported", () => {
  for (const lifecycle of ["starting", "alive"] as const) {
    const harness = makeRoster([lifecycle]);
    harness.controller.updateItems([
      makeItem({
        id: lifecycle,
        lifecycle,
        busy: false,
        hasLiveProcess: false,
      }),
    ]);
    harness.send(DOWN); // New session -> Quit host
    harness.send(ENTER);
    assert.equal(harness.controller.focus, "confirm", lifecycle);
    assert.deepEqual(harness.focusedActions(), []);
  }
});

test("menu q is the same explicit Quit action, confirmation included", () => {
  const harness = makeRoster(["a"]);
  harness.send("q");
  assert.deepEqual(harness.focusedActions(), []);
  assert.equal(harness.controller.focus, "confirm");
  harness.send("n"); // cancel -> back to the roster
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focusedActions(), []);
  harness.send("q");
  assert.equal(harness.controller.focus, "confirm");
  harness.send("y");
  assert.deepEqual(harness.focusedActions(), [{ type: "quit" }]);
});

test("quit confirmation: enter/y emits quit, n cancels, none before confirm", () => {
  const harness = makeRoster(["starting-one"]);
  harness.controller.updateItems([
    makeItem({ id: "starting-one", lifecycle: "starting", busy: null }),
  ]);
  harness.send(DOWN); // New -> Quit
  harness.send(ENTER); // opens confirmation only
  assert.equal(harness.controller.focus, "confirm");
  assert.deepEqual(harness.focusedActions(), []);
  const texts = rosterView(harness.controller).texts;
  assert.ok(texts.some((line) => line.includes("Quit host?")));
  assert.ok(texts.some((line) => line.includes("1 session(s)")));
  harness.send("n");
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focusedActions(), []);
  // The keyboard selection stayed on the Quit row: q re-opens the same
  // explicit confirmation.
  harness.send("q");
  assert.equal(harness.controller.focus, "confirm");
  harness.send("y");
  assert.deepEqual(harness.focusedActions(), [{ type: "quit" }]);
  assert.equal(harness.controller.focus, "sidebar");
});

test("confirm Escape cancels and hides the sidebar (restores main)", () => {
  const harness = makeRoster(["a"]);
  harness.send("q"); // confirmation opens (an alive row exists)
  assert.equal(harness.controller.focus, "confirm");
  harness.send(ESC);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.visible, false);
  assert.deepEqual(harness.focusedActions(), [{ type: "visibility", visible: false }]);
});

test("confirm ignores Kitty key releases; native Ctrl+C there quits nothing", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeRoster(["a"]);
    harness.send("q");
    assert.equal(harness.controller.focus, "confirm");
    harness.send(KITTY_Q_RELEASE); // release of y must not confirm
    assert.deepEqual(harness.focusedActions(), []);
    assert.equal(harness.controller.focus, "confirm");
    harness.send("\x03"); // native Ctrl+C must not all-host-quit
    assert.deepEqual(harness.focusedActions(), []);
    harness.send(KITTY_ENTER); // kitty enter confirms
    assert.deepEqual(harness.focusedActions(), [{ type: "quit" }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

// ---------------------------------------------------------------------------
// Stop/remove: d control with complete-idle warning and explicit confirmation
// ---------------------------------------------------------------------------

/** A live, host-owned row that is completely idle unless overridden. */
function liveItem(id: string, overrides: Partial<SidebarItem> = {}): SidebarItem {
  return makeItem({
    id,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    backgroundTasks: 0,
    backgroundShells: 0,
    hasLiveProcess: true,
    ...overrides,
  });
}

test("d on a positively idle owned session requests stop-remove without confirmation", () => {
  const id = "idle-live";
  const harness = makeRoster([id]);
  harness.controller.updateItems([liveItem(id)]);
  harness.controller.select(id);
  rosterView(harness.controller, 40, 10); // the card is drawn before acting
  harness.send("d");
  assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id, confirmed: false }]);
  assert.equal(harness.controller.focus, "sidebar", "observed complete idleness needs no confirmation");
});

test("d on an active or unknown owned session asks for explicit stop confirmation", () => {
  const cases: Array<[string, Partial<SidebarItem>]> = [
    ["busy turn", { busy: true }],
    ["pending question", { pendingInput: true }],
    ["modal input surface", { inputSurface: true }],
    ["background tasks", { backgroundTasks: 1 }],
    ["background shells", { backgroundShells: 1 }],
    ["busy unknown", { busy: null }],
    ["pending input unknown", { pendingInput: null }],
    ["background counts unknown", { backgroundTasks: null, backgroundShells: null }],
  ];
  for (const [name, overrides] of cases) {
    const id = `live-${name.replace(/\s+/g, "-")}`;
    const harness = makeRoster([id]);
    harness.controller.updateItems([liveItem(id, overrides)]);
    harness.controller.select(id);
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm", name);
    assert.deepEqual(harness.focusedActions(), [], `${name}: no stop before confirmation`);
    const texts = rosterView(harness.controller, 40, 10).texts;
    assert.ok(texts.some((line) => line.includes("Stop session?")), name);
    assert.ok(
      texts.map((line) => line.trimEnd()).join(" ").includes("active turn, questions, background tasks, and shells"),
      `${name}: the warning names every stopped category`,
    );
  }
});

test("stop confirmation: enter/y confirm the frozen target; n/escape cancel without hiding", () => {
  // y confirms.
  {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    rosterView(harness.controller, 40, 10); // the dialog must be displayed before a stop
    harness.send("y");
    assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: true }]);
    assert.equal(harness.controller.focus, "sidebar");
  }
  // Enter confirms.
  {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    rosterView(harness.controller, 40, 10); // the dialog must be displayed before a stop
    harness.send(ENTER);
    assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: true }]);
    assert.equal(harness.controller.focus, "sidebar");
  }
  // n cancels: no lifecycle action, roster and selection preserved.
  {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    harness.send("n");
    assert.deepEqual(harness.focusedActions(), []);
    assert.equal(harness.controller.focus, "sidebar");
    assert.equal(harness.controller.visible, true, "cancel keeps the pane visible");
    assert.equal(harness.controller.selectedId, "a", "the highlighted row is preserved");
  }
  // Escape cancels the same way and sends no native input.
  {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    harness.send(ESC);
    assert.deepEqual(harness.focusedActions(), []);
    assert.ok(
      !harness.sinceActions().some((action) => action.type === "forward"),
      "no native input on cancel",
    );
    assert.equal(harness.controller.focus, "sidebar");
    assert.equal(harness.controller.visible, true);
  }
});

test("stop confirmation ignores held repeats and releases", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    rosterView(harness.controller, 40, 10); // the dialog must be displayed before a stop
    harness.send("\x1b[13;1:2u"); // Enter repeat
    harness.send("\x1b[13;1:3u"); // Enter release
    harness.send("\x1b[121;1:2u"); // y repeat
    harness.send("\x1b[121;1:3u"); // y release
    assert.deepEqual(harness.focusedActions(), [], "repeats/releases never confirm");
    assert.equal(harness.controller.focus, "confirm");
    harness.send("\x1b[121u"); // a deliberate initial Kitty y press confirms
    assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: true }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("held d and Delete repeats never stop an idle owned row", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    // A d repeat on a completely idle row never requests a stop.
    {
      const harness = makeRoster(["a"]);
      harness.controller.updateItems([liveItem("a")]);
      harness.controller.select("a");
      rosterView(harness.controller, 40, 10);
      harness.send("\x1b[100;1:2u"); // d repeat
      assert.deepEqual(harness.focusedActions(), [], "d repeat never stops");
      assert.equal(harness.controller.focus, "sidebar");
      harness.send("d"); // a deliberate initial press requests the stop
      assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: false }]);
    }
    // A Delete repeat on a completely idle row never requests a stop.
    {
      const harness = makeRoster(["a"]);
      harness.controller.updateItems([liveItem("a")]);
      harness.controller.select("a");
      rosterView(harness.controller, 40, 10);
      harness.send("\x1b[127;1:2u"); // Delete repeat
      assert.deepEqual(harness.focusedActions(), [], "Delete repeat never stops");
      assert.equal(harness.controller.focus, "sidebar");
      harness.send(DELETE); // a deliberate initial press requests the stop
      assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: false }]);
    }
    // A repeat arriving after a MAIN-to-sidebar focus transfer never acts.
    {
      const harness = makeController({ initialVisible: false });
      harness.controller.updateItems([liveItem("a")]);
      harness.send(ALT_LEFT_LEGACY); // show -> focus sidebar
      harness.controller.select("a");
      rosterView(harness.controller, 40, 10);
      harness.send(ENTER); // select a -> MAIN focus, sidebar stays visible
      assert.equal(harness.controller.focus, "main");
      harness.baseline = harness.actions.length;
      harness.send("\x1b[100;1:2u"); // the held d repeat is native in MAIN
      assert.deepEqual(harness.sinceActions(), [{ type: "forward", data: "\x1b[100;1:2u" }]);
      harness.send(ALT_LEFT_LEGACY); // visible + MAIN: focus the sidebar only
      assert.equal(harness.controller.focus, "sidebar");
      harness.send("\x1b[100;1:2u"); // the held repeat now lands in the sidebar
      assert.deepEqual(harness.focusedActions(), [], "repeat after focus transfer never stops");
      assert.equal(harness.controller.focus, "sidebar");
      harness.send("d"); // a deliberate initial press requests the stop
      assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: false }]);
    }
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("stop confirmation refuses to confirm until the complete warning is displayed", () => {
  // A long unbroken title truncates instead of hiding the warning.
  {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true, label: "T".repeat(60) })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    const texts = rosterView(harness.controller, 40, 10).texts;
    assert.ok(texts.some((line) => line.includes("Stop session?")), JSON.stringify(texts));
    assert.ok(
      texts.map((line) => line.trimEnd()).join(" ").includes("active turn, questions, background tasks, and shells"),
      "the warning stays visible under a truncated title",
    );
    assert.ok(!texts.some((line) => line.includes("too small")));
    harness.send(ENTER);
    assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: true }]);
  }
  // Resize below the dialog's needs: no confirmed stop until it is visible again.
  {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    const tooSmall = harness.controller.render(32, 5);
    assert.ok(tooSmall.lines.some((line) => line.includes("too small")));
    harness.send(ENTER);
    harness.send("y");
    assert.deepEqual(harness.focusedActions(), [], "no confirmed stop while the warning is hidden");
    assert.equal(harness.controller.focus, "confirm", "the dialog stays open");
    rosterView(harness.controller, 40, 10); // the complete dialog is visible again
    harness.send(ENTER);
    assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: true }]);
  }
  // Cancellation stays available while the warning is hidden.
  {
    const harness = makeRoster(["a"]);
    harness.controller.updateItems([liveItem("a", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    const tooSmall = harness.controller.render(32, 5);
    assert.ok(tooSmall.lines.some((line) => line.includes("too small")));
    harness.send("n");
    assert.deepEqual(harness.focusedActions(), []);
    assert.equal(harness.controller.focus, "sidebar", "cancel stays available while hidden");
    assert.equal(harness.controller.visible, true);
  }
});

test("stop confirmation targets the frozen id, never a later highlighted row", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.updateItems([liveItem("a", { busy: true }), liveItem("b", { busy: true })]);
  harness.controller.select("a");
  rosterView(harness.controller, 40, 20);
  harness.send("d");
  assert.equal(harness.controller.focus, "confirm");
  harness.controller.select("b"); // a later highlight never retargets
  rosterView(harness.controller, 40, 20); // the dialog must be displayed before a stop
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "a", confirmed: true }]);
});

test("stop confirmation refuses a vanished or no-longer-live target instead of a sibling", () => {
  // The target leaves the roster while the confirmation is open.
  {
    const harness = makeRoster(["a", "b"]);
    harness.controller.updateItems([liveItem("a", { busy: true }), liveItem("b", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 20);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    harness.controller.updateItems([liveItem("b", { busy: true })]); // a is gone
    rosterView(harness.controller, 40, 20); // the dialog must be displayed before a stop
    harness.send(ENTER);
    assert.deepEqual(harness.focusedActions(), [], "no stop for a vanished target");
    assert.equal(harness.controller.focus, "sidebar");
    assert.ok(
      rosterView(harness.controller, 40, 20).texts.some((line) => line.includes("no longer exists")),
    );
  }
  // The target exits while the confirmation is open.
  {
    const harness = makeRoster(["a", "b"]);
    harness.controller.updateItems([liveItem("a", { busy: true }), liveItem("b", { busy: true })]);
    harness.controller.select("a");
    rosterView(harness.controller, 40, 20);
    harness.send("d");
    assert.equal(harness.controller.focus, "confirm");
    harness.controller.updateItems([
      makeItem({ id: "a", lifecycle: "exited", exitCode: 0, hasLiveProcess: false }),
      liveItem("b", { busy: true }),
    ]);
    rosterView(harness.controller, 40, 20); // the dialog must be displayed before a stop
    harness.send(ENTER);
    assert.deepEqual(harness.focusedActions(), [], "no stop for a no-longer-live target");
    assert.equal(harness.controller.focus, "sidebar");
    assert.ok(
      rosterView(harness.controller, 40, 20).texts.some((line) => line.includes("no longer live")),
    );
  }
});

test("d is native input in MAIN focus and removes an exited row immediately", () => {
  // MAIN focus: d is ordinary native input.
  const main = makeController({ initialVisible: false });
  main.send("d");
  assert.deepEqual(main.actions, [{ type: "forward", data: "d" }]);

  // Exited row: d and Delete emit the existing remove action immediately.
  const id = "done";
  const harness = makeRoster([id]);
  harness.controller.updateItems([
    makeItem({ id, lifecycle: "exited", exitCode: 0, hasLiveProcess: false }),
  ]);
  harness.controller.select(id);
  rosterView(harness.controller, 40, 10);
  harness.send("d");
  assert.deepEqual(harness.focusedActions(), [{ type: "remove", id }]);
  assert.equal(harness.controller.focus, "sidebar");
});

test("d refuses with a bounded notice when no process is owned and exit is unconfirmed", () => {
  // Settled error rows (no live process) request the same deliberate removal
  // as exited rows; see session-host-error-row-ui.test.ts.
  for (const lifecycle of ["starting", "alive"] as const) {
    const harness = makeRoster([lifecycle]);
    harness.controller.updateItems([
      makeItem({ id: lifecycle, lifecycle, hasLiveProcess: false }),
    ]);
    harness.controller.select(lifecycle);
    rosterView(harness.controller, 40, 10);
    harness.send("d");
    assert.equal(harness.controller.focus, "sidebar", lifecycle);
    assert.deepEqual(harness.focusedActions(), [], `${lifecycle}: no stop or remove`);
    assert.ok(
      rosterView(harness.controller, 40, 10).texts.some((line) => line.includes("No owned process to stop")),
      lifecycle,
    );
  }
});

test("d on a non-session row is a bounded notice, never an action", () => {
  const harness = makeRoster(["a"]);
  // The default highlight is the New session row.
  harness.send("d");
  assert.deepEqual(harness.focusedActions(), []);
  assert.equal(harness.controller.focus, "sidebar");
  assert.ok(
    rosterView(harness.controller, 40, 10).texts.some((line) => line.includes("Select a session row to stop or remove")),
  );
});

test("hints advertise d stop/remove; Delete stays an alias", () => {
  const harness = makeRoster(["a"]);
  const texts = rosterView(harness.controller, 40, 10).texts;
  assert.ok(texts.join(" ").includes("d stop/remove"), JSON.stringify(texts));
  assert.ok(!texts.join(" ").includes("remove exited"));

  // Delete is the accessible alias: the same confirmation flow as d.
  harness.controller.updateItems([liveItem("a", { busy: true })]);
  harness.controller.select("a");
  rosterView(harness.controller, 40, 10);
  harness.send(DELETE);
  assert.equal(harness.controller.focus, "confirm");
  assert.deepEqual(harness.focusedActions(), []);
  harness.send("n");

});

test("reserved toggle still hides from stop confirmation and resets the frozen target", () => {
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([liveItem("a", { busy: true })]);
  harness.controller.select("a");
  rosterView(harness.controller, 40, 10);
  harness.send("d");
  assert.equal(harness.controller.focus, "confirm");
  harness.send(ALT_LEFT_LEGACY); // the reserved toggle hides the pane
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.focus, "main");
  harness.send(ALT_LEFT_LEGACY); // reopen: the roster is back, no pending stop
  assert.equal(harness.controller.focus, "sidebar");
  const texts = rosterView(harness.controller, 40, 10).texts;
  assert.ok(texts.some((line) => line.includes("Sessions (1)")));
  harness.baseline = harness.actions.length;
  harness.send(ENTER); // the redrawn roster: Enter selects, never stops
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }]);
});

// ---------------------------------------------------------------------------
// Hiding/switching never stops an instance
// ---------------------------------------------------------------------------

test("hide/show/switch emit only visibility; no stop/quit on hide or switch", () => {
  const harness = makeRoster(["a"]);
  // Navigate to a and drive main, then hide and show again.
  harness.send(DOWN);
  harness.send(DOWN); // -> a
  harness.send(ENTER); // select a, focus main, sidebar still visible
  assert.equal(harness.controller.visible, true);
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }]);
  harness.send(ALT_LEFT_LEGACY); // visible + main: first press only focuses the sidebar
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }]);
  harness.send(ALT_LEFT_LEGACY); // sidebar focused: second press hides
  assert.deepEqual(harness.focusedActions(), [
    { type: "select", id: "a" },
    { type: "visibility", visible: false },
  ]);
  harness.send(ALT_LEFT_LEGACY); // toggle shows again -> sidebar focus
  assert.deepEqual(harness.focusedActions(), [
    { type: "select", id: "a" },
    { type: "visibility", visible: false },
    { type: "visibility", visible: true },
  ]);
  assert.equal(harness.controller.focus, "sidebar");
  // Instance lifecycle was never touched: no quit/stop action exists.
  assert.deepEqual(
    harness.focusedActions().filter((action) => action.type === "quit"),
    [],
  );
});

test("sidebar Escape hides with a single visibility action and keeps selection", () => {
  const harness = makeRoster(["a"]);
  harness.send(DOWN);
  harness.send(DOWN); // -> a
  harness.send(ESC); // hide without selecting
  assert.equal(harness.controller.visible, false);
  assert.deepEqual(harness.focusedActions(), [{ type: "visibility", visible: false }]);
  assert.deepEqual(harness.controller.selectedId, "a"); // selection preserved; only focus moved
  assert.equal(harness.controller.focus, "main");
  // Reopening restores sidebar focus with the same roster state.
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
});

// ---------------------------------------------------------------------------
// New session form
// ---------------------------------------------------------------------------

test("New session has only an explicit workspace field and creates without a manual label", () => {
  const harness = formWith();
  const first = harness.controller.render(40, 10);
  const texts = assertPaneSafe(first.lines, 40, 10);
  assert.ok(texts[0].includes("New session"));
  assert.ok(texts.some((line) => line.includes("Workspace:")));
  assert.ok(!texts.some((line) => /Label:|Profile:/.test(line)));
  assert.ok(texts.some((line) => line.includes("Host:")), "the New form carries its one Host line");
  assert.equal(first.cursor?.row, 3, "the New form's Host row sits above the native Editor's completion viewport and path cursor");
  assert.equal(first.cursor?.column, 13);
  assert.equal(texts[first.cursor!.row]?.slice(0, 13), "> Workspace: ",
    "the label is beside the actual empty insertion row");
  assert.equal(texts[first.cursor!.row]?.slice(13).trim(), "",
    "the labelled native body contains no workspace draft yet");
  harness.send("/workspace");
  harness.send(ENTER); // workspace submits directly
  assert.deepEqual(harness.focusedActions(), [
    { type: "create", requestId: 1, workspace: "/workspace" },
  ]);
  assert.ok(!("profile" in createOf(harness.focusedActions()[0])));
  assert.ok(!("label" in createOf(harness.focusedActions()[0])));
});

test("create is single-shot, completion activates the new row, ids increase", () => {
  const harness = formWith();
  harness.send("/workspace");
  harness.send(ENTER);
  harness.send(ENTER); // duplicate Enter is ignored while starting
  assert.deepEqual(harness.focusedActions(), [
    { type: "create", requestId: 1, workspace: "/workspace" },
  ]);
  assert.equal(harness.controller.focus, "form");
  assert.ok(assertPaneSafe(harness.controller.render(40, 8).lines, 40, 8).some((line) => line.includes("Starting (request 1)")));
  harness.controller.completeCreate(1, "spawned");
  assert.equal(harness.controller.focus, "main", "a successful New activates the created child");
  assert.deepEqual(harness.focusedActions().at(-1), { type: "select", id: "spawned" });
  assert.equal(harness.controller.selectedId, undefined);
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "spawned" })]);
  assert.equal(harness.controller.selectedId, "spawned");
  harness.send(ALT_LEFT_LEGACY); // return to the visible roster before navigating again
  rosterView(harness.controller, 40, 20); // the updated roster is drawn before Enter
  harness.send(DOWN); // spawned -> Saved conversations
  harness.send(DOWN); // -> New session
  harness.send(ENTER);
  harness.send("/next");
  harness.send(ENTER);
  const creates = harness.focusedActions().filter((action) => action.type === "create");
  assert.deepEqual(creates.map((create) => create.type === "create" ? create.requestId : -1), [1, 2]);
});

test("a suggested workspace stays editable but is the only New form value", () => {
  const harness = formWith({ options: { initialWorkspace: "/tmp/proj one" } });
  harness.send("\x1b[4~"); // End; the suggested path is an editable draft
  harness.send("/child");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "create", requestId: 1, workspace: "/tmp/proj one/child",
  });
});

test("workspace is required and an empty submission can be corrected", () => {
  const harness = formWith();
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  assert.ok(assertPaneSafe(harness.controller.render(44, 10).lines, 44, 10).some((line) => line.includes("Workspace is required")));
  assert.ok(!harness.focusedActions().some((action) => action.type === "create"));
  harness.send("/workspace");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "create", requestId: 1, workspace: "/workspace",
  });
});

test("Edit starts with a separate empty replacement field and emits the observed tuple without selecting", () => {
  const tuple = { sessionId: "session-123", epoch: 7, name: "Observed title" };
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([makeItem({ id: "a", nativeSession: tuple, label: "stale row label" })]);
  const rosterText = assertPaneSafe(harness.controller.renderRoster(48, 14).lines, 48, 14).join("\n");
  assert.ok(rosterText.includes("Observed title"));
  assert.ok(!rosterText.includes("stale row label"), "validated native metadata is authoritative over an old display label");
  harness.send(UP); // New -> Saved conversations
  harness.send(UP); // -> the existing row, not a picker entry
  harness.send("e");
  const edit = harness.focusedActions().at(-1);
  assert.deepEqual(edit, { type: "edit", id: "a", nativeSession: tuple });
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.selectedId, "a");
  assert.equal(harness.controller.openEdit({ id: "a", nativeSession: tuple, currentName: tuple.name }), true);
  const text = assertPaneSafe(harness.controller.render(48, 10).lines, 48, 10);
  assert.ok(text.some((line) => line.includes("Observed title")));
  assert.ok(text.some((line) => line.includes("New name:")));
  harness.send("Replacement");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "rename", requestId: 1, id: "a", expectedSessionId: "session-123",
    expectedSessionEpoch: 7, name: "Replacement",
  });
  assert.equal(harness.controller.selectedId, "a");
  assert.equal(harness.focusedActions().some((action) => action.type === "select"), false);
});

test("path limit: the 2049th character is an explicit error, never truncated", () => {
  const harness = formWith();
  for (let i = 0; i < 2048; i += 1) {
    harness.controller.handleInput("p");
  }
  harness.controller.handleInput("p"); // the 2049th
  const texts = assertPaneSafe(harness.controller.render(48, 24).lines, 48, 24);
  assert.ok(texts.some((line) => line.includes("Field value exceeds its limit")));
  harness.send(ENTER); // submit
  const create = createOf(harness.focusedActions().at(-1));
  assert.equal(create.workspace, "p".repeat(2048));
});





test("Unicode workspace editing removes whole graphemes and never splits them", () => {
  const harness = formWith();
  harness.controller.handleInput("héllo👨‍👩‍👧"); // ZWJ family grapheme at the end
  harness.controller.handleInput("\x7f"); // backspace: whole grapheme
  harness.send(ENTER);
  assert.equal(createOf(harness.focusedActions().at(-1)).workspace, "héllo");
});

test("bounded single-line paste; multi-line workspace paste is cleaned to one line", () => {
  const harness = formWith();
  harness.controller.handleInput("\x1b[200~/tmp/a\nb\r\nc\x1b[201~");
  harness.send(ENTER);
  assert.equal(createOf(harness.focusedActions().at(-1)).workspace, "/tmp/abc");
});

test("malicious form pastes are sanitized before Input storage and pane rendering", () => {
  const harness = formWith();
  // Both bracketed markers and terminal strings/CSI packets may arrive split
  // across chunks. Nothing untrusted is passed through Input.render or kept
  // in the field value.
  harness.send("\x1b[20");
  harness.send("0~A\x1b]52;c;YWJj\x07B\x1b]0;malicious title\x1b");
  harness.send(`\\C\x1b[8;99;99tD\x1b[31mE\x1b[0mF${CURSOR_MARKER}\x01G\u009b31mH\u0085I\x1b[201`);
  harness.send("~tail");
  const frame = harness.controller.render(44, 8);
  const texts = assertPaneSafe(frame.lines, 44, 8);
  const visible = texts.join("\n");
  assert.ok(visible.includes("ABCDEF") && visible.includes("tail"), JSON.stringify(texts));
  assert.ok(texts.every((line) => !/YWJj|malicious title|99;99|31m/.test(line)));
  assert.ok(texts.every((line) => !line.includes(CURSOR_MARKER)));
});

test("streamed paste owns toggle and key-release packets until its split end marker", () => {
  const harness = formWith();
  harness.send("\x1b[20");
  harness.send("0~before");
  harness.send(ALT_LEFT_LEGACY);
  harness.send(KITTY_Q_RELEASE);
  harness.send("\x1b[201");
  harness.send("~after");

  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "form");
  assert.deepEqual(harness.focusedActions(), [], "paste-body packets never trigger sidebar actions");
  assert.equal(harness.sinceActions().some((action) => action.type === "forward"), false,
    "paste-body packets are not forwarded to the active child");
  const text = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8).join("\n");
  assert.ok(text.includes("before") && text.includes("after"), text);
});

test("adjacent bracketed pastes retain ownership across end/start markers in one chunk", () => {
  const harness = formWith();
  harness.send("\x1b[200~first");
  harness.send("\x1b[201~\x1b[200~second");
  harness.send(ALT_LEFT_LEGACY);
  harness.send(KITTY_Q_RELEASE);
  harness.send("\x1b[201~");

  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "form");
  assert.deepEqual(harness.focusedActions(), []);
  assert.equal(harness.sinceActions().some((action) => action.type === "forward"), false);
  const text = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8).join("\n");
  assert.ok(text.includes("first") && text.includes("second"), text);
});

test("a consecutive paste start split across chunks keeps toggle and release packets opaque", () => {
  const harness = formWith();
  harness.send("\x1b[200~first");
  harness.send("\x1b[201~\x1b[20");
  harness.send("0~second");
  harness.send(ALT_LEFT_LEGACY);
  harness.send(KITTY_Q_RELEASE);
  harness.send("\x1b[201");
  harness.send("~");

  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "form");
  assert.deepEqual(harness.focusedActions(), []);
  assert.equal(harness.sinceActions().some((action) => action.type === "forward"), false);
  const text = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8).join("\n");
  assert.ok(text.includes("first") && text.includes("second"), text);
});

test("sanitized paste preserves visible caret editing around stripped commands", () => {
  const harness = formWith();
  harness.send("\x1b[200~A\x1b]52;c;YWJj\x07B\x1b[201~");
  harness.send(LEFT);
  harness.send(LEFT);
  harness.send(LEFT);
  harness.send("X");
  const texts = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8);
  assert.ok(texts.join("\n").includes("XAB"), JSON.stringify(texts));
});

test("streamed paste accumulation is byte-bounded and reports overflow", () => {
  const harness = formWith();
  harness.send("\x1b[200~");
  harness.send("x".repeat(5000));
  harness.send("y".repeat(5000));
  harness.send("\x1b[201~");
  const texts = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8);
  assert.ok(texts.some((line) => line.includes("Pasted text exceeds the field limit")));
  assert.ok(texts.every((line) => !line.includes("x".repeat(20)) && !line.includes("y".repeat(20))));
});

test("Ctrl+U kills the field line via the real keybinding", () => {
  const harness = formWith();
  for (const ch of "draft") {
    harness.controller.handleInput(ch);
  }
  harness.controller.handleInput("\x15"); // Ctrl+U (tui.editor.deleteToLineStart)
  for (const ch of "kept") {
    harness.controller.handleInput(ch);
  }
  harness.send(ENTER);
  assert.equal(createOf(harness.focusedActions().at(-1)).workspace, "kept");
});

test("exact-width form text reserves a visible end-of-value caret", () => {
  const harness = formWith({ cols: 24 });
  for (const char of "abcdefghijk") {
    harness.send(char);
  }
  const frame = harness.controller.render(24, 20);
  const texts = assertPaneSafe(frame.lines, 24, 20);
  assert.ok(texts[3]?.startsWith("> Workspace: "), JSON.stringify(texts));
  assert.ok(texts[3]?.slice(13).trimEnd().endsWith("abcdefghij"), JSON.stringify(texts));
  assert.ok(texts[4]?.startsWith(" ".repeat(13)), JSON.stringify(texts));
  assert.ok(texts[4]?.slice(13).trimEnd().endsWith("k"), JSON.stringify(texts));
  assert.deepEqual(frame.cursor, { column: 14, row: 4 }, "hardware cursor follows the native Editor's wrapped value");
  assert.equal(texts[frame.cursor!.row]?.slice(13, frame.cursor!.column), "k", "cursor is at the insertion cell after the wrapped character");
  assert.notEqual(frame.cursor?.row, 3,
    "the caret wrapped to a later row while the label stayed on the field's first editable row");
});

test("a wrapped value keeps its label on the field's first editable row as the caret moves", () => {
  const harness = formWith({ cols: 24 });
  for (const char of "abcdefghijk") {
    harness.send(char);
  }
  // Rows are compared as written text with the generated SGR removed, exactly
  // as every other pane witness here does; the caret is asserted against the
  // original frame's cursor DTO.
  const pane = () => {
    const frame = harness.controller.render(24, 20);
    return { rows: assertPaneSafe(frame.lines, 24, 20), cursor: frame.cursor };
  };
  const labelRow = (rows: readonly string[]): number =>
    rows.findIndex((line) => line.startsWith("> Workspace: "));

  const wrapped = pane();
  const firstLabelRow = labelRow(wrapped.rows);
  assert.equal(firstLabelRow, 3, "the label sits beside the first editable row, below the Host line and the Editor's own top border");
  assert.equal(wrapped.rows[firstLabelRow]?.slice(13).trimEnd(), "abcdefghij",
    "the labelled row carries the field's first wrapped segment, not a border or help row");
  assert.equal(wrapped.cursor?.row, firstLabelRow + 1, "the caret wrapped to the following row");

  // Home moves the caret onto the labelled row; End moves it away again. Neither
  // movement may drag the label with the caret.
  harness.send("\x1b[H");
  const atHome = pane();
  assert.equal(labelRow(atHome.rows), firstLabelRow, "Home leaves the label on the same row");
  assert.equal(atHome.cursor?.row, firstLabelRow, "the caret is now on the labelled row itself");
  assert.equal(atHome.rows.filter((line) => line.startsWith("> Workspace: ")).length, 1,
    "the field never gains a second label row");

  harness.send("\x1b[4~");
  const atEnd = pane();
  assert.equal(labelRow(atEnd.rows), firstLabelRow, "End leaves the label on the same row");
  assert.equal(atEnd.cursor?.row, firstLabelRow + 1, "the caret wrapped away again");
  assert.equal(atEnd.rows[firstLabelRow]?.slice(13).trimEnd(), "abcdefghij",
    "the labelled row still carries the first wrapped segment of the value");
  assert.deepEqual(atEnd.cursor, wrapped.cursor,
    "the native caret geometry is exactly what it was before the round trip");
});

test("empty, populated, Unicode, and Edit cursors sit on their labelled native text rows", () => {
  const empty = formWith({ cols: 44, rows: 10 });
  const emptyFrame = empty.controller.render(44, 10);
  const emptyRows = assertPaneSafe(emptyFrame.lines, 44, 10);
  assert.ok(emptyFrame.cursor);
  assert.equal(emptyRows[emptyFrame.cursor.row]?.slice(0, 13), "> Workspace: ",
    "the label sits beside the editable content row, not the Editor's top rule");
  assert.equal(emptyRows[emptyFrame.cursor.row]?.slice(13).trim(), "");

  empty.send("/a");
  const populatedFrame = empty.controller.render(44, 10);
  const populatedRows = assertPaneSafe(populatedFrame.lines, 44, 10);
  assert.ok(populatedFrame.cursor);
  assert.equal(populatedRows[populatedFrame.cursor.row]?.slice(13, populatedFrame.cursor.column), "/a");

  const unicode = formWith({ cols: 44, rows: 10 });
  unicode.send("雪");
  const unicodeFrame = unicode.controller.render(44, 10);
  const unicodeRows = assertPaneSafe(unicodeFrame.lines, 44, 10);
  assert.ok(unicodeFrame.cursor);
  assert.equal(unicodeRows[unicodeFrame.cursor.row]?.slice(0, 13), "> Workspace: ");
  assert.equal(unicodeRows[unicodeFrame.cursor.row]?.slice(13).trimStart().startsWith("雪"), true);
  assert.equal(visibleWidth(" ".repeat(13) + "雪"), unicodeFrame.cursor.column,
    "the Unicode grapheme occupies two terminal cells before the insertion point");

  const edit = makeRoster(["a"]);
  const tuple = { sessionId: "session-123", epoch: 7, name: "Current" };
  edit.controller.updateItems([makeItem({ id: "a", nativeSession: tuple })]);
  edit.controller.openEdit({ id: "a", nativeSession: tuple, currentName: tuple.name });
  edit.send("雪");
  const editFrame = edit.controller.render(48, 12);
  const editRows = assertPaneSafe(editFrame.lines, 48, 12);
  assert.ok(editFrame.cursor);
  assert.equal(editRows[editFrame.cursor.row]?.slice(0, 12), "> New name: ");
  assert.equal(editRows[editFrame.cursor.row]?.slice(12).trimStart().startsWith("雪"), true);
  assert.equal(visibleWidth(" ".repeat(12) + "雪"), editFrame.cursor.column,
    "Edit cursor follows the wide Unicode grapheme by terminal cells, not UTF-16 code units");
});

test("home/end navigate the native path field and scroll horizontally to the cursor", () => {
  const harness = formWith({ cols: 44 });
  harness.controller.handleInput("/Users/dev/" + "0123456789".repeat(3));
  const atEnd = harness.controller.render(44, 20);
  assert.ok(
    (atEnd.cursor?.column ?? 0) >= 13 && (atEnd.cursor?.column ?? 0) <= 43,
    `end caret out of pane: ${JSON.stringify(atEnd.cursor)}`,
  );
  harness.controller.handleInput("\x1b[H"); // home: cursor scrolls back left
  const atHome = harness.controller.render(44, 20);
  assert.equal(atHome.cursor?.row, 3);
  harness.controller.handleInput("\x1b[4~"); // end again
  const atEndAgain = harness.controller.render(44, 20);
  assert.ok((atEndAgain.cursor?.column ?? 0) > 13);
  // 0-based pane coordinates on every render.
  assert.ok((atHome.cursor?.row ?? 0) >= 0);
});

test("form Escape while starting cancels only the UI, keeps the roster visible, and never kills the launch", () => {
  const harness = formWith();
  harness.send("/workspace");
  harness.send(ENTER); // submit -> create request 1
  const texts = assertPaneSafe(harness.controller.render(40, 8).lines, 40, 8);
  assert.ok(texts.some((line) => line.includes("Starting (request 1)")));
  harness.send(ESC); // escape while starting: UI-only local cancel
  assert.equal(harness.controller.visible, true, "the roster stays visible");
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focusedActions(), [
    { type: "create", requestId: 1, workspace: "/workspace" },
  ], "the cancel itself emits no visibility action");
  // The retained workspace draft is restored when the New form is reopened.
  void harness.controller.render(40, 20); // the restored roster is drawn before Enter
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  assert.ok(
    assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8).join("\n").includes("/workspace"),
    "the workspace draft survives the cancel",
  );
  // Backend already launched? Then this late completion is real UI noise:
  // it must not kill anything (it can't — there is no kill path) and must
  // not steal focus. But the escaped request may still legitimately land.
  harness.controller.completeCreate(1, "landing-row");
  assert.equal(harness.controller.focus, "form", "a late create result never steals the reopened form");
  assert.deepEqual(harness.controller.selectedId, undefined);
  // The cancel itself emitted no quit/stop action.
  assert.deepEqual(
    harness.focusedActions().filter((action) => action.type === "quit" || action.type === "stop-remove"),
    [],
  );
});

test("reserved toggle hides a form during editing and while creation is pending", () => {
  for (const options of [{}, { toggleKey: "f8" }] as const) {
    const packet = togglePacketFor(options);
    const editing = formWith({ options });
    for (const char of "draft") {
      editing.send(char);
    }
    editing.send(packet); // reserved toggle beats Input word navigation
    assert.equal(editing.controller.visible, false);
    assert.equal(editing.controller.focus, "main");
    assert.deepEqual(editing.focusedActions(), [{ type: "visibility", visible: false }]);
    editing.send(packet);
    assert.equal(editing.controller.focus, "sidebar");
    void editing.controller.render(40, 20); // the reopened roster is drawn
    editing.send(ENTER); // reopen the New session form
    assert.equal(editing.controller.focus, "form");
    assert.ok(assertPaneSafe(editing.controller.render(44, 8).lines, 44, 8).join("\n").includes("draft"));

    const pending = formWith({ options });
    pending.send("/workspace");
    pending.send(ENTER); // request 1 starts
    assert.equal(createOf(pending.focusedActions().at(-1)).requestId, 1);
    pending.send(packet); // abandon UI ownership; do not stop the backend launch
    assert.equal(pending.controller.visible, false);
    pending.send(packet);
    void pending.controller.render(40, 20); // the reopened roster is drawn
    pending.send(ENTER); // open a newer form
    assert.equal(pending.controller.focus, "form");
    pending.controller.completeCreate(1, "late-row");
    pending.controller.failCreate(1, "late failure");
    assert.equal(pending.controller.focus, "form");
    assert.ok(assertPaneSafe(pending.controller.render(44, 8).lines, 44, 8).every((line) => !line.includes("late")));
    assert.deepEqual(
      pending.focusedActions().filter((action) => action.type === "quit" || action.type === "select"),
      [],
    );
  }
});

test("failCreate preserves the workspace draft and shows the sanitized error", () => {
  const harness = formWith();
  harness.controller.handleInput("/w");
  harness.send(ENTER); // submit -> request 1
  harness.controller.failCreate(1, "\x1b[31mNo such workspace\x07boom");
  const texts = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8);
  assert.ok(texts.some((line) => line.includes("No such workspaceboom")));
  assert.ok(texts.every((line) => !line.includes("Starting")));
  // Draft preserved: re-submitting needs no retyping and gets a fresh id.
  harness.send(ENTER); // submit -> request 2
  const create = createOf(harness.focusedActions().at(-1));
  assert.equal(create.requestId, 2);
  assert.equal(create.workspace, "/w");
});

test("backend selection supersedes pending create callbacks", () => {
  for (const selectedId of ["a", "later"]) {
    for (const callback of ["complete", "fail"]) {
      const harness = formWith();
      harness.send("/w");
      harness.send(ENTER);
      const request = createOf(harness.focusedActions().at(-1));
      harness.controller.select(selectedId);
      const before = harness.controller.render(44, 8);
      const actionsBefore = [...harness.actions];
      if (callback === "complete") {
        harness.controller.completeCreate(request.requestId, "old-created");
      } else {
        harness.controller.failCreate(request.requestId, "stale failure");
      }
      assert.equal(harness.controller.focus, "form");
      assert.deepEqual(harness.controller.render(44, 8), before);
      assert.deepEqual(harness.actions, actionsBefore);
      harness.controller.updateItems([
        makeItem({ id: "a" }),
        makeItem({ id: "later" }),
        makeItem({ id: "old-created" }),
      ]);
      assert.equal(harness.controller.selectedId, selectedId);
      harness.send(ENTER);
      const retry = createOf(harness.focusedActions().at(-1));
      assert.equal(retry.requestId, request.requestId + 1);
      assert.equal(retry.workspace, "/w");
    }
  }
});

test("stale create callbacks never contaminate the current form or selection", () => {
  const harness = formWith();
  harness.send("/workspace");
  harness.send(ENTER); // submit -> request 1
  harness.controller.failCreate(1, "nope");
  // A stale failCreate for the already-failed request changes nothing.
  harness.controller.failCreate(1, "late");
  const texts = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8);
  assert.ok(texts.some((line) => line.includes("nope")));
  assert.ok(texts.every((line) => !line.includes("late")));
  // A stale completion cannot steal focus while a newer request is pending:
  // submit again (request 2) and replay the old completion.
   harness.send(ENTER); // submit -> request 2
  harness.controller.completeCreate(1, "stale-row");
  assert.equal(harness.controller.focus, "form");
  assert.equal(harness.controller.selectedId, undefined);
  // The matching completion activates the row (once published) and closes the form.
  harness.controller.completeCreate(2, "fresh-row");
  assert.equal(harness.controller.focus, "main");
  assert.deepEqual(harness.focusedActions().at(-1), { type: "select", id: "fresh-row" });
  assert.deepEqual(harness.controller.selectedId, undefined); // row not published yet
  harness.controller.updateItems([
    makeItem({ id: "a" }),
    makeItem({ id: "fresh-row" }),
  ]);
  assert.deepEqual(harness.controller.selectedId, "fresh-row");
});

// ---------------------------------------------------------------------------
// Rendering safety: sanitization, width bounds, badges, scroll, small panes
// ---------------------------------------------------------------------------

test("malicious metadata, error text, and OSC-52-like payloads are neutralized", () => {
  const harness = makeController({ initialVisible: false });
  harness.send(ALT_LEFT_LEGACY); // show
  harness.controller.updateItems([
    makeItem({
      id: "s",
      label: "\x1b[31mEVIL\x1b]0;pwned\x07tail",
      activity: ["\x9b1mmore\x07DEL\x7fx", "fine", "third line hidden"],
    }),
  ]);
  harness.controller.select("s"); // activity renders under the selected row
  harness.controller.showError("\x1b]52;c;Y2xlYXJ0ZXh0\x07boom");
  const texts = rosterView(harness.controller).texts;
  assert.ok(texts.some((line) => line.includes("EVIL")));
  assert.ok(texts.some((line) => line.includes("tail")));
  assert.ok(texts.every((line) => !line.includes("pwned")));
  assert.ok(texts.every((line) => !line.includes("Y2xlYXJ0ZXh0")));
  assert.ok(texts.some((line) => line.includes("boom")));
  // Activity is sanitized and bounded to two lines.
  assert.ok(texts.some((line) => line.includes("moreDELx")));
  assert.ok(texts.some((line) => line.includes("fine")));
  assert.ok(texts.every((line) => !line.includes("third line hidden")));
});

/** Index of the card whose title line is exactly `title` (padding trimmed). */
function cardIndex(texts: string[], title: string): number {
  const index = texts.findIndex((line) => line.trimEnd() === title);
  assert.ok(index >= 0, `missing title-only card line ${JSON.stringify(title)} in ${JSON.stringify(texts)}`);
  return index;
}

test("truthful card status: observed/unknown agent and input state below the title", () => {
  const harness = makeController({ initialVisible: false });
  harness.send(ALT_LEFT_LEGACY);
  harness.controller.updateItems([
    makeItem({ id: "run", busy: true }),
    makeItem({ id: "idle", busy: false, activeTasks: 0, activeShells: 0 }),
    makeItem({ id: "unsure", busy: null }),
    makeItem({ id: "typed", pendingInput: true }),
    makeItem({ id: "surface", inputSurface: true }),
    makeItem({ id: "quiet", activeTasks: 0, activeShells: 0 }),
    makeItem({ id: "unobserved", pendingInput: null }),
    makeItem({ id: "gone", lifecycle: "exited", exitCode: 3, busy: null, pendingInput: null }),
    makeItem({ id: "err", lifecycle: "error", exitCode: 1 }),
    makeItem({ id: "warm", lifecycle: "starting", busy: null }),
  ]);
  // 10 expanded cards (50 rows) + 3 action rows fit at 80x60.
  const texts = rosterView(harness.controller, 80, 60).texts;
  const statusFor = (id: string): string => texts[cardIndex(texts, `label-${id}`) + 1]?.trimEnd() ?? "";
  assert.equal(statusFor("run"), "  agent running | input none");
  // Idle requires every ACTIVITY-INTENT category and modal input positively
  // known; the conservative ownership channel is not what this line displays.
  assert.equal(statusFor("idle"), "  agent idle | input none");
  assert.equal(statusFor("unsure"), "  agent unknown | input none");
  assert.equal(statusFor("typed"), "  agent waiting | input pending");
  assert.equal(statusFor("surface"), "  agent waiting | input pending");
  assert.equal(statusFor("quiet"), "  agent idle | input none");
  // Unobserved input (and omitted background counts) is unknown, never idle.
  assert.equal(statusFor("unobserved"), "  agent unknown | input unknown");
  // No conflation: exited/error rows never claim agent or input state.
  assert.equal(statusFor("gone"), "  exited (code 3)");
  assert.equal(statusFor("err"), "  error (code 1)");
  assert.equal(statusFor("warm"), "  starting | input none");
});

test("card title line carries only the sanitized canonical title", () => {
  const harness = makeRoster(["native", "plain"]);
  harness.controller.updateItems([
    makeItem({
      id: "native",
      label: "stale label",
      busy: true,
      pendingInput: true,
      nativeSession: { sessionId: "session-123", epoch: 2, name: "Canonical title" },
    }),
    makeItem({ id: "plain", label: "\x1b[31mPlain\x1b]0;evil\x07 label", lifecycle: "exited", exitCode: 0 }),
  ]);
  harness.controller.select("native");
  const { texts, lines } = rosterView(harness.controller, 40, 20);
  // Header, then the selected native card: the title row is the title alone —
  // no marker, prefix, or status badge — styled only by generated SGR.
  assert.equal(texts[1]?.trimEnd(), "Canonical title");
  // Sidebar focus: the selected navigation target's title is blue (the focus-
  // domain highlight), not the old inverse mark.
  assert.ok(lines[1]?.startsWith("\x1b[0m\x1b[1;34mCanonical title"), JSON.stringify(lines[1]));
  assert.equal(texts[2]?.trimEnd(), "> agent running | input pending", "the selection marker lives on the status row");
  assert.ok(!texts.join("\n").includes("stale label"));
  // Unselected title: sanitized label only, bold without inverse, no marker.
  const plain = cardIndex(texts, "Plain label");
  assert.ok(lines[plain]?.startsWith("\x1b[0m\x1b[1mPlain label"), JSON.stringify(lines[plain]));
  assert.equal(texts[plain + 1]?.trimEnd(), "  exited (code 0)");
  assert.ok(texts.every((line) => !line.includes("evil")));
  for (const title of [texts[1], texts[plain]]) {
    assert.ok(!/>|\[|agent|input|exited|bg tasks|background/.test(title ?? ""), JSON.stringify(title));
  }
});

test("activity-intent counts are honest: observed integers shown, anything else unknown", () => {
  const harness = makeController({ initialVisible: false });
  harness.send(ALT_LEFT_LEGACY);
  harness.controller.updateItems([
    makeItem({ id: "known", label: "Known", backgroundTasks: 2, backgroundShells: 0, activeTasks: 2, activeShells: 0, activity: ["compiling", "tests"] }),
    makeItem({ id: "settling", label: "Settling", backgroundTasks: 1, backgroundShells: 0, activeTasks: 0, activeShells: 0 }),
    makeItem({ id: "mixed", label: "Mixed", activeTasks: null, activeShells: 3 }),
    makeItem({ id: "bogus", label: "Bogus", activeTasks: -1, activeShells: 1.5 }),
    makeItem({
      id: "hostile",
      label: "Hostile",
      activeTasks: "3" as unknown as number,
      activeShells: Number.MAX_SAFE_INTEGER + 1,
    }),
    makeItem({ id: "nonfinite", label: "Nonfinite", activeTasks: Number.NaN, activeShells: Number.POSITIVE_INFINITY }),
  ]);
  harness.controller.select("known");
  // 6 expanded cards (25 rows) + 3 action rows fit at 40x40.
  const texts = rosterView(harness.controller, 40, 40).texts;
  const known = cardIndex(texts, "Known");
  // Observed activity intent keeps the row running, never idle.
  assert.equal(texts[known + 1]?.trimEnd(), "> agent running | input none");
  assert.equal(texts[known + 2]?.trimEnd(), "  bg tasks 2 | shells 0", "an observed zero is shown as zero");
  assert.equal(texts[known + 3]?.trimEnd(), "    compiling");
  assert.equal(texts[known + 4]?.trimEnd(), "    tests");
  // Retained ownership with zero activity is displayed as an idle row with no
  // background number: the card is activity intent, never a cleanup obligation.
  const settling = cardIndex(texts, "Settling");
  assert.equal(texts[settling + 1]?.trimEnd(), "  agent idle | input none");
  assert.equal(texts[settling + 2]?.trimEnd(), "  bg tasks 0 | shells 0");
  assert.equal(texts[cardIndex(texts, "Mixed") + 2]?.trimEnd(), "  bg tasks unknown | shells 3");
  assert.equal(texts[cardIndex(texts, "Bogus") + 2]?.trimEnd(), "  background unknown");
  assert.equal(texts[cardIndex(texts, "Hostile") + 2]?.trimEnd(), "  background unknown");
  assert.equal(texts[cardIndex(texts, "Nonfinite") + 2]?.trimEnd(), "  background unknown");
  // The stored DTO copy is sanitized the same way: unknown is null, never 0.
  const items = harness.controller.items;
  assert.deepEqual(items.map((item) => [item.activeTasks, item.activeShells]), [
    [2, 0],
    [0, 0],
    [null, 3],
    [null, null],
    [null, null],
    [null, null],
  ]);
  // The ownership channel is retained verbatim for the stop/remove gate.
  assert.deepEqual(items.map((item) => [item.backgroundTasks, item.backgroundShells]), [
    [2, 0],
    [1, 0],
    [null, null],
    [null, null],
    [null, null],
    [null, null],
  ]);
});

test("CJK width cards stay bounded and intact; configured F8 shows in the help", () => {
  const harness = makeRoster(["jp"], { toggleKey: "f8" });
  harness.controller.updateItems([makeItem({ id: "jp", label: "セッション", busy: true })]);
  harness.controller.select("jp");
  const texts = rosterView(harness.controller, 40, 10).texts;
  assert.equal(texts[1]?.trimEnd(), "セッション");
  assert.equal(texts[2]?.trimEnd(), "> agent running | input none");
  assert.ok(texts.some((line) => line.includes("F8 toggle")));
});

test("32-column cards bound long titles while the status row stays intact", () => {
  const harness = makeController({ initialVisible: false });
  harness.send(ALT_LEFT_LEGACY);
  harness.controller.updateItems([
    makeItem({ id: "ascii", label: "A".repeat(80), lifecycle: "alive", busy: true, pendingInput: true }),
    makeItem({ id: "wide", label: "セッション".repeat(12), lifecycle: "alive", busy: null, inputSurface: true }),
    makeItem({ id: "exited", label: "E".repeat(80), lifecycle: "exited", exitCode: 3 }),
    makeItem({ id: "error", label: "障害".repeat(20), lifecycle: "error", exitCode: 1 }),
  ]);
  // Four expanded cards (rows 1-20) + 3 action rows fit at 32x40.
  const view = rosterView(harness.controller, 32, 40);
  assert.ok(view.texts[1]?.startsWith("AAA"));
  assert.ok(!view.texts[1]?.includes("A".repeat(32)));
  assert.equal(view.texts[2]?.trimEnd(), "  agent running | input pending");
  assert.ok(view.texts[6]?.startsWith("セ"));
  assert.ok(!view.texts[6]?.includes("セッション".repeat(4)));
  assert.equal(view.texts[7]?.trimEnd(), "  agent waiting | input pending");
  assert.ok(view.texts[11]?.startsWith("EEE"));
  assert.equal(view.texts[12]?.trimEnd(), "  exited (code 3)");
  assert.ok(view.texts[16]?.startsWith("障"));
  assert.equal(view.texts[17]?.trimEnd(), "  error (code 1)");
  for (const titleRow of [1, 6, 11, 16]) {
    assert.ok(!/agent|input|exited|error|>/.test(view.texts[titleRow] ?? ""), JSON.stringify(view.texts[titleRow]));
  }
  assert.ok(view.texts.every((line) => visibleWidth(line) <= 32));
  assert.equal(view.lines.length, 40);
});

test("variable-height scrolling keeps the complete highlighted card visible", () => {
  const harness = makeController({ initialVisible: false });
  harness.controller.updateItems(
    Array.from({ length: 8 }, (_, i) => makeItem({ id: `s${i}` })),
  );
  harness.send(ALT_LEFT_LEGACY); // show -> focus sidebar
  harness.controller.select("s0");
  // 32x16 => header + 12 list rows + 3 wrapped footer rows: two whole cards.
  const first = rosterView(harness.controller, 32, 16);
  assert.equal(first.texts[1]?.trimEnd(), "label-s0");
  assert.ok(first.texts[2]?.startsWith("> "));
  assert.equal(first.texts[6]?.trimEnd(), "label-s1");
  assert.ok(first.texts.every((line) => !line.includes("label-s2")), "clipped cards are never half-drawn");
  for (let i = 0; i < 5; i += 1) {
    harness.send(DOWN); // s0 .. s5
  }
  const scrolled = rosterView(harness.controller, 32, 16);
  const s5 = cardIndex(scrolled.texts, "label-s5");
  assert.ok(scrolled.texts[s5 + 1]?.startsWith("> "));
  assert.ok(s5 + 4 <= 11, "all five rows of the highlighted card sit inside the list area");
  assert.ok(scrolled.texts.every((line) => !line.includes("label-s0")));
  assert.equal(scrolled.lines.length, 16);
  harness.send(UP); // back to s4
  const back = rosterView(harness.controller, 32, 16);
  assert.equal(back.texts[1]?.trimEnd(), "label-s4");
  assert.ok(back.texts[2]?.startsWith("> "));

  // Collapsing s4 (3 rows) changes the variable heights; navigating to the
  // end still keeps each complete highlighted entry in view.
  harness.send(" ");
  harness.send(DOWN); // s5
  harness.send(DOWN); // s6
  harness.send(DOWN); // s7
  const tail = rosterView(harness.controller, 32, 16);
  const s7 = cardIndex(tail.texts, "label-s7");
  assert.ok(tail.texts[s7 + 1]?.startsWith("> "));
  assert.ok(s7 + 4 <= 11);
  harness.send(DOWN); // Saved conversations
  const saved = rosterView(harness.controller, 32, 16);
  assert.ok(saved.texts.some((line) => line.startsWith("> Saved conversations")), JSON.stringify(saved.texts));
  harness.send(DOWN); // New session
  const fresh = rosterView(harness.controller, 32, 16);
  assert.ok(fresh.texts.some((line) => line.startsWith("> New session")), JSON.stringify(fresh.texts));
});

test("expanded card activity is generic, sanitized, and bounded to two rows", () => {
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([
    makeItem({ id: "a", activity: ["one", "\x1b[31mtwo\x07", "three", "four"] }),
  ]);
  harness.controller.select("a");
  const texts = rosterView(harness.controller, 40, 12).texts;
  assert.equal(texts[4]?.trimEnd(), "    one");
  assert.equal(texts[5]?.trimEnd(), "    two");
  assert.ok(texts.every((line) => !line.includes("three")));
  // Bounded rendering only: the stored DTO keeps everything the backend sent.
  assert.equal(harness.controller.items[0]?.activity.length, 4);
  // A collapsed card keeps title, status, and background but drops activity:
  // exactly 3 rows (expanded was 5), so the next entry starts two rows
  // earlier and no activity row content appears in the card's rows.
  harness.send(" ");
  const collapsed = rosterView(harness.controller, 40, 12).texts;
  assert.equal(collapsed[1]?.trimEnd(), "label-a");
  assert.ok(collapsed[2]?.startsWith("> agent"), JSON.stringify(collapsed));
  assert.equal(collapsed[3]?.trimEnd(), "  background unknown");
  assert.equal(collapsed[4]?.trimEnd(), "  Saved conversations", "the collapsed card is exactly 3 rows, dropping both activity rows");
});

test("Space toggles only the highlighted card and expansion persists per id", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.select("a");
  const view = (): string[] => rosterView(harness.controller, 40, 20).texts;
  // Default expanded: a = rows 1-5, b = rows 6-10.
  assert.equal(view()[6]?.trimEnd(), "label-b");
  harness.send(" "); // collapse a
  let texts = view();
  assert.equal(texts[1]?.trimEnd(), "label-a");
  assert.equal(texts[4]?.trimEnd(), "label-b", "a now occupies 3 rows");
  harness.send(DOWN); // highlight b: a stays collapsed, b stays expanded
  texts = view();
  assert.equal(texts[4]?.trimEnd(), "label-b");
  assert.ok(texts[5]?.startsWith("> "));
  assert.equal(texts[9]?.trimEnd(), "  Saved conversations", "b keeps its 5 rows");
  harness.send(" "); // collapse b only
  texts = view();
  assert.equal(texts[7]?.trimEnd(), "  Saved conversations");
  harness.send(UP); // highlight a: b stays collapsed
  harness.send(" "); // expand a again
  texts = view();
  assert.equal(texts[6]?.trimEnd(), "label-b");
  assert.equal(texts[9]?.trimEnd(), "  Saved conversations", "b is still collapsed");

  // Metadata updates and reorders keep each card's own state.
  harness.controller.updateItems([makeItem({ id: "a", busy: true }), makeItem({ id: "b", busy: true })]);
  texts = view();
  assert.equal(texts[9]?.trimEnd(), "  Saved conversations");
  // A row that leaves the roster forgets its state; it returns expanded.
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "b" })]);
  texts = view();
  assert.equal(texts[11]?.trimEnd(), "  Saved conversations");

  // Space never emits actions, ignores held repeats, and is inert on action rows.
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    harness.send("\x1b[32;1:2u"); // Space repeat
    harness.send("\x1b[32;1:3u"); // Space release
  } finally {
    setKittyProtocolActive(previous);
  }
  assert.equal(view()[6]?.trimEnd(), "label-b", "repeat/release did not collapse a");
  harness.send(DOWN);
  harness.send(DOWN); // Saved conversations
  harness.send(" ");
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.sinceActions(), []);
});

test("a card that cannot fit is truthfully too small and selection keys never act invisibly", () => {
  const tuple = { sessionId: "session-123", epoch: 1, name: "Nine" };
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([makeItem({ id: "a", lifecycle: "exited", hasLiveProcess: false, nativeSession: tuple })]);
  // 40x8 => 4 list rows: the action rows fit, the 5-row card does not.
  const actions = rosterView(harness.controller, 40, 8).texts;
  assert.ok(actions.some((line) => line.startsWith("> New session")));
  assert.ok(actions.every((line) => !line.includes("Nine")));
  harness.send(UP); // Saved
  harness.send(UP); // the card: off-screen at the last rendered geometry
  assert.equal(harness.controller.selectedId, "a");
  harness.send(ENTER);
  harness.send("e");
  harness.send(DELETE);
  assert.deepEqual(harness.sinceActions(), [], "no select/edit/remove for a target the user cannot see");
  assert.equal(harness.controller.focus, "sidebar");
  const tooSmall = harness.controller.render(40, 8);
  assert.ok(tooSmall.lines.some((line) => line.includes("too small")));
  assert.ok(tooSmall.lines.every((line) => !line.includes("Nine")));
  harness.send(ENTER);
  assert.deepEqual(harness.sinceActions(), []);

  harness.send(" "); // collapse: 3 rows would fit in 4, but nothing is drawn yet
  harness.send(ENTER);
  harness.send("e");
  harness.send(DELETE);
  assert.deepEqual(harness.sinceActions(), [], "the screen still shows only the too-small message");
  const fits = rosterView(harness.controller, 40, 8).texts;
  assert.equal(fits[1]?.trimEnd(), "Nine");
  assert.ok(fits[2]?.startsWith("> exited"));
  assert.equal(fits[3]?.trimEnd(), "  background unknown");
  harness.send(ENTER);
  assert.deepEqual(harness.sinceActions(), [{ type: "resume-row", requestId: 1, id: "a" }],
    "a drawn exited card asks the backend to restart that exact row");
  assert.equal(harness.controller.focus, "sidebar");
});

test("activation requires the highlighted entry on the last drawn roster at its current height and order", () => {
  const harness = makeController({ initialVisible: false });
  harness.controller.updateItems(Array.from({ length: 4 }, (_, i) => makeItem({ id: `s${i}` })));
  harness.send(ALT_LEFT_LEGACY);
  harness.controller.select("s0");
  harness.baseline = harness.actions.length;
  const selects = (): number => harness.focusedActions().filter((action) => action.type === "select").length;

  // 32x16 => 12 list rows: s0 and s1 are drawn whole, s2 is not drawn.
  const first = rosterView(harness.controller, 32, 16).texts;
  assert.ok(first.every((line) => !line.includes("label-s2")));
  harness.send(DOWN); // s1
  harness.send(DOWN); // s2 would fit the list area but was never drawn
  assert.equal(harness.controller.selectedId, "s2");
  harness.send(ENTER);
  harness.send("e");
  harness.send(DELETE);
  assert.deepEqual(harness.focusedActions(), [], "navigation alone never activates an undrawn target");
  const drawn = rosterView(harness.controller, 32, 16).texts;
  assert.equal(drawn[cardIndex(drawn, "label-s2") + 1]?.slice(0, 2), "> ");
  harness.send(ENTER);
  assert.equal(selects(), 1);
  assert.equal(harness.controller.focus, "main");

  // Visible MAIN -> sidebar focus does not change what is drawn.
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.focus, "sidebar");

  // A roster reorder after the last render blocks until it is redrawn.
  harness.controller.updateItems(["s2", "s0", "s1", "s3"].map((id) => makeItem({ id })));
  harness.send(ENTER);
  assert.equal(selects(), 1);
  rosterView(harness.controller, 32, 16);
  harness.send(ENTER);
  assert.equal(selects(), 2);

  // An expansion change after the last render blocks until it is redrawn.
  harness.send(ALT_LEFT_LEGACY); // MAIN -> sidebar focus
  harness.send(" "); // collapse s2: drawn at 5 rows, now 3
  harness.send(ENTER);
  assert.equal(selects(), 2);
  const collapsed = rosterView(harness.controller, 32, 16).texts;
  assert.equal(collapsed[1]?.trimEnd(), "label-s2");
  assert.equal(collapsed[4]?.trimEnd(), "label-s0", "s2 now occupies 3 rows");
  harness.send(ENTER);
  assert.equal(selects(), 3);
});

test("narrow picker overlay forgets a roster previously drawn beside it", () => {
  const harness = makeRoster(["a"]);
  harness.send(UP); // New -> Saved conversations
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");

  // Wide layout draws both panes; narrowing replaces the roster.
  void harness.controller.renderRoster(32, 20);
  void harness.controller.renderForm(40, 20);
  void harness.controller.render(40, 20);
  harness.baseline = harness.actions.length;

  harness.send(ESC); // dismiss listing, without a roster redraw yet
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "sidebar");
  assert.ok(!harness.sinceActions().some((action) => action.type === "saved-list"));

  void harness.controller.render(40, 20);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  assert.equal(harness.sinceActions().filter((action) => action.type === "saved-list").length, 1);
});

test("wide layout keeps the roster beside a form actionable after the form closes", () => {
  const harness = makeRoster(["a"]);
  harness.send(UP); // New -> Saved conversations
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  // Wide layout only: the roster stays drawn beside the picker.
  void harness.controller.renderRoster(32, 20);
  void harness.controller.renderForm(40, 20);
  harness.baseline = harness.actions.length;
  harness.send(ESC);
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(ENTER); // the Saved row was visibly drawn beside the picker
  assert.equal(harness.controller.focus, "form");
  assert.equal(harness.sinceActions().filter((action) => action.type === "saved-list").length, 1);
});

test("reserved shortcut: hidden shows, visible MAIN focuses sidebar, sidebar focus hides", () => {
  for (const options of [{}, { toggleKey: "f8" }] as const) {
    const packet = togglePacketFor(options);
    let invalidations = 0;
    const harness = makeController({ ...options, initialVisible: false, onInvalidate: () => { invalidations += 1; } });
    harness.controller.updateItems([makeItem({ id: "a" })]);
    harness.send(packet); // hidden -> show and focus sidebar
    assert.equal(harness.controller.visible, true);
    assert.equal(harness.controller.focus, "sidebar");
    assert.deepEqual(harness.actions, [{ type: "visibility", visible: true }]);
    rosterView(harness.controller, 40, 20);
    harness.send(DOWN); // New -> Quit
    harness.send(DOWN); // -> a
    harness.send(ENTER); // select a; the sidebar stays visible with MAIN focus
    assert.equal(harness.controller.focus, "main");
    harness.baseline = harness.actions.length;
    const invalidationsBefore = invalidations;

    harness.send(packet); // first press: focus only, no hide or resize
    assert.equal(harness.controller.visible, true);
    assert.equal(harness.controller.focus, "sidebar");
    assert.equal(harness.controller.selectedId, "a");
    assert.deepEqual(harness.sinceActions(), [], "no visibility (resize) or forward action");
    assert.equal(invalidations, invalidationsBefore + 1, "the focus change requests a redraw");

    harness.send(packet); // second press: hide and return focus to main
    assert.equal(harness.controller.visible, false);
    assert.equal(harness.controller.focus, "main");
    assert.deepEqual(harness.sinceActions(), [{ type: "visibility", visible: false }]);

    harness.send(packet); // hidden again -> show
    assert.equal(harness.controller.visible, true);
    assert.equal(harness.controller.focus, "sidebar");
    assert.deepEqual(harness.sinceActions(), [
      { type: "visibility", visible: false },
      { type: "visibility", visible: true },
    ]);
  }
});

test("visible-MAIN shortcut repeats/releases are consumed without a second step", () => {
  const harness = makeRoster(["a"]);
  harness.send(DOWN);
  harness.send(DOWN); // -> a
  harness.send(ENTER); // MAIN focus, sidebar visible
  harness.baseline = harness.actions.length;
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    harness.send(KITTY_ALT_LEFT_PRESS); // focus sidebar
    harness.send(KITTY_ALT_LEFT_REPEAT);
    harness.send(KITTY_ALT_LEFT_RELEASE);
    assert.equal(harness.controller.visible, true);
    assert.equal(harness.controller.focus, "sidebar");
    assert.deepEqual(harness.sinceActions(), [], "held chord neither hides nor forwards");
    harness.send(KITTY_ALT_LEFT_PRESS); // fresh press hides
    harness.send(KITTY_ALT_LEFT_REPEAT);
    harness.send(KITTY_ALT_LEFT_RELEASE);
    assert.equal(harness.controller.visible, false);
    assert.deepEqual(harness.sinceActions(), [{ type: "visibility", visible: false }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("visible sidebar with MAIN focus still forwards native keys unchanged", () => {
  const harness = makeRoster(["a"]);
  harness.send(DOWN);
  harness.send(DOWN); // -> a
  harness.send(ENTER); // MAIN focus, sidebar visible
  harness.baseline = harness.actions.length;
  const chunks = ["q", "Q", "\x03", ESC, DELETE, " ", "e", UP, ENTER];
  for (const chunk of chunks) {
    harness.send(chunk);
  }
  assert.deepEqual(harness.sinceActions(), chunks.map((data) => ({ type: "forward", data })));
  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "main");
});

test("wide layout renders roster and form as independent panes", () => {
  const harness = formWith();
  // render() dispatches to the focused pane (the form) with its cursor.
  const formPane = harness.controller.render(47, 23);
  assert.deepEqual(formPane.cursor, { column: 13, row: 3 });
  assert.ok(assertPaneSafe(formPane.lines, 47, 23)[0].includes("New session"));
  // The roster pane is still available beside it on wide terminals; its
  // return type carries no cursor, so it can never claim one.
  const roster = harness.controller.renderRoster(32, 23);
  const texts = assertPaneSafe(roster.lines, 32, 23);
  assert.ok(texts[0].includes("Sessions (1)"));
  assert.ok(texts.some((line) => line.includes("> New session")));
  assert.ok(!texts.join(" ").includes("d stop/remove"), "the sidebar-only action is hidden while the form owns input");
});

test("footer hints wrap across reserved rows and never ellipsize", () => {
  const harness = makeRoster(["a"]);
  for (const cols of [32, 40, 60]) {
    const texts = rosterView(harness.controller, cols, 10).texts;
    const footer = texts.join(" ");
    for (const hint of ["toggle", "enter open", "e edit name", "d stop/remove", "esc hide", "q quit", "space expand"]) {
      assert.ok(footer.includes(hint), `missing ${JSON.stringify(hint)} at ${cols} cols: ${JSON.stringify(texts)}`);
    }
    assert.ok(!texts.some((line) => line.includes("...")), `no ellipsized hints at ${cols} cols`);
  }
  // The form footer wraps the actual native keybinding labels.
  const form = formWith({ cols: 24 });
  const texts = assertPaneSafe(form.controller.render(24, 10).lines, 24, 10);
  const footer = texts.join(" ");
  assert.ok(footer.includes("enter create"), JSON.stringify(texts));
  assert.ok(footer.includes("esc cancel"), JSON.stringify(texts));
  assert.ok(footer.includes("external editor"), JSON.stringify(texts));
});

test("roster requires a visible entry row; otherwise it falls back to too-small", () => {
  const { controller } = makeController();
  // The complete footer (including the alt+right main hint) plus an entry
  // now needs 20x8; 20x7 leaves no room for an entry, so Enter would
  // activate an invisible target.
  const tooSmall = controller.render(20, 7);
  assert.ok(tooSmall.lines.some((line) => line.includes("too small")));
  assert.equal(tooSmall.cursor, undefined);

  // One more row keeps exactly one visible entry plus the complete hints.
  const fits = assertPaneSafe(controller.render(20, 8).lines, 20, 8);
  assert.ok(fits.some((line) => line.includes("> New session")), JSON.stringify(fits));
  const footer = fits.join(" ");
  for (const hint of ["toggle", "enter open", "e edit name", "d stop/remove", "esc hide", "q quit"]) {
    assert.ok(footer.includes(hint), `missing ${JSON.stringify(hint)}: ${JSON.stringify(fits)}`);
  }

  // An error row consumes the last entry slot at 32x6.
  controller.showError("boom");
  const tooSmallWithError = controller.render(32, 6);
  assert.ok(tooSmallWithError.lines.some((line) => line.includes("too small")));
  const fitsWithError = assertPaneSafe(controller.render(32, 7).lines, 32, 7);
  assert.ok(fitsWithError.some((line) => line.includes("> New session")), JSON.stringify(fitsWithError));
  assert.ok(fitsWithError.some((line) => line.includes("boom")));
  const footerWith = fitsWithError.join(" ");
  for (const hint of ["toggle", "enter open", "e edit name", "d stop/remove", "esc hide", "q quit"]) {
    assert.ok(footerWith.includes(hint), `missing ${JSON.stringify(hint)}: ${JSON.stringify(fitsWithError)}`);
  }
});

test("long validated toggle chords render in full, wrapping or falling back instead of truncating", () => {
  const chord = "ctrl+shift+alt+super+pageDown";
  const harness = makeController({ toggleKey: chord });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  assert.equal(harness.controller.focus, "sidebar");

  // Ample width: the complete label survives the wrap.
  const wide = assertPaneSafe(harness.controller.render(40, 8).lines, 40, 8);
  assert.ok(wide.some((line) => line.includes("Ctrl+Shift+Alt+Super+PageDown")), JSON.stringify(wide));

  // Tight width: the chord and removal hint wrap while an entry stays visible.
  const tight = assertPaneSafe(harness.controller.render(32, 7).lines, 32, 7);
  assert.ok(tight.some((line) => line.includes("Ctrl+Shift+Alt+Super+PageDown")), JSON.stringify(tight));
  assert.ok(tight.some((line) => line.includes("> New session")));

  // When even the wrapped chord leaves no entry row, the pane is truthfully
  // too small with no partial chord.
  const tooSmall = harness.controller.render(32, 5);
  assert.ok(tooSmall.lines.some((line) => line.includes("too small")));
  assert.ok(!tooSmall.lines.join("\n").includes("Ctrl+Shift"), "no partial chord in the fallback");
});

test("tiny form and confirm geometry falls back to a truthful too-small pane", () => {
  const form = formWith();
  // 24x8 cannot fit the header, editable field, status, and wrapped native hints.
  const tooSmallForm = form.controller.render(24, 8);
  assert.ok(tooSmallForm.lines.some((line) => line.includes("too small")));
  assert.equal(tooSmallForm.cursor, undefined);
  const fits = form.controller.render(24, 20);
  assert.deepEqual(fits.cursor, { column: 13, row: 3 });
  assertPaneSafe(fits.lines, 24, 20);

  const confirm = makeRoster(["alive"]);
  confirm.send("q");
  assert.equal(confirm.controller.focus, "confirm");
  const tooSmallConfirm = confirm.controller.render(13, 4);
  assert.ok(tooSmallConfirm.lines.some((line) => line.includes("too small")));
  // A usable confirm geometry shows the full wrapped hint text.
  const confirmTexts = assertPaneSafe(confirm.controller.render(32, 6).lines, 32, 6);
  const footer = confirmTexts.slice(-2).join(" ");
  assert.ok(footer.includes("enter/y = quit host"), JSON.stringify(confirmTexts));
  assert.ok(footer.includes("esc/n = cancel"), JSON.stringify(confirmTexts));
});

test("small panes degrade to a graceful bounded message, never a broken layout", () => {
  const { controller } = makeController();
  for (const [cols, rows] of [[1, 1], [11, 4], [10, 3], [20, 3]] as const) {
    const frame = controller.render(cols, rows);
    assertPaneSafe(frame.lines, cols);
    if (cols >= 10) {
      assert.ok(frame.lines.some((line) => line.includes("too small")));
    }
    assert.ok(frame.lines.length <= rows);
    assert.equal(frame.cursor, undefined);
  }
  const formHarness = formWith();
  // The form layout needs a bit more room than the roster.
  const tooSmallForm = formHarness.controller.render(20, 5);
  assert.ok(tooSmallForm.lines.some((line) => line.includes("too small")));
  assert.equal(tooSmallForm.cursor, undefined);
});

test("module purity: no process, fs, network, or TerminalSurface coupling", () => {
  const sourcePath = join(dirname(__filename), "../../src/session-host/sidebar.ts");
  assert.ok(existsSync(sourcePath), "sidebar source must be readable for the purity check");
  const source = readFileSync(sourcePath, "utf8");
  for (const banned of [
    "node:fs",
    "node:os",
    "node:child_process",
    "node:net",
    "node:http",
    "terminal-surface",
    "from \"./main\"",
    "from \"./instances\"",
    "from \"./terminal-surface\"",
  ]) {
    assert.ok(!source.includes(banned), `sidebar must not reference ${banned}`);
  }
});
// ---------------------------------------------------------------------------
// Deliberate saved-conversation picker (issue 323)
// ---------------------------------------------------------------------------

const SAVED_ROWS = [
  { id: "conv-1", file: "/agents/a/sessions/proj/one.jsonl", caption: "First conversation" },
  { id: "conv-2", file: "/agents/a/sessions/proj/two.jsonl", caption: "Second conversation" },
] as const;

/** Opens the saved-conversation picker from a roster with the given items. */
function savedPaneWith(ids: string[] = [], options: SidebarControllerOptions = {}): RosterHarness {
  const harness = makeRoster(ids, options);
  // Default selection is "new"; one UP lands on the saved entry.
  harness.send(UP);
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form", "the picker occupies the form pane slot");
  const action = harness.sinceActions().at(-1);
  assert.ok(action !== undefined && action.type === "saved-list", `expected saved-list, got ${JSON.stringify(action)}`);
  harness.baseline = harness.actions.length;
  return harness;
}

function savedView(harness: RosterHarness, cols = 40, rows = 10): string[] {
  const lines = harness.controller.render(cols, rows).lines;
  return assertPaneSafe(lines, cols, rows);
}

test("saved picker lists, highlights without acting, and opens a deliberate saved-open", () => {
  const harness = savedPaneWith(["a"]);
  const listAction = harness.actions.at(-1);
  assert.ok(listAction?.type === "saved-list");
  const requestId = listAction!.type === "saved-list" ? listAction.requestId : -1;

  // Loading state is truthful while the listing is outstanding.
  assert.ok(savedView(harness).some((line) => line.includes("Loading saved conversations...")));

  harness.controller.completeSavedList(requestId, [...SAVED_ROWS], 0);
  const texts = savedView(harness);
  assert.ok(texts.some((line) => line.includes("Saved conversations")));
  assert.ok(texts.some((line) => line.includes("> First conversation")), "first row highlighted by default");
  assert.ok(texts.some((line) => line.includes("Second conversation")));

  // Highlighting rows does nothing to any session: navigation emits no actions.
  harness.send(DOWN);
  harness.send(UP);
  assert.deepEqual(harness.sinceActions(), [], "arrows never emit actions");

  // Deliberate Enter opens the highlighted row exactly once.
  harness.send(ENTER);
  const open = harness.sinceActions().at(-1);
  assert.deepEqual(open, { type: "saved-open", requestId: requestId + 1, file: SAVED_ROWS[0].file, sessionId: "conv-1" });

  // A second Enter while the open is pending is refused with a notice.
  harness.send(ENTER);
  assert.equal(harness.sinceActions().length, 1, "no duplicate saved-open");
  assert.ok(savedView(harness, 40, 16).join(" ").replace(/\s+/g, " ").includes("A saved conversation is already starting"));

  // Completion activates the restored row as the Main input owner.
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "new-row" })]);
  harness.controller.completeSavedOpen(requestId + 1, "new-row");
  assert.equal(harness.controller.focus, "main", "the restored row becomes the active Main owner");
  assert.equal(harness.controller.selectedId, "new-row", "the restored row is highlighted as the active owner");
  assert.deepEqual(harness.focusedActions().at(-1), { type: "select", id: "new-row" });
});

test("saved mouse activation is draw-derived and retains pending-open duplicate guards", () => {
  const harness = savedPaneWith();
  const list = harness.actions.at(-1);
  assert.ok(list?.type === "saved-list");
  harness.controller.completeSavedList(list!.requestId, [...SAVED_ROWS], 0);
  const rows = savedView(harness, 40, 10);
  const firstRow = rows.findIndex((line) => line.includes("First conversation"));
  assert.ok(firstRow > 0);
  assert.equal(harness.controller.activateSavedAt(0, 0, 40, 10), false, "the saved header is not clickable");
  assert.equal(harness.controller.activateSavedAt(0, 7, 40, 10), false, "fixed details/footer rows are not entries");
  assert.equal(harness.controller.activateSavedAt(0, firstRow, 40, 10), true);
  assert.equal(harness.focusedActions().length, 1);
  assert.deepEqual(harness.focusedActions()[0], {
    type: "saved-open", requestId: list!.requestId + 1, file: SAVED_ROWS[0].file, sessionId: "conv-1",
  });
  assert.equal(harness.controller.activateSavedAt(0, firstRow, 40, 10), true,
    "a repeated click reaches the existing pending-open guard");
  assert.equal(harness.focusedActions().length, 1, "the click does not emit duplicate saved-open actions");
  assert.ok(savedView(harness, 40, 16).join(" ").replace(/\s+/g, " ").includes("A saved conversation is already starting"));

  const stale = savedPaneWith();
  const staleList = stale.actions.at(-1)!;
  assert.equal(staleList.type, "saved-list");
  stale.controller.completeSavedList(staleList.requestId, [...SAVED_ROWS], 0);
  const staleRows = savedView(stale, 40, 10);
  const staleFirst = staleRows.findIndex((line) => line.includes("First conversation"));
  stale.send(ESC); // dismissal invalidates the render-derived saved row map
  assert.equal(stale.controller.activateSavedAt(0, staleFirst, 40, 10), false,
    "a dismissed/stale render cannot authorize a row click");
  assert.deepEqual(stale.focusedActions(), [{ type: "saved-dismiss", pickerId: staleList.requestId }]);
});

test("Saved deletion confirms only a fully displayed target and consumes held confirm repeats", () => {
  const harness = savedPaneWith();
  const list = harness.actions.at(-1)!;
  assert.equal(list.type, "saved-list");
  harness.controller.completeSavedList(list.requestId, [...SAVED_ROWS], 0);
  savedView(harness, 40, 16);

  harness.send("\x04"); // native default app.session.delete = Ctrl+D
  const prepare = harness.actions.at(-1);
  assert.ok(prepare?.type === "saved-delete-prepare");
  assert.equal(prepare.id, SAVED_ROWS[0].id);
  assert.equal(prepare.file, SAVED_ROWS[0].file);
  assert.equal(harness.controller.completeSavedDeleteCheck(prepare.requestId, true), true);
  assert.equal(harness.controller.focus, "confirm");
  assert.equal(harness.controller.savedPickerRequestId, list.requestId);

  // A too-small fallback never enables Enter, even though the target remains frozen.
  assert.ok(harness.controller.render(20, 4).lines.some((line) => line.includes("too small")));
  harness.send(ENTER);
  assert.equal(harness.actions.filter((action) => action.type === "saved-delete").length, 0);

  const focusedConfirmation = assertPaneSafe(harness.controller.render(40, 20).lines, 40, 20).join("\n");
  assert.ok(focusedConfirmation.includes("Delete saved conversation?"), "standalone Sidebar rendering remains supported");
  const focusedToken = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(focusedToken !== undefined);

  const roster = assertPaneSafe(harness.controller.renderRoster(32, 20).lines, 32, 20).join("\n");
  const rightConfirmation = assertPaneSafe(harness.controller.renderSavedDeleteConfirmation(47, 20).lines, 47, 20).join("\n");
  assert.ok(roster.includes("Sessions"), "the left roster can render without changing confirmation focus");
  assert.ok(rightConfirmation.includes("Delete saved conversation?"));
  assert.ok(rightConfirmation.replace(/\s/g, "").includes(SAVED_ROWS[0].file.replace(/\s/g, "")),
    "the right-pane rendering also requires the complete exact file path");
  assert.equal(harness.controller.focus, "confirm", "placement does not change keyboard ownership");
  const renderToken = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(renderToken !== undefined && renderToken !== focusedToken,
    "the right-pane warning gets its own render token after the roster render revoked the earlier token");
  assert.equal(harness.controller.settleSavedDeleteConfirmationRender(focusedToken), false,
    "a superseded focused-pane candidate cannot authorize this placement");

  const confirmation = rightConfirmation;
  assert.ok(confirmation.includes("Delete saved conversation?"));
  assert.ok(renderToken !== undefined, "a complete right-pane render produces a candidate token, not authority");
  harness.send(ENTER);
  assert.equal(harness.actions.filter((action) => action.type === "saved-delete").length, 0,
    "rendering alone cannot authorize deletion before the output writer settles the frame");
  assert.equal(harness.controller.settleSavedDeleteConfirmationRender(renderToken), true);
  harness.send(ENTER);
  harness.send("\x1b[13;1:2u"); // held Enter repeat
  harness.send("\x1b[13;1:3u"); // release
  const deletions = harness.actions.filter((action) => action.type === "saved-delete");
  assert.equal(deletions.length, 1, "one deliberate confirm emits exactly one deletion request");
  assert.deepEqual(deletions[0], {
    type: "saved-delete",
    pickerId: list.requestId,
    requestId: prepare.requestId,
    id: SAVED_ROWS[0].id,
    file: SAVED_ROWS[0].file,
    revision: prepare.revision,
  });
  assert.equal(harness.controller.completeSavedDelete(prepare.requestId, "No file was deleted", false), true);
  assert.equal(harness.controller.focus, "form");
  assert.equal(harness.controller.savedPickerRequestId, list.requestId);
  assert.equal(harness.controller.savedQuery, "", "a refusal keeps the same query draft");
});

test("saved picker fencing: stale listings and late completions never seize the pane", () => {
  const harness = savedPaneWith();
  const first = harness.actions.at(-1);
  assert.ok(first?.type === "saved-list");
  const r1 = first!.type === "saved-list" ? first.requestId : -1;

  // Dismiss while the listing is pending: cancel is emitted, roster restored.
  harness.send(ESC);
  assert.deepEqual(harness.sinceActions(), [
    { type: "saved-dismiss", pickerId: r1 },
    { type: "saved-cancel", requestId: r1 },
  ]);
  assert.equal(harness.controller.focus, "sidebar");
  assert.ok(savedView(harness).some((line) => line.includes("Sessions (0)")));

  // Reopen (the saved entry is still highlighted): the stale first listing
  // is fenced; only the new request counts.
  harness.send(ENTER);
  const second = harness.sinceActions().at(-1);
  assert.ok(second?.type === "saved-list");
  const r2 = second!.type === "saved-list" ? second.requestId : -1;
  assert.equal(harness.controller.completeSavedList(r1, [...SAVED_ROWS], 0), false, "stale listing is ignored");
  assert.equal(harness.controller.completeSavedList(r2, [SAVED_ROWS[1]], 0), true);
  const texts = savedView(harness);
  assert.ok(texts.some((line) => line.includes("Second conversation")));
  assert.ok(!texts.some((line) => line.includes("First conversation")));

  // A late open completion after dismissal never highlights or steals focus.
  harness.send(ENTER);
  const open = harness.sinceActions().at(-1);
  assert.ok(open?.type === "saved-open");
  const r3 = open!.type === "saved-open" ? open.requestId : -1;
  harness.send(ESC); // dismiss while the open is pending
  assert.equal(harness.controller.focus, "sidebar");
  harness.controller.completeSavedOpen(r3, "ghost-row");
  assert.equal(harness.controller.selectedId, undefined, "late completion never highlights");
  assert.equal(harness.controller.focus, "sidebar");
});

test("saved picker shows truthful empty, unavailable, and partial issue-count notices", () => {
  const harness = savedPaneWith();
  const list = harness.actions.at(-1);
  assert.ok(list?.type === "saved-list");
  const r1 = list!.type === "saved-list" ? list.requestId : -1;

  harness.controller.completeSavedList(r1, [], 0);
  assert.ok(savedView(harness).some((line) => line.includes("No saved conversations")));

  // Unavailable: bounded sanitized notice (a hostile 500-char message with
  // escape sequences is stripped and clipped before it can appear).
  const second = savedPaneWith();
  const r2 = second.actions.at(-1)!;
  assert.equal(r2.type, "saved-list");
  second.controller.failSavedList(r2.requestId, "boom \x1b[31m" + "xx ".repeat(150));
  const texts = savedView(second, 40, 20);
  assert.ok(texts.some((line) => line.includes("! boom")));
  assert.ok(!texts.some((line) => line.includes("\x1b[31m")), "escape sequences are sanitized");
  assert.ok(texts.join("").replace(/[^x]/g, "").length <= 300, "notice stays within the 300-codepoint bound");

  // Partial: retained issue count is disclosed, not hidden.
  const third = savedPaneWith();
  const r3 = third.actions.at(-1)!;
  assert.equal(r3.type, "saved-list");
  third.controller.completeSavedList(r3.requestId, [...SAVED_ROWS], 3);
  const partial = savedView(third);
  assert.ok(partial.some((line) => line.includes("3 catalog issue(s) not shown")));

  // Tiny geometry falls back to the truthful too-small pane.
  assert.ok(savedView(harness, 24, 5).some((line) => line.includes("too small")));
});

test("saved picker: bracketed paste and Kitty repeats/releases never activate or dismiss", () => {
  const harness = savedPaneWith();
  const list = harness.actions.at(-1);
  assert.ok(list?.type === "saved-list");
  const r1 = list!.type === "saved-list" ? list.requestId : -1;
  harness.controller.completeSavedList(r1, [...SAVED_ROWS], 0);

  // A bracketed paste containing the reserved toggle is query text, never a host action.
  harness.send(`\x1b[200~${ALT_LEFT_LEGACY}\x1b[201~`);
  assert.ok(harness.sinceActions().every((action) => action.type === "saved-search"), "paste may search, but never dismisses or activates");
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;

  // Kitty repeat and release of Enter/Escape are inert.
  harness.send("\x1b[13;1:2u"); // Enter repeat
  harness.send("\x1b[13;1:3u"); // Enter release
  harness.send("\x1b[27;1:2u"); // Escape repeat
  harness.send("\x1b[27;1:3u"); // Escape release
  assert.deepEqual(harness.sinceActions(), [], "repeats and releases never activate or dismiss");
  assert.equal(harness.controller.focus, "form");

  // The initial presses still work.
  savedView(harness);
  harness.send(ENTER);
  assert.ok(harness.sinceActions().at(-1)?.type === "saved-open");
});

test("saved picker: reserved toggle dismisses like the other forms", () => {
  const harness = savedPaneWith();
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.visible, false, "toggle hides the pane");
  assert.equal(harness.controller.focus, "main");
  assert.ok(harness.sinceActions().some((action) => action.type === "visibility" && action.visible === false));
});

test("saved picker: roster Enter repeat does not re-open the picker", () => {
  const harness = makeRoster(["a"]);
  harness.send(UP); // new -> saved
  assert.equal(harness.controller.focus, "sidebar");
  harness.send("\x1b[13;1:2u"); // Enter repeat on the saved entry
  assert.equal(harness.controller.focus, "sidebar", "repeat never opens the picker");
  assert.deepEqual(harness.sinceActions(), []);
  harness.send(ENTER); // initial press opens it
  assert.equal(harness.controller.focus, "form");
});

test("held Enter after a completed saved-open is fenced out of the newly focused child", () => {
  const harness = savedPaneWith(["a"]);
  const list = harness.actions.at(-1);
  assert.ok(list?.type === "saved-list");
  const r1 = list!.type === "saved-list" ? list.requestId : -1;
  harness.controller.completeSavedList(r1, [...SAVED_ROWS], 0);

  // The deliberate Enter opens the highlighted row.
  savedView(harness);
  harness.send(ENTER);
  const open = harness.sinceActions().at(-1);
  assert.ok(open?.type === "saved-open");
  const r2 = open!.type === "saved-open" ? open.requestId : -1;

  // Completion activates the restored row as the Main input owner.
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "new-row" })]);
  harness.controller.completeSavedOpen(r2, "new-row");
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.selectedId, "new-row");
  assert.deepEqual(harness.focusedActions().at(-1), { type: "select", id: "new-row" });
  harness.baseline = harness.actions.length;
  rosterView(harness.controller, 40, 20); // the roster replaces the picker on screen

  // The held Enter's repeat and release are consumed, never replayed into the child.
  harness.send("\x1b[13;1:2u"); // Enter repeat
  harness.send("\x1b[13;1:3u"); // Enter release
  assert.deepEqual(harness.sinceActions(), [], "the submission repeat/release never reaches the child");

  // A fresh press is ordinary native input for the new owner.
  harness.send(ENTER);
  assert.deepEqual(harness.sinceActions(), [{ type: "forward", data: ENTER }]);
});

test("streamed paste containing the toggle packet never dismisses the saved picker", () => {
  const harness = savedPaneWith();
  const list = harness.actions.at(-1);
  assert.ok(list?.type === "saved-list");
  void list.requestId;

  // Streamed paste: start marker, a body chunk equal to the reserved toggle,
  // then the end marker — every chunk stays opaque to the picker.
  harness.send("\x1b[200~");
  harness.send(ALT_LEFT_LEGACY);
  harness.send("\x1b[201~");
  assert.ok(harness.sinceActions().every((action) => action.type === "saved-search"), "paste may search but never dismisses or cancels");
  assert.equal(harness.controller.focus, "form", "the picker stays open");

  // A fresh toggle press outside any paste still dismisses.
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.focus, "main");
});

test("saved picker distinguishes empty, failed, and issue-bearing zero-row listings", () => {
  // Failed listing: the error notice is shown, never an empty-catalog claim.
  const failed = savedPaneWith();
  const rf = failed.actions.at(-1)!;
  assert.equal(rf.type, "saved-list");
  failed.controller.failSavedList(rf.requestId, "Saved conversations are unavailable in this host");
  let texts = savedView(failed, 40, 16);
  assert.ok(texts.some((line) => line.includes("unavailable")));
  assert.ok(!texts.some((line) => line.includes("No saved conversations")), "failure is not an empty catalog");

  // Issue-bearing zero rows: the listing succeeded but nothing could be listed.
  const issues = savedPaneWith();
  const ri = issues.actions.at(-1)!;
  assert.equal(ri.type, "saved-list");
  issues.controller.completeSavedList(ri.requestId, [], 2);
  texts = savedView(issues, 40, 16);
  assert.ok(texts.some((line) => line.includes("No conversations could be listed")));
  assert.ok(!texts.some((line) => line.includes("No saved conversations")));

  // Successful issue-free empty: the truthful empty notice.
  const empty = savedPaneWith();
  const re = empty.actions.at(-1)!;
  assert.equal(re.type, "saved-list");
  empty.controller.completeSavedList(re.requestId, [], 0);
  texts = savedView(empty);
  assert.ok(texts.some((line) => line.includes("No saved conversations")));
});

test("rename failure notices use set/verify wording, never persistence claims", () => {
  const tuple = { sessionId: "session-123", epoch: 7, name: "Observed title" };
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([makeItem({ id: "a", nativeSession: tuple })]);
  harness.send(UP); // New -> Saved conversations
  harness.send(UP); // -> the existing row
  harness.send("e");
  assert.equal(harness.controller.openEdit({ id: "a", nativeSession: tuple, currentName: tuple.name }), true);
  harness.send("Replacement");
  harness.send(ENTER);
  const rename = harness.focusedActions().at(-1);
  assert.ok(rename?.type === "rename");

  harness.controller.completeRename(rename!.requestId, "setter-failed");
  let text = savedView(harness, 60, 12).join(" ").replace(/\s+/g, " ");
  assert.ok(text.includes("Pi could not set the new session name"), `setter notice: ${text}`);
  assert.ok(!text.toLowerCase().includes("persist"), "no persistence claim on setter failure");

  // The failed form retains its draft; resubmit for the verification-failed wording.
  harness.send(ENTER);
  const second = harness.focusedActions().at(-1);
  assert.ok(second?.type === "rename");
  harness.controller.completeRename(second!.requestId, "verification-failed");
  text = savedView(harness, 60, 12).join(" ").replace(/\s+/g, " ");
  assert.ok(text.includes("Pi could not verify the native session name"), `verification notice: ${text}`);
  assert.ok(!text.toLowerCase().includes("persist"), "no persistence claim on verification failure");
});

test("saved picker footer shows the complete keyboard hints with tiny-terminal fallback", () => {
  const harness = savedPaneWith(["a"]);
  const list = harness.actions.at(-1);
  assert.ok(list?.type === "saved-list");
  harness.controller.completeSavedList(list!.requestId, [...SAVED_ROWS], 0);
  const texts = savedView(harness, 48, 12).join(" ").replace(/\s+/g, " ");
  for (const hint of ["toggle", "up/down select", "enter open", "esc/ctrl+c back", "ctrl+d delete", "ctrl+backspace empty"]) {
    assert.ok(texts.includes(hint), `missing hint ${hint} in: ${texts}`);
  }
  // Tiny geometry falls back to the truthful too-small pane.
  assert.ok(savedView(harness, 20, 4).some((line) => line.includes("too small")));
});

test("n detaches only the local content view and leaves every row alone", () => {
  const harness = makeRoster(["a", "b"]);
  rosterView(harness.controller, 60, 24);
  harness.send(UP); // Saved conversations
  harness.send(UP); // the last session row
  assert.equal(harness.controller.selectedId, "b");
  harness.baseline = harness.actions.length;

  harness.send("n");
  assert.deepEqual(harness.focusedActions(), [{ type: "detach-view" }],
    "the local detach is its own action: never select, stop, remove, quit, or forwarded child input");
  assert.equal(harness.controller.focus, "sidebar", "detaching the view keeps the operator in the roster");
  assert.equal(harness.controller.visible, true, "the roster stays open with every row still listed");
  assert.equal(harness.controller.selectedId, "b", "the highlighted row is not moved or removed");

  // Displaying a session again is the ordinary row activation: no restart, and
  // the row the operator picks is the row that comes back.
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().at(-1), { type: "select", id: "b" });
  assert.equal(harness.focusedActions().some((action) => action.type === "resume-row"), false,
    "re-displaying a live session never restarts it");
});

test("a held n never re-fires the local view detach", () => {
  const harness = makeRoster(["a"]);
  rosterView(harness.controller, 60, 24);
  harness.baseline = harness.actions.length;
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    harness.send("\x1b[110u"); // fresh `n`
    harness.send("\x1b[110;1:2u"); // held repeat
    harness.send("\x1b[110;1:3u"); // release
  } finally {
    setKittyProtocolActive(previous);
  }
  assert.deepEqual(harness.focusedActions(), [{ type: "detach-view" }],
    "one deliberate press, one detach; a held key and its release are inert");
});

test("n typed in a text field is content, not a local view detach", () => {
  const tuple = { sessionId: "session-123", epoch: 7, name: "Observed title" };
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([makeItem({ id: "a", nativeSession: tuple, label: "stale row label" })]);
  assertPaneSafe(harness.controller.renderRoster(48, 14).lines, 48, 14);
  harness.send(UP); // Saved conversations
  harness.send(UP); // the session row
  harness.send("e");
  assert.equal(harness.controller.openEdit({ id: "a", nativeSession: tuple, currentName: tuple.name }), true);
  harness.baseline = harness.actions.length;

  harness.send("n");
  harness.send("o");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "rename", requestId: 1, id: "a", expectedSessionId: "session-123",
    expectedSessionEpoch: 7, name: "no",
  }, "the field keeps the typed letters");
  assert.equal(harness.focusedActions().some((action) => action.type === "detach-view"), false,
    "a detached-view key never fires from inside a text field");
});

test("detaching the local view cancels an in-flight exited-row restart", () => {
  const tuple = { sessionId: "session-123", epoch: 1, name: "Nine" };
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([makeItem({ id: "a", lifecycle: "exited", hasLiveProcess: false, nativeSession: tuple })]);
  rosterView(harness.controller, 60, 24);
  harness.send(UP); // Saved conversations
  harness.send(UP); // the exited card
  harness.send(ENTER);
  assert.deepEqual(harness.sinceActions(), [{ type: "resume-row", requestId: 1, id: "a" }]);
  harness.baseline = harness.actions.length;

  harness.send("n");
  assert.deepEqual(harness.sinceActions(), [
    { type: "resume-row-cancel", requestId: 1 },
    { type: "detach-view" },
  ], "the operator's choice wins and the pending restart is cancelled");
  assert.equal(harness.controller.completeRowResume(1, "a", "late-row"), false,
    "a late restart completion cannot display itself over the detached view");
});

// ---------------------------------------------------------------------------
// New form Host line (requester-side remote create)
//
// The New form's ONE Host line names Local until the operator changes it. Its
// identity is the saved destination handle plus the DTO's exact observed owner
// run; a label, index, endpoint, or fingerprint is never identity. Every ACTUAL
// change clears the workspace atomically, the same destination is a no-op, and a
// remote submission needs the exact drawn-and-written form.
// ---------------------------------------------------------------------------

/** One destination DTO the Host line can offer. */
function newFormPeerHost(options: {
  readonly id: string;
  readonly label: string;
  readonly state?: PeerUiHost["state"];
  readonly hostRunId?: string | null;
  readonly message?: string | null;
}): PeerUiHost {
  const run = options.hostRunId === undefined ? "run-a" : options.hostRunId;
  return {
    id: options.id,
    label: options.label,
    host: "10.0.0.5",
    port: 8443,
    state: options.state ?? "connected",
    fingerprint: null,
    message: options.message ?? null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: {
      state: run === null ? "never" : "current",
      rows: [],
      ...(run === null ? {} : { hostRunId: run }),
    },
  };
}

function newFormPeerSnapshot(hosts: readonly PeerUiHost[]): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: null,
    identityFingerprint: null,
    listener: { state: "off", host: null, port: null, message: null },
    hosts,
    trustedPeers: [],
    consents: [],
    notice: null,
  };
}

/** Column of the drawn Host value (`  Host: ` is eight cells wide). */
const HOST_VALUE_COLUMN = 9;
const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";

interface HostLineHarness extends Harness {
  render(): { lines: string[]; cursor?: { column: number; row: number } };
  texts(): string[];
}

/** Publishes the destinations and draws the whole New form once. */
function hostLineForm(
  hosts: readonly PeerUiHost[],
  geometry: { cols?: number; rows?: number; options?: SidebarControllerOptions } = {},
): HostLineHarness {
  const cols = geometry.cols ?? 48;
  const rows = geometry.rows ?? 14;
  // The same harness object is extended in place: its action helpers read this
  // object's own baseline, so a mid-test baseline move still applies.
  const harness = formWith({
    cols,
    rows,
    ...(geometry.options === undefined ? {} : { options: geometry.options }),
  }) as Harness & Partial<HostLineHarness>;
  harness.controller.setPeerUiSnapshot(newFormPeerSnapshot(hosts));
  const render = (): { lines: string[]; cursor?: { column: number; row: number } } =>
    harness.controller.render(cols, rows);
  render();
  harness.baseline = harness.actions.length;
  harness.render = render;
  harness.texts = () => assertPaneSafe(render().lines, cols, rows);
  return harness as HostLineHarness;
}

/** The exact `create-on-peer` actions emitted since the baseline. */
function createsOnPeer(harness: Harness): Extract<SidebarAction, { type: "create-on-peer" }>[] {
  return harness.focusedActions().filter(
    (action): action is Extract<SidebarAction, { type: "create-on-peer" }> => action.type === "create-on-peer",
  );
}

/** Selects the next Host choice with real host input only. */
function cycleHost(harness: Harness): void {
  harness.send(SHIFT_TAB);
  harness.send(DOWN);
  harness.send(TAB);
}

test("the New form opens on Local and its ordinary path submission is unchanged", () => {
  const harness = hostLineForm([newFormPeerHost({ id: "lab-a", label: "Lab Alpha" })], { cols: 40, rows: 12 });
  const texts = harness.texts();
  assert.equal(texts[0]?.includes("New session"), true);
  assert.equal(texts[1]?.startsWith("  Host: [ Local ]"), true, JSON.stringify(texts));
  assert.equal(texts[3]?.startsWith("> Workspace: "), true,
    "the workspace editor keeps its own labelled body row");
  harness.send("/workspace");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [
    { type: "create", requestId: 1, workspace: "/workspace" },
  ], "a Local submission is exactly the existing local create action");
  assert.deepEqual(createsOnPeer(harness), []);
});

test("Shift+Tab reaches the Host line and Tab returns to the workspace", () => {
  const harness = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha" }),
  ], { cols: 48, rows: 14 });
  harness.send("/draft");
  assert.equal(harness.render().cursor?.row, 3, "the workspace editor keeps the caret while it has the focus");

  harness.send(SHIFT_TAB);
  const hostFocused = harness.render();
  assert.equal(assertPaneSafe(hostFocused.lines, 48, 14)[1]?.startsWith("> Host: [ Local ]"), true,
    "the drawn Host line takes the form's focus marker");
  assert.equal(hostFocused.cursor?.row, 1, "the hardware cursor moves to the drawn Host line");

  harness.send(DOWN);
  const afterTexts = harness.texts();
  assert.equal(afterTexts[1]?.startsWith("> Host: [ Lab Alpha ]"), true, JSON.stringify(afterTexts));
  assert.equal(afterTexts[3]?.slice(13).trim(), "", "the actual Host change cleared the workspace value");
  assert.deepEqual(harness.focusedActions(), [], "cycling a host emits no backend action by itself");

  harness.send(TAB);
  assert.equal(harness.texts()[1]?.startsWith("  Host: [ Lab Alpha ]"), true,
    "Tab returns the focus to the workspace editor");
});

test("every actual Host change clears the workspace and the same destination keeps it", () => {
  const harness = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha" }),
    newFormPeerHost({ id: "lab-b", label: "Lab Beta" }),
  ], { cols: 48, rows: 14 });
  const hostLine = (): string => harness.texts()[1] ?? "";
  const body = (): string => (harness.texts()[3] ?? "").slice(13).trim();
  /** One deliberate host change: focus the Host line, step once, return to the body. */
  const step = (): void => {
    harness.send(SHIFT_TAB);
    harness.send(DOWN);
    harness.send(TAB);
  };

  harness.send("/local-draft");
  assert.equal(body(), "/local-draft");
  step(); // Local -> Lab Alpha: an actual change
  assert.equal(hostLine().includes("[ Lab Alpha ]"), true, JSON.stringify(harness.texts()));
  assert.equal(body(), "");
  harness.send("/remote-draft");
  assert.equal(body(), "/remote-draft");

  // Re-listing the SAME destination (an ordinary roster update) is not a change:
  // the draft, its caret, and the form stay exactly as the operator left them.
  const before = harness.render();
  harness.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", message: "Roster resyncing" }),
    newFormPeerHost({ id: "lab-b", label: "Lab Beta" }),
  ]));
  const after = harness.render();
  assert.deepEqual(after.cursor, before.cursor, "the caret is unchanged");
  assert.equal(body(), "/remote-draft", "ordinary snapshot output never clears the field");
  assert.deepEqual(harness.focusedActions(), [], "no action is emitted by a snapshot update");

  step(); // Lab Alpha -> Lab Beta: another actual change
  assert.equal(hostLine().includes("[ Lab Beta ]"), true, JSON.stringify(harness.texts()));
  assert.equal(body(), "");
  step(); // Lab Beta -> Local: back to the default
  assert.equal(hostLine().includes("[ Local ]"), true, JSON.stringify(harness.texts()));
  assert.equal(body(), "");
  step(); // Local -> Lab Alpha again: no per-host history is restored
  assert.equal(body(), "", "a returning host starts empty; the previous value is never restored");
});

test("a remote Host uses a plain owner-path entry, never the local path completer", () => {
  const kinds: string[] = [];
  const harness = formWith({
    options: {
      createTextField: (options) => {
        kinds.push(options.kind);
        const callbacks = {
          initialText: options.initialText,
          workspaceBasePath: join(process.cwd(), ".pi-session-host-test-missing-workspace"),
          onInvalidate: options.onInvalidate,
          onSubmit: options.onSubmit,
          onCancel: options.onCancel,
          onReject: options.onReject,
        };
        return {
          field: options.kind === "plain"
            ? createPlainOwnerWorkspaceField(callbacks)
            : options.kind === "path"
              ? createSessionHostTextField({ ...callbacks, kind: "path" })
              : createSessionHostTextField({
                kind: "name",
                initialText: options.initialText,
                onInvalidate: options.onInvalidate,
                onSubmit: options.onSubmit,
                onCancel: options.onCancel,
                onReject: options.onReject,
              }),
        };
      },
    },
  });
  harness.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha" }),
  ]));
  void harness.controller.render(48, 14);
  assert.deepEqual(kinds, ["path"], "the default Local New form keeps the native path editor");
  harness.send(SHIFT_TAB);
  harness.send(DOWN);
  assert.deepEqual(kinds, ["path", "plain"],
    "a remote destination gets plain owner-interpreted entry with no requester filesystem completion");
  harness.send(TAB);
  harness.send("C:\\Users\\owner\\My Projects\\pi");
  assert.equal(assertPaneSafe(harness.controller.render(48, 14).lines, 48, 14)[3]
    ?.includes("C:\\Users\\owner\\My Projects\\pi"), true, "raw Windows path text is accepted verbatim");
});

test("the plain owner entry keeps the workspace bound and never reads a local path", async () => {
  // A rename field's 1024-byte name bound would reject these; the plain owner
  // entry carries the workspace bound the create contract actually accepts.
  const longAscii = `/${"a".repeat(1500)}`;
  const longUnicode = `/${"雪".repeat(600)}`;
  assert.equal(Buffer.byteLength(longAscii, "utf8") > 1024, true, "the ASCII fixture exceeds the name bound");
  assert.equal(Buffer.byteLength(longUnicode, "utf8") > 1024, true, "the multibyte fixture exceeds the name bound");
  for (const value of [longAscii, longUnicode]) {
    const field = createPlainOwnerWorkspaceField({
      initialText: "",
      workspaceBasePath: process.cwd(),
    });
    try {
      assert.equal(field.setText(value), true, "the plain owner entry accepts the workspace bound");
      assert.equal(field.getValue(), value, "the value is carried verbatim, never normalized");
    } finally {
      field.dispose();
    }
  }

  // A path prefix inside this repository offers nothing: completion is not merely
  // dismissed for this field, it has no provider that could ever list anything.
  const field = createPlainOwnerWorkspaceField({
    initialText: "",
    workspaceBasePath: process.cwd(),
  });
  try {
    field.handleInput(join(process.cwd(), "packag"));
    field.handleInput(TAB);
    // One real timer tick, past the Editor's completion debounce.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(field.isShowingAutocomplete(), false,
      "no local completion list is ever offered for owner-interpreted text");
    assert.equal(field.getText().endsWith("packag"), true, "the typed text is unchanged");
  } finally {
    field.dispose();
  }
});

test("a missing owner run or a disconnected destination refuses truthfully", () => {
  const missingRun = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: null }),
  ], { cols: 100, rows: 14 });
  cycleHost(missingRun);
  missingRun.send("/srv/owner/project");
  missingRun.send(ENTER);
  assert.deepEqual(createsOnPeer(missingRun), [], "an unobserved owner run is never guessed");
  assert.equal(missingRun.texts().join(" ").includes(
    "That destination's owner run was not observed; nothing was sent"), true);

  const disconnected = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha" }),
  ], { cols: 100, rows: 14 });
  disconnected.send(SHIFT_TAB);
  disconnected.send(DOWN);
  disconnected.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", state: "disconnected" }),
  ]));
  disconnected.send(TAB);
  disconnected.send("/srv/owner/project");
  disconnected.send(ENTER);
  assert.deepEqual(createsOnPeer(disconnected), [], "a disconnected destination never falls back to Local");
  const disconnectedTexts = disconnected.texts();
  assert.equal(disconnectedTexts[1]?.includes("Lab Alpha"), true,
    "the chosen destination stays named instead of silently becoming Local");
  assert.equal(disconnectedTexts.join(" ").includes(
    "That destination is disconnected or gone; nothing was sent"), true);
});

test("a remote submission needs the exact drawn and written form", () => {
  const harness = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ], { cols: 100, rows: 14 });
  cycleHost(harness);
  harness.send("/srv/owner/project");
  // The harness's send only routes input: the candidate exists once the pane has
  // actually been rendered with this value.
  harness.texts();
  const presentation = harness.controller.captureCreateFormPresentation();
  assert.ok(presentation !== undefined, "the complete render drew a candidate");
  assert.equal(presentation!.hostKind, "remote");
  assert.equal(presentation!.hostId, "lab-a");
  assert.equal(presentation!.hostRunId, "run-a");
  assert.equal(presentation!.workspace, "/srv/owner/project");

  // Not written yet: nothing is sent.
  harness.send(ENTER);
  assert.deepEqual(createsOnPeer(harness), []);
  assert.equal(harness.texts().join(" ").includes(
    "That New session form is not the displayed form; nothing was sent"), true,
  "the refusal is the fixed truthful notice");

  // The refusal reopened the field; this render is the candidate that gets the
  // writer receipt, and it is submitted with NO render in between.
  harness.texts();
  const ready = harness.controller.captureCreateFormPresentation();
  assert.ok(ready !== undefined);
  assert.equal(harness.controller.settleCreateFormRender(ready!.renderToken), true);
  harness.send(ENTER);
  const creates = createsOnPeer(harness);
  assert.equal(creates.length, 1, "exactly one remote create is emitted");
  assert.deepEqual(creates[0], {
    type: "create-on-peer",
    requestId: creates[0]!.requestId,
    formGeneration: ready!.formGeneration,
    renderToken: ready!.renderToken,
    hostId: "lab-a",
    hostRunId: "run-a",
    workspace: "/srv/owner/project",
  });
  assert.equal(harness.controller.focus, "form", "the form stays pending while the owner is asked");

  // A different owner run is never selected on this request's behalf.
  harness.controller.completeCreateOnPeer(creates[0]!.requestId, { hostRunId: "run-b", rowId: "row-a" });
  assert.equal(harness.focusedActions().some((action) => action.type === "select-remote"), false,
    "a mismatched returned run is never substituted");
  assert.equal(harness.texts().join(" ").includes(
    "The remote host reported a different owner run; nothing was selected"), true);
});

test("the exact started reply selects the returned run and row, and a late one never steals", () => {
  const harness = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ], { cols: 100, rows: 14 });
  const submit = (): Extract<SidebarAction, { type: "create-on-peer" }> => {
    cycleHost(harness);
    harness.send("/srv/owner/project");
    harness.texts(); // the drawn candidate exists only after this render
    const drawn = harness.controller.captureCreateFormPresentation();
    assert.ok(drawn !== undefined);
    harness.controller.settleCreateFormRender(drawn!.renderToken);
    harness.send(ENTER);
    const emitted = createsOnPeer(harness).at(-1);
    assert.ok(emitted !== undefined, "the written remote form submits");
    return emitted!;
  };
  const first = submit();
  harness.controller.completeCreateOnPeer(first.requestId, { hostRunId: "run-a", rowId: "row-a" });
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "select-remote", hostId: "lab-a", hostRunId: "run-a", rowId: "row-a",
  }, "the owner's own started fact selects exactly the returned run and row");
  assert.equal(harness.controller.focus, "main", "the submitted form hands the view to the selected remote row");
  assert.equal(harness.focusedActions().some((action) => action.type === "select"), false,
    "no local row is activated, accepted, or fabricated");

  // Reopening the New form and submitting again: the FIRST request's late reply
  // is stale and must not steal the newer form.
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.focus, "sidebar");
  rosterView(harness.controller, 40, 20);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;
  const second = submit();
  harness.controller.completeCreateOnPeer(first.requestId, { hostRunId: "run-a", rowId: "row-late" });
  assert.equal(harness.focusedActions().some((action) => action.type === "select-remote"), false,
    "a superseded request never selects, even with a matching run");
  assert.equal(harness.controller.focus, "form", "the newer form keeps the focus it owns");
  harness.controller.completeCreateOnPeer(second.requestId, { hostRunId: "run-a", rowId: "row-b" });
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "select-remote", hostId: "lab-a", hostRunId: "run-a", rowId: "row-b",
  });
});

test("the Host line answers only its own drawn geometry and its own option list", () => {
  const harness = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha" }),
    newFormPeerHost({ id: "lab-b", label: "Lab Beta" }),
  ], { cols: 48, rows: 14 });
  const shown = harness.controller.captureMousePresentation();
  assert.equal(shown.activateFormHostAt(HOST_VALUE_COLUMN, 1, 48, 14), true,
    "a press on the drawn Host value cycles the one selection");
  assert.equal(harness.texts()[1]?.includes("[ Lab Alpha ]"), true,
    "the drawn Host line now names the next destination");
  assert.equal(shown.activateFormHostAt(HOST_VALUE_COLUMN, 2, 48, 14), false,
    "a press on the row this render drew as the workspace body never touches the Host line");
  assert.equal(shown.activateFormHostAt(HOST_VALUE_COLUMN, 1, 40, 14), false,
    "a different pane geometry can never reuse the captured map");

  // A press elsewhere on the drawn row only focuses the control.
  const focused = harness.controller.captureMousePresentation();
  assert.equal(focused.activateFormRowAt(1, 1, 48, 14), true);
  assert.equal(harness.texts()[1]?.startsWith("> Host: "), true);

  // A stale option list is refused as well: same drawn row, changed list.
  const stale = harness.controller.captureMousePresentation();
  harness.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", state: "disconnected" }),
    newFormPeerHost({ id: "lab-b", label: "Lab Beta" }),
  ]));
  harness.render();
  assert.equal(stale.activateFormHostAt(HOST_VALUE_COLUMN, 1, 48, 14), false,
    "a press captured before the option list changed cannot act on the new list");
});

test("an identical redraw keeps the earned receipt and a real change needs a new write", () => {
  const harness = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha" }),
  ], { cols: 100, rows: 14 });
  cycleHost(harness);
  harness.send("/srv/owner/project");
  harness.texts();
  const earned = harness.controller.captureCreateFormPresentation();
  assert.ok(earned !== undefined);
  assert.equal(harness.controller.settleCreateFormRender(earned!.renderToken), true);

  // An unrelated roster repaint that draws the identical form keeps the same
  // candidate, so the receipt it already earned is preserved.
  harness.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", message: "Roster resyncing" }),
  ]));
  harness.texts();
  const redrawn = harness.controller.captureCreateFormPresentation();
  assert.equal(redrawn?.renderToken, earned!.renderToken,
    "an identical complete redraw is the same drawn candidate");
  harness.send(ENTER);
  assert.equal(createsOnPeer(harness).length, 1,
    "the earned receipt survives an unrelated repaint and submits once");

  // A genuinely different source is a new unwritten candidate: identical bytes
  // can never inherit the previous receipt.
  const changed = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ], { cols: 100, rows: 14 });
  cycleHost(changed);
  changed.send("/srv/owner/project");
  changed.texts();
  const before = changed.controller.captureCreateFormPresentation();
  assert.ok(before !== undefined);
  assert.equal(changed.controller.settleCreateFormRender(before!.renderToken), true);
  changed.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-b" }),
  ]));
  changed.texts();
  const after = changed.controller.captureCreateFormPresentation();
  assert.notEqual(after?.renderToken, before!.renderToken,
    "a changed owner run mints its own candidate");
  assert.equal(after?.hostRunId, "run-b", "the new candidate names the run it was drawn with");
  changed.send(ENTER);
  assert.deepEqual(createsOnPeer(changed), [],
    "a changed owner run needs its own written frame before anything is sent");
});

test("a destination run or connection transition retires the drawn receipt for good", () => {
  const UNCERTAIN = "UNCERTAIN: the remote create may have been handed off; outcome unknown";

  // A -> B -> A BEFORE submission: the transition itself retires, so the
  // returning run never reuses the receipt written for the earlier one.
  const runChanged = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ], { cols: 100, rows: 14 });
  cycleHost(runChanged);
  runChanged.send("/srv/owner/project");
  runChanged.texts();
  const written = runChanged.controller.captureCreateFormPresentation();
  assert.ok(written !== undefined);
  assert.equal(runChanged.controller.settleCreateFormRender(written!.renderToken), true);
  runChanged.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-b" }),
  ]));
  runChanged.texts();
  runChanged.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ]));
  runChanged.texts();
  const revived = runChanged.controller.captureCreateFormPresentation();
  assert.notEqual(revived?.renderToken, written!.renderToken,
    "run A -> B -> A mints a fresh unwritten candidate");
  runChanged.send(ENTER);
  assert.deepEqual(createsOnPeer(runChanged), [],
    "the retired receipt is never submitted again after the run returns");

  // disconnected -> connected BEFORE submission behaves the same way.
  const reconnected = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ], { cols: 100, rows: 14 });
  cycleHost(reconnected);
  reconnected.send("/srv/owner/project");
  reconnected.texts();
  const connectedWritten = reconnected.controller.captureCreateFormPresentation();
  assert.equal(reconnected.controller.settleCreateFormRender(connectedWritten!.renderToken), true);
  reconnected.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a", state: "disconnected" }),
  ]));
  reconnected.texts();
  reconnected.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ]));
  reconnected.texts();
  reconnected.send(ENTER);
  assert.deepEqual(createsOnPeer(reconnected), [],
    "a reconnect never reuses the receipt written before the drop");

  // WHILE QUEUED: the pending request loses this side's ownership with truthful
  // uncertainty, and a late started reply never selects from it.
  const queued = hostLineForm([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ], { cols: 100, rows: 14 });
  cycleHost(queued);
  queued.send("/srv/owner/project");
  queued.texts();
  const queuedCandidate = queued.controller.captureCreateFormPresentation();
  assert.equal(queued.controller.settleCreateFormRender(queuedCandidate!.renderToken), true);
  queued.send(ENTER);
  const submitted = createsOnPeer(queued);
  assert.equal(submitted.length, 1, "the written form submitted exactly once");
  assert.equal(queued.controller.createOnPeerStillCurrent(submitted[0]!), true,
    "the queued proof holds while the destination is unchanged");
  queued.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-b" }),
  ]));
  assert.equal(queued.texts().join(" ").includes(UNCERTAIN), true,
    "the retirement is stated as uncertainty, never as a cancellation or a failure");
  queued.controller.setPeerUiSnapshot(newFormPeerSnapshot([
    newFormPeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a" }),
  ]));
  queued.texts();
  assert.equal(queued.controller.createOnPeerStillCurrent(submitted[0]!), false,
    "the queued proof stays false after the run returns");
  queued.send(ENTER);
  assert.equal(createsOnPeer(queued).length, 1, "a returning run never re-arms the request");
  queued.controller.completeCreateOnPeer(submitted[0]!.requestId, { hostRunId: "run-a", rowId: "row-a" });
  assert.equal(queued.focusedActions().some((action) => action.type === "select-remote"), false,
    "a late started reply never selects from a retired receipt");
});

// ---------------------------------------------------------------------------
// Network menu: viewer Remote input/copy and owner remote history deletion
// ---------------------------------------------------------------------------

const NETWORK_COLS = 100;
const NETWORK_ROWS = 30;

function networkSettings(overrides: Partial<PeerUiSettings> = {}): PeerUiSettings {
  return {
    hostingEnabled: false,
    bindHost: "",
    bindPort: null,
    autoReconnect: false,
    bellEnabled: true,
    viewerNativeInputEnabled: true,
    remoteHistoryDeleteEnabled: true,
    ...overrides,
  };
}

function networkSnapshot(settings: PeerUiSettings | null, revision = 1): PeerUiSnapshot {
  return {
    revision,
    status: "ready",
    settings,
    identityFingerprint: null,
    listener: { state: "off", host: null, port: null, message: null },
    hosts: [],
    trustedPeers: [],
    consents: [],
    notice: null,
  };
}

function networkPane(settings: PeerUiSettings | null): Harness {
  const harness = makeController();
  harness.controller.setPeerUiSnapshot(networkSnapshot(settings));
  harness.controller.openPeerMenu();
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;
  return harness;
}

function networkTexts(harness: Harness): string[] {
  return assertPaneSafe(harness.controller.render(NETWORK_COLS, NETWORK_ROWS).lines, NETWORK_COLS, NETWORK_ROWS);
}

/** Moves the Network highlight onto the drawn row with this label, using real keys only. */
function highlightNetworkRow(harness: Harness, label: string): string[] {
  for (let step = 0; step < 20; step += 1) {
    const texts = networkTexts(harness);
    if (texts.find((line) => line.startsWith("> "))?.includes(label)) return texts;
    harness.send(DOWN);
  }
  assert.fail(`the Network pane never drew ${label} as its highlight`);
}

function peerActions(harness: Harness): SidebarAction[] {
  return harness.sinceActions().filter((action) => action.type.startsWith("peer-"));
}

test("Network shows distinct viewer Remote input/copy and owner history-deletion rows after the bell", () => {
  const harness = networkPane(networkSettings());
  const texts = networkTexts(harness);
  const bell = texts.findIndex((line) => line.includes("Incoming bell: on"));
  const viewer = texts.findIndex((line) => line.includes("Remote input/copy: on (enter to toggle)"));
  const history = texts.findIndex((line) => line.includes("Allow remote history deletion: on (enter to toggle)"));
  const add = texts.findIndex((line) => line.includes("Add destination"));
  assert.ok(bell > 0 && viewer === bell + 1 && history === viewer + 1 && add === history + 1,
    `unexpected Network row order: ${JSON.stringify(texts)}`);

  highlightNetworkRow(harness, "Remote input/copy");
  harness.send(ENTER);
  assert.deepEqual(peerActions(harness), [{ type: "peer-viewer-native-input", enabled: false }],
    "the viewer row toggles only this viewer's remote input/copy");

  highlightNetworkRow(harness, "Allow remote history deletion");
  harness.send(ENTER);
  assert.deepEqual(peerActions(harness), [
    { type: "peer-viewer-native-input", enabled: false },
    { type: "peer-remote-history-delete", enabled: false },
  ], "the owner policy row is a separate action, never a viewer delete toggle");
  assert.equal(peerActions(harness).some((action) => action.type === "peer-bell"), false);
});

test("each Network flag row sends the opposite of the drawn saved value", () => {
  const harness = networkPane(networkSettings({ viewerNativeInputEnabled: false, remoteHistoryDeleteEnabled: false }));
  const texts = networkTexts(harness);
  assert.ok(texts.some((line) => line.includes("Remote input/copy: off (enter to toggle)")));
  assert.ok(texts.some((line) => line.includes("Allow remote history deletion: off (enter to toggle)")));
  highlightNetworkRow(harness, "Remote input/copy");
  harness.send(ENTER);
  highlightNetworkRow(harness, "Allow remote history deletion");
  harness.send(ENTER);
  assert.deepEqual(peerActions(harness), [
    { type: "peer-viewer-native-input", enabled: true },
    { type: "peer-remote-history-delete", enabled: true },
  ]);
});

test("a Network flag toggle whose drawn value changed behind the frame sends nothing", () => {
  const harness = networkPane(networkSettings());
  highlightNetworkRow(harness, "Remote input/copy");
  // The saved value changes after the frame that drew "on", with no new render.
  harness.controller.setPeerUiSnapshot(networkSnapshot(networkSettings({ viewerNativeInputEnabled: false }), 2));
  harness.send(ENTER);
  assert.deepEqual(peerActions(harness), [], "a stale drawn intent never toggles the opposite value");
  assert.ok(networkTexts(harness).some((line) => line.includes("The network pane changed")));

  // A pointer press captured from the older drawn frame is refused the same way.
  const history = networkPane(networkSettings());
  const drawn = networkTexts(history);
  const row = drawn.findIndex((line) => line.includes("Allow remote history deletion"));
  assert.ok(row > 0);
  const presentation = history.controller.captureMousePresentation();
  history.controller.setPeerUiSnapshot(networkSnapshot(networkSettings({ remoteHistoryDeleteEnabled: false }), 2));
  assert.equal(presentation.activatePeerAt(2, row, NETWORK_COLS, NETWORK_ROWS), false);
  assert.deepEqual(peerActions(history), []);
  // The current written row acts once, through the ordinary Enter routine.
  const current = networkTexts(history);
  const currentRow = current.findIndex((line) => line.includes("Allow remote history deletion: off"));
  assert.ok(currentRow > 0);
  assert.equal(history.controller.captureMousePresentation().activatePeerAt(2, currentRow, NETWORK_COLS, NETWORK_ROWS), true);
  assert.deepEqual(peerActions(history), [{ type: "peer-remote-history-delete", enabled: true }]);
});

test("unknown settings, or settings missing a flag, show unknown and send no flag change", () => {
  for (const settings of [
    null,
    { ...networkSettings(), viewerNativeInputEnabled: undefined } as unknown as PeerUiSettings,
    { ...networkSettings(), remoteHistoryDeleteEnabled: "true" } as unknown as PeerUiSettings,
  ]) {
    const harness = networkPane(settings);
    const texts = networkTexts(harness);
    assert.ok(texts.some((line) => line.includes("Remote input/copy: unknown")), JSON.stringify(texts));
    assert.ok(texts.some((line) => line.includes("Allow remote history deletion: unknown")));
    highlightNetworkRow(harness, "Remote input/copy");
    harness.send(ENTER);
    highlightNetworkRow(harness, "Allow remote history deletion");
    harness.send(ENTER);
    assert.deepEqual(peerActions(harness), [], "an unknown setting is never toggled to a guessed value");
  }
});
