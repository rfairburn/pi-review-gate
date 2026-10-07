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
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
  SidebarController,
} from "../src/session-host/sidebar";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT_LEGACY = "\x1b[1;3D";
const ALT_LEFT_ALTCHAT_LEGACY = "\x1bb";
const F8_LEGACY = "\x1b[19~";
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
  harness.baseline = harness.actions.length;
  return harness;
}

/** Opens the New session form: hidden start, toggle show, Enter on New. */
function formWith(
  overrides: { cols?: number; rows?: number; options?: SidebarControllerOptions } = {},
): Harness {
  const harness = makeController({ initialVisible: false, ...(overrides.options ?? {}) });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(togglePacketFor(overrides.options ?? {})); // show -> focus sidebar (New default)
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
  const footer = texts.slice(-2).join(" ");
  for (const hint of ["toggle", "enter open", "delete remove exited", "esc hide", "q quit"]) {
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
    "pageUp",
    "pageDown",
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

test("unmatchable modified function and Clear toggles fail construction", () => {
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
    if (!(selected.length === 1 && (prefix === "ctrl" || prefix === "shift"))) {
      assert.throws(
        () => new SidebarController({ toggleKey: `${prefix}+clear` }),
        /toggleKey/,
      );
    }
  }
});

test("supported Clear toggles match pinned legacy packets", () => {
  for (const [toggleKey, packet] of [
    ["clear", "\x1b[E"],
    ["ctrl+clear", "\x1bOe"],
    ["shift+clear", "\x1b[e"],
  ]) {
    const harness = makeController({ toggleKey, initialVisible: false });
    harness.send(packet);
    assert.equal(harness.controller.visible, true);
    assert.deepEqual(harness.actions, [{ type: "visibility", visible: true }]);
  }
});

test("page key and modified page key toggles validate and match pinned packets", () => {
  const cases = [
    ["pageUp", "\x1b[5~"],
    ["pageDown", "\x1b[6~"],
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
  assert.ok(texts.slice(-2).join(" ").includes("delete remove exited"), JSON.stringify(texts));
  harness.send(DELETE);
  assert.deepEqual(harness.focusedActions(), [{ type: "remove", id }]);
  assert.equal(harness.controller.selectedId, id, "the UI waits for the backend roster confirmation");
  assert.equal(harness.controller.focus, "sidebar");
});

test("a configured Delete toggle keeps its identity and exposes x as the removal key", () => {
  const id = "opaque-delete-toggle-row";
  const harness = makeController({ toggleKey: "delete", initialVisible: false });
  harness.controller.updateItems([
    makeItem({ id, lifecycle: "exited", hasLiveProcess: false }),
  ]);
  harness.send(DELETE); // configured toggle shows the sidebar
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(DOWN); // New -> Quit
  harness.send(DOWN); // -> exited row
  const texts = rosterView(harness.controller, 40, 10).texts;
  assert.ok(texts.join(" ").includes("x remove exited"), JSON.stringify(texts));
  assert.ok(!texts.join(" ").includes("delete remove exited"));
  harness.baseline = harness.actions.length;
  harness.send("x");
  assert.deepEqual(harness.focusedActions(), [{ type: "remove", id }]);
  harness.send(DELETE); // the original configured toggle still hides the sidebar
  assert.equal(harness.controller.visible, false);
  assert.deepEqual(harness.focusedActions().at(-1), { type: "visibility", visible: false });
});

test("arrows select roster items then New session and Quit host with wrap", () => {
  const harness = makeRoster(["a", "b"]);
  harness.send(DOWN); // New session -> Quit host
  assert.equal(harness.controller.selectedId, undefined); // on quit row
  harness.send(DOWN); // wraps to the first roster item
  assert.deepEqual(harness.controller.selectedId, "a");
  harness.send(DOWN);
  assert.deepEqual(harness.controller.selectedId, "b");
  harness.send(DOWN); // b -> New session
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(DOWN); // -> Quit host
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(DOWN); // wraps past Quit to the first item again
  assert.deepEqual(harness.controller.selectedId, "a");
  harness.send(UP); // a wraps backwards to Quit host
  assert.equal(harness.controller.selectedId, undefined);
  harness.send(UP); // Quit -> New session? (b is before New; up from quit)
  assert.equal(harness.controller.selectedId, undefined); // New session
  harness.send(UP);
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
  assert.ok(!rosterView(harness.controller, 40, 10).texts.join(" ").includes("delete remove exited"));
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
  const texts = rosterView(harness.controller).texts;
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
  harness.send(ALT_LEFT_LEGACY); // toggle hides
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

test("New session opens a two-field form and forwards only label/workspace", () => {
  const harness = formWith();
  const first = harness.controller.render(40, 8);
  const texts = assertPaneSafe(first.lines, 40, 8);
  assert.ok(texts[0].includes("New session"));
  assert.ok(texts[1].includes("Label:"));
  assert.ok(texts[2].includes("Workspace:"));
  assert.ok(!texts.some((line) => line.includes("Profile:")));
  assert.deepEqual(first.cursor, { column: 13, row: 1 });
  for (const ch of "my session") {
    harness.controller.handleInput(ch);
  }
  const typed = harness.controller.render(40, 8);
  assert.deepEqual(typed.cursor, { column: 23, row: 1 });
  harness.send(ENTER); // label -> workspace, still no create
  assert.deepEqual(harness.focusedActions(), []);
  assert.deepEqual(harness.controller.render(40, 8).cursor, { column: 13, row: 2 });
  harness.send("/workspace");
  harness.send(ENTER); // workspace submits directly
  assert.deepEqual(harness.focusedActions(), [
    { type: "create", requestId: 1, label: "my session", workspace: "/workspace" },
  ]);
  assert.ok(!("profile" in createOf(harness.focusedActions()[0])));
});

test("submit emits one create with a monotonic requestId and disables duplicate Enter", () => {
  const harness = formWith();
  harness.send("my session");
  harness.send(ENTER); // label -> workspace
  harness.send("/workspace");
  harness.send(ENTER); // submit
  assert.deepEqual(harness.focusedActions(), [
    { type: "create", requestId: 1, label: "my session", workspace: "/workspace" },
  ]);
  assert.equal(harness.controller.focus, "form");
  const texts = assertPaneSafe(harness.controller.render(40, 8).lines, 40, 8);
  assert.ok(texts.some((line) => line.includes("Starting (request 1)")));
  harness.send(ENTER); // duplicate Enter disabled while starting
  assert.equal(harness.focusedActions().length, 1);
  // Completion closes the form; the row is highlighted once the backend
  // publishes it in the roster.
  harness.controller.completeCreate(1, "spawned");
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.controller.selectedId, undefined); // row not published yet
  harness.controller.updateItems([
    makeItem({ id: "a" }),
    makeItem({ id: "spawned", lifecycle: "starting", busy: null }),
  ]);
  assert.deepEqual(harness.controller.selectedId, "spawned");
  // Monotonic ids for the next submission.
  harness.send(DOWN); // spawned -> New session
  harness.send(ENTER); // reopen the form
  assert.equal(harness.controller.focus, "form");
  harness.send(ENTER);
  harness.send(ENTER);
  harness.send(ENTER); // submit -> request 2
  const creates = harness.focusedActions().filter(
    (action): action is Extract<SidebarAction, { type: "create" }> => action.type === "create",
  );
  assert.deepEqual(
    creates.map((create) => create.requestId),
    [1, 2],
  );
});

test("label remains temporarily required; a suggested workspace never supplies an implicit name", () => {
  const harness = formWith({ options: { initialWorkspace: "/tmp/proj one" } });
  harness.send(ENTER); // empty label -> workspace
  harness.send(ENTER); // submit returns focus to the required label
  assert.equal(harness.controller.focus, "form");
  assert.ok(assertPaneSafe(harness.controller.render(48, 8).lines, 48, 8).some((line) => line.includes("Label is required")));
  assert.ok(!harness.focusedActions().some((action) => action.type === "create"));

  harness.send("my project");
  harness.send(ENTER); // label -> suggested workspace
  harness.send("\x1b[4~"); // public Input End key; suggested path remains editable
  harness.send("/child");
  harness.send(ENTER); // submit
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "create",
    requestId: 1,
    label: "my project",
    workspace: "/tmp/proj one/child",
  });
});

test("workspace is required and its validation preserves the label draft", () => {
  const harness = formWith();
  harness.send("project");
  harness.send(ENTER); // label -> workspace
  harness.send(ENTER); // submit returns focus to workspace
  assert.equal(harness.controller.focus, "form");
  assert.ok(assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8).some((line) => line.includes("Workspace is required")));
  assert.ok(!harness.focusedActions().some((action) => action.type === "create"));

  harness.send("/workspace");
  harness.send(ENTER); // submit
  assert.deepEqual(harness.focusedActions().at(-1), {
    type: "create",
    requestId: 1,
    label: "project",
    workspace: "/workspace",
  });
});

