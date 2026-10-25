/**
 * Native fullscreen integration for the shared question/notice popup (#413).
 *
 * Drives the production extension registration (activate → the registered
 * Ctrl+Alt+Up shortcut handler → the shared custom overlay factory) over a
 * REAL pinned pi-tui `TuiAltScreen` (`pi-session-host-tui`, the exact pi-tui
 * 1.4.0 release this package depends on). The test's `ctx.ui.custom` mirrors
 * Pi 1.4.0's public `showExtensionCustom`: it invokes the factory with the
 * live TUI, shows the returned component through the public
 * `tui.showOverlay(component, overlayOptions)`, and hides that overlay when
 * the factory's completion callback runs. Every keyboard byte sequence (and
 * the one SGR wheel report) enters through the terminal's input callback, so
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
 * clamps and keeps content reachable, the popup handles no wheel input, and
 * ordinary answer delivery, close, and reopen are unchanged.
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
const CTRL_ALT_UP = "\x1b[1;7A";
const SHIFT_ALT_DOWN = "\x1b[1;4B";
const SHIFT_ALT_UP = "\x1b[1;4A";
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

const stripAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\x1b_[^\x07]*\x07/gu, "").replace(/\x1b\][^\x07]*\x07/gu, "");

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

test("native fullscreen: the compact popup keeps its natural size over the live transcript and scrolls by keyboard only", async () => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  // Hermetic top-level surface, as in the entrypoint tests.
  delete process.env.PI_REVIEW_GATE_DISABLED;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-native-popup-"));
  const terminal = new VirtualTerminal(COLUMNS, ROWS);
  const tui = new TuiAltScreen(terminal);
  try {
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

    // A long native transcript underneath; it is updated while the popup is open.
    const transcript = new Text(Array.from({ length: 200 }, (_, index) => `Transcript line ${index + 1}`).join("\n"), 0, 0);
    tui.addChild(transcript);
    tui.start();
    tui.renderNow(true);

    const askQuestion = async (id: string, question: string, choices: string[]): Promise<void> => {
      await tools.get("AskUserQuestion")!.execute(id, { question, choices }, undefined, undefined, { sessionManager });
    };
    await askQuestion("q1", "Short question?", ["Keep the lane"]);

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => `${SURFACE_BG}${text}\x1b[49m`,
    };
    const overlays: Array<{ handle: OverlayHandle; options: OverlayOptions | undefined }> = [];
    let openCount = 0;
    const open = async (): Promise<{ closed: Promise<unknown> }> => {
      const bridge = createBridgeUi({ keybindings: getKeybindings(), draft: "chat draft", drivers: [] });
      // Mirror Pi 1.4.0 InteractiveMode.showExtensionCustom for overlays.
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
      openCount += 1;
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
     * Locate the popup through the native overlay bounds and check the compact
     * appearance: the frame (rules, padding, theme surface) only within its
     * centered, margin-bounded rectangle; outside it, the native transcript
     * rows without any popup surface.
     */
    const view = (hint: string, rows = ROWS): PopupView => {
      const lines = screen();
      assert.equal(lines.length, rows);
      const bounds = current().getBounds();
      assert.ok(bounds, "the native overlay reports its rendered rectangle");
      assert.equal(bounds.col, 0);
      assert.equal(bounds.width, COLUMNS, "the popup keeps the full conversation width");
      assert.ok(bounds.height <= rows - 2, "the popup stays within its one-row top and bottom margins");
      assert.equal(bounds.row, 1 + Math.floor((rows - 2 - bounds.height) / 2), "the popup stays centered inside its margins");
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

    // A wheel report over the popup is not handled by it: the popup body and
    // selection stay as they were (wheel behavior remains Pi's own).
    const beforeWheel = popup.interior;
    terminal.send(wheel("down", 10, popup.bounds.row + 3));
    terminal.send(wheel("up", 10, popup.bounds.row + 3));
    assert.deepEqual(view(LIST_ANSWER_HINT).interior, beforeWheel, "wheel input does not scroll or select within the popup");

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
    await tools.get("YouShouldKnow")!.execute("n1", {
      title: "Long notice",
      body: Array.from({ length: 40 }, (_, index) => `Notice body row ${String(index + 1).padStart(2, "0")}`).join("\n"),
      context: "Context first row\nCONTEXT-END",
    }, undefined, undefined, { sessionManager });
    const shortNoticeBody = "One short notice row.";
    await tools.get("YouShouldKnow")!.execute("n2", { title: "Short notice", body: shortNoticeBody }, undefined, undefined, { sessionManager });

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
    assert.equal(openCount, 4);
    assert.equal(sent.length, 1, "only the confirmed answer reached the model");
  } finally {
    tui.stop();
    await rm(dir, { recursive: true, force: true });
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
      assert.ok(!screen().some((line) => line.includes(name)), "the async path is not inserted before clipboard completion");
      const requestsBeforeCompletion = requestRenderCount;
      pending.release();
      await waitForScreen(name);
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
