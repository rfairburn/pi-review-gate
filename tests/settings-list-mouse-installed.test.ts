/**
 * Issue #723: the shared Review-settings list pointer seam driven through the
 * INSTALLED Pi's actual native dispatch.
 *
 * A deny picker is built from the REAL installed pi-tui `SelectList`, `Input`,
 * `Container`, and `Text` and mounted as the layout child of the installed
 * `TuiAltScreen` over a virtual terminal. SGR mouse packets enter through the
 * terminal's own input callback, so Pi's parser, its layout hit test, its press
 * capture, and its stationary-click synthesis decide what reaches the picker —
 * including the click Pi synthesizes for a press the component never accepted.
 *
 * What this proves is the ORDER the operator can actually produce: the terminal
 * delivers a burst of reports inside one input turn, before Pi paints the frame
 * those reports changed. A press must therefore be judged against the list this
 * seam last RENDERED, not against whatever the live list now maps that cell to.
 *
 * Evidence boundary: headless. It proves the dispatch the installed runtime
 * performs for given terminal bytes; it does not prove which bytes a particular
 * physical terminal emits.
 *
 * Installed-runtime discovery follows the established helpers
 * (PI_REVIEW_GATE_INSTALLED_AGENT, else ambient global installs); without a
 * resolvable install the tests skip, or fail under PI_REVIEW_GATE_REQUIRE_PI_HOST=1.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { retainedDenySelect, type DenyPickerRow } from "../src/settings/deny-picker";
import { setMenuTuiHost, type MenuTuiHost } from "../src/settings/menu";
import { findInstalledAgentDirs, IDENTITY_THEME, loadRealMenuTuiHost } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

const SKIP_REASON = "installed Pi runtime with pi-tui TuiAltScreen not found (set PI_REVIEW_GATE_INSTALLED_AGENT)";

interface Installed {
  tui: Record<string, unknown>;
  host: MenuTuiHost;
}

/** The first installed Pi whose pi-tui exposes the fullscreen TUI. */
async function resolveInstalled(): Promise<Installed | undefined> {
  for (const agentDir of findInstalledAgentDirs()) {
    try {
      const requireFromAgent = createRequire(join(agentDir, "package.json"));
      const tui = requireFromAgent("@earendil-works/pi-tui") as Record<string, unknown>;
      if (typeof tui.TuiAltScreen !== "function") continue;
      const host = await loadRealMenuTuiHost();
      if (host === undefined || typeof host.Input !== "function") continue;
      return { tui, host };
    } catch {
      // Unusable install: try the next candidate.
    }
  }
  return undefined;
}

const installedPromise = resolveInstalled();

/** A terminal that hands its input callback straight to the installed TUI. */
class VirtualTerminal {
  columns: number;
  rows: number;
  private inputHandler: ((data: string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }

  stop(): void { this.inputHandler = undefined; this.resizeHandler = undefined; }
  async drainInput(): Promise<void> {}
  write(): void {}
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}

  /** Bytes arriving from the terminal, through the installed TUI's real input path. */
  input(data: string): void {
    assert.ok(this.inputHandler !== undefined, "the TUI is started");
    this.inputHandler(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.resizeHandler?.();
  }
}

interface TuiScreen {
  start(): void;
  stop(): void;
  addChild(component: unknown): void;
  setFocus(component: unknown): void;
  getScreenLines(): string[];
  renderNow(force?: boolean): void;
  requestRender(force?: boolean): void;
}

/** SGR 1006 packets exactly as the terminal sends them (1-based cells). */
const sgr = {
  press: (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`,
  release: (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`,
  wheelDown: (x: number, y: number): string => `\x1b[<65;${x + 1};${y + 1}M`,
};

const TOOL_ROWS: DenyPickerRow[] = [
  ...Array.from({ length: 30 }, (_unused, index) => ({
    key: `tool:t${index}`,
    label: `tool_${String(index).padStart(2, "0")}  x allowed`,
    searchText: `tool_${String(index).padStart(2, "0")}`,
  })),
  { key: "back", label: "Back", searchText: "back", alwaysVisible: true },
];

const stripAnsi = (line: string): string => line
  .replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]/g, "")
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const settle = async (ms = 30): Promise<void> => {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
};

interface Picker {
  /** The rows of the frame Pi last painted. */
  drawn(): string[];
  /** The label of the row drawn at this screen row, or "" for a non-row. */
  labelAt(row: number): string;
  /** The tool the picker answered with, once it answers. */
answer(): string | undefined;
  press(x: number, y: number): void;
  release(x: number, y: number): void;
  wheelDown(x: number, y: number): void;
  type(data: string): void;
  /** Stop the TUI and drop this file's menu host override. */
  close(): void;
}

/**
 * Mount a live deny picker as the installed TUI's own layout child. Every byte
 * below travels Pi's real input path; nothing calls the picker's seams directly.
 */
async function openPicker(): Promise<Picker | undefined> {
  const installed = await installedPromise;
  if (installed === undefined) return undefined;
  setMenuTuiHost(installed.host);
  const terminal = new VirtualTerminal(80, 24);
  const TuiAltScreen = installed.tui.TuiAltScreen as new (
    terminal: unknown, showHardwareCursor?: boolean, logDirectory?: string, options?: unknown,
  ) => TuiScreen;
  const screen = new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false });
  let answer: string | undefined;
  const ui = {
    mode: "tui",
    menuTuiHost: installed.host,
    notify(): void {},
    async select(): Promise<never> { throw new Error("the plain selector must not be used"); },
    custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown): Promise<unknown> {
      return new Promise<unknown>((resolve) => {
        const component = factory(
          { requestRender: (): void => screen.requestRender() },
          IDENTITY_THEME,
          null,
          (value: unknown) => { answer = value as string | undefined; resolve(value); },
        ) as { focused?: boolean };
        if ("focused" in component) component.focused = true;
        screen.addChild(component);
        // Keys reach the focused component, exactly as Pi's own custom slot does.
        screen.setFocus(component);
        screen.renderNow(true);
      });
    },
  };
  void retainedDenySelect(ui as never, { title: "Top-level tools", rows: TOOL_ROWS });
  screen.start();
  await settle();
  const drawn = (): string[] => screen.getScreenLines().map(stripAnsi);
  const labelAt = (row: number): string => {
    const line = drawn()[row] ?? "";
    const name = line.trim().replace(/^→\s*/, "").split(/\s{2,}/)[0] ?? "";
    return /^tool_/.test(name) ? name : "";
  };
  return {
    drawn,
    labelAt,
    answer: () => answer,
    press: (x, y) => terminal.input(sgr.press(x, y)),
    release: (x, y) => terminal.input(sgr.release(x, y)),
    wheelDown: (x, y) => terminal.input(sgr.wheelDown(x, y)),
    type: (data) => terminal.input(data),
    close: () => {
      screen.stop();
      terminal.stop();
      setMenuTuiHost(undefined);
    },
  };
}

test("the installed picker answers a stationary click on a row it painted", async (t) => {
  const picker = await openPicker();
  if (picker === undefined) { skipOrFail(t, SKIP_REASON); return; }
  try {
  const row = 12;
  const label = picker.labelAt(row);
  assert.ok(label.length > 0, `row ${row} is a tool row:\n${picker.drawn().join("\n")}`);
  picker.press(5, row);
  await settle(3);
  picker.release(5, row);
  await settle();
  assert.equal(picker.answer(), `tool:t${Number(label.slice("tool_".length))}`,
    `Pi's press and synthesized click toggled the row drawn at that cell:\n${picker.drawn().join("\n")}`);
  } finally {
    picker.close();
  }
});