test("label limit: the 81st character is an explicit error, never truncated", () => {
  const harness = formWith();
  for (let i = 0; i < 80; i += 1) {
    harness.controller.handleInput("a");
  }
  harness.controller.handleInput("a"); // the 81st
  const texts = assertPaneSafe(harness.controller.render(40, 8).lines, 40, 8);
  assert.ok(texts.some((line) => line.includes("exceeds 80 UTF-16 code units")));
  // The prior draft stays at exactly 80 code units (rollback, not truncation).
  harness.send(ENTER); // label -> workspace
  harness.send("/workspace");
  harness.send(ENTER); // submit
  assert.equal(createOf(harness.focusedActions().at(-1)).label, "a".repeat(80));
});

test("path limit: the 2049th character is an explicit error, never truncated", () => {
  const harness = formWith();
  for (const ch of "L") {
    harness.controller.handleInput(ch);
  }
  harness.send(ENTER); // label -> workspace
  for (let i = 0; i < 2048; i += 1) {
    harness.controller.handleInput("p");
  }
  harness.controller.handleInput("p"); // the 2049th
  const texts = assertPaneSafe(harness.controller.render(48, 8).lines, 48, 8);
  assert.ok(texts.some((line) => line.includes("exceeds 2048 characters")));
  harness.send(ENTER); // submit
  const create = createOf(harness.focusedActions().at(-1));
  assert.equal(create.workspace, "p".repeat(2048));
  assert.equal(create.label, "L");
});

