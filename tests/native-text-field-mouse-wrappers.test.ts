/**
 * In-Pi text-field wrappers route Pi's own mouse events to the native
 * component (#714): the native editor bridge field (settings, subtask,
 * steering, and reviewer text), the AskUserQuestion popup's free-text editor,
 * and the settings deny-picker query Input.
 *
 * The host editor class here is the REAL pinned pi-tui `Editor` (and the real
 * pinned `Input`), so caret mapping is the native component's own. Each test
 * proves the caret by the text the following keystrokes produce, and proves
 * that presses, drags, and releases the native Editor leaves unhandled stay
 * unhandled (Pi's native selection keeps them).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  Editor,
  Input as PinnedInput,
  SelectList as PinnedSelectList,
  Text as PinnedText,
  Container as PinnedContainer,
  visibleWidth,
  wrapTextWithAnsi,
} from "pi-session-host-tui";
import {
  acquireNativeEditorField,
  editTextWithNativeEditor,
  setNativeEditorHost,
  __resetActiveNativeEditorFieldForTest,
  type NativeEditorFieldHandle,
  type NativeEditorHost,
} from "../src/native-editor-bridge";
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import { UserQuestionController } from "../src/user-question/controller";
import { retainedDenySelect, type DenyPickerRow } from "../src/settings/deny-picker";
import { setMenuTuiHost, type MenuTuiHost } from "../src/settings/menu";
import type { TextFieldMouseEvent, TextFieldMouseResult } from "../src/text-field-mouse";
import { createBridgeUi, fakeKeybindingsManager, REAL_IDENTITY_THEME, settle } from "./bridge-fakes";
import { IDENTITY_THEME } from "./menu-tui-fakes";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";
const PASTE_START = "\x1b[200~";

test.afterEach(() => {
  setNativeEditorHost(undefined);
  __resetActiveNativeEditorFieldForTest();
});

/** The pinned public Editor standing in for the host's CustomEditor (same public seams). */
class PinnedCustomEditor extends Editor {
  constructor(tui: unknown, theme: unknown) {
    super(tui as never, theme as never);
  }
}

function pinnedEditorHost(): NativeEditorHost {
  return { CustomEditor: PinnedCustomEditor as unknown as NativeEditorHost["CustomEditor"] };
}

interface MouseComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse?(event: TextFieldMouseEvent): TextFieldMouseResult | undefined;
}

function strip(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

function mouse(type: TextFieldMouseEvent["type"], x: number, y: number, width: number, height: number): TextFieldMouseEvent {
  return { type, button: "left", x, y, screenX: x, screenY: y + 10, width, height, shift: false, alt: false, ctrl: false };
}

function locate(lines: readonly string[], text: string): { row: number; column: number } {
  const row = lines.findIndex((line) => strip(line).includes(text));
  assert.ok(row >= 0, `no rendered row contains ${JSON.stringify(text)}:\n${lines.map(strip).join("\n")}`);
  return { row, column: strip(lines[row] ?? "").indexOf(text) };
}

// ---------------------------------------------------------------------------
// Native editor bridge field (settings / subtasks / steering / reviewer text)
// ---------------------------------------------------------------------------

test("bridge field: a native click after /srv/ then X yields /srv/Xexample; selection gestures stay Pi's", async () => {
  setNativeEditorHost(pinnedEditorHost());
  const observations: string[] = [];
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    theme: REAL_IDENTITY_THEME,
    customTheme: IDENTITY_THEME,
    drivers: [(raw) => {
      const component = raw as unknown as MouseComponent;
      assert.equal(typeof component.handleMouse, "function", "the bridge field exposes the optional mouse seam");
      const width = 60;
      const lines = component.render(width);
      const { row, column } = locate(lines, "/srv/example");
      const height = lines.length;
      // Pi delivers press -> release -> synthesized click for a stationary gesture.
      assert.equal(component.handleMouse!(mouse("press", column + 5, row, width, height)), undefined,
        "the press stays with Pi's native selection");
      assert.equal(component.handleMouse!(mouse("drag", column + 6, row, width, height)), undefined,
        "a drag stays with Pi's native selection");
      assert.equal(component.handleMouse!(mouse("release", column + 5, row, width, height)), undefined);
      assert.equal(component.handleMouse!(mouse("click", column + 5, row, width + 1, height)), undefined,
        "a width the last render did not use");
      assert.equal(component.handleMouse!(mouse("click", 1, 0, width, height)), undefined, "the title row");
      const result = component.handleMouse!(mouse("click", column + 5, row, width, height));
      assert.equal(result?.handled, true, "the native Editor positioned the caret");
      component.handleInput("X");
      observations.push(strip(component.render(width)[row] ?? "").trim());
      component.handleInput(ENTER);
      assert.equal(component.handleMouse!(mouse("click", column, row, width, height)), undefined,
        "a settled field forwards nothing");
    }],
  });
  const result = await editTextWithNativeEditor(ui, { title: "Workspace", prefill: "/srv/example" });
  assert.deepEqual(result, { kind: "value", value: "/srv/Xexample" });
  assert.deepEqual(observations, ["/srv/Xexample"]);
});