test("a wheel burst that recenters the list, then a press at the old cell, answers nothing", async (t) => {
  const picker = await openPicker();
  if (picker === undefined) { skipOrFail(t, SKIP_REASON); return; }
  try {
    const row = 12;
    const painted = picker.labelAt(row);
    assert.ok(painted.length > 0, `row ${row} is a tool row:\n${picker.drawn().join("\n")}`);

    // A real terminal delivers the burst inside one input turn: Pi has not
    // painted the recentered window yet, so this cell is still the row the
    // operator saw, while the live list already maps it elsewhere.
    for (let notch = 0; notch < 6; notch += 1) picker.wheelDown(5, 6);
    picker.press(5, row);
    picker.release(5, row);
    await settle();
    assert.equal(picker.answer(), undefined,
      "a press measured against a window the operator was never shown activates nothing");

    // After the paint the same cell is a different row, and it answers normally.
    const now = picker.labelAt(row);
    assert.notEqual(now, painted, `the burst recentered the drawn window:\n${picker.drawn().join("\n")}`);
    picker.press(5, row);
    await settle(3);
    picker.release(5, row);
    await settle();
    assert.equal(picker.answer(), `tool:t${Number(now.slice("tool_".length))}`,
      `a fresh click after the repaint answers the row now drawn there:\n${picker.drawn().join("\n")}`);
  } finally {
    picker.close();
  }
});

test("a filter that replaces the list, then a press at the old cell, answers nothing", async (t) => {
  const picker = await openPicker();
  if (picker === undefined) { skipOrFail(t, SKIP_REASON); return; }
  try {
    const row = 12;
    const painted = picker.labelAt(row);
    assert.ok(painted.length > 0, `row ${row} is a tool row:\n${picker.drawn().join("\n")}`);

    // The keystroke REPLACES the picker's result list, and the terminal's press
    // arrives in the same input turn, before Pi paints the filtered list.
    picker.type("1");
    picker.press(5, row);
    picker.release(5, row);
    await settle();
    assert.equal(picker.answer(), undefined,
      "a press against a list the operator never saw activates nothing");

    // Painted, the filtered list answers a fresh click normally.
    const now = picker.labelAt(row);
    assert.ok(now.length > 0 && now !== painted, `the filter changed what row ${row} holds:\n${picker.drawn().join("\n")}`);
    assert.match(picker.drawn()[1] ?? /^$/, /^>\s*1/, "the typed filter is what the picker shows");
    picker.press(5, row);
    await settle(3);
    picker.release(5, row);
    await settle();
    assert.equal(picker.answer(), `tool:t${Number(now.slice("tool_".length))}`,
      `a fresh click after the repaint answers the row now drawn there:\n${picker.drawn().join("\n")}`);
  } finally {
    picker.close();
  }
});

test("a wheel report between a press and its release ends the press", async (t) => {
  const picker = await openPicker();
  if (picker === undefined) { skipOrFail(t, SKIP_REASON); return; }
  try {
    const row = 12;
    const painted = picker.labelAt(row);
    assert.ok(painted.length > 0, `row ${row} is a tool row:\n${picker.drawn().join("\n")}`);

    // The press is accepted, then a wheel report moves the list under it. Pi
    // still retains this component as the press target and still synthesizes the
    // stationary click, but the press that click would complete is over.
    picker.press(5, row);
    picker.wheelDown(5, row);
    picker.release(5, row);
    await settle();
    assert.equal(picker.answer(), undefined,
      "the synthesized click after an intervening wheel activates nothing");

    // A fresh gesture on the repainted list still works.
    await settle();
    const now = picker.labelAt(row);
    assert.ok(now.length > 0, `row ${row} is still a tool row:\n${picker.drawn().join("\n")}`);
    picker.press(5, row);
    await settle(3);
    picker.release(5, row);
    await settle();
    assert.equal(picker.answer(), `tool:t${Number(now.slice("tool_".length))}`,
      `a fresh click answers the row drawn there:\n${picker.drawn().join("\n")}`);
  } finally {
    picker.close();
  }
});