test("label bound matches the manager's 80 UTF-16 code units", () => {
  const emoji = "🙂";
  const harness = formWith();
  for (let index = 0; index < 40; index += 1) {
    harness.send(emoji); // 40 graphemes, exactly 80 UTF-16 code units
  }
  harness.send(emoji); // exceeds the manager's UTF-16 code-unit limit
  const texts = assertPaneSafe(harness.controller.render(48, 8).lines, 48, 8);
  assert.ok(texts.some((line) => line.includes("exceeds 80 UTF-16 code units")));
  assert.ok(!harness.focusedActions().some((action) => action.type === "create"));
  harness.send(ENTER); // label -> workspace
  harness.send("/workspace");
  harness.send(ENTER); // valid preserved draft submits
  assert.equal(createOf(harness.focusedActions().at(-1)).label, emoji.repeat(40));
});

test("public Input rollback preserves text and documents its caret clamping", () => {
  const harness = formWith();
  for (let index = 0; index < 80; index += 1) {
    harness.send("a");
  }
  harness.send("\x1b[H"); // Home to the beginning via public Input key handling
  assert.deepEqual(harness.controller.render(40, 8).cursor, { column: 13, row: 1 });
  harness.send("b"); // over limit rolls text back; public setValue retains/clamps caret at column 1
  const frame = harness.controller.render(40, 8);
  assert.deepEqual(frame.cursor, { column: 14, row: 1 });
  assert.ok(assertPaneSafe(frame.lines, 40, 8).some((line) => line.includes("exceeds 80 UTF-16 code units")));
  harness.send(ENTER);
  harness.send("/workspace");
  harness.send(ENTER);
  harness.send(ENTER);
  assert.equal(createOf(harness.focusedActions().at(-1)).label, "a".repeat(80));
});

test("Unicode labels: editing removes whole graphemes and never splits them", () => {
  const harness = formWith();
  harness.controller.handleInput("héllo👨‍👩‍👧"); // ZWJ family grapheme at the end
  harness.controller.handleInput("\x7f"); // backspace: whole grapheme
  harness.send(ENTER); // label -> workspace
  harness.send("/workspace");
  harness.send(ENTER); // submit
  const create = createOf(harness.focusedActions().at(-1));
  assert.equal(create.label, "héllo");
});