test("bridge field: wrapped wide text maps through the native Editor's visual lines", async () => {
  setNativeEditorHost(pinnedEditorHost());
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    theme: REAL_IDENTITY_THEME,
    customTheme: IDENTITY_THEME,
    drivers: [(raw) => {
      const component = raw as unknown as MouseComponent;
      const width = 12;
      const lines = component.render(width);
      // "界界界界界界界" is 14 cells: the native layout wraps it at 11 columns.
      const second = lines.findIndex((line, index) => index > 1 && strip(line).trim().startsWith("界") && strip(line).trim().length <= 2);
      assert.ok(second > 0, `a wrapped continuation row is drawn:\n${lines.map(strip).join("\n")}`);
      assert.equal(component.handleMouse!(mouse("click", 0, second, width, lines.length))?.handled, true);
      component.handleInput("X");
      component.handleInput(ENTER);
    }],
  });
  const result = await editTextWithNativeEditor(ui, { title: "Name", prefill: "界界界界界界界" });
  assert.deepEqual(result, { kind: "value", value: "界界界界界X界界" });
});

// ---------------------------------------------------------------------------
// AskUserQuestion popup free-text editor
// ---------------------------------------------------------------------------

async function popupFixture(
  driver: (component: MouseComponent, sent: string[]) => void,
  options: { getViewportRows?: () => number; question?: string } = {},
): Promise<string[]> {
  setNativeEditorHost(pinnedEditorHost());
  const sent: string[] = [];
  const controller = new UserQuestionController({
    pi: { sendUserMessage(message: string) { sent.push(message); return Promise.resolve(); } },
    uiAvailable: () => true,
  });
  const identity = { sessionManager: "mouse" };
  controller.beginSession(identity);
  const registered = controller.register(
    { toolCallId: "t1", question: options.question ?? "Which path?", choices: ["none"], mode: "async" },
    identity,
  );
  assert.ok(registered.ok);
  let component: MouseComponent | undefined;
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    theme: REAL_IDENTITY_THEME,
    customTheme: IDENTITY_THEME,
    drivers: [(raw) => { component = raw as unknown as MouseComponent; driver(component, sent); }],
  });
  const acquired = await acquireNativeEditorField(ui, { semantics: { onSubmitKey: (text) => (text.length > 0 ? text : null) } });
  assert.equal(acquired.kind, "acquired");
  const handle = (acquired as { kind: "acquired"; handle: NativeEditorFieldHandle }).handle;
  const keys = {
    matches(data: string, binding: string): boolean {
      const table: Record<string, string[]> = {
        "tui.select.up": ["\x1b[A"], "tui.select.down": [DOWN], "tui.select.confirm": [ENTER],
        "tui.select.cancel": [ESCAPE],
      };
      return (table[binding] ?? []).includes(data);
    },
  };
  const opened = ui.custom!((tui, theme, live, close) => {
    handle.prepare("");
    handle.isolatePromptForOverlay(tui, theme, live);
    return createQuestionListComponent({
      controller,
      keybindings: keys,
      theme: { fg: (_c: string, text: string) => text, bold: (text: string) => text },
      shortcutLabel: "Ctrl+Alt+Up",
      // Production passes Pi's own width helpers; without them the popup's
      // naive fallback mis-measures the fake-cursor row and (fail-closed)
      // treats it as re-wrapped, so it carries no editor row.
      tuiHost: {
        matchesKey: (_data: string, keyId: string) => keyId === QUESTION_LIST_SHORTCUT_KEY && false,
        visibleWidth,
        wrapTextWithAnsi,
      },
      nativeField: handle.instance,
      ...(options.getViewportRows ? { getViewportRows: options.getViewportRows } : {}),
      onDone: () => close(undefined),
    }) as never;
  });
  await Promise.race([opened, settle(500)]);
  handle.finish();
  return sent;
}

