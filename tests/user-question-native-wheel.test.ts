/**
 * Native fullscreen integration for the shared question/notice popup (#413).
 *
 * Drives the production extension registration (activate → the registered
 * Ctrl+Alt+Up shortcut handler → the shared custom overlay factory) over a
 * REAL pinned pi-tui `TuiAltScreen` (`pi-session-host-tui`, the exact pi-tui
 * 1.3.0 release this package depends on). The test's `ctx.ui.custom` mirrors
 * Pi 1.3.0's public `showExtensionCustom`: it invokes the factory with the
 * live TUI, shows the returned component through the public
 * `tui.showOverlay(component, overlayOptions)`, and hides that overlay when
 * the factory's completion callback runs. Every keyboard and SGR mouse-wheel
 * byte sequence enters through the terminal's input callback, so the native
 * renderer's own raw input listener, overlay hit testing, and normalized
 * `handleMouse` dispatch decide where each event goes.
 *
 * Pins: wheel over the body and over the full-height outer rows scrolls the
 * popup (both directions, bounded, Alt-accelerated) and never the transcript;
 * keyboard paging shares the same viewport; long content opens at its
 * beginning; the keyboard hint stays in its fixed area; the free-text field
 * keeps its draft while the wheel scrolls; closing returns wheel input to the
 * transcript; reopening routes it to the popup again.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { getKeybindings, matchesKey, Text, TuiAltScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "pi-session-host-tui";
import type { OverlayHandle, OverlayOptions, Terminal } from "pi-session-host-tui";
import { activate } from "../src/index";
import { setHostKeybindingLoader } from "../src/host-keybindings";
import { __resetActiveNativeEditorFieldForTest, setNativeEditorHost } from "../src/native-editor-bridge";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";
import { createBridgeUi, fakeHost, type FakeBridgeEditor } from "./bridge-fakes";

const COLUMNS = 80;
const ROWS = 24;
const CTRL_ALT_UP = "\x1b[1;7A";
const SHIFT_ALT_DOWN = "\x1b[1;4B";
const SHIFT_ALT_UP = "\x1b[1;4A";
const ENTER = "\r";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";
const SURFACE_BG = "\x1b[48;5;236m";
const NOTICE_HINT = "arrows select · Enter choose · Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll · Esc back";

/** SGR wheel report (1-based terminal coordinates); bit 3 adds Alt. */
function wheel(direction: "up" | "down", x: number, y: number, alt = false): string {
  const button = (direction === "up" ? 64 : 65) | (alt ? 8 : 0);
  return `\x1b[<${button};${x + 1};${y + 1}M`;
}

const stripAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\x1b_[^\x07]*\x07/gu, "").replace(/\x1b\][^\x07]*\x07/gu, "");

class VirtualTerminal implements Terminal {
  private onInput?: (data: string) => void;
  constructor(private cols: number, private height: number) {}
  start(onInput: (data: string) => void, _onResize: () => void): void { this.onInput = onInput; }
  stop(): void { this.onInput = undefined; }
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

test("native fullscreen: wheel and keyboard scroll the shared popup, never the transcript, across close and reopen", async () => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  // Hermetic top-level surface, as in the entrypoint tests.
  delete process.env.PI_REVIEW_GATE_DISABLED;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-native-wheel-"));
  const terminal = new VirtualTerminal(COLUMNS, ROWS);
  const tui = new TuiAltScreen(terminal);
  try {
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
    const sessionManager = { id: "native-wheel-session" };
    const sessionContext = {
      cwd: dir,
      ui: { setWidget() {} },
      sessionManager,
      mode: "tui",
    };
    for (const handler of hooks.get("session_start") ?? []) await handler({ cwd: dir }, sessionContext);

    // The transcript underneath is long enough to scroll in both directions.
    tui.addChild(new Text(Array.from({ length: 200 }, (_, index) => `Transcript line ${index + 1}`).join("\n"), 0, 0));
    tui.start();
    tui.renderNow(true);
    terminal.send(wheel("up", 10, 10));
    terminal.send(wheel("up", 10, 10));
    tui.renderNow(true);
    const transcriptTop = tui.viewportTop;
    assert.ok(transcriptTop > 0, "the transcript is scrolled away from its first line before the popup opens");

    const body = Array.from({ length: 40 }, (_, index) => `Notice body row ${String(index + 1).padStart(2, "0")}`).join("\n");
    await tools.get("YouShouldKnow")!.execute("n1", {
      title: "Wheel notice",
      body,
      context: "Context first row\nCONTEXT-END",
    }, undefined, undefined, { sessionManager });
    await tools.get("AskUserQuestion")!.execute("q1", {
      question: Array.from({ length: 30 }, (_, index) => `Question detail ${index + 1}.`).join("\n\n"),
      choices: ["Keep the lane"],
    }, undefined, undefined, { sessionManager });

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => `${SURFACE_BG}${text}\x1b[49m`,
    };
    const overlays: Array<{ handle: OverlayHandle; options: OverlayOptions | undefined }> = [];
    let openCount = 0;
    // Resolves once the overlay is shown; `closed` settles when it closes.
    const open = async (): Promise<{ closed: Promise<unknown> }> => {
      const bridge = createBridgeUi({ keybindings: getKeybindings(), draft: "chat draft", drivers: [] });
      // Mirror Pi 1.3.0 InteractiveMode.showExtensionCustom for overlays.
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
    const plainScreen = (): string[] => screen().map(stripAnsi);

    const { closed: opening } = await open();
    assert.deepEqual(overlays[0]!.options?.margin, { top: 0, right: 0, bottom: 0, left: 0 },
      "the overlay has no margins, so its hit rectangle spans the conversation viewport");
    let rows = screen();
    assert.equal(rows.length, ROWS);
    for (const [index, row] of rows.entries()) {
      assert.ok(row.includes(SURFACE_BG), `fullscreen popup row ${index} is opaque surface (no exposed transcript edge)`);
      assert.ok(!stripAnsi(row).includes("Transcript line"), `fullscreen popup row ${index} hides the transcript`);
    }
    const bounds = overlays[0]!.handle.getBounds();
    assert.deepEqual(bounds, { row: 0, col: 0, width: COLUMNS, height: ROWS },
      "the rendered overlay rectangle covers every terminal row for native mouse hit testing");

    // Open the long notice (listed first, in creation order).
    terminal.send(ENTER);
    let plain = plainScreen();
    const ruleRow = plain.findIndex((line) => /^─+$/u.test(line));
    assert.equal(ruleRow, 1, "the frame keeps its one-row inset: the old top margin row is now opaque fill");
    assert.ok(/^─+$/u.test(plain[ROWS - 2]!), "the bottom rule keeps its old row above the opaque fill row");
    assert.ok(plain.some((line) => line.includes("n1: Wheel notice")), "the long notice opens at its beginning");
    assert.ok(!plain.some((line) => line.includes("More details")), "actions scroll with the body; they are not fixed");
    const hintText = (lines: readonly string[]): string => lines.slice(ruleRow + 1, ROWS - 2).join(" ").replace(/\s+/gu, " ");
    assert.ok(hintText(plain).includes(NOTICE_HINT), "the fixed keyboard hint is visible at the beginning");

    const bodyRow = (lines: readonly string[]): number => lines.findIndex((line) => /Notice body row \d\d/u.test(line));
    const firstBody = (lines: readonly string[]): string => lines.find((line) => /Notice body row \d\d/u.test(line))!.trim();
    assert.equal(firstBody(plain), "Notice body row 01");

    // Wheel down over a body row, then over the outer opaque fill rows.
    terminal.send(wheel("down", 20, bodyRow(plain)));
    terminal.send(wheel("down", 20, 0));
    terminal.send(wheel("down", 20, ROWS - 1));
    plain = plainScreen();
    assert.equal(tui.viewportTop, transcriptTop, "wheel input over the popup leaves the transcript where it was");
    assert.ok(hintText(plain).includes(NOTICE_HINT), "the hint stays fixed while the body scrolls");
    const scrolledFirst = plain.slice(ruleRow + 2).find((line) => line.trim().length > 0)!.trim();
    assert.notEqual(scrolledFirst, "n1: Wheel notice", "three wheel lines moved the popup body");

    // Alt-accelerated wheel and keyboard paging reach the end, which is bounded.
    for (let index = 0; index < 30; index += 1) terminal.send(wheel("down", 5, 5, true));
    plain = plainScreen();
    assert.ok(plain.some((line) => line.includes("CONTEXT-END")) && plain.some((line) => line.includes("Close")),
      "wheel scrolling reaches the complete context and both actions");
    const atEnd = plain.join("\n");
    terminal.send(wheel("down", 5, 5));
    terminal.send(wheel("down", 5, ROWS - 1, true));
    terminal.send(SHIFT_ALT_DOWN);
    assert.equal(plainScreen().join("\n"), atEnd, "wheel and keyboard input at the end bound is contained by the popup");
    assert.equal(tui.viewportTop, transcriptTop, "the bounded popup never chains its overscroll into the transcript");

    // Back to the middle and the beginning, by keyboard and wheel.
    terminal.send(SHIFT_ALT_UP);
    plain = plainScreen();
    assert.ok(!plain.some((line) => line.includes("n1: Wheel notice")) && plain.some((line) => /Notice body row/u.test(line)),
      "keyboard paging back lands in the middle of the body");
    for (let index = 0; index < 20; index += 1) terminal.send(wheel("up", 5, 0, true));
    plain = plainScreen();
    assert.ok(plain.some((line) => line.includes("n1: Wheel notice")), "wheel scrolling returns to the beginning");
    terminal.send(wheel("up", 5, 0));
    assert.ok(plainScreen().some((line) => line.includes("n1: Wheel notice")), "the beginning bound is contained");
    assert.equal(tui.viewportTop, transcriptTop);
    // Up/Down still select actions and reveal them.
    terminal.send(DOWN);
    plain = plainScreen();
    assert.ok(plain.some((line) => line.includes("> Close")), "Down selects and reveals the Close action");

    // Back to the list, open the question, and edit its free-text answer.
    terminal.send(ESCAPE);
    terminal.send(DOWN);
    terminal.send(ENTER);
    plain = plainScreen();
    assert.ok(plain.some((line) => line.trim() === "q1:"), "the long question opens at its beginning");
    assert.ok(!plain.some((line) => line.includes("> 1. Keep the lane")), "opening does not jump to the first choice");
    terminal.send(DOWN); // Type something… (reveals it)
    terminal.send(ENTER); // edit
    for (const character of "draft") terminal.send(character);
    plain = plainScreen();
    assert.ok(plain.some((line) => line.includes("[field:draft]")), "the active native field is visible while editing");
    assert.ok(hintText(plain).includes("Esc back to options for scroll keys · mouse wheel scrolls"),
      "the fullscreen editing hint names the Esc exception and the working wheel");
    for (let index = 0; index < 20; index += 1) terminal.send(wheel("up", 5, 8, true));
    plain = plainScreen();
    assert.ok(plain.some((line) => line.trim() === "q1:"), "the wheel scrolls the question while the field is editing");
    assert.ok(!plain.some((line) => line.includes("[field:draft]")), "render does not snap the viewport back to the editor");
    assert.equal(instances.at(-1)!.getText(), "draft", "wheel scrolling neither mutates nor submits the draft");
    assert.equal(sent.length, 0);
    terminal.send("!");
    plain = plainScreen();
    assert.ok(plain.some((line) => line.includes("[field:draft!]")), "the next editing input brings the cursor row back into view");

    // Closing hands wheel input back to the transcript.
    terminal.send(CTRL_ALT_UP);
    await opening;
    tui.renderNow(true);
    terminal.send(wheel("up", 10, 10));
    tui.renderNow(true);
    assert.equal(tui.viewportTop, transcriptTop - 1, "after close, wheel input scrolls the transcript normally");
    assert.ok(plainScreen().some((line) => line.includes("Transcript line")), "the closed popup leaves no opaque surface");

    // Reopening routes the wheel to the new popup instance again.
    const { closed: reopened } = await open();
    const reopenedTop = tui.viewportTop;
    terminal.send(ENTER);
    terminal.send(wheel("down", 10, 0));
    terminal.send(wheel("down", 10, 10));
    tui.renderNow(true);
    assert.equal(tui.viewportTop, reopenedTop, "a reopened popup owns wheel input over its whole surface again");
    terminal.send(CTRL_ALT_UP);
    await reopened;
    assert.equal(openCount, 2);
    assert.equal(sent.length, 0, "no wheel or scroll input sent anything to the model");
  } finally {
    tui.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