test("bounded single-line paste; multi-line paste is cleaned to one line", () => {
  const harness = formWith();
  harness.controller.handleInput("\x1b[200~a\nb\r\nc\x1b[201~");
  harness.send(ENTER); // label -> workspace
  harness.controller.handleInput("\x1b[200~/tmp/paste dir\x1b[201~");
  harness.send(ENTER); // submit
  const create = createOf(harness.focusedActions().at(-1));
  assert.equal(create.label, "abc");
  assert.equal(create.workspace, "/tmp/paste dir");
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
  assert.ok(texts[1]?.includes("ABCDEFGHItail"), JSON.stringify(texts));
  assert.ok(texts.every((line) => !/YWJj|malicious title|99;99|31m/.test(line)));
  assert.ok(texts.every((line) => !line.includes(CURSOR_MARKER)));
});

test("sanitized paste preserves visible caret editing around stripped commands", () => {
  const harness = formWith();
  harness.send("\x1b[200~A\x1b]52;c;YWJj\x07B\x1b[201~");
  harness.send(LEFT);
  harness.send(LEFT);
  harness.send(LEFT);
  harness.send("X");
  const texts = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8);
  assert.ok(texts[1]?.includes("XAB"), JSON.stringify(texts));
});

test("streamed paste accumulation is byte-bounded and reports overflow", () => {
  const harness = formWith();
  harness.send("\x1b[200~");
  harness.send("x".repeat(5000));
  harness.send("y".repeat(5000));
  harness.send("\x1b[201~");
  const texts = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8);
  assert.ok(texts.some((line) => line.includes("Paste exceeds 8192 bytes")));
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
  harness.send(ENTER); // label -> workspace
  harness.send("/workspace");
  harness.send(ENTER); // submit
  assert.equal(createOf(harness.focusedActions().at(-1)).label, "kept");
});

test("exact-width form text reserves a visible end-of-value caret", () => {
  const harness = formWith({ cols: 24 });
  for (const char of "abcdefghijk") {
    harness.send(char);
  }
  const frame = harness.controller.render(24, 8);
  const texts = assertPaneSafe(frame.lines, 24, 8);
  assert.ok(texts[1]?.endsWith("bcdefghijk "), JSON.stringify(texts[1]));
  assert.ok(frame.lines[1]?.includes("\x1b[7m \x1b[27m"));
  assert.deepEqual(frame.cursor, { column: 23, row: 1 });
});

test("home/end navigate fields; the path field scrolls horizontally to the cursor", () => {
  const harness = formWith({ cols: 44 });
  harness.send(ENTER); // label -> workspace
  harness.controller.handleInput("/Users/dev/" + "0123456789".repeat(3));
  const atEnd = harness.controller.render(44, 8);
  assert.ok(
    (atEnd.cursor?.column ?? 0) >= 13 && (atEnd.cursor?.column ?? 0) <= 43,
    `end caret out of pane: ${JSON.stringify(atEnd.cursor)}`,
  );
  harness.controller.handleInput("\x1b[H"); // home: cursor scrolls back left
  const atHome = harness.controller.render(44, 8);
  assert.deepEqual(atHome.cursor, { column: 13, row: 2 });
  harness.controller.handleInput("\x1b[4~"); // end again
  const atEndAgain = harness.controller.render(44, 8);
  assert.ok((atEndAgain.cursor?.column ?? 0) > 13);
  // 0-based pane coordinates on every render.
  assert.ok((atHome.cursor?.row ?? 0) >= 0);
});

