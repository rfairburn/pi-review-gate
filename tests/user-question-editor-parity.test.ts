/**
 * Issue #182: AskUserQuestion free-text editor parity.
 *
 * Two layers, mirroring the issue #140 menu test split:
 *
 * 1. Component tests drive the question component with a stateful fake host
 *    editor (same callback contract as pi-tui's Editor: onSubmit receives
 *    expanded trimmed text, onChange fires after every content change). They
 *    pin the wrapper coordination that must hold regardless of which editor
 *    backend answers: draft preservation across Escape, empty-submit no-op,
 *    the 4000-character bound revert, per-question draft ownership, focus
 *    propagation, width-correct multiline rendering, and the unchanged
 *    choice/decline lifecycle.
 *
 * 2. Host-integration tests best-effort load the actually installed pi-tui
 *    (same resolution strategy as tests/menu-tui-fakes.ts) and drive the real
 *    Editor through the component with a real KeybindingsManager: multiline
 *    render/navigation, movement/edit/delete/undo/newline key chords, user
 *    keybinding overrides, unsupported escape input, and the choice/decline
 *    lifecycle. They skip where no host is resolvable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { UserQuestionController } from "../src/user-question/controller";
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import type { QuestionAnswerEditor } from "../src/user-question/pi-tui-host";
import { loadRealPiTuiModule } from "./menu-tui-fakes";

// ---------------------------------------------------------------------------
// Raw key sequences (pi-tui legacy terminal encodings)
// ---------------------------------------------------------------------------

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";
const DELETE_FWD = "\x1b[3~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ALT_LEFT = "\x1b[1;3D";
const ALT_RIGHT = "\x1b[1;3C";
const CTRL_LEFT = "\x1b[1;5D";
const SHIFT_ENTER = "\x1b[13;2~";
const CTRL_J = "\n";
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const CTRL_W = "\x17";
const CTRL_U = "\x15";
const CTRL_K = "\x0b";
const CTRL_Y = "\x19";
const CTRL_D = "\x04";
// ctrl+- as Kitty CSI-u: in legacy terminals ctrl+- is indistinguishable
// from Enter, so the binding only resolves through the Kitty protocol.
const UNDO = "\x1b[45;5u";
const F6 = "\x1b[17~";
const F8 = "\x1b[19~";
const CHORD = "\x1b[1;64A";

interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

function makeKeybindings(): KeybindingsLike {
  const bindings: Record<string, string[]> = {
    "tui.select.up": [UP],
    "tui.select.down": [DOWN],
    "tui.select.confirm": [ENTER],
    // The host default for cancel is escape + ctrl+c; both are exercised.
    "tui.select.cancel": [ESCAPE, "\x03"],
    "tui.input.submit": [ENTER],
    "tui.input.newLine": [SHIFT_ENTER, CTRL_J],
    "tui.editor.cursorUp": [UP],
    "tui.editor.cursorDown": [DOWN],
    "tui.editor.cursorLeft": [LEFT],
    "tui.editor.cursorRight": [RIGHT],
    "tui.editor.deleteCharBackward": [BACKSPACE],
  };
  return {
    matches(data: string, keybinding: string): boolean {
      return (bindings[keybinding] ?? []).includes(data);
    },
  };
}

const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

// ---------------------------------------------------------------------------
// Fake host editor: stateful stand-in with the real Editor's callback
// contract (onSubmit receives expanded trimmed text and clears; onChange
// fires after every content change).
// ---------------------------------------------------------------------------

class FakeAnswerEditor implements QuestionAnswerEditor {
  focused = false;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  /** Every raw sequence the component delegated, in order. */
  readonly inputs: string[] = [];
  private lines: string[] = [""];
  private line = 0;
  private col = 0;

  constructor(private readonly keys: KeybindingsLike) {}

  getExpandedText(): string {
    return this.lines.join("\n");
  }

  setText(text: string): void {
    this.lines = text.length === 0 ? [""] : text.split("\n");
    this.line = this.lines.length - 1;
    this.col = this.lines[this.line]!.length;
    this.onChange?.(this.getExpandedText());
  }

  handleInput(data: string): void {
    this.inputs.push(data);
    const k = this.keys;
    if (k.matches(data, "tui.input.submit")) {
      // The real Editor clears its state before calling onSubmit.
      const result = this.getExpandedText().trim();
      this.lines = [""];
      this.line = 0;
      this.col = 0;
      this.onChange?.("");
      this.onSubmit?.(result);
      return;
    }
    if (k.matches(data, "tui.input.newLine")) {
      const current = this.lines[this.line]!;
      this.lines.splice(this.line, 1, current.slice(0, this.col), current.slice(this.col));
      this.line += 1;
      this.col = 0;
      this.onChange?.(this.getExpandedText());
      return;
    }
    if (k.matches(data, "tui.editor.cursorLeft")) {
      if (this.col > 0) this.col -= 1;
      return;
    }
    if (k.matches(data, "tui.editor.cursorRight")) {
      if (this.col < this.lines[this.line]!.length) this.col += 1;
      return;
    }
    if (k.matches(data, "tui.editor.cursorUp")) {
      if (this.line > 0) {
        this.line -= 1;
        this.clampCol();
      }
      return;
    }
    if (k.matches(data, "tui.editor.cursorDown")) {
      if (this.line < this.lines.length - 1) {
        this.line += 1;
        this.clampCol();
      }
      return;
    }
    if (k.matches(data, "tui.editor.deleteCharBackward")) {
      const current = this.lines[this.line]!;
      if (this.col > 0) {
        this.lines[this.line] = current.slice(0, this.col - 1) + current.slice(this.col);
        this.col -= 1;
        this.onChange?.(this.getExpandedText());
      }
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      const current = this.lines[this.line]!;
      this.lines[this.line] = current.slice(0, this.col) + data + current.slice(this.col);
      this.col += 1;
      this.onChange?.(this.getExpandedText());
    }
  }

  /** Bordered box like the host editor: top/bottom rules plus padded lines. */
  render(width: number): string[] {
    const bounded = Math.max(1, width);
    const border = "─".repeat(bounded);
    return [
      border,
      ...this.lines.map((line) => line + " ".repeat(Math.max(0, bounded - line.length))),
      border,
    ];
  }

  invalidate(): void {}

  private clampCol(): void {
    const max = this.lines[this.line]!.length;
    if (this.col > max) this.col = max;
  }
}

// ---------------------------------------------------------------------------
// Fixture: question controller + component wired to a fake host editor
// ---------------------------------------------------------------------------

interface EditorFixture {
  controller: UserQuestionController;
  identity: object;
  sent: Array<{ message: string; options?: { deliverAs?: "steer" | "followUp" } }>;
  done: unknown[];
  component: ReturnType<typeof createQuestionListComponent>;
  keys: KeybindingsLike;
  /** The most recent answer-view session's editor (created on first edit entry). */
  editor: FakeAnswerEditor;
  /** Every editor instance the factory created, in creation order. */
  editors: FakeAnswerEditor[];
}

function makeEditorFixture(): EditorFixture {
  const sent: EditorFixture["sent"] = [];
  const controller = new UserQuestionController({
    pi: {
      sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }) {
        sent.push({ message, options });
        return Promise.resolve();
      },
    },
    uiAvailable: () => true,
  });
  const identity = { sessionManager: "UI" };
  controller.beginSession(identity);
  const done: unknown[] = [];
  const keys = makeKeybindings();
  // The factory mirrors production: every call constructs a fresh host
  // Editor (the component calls it once per answer-view session).
  const editors: FakeAnswerEditor[] = [];
  const component = createQuestionListComponent({
    controller,
    keybindings: keys,
    theme: THEME,
    shortcutLabel: "Ctrl+Alt+Up",
    tuiHost: {
      matchesKey: (data: string, keyId: string) => keyId === QUESTION_LIST_SHORTCUT_KEY && data === CHORD,
    },
    createAnswerEditor: () => {
      const editor = new FakeAnswerEditor(keys);
      editors.push(editor);
      return editor;
    },
    onDone: (result) => done.push(result),
  });
  const fixture = {
    controller,
    identity,
    sent,
    done,
    component,
    keys,
    editors,
    get editor(): FakeAnswerEditor {
      return editors[editors.length - 1]!;
    },
  };
  return fixture;
}

function register(fixture: EditorFixture, question: string, options: { choices?: string[]; mode?: "async" | "sync" } = {}) {
  const result = fixture.controller.register(
    {
      toolCallId: `t${fixture.controller.listPending().length + 1}`,
      question,
      choices: options.choices,
      mode: options.mode ?? "async",
    },
    fixture.identity,
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("registration failed");
  return result.question.id;
}

/** Open the answer view and confirm the free-text row (one choice registered). */
function enterEditing(fixture: EditorFixture): void {
  fixture.component.handleInput(ENTER); // answer view (row 0 = the choice)
  fixture.component.handleInput(DOWN); // row 1: Type something…
  fixture.component.handleInput(ENTER); // start editing
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Component tests (fake host editor): wrapper coordination
// ---------------------------------------------------------------------------

test("the host editor is embedded in the free-text row and renders a width-correct multiline box", () => {
  const fixture = makeEditorFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  enterEditing(fixture);
  for (const char of "alpha") fixture.component.handleInput(char);
  fixture.component.handleInput(SHIFT_ENTER);
  for (const char of "beta") fixture.component.handleInput(char);

  assert.equal(fixture.editor.getExpandedText(), "alpha\nbeta", "the editor owns the multiline draft");
  assert.equal(fixture.editor.focused, true, "focus is propagated to the host editor while editing");

  const lines = fixture.component.render(40);
  const text = lines.join("\n");
  assert.match(text, /Which database\?/);
  assert.ok(lines.findIndex((line) => line.includes("alpha")) < lines.findIndex((line) => line.includes("beta")));
  for (const line of lines) {
    assert.ok(line.length <= 40, `every rendered line fits the width: ${JSON.stringify(line)}`);
  }
  // The box is indented like the other rows and carries its own rules.
  const alphaLine = lines.find((line) => line.includes("alpha"))!;
  assert.ok(alphaLine.startsWith("  "), "the editor box is indented with the other rows");
});

test("Escape returns to the choices preserving the draft; re-entering resumes it", () => {
  const fixture = makeEditorFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  enterEditing(fixture);
  for (const char of "partial draft") fixture.component.handleInput(char);
  fixture.component.handleInput(ESCAPE); // back to the option rows

  assert.equal(fixture.editor.getExpandedText(), "partial draft", "the draft survives backing out");
  assert.equal(fixture.editor.focused, false, "focus leaves the editor with editing mode");
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /> Type something…/, "selection stays on the free-text row");

  fixture.component.handleInput(ENTER); // resume editing
  assert.equal(fixture.editor.focused, true);
  for (const char of " done") fixture.component.handleInput(char);
  fixture.component.handleInput(ENTER); // submit
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  void flush();
});

test("empty or whitespace-only Enter does not submit and keeps the draft (editor path)", async () => {
  const fixture = makeEditorFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  enterEditing(fixture);
  fixture.component.handleInput(ENTER); // empty: no submission, editor untouched
  assert.equal(fixture.done.length, 0);
  assert.ok(!fixture.editor.inputs.includes(ENTER), "the empty submit never reaches the editor");
  for (const char of "   ") fixture.component.handleInput(char);
  fixture.component.handleInput(ENTER); // whitespace only: still no submission
  assert.equal(fixture.done.length, 0);
  assert.equal(fixture.editor.getExpandedText(), "   ", "the whitespace draft is kept");

  for (const char of "ok") fixture.component.handleInput(char);
  fixture.component.handleInput(ENTER); // trimmed to "ok" and submitted
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await flush();
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": ok$/);
});

test("Enter submits through the host editor with embedded newlines preserved", async () => {
  const fixture = makeEditorFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  enterEditing(fixture);
  for (const char of "alpha") fixture.component.handleInput(char);
  fixture.component.handleInput(SHIFT_ENTER);
  for (const char of "beta") fixture.component.handleInput(char);
  fixture.component.handleInput(ENTER); // submit

  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await flush();
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Answer to pending question "Which database\?": alpha\nbeta/);
});

test("the 4000-character bound reverts over-limit changes to the last compliant draft", () => {
  const fixture = makeEditorFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  enterEditing(fixture);
  fixture.editor.setText("a".repeat(4000)); // a prior compliant state (e.g. typed or pasted)
  fixture.component.handleInput("b"); // one character over the bound

  assert.equal(fixture.editor.getExpandedText(), "a".repeat(4000), "the over-limit change is reverted");

  // From an empty draft, typing past the bound stops at exactly 4000.
  const second = makeEditorFixture();
  register(second, "Which database?", { choices: ["SQLite"] });
  enterEditing(second);
  for (let i = 0; i < 5000; i += 1) second.component.handleInput("x");
  assert.equal(second.editor.getExpandedText().length, 4000);
});

test("the draft survives editing↔rows but a new answer view starts fresh (text and undo)", () => {
  const fixture = makeEditorFixture();
  register(fixture, "First question?", { choices: ["a"] });
  register(fixture, "Second question?", { choices: ["b"] });
  enterEditing(fixture); // q1's free-text row
  for (const char of "draft one") fixture.component.handleInput(char);
  fixture.component.handleInput(ESCAPE); // rows — draft kept within this session
  assert.equal(fixture.editor.getExpandedText(), "draft one");
  fixture.component.handleInput(ENTER); // resume editing
  assert.equal(fixture.editor.getExpandedText(), "draft one");

  // Leaving the answer view back to the list starts the next session fresh —
  // text, cursor and undo history all empty (the host Editor exposes no
  // public undo-stack clear, so the previous session's instance is
  // discarded and a new one is created on first edit entry).
  fixture.component.handleInput(ESCAPE); // rows
  fixture.component.handleInput(ESCAPE); // list (q1 selected)
  fixture.component.handleInput(DOWN); // select q2
  fixture.component.handleInput(ENTER); // q2's answer view: fresh session
  assert.equal(fixture.editors.length, 1, "the previous session's editor is discarded; none exists yet");
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing q2
  assert.equal(fixture.editors.length, 2, "a new answer view gets a fresh editor instance");
  assert.equal(fixture.editor.getExpandedText(), "", "the previous draft never leaks into a new answer view");
  for (const char of "draft two") fixture.component.handleInput(char);
  assert.equal(fixture.editors[0]!.getExpandedText(), "draft one", "the old session's editor is no longer referenced");
});

test("Ctrl+C (tui.select.cancel) returns to the choices from editing without closing", () => {
  const fixture = makeEditorFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  enterEditing(fixture);
  for (const char of "x") fixture.component.handleInput(char);
  fixture.component.handleInput("\x03"); // ctrl+c = cancel

  assert.equal(fixture.done.length, 0, "cancel does not close the list");
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /Which database\?/, "back on the option rows");
  assert.equal(fixture.editor.getExpandedText(), "x", "the draft is kept");
});

test("the shortcut chord collapses from host-editor editing without submitting", () => {
  const fixture = makeEditorFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  enterEditing(fixture);
  for (const char of "partial") fixture.component.handleInput(char);
  fixture.component.handleInput(CHORD);

  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
  assert.equal(fixture.controller.listPending().length, 1, "the question stays pending");
  assert.equal(fixture.sent.length, 0);
});

test("choice and decline lifecycle is unchanged with the host editor available", async () => {
  // Choice confirmation.
  const choiceFixture = makeEditorFixture();
  register(choiceFixture, "Which database?", { choices: ["SQLite", "Postgres"] });
  choiceFixture.component.handleInput(ENTER); // answer view
  choiceFixture.component.handleInput(DOWN); // 2. Postgres
  choiceFixture.component.handleInput(ENTER); // confirm
  assert.deepEqual(choiceFixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await flush();
  assert.match(choiceFixture.sent[0]!.message, /Which database\?": Postgres$/);

  // Explicit decline.
  const declineFixture = makeEditorFixture();
  register(declineFixture, "Which database?", { choices: ["SQLite"] });
  declineFixture.component.handleInput(ENTER); // answer view
  declineFixture.component.handleInput(DOWN); // Type something…
  declineFixture.component.handleInput(DOWN); // Decline row
  declineFixture.component.handleInput(ENTER); // confirm decline
  assert.deepEqual(declineFixture.done, [{ kind: "submitted", result: { status: "declined", empty: true } }]);
  await flush();
  assert.equal(declineFixture.sent.length, 0, "an async decline sends nothing to the model");
});

// ---------------------------------------------------------------------------
// Host-integration tests (real pi-tui Editor + real KeybindingsManager)
// ---------------------------------------------------------------------------

interface RealHost {
  mod: Record<string, any>;
}

async function loadRealHost(): Promise<RealHost | undefined> {
  const mod = await loadRealPiTuiModule();
  if (!mod || typeof mod.Editor !== "function" || typeof mod.KeybindingsManager !== "function") return undefined;
  return { mod };
}

function makeHostFixture(
  host: RealHost,
  userBindings: Record<string, string | string[]> = {},
): EditorFixture {
  const manager = new host.mod.KeybindingsManager(host.mod.TUI_KEYBINDINGS, userBindings);
  // The standalone module's global keybinding state must point at the live
  // manager (production does this in src/user-question/index.ts).
  host.mod.setKeybindings(manager);
  const sent: EditorFixture["sent"] = [];
  const controller = new UserQuestionController({
    pi: {
      sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }) {
        sent.push({ message, options });
        return Promise.resolve();
      },
    },
    uiAvailable: () => true,
  });
  const identity = { sessionManager: "HOST" };
  controller.beginSession(identity);
  const done: unknown[] = [];
  let editor: any;
  const tui = { terminal: { rows: 40 }, requestRender(): void {} };
  const component = createQuestionListComponent({
    controller,
    keybindings: manager,
    theme: THEME,
    shortcutLabel: "Ctrl+Alt+Up",
    tuiHost: {
      matchesKey: (data: string, keyId: string) => keyId === QUESTION_LIST_SHORTCUT_KEY && data === CHORD,
      visibleWidth: host.mod.visibleWidth as (text: string) => number,
      wrapTextWithAnsi: host.mod.wrapTextWithAnsi as (text: string, width: number) => string[],
    },
    createAnswerEditor: () => {
      editor = new host.mod.Editor(tui, {
        borderColor: (text: string) => text,
        selectList: {
          selectedPrefix: (t: string) => t,
          selectedText: (t: string) => t,
          description: (t: string) => t,
          scrollInfo: (t: string) => t,
          noMatch: (t: string) => t,
        },
      });
      return editor;
    },
    onDone: (result) => done.push(result),
  });
  // The real editor is created lazily; expose it through the fixture slot.
  const fixture = {
    controller,
    identity,
    sent,
    done,
    component,
    keys: manager,
    get editor() {
      return editor as FakeAnswerEditor;
    },
  };
  return fixture as EditorFixture;
}

function hostRegister(fixture: EditorFixture, question: string, choices?: string[]): void {
  const result = fixture.controller.register(
    { toolCallId: `t${fixture.controller.listPending().length + 1}`, question, choices, mode: "async" },
    fixture.identity,
  );
  assert.ok(result.ok);
}

function hostEnterEditing(fixture: EditorFixture): void {
  enterEditing(fixture);
}

/** Rendered lines with the hardware-cursor marker and ANSI styles removed. */
function plainLines(host: RealHost, lines: string[]): string[] {
  const marker = typeof host.mod.CURSOR_MARKER === "string" ? host.mod.CURSOR_MARKER : "\x1b_pi:c\x07";
  return lines.map((line) => line.split(marker).join(""));
}

test("host integration: multiline draft renders width-correctly and navigates", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const fixture = makeHostFixture(host);
  hostRegister(fixture, "Which database?", ["SQLite"]);
  hostEnterEditing(fixture);
  for (const char of "alpha") fixture.component.handleInput(char);
  fixture.component.handleInput(SHIFT_ENTER); // shift+enter inserts a newline
  for (const char of "beta") fixture.component.handleInput(char);

  const editor = fixture.editor as any;
  assert.deepEqual(editor.getLines(), ["alpha", "beta"], "the real editor owns the multiline draft");

  const lines = plainLines(host, fixture.component.render(40));
  for (const line of lines) {
    assert.ok(host.mod.visibleWidth(line) <= 40, `line fits the width: ${JSON.stringify(line)}`);
  }
  assert.ok(lines.findIndex((line) => line.includes("alpha")) < lines.findIndex((line) => line.includes("beta")));

  // Vertical navigation moves between the draft's lines (the cursor sits on
  // the second line after typing it).
  assert.equal(editor.getCursor().line, 1);
  fixture.component.handleInput(UP);
  assert.equal(editor.getCursor().line, 0, "up moves to the first line");
  fixture.component.handleInput(DOWN);
  assert.equal(editor.getCursor().line, 1, "down moves back to the second line");

  // PageUp/PageDown are no-ops on a short draft but must not disturb it.
  fixture.component.handleInput(PAGE_UP);
  fixture.component.handleInput(PAGE_DOWN);
  assert.deepEqual(editor.getLines(), ["alpha", "beta"]);
});

test("host integration: movement chords (word, line start/end, home/end) honor the live manager", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const fixture = makeHostFixture(host);
  hostRegister(fixture, "Which database?", ["SQLite"]);
  hostEnterEditing(fixture);
  for (const char of "one two three") fixture.component.handleInput(char);
  const editor = fixture.editor as any;
  assert.equal(editor.getCursor().col, 13);

  // Word movement: alt+left and ctrl+left.
  fixture.component.handleInput(ALT_LEFT);
  assert.equal(editor.getCursor().col, 8, "alt+left jumps to the start of 'three'");
  fixture.component.handleInput(ALT_LEFT);
  assert.equal(editor.getCursor().col, 4, "alt+left jumps to the start of 'two'");
  fixture.component.handleInput(CTRL_LEFT);
  assert.equal(editor.getCursor().col, 0, "ctrl+left jumps to the start of 'one'");

  // Line start/end: ctrl+a / ctrl+e and home / end.
  fixture.component.handleInput(CTRL_E);
  assert.equal(editor.getCursor().col, 13, "ctrl+e moves to line end");
  fixture.component.handleInput(HOME);
  assert.equal(editor.getCursor().col, 0, "home moves to line start");
  fixture.component.handleInput(END);
  assert.equal(editor.getCursor().col, 13, "end moves to line end");
  fixture.component.handleInput(CTRL_A);
  assert.equal(editor.getCursor().col, 0, "ctrl+a moves to line start");

  // Alt+right walks back toward the end.
  for (let i = 0; i < 5; i += 1) fixture.component.handleInput(ALT_RIGHT);
  assert.equal(editor.getCursor().col, 13, "alt+right reaches line end");

  // Character jump forward (ctrl+]): the next key is the target character.
  fixture.component.handleInput(CTRL_A); // from line start
  fixture.component.handleInput("\x1d"); // ctrl+] = tui.editor.jumpForward
  fixture.component.handleInput("t"); // jump to the next 't'
  assert.equal(editor.getCursor().col, 4, "the jump landed on 'two'");
});

test("host integration: newline chords insert newlines; plain Enter submits", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const fixture = makeHostFixture(host);
  hostRegister(fixture, "Which database?", ["SQLite"]);
  hostEnterEditing(fixture);
  for (const char of "first") fixture.component.handleInput(char);
  fixture.component.handleInput(CTRL_J); // ctrl+j inserts a newline
  for (const char of "second") fixture.component.handleInput(char);
  const editor = fixture.editor as any;
  assert.deepEqual(editor.getLines(), ["first", "second"], "ctrl+j inserted a newline");
  fixture.component.handleInput(SHIFT_ENTER);
  assert.equal(editor.getLines().length, 3, "shift+enter inserted another newline");

  fixture.component.handleInput(ENTER); // plain Enter submits
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await flush();
  assert.equal(fixture.sent.length, 1);
  // Embedded newlines are preserved; only the ends are trimmed.
  assert.match(fixture.sent[0]!.message, /": first\nsecond$/);
});

test("host integration: deletion, kill ring, and undo chords behave like the chat editor", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const fixture = makeHostFixture(host);
  hostRegister(fixture, "Which database?", ["SQLite"]);
  hostEnterEditing(fixture);
  const editor = fixture.editor as any;

  // ctrl+w deletes the word backward (host semantics: stops at the word
  // start; a preceding space only goes with a word deleted from beyond it).
  for (const char of "foo bar") fixture.component.handleInput(char);
  fixture.component.handleInput(CTRL_W);
  assert.equal(editor.getExpandedText(), "foo ", "ctrl+w deleted 'bar'");

  // Forward delete: cursor before 'z', ctrl+d removes it.
  for (const char of "baz") fixture.component.handleInput(char); // "foo baz"
  fixture.component.handleInput(LEFT);
  fixture.component.handleInput(CTRL_D);
  assert.equal(editor.getExpandedText(), "foo ba", "ctrl+d deleted the character forward");

  // ctrl+k deletes to line end; ctrl+y yanks it back.
  fixture.component.handleInput(HOME);
  for (let i = 0; i < 3; i += 1) fixture.component.handleInput(RIGHT); // after "foo"
  fixture.component.handleInput(CTRL_K);
  assert.equal(editor.getExpandedText(), "foo", "ctrl+k deleted to line end");
  fixture.component.handleInput(CTRL_Y);
  assert.equal(editor.getExpandedText(), "foo ba", "ctrl+y yanked the killed text back");

  // ctrl+u deletes to line start.
  fixture.component.handleInput(CTRL_U);
  assert.equal(editor.getExpandedText(), "", "ctrl+u deleted to line start");

  // Undo restores the last edit.
  for (const char of "abc") fixture.component.handleInput(char);
  fixture.component.handleInput(UNDO);
  assert.equal(editor.getExpandedText(), "", "undo reverted the insertion");

  // Delete key (forward) works too.
  for (const char of "xy") fixture.component.handleInput(char);
  fixture.component.handleInput(HOME);
  fixture.component.handleInput(DELETE_FWD);
  assert.equal(editor.getExpandedText(), "y", "delete removed the first character");
});

test("host integration: user keybinding overrides reach the embedded editor", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  // Rebind submit to F8 and word-left to F6; the old keys must stop acting.
  const fixture = makeHostFixture(host, {
    "tui.input.submit": ["f8"],
    "tui.editor.cursorWordLeft": ["f6"],
  });
  hostRegister(fixture, "Which database?", ["SQLite"]);
  // Row confirmation still uses tui.select.confirm (Enter) — unchanged.
  fixture.component.handleInput(ENTER); // answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  const editor = fixture.editor as any;
  for (const char of "one two three") fixture.component.handleInput(char);

  fixture.component.handleInput(ALT_LEFT);
  assert.equal(editor.getCursor().col, 13, "the old word-left binding no longer acts");
  fixture.component.handleInput(F6);
  assert.equal(editor.getCursor().col, 8, "the user's F6 binding moves the word left");

  fixture.component.handleInput(ENTER);
  assert.equal(fixture.done.length, 0, "Enter no longer submits after the rebind");
  assert.equal(editor.getExpandedText(), "one two three", "the draft is untouched by the inert Enter");
  fixture.component.handleInput(F8);
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await flush();
  assert.match(fixture.sent[0]!.message, /": one two three$/);
});

test("host integration: unsupported escape input never leaks printable tails into the draft", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const fixture = makeHostFixture(host);
  hostRegister(fixture, "Which database?", ["SQLite"]);
  hostEnterEditing(fixture);
  for (const char of "yes") fixture.component.handleInput(char);
  const unknown = [
    "\x1b[1;99A", // arrow with an unsupported modifier value
    "\x1bOZ", // SS3 sequence the editor does not own
    "\x1b[999~", // unknown parameterized sequence
  ];
  for (const sequence of unknown) fixture.component.handleInput(sequence);

  const editor = fixture.editor as any;
  assert.equal(editor.getExpandedText(), "yes", "unknown sequences change nothing");
  const rendered = plainLines(host, fixture.component.render(80)).join("\n");
  assert.ok(!/1;99A|OZ|999~/.test(rendered), "no printable tails reach the rendering");

  // The draft remains fully editable afterwards.
  for (const char of " and no") fixture.component.handleInput(char);
  fixture.component.handleInput(ENTER);
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await flush();
  assert.match(fixture.sent[0]!.message, /": yes and no$/);
});

test("host integration: the 4000-character bound holds for typing and pastes", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const fixture = makeHostFixture(host);
  hostRegister(fixture, "Which database?", ["SQLite"]);
  hostEnterEditing(fixture);
  const editor = fixture.editor as any;

  // Typing one character over the bound reverts to the compliant draft.
  editor.setText("a".repeat(4000));
  fixture.component.handleInput("b");
  assert.equal(editor.getExpandedText(), "a".repeat(4000), "the over-limit keystroke is reverted");

  // A large bracketed paste from an empty draft cannot exceed the bound.
  const second = makeHostFixture(host);
  hostRegister(second, "Which database?", ["SQLite"]);
  hostEnterEditing(second);
  second.component.handleInput(`\x1b[200~${"c".repeat(5000)}\x1b[201~`);
  const expanded = (second.editor as any).getExpandedText();
  assert.ok(expanded.length <= 4000, `paste is clamped to the bound (got ${expanded.length})`);
});

test("host integration: choice and decline lifecycle is unchanged with the real editor", async (t) => {
  const host = await loadRealHost();
  if (!host) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  // Choice.
  const choiceFixture = makeHostFixture(host);
  hostRegister(choiceFixture, "Which database?", ["SQLite", "Postgres"]);
  choiceFixture.component.handleInput(ENTER); // answer view
  choiceFixture.component.handleInput(DOWN); // 2. Postgres
  choiceFixture.component.handleInput(ENTER); // confirm
  assert.deepEqual(choiceFixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await flush();
  assert.match(choiceFixture.sent[0]!.message, /": Postgres$/);

  // Decline.
  const declineFixture = makeHostFixture(host);
  hostRegister(declineFixture, "Which database?", ["SQLite"]);
  declineFixture.component.handleInput(ENTER); // answer view
  declineFixture.component.handleInput(DOWN); // Type something…
  declineFixture.component.handleInput(DOWN); // Decline row
  declineFixture.component.handleInput(ENTER); // confirm decline
  assert.deepEqual(declineFixture.done, [{ kind: "submitted", result: { status: "declined", empty: true } }]);
  await flush();
  assert.equal(declineFixture.sent.length, 0);

  // Escape from real-editor editing preserves the draft for re-entry.
  const draftFixture = makeHostFixture(host);
  hostRegister(draftFixture, "Which database?", ["SQLite"]);
  hostEnterEditing(draftFixture);
  for (const char of "kept") draftFixture.component.handleInput(char);
  draftFixture.component.handleInput(ESCAPE);
  assert.equal((draftFixture.editor as any).getExpandedText(), "kept");
  draftFixture.component.handleInput(ENTER); // resume editing
  assert.equal((draftFixture.editor as any).getCursor().col, 4, "the cursor position survives too");
});