function startEditing(component: MouseComponent): void {
  component.handleInput(ENTER); // answer view
  component.handleInput(DOWN); // the free-text row
  component.handleInput(ENTER); // begin editing
  for (const character of "/srv/example") component.handleInput(character);
}

test("question popup: Pi's press/release/click over the editor box places the native caret", async () => {
  const sent = await popupFixture((component) => {
    startEditing(component);
    const width = 70;
    const lines = component.render(width);
    const { row, column } = locate(lines, "/srv/example");
    const height = lines.length;
    assert.equal(component.handleMouse!(mouse("press", column + 5, row, width, height)), undefined,
      "the press over editor text stays Pi's native selection");
    assert.equal(component.handleMouse!(mouse("release", column + 5, row, width, height)), undefined);
    const clicked = component.handleMouse!(mouse("click", column + 5, row, width, height));
    assert.deepEqual(clicked, { handled: true, render: true });
    component.handleInput("X");
    assert.ok(strip(component.render(width)[row] ?? "").includes("/srv/Xexample"));
    component.handleInput(ENTER);
    assert.equal(component.handleMouse!(mouse("click", column, row, width, height)), undefined,
      "a closed popup forwards nothing");
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /\/srv\/Xexample/u);
});

test("question popup: a scrolled, clipped viewport maps written rows to the editor's own rows", async () => {
  const question = Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of context.`).join("\n\n");
  const sent = await popupFixture((component) => {
    startEditing(component);
    const width = 50;
    const lines = component.render(width);
    assert.ok(lines.length <= 9, "the popup is bounded by the viewport");
    const { row, column } = locate(lines, "/srv/example");
    assert.equal(component.handleMouse!(mouse("click", column + 5, row, width, lines.length))?.handled, true);
    component.handleInput("X");
    // Rows the editor did not draw (question text, hint, rules) are not editor rows.
    assert.equal(component.handleMouse!(mouse("click", 2, 0, width, lines.length)), undefined);
    component.handleInput(ENTER);
  }, { getViewportRows: () => 9, question });
  assert.match(sent[0] ?? "", /\/srv\/Xexample/u);
});

// ---------------------------------------------------------------------------
// Settings deny-picker query Input
// ---------------------------------------------------------------------------

test("deny picker: a press on the native query row places the Input caret; paste in flight refuses", async () => {
  const host: MenuTuiHost = {
    SelectList: PinnedSelectList as unknown as MenuTuiHost["SelectList"],
    Container: PinnedContainer as unknown as MenuTuiHost["Container"],
    Text: PinnedText as unknown as MenuTuiHost["Text"],
    Input: PinnedInput as unknown as MenuTuiHost["Input"],
  };
  const rows: DenyPickerRow[] = [
    { key: "tool:read", label: "read  ✗ allowed", searchText: "read" },
    { key: "back", label: "Back", searchText: "back", alwaysVisible: true },
  ];
  const ui = {
    mode: "tui",
    custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown) {
      return new Promise<string | undefined>((resolve) => {
        const component = factory({ requestRender() {} }, IDENTITY_THEME, null, resolve) as MouseComponent & { focused?: boolean };
        component.focused = true;
        const width = 60;
        let lines = component.render(width);
        const { row } = locate(lines, "> /srv/example");
        // Input's native press convention: prompt "> " then the value cells.
        component.handleInput(`${PASTE_START}q`);
        lines = component.render(width);
        assert.equal(component.handleMouse!(mouse("press", 2 + 5, row, width, lines.length)), undefined,
          "no caret move while a paste is assembled");
        component.handleInput("\x1b[201~");
        lines = component.render(width);
        assert.equal(component.handleMouse!(mouse("press", 2 + 5, row + 1, width, lines.length)), undefined,
          "the row below the query is not the Input");
        assert.equal(component.handleMouse!(mouse("press", 2 + 5, row, width, lines.length))?.handled, true);
        component.handleInput("X");
        component.handleInput(ESCAPE);
      });
    },
    async select(): Promise<string | undefined> { return undefined; },
    notify() {},
  };
  setMenuTuiHost(host);
  try {
    const picked = await retainedDenySelect(ui as never, { title: "Tools", rows, query: "/srv/example" });
    assert.equal(picked.query, "/srv/Xexampleq");
  } finally {
    setMenuTuiHost(undefined);
  }
});