test("form Escape abandons the UI request and hides; the launch is never killed", () => {
  const harness = formWith();
  for (const ch of "fast") {
    harness.controller.handleInput(ch);
  }
  harness.send(ENTER); // label -> workspace
  harness.send("/workspace");
  harness.send(ENTER); // submit -> create request 1
  const texts = assertPaneSafe(harness.controller.render(40, 8).lines, 40, 8);
  assert.ok(texts.some((line) => line.includes("Starting (request 1)")));
  harness.send(ESC); // escape while starting: UI-only abandon
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.focus, "main");
  assert.deepEqual(harness.focusedActions(), [
    { type: "create", requestId: 1, label: "fast", workspace: "/workspace" },
    { type: "visibility", visible: false },
  ]);
  // Backend already launched? Then this late completion is real UI noise:
  // it must not kill anything (it can't — there is no kill path) and must
  // not steal focus. But the escaped request may still legitimately land.
  harness.controller.completeCreate(1, "landing-row");
  assert.equal(harness.controller.focus, "main");
  assert.deepEqual(harness.controller.selectedId, undefined);
  // The abandon itself emitted no quit/stop action.
  assert.deepEqual(
    harness.focusedActions().filter((action) => action.type === "quit"),
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
    editing.send(ENTER); // reopen the New session form
    assert.equal(editing.controller.focus, "form");
    assert.ok(assertPaneSafe(editing.controller.render(44, 8).lines, 44, 8)[1]?.includes("draft"));

    const pending = formWith({ options });
    pending.send("draft");
    pending.send(ENTER);
    pending.send("/workspace");
    pending.send(ENTER);
    pending.send(ENTER); // request 1 starts
    assert.equal(createOf(pending.focusedActions().at(-1)).requestId, 1);
    pending.send(packet); // abandon UI ownership; do not stop the backend launch
    assert.equal(pending.controller.visible, false);
    pending.send(packet);
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

test("failCreate preserves entered fields and shows the sanitized error", () => {
  const harness = formWith();
  for (const ch of "first") {
    harness.controller.handleInput(ch);
  }
  harness.send(ENTER);
  harness.controller.handleInput("/w");
  harness.send(ENTER);
  harness.send(ENTER); // submit -> request 1
  harness.controller.failCreate(1, "\x1b[31mNo such workspace\x07boom");
  const texts = assertPaneSafe(harness.controller.render(44, 8).lines, 44, 8);
  assert.ok(texts.some((line) => line.includes("No such workspaceboom")));
  assert.ok(texts.every((line) => !line.includes("Starting")));
  // Draft preserved: re-submitting needs no retyping and gets a fresh id.
   harness.send(ENTER); // submit -> request 2
  const create = createOf(harness.focusedActions().at(-1));
  assert.equal(create.requestId, 2);
  assert.equal(create.label, "first");
  assert.equal(create.workspace, "/w");
});

test("backend selection supersedes pending create callbacks", () => {
  for (const selectedId of ["a", "later"]) {
    for (const callback of ["complete", "fail"]) {
      const harness = formWith();
      harness.send("draft");
      harness.send(ENTER);
      harness.send("/w");
      harness.send(ENTER);
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
      assert.equal(retry.label, "draft");
      assert.equal(retry.workspace, "/w");
    }
  }
});

test("stale create callbacks never contaminate the current form or selection", () => {
  const harness = formWith();
  harness.send("draft");
  harness.send(ENTER);
  harness.send("/workspace");
  harness.send(ENTER);
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
  // The matching completion selects the row (once published) and closes the form.
  harness.controller.completeCreate(2, "fresh-row");
  assert.equal(harness.controller.focus, "sidebar");
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

test("truthful badges: running/idle/unknown plus input observed only when observed", () => {
  const harness = makeController({ initialVisible: false });
  harness.send(ALT_LEFT_LEGACY);
  harness.controller.updateItems([
    makeItem({ id: "run", busy: true }),
    makeItem({ id: "idle", busy: false }),
    makeItem({ id: "unsure", busy: null }),
    makeItem({ id: "typed", pendingInput: true }),
    makeItem({ id: "surface", inputSurface: true }),
    makeItem({ id: "quiet" }),
    makeItem({ id: "gone", lifecycle: "exited", exitCode: 3, busy: null, pendingInput: null }),
    makeItem({ id: "err", lifecycle: "error", exitCode: 1 }),
    makeItem({ id: "warm", lifecycle: "starting", busy: null }),
  ]);
  const texts = rosterView(harness.controller, 80, 20).texts;
  const rowFor = (id: string): string | undefined =>
    texts.find((line) => line.includes(`label-${id}`));
  assert.ok(rowFor("run")?.includes("[AGENT: running]"));
  assert.ok(rowFor("idle")?.includes("[AGENT: idle]"));
  assert.ok(rowFor("unsure")?.includes("[AGENT: unknown]"));
  assert.ok(rowFor("typed")?.includes("[input]"));
  assert.ok(rowFor("surface")?.includes("[input]"));
  assert.ok(!rowFor("quiet")?.includes("[input]"));
  assert.ok(rowFor("gone")?.includes("[exited (code 3)]"));
  assert.ok(rowFor("err")?.includes("[error (code 1)]"));
  assert.ok(rowFor("warm")?.includes("[starting]"));
  // No conflation: exited/error rows never claim running or idle.
  assert.ok(!rowFor("gone")?.includes("[AGENT: running]"));
  assert.ok(!rowFor("gone")?.includes("[AGENT: idle]"));
  assert.ok(!rowFor("err")?.includes("[AGENT: running]"));
});

test("CJK width rows stay bounded and intact; configured F8 shows in the help", () => {
  const harness = makeRoster(["jp"], { toggleKey: "f8" });
  harness.controller.updateItems([makeItem({ id: "jp", label: "セッション", busy: true })]);
  const texts = rosterView(harness.controller, 40, 6).texts;
  assert.ok(texts.some((line) => line.includes("セッション")));
  assert.ok(texts.some((line) => line.includes("[AGENT: running]")));
  assert.ok(texts.some((line) => line.includes("F8 toggle")));
});

test("32-column roster reserves lifecycle, AGENT, and input status before long labels", () => {
  const harness = makeController({ initialVisible: false });
  harness.send(ALT_LEFT_LEGACY);
  harness.controller.updateItems([
    makeItem({ id: "ascii", label: "A".repeat(80), lifecycle: "alive", busy: true, pendingInput: true }),
    makeItem({ id: "wide", label: "セッション".repeat(12), lifecycle: "alive", busy: null, inputSurface: true }),
    makeItem({ id: "exited", label: "E".repeat(80), lifecycle: "exited", exitCode: 3 }),
    makeItem({ id: "error", label: "障害".repeat(20), lifecycle: "error", exitCode: 1 }),
  ]);
  const view = rosterView(harness.controller, 32, 10);
  assert.ok(view.texts[1]?.includes("[AGENT: running]"));
  assert.ok(view.texts[1]?.includes("[input]"));
  assert.ok(view.texts[2]?.includes("セ"));
  assert.ok(view.texts[2]?.includes("[AGENT: unknown]"));
  assert.ok(view.texts[2]?.includes("[input]"));
  assert.ok(view.texts[3]?.includes("[exited (code 3)]"));
  assert.ok(view.texts[4]?.includes("[error (code 1)]"));
  assert.ok(view.texts.every((line) => visibleWidth(line) <= 32));
  assert.equal(view.lines.length, 10);
  assert.ok(!view.texts[1]?.includes("A".repeat(20)));
  assert.ok(!view.texts[2]?.includes("セッション".repeat(3)));
});

test("roster scrolls vertically and keeps the keyboard highlight visible", () => {
  const harness = makeController({ initialVisible: false });
  harness.controller.updateItems(
    Array.from({ length: 8 }, (_, i) => makeItem({ id: `s${i}` })),
  );
  harness.send(ALT_LEFT_LEGACY); // show -> focus sidebar
  harness.controller.select("s0");
  // pane 32x7 => header + 4 list rows + footer; labels still fit beside status.
  const first = rosterView(harness.controller, 32, 7);
  assert.ok(first.texts[1].includes("> label-s0"));
  for (let i = 0; i < 5; i += 1) {
    harness.controller.handleInput(DOWN); // s0 .. s5
  }
  const scrolled = rosterView(harness.controller, 32, 7);
  assert.ok(scrolled.texts.some((line) => line.includes("> label-s5")));
  assert.ok(scrolled.texts.every((line) => !line.includes("label-s0")));
  assert.equal(scrolled.lines.length, 7);
  harness.controller.handleInput(UP); // back to s4
  const scrolledBack = rosterView(harness.controller, 32, 7);
  assert.ok(scrolledBack.texts.some((line) => line.includes("> label-s4")));
});

test("selected activity lines render beneath the row, bounded to two", () => {
  const harness = makeRoster(["a"]);
  harness.controller.updateItems([
    makeItem({ id: "a", activity: ["one", "two", "three", "four"] }),
  ]);
  harness.controller.select("a");
  const texts = rosterView(harness.controller, 40, 12).texts;
  assert.ok(texts.some((line) => line.includes("one")));
  assert.ok(texts.some((line) => line.includes("two")));
  assert.ok(texts.every((line) => !line.includes("three")));
  // Bounded rendering only: the stored DTO keeps everything the backend sent.
  assert.equal(harness.controller.items[0]?.activity.length, 4);
});

test("wide layout renders roster and form as independent panes", () => {
  const harness = formWith();
  // render() dispatches to the focused pane (the form) with its cursor.
  const formPane = harness.controller.render(47, 23);
  assert.deepEqual(formPane.cursor, { column: 13, row: 1 });
  assert.ok(assertPaneSafe(formPane.lines, 47, 23)[0].includes("New session"));
  // The roster pane is still available beside it on wide terminals; its
  // return type carries no cursor, so it can never claim one.
  const roster = harness.controller.renderRoster(32, 23);
  const texts = assertPaneSafe(roster.lines, 32, 23);
  assert.ok(texts[0].includes("Sessions (1)"));
  assert.ok(texts.some((line) => line.includes("> New session")));
  assert.ok(!texts.join(" ").includes("delete remove exited"), "the sidebar-only action is hidden while the form owns input");
});

test("footer hints wrap across reserved rows and never ellipsize", () => {
  const harness = makeRoster(["a"]);
  for (const cols of [32, 40, 60]) {
    const texts = rosterView(harness.controller, cols, 10).texts;
    const footer = texts.join(" ");
    for (const hint of ["toggle", "enter open", "delete remove exited", "esc hide", "q quit"]) {
      assert.ok(footer.includes(hint), `missing ${JSON.stringify(hint)} at ${cols} cols: ${JSON.stringify(texts)}`);
    }
    assert.ok(!texts.some((line) => line.includes("...")), `no ellipsized hints at ${cols} cols`);
  }
  // The form footer wraps too, preserving both hints.
  const form = formWith({ cols: 24 });
  const texts = assertPaneSafe(form.controller.render(24, 8).lines, 24, 8);
  const footer = texts.slice(-2).join(" ");
  assert.ok(footer.includes("enter next/submit"), JSON.stringify(texts));
  assert.ok(footer.includes("esc toggle-cancel"), JSON.stringify(texts));
});

test("roster requires a visible entry row; otherwise it falls back to too-small", () => {
  const { controller } = makeController();
  // The complete footer wraps to four rows at 20 cols; 20x5 leaves no
  // room for an entry, so Enter would activate an invisible target.
  const tooSmall = controller.render(20, 5);
  assert.ok(tooSmall.lines.some((line) => line.includes("too small")));
  assert.equal(tooSmall.cursor, undefined);

  // One more row keeps exactly one visible entry plus the complete hints.
  const fits = assertPaneSafe(controller.render(20, 6).lines, 20, 6);
  assert.ok(fits.some((line) => line.includes("> New session")), JSON.stringify(fits));
  const footer = fits.join(" ");
  for (const hint of ["toggle", "enter open", "delete remove exited", "esc hide", "q quit"]) {
    assert.ok(footer.includes(hint), `missing ${JSON.stringify(hint)}: ${JSON.stringify(fits)}`);
  }

  // An error row consumes the last entry slot at 32x5.
  controller.showError("boom");
  const tooSmallWithError = controller.render(32, 5);
  assert.ok(tooSmallWithError.lines.some((line) => line.includes("too small")));
  const fitsWithError = assertPaneSafe(controller.render(32, 6).lines, 32, 6);
  assert.ok(fitsWithError.some((line) => line.includes("> New session")), JSON.stringify(fitsWithError));
  assert.ok(fitsWithError.some((line) => line.includes("boom")));
  const footerWith = fitsWithError.join(" ");
  for (const hint of ["toggle", "enter open", "delete remove exited", "esc hide", "q quit"]) {
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
  const tight = assertPaneSafe(harness.controller.render(32, 6).lines, 32, 6);
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
  // 24x5 cannot fit header+two fields+status+the wrapped two-line footer.
  const tooSmallForm = form.controller.render(24, 5);
  assert.ok(tooSmallForm.lines.some((line) => line.includes("too small")));
  assert.equal(tooSmallForm.cursor, undefined);
  // One more row renders the full two-field form again.
  const fits = form.controller.render(24, 6);
  assert.deepEqual(fits.cursor, { column: 13, row: 1 });
  assertPaneSafe(fits.lines, 24, 6);

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
    "process.cwd",
    "terminal-surface",
    "from \"./",
  ]) {
    assert.ok(!source.includes(banned), `sidebar must not reference ${banned}`);
  }
});