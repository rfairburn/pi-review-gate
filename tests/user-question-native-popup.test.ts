/**
 * Native fullscreen integration for the shared question/notice popup (#413).
 *
 * Drives the production extension registration (activate → the registered
 * Ctrl+Alt+Up shortcut handler → the shared custom overlay factory) over a
 * REAL pinned pi-tui `TuiAltScreen` (`pi-session-host-tui`, the exact pi-tui
 * 1.5.0 release this package depends on). The test's `ctx.ui.custom` mirrors
 * Pi 1.5.0's public `showExtensionCustom`: it invokes the factory with the
 * live TUI, shows the returned component through the public
 * `tui.showOverlay(component, overlayOptions)`, and hides that overlay when
 * the factory's completion callback runs. Every keyboard byte sequence and
 * SGR wheel/press/release report enters through the terminal's input callback, so
 * the native renderer's own raw input listener, overlay compositing, and
 * focus dispatch decide where each event goes.
 *
 * Pins the restored compact appearance in the fullscreen renderer: the popup
 * keeps the pre-#413 public overlay geometry (full width, one-row top/bottom
 * margins, centered) and its natural content height — a short list, question,
 * or notice uses only its own rows, longer content grows row for row up to
 * the margin-bounded cap — while the LIVE native transcript stays visible
 * around it, with the popup's theme surface only inside its bounds. Within
 * that frame the keyboard hint stays fixed at every scroll position, keyboard
 * scrolling moves exactly one line, Up/Down reveal the selection, resize
 * clamps and keeps content reachable, a wheel report inside the popup's own
 * rectangle scrolls that popup (and never the transcript behind it) while a
 * wheel report outside it scrolls the transcript and leaves the popup alone,
 * and ordinary answer delivery, close, and reopen are unchanged. The #615
 * regressions preserve explicit list scrolling across controller updates and
 * compare long question/notice scrolling at identical synthetic geometry.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { getKeybindings, matchesKey, Text, TuiAltScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "pi-session-host-tui";
import type { OverlayHandle, OverlayOptions, Terminal } from "pi-session-host-tui";
import { activate } from "../src/index";
import { setHostKeybindingLoader } from "../src/host-keybindings";
import { __resetActiveNativeEditorFieldForTest, setNativeEditorHost } from "../src/native-editor-bridge";
import { questionShortcutLabel } from "../src/user-question/index";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";
import {
  createBridgeUi,
  createRealKeybindingsManager,
  fakeHost,
  loadRealBridgeHost,
  realHostAfter,
  REAL_IDENTITY_THEME,
  skipOrFail,
  SHIFT_ENTER,
  type FakeBridgeEditor,
} from "./bridge-fakes";

const COLUMNS = 80;
const ROWS = 24;
const RESIZED_ROWS = 14;
/** Synthetic short-terminal geometry that makes the pending list overflow. */
const SHORT_ROWS = 12;
const CTRL_ALT_UP = "\x1b[1;7A";
const SHIFT_ALT_DOWN = "\x1b[1;4B";
const SHIFT_ALT_UP = "\x1b[1;4A";
const CTRL_ALT_PAGE_UP = "\x1b[5;7~";
const CTRL_ALT_PAGE_DOWN = "\x1b[6;7~";
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";
const SURFACE_BG = "\x1b[48;5;236m";
const SCROLL_HINT = "Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll";
const LIST_ANSWER_HINT = `arrows select · Enter answer · ${SCROLL_HINT} · Esc defer and close`;
const LIST_MIXED_HINT = `arrows select · Enter open question/notice · ${SCROLL_HINT} · Esc defer and close`;
const NOTICE_HINT = `arrows select · Enter choose · ${SCROLL_HINT} · Esc back`;
const ANSWER_HINT = `arrows select · Enter confirm · ${SCROLL_HINT} · Esc back`;
const EDITING_HINT = "Enter submit · Esc back to options to scroll";

/** SGR wheel report (1-based terminal coordinates). */
function wheel(direction: "up" | "down", x: number, y: number): string {
  return `\x1b[<${direction === "up" ? 64 : 65};${x + 1};${y + 1}M`;
}

/** SGR left-button press and release on one terminal cell (0-based x/y). */
function leftPress(x: number, y: number): string {
  return `\x1b[<0;${x + 1};${y + 1}M`;
}

function leftRelease(x: number, y: number): string {
  return `\x1b[<0;${x + 1};${y + 1}m`;
}

/**
 * The rows outside a rendered popup rectangle — the live native transcript
 * behind it. A wheel the popup claims must leave every one of these rows
 * untouched; a wheel outside the popup must move them.
 */
function outsideBoundsRows(lines: readonly string[], bounds: { row: number; height: number }): string[] {
  return lines.filter((_, index) => index < bounds.row || index >= bounds.row + bounds.height);
}

const stripAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\x1b_[^\x07]*\x07/gu, "").replace(/\x1b\][^\x07]*\x07/gu, "");

/**
 * Witness one exact value in a single frame's rendered rows. A native editor
 * wraps a long value at its row width without inserting a separator, so the
 * value may begin after other row content and continue through adjacent rows.
 * A wrapped run may cross a row boundary only after whitespace padding, and
 * every row in the run must contribute at least one character; rows are never
 * reordered or combined with another frame. This is a terminal-rendering
 * witness, not a substitute for the field's text API.
 */
function renderedRowsContainWrapped(rows: readonly string[], expected: string): boolean {
  const first = expected[0];
  if (first === undefined) return false;
  for (let startRow = 0; startRow < rows.length; startRow += 1) {
    const row = rows[startRow]!;
    for (let start = 0; start < row.length; start += 1) {
      if (row[start] !== first) continue;
      let rowIndex = startRow;
      let column = start;
      let offset = 0;
      while (rowIndex < rows.length) {
        const line = rows[rowIndex]!;
        const before = offset;
        while (column < line.length && offset < expected.length && line[column] === expected[offset]) {
          column += 1;
          offset += 1;
        }
        if (offset === expected.length) return true;
        // Every row in a wrapped run must contribute at least one character;
        // a blank row cannot bridge separated fragments.
        if (offset === before || !/^ *$/u.test(line.slice(column))) break;
        rowIndex += 1;
        if (rowIndex === rows.length) break;
        column = /^ */u.exec(rows[rowIndex]!)?.[0].length ?? 0;
      }
    }
  }
  return false;
}

class VirtualTerminal implements Terminal {
  private onInput?: (data: string) => void;
  private onResize?: () => void;
  constructor(private cols: number, private height: number) {}
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void { this.onInput = undefined; this.onResize = undefined; }
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  get columns(): number { return this.cols; }
  get rows(): number { return this.height; }
  get kittyProtocolActive(): boolean { return true; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  send(data: string): void {
    assert.ok(this.onInput, "the native renderer is listening for terminal input");
    this.onInput(data);
  }
  resize(rows: number): void {
    this.height = rows;
    this.onResize?.();
  }
}

let previousConfig: string | undefined;
let previousDisabled: string | undefined;
let previousRuntimeRole: string | undefined;

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
  if (previousRuntimeRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRuntimeRole;
  setHostKeybindingLoader(undefined);
  setNativeEditorHost(undefined);
  setUserQuestionTuiHost(undefined);
  __resetActiveNativeEditorFieldForTest();
});

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One rendered popup, located through the native overlay bounds. */
interface PopupView {
  bounds: { row: number; col: number; width: number; height: number };
  /** Plain interior rows between the frame's padding rows. */
  interior: string[];
  /** Scrolled body rows (interior minus the blank separator and the fixed hint). */
  body: string[];
  /** First terminal row of the fixed hint. */
  hintRow: number;
}

/**
 * The shared native popup harness: the production extension registration
 * (`activate` → the registered shortcut handler → the shared custom overlay
 * factory) over the pinned real `TuiAltScreen`, with a live native transcript
 * underneath. Every keyboard byte sequence and SGR wheel report enters through
 * the terminal's own input callback. One harness serves every native popup
 * regression in this file; tests add their own pending entries and assertions.
 */
interface NativePopupHarness {
  dir: string;
  terminal: VirtualTerminal;
  tui: TuiAltScreen;
  transcript: Text;
  tools: Map<string, any>;
  sent: string[];
  instances: FakeBridgeEditor[];
  sessionManager: { id: string };
  overlays: Array<{ handle: OverlayHandle; options: OverlayOptions | undefined }>;
  open(): Promise<{ closed: Promise<unknown> }>;
  screen(): string[];
  current(): OverlayHandle;
  view(hint: string, rows?: number): PopupView;
  selected(popup: PopupView, needle: string): boolean;
  natural(contentRows: number, hint: string): number;
  wrappedRows(text: string): number;
  askQuestion(id: string, question: string, choices: string[]): Promise<void>;
  askQuestionWithAbort(
    id: string,
    question: string,
    choices: string[],
    signal: AbortSignal,
  ): Promise<unknown>;
  addNotice(id: string, title: string, body: string, context?: string): Promise<void>;
  dispose(): Promise<void>;
}

async function startNativePopupHarness(options: { rows?: number } = {}): Promise<NativePopupHarness> {
  const rows = options.rows ?? ROWS;
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  // Hermetic top-level surface, as in the entrypoint tests.
  delete process.env.PI_REVIEW_GATE_DISABLED;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-native-popup-"));
  const terminal = new VirtualTerminal(COLUMNS, rows);
  const tui = new TuiAltScreen(terminal);
  assert.equal(tui.mode, "fullscreen", "the pinned native renderer is the fullscreen alternate-screen TUI");
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    maxCorrectionCycles: 3,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    review: { activeReviewers: [] },
  }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
  const sent: string[] = [];
  await activate({
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut(shortcut: string, options: { handler: (ctx: unknown) => unknown }) { shortcuts.set(shortcut, options); },
    notify() {},
    sendUserMessage(message: string) { sent.push(message); return Promise.resolve(); },
    ui: { setStatus() {} },
  });
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  // The running pi-tui's own width helpers and raw key matcher, as the
  // production host loader would resolve them inside Pi.
  setUserQuestionTuiHost({ matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi });
  const sessionManager = { id: "native-popup-session" };
  const sessionContext = { cwd: dir, ui: { setWidget() {} }, sessionManager, mode: "tui" };
  for (const handler of hooks.get("session_start") ?? []) await handler({ cwd: dir }, sessionContext);

  // A long native transcript underneath; it stays live while the popup is open.
  const transcript = new Text(Array.from({ length: 200 }, (_, index) => `Transcript line ${index + 1}`).join("\n"), 0, 0);
  tui.addChild(transcript);
  tui.start();
  tui.renderNow(true);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: (_color: string, text: string) => `${SURFACE_BG}${text}\x1b[49m`,
  };
  const overlays: Array<{ handle: OverlayHandle; options: OverlayOptions | undefined }> = [];
  const open = async (): Promise<{ closed: Promise<unknown> }> => {
    const bridge = createBridgeUi({ keybindings: getKeybindings(), draft: "chat draft", drivers: [] });
    // Mirror Pi 1.5.0 InteractiveMode.showExtensionCustom for overlays.
    const custom = (factory: (...args: unknown[]) => unknown, options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions;
      onHandle?: (handle: OverlayHandle) => void;
    }) => new Promise((resolve) => {
      let handle: OverlayHandle | undefined;
      let closed = false;
      const done = (result: unknown) => {
        if (closed) return;
        closed = true;
        handle?.hide();
        resolve(result);
      };
      Promise.resolve(factory(tui, theme, getKeybindings(), done)).then((component) => {
        if (closed) return;
        assert.equal(options?.overlay, true, "the shared popup is a public custom overlay");
        handle = tui.showOverlay(component as never, options?.overlayOptions);
        overlays.push({ handle, options: options?.overlayOptions });
        options?.onHandle?.(handle);
      });
    });
    const before = overlays.length;
    const opening = shortcuts.get("ctrl+alt+up")!.handler({
      ui: { ...bridge.ui, custom },
      sessionManager,
      isIdle: () => true,
    }) as Promise<unknown>;
    await until(() => overlays.length > before);
    return { closed: opening };
  };
  const screen = (): string[] => {
    tui.renderNow(true);
    return tui.getScreenLines();
  };
  const current = (): OverlayHandle => overlays.at(-1)!.handle;
  const wrappedRows = (text: string): number => wrapTextWithAnsi(text, COLUMNS - 2).length;
  /** Pre-#413 natural frame: two rules, two padding rows, content, a blank separator, and the hint. */
  const natural = (contentRows: number, hint: string): number => 2 + 2 + contentRows + 1 + wrappedRows(hint);

  /**
   * Locate the popup through the native overlay bounds and check the compact
   * appearance: the frame (rules, padding, theme surface) only within its
   * centered, margin-bounded rectangle; outside it, the native transcript
   * rows without any popup surface.
   */
  const view = (hint: string, viewRows = rows): PopupView => {
    const lines = screen();
    assert.equal(lines.length, viewRows);
    const bounds = current().getBounds();
    assert.ok(bounds, "the native overlay reports its rendered rectangle");
    assert.equal(bounds.col, 0);
    assert.equal(bounds.width, COLUMNS, "the popup keeps the full conversation width");
    assert.ok(bounds.height <= viewRows - 2, "the popup stays within its one-row top and bottom margins");
    assert.equal(bounds.row, 1 + Math.floor((viewRows - 2 - bounds.height) / 2), "the popup stays centered inside its margins");
    const plain = lines.map(stripAnsi);
    for (const [index, line] of lines.entries()) {
      const inside = index >= bounds.row && index < bounds.row + bounds.height;
      if (inside) {
        assert.ok(line.includes(SURFACE_BG) && !/Transcript line/u.test(plain[index]!), `popup row ${index} carries the native theme surface`);
      } else {
        assert.ok(!line.includes(SURFACE_BG), `row ${index} outside the popup has no popup surface fill`);
        assert.match(plain[index]!, /Transcript line \d+/u, `row ${index} outside the popup shows the native transcript`);
      }
    }
    const frame = plain.slice(bounds.row, bounds.row + bounds.height);
    assert.match(frame[0]!, /^─+$/u, "the frame starts with its top rule");
    assert.match(frame.at(-1)!, /^─+$/u, "the frame ends with its bottom rule");
    assert.equal(frame[1]!.trim(), "", "a blank padding row follows the top rule");
    assert.equal(frame.at(-2)!.trim(), "", "a blank padding row precedes the bottom rule");
    const interior = frame.slice(2, -2).map((line) => line.slice(1).trimEnd());
    const hintRows = wrappedRows(hint);
    const hintText = interior.slice(-hintRows).join(" ").replace(/\s+/gu, " ").trim();
    assert.equal(hintText, hint, `the fixed keyboard hint closes the frame: ${interior.join(" | ")}`);
    assert.equal(interior.at(-hintRows - 1), "", "a blank separator sits between the body and the fixed hint");
    return {
      bounds,
      interior,
      body: interior.slice(0, -hintRows - 1),
      hintRow: bounds.row + 2 + interior.length - hintRows,
    };
  };
  const selected = (popup: PopupView, needle: string): boolean =>
    popup.body.some((line) => line.trimStart().startsWith("> ") && line.includes(needle));

  const askQuestion = async (id: string, question: string, choices: string[]): Promise<void> => {
    await tools.get("AskUserQuestion")!.execute(id, { question, choices }, undefined, undefined, { sessionManager });
  };
  const askQuestionWithAbort = (id: string, question: string, choices: string[], signal: AbortSignal): Promise<unknown> =>
    tools.get("AskUserQuestion")!.execute(
      id,
      { question, choices, mode: "sync" },
      signal,
      undefined,
      { sessionManager },
    );
  const addNotice = async (id: string, title: string, body: string, context?: string): Promise<void> => {
    await tools.get("YouShouldKnow")!.execute(
      id,
      { title, body, ...(context === undefined ? {} : { context }) },
      undefined,
      undefined,
      { sessionManager },
    );
  };

  return {
    dir,
    terminal,
    tui,
    transcript,
    tools,
    sent,
    instances,
    sessionManager,
    overlays,
    open,
    screen,
    current,
    view,
    selected,
    natural,
    wrappedRows,
    askQuestion,
    askQuestionWithAbort,
    addNotice,
    dispose: async () => {
      tui.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("synthetic popup wrap witness: one contiguous rendered run carries the wrapped path", () => {
  // Synthetic rows only: this pins the frame-witness helper, not a native host
  // rendering result.
  const path = "/tmp/pi-clipboard-488-1.png";
  const basename = "pi-clipboard-488-1.png";
  const split = path.indexOf("488-1.png");
  const prefix = path.slice(0, split);
  const suffix = path.slice(split);
  const wrapped = [`  ${prefix}`, `  ${suffix}  `];

  assert.equal(renderedRowsContainWrapped(wrapped, path), true,
    "the complete path is recognized across adjacent wrapped rows");
  assert.equal(renderedRowsContainWrapped(wrapped, basename), true,
    "the complete basename is recognized across the same wrap");
  assert.equal(renderedRowsContainWrapped([`  ${path}  `], path), true,
    "an ordinary unwrapped row still carries the path");
  assert.equal(renderedRowsContainWrapped([`  ${prefix}`, "  an unrelated popup row", `  ${suffix}`], path), false,
    "a non-contiguous occurrence is not joined across an unrelated row");
  assert.equal(renderedRowsContainWrapped([`  ${prefix}`, "  ", `  ${suffix}`], path), false,
    "a blank row is not skipped to join separated fragments");
  assert.equal(renderedRowsContainWrapped([`  ${prefix}`, `  ${suffix.slice(1)}`], path), false,
    "a missing character is not hidden by wrapping");
  assert.equal(renderedRowsContainWrapped([`  ${suffix}`, `  ${prefix}`], path), false,
    "rows are not reordered to manufacture the path");
});

test("native fullscreen: the compact popup keeps its natural size over the live transcript and scrolls by keyboard and pointer-owned wheel", async () => {
  const harness = await startNativePopupHarness();
  const { terminal, transcript, sent, instances, overlays, open, screen, view, selected, natural, wrappedRows, askQuestion, addNotice } = harness;
  try {
    await askQuestion("q1", "Short question?", ["Keep the lane"]);
    const listHeader = `Pending input (1) · ${questionShortcutLabel()} to close`;
    assert.equal(wrappedRows(listHeader), 1);

    // --- Short one-item list: sized to its entry, transcript visible around it ---
    const { closed: firstOpening } = await open();
    assert.deepEqual(overlays[0]!.options, {
      width: "100%", anchor: "center", margin: { top: 1, right: 0, bottom: 1, left: 0 }, maxHeight: "100%",
    }, "the overlay keeps the pre-#413 public geometry");
    let popup = view(LIST_ANSWER_HINT);
    assert.equal(popup.bounds.height, natural(3, LIST_ANSWER_HINT), "a one-item list is sized to its single entry");
    assert.ok(popup.bounds.height < ROWS / 2, "the short list leaves most of the transcript visible");
    assert.deepEqual(popup.body, [listHeader, "", "> q1: Short question?"]);

    // The background is the LIVE native transcript, not a frozen copy.
    transcript.setText(Array.from({ length: 200 }, (_, index) => `Transcript line ${index + 1} live`).join("\n"));
    const liveRows = screen().map(stripAnsi);
    assert.ok(liveRows[0]!.includes(" live") && liveRows.at(-1)!.includes(" live"),
      "transcript updates render above and below the open popup");
    popup = view(LIST_ANSWER_HINT);

    // A wheel report over the popup belongs to the popup (#413). This short
    // list has nothing to scroll, so no popup row moves — and because the
    // popup claims the event, the live transcript behind it never moves.
    const beforeWheel = popup.interior;
    const beforeWheelScreen = screen();
    terminal.send(wheel("down", 10, popup.bounds.row + 3));
    terminal.send(wheel("up", 10, popup.bounds.row + 3));
    assert.deepEqual(view(LIST_ANSWER_HINT).interior, beforeWheel,
      "a wheel over a popup with nothing to scroll moves no popup row and selects nothing");
    assert.deepEqual(screen(), beforeWheelScreen, "and the native transcript behind the popup never moved");

    // --- Short question: only its natural rows ---
    terminal.send(ENTER);
    popup = view(ANSWER_HINT);
    // q1:, the plain-text disclosure and a blank row, the question, a blank
    // row, the choice, Type something…, and Decline.
    assert.equal(popup.bounds.height, natural(8, ANSWER_HINT), "a short question uses only its natural rows");
    assert.ok(selected(popup, "1. Keep the lane"));

    // Close and register two notices: each one-row entry adds one list row.
    terminal.send(CTRL_ALT_UP);
    await firstOpening;
    assert.ok(screen().every((line) => !line.includes(SURFACE_BG)), "closing leaves no popup surface behind");
    await addNotice("n1", "Long notice",
      Array.from({ length: 40 }, (_, index) => `Notice body row ${String(index + 1).padStart(2, "0")}`).join("\n"),
      "Context first row\nCONTEXT-END");
    const shortNoticeBody = "One short notice row.";
    await addNotice("n2", "Short notice", shortNoticeBody);

    const { closed: secondOpening } = await open();
    popup = view(LIST_MIXED_HINT);
    assert.equal(popup.bounds.height, natural(2 + 3, LIST_MIXED_HINT), "a three-item list is sized to its three entries");
    assert.equal(popup.body[0], `Pending input (3) · ${questionShortcutLabel()} to close`);

    // --- Short notice: natural rows ---
    for (let index = 0; index < 2; index += 1) terminal.send(DOWN);
    assert.ok(selected(view(LIST_MIXED_HINT), "n2: Short notice"));
    terminal.send(ENTER);
    popup = view(NOTICE_HINT);
    // Title and a blank row, the disclosure and a blank row, the body, a blank
    // row, More details, and Close.
    assert.equal(popup.bounds.height, natural(8, NOTICE_HINT), "a short notice uses only its natural rows");
    assert.ok(popup.body.includes(shortNoticeBody));

    // --- Long notice: capped below the full terminal; keyboard scrolling under a fixed hint ---
    terminal.send(ESCAPE);
    terminal.send(UP); // the long notice (list order: q1, n1, n2)
    assert.ok(selected(view(LIST_MIXED_HINT), "n1: Long notice"));
    terminal.send(ENTER);
    popup = view(NOTICE_HINT);
    assert.equal(popup.bounds.height, ROWS - 2, "long content grows only to the margin-bounded cap");
    assert.equal(popup.bounds.row, 1, "the capped popup keeps one transcript row above it");
    assert.equal(popup.body[0], "n1: Long notice", "the long notice opens at its beginning");
    assert.ok(!popup.body.some((line) => line.includes("More details")), "actions scroll with the body; they are not fixed");
    const hintRow = popup.hintRow;
    const reached = new Set(popup.body);
    for (let step = 0; step < 80 && !popup.body.some((line) => line.includes("Close")); step += 1) {
      terminal.send(SHIFT_ALT_DOWN);
      const next = view(NOTICE_HINT);
      assert.equal(next.hintRow, hintRow, "the hint stays in its fixed rows at every scroll position");
      assert.deepEqual(next.body.slice(0, -1), popup.body.slice(1), "each Shift+Alt+Down moves exactly one line");
      popup = next;
      for (const line of popup.body) reached.add(line);
    }
    for (let row = 1; row <= 40; row += 1) {
      assert.ok(reached.has(`Notice body row ${String(row).padStart(2, "0")}`), `notice body row ${row} is reachable`);
    }
    assert.ok(reached.has("CONTEXT-END") && reached.has("> More details") && reached.has("  Close"),
      "the complete context and both actions are reachable");
    const atEnd = popup.interior;
    terminal.send(SHIFT_ALT_DOWN);
    assert.deepEqual(view(NOTICE_HINT).interior, atEnd, "keyboard scrolling is bounded at the end");
    for (let step = 0; step < 80; step += 1) terminal.send(SHIFT_ALT_UP);
    assert.equal(view(NOTICE_HINT).body[0], "n1: Long notice", "keyboard scrolling returns to the beginning");
    terminal.send(DOWN);
    assert.ok(selected(view(NOTICE_HINT), "Close"), "Down selects and reveals the Close action");
    terminal.send(UP);
    popup = view(NOTICE_HINT);
    assert.ok(selected(popup, "More details"), "Up selects and reveals More details");

    // --- Pointer-owned wheel scrolling over that same long notice ---
    // One wheel report inside the popup's rectangle moves exactly one line —
    // the same line Shift+Alt+Down moves — while the live transcript rows
    // around the popup stay put. The pointer cell is inside the drawn frame
    // but on no menu entry, so nothing is highlighted or activated.
    const wheelCell = 10;
    const wheelRow = popup.bounds.row + 3;
    const outsidePopup = (lines: string[]): string[] => outsideBoundsRows(lines, popup.bounds);
    const bodyBeforeWheel = popup.body;
    const screenBeforeWheel = screen();
    terminal.send(wheel("up", wheelCell, wheelRow));
    let wheelPopup = view(NOTICE_HINT);
    assert.deepEqual(wheelPopup.body.slice(1), bodyBeforeWheel.slice(0, -1),
      "one wheel report inside the popup moves exactly one line");
    assert.ok(selected(wheelPopup, "More details") && !selected(wheelPopup, "Close"),
      "the wheel highlights, selects, and activates nothing of its own");
    assert.deepEqual(outsidePopup(screen()), outsidePopup(screenBeforeWheel),
      "the transcript around the popup never moves under a wheel inside it");
    for (let step = 0; step < 80; step += 1) terminal.send(wheel("down", wheelCell, wheelRow));
    wheelPopup = view(NOTICE_HINT);
    assert.ok(wheelPopup.body.some((line) => line.includes("Close")), "the wheel reaches the end of the notice content");
    const atWheelEnd = wheelPopup.interior;
    terminal.send(wheel("down", wheelCell, wheelRow));
    assert.deepEqual(view(NOTICE_HINT).interior, atWheelEnd, "a wheel past the popup's end is claimed and changes nothing");
    assert.deepEqual(outsidePopup(screen()), outsidePopup(screenBeforeWheel),
      "even at that bound the transcript behind the popup does not move");
    for (let step = 0; step < 80; step += 1) terminal.send(wheel("up", wheelCell, wheelRow));
    wheelPopup = view(NOTICE_HINT);
    assert.equal(wheelPopup.body[0], "n1: Long notice", "the wheel returns the popup to its beginning");
    const atWheelStart = wheelPopup.interior;
    terminal.send(wheel("up", wheelCell, wheelRow));
    assert.deepEqual(view(NOTICE_HINT).interior, atWheelStart, "a wheel before the popup's beginning is claimed and changes nothing");
    assert.deepEqual(outsidePopup(screen()), outsidePopup(screenBeforeWheel),
      "and the transcript behind it still does not move");

    // A wheel report outside the popup's rectangle is left to Pi: the native
    // transcript scrolls and the popup keeps its own scroll position.
    const abovePopup = popup.bounds.row - 1;
    assert.ok(abovePopup >= 0, "one transcript row stays visible above the capped popup");
    const bodyBeforeBackgroundWheel = view(NOTICE_HINT).body;
    terminal.send(wheel("up", wheelCell, abovePopup));
    assert.notDeepEqual(outsidePopup(screen()), outsidePopup(screenBeforeWheel),
      "a wheel outside the popup scrolls the native transcript as usual");
    assert.deepEqual(view(NOTICE_HINT).body, bodyBeforeBackgroundWheel,
      "and that wheel leaves the popup's viewport exactly where it was");
    terminal.send(wheel("down", wheelCell, abovePopup));
    assert.deepEqual(outsidePopup(screen()), outsidePopup(screenBeforeWheel),
      "a wheel back down outside the popup returns the native transcript to its earlier rows");
    assert.deepEqual(view(NOTICE_HINT).body, bodyBeforeBackgroundWheel,
      "and the popup is still untouched by background wheel input");
    popup = view(NOTICE_HINT);

    // --- Resize: the cap follows the live terminal; the offset is kept and content stays reachable ---
    const firstBeforeResize = popup.body[0];
    terminal.resize(RESIZED_ROWS);
    popup = view(NOTICE_HINT, RESIZED_ROWS);
    assert.equal(popup.bounds.height, RESIZED_ROWS - 2, "the resized popup is capped at the new margin-bounded height");
    assert.equal(popup.body[0], firstBeforeResize, "resize keeps the scroll position");
    for (let step = 0; step < 80 && !popup.body.includes("  Close"); step += 1) {
      terminal.send(SHIFT_ALT_DOWN);
      popup = view(NOTICE_HINT, RESIZED_ROWS);
    }
    assert.ok(popup.body.includes("> More details") && popup.body.includes("  Close"), "the end stays reachable after resize");
    for (let step = 0; step < 80; step += 1) terminal.send(SHIFT_ALT_UP);
    popup = view(NOTICE_HINT, RESIZED_ROWS);
    assert.equal(popup.body[0], "n1: Long notice", "the beginning stays reachable after resize");
    terminal.resize(ROWS);
    assert.equal(view(NOTICE_HINT).bounds.height, ROWS - 2);

    // --- Long question: opens at its beginning; choices, editing, and answer delivery ---
    terminal.send(CTRL_ALT_UP);
    await secondOpening;
    await askQuestion("q2", Array.from({ length: 30 }, (_, index) => `Question detail ${index + 1}.`).join("\n\n"), ["Alpha", "Beta"]);
    const { closed: thirdOpening } = await open();
    for (let index = 0; index < 3; index += 1) terminal.send(DOWN); // q2 (list order: q1, n1, n2, q2)
    assert.ok(selected(view(LIST_MIXED_HINT), "q2: Question detail 1."), "Down reveals the long question's list entry");
    terminal.send(ENTER);
    popup = view(ANSWER_HINT);
    assert.equal(popup.bounds.height, ROWS - 2);
    assert.equal(popup.body[0], "q2:", "the long question opens at its beginning");
    assert.ok(!popup.body.some((line) => line.includes("> 1. Alpha")), "opening does not jump to the first choice");

    // The same pointer-owned wheel rule applies to a long AskUserQuestion:
    // one report inside the popup scrolls the question body one line, and the
    // live transcript behind the popup does not move.
    const questionBodyBefore = popup.body;
    const questionScreenBefore = screen();
    terminal.send(wheel("down", 10, popup.bounds.row + 3));
    let questionWheel = view(ANSWER_HINT);
    assert.deepEqual(questionWheel.body.slice(0, -1), questionBodyBefore.slice(1),
      "a wheel report inside a long question scrolls its body exactly one line");
    assert.deepEqual(outsideBoundsRows(screen(), questionWheel.bounds), outsideBoundsRows(questionScreenBefore, questionWheel.bounds),
      "and the transcript behind the question never moved");
    terminal.send(wheel("up", 10, popup.bounds.row + 3));
    questionWheel = view(ANSWER_HINT);
    assert.deepEqual(questionWheel.body, questionBodyBefore, "the wheel returns the question to where it was");
    assert.deepEqual(outsideBoundsRows(screen(), questionWheel.bounds), outsideBoundsRows(questionScreenBefore, questionWheel.bounds),
      "with the transcript still untouched");

    terminal.send(DOWN);
    assert.ok(selected(view(ANSWER_HINT), "2. Beta"), "Down selects and reveals the second choice");
    terminal.send(DOWN); // Type something…
    terminal.send(ENTER); // edit
    for (const character of "draft") terminal.send(character);
    popup = view(EDITING_HINT);
    assert.ok(popup.body.some((line) => line.includes("[field:draft]")), "the active native field is visible while editing");
    terminal.send(SHIFT_ALT_UP);
    popup = view(EDITING_HINT);
    assert.ok(popup.body.some((line) => line.includes("[field:draft]")),
      "the scroll keys belong to the native field while editing, so the cursor row stays in view");
    terminal.send(ESCAPE); // back to the options
    for (let step = 0; step < 100; step += 1) terminal.send(SHIFT_ALT_UP);
    popup = view(ANSWER_HINT);
    assert.equal(popup.body[0], "q2:", "after Esc the scroll keys page back to the question beginning");
    assert.equal(instances.at(-1)!.getText(), "draft", "scrolling neither mutates nor submits the draft");
    terminal.send(UP); // Beta (revealed)
    assert.ok(selected(view(ANSWER_HINT), "2. Beta"), "Up reveals the selected choice from the beginning");
    assert.equal(sent.length, 0, "no scroll or selection input sent anything to the model");
    terminal.send(ENTER);
    await until(() => sent.length === 1);
    assert.match(sent[0]!, /Beta/u, "the confirmed choice is delivered as an ordinary answer");
    popup = view(LIST_MIXED_HINT);
    assert.ok(!popup.body.some((line) => line.includes("q2:")), "only the answered question leaves the list");

    // Close and reopen: a fresh popup with the same compact geometry.
    terminal.send(CTRL_ALT_UP);
    await thirdOpening;
    const { closed: reopened } = await open();
    popup = view(LIST_MIXED_HINT);
    assert.equal(popup.bounds.height, natural(2 + 3, LIST_MIXED_HINT), "the reopened list is sized to its three one-row entries");
    terminal.send(CTRL_ALT_UP);
    await reopened;
    assert.equal(overlays.length, 4);
    assert.equal(sent.length, 1, "only the confirmed answer reached the model");
  } finally {
    await harness.dispose();
  }
});

test("native fullscreen: an explicit pending-list scroll survives unrelated controller updates (#615)", async () => {
  const harness = await startNativePopupHarness({ rows: SHORT_ROWS });
  const { terminal, sent, open, screen, view, selected, askQuestion, askQuestionWithAbort, addNotice } = harness;
  /** The pending entry each body row shows, in list order ("q3", "n4", …). */
  const entryIds = (popup: PopupView): string[] => popup.body.flatMap((line) => {
    const match = /^\s*>?\s*([qn]\d+):/u.exec(line);
    return match ? [match[1]!] : [];
  });
  const listHeader = (count: number): string => `Pending input (${count}) · ${questionShortcutLabel()} to close`;
  const showsEntry = (popup: PopupView, id: string): boolean => popup.body.some((line) => line.includes(`${id}:`));
  const showsSelectedEntry = (popup: PopupView, id: string): boolean => selected(popup, `${id}:`);
  const selectedEntryId = (popup: PopupView): string | undefined => {
    for (const line of popup.body) {
      const match = /^\s*>\s*([qn]\d+):/u.exec(line);
      if (match) return match[1];
    }
    return undefined;
  };
  // Live count of registered pending entries, so every header assertion reads
  // the same state the popup does instead of a hand-maintained number.
  let pendingCount = 0;
  const registerQuestion = async (id: string, question: string, choices: string[]): Promise<void> => {
    await askQuestion(id, question, choices);
    pendingCount += 1;
  };
  const registerNotice = async (id: string, title: string, body: string): Promise<void> => {
    await addNotice(id, title, body);
    pendingCount += 1;
  };

  try {
    // Twelve pending entries through the production tools: six questions and
    // six notices, so one list geometry owns both entry kinds.
    for (let index = 1; index <= 6; index += 1) {
      await registerQuestion(`tc-q${index}`, `Choose the lane for ${index}?`, ["Alpha", "Beta"]);
      await registerNotice(`tc-n${index}`, `Notice ${index}`, `Notice ${index} body.`);
    }
    const { closed: opening } = await open();

    let popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.equal(popup.bounds.height, SHORT_ROWS - 2, "a twelve-entry list is capped inside the one-row margins");
    assert.equal(popup.body[0], listHeader(pendingCount));
    assert.ok(showsSelectedEntry(popup, "q1"), "the implicit first selection is revealed on open");
    assert.ok(!showsEntry(popup, "n6"), "the last entry starts out of view");

    // --- keyboard scrolling moves the list one line at a time ---
    const idsBeforeScroll = new Set(entryIds(popup));
    for (let step = 0; step < 4; step += 1) {
      const before = popup;
      terminal.send(SHIFT_ALT_DOWN);
      const next = view(LIST_MIXED_HINT, SHORT_ROWS);
      assert.equal(next.hintRow, before.hintRow, "the fixed hint does not move while the list scrolls");
      assert.deepEqual(next.body.slice(0, -1), before.body.slice(1), "each Shift+Alt+Down moves the list exactly one line");
      popup = next;
    }
    assert.ok(entryIds(popup).some((id) => !idsBeforeScroll.has(id)), "keyboard scrolling brings later entries into view");
    assert.ok(!showsSelectedEntry(popup, "q1"), "the selected first entry is now scrolled out of the viewport");

    // --- the reported defect (#615): registering an entry while scrolled used
    // to re-reveal the selection and snap the viewport back to the top ---
    const screenBeforeRegister = screen();
    await registerNotice("tc-n7", "Late notice", "Late notice body.");
    const afterRegister = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.deepEqual(afterRegister.body, popup.body,
      "a new pending entry leaves the scrolled list viewport exactly where the reader put it");
    assert.ok(!showsEntry(afterRegister, "n7"), "the new entry does not jump into the viewport");
    assert.deepEqual(outsideBoundsRows(screen(), afterRegister.bounds), outsideBoundsRows(screenBeforeRegister, afterRegister.bounds),
      "the native transcript behind the popup never moved");
    popup = afterRegister;

    // --- repeated controller updates interleaved with wheel scrolling ---
    const wheelCell = 10;
    const wheelRow = popup.bounds.row + 3;
    for (let round = 0; round < 3; round += 1) {
      await registerNotice(`tc-extra-${round}`, `Extra notice ${round}`, `Extra body ${round}.`);
      const afterUpdate = view(LIST_MIXED_HINT, SHORT_ROWS);
      assert.deepEqual(afterUpdate.body, popup.body, `a controller update between wheel steps ${round} keeps the list position`);
      terminal.send(wheel("down", wheelCell, wheelRow));
      const afterWheel = view(LIST_MIXED_HINT, SHORT_ROWS);
      assert.deepEqual(afterWheel.body.slice(0, -1), afterUpdate.body.slice(1),
        `the list still moves exactly one line after controller update ${round}`);
      popup = afterWheel;
    }

    // --- the wheel reaches both ends of the grown list, in both directions ---
    const seenWhileWheeling = new Set<string>(entryIds(popup));
    for (let step = 0; step < 60 && !showsEntry(popup, "n10"); step += 1) {
      terminal.send(wheel("down", wheelCell, wheelRow));
      popup = view(LIST_MIXED_HINT, SHORT_ROWS);
      for (const id of entryIds(popup)) seenWhileWheeling.add(id);
    }
    assert.ok(showsEntry(popup, "n10"), "the wheel reaches the last registered notice");
    assert.ok([...seenWhileWheeling].some((id) => id.startsWith("q")), "the wheel reaches question entries of the list");
    assert.ok([...seenWhileWheeling].some((id) => id.startsWith("n")), "the wheel reaches notice entries of the list");
    const atWheelEnd = popup.interior;
    terminal.send(wheel("down", wheelCell, wheelRow));
    assert.deepEqual(view(LIST_MIXED_HINT, SHORT_ROWS).interior, atWheelEnd, "a wheel past the list end is claimed and changes nothing");
    for (let step = 0; step < 60; step += 1) terminal.send(wheel("up", wheelCell, wheelRow));
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.equal(popup.body[0], listHeader(pendingCount), "the wheel returns the list to its beginning, with the live entry count");
    assert.ok(showsSelectedEntry(popup, "q1"), "the first entry is visible again at the beginning");
    const atWheelStart = popup.interior;
    terminal.send(wheel("up", wheelCell, wheelRow));
    assert.deepEqual(view(LIST_MIXED_HINT, SHORT_ROWS).interior, atWheelStart, "a wheel before the list beginning is claimed and changes nothing");

    // --- a pointer press selects without revealing, and a held press that is
    // cancelled by a wheel still does not pull the viewport back later ---
    for (let step = 0; step < 3; step += 1) terminal.send(wheel("down", wheelCell, wheelRow));
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    const pressedEntry = entryIds(popup)[0]!;
    assert.notEqual(pressedEntry, "q1", "the row to press shows a different entry than the selected one");
    const pressRow = popup.bounds.row + 2;
    terminal.send(leftPress(5, pressRow));
    const afterPress = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.equal(selectedEntryId(afterPress), pressedEntry, "a press on a visible list row selects that entry");
    assert.deepEqual(entryIds(afterPress), entryIds(popup), "the press alone did not move the list viewport");
    terminal.send(wheel("down", wheelCell, wheelRow));
    terminal.send(leftRelease(5, pressRow));
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.equal(entryIds(popup)[0], entryIds(afterPress)[1],
      "the wheel that cancels the held press still moves the list exactly one line");
    await registerNotice("tc-after-press", "After press", "After press body.");
    assert.deepEqual(view(LIST_MIXED_HINT, SHORT_ROWS).body, popup.body,
      "a controller update after a press and a wheel keeps the list where the reader left it");

    // --- Ctrl+Alt+PageDown/PageUp page the same offset, both directions ---
    // Move away from the beginning first: while the header row is visible, a
    // changed entry count is a real content change, not a viewport move.
    for (let step = 0; step < 3; step += 1) terminal.send(wheel("down", wheelCell, wheelRow));
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.ok(!popup.body[0].startsWith("Pending input"), "the header row has scrolled out of the list viewport");
    for (const direction of ["down", "up"] as const) {
      const key = direction === "down" ? CTRL_ALT_PAGE_DOWN : CTRL_ALT_PAGE_UP;
      const before = view(LIST_MIXED_HINT, SHORT_ROWS);
      terminal.send(key);
      const afterKey = view(LIST_MIXED_HINT, SHORT_ROWS);
      assert.deepEqual(direction === "down" ? afterKey.body.slice(0, -1) : before.body.slice(0, -1),
        direction === "down" ? before.body.slice(1) : afterKey.body.slice(1),
        `Ctrl+Alt+Page${direction === "down" ? "Down" : "Up"} moves the list exactly one line`);
      await registerNotice(`tc-page-${direction}`, `Page notice ${direction}`, "Page body.");
      const afterUpdate = view(LIST_MIXED_HINT, SHORT_ROWS);
      assert.deepEqual(afterUpdate.body, afterKey.body, `Ctrl+Alt+Page${direction === "down" ? "Down" : "Up"} keeps the position across a controller update`);
    }

    // --- selection navigation still reveals the selected entry ---
    for (let step = 0; step < 10; step += 1) terminal.send(DOWN);
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    const navigated = entryIds(popup).find((id) => showsSelectedEntry(popup, id));
    assert.ok(navigated !== undefined, "Down keeps the selected entry inside the viewport while navigating");

    // An arrow key whose reveal is immediately cancelled by a wheel must not
    // have that reveal applied by a controller update that arrives later.
    const topBeforeCancelledWheel = entryIds(popup)[0];
    terminal.send(DOWN);
    terminal.send(wheel("up", wheelCell, wheelRow));
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.notEqual(entryIds(popup)[0], topBeforeCancelledWheel, "the wheel after the arrow key moved the list");
    await registerNotice("tc-after-cancelled-reveal", "After cancelled reveal", "Cancelled reveal body.");
    assert.deepEqual(view(LIST_MIXED_HINT, SHORT_ROWS).body, popup.body,
      "a controller update does not apply a reveal the wheel already cancelled");

    // --- the selected record disappearing still reveals the fallback ---
    const abort = new AbortController();
    const syncWait = askQuestionWithAbort("tc-sync", "Which abort lane?", ["Abort"], abort.signal);
    pendingCount += 1;
    for (let step = 0; step < 30 && !showsSelectedEntry(popup, "q7"); step += 1) {
      terminal.send(DOWN);
      popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    }
    assert.ok(showsSelectedEntry(popup, "q7"), "the waiting sync question is selected and revealed");
    for (let step = 0; step < 4; step += 1) terminal.send(wheel("up", wheelCell, wheelRow));
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.ok(!showsSelectedEntry(popup, "q7"), "the selected sync question is scrolled out of the viewport");
    abort.abort();
    await syncWait;
    pendingCount -= 1;
    popup = view(LIST_MIXED_HINT, SHORT_ROWS);
    assert.ok(!popup.body.some((line) => line.includes("q7:")), "the aborted sync question left the pending list");
    assert.ok(showsSelectedEntry(popup, "q1"), "the fallback selection is revealed when the selected record disappears");

    // --- the answer view's choices and the notice view's actions are unchanged ---
    terminal.send(ENTER);
    let detail = view(ANSWER_HINT, SHORT_ROWS);
    assert.equal(detail.body[0], "q1:", "the selected question opens at its beginning");
    for (let step = 0; step < 30 && !detail.body.some((line) => line.includes("1. Alpha")); step += 1) {
      terminal.send(SHIFT_ALT_DOWN);
      detail = view(ANSWER_HINT, SHORT_ROWS);
    }
    assert.ok(detail.body.some((line) => line.includes("> 1. Alpha")), "the question's choices are still reachable");
    terminal.send(ESCAPE);
    terminal.send(DOWN); // the notice after q1 (list order: q1, n1, …)
    terminal.send(ENTER);
    detail = view(NOTICE_HINT, SHORT_ROWS);
    for (let step = 0; step < 30
      && !(detail.body.some((line) => line.includes("More details")) && detail.body.some((line) => line.includes("Close"))); step += 1) {
      terminal.send(SHIFT_ALT_DOWN);
      detail = view(NOTICE_HINT, SHORT_ROWS);
    }
    assert.ok(detail.body.some((line) => line.includes("More details")), "the notice's More details action is still reachable");
    assert.ok(detail.body.some((line) => line.includes("Close")), "and its Close action too");
    terminal.send(ESCAPE);

    // --- resize keeps its existing semantics, then the fix still holds ---
    const selectionBeforeResize = selectedEntryId(view(LIST_MIXED_HINT, SHORT_ROWS));
    assert.ok(selectionBeforeResize, "a list entry is selected before the resize");
    for (let step = 0; step < 4; step += 1) terminal.send(SHIFT_ALT_DOWN);
    assert.ok(!showsSelectedEntry(view(LIST_MIXED_HINT, SHORT_ROWS), selectionBeforeResize),
      "the selection is scrolled out of view before resize re-reveals it");
    terminal.resize(ROWS);
    popup = view(LIST_MIXED_HINT, ROWS);
    assert.equal(popup.bounds.height, ROWS - 2, "the resized list follows the new margin-bounded height");
    assert.equal(selectedEntryId(popup), selectionBeforeResize,
      "resize keeps re-revealing the list selection with its existing semantics");
    for (let step = 0; step < 3; step += 1) terminal.send(SHIFT_ALT_DOWN);
    popup = view(LIST_MIXED_HINT, ROWS);
    await registerNotice("tc-after-resize", "After resize", "After resize body.");
    assert.deepEqual(view(LIST_MIXED_HINT, ROWS).body, popup.body, "the preserved scroll survives a resize to a new geometry");
    for (let step = 0; step < 60 && !showsEntry(popup, "n14"); step += 1) {
      terminal.send(SHIFT_ALT_DOWN);
      popup = view(LIST_MIXED_HINT, ROWS);
    }
    assert.ok(showsEntry(popup, "n14"), "content added after a resize is reachable by scrolling");

    // --- close and reopen routing: a fresh popup starts at its beginning ---
    terminal.send(CTRL_ALT_UP);
    await opening;
    assert.ok(screen().every((line) => !line.includes(SURFACE_BG)), "closing leaves no popup surface behind");
    const { closed: reopened } = await open();
    popup = view(LIST_MIXED_HINT, ROWS);
    assert.equal(popup.body[0], listHeader(pendingCount), "the reopened list reads the live pending state");
    assert.ok(showsSelectedEntry(popup, "q1"), "the reopened popup starts at its beginning with the first entry revealed");
    terminal.send(CTRL_ALT_UP);
    await reopened;
    assert.equal(sent.length, 0, "no scroll, controller update, resize, or navigation sent anything to the model");
  } finally {
    await harness.dispose();
  }
});

test("native fullscreen: a long question and a long notice scroll identically by wheel and both documented keyboard chords (#615)", async () => {
  const harness = await startNativePopupHarness({ rows: SHORT_ROWS });
  const { terminal, sent, open, screen, view, current, askQuestion, addNotice } = harness;

  // The same paragraph text through both tools — one long question and one
  // long notice — rendered at one identical geometry, so any difference
  // between the two runs is that tool's own scroll behaviour and nothing else.
  const sharedText = Array.from({ length: 8 }, (_, index) =>
    `Paragraph ${index + 1} of 8: align the retry budget for the payment worker with the checkout queue before the release ships to production.`).join("\n\n");
  const paragraphMarkers = Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1} of 8`);
  const shows = (popup: PopupView, marker: string): boolean => popup.body.some((line) => line.includes(marker));

  /**
   * Drive one detail view through the whole documented scroll matrix at this
   * geometry: every control moves the rendered body rows exactly one line in
   * both directions, the fixed hint and the native transcript behind the popup
   * never move, both bounds stay claimed and inert, and every paragraph plus
   * the trailing choices or actions becomes reachable with every control.
   * Returns the presses each control needed to traverse the content.
   */
  const exerciseDetail = (hint: string, header: string, trailing: string[]): Record<string, number> => {
    const bounds = current().getBounds()!;
    assert.equal(bounds.height, SHORT_ROWS - 2, "the detail view is capped inside the one-row margins");
    assert.equal(bounds.width, COLUMNS, "the detail view keeps the full conversation width");
    const wheelRow = bounds.row + 3;
    const controls = [
      {
        name: "the pointer wheel",
        down: (): void => { terminal.send(wheel("down", 10, wheelRow)); },
        up: (): void => { terminal.send(wheel("up", 10, wheelRow)); },
      },
      {
        name: "Shift+Alt+Down/Up",
        down: (): void => { terminal.send(SHIFT_ALT_DOWN); },
        up: (): void => { terminal.send(SHIFT_ALT_UP); },
      },
      {
        name: "Ctrl+Alt+PageDown/PageUp",
        down: (): void => { terminal.send(CTRL_ALT_PAGE_DOWN); },
        up: (): void => { terminal.send(CTRL_ALT_PAGE_UP); },
      },
    ];
    const background = outsideBoundsRows(screen(), bounds);

    let popup = view(hint, SHORT_ROWS);
    assert.equal(popup.body[0], header, "the detail view opens at its own header");
    assert.ok(!shows(popup, paragraphMarkers.at(-1)!), "the detail view opens before its last paragraph");

    // One line each way for every control, away from both bounds.
    for (let step = 0; step < 3; step += 1) terminal.send(wheel("down", 10, wheelRow));
    popup = view(hint, SHORT_ROWS);
    for (const control of controls) {
      const before = view(hint, SHORT_ROWS);
      control.down();
      const moved = view(hint, SHORT_ROWS);
      assert.deepEqual(moved.body.slice(0, -1), before.body.slice(1), `${control.name} moves the body exactly one line`);
      assert.equal(moved.hintRow, before.hintRow, `${control.name} leaves the fixed hint in place`);
      assert.deepEqual(outsideBoundsRows(screen(), moved.bounds), background,
        `${control.name} never moves the native transcript behind the popup`);
      control.up();
      const back = view(hint, SHORT_ROWS);
      assert.deepEqual(moved.body.slice(0, -1), back.body.slice(1), `${control.name} moves back exactly one line`);
      assert.deepEqual(back.body, before.body, `${control.name} returns the body to the same rows`);
    }

    // Full traversal with every control, both directions, from a clamped start.
    // Each press is measured against the rows rendered just before it, and the
    // paragraphs that came into view are collected, so reachability is read off
    // the screen rather than inferred.
    const traverse = (send: () => void): { moves: number; seen: Set<string> } => {
      const seen = new Set<string>();
      const collect = (at: PopupView): void => {
        for (const marker of [...paragraphMarkers, ...trailing]) if (shows(at, marker)) seen.add(marker);
      };
      collect(view(hint, SHORT_ROWS));
      let moves = 0;
      for (; ;) {
        const before = view(hint, SHORT_ROWS);
        send();
        const after = view(hint, SHORT_ROWS);
        collect(after);
        if (after.body.join("\n") === before.body.join("\n")) return { moves, seen };
        moves += 1;
        if (moves > 80) return assert.fail(`${hint} never clamped while scrolling`);
      }
    };
    const traversed: Record<string, number> = {};
    for (const control of controls) {
      traverse(control.up); // rewind to the content beginning (clamps)
      const down = traverse(control.down);
      const atEnd = view(hint, SHORT_ROWS);
      for (const marker of [...paragraphMarkers, ...trailing]) {
        assert.ok(down.seen.has(marker), `${control.name} brings "${marker}" into view`);
      }
      assert.ok(shows(atEnd, trailing.at(-1)!), `${control.name} reaches the last "${trailing.at(-1)!}" row at the content end`);
      control.down();
      assert.deepEqual(view(hint, SHORT_ROWS).body, atEnd.body,
        `${control.name} past the content end is claimed and changes nothing`);
      const up = traverse(control.up);
      assert.equal(up.moves, down.moves, `${control.name} returns over the same range`);
      assert.ok(up.seen.has(paragraphMarkers[0]!), `${control.name} passed the first paragraph on the way back`);
      const atStart = view(hint, SHORT_ROWS);
      assert.equal(atStart.body[0], header, `${control.name} returns to the content beginning`);
      control.up();
      assert.deepEqual(view(hint, SHORT_ROWS).body, atStart.body,
        `${control.name} before the content beginning is claimed and changes nothing`);
      assert.deepEqual(outsideBoundsRows(screen(), atStart.bounds), background,
        `${control.name} left the native transcript behind the popup untouched across the whole traversal`);
      traversed[control.name] = down.moves;
    }
    return traversed;
  };

  try {
    await askQuestion("tc-long-q", sharedText, ["Alpha", "Beta"]);
    await addNotice("tc-long-n", "Long notice", sharedText);
    const { closed: opening } = await open();
    view(LIST_MIXED_HINT, SHORT_ROWS);

    // --- the long question's answer view ---
    terminal.send(ENTER);
    const question = view(ANSWER_HINT, SHORT_ROWS);
    const questionSteps = exerciseDetail(ANSWER_HINT, "q1:", ["1. Alpha", "2. Beta", "Type something…", "Decline"]);

    // --- the same matrix on the long notice, at the identical geometry ---
    terminal.send(ESCAPE);
    terminal.send(DOWN);
    terminal.send(ENTER);
    const noticeBounds = current().getBounds()!;
    assert.deepEqual({ width: noticeBounds.width, height: noticeBounds.height, row: noticeBounds.row },
      { width: question.bounds.width, height: question.bounds.height, row: question.bounds.row },
      "the long notice is laid out at the identical geometry as the long question");
    const noticeSteps = exerciseDetail(NOTICE_HINT, "n1: Long notice", ["More details", "Close"]);

    // Within each view every control drives the same range, so no control or
    // tool owns a scroll behaviour of its own.
    assert.ok(Object.values(questionSteps).every((steps) => steps > 0), "the long question scrolls for every control");
    assert.ok(Object.values(noticeSteps).every((steps) => steps > 0), "the long notice scrolls for every control");
    assert.equal(new Set(Object.values(questionSteps)).size, 1, "every control traverses the long question over the same range");
    assert.equal(new Set(Object.values(noticeSteps)).size, 1, "every control traverses the long notice over the same range");

    terminal.send(CTRL_ALT_UP);
    await opening;
    assert.ok(screen().every((line) => !line.includes(SURFACE_BG)), "closing leaves no popup surface behind");
    assert.equal(sent.length, 0, "no scroll control sent anything to the model");
  } finally {
    await harness.dispose();
  }
});

test("native fullscreen: async native image pastes redraw the popup and preserve the native draft", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_DISABLED;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;

  // Keep every fixture write inside this worker-owned workspace. No system
  // clipboard or user session is consulted; the clipboard callback below is
  // an explicitly released async seam carrying synthetic PNG bytes.
  const dir = await mkdtemp(join(process.cwd(), ".user-question-native-paste-"));
  const terminal = new VirtualTerminal(COLUMNS, ROWS);
  const tui = new TuiAltScreen(terminal);
  const keybindings = createRealKeybindingsManager(loaded.tui);
  const instances: FakeBridgeEditor[] = [];
  const hostChanges: Array<{ editor: FakeBridgeEditor; receiver: unknown; text: string; args: unknown[] }> = [];
  const hostChangeCallbacks: Array<{
    editor: FakeBridgeEditor;
    callback: NonNullable<FakeBridgeEditor["onChange"]>;
  }> = [];
  const pendingPastes: Array<{ path: string; release(): void }> = [];
  const pasteErrors: unknown[] = [];
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aHcAAAAASUVORK5CYII=",
    "base64",
  );
  let requestRenderCount = 0;
  const nativeRequestRender = tui.requestRender.bind(tui);
  tui.requestRender = (force?: boolean): void => {
    requestRenderCount += 1;
    nativeRequestRender(force);
  };

  try {
    assert.equal(tui.mode, "fullscreen", "the regression uses the real pinned pi-tui alternate screen");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      maxCorrectionCycles: 3,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200_000,
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
      retainBundles: "never",
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, any>();
    const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
    const sent: string[] = [];
    await activate({
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      registerShortcut(shortcut: string, options: { handler: (ctx: unknown) => unknown }) {
        shortcuts.set(shortcut, options);
      },
      notify() {},
      sendUserMessage(message: string) { sent.push(message); return Promise.resolve(); },
      ui: { setStatus() {} },
    });

    setUserQuestionTuiHost({ matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi });
    const sessionManager = { id: "native-paste-session" };
    const sessionContext = (identity: object) => ({
      cwd: dir,
      ui: { setWidget() {} },
      sessionManager: identity,
      mode: "tui",
    });
    for (const handler of hooks.get("session_start") ?? []) {
      await handler({ cwd: dir }, sessionContext(sessionManager));
    }

    tui.addChild(new Text("Native paste regression transcript", 0, 0));
    tui.start();
    const screen = (): string[] => tui.getScreenLines().map(stripAnsi);
    const waitForScreen = async (needle: string): Promise<void> => {
      await until(() => screen().some((line) => line.includes(needle)), 3000);
    };
    await waitForScreen("Native paste regression transcript");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => `${SURFACE_BG}${text}\x1b[49m`,
    };
    const overlays: OverlayHandle[] = [];
    /** Plain rows inside the current popup rectangle from one actual frame. */
    const popupRows = (): string[] => {
      const bounds = overlays.at(-1)?.getBounds();
      assert.ok(bounds, "the open popup reports its rendered rectangle");
      const lines = screen();
      assert.ok(bounds.row >= 0 && bounds.height >= 2 && bounds.row + bounds.height <= lines.length,
        "the popup rectangle lies inside the current rendered terminal frame");
      return lines.slice(bounds.row + 1, bounds.row + bounds.height - 1)
        .map((line) => line.slice(1).trimEnd());
    };
    const waitForPopupText = async (needle: string): Promise<string[]> => {
      let rows: string[] = [];
      await until(() => {
        rows = popupRows();
        return renderedRowsContainWrapped(rows, needle);
      }, 3000);
      return rows;
    };
    const open = async (identity: object): Promise<{ closed: Promise<unknown> }> => {
      const bridge = createBridgeUi({
        keybindings,
        theme: REAL_IDENTITY_THEME,
        draft: "independent chat draft",
        customTheme: theme,
        onChange: (editor) => {
          if (!instances.includes(editor)) instances.push(editor);
          const callback = function (this: unknown, ...args: [string]): void {
            hostChanges.push({ editor, receiver: this, text: args[0]!, args: [...args] });
          };
          hostChangeCallbacks.push({ editor, callback });
          return callback;
        },
        onPasteImage: (editor) => () => {
          const number = pendingPastes.length + 1;
          const path = join(dir, `pi-clipboard-488-${number}.png`);
          let resolveClipboard!: (value: { path: string; bytes: Buffer }) => void;
          const clipboardRead = new Promise<{ path: string; bytes: Buffer }>((resolve) => {
            resolveClipboard = resolve;
          });
          pendingPastes.push({
            path,
            release: () => resolveClipboard({ path, bytes: pngBytes }),
          });
          void clipboardRead.then(async (image) => {
            await writeFile(image.path, image.bytes);
            editor.insertTextAtCursor(image.path);
            // Pi 1.4's native async paste path requests its ordinary coalesced
            // render immediately after inserting the selected path.
            tui.requestRender();
          }).catch((error: unknown) => pasteErrors.push(error));
        },
        drivers: [],
      });
      const before = overlays.length;
      const custom = (factory: (...args: unknown[]) => unknown, options?: {
        overlay?: boolean;
        overlayOptions?: OverlayOptions;
        onHandle?: (handle: OverlayHandle) => void;
      }) => new Promise((resolve) => {
        let handle: OverlayHandle | undefined;
        let closed = false;
        const done = (result: unknown) => {
          if (closed) return;
          closed = true;
          handle?.hide();
          resolve(result);
        };
        Promise.resolve(factory(tui, theme, keybindings, done)).then((component) => {
          if (closed) return;
          assert.equal(options?.overlay, true);
          handle = tui.showOverlay(component as never, options?.overlayOptions);
          overlays.push(handle);
          options?.onHandle?.(handle);
        });
      });
      const opening = shortcuts.get("ctrl+alt+up")!.handler({
        ui: { ...bridge.ui, custom },
        sessionManager: identity,
        isIdle: () => true,
      }) as Promise<unknown>;
      await until(() => overlays.length > before);
      return { closed: opening };
    };
    const ask = async (id: string, identity: object): Promise<void> => {
      await tools.get("AskUserQuestion")!.execute(
        id,
        { question: `Paste answer ${id}?`, choices: ["Use the text"] },
        undefined,
        undefined,
        { sessionManager: identity },
      );
    };

    await ask("q1", sessionManager);
    const firstPopup = await open(sessionManager);
    await waitForScreen("q1: Paste answer q1?");
    terminal.send(ENTER);
    await waitForScreen("Type something…");
    terminal.send(DOWN);
    terminal.send(ENTER);
    await waitForScreen(EDITING_HINT);

    const field = instances.at(-1)! as FakeBridgeEditor & {
      getCursor?(): { line: number; col: number };
    };
    assert.equal(field.getText(), "", "the native answer field starts empty");
    const paste = async (index: number): Promise<string> => {
      terminal.send("\x16"); // Ctrl+V through the actual installed CustomEditor.
      await until(() => pendingPastes.length === index, 2000);
      // Let the paste key's first native render settle before releasing the
      // clipboard promise. This wait does not render or invalidate the popup.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const pending = pendingPastes[index - 1]!;
      const name = pending.path.slice(pending.path.lastIndexOf("/") + 1);
      assert.ok(!renderedRowsContainWrapped(popupRows(), name), "the async path is not inserted before clipboard completion");
      const requestsBeforeCompletion = requestRenderCount;
      pending.release();
      const pastedRows = await waitForPopupText(pending.path);
      assert.ok(renderedRowsContainWrapped(pastedRows, name),
        "the full basename is visible in the same post-paste popup frame, including across native wrapping");
      assert.ok(requestRenderCount > requestsBeforeCompletion, "the rendered path arrived through ordinary coalesced render requests");
      assert.deepEqual(await readFile(pending.path), pngBytes, "only the synthetic PNG fixture was supplied");
      assert.deepEqual(pasteErrors, []);
      return pending.path;
    };

    const firstPath = await paste(1);
    assert.equal(field.getText(), firstPath, "the first paste remains the native field's only draft");
    const firstCursor = field.getCursor?.();
    assert.ok(firstCursor);
    assert.deepEqual(firstCursor, { line: 0, col: firstPath.length });
    assert.deepEqual(field.getCursor?.(), firstCursor, "the normal popup redraw preserves the native cursor");
    const firstHostChange = hostChanges.filter((change) => change.text === firstPath);
    assert.equal(firstHostChange.length, 1, "the host onChange callback is chained once for the native insertion");
    assert.equal(firstHostChange[0]!.editor, field);
    assert.equal(firstHostChange[0]!.receiver, field, "the host callback receiver is preserved");
    assert.deepEqual(firstHostChange[0]!.args, [firstPath], "the host callback arguments are preserved");

    // Keep existing text and a multiline draft, then perform independent
    // native pastes at the current cursor. No paste is replayed or duplicated.
    terminal.send(SHIFT_ENTER);
    for (const character of "retained text") terminal.send(character);
    await waitForScreen("retained text");
    const secondPath = await paste(2);
    terminal.send(SHIFT_ENTER);
    const thirdPath = await paste(3);
    const expectedAnswer = `${firstPath}\nretained text${secondPath}\n${thirdPath}`;
    assert.equal(field.getText(), expectedAnswer, "multiline content and repeated native paths stay exact");
    const finalCursor = field.getCursor?.();
    assert.ok(finalCursor);
    assert.deepEqual(finalCursor, { line: 2, col: thirdPath.length });
    assert.deepEqual(field.getCursor?.(), finalCursor, "rendering does not replace or move the native cursor");
    assert.equal(hostChanges.filter((change) => change.text === expectedAnswer).length, 1);

    terminal.send(ENTER);
    await until(() => sent.length === 1);
    assert.deepEqual(sent, [`Answer to pending question \"Paste answer q1?\": ${expectedAnswer}`],
      "submission contains each native path and typed line exactly once, with the existing question context");
    assert.deepEqual((await readFile(firstPath)), pngBytes);
    assert.deepEqual((await readFile(secondPath)), pngBytes);
    assert.deepEqual((await readFile(thirdPath)), pngBytes);

    const ownedObserver = field.onChange!;
    const originalHostCallback = hostChangeCallbacks.find((entry) => entry.editor === field)!.callback;
    terminal.send(CTRL_ALT_UP);
    await firstPopup.closed;
    assert.equal(field.onChange, originalHostCallback, "closing restores only the callback this popup owned");
    assert.equal(instances.at(-1)!.getText(), "independent chat draft", "the separate chat draft is restored unchanged");
    const afterCloseRequests = requestRenderCount;
    (ownedObserver as unknown as (this: FakeBridgeEditor, ...args: unknown[]) => void).call(
      field,
      "late notification after close",
      { source: "synthetic-late-callback" },
    );
    assert.equal(requestRenderCount, afterCloseRequests, "a retained callback cannot request a render after close");
    assert.deepEqual(hostChanges.at(-1)?.args, ["late notification after close", { source: "synthetic-late-callback" }],
      "the original host callback receives every argument after close too");

    // A session replacement makes an open popup stale before a former field
    // can notify it. The callback still reaches the host handler, but cannot
    // invalidate or resurrect the old popup.
    await ask("q2", sessionManager);
    const stalePopup = await open(sessionManager);
    await waitForScreen("q2: Paste answer q2?");
    const staleField = instances.at(-1)!;
    const staleObserver = staleField.onChange!;
    const staleHostCallback = hostChangeCallbacks.find((entry) => entry.editor === staleField)!.callback;
    const replacedSession = { id: "replaced-again" };
    for (const handler of hooks.get("session_start") ?? []) {
      await handler({ cwd: dir }, sessionContext(replacedSession));
    }
    const afterReplacementRequests = requestRenderCount;
    staleObserver.call(staleField, "late notification after replacement");
    assert.equal(requestRenderCount, afterReplacementRequests, "a stale field notification is inert for the popup");
    assert.equal(hostChanges.at(-1)?.editor, staleField);
    assert.equal(hostChanges.at(-1)?.receiver, staleField);
    assert.equal(hostChanges.at(-1)?.text, "late notification after replacement");
    if (tui.hasOverlay()) terminal.send(ESCAPE);
    await stalePopup.closed;
    assert.equal(staleField.onChange, staleHostCallback);
    assert.equal(tui.hasOverlay(), false, "the replaced session's popup is closed");
  } finally {
    tui.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
