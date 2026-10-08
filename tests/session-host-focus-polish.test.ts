/**
 * Focus-polish tests for the optional custom session host sidebar (#323 alpha):
 *
 * 1. Alt+Right (roster-only) returns input focus to the existing Main owner
 *    without activating the highlighted row, resizing, hiding, or emitting a
 *    select action. Repeats/releases are fenced so a held key never leaks into
 *    the child; a fresh Alt+Right in Main focus is ordinary native input.
 * 2. Focus-domain title highlighting: blue identifies the LEFT selected
 *    navigation target while a sidebar-owned surface has focus; white
 *    identifies the ACTUAL active Main conversation only while Main has focus.
 *    Never both at once, never a false sibling/owner mark.
 * 3. Escape in the Edit form cancels ONLY that form and returns to the VISIBLE
 *    roster (sidebar focus) without hiding; a held Escape repeat does not
 *    bubble into the roster hide, but a fresh roster Escape still hides.
 *
 * Keyboard paths use REAL pinned pi-tui key matching (legacy, modifyOtherKeys,
 * Kitty CSI-u) — never mock key algorithms. Everything is pure frontend.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
  SidebarController,
} from "../src/session-host/sidebar";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_RIGHT_LEGACY = "\x1b[1;3C";
const ALT_RIGHT_KITTY_PRESS = "\x1b[1;3:1C";
const ALT_RIGHT_KITTY_REPEAT = "\x1b[1;3:2C";
const ALT_RIGHT_KITTY_RELEASE = "\x1b[1;3:3C";
const ALT_LEFT_LEGACY = "\x1b[1;3D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const ESC_REPEAT = "\x1b[27;1:2u";
const ESC_RELEASE = "\x1b[27;1:3u";

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

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  sinceActions(): SidebarAction[];
  forwards(): SidebarAction[];
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
    forwards: () =>
      actions.slice(harness.baseline).filter((action) => action.type === "forward"),
  };
  return harness;
}

/** Builds a roster and moves focus to the sidebar pane (one toggle show). */
function makeRoster(ids: string[], options: SidebarControllerOptions = {}): Harness {
  const harness = makeController({ initialVisible: false, ...options });
  harness.controller.updateItems(ids.map((id) => makeItem({ id })));
  harness.send(ALT_LEFT_LEGACY); // show -> focus sidebar
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
  return harness;
}

function assertPaneSafe(lines: string[], cols: number): string[] {
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
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than pane`);
  }
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

function rosterTexts(controller: SidebarController, cols = 40, rows = 20): string[] {
  return assertPaneSafe(controller.render(cols, rows).lines, cols);
}

// ---------------------------------------------------------------------------
// Alt+Right: roster-only return to the existing Main owner
// ---------------------------------------------------------------------------

test("Alt+Right in roster focus returns input focus to Main without activating or hiding", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.select("b"); // a non-owner row; Alt+Right must not activate it
  void harness.controller.render(40, 30);
  const before = harness.controller.selectedId;
  harness.send(ALT_RIGHT_LEGACY);
  assert.equal(harness.controller.focus, "main", "input focus returns to Main");
  assert.equal(harness.controller.visible, true, "the sidebar stays visible");
  assert.equal(harness.controller.selectedId, before, "the left selection is retained internally");
  assert.deepEqual(harness.sinceActions(), [], "Alt+Right emits no host actions");
});

test("Alt+Right with no Main owner moves focus to Main (welcome) without inventing an owner", () => {
  const harness = makeRoster([]);
  harness.controller.setActiveMainOwner(undefined);
  harness.send(ALT_RIGHT_LEGACY);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.visible, true);
  assert.deepEqual(harness.sinceActions(), [], "no owner is invented or activated");
});

test("Alt+Right repeat and release in roster focus are consumed (no re-focus)", () => {
  const harness = makeRoster(["a"]);
  harness.send(ALT_RIGHT_KITTY_PRESS);
  assert.equal(harness.controller.focus, "main");
  harness.send(ALT_RIGHT_KITTY_REPEAT);
  harness.send(ALT_RIGHT_KITTY_RELEASE);
  assert.equal(harness.controller.focus, "main", "repeat/release do not change focus");
  assert.deepEqual(harness.sinceActions(), [], "no actions from repeat/release");
});

test("held Alt+Right whose press was claimed by the roster never leaks into Main input", () => {
  const harness = makeRoster(["a"]);
  harness.send(ALT_RIGHT_KITTY_PRESS); // roster claims, focus -> main
  assert.equal(harness.controller.focus, "main");
  harness.baseline = harness.actions.length;
  harness.send(ALT_RIGHT_KITTY_REPEAT);
  harness.send(ALT_RIGHT_KITTY_RELEASE);
  assert.deepEqual(harness.forwards(), [], "held Alt+Right repeat/release never become child input");
});

test("a fresh Alt+Right in Main focus is ordinary native input (forwarded)", () => {
  const harness = makeRoster(["a"]);
  harness.send(ALT_RIGHT_KITTY_PRESS); // claim + focus main
  harness.send(ALT_RIGHT_KITTY_RELEASE); // release clears the claim
  harness.baseline = harness.actions.length;
  harness.send(ALT_RIGHT_LEGACY); // a fresh, deliberate press in Main focus
  const forwards = harness.forwards();
  assert.equal(forwards.length, 1, "a fresh Alt+Right in Main focus is forwarded to native");
  assert.equal(forwards[0]?.type === "forward" ? forwards[0].data : "", ALT_RIGHT_LEGACY);
});

test("Alt+Right in form/picker/confirm focus is consumed (no dismiss/submit/forward)", () => {
  // New session form.
  const form = makeRoster(["a"]);
  form.send(ENTER); // default selection "new" -> form focus
  assert.equal(form.controller.focus, "form");
  form.baseline = form.actions.length;
  form.send(ALT_RIGHT_LEGACY);
  assert.equal(form.controller.focus, "form", "Alt+Right does not dismiss the form");
  assert.deepEqual(form.sinceActions(), [], "no actions from Alt+Right in the form");

  // Quit confirmation (a live row requires confirmation).
  const confirm = makeRoster(["a"]);
  confirm.send("q");
  assert.equal(confirm.controller.focus, "confirm");
  confirm.baseline = confirm.actions.length;
  confirm.send(ALT_RIGHT_LEGACY);
  assert.equal(confirm.controller.focus, "confirm", "Alt+Right does not confirm/cancel");
  assert.deepEqual(confirm.sinceActions(), [], "no actions from Alt+Right in the confirmation");
});

test("the roster footer shows the Alt+Right main hint while the roster owns focus", () => {
  const harness = makeRoster(["a"]);
  const texts = rosterTexts(harness.controller);
  assert.ok(texts.some((line) => line.includes("alt+right main")), `missing hint: ${JSON.stringify(texts)}`);
});

// ---------------------------------------------------------------------------
// Focus-domain title highlighting (blue selection / white active owner)
// ---------------------------------------------------------------------------

test("sidebar focus highlights the selected target blue, not the active owner", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.setActiveMainOwner("a"); // actual Main owner is a
  harness.controller.select("b"); // left navigation target is b
  void harness.controller.render(40, 30);
  assert.equal(harness.controller.selectedId, "b");
  const lines = harness.controller.render(40, 30).lines;
  const blueIndex = lines.findIndex((line) => line.includes("\x1b[1;34m"));
  assert.ok(blueIndex >= 0, "the selected target title is blue");
  assert.ok(lines[blueIndex]?.includes("label-b"), "blue is on the selected row b");
  assert.ok(!lines.some((line) => line.includes("\x1b[1;97m")), "no white highlight in sidebar focus");
});

test("main focus highlights the actual active owner white, not the left selection", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.setActiveMainOwner("a"); // actual Main owner is a
  harness.controller.select("b"); // left navigation target is b
  void harness.controller.render(40, 30);
  harness.send(ALT_RIGHT_LEGACY); // focus -> main, selection b retained
  assert.equal(harness.controller.focus, "main");
  const lines = harness.controller.render(40, 30).lines;
  const whiteIndex = lines.findIndex((line) => line.includes("\x1b[1;97m"));
  assert.ok(whiteIndex >= 0, "the active owner title is white");
  assert.ok(lines[whiteIndex]?.includes("label-a"), "white is on the active owner a");
  assert.ok(!lines.some((line) => line.includes("\x1b[1;34m")), "no blue highlight in main focus");
});

test("no active owner in Main focus produces no false white highlight", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.setActiveMainOwner(undefined);
  harness.send(ALT_RIGHT_LEGACY); // focus -> main, no owner
  assert.equal(harness.controller.focus, "main");
  const lines = harness.controller.render(40, 30).lines;
  assert.ok(!lines.some((line) => line.includes("\x1b[1;97m")), "no false white highlight without an owner");
});

test("clearing the active owner removes the white highlight (no sibling adoption)", () => {
  const harness = makeRoster(["a", "b"]);
  harness.controller.setActiveMainOwner("a");
  harness.send(ALT_RIGHT_LEGACY); // focus -> main, a is white
  assert.ok(harness.controller.render(40, 30).lines.some((line) => line.includes("\x1b[1;97m")));
  // The owner row leaves the roster: Main clears the active id.
  harness.controller.setActiveMainOwner(undefined);
  const lines = harness.controller.render(40, 30).lines;
  const whiteSgr = "\x1b[1;97m";
  assert.ok(!lines.some((line) => line.includes(whiteSgr)), "no sibling is falsely highlighted");
});

// ---------------------------------------------------------------------------
// Escape in the Edit form cancels only that form (visible roster returned)
// ---------------------------------------------------------------------------

function openEditForm(harness: Harness, id: string): void {
  const tuple = { sessionId: "session-123", epoch: 7, name: "Observed title" };
  harness.controller.updateItems([makeItem({ id, nativeSession: tuple })]);
  harness.controller.select(id);
  void harness.controller.render(40, 30);
  assert.equal(harness.controller.openEdit({ id, nativeSession: tuple, currentName: tuple.name }), true);
  assert.equal(harness.controller.focus, "form");
}

test("Escape in the Edit form cancels only the form and returns to the visible roster", () => {
  const harness = makeRoster(["a"]);
  openEditForm(harness, "a");
  const ownerBefore = harness.controller.activeMainOwnerID;
  harness.send(ESC);
  assert.equal(harness.controller.focus, "sidebar", "focus returns to the roster");
  assert.equal(harness.controller.visible, true, "the sidebar stays visible (not hidden)");
  assert.equal(harness.controller.activeMainOwnerID, ownerBefore, "the active owner is preserved");
  const texts = rosterTexts(harness.controller);
  assert.ok(!texts.some((line) => line.includes("Edit native session name")), "the Edit form is gone");
  assert.ok(texts.some((line) => line.includes("Sessions (1)")), "the roster is restored");
});

test("a held Escape that canceled the Edit form does not hide the roster; a fresh Escape still hides", () => {
  const harness = makeRoster(["a"]);
  openEditForm(harness, "a");
  harness.send(ESC); // cancel only the Edit form -> visible roster
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
  // The held key's repeat must not bubble into the roster hide.
  harness.send(ESC_REPEAT);
  assert.equal(harness.controller.visible, true, "a held Escape repeat does not hide the roster");
  assert.equal(harness.controller.focus, "sidebar");
  // A fresh, deliberate roster Escape still hides (existing semantics).
  harness.send(ESC);
  assert.equal(harness.controller.visible, false, "a fresh roster Escape hides the sidebar");
  assert.equal(harness.controller.focus, "main");
});

test("Escape in the New form still hides the sidebar (behavior unchanged)", () => {
  const harness = makeRoster(["a"]);
  harness.send(ENTER); // default selection "new" -> form focus
  assert.equal(harness.controller.focus, "form");
  harness.send(ESC);
  assert.equal(harness.controller.visible, false, "the New form Escape still hides the sidebar");
  assert.equal(harness.controller.focus, "main");
});

test("New form retains its existing Escape-repeat cancellation", () => {
  const harness = makeRoster(["a"]);
  harness.send(ENTER); // default selection "new" -> form focus
  assert.equal(harness.controller.focus, "form");
  harness.send(ESC_REPEAT);
  assert.equal(harness.controller.visible, false, "New-form Escape repeat still cancels");
  assert.equal(harness.controller.focus, "main");
});

// ---------------------------------------------------------------------------
// Edit Escape claim lifecycle across focus domains (finding 2)
// ---------------------------------------------------------------------------

test("Edit Escape claim survives unrelated input (Down) and fences the held repeat", () => {
  const harness = makeRoster(["a"]);
  openEditForm(harness, "a");
  harness.send(ESC); // cancel only the Edit form -> visible roster, claim set
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
  harness.send(DOWN); // unrelated input must NOT clear the claim
  harness.send(ESC_REPEAT); // held Escape repeat: consumed, never a roster hide
  assert.equal(harness.controller.visible, true, "a held Escape repeat after Down does not hide");
  assert.equal(harness.controller.focus, "sidebar");
});

test("Edit Escape claim survives a focus change to Main and fences the held repeat/release", () => {
  const harness = makeRoster(["a"]);
  openEditForm(harness, "a");
  harness.send(ESC); // cancel only the Edit form -> visible roster, claim set
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30); // host re-renders the visible roster
  harness.send(ALT_RIGHT_LEGACY); // move to Main while the Escape is still held
  assert.equal(harness.controller.focus, "main");
  harness.baseline = harness.actions.length;
  harness.send(ESC_REPEAT); // held Escape repeat in Main: consumed, not forwarded
  harness.send(ESC_RELEASE); // held Escape release in Main: consumed, clears claim
  assert.deepEqual(harness.forwards(), [], "held Escape repeat/release never become child input");
});

test("a held Escape repeat in the Edit form does not cancel it (completion dismissal precedence)", () => {
  const harness = makeRoster(["a"]);
  openEditForm(harness, "a");
  assert.equal(harness.controller.focus, "form");
  harness.send(ESC_REPEAT); // a held Escape's repeat is refused, never a cancel
  assert.equal(harness.controller.focus, "form", "a held Escape repeat does not cancel the Edit form");
});

// ---------------------------------------------------------------------------
// Alt+Right complete-card fence and paste opacity (finding 3)
// ---------------------------------------------------------------------------

test("Alt+Right is refused when the selected card was not fully drawn (too-small)", () => {
  const harness = makeRoster(["a"]);
  void harness.controller.render(20, 4); // too-small pane: selection not fully drawn
  harness.send(ALT_RIGHT_LEGACY);
  assert.equal(harness.controller.focus, "sidebar", "Alt+Right is refused when the card is undrawn");
});

test("a bracketed paste containing Alt+Right in roster focus does not change focus or leak", () => {
  const harness = makeRoster(["a"]);
  harness.baseline = harness.actions.length;
  // Stream a paste whose body equals the Alt+Right host chord; it must stay opaque.
  harness.send("\x1b[200~"); // paste start
  harness.send(ALT_RIGHT_LEGACY); // paste body: the host chord
  harness.send("\x1b[201~"); // paste end
  assert.equal(harness.controller.focus, "sidebar", "a pasted Alt+Right does not change focus");
  assert.deepEqual(harness.sinceActions(), [], "pasted content is never forwarded");
});

// ---------------------------------------------------------------------------
// Alt+Right provenance claim across host-owned surfaces (finding 4)
// ---------------------------------------------------------------------------

test("Alt+Right pressed in the Edit form is fenced after a toggle hides it", () => {
  const harness = makeRoster(["a"]);
  openEditForm(harness, "a");
  assert.equal(harness.controller.focus, "form");
  harness.send(ALT_RIGHT_KITTY_PRESS); // initial press consumed by the form, claim set
  harness.baseline = harness.actions.length;
  harness.send(ALT_LEFT_LEGACY); // reserved toggle abandons the form and hides -> Main focus
  assert.equal(harness.controller.focus, "main");
  harness.send(ALT_RIGHT_KITTY_REPEAT); // held Alt+Right repeat in Main: consumed
  harness.send(ALT_RIGHT_KITTY_RELEASE); // held Alt+Right release in Main: consumed, clears claim
  assert.deepEqual(harness.forwards(), [], "held Alt+Right from the form never becomes child input");
});

test("Alt+Right pressed in the Saved picker is fenced after a toggle hides it", () => {
  const harness = makeRoster(["a"]);
  void harness.controller.render(40, 30);
  harness.send(UP); // select the Saved entry
  void harness.controller.render(40, 30);
  harness.send(ENTER); // open the saved picker
  assert.equal(harness.controller.focus, "form");
  harness.send(ALT_RIGHT_KITTY_PRESS); // initial press consumed by the picker, claim set
  harness.baseline = harness.actions.length;
  harness.send(ALT_LEFT_LEGACY); // reserved toggle dismisses the picker and hides -> Main focus
  assert.equal(harness.controller.focus, "main");
  harness.send(ALT_RIGHT_KITTY_REPEAT); // held Alt+Right repeat in Main: consumed
  harness.send(ALT_RIGHT_KITTY_RELEASE); // held Alt+Right release in Main: consumed, clears claim
  assert.deepEqual(harness.forwards(), [], "held Alt+Right from the picker never becomes child input");
});

test("Alt+Right pressed in a confirmation is fenced after a toggle hides it", () => {
  const harness = makeRoster(["a"]);
  harness.send("q"); // activate Quit host -> confirmation
  assert.equal(harness.controller.focus, "confirm");
  harness.send(ALT_RIGHT_KITTY_PRESS); // initial press consumed by the confirm, claim set
  harness.baseline = harness.actions.length;
  harness.send(ALT_LEFT_LEGACY); // reserved toggle hides the sidebar -> Main focus
  assert.equal(harness.controller.focus, "main");
  harness.send(ALT_RIGHT_KITTY_REPEAT); // held Alt+Right repeat in Main: consumed
  harness.send(ALT_RIGHT_KITTY_RELEASE); // held Alt+Right release in Main: consumed, clears claim
  assert.deepEqual(harness.forwards(), [], "held Alt+Right from the confirmation never becomes child input");
});
