import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { UserQuestionController } from "../src/user-question/controller";
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import { visibleTerminalText } from "../src/tool-result-text";

/** Raw sequence used by the fakes for the approved chord (Kitty-style). */
const CHORD = "\x1b[1;64A";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const TAB = "\t";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CTRL_ALT_PAGE_UP = "\x1b[5;7~";
const CTRL_ALT_PAGE_DOWN = "\x1b[6;7~";
const SHIFT_ALT_UP = "\x1b[1;4A";
const SHIFT_ALT_DOWN = "\x1b[1;4B";

type EditorLineChunk = { text: string; startIndex: number; endIndex: number };
const editorWordWrapLine = (createRequire(__filename)("pi-session-host-tui/dist/components/editor.js") as {
  wordWrapLine: (text: string, width: number) => EditorLineChunk[];
}).wordWrapLine;

function makeKeybindings(overrides: Record<string, string[]> = {}) {
  const bindings: Record<string, string[]> = {
    "tui.select.up": [UP],
    "tui.select.down": [DOWN],
    "tui.select.confirm": [ENTER],
    // The pi 0.87.1 defaults: cancel is escape + ctrl+c; the component's
    // editing pre-check must let ctrl+c through to the native clear.
    "tui.select.cancel": [ESCAPE, CTRL_C],
    "app.interrupt": [ESCAPE],
    "app.clear": [CTRL_C],
    "app.exit": [CTRL_D],
    "tui.editor.cursorLeft": [LEFT],
    "tui.editor.cursorRight": [RIGHT],
    "tui.editor.deleteCharBackward": [BACKSPACE],
    "tui.editor.pageUp": [PAGE_UP],
    "tui.editor.pageDown": [PAGE_DOWN],
  };
  Object.assign(bindings, overrides);
  return {
    matches(data: string, keybinding: string): boolean {
      return (bindings[keybinding] ?? []).includes(data);
    },
  };
}

/**
 * The post-bridge instance contract as seen by the component: a host-wired
 * editor whose intercepted keys settle through onFieldSettle and whose native
 * submit path (Enter) routes through the taken-over onSubmit. Emulates just
 * enough of pi-tui's base Editor for the component tier; the bridge's own
 * logic is pinned by the editor-parity and wiring tiers.
 */
class FakeNativeField {
  fieldActive = false;
  focused = false;
  onFieldSettle?: (value: string | undefined) => void;
  onSubmit?: (text: string) => void;
  private text = "";
  private cursor = 0;
  private scrollOffset = 0;
  // Pi's Editor keeps at least five text rows at a terminal height of five.
  private readonly maxVisibleLines = 5;
  private renderedHiddenLineCount = 0;
  private listItems: string[] | undefined;
  completionItems = ["assets/", "guide.md"];
  readonly inputLog: string[] = [];

  constructor() {
    // The bridge's native-submit takeover with the question semantics:
    // non-empty submits, empty stays open (the draft was cleared natively).
    this.onSubmit = (text: string) => this.nativeSubmit(text);
  }

  nativeSubmit(text: string): void {
    const value = text.trim();
    if (value.length === 0) return;
    this.onFieldSettle?.(value);
  }

  getText(): string {
    return this.text;
  }

  getLines(): string[] {
    return this.text.split("\n");
  }

  getCursor(): { line: number; col: number } {
    const beforeCursor = this.text.slice(0, this.cursor);
    const lastNewline = beforeCursor.lastIndexOf("\n");
    return { line: beforeCursor.split("\n").length - 1, col: beforeCursor.length - lastNewline - 1 };
  }

  getPaddingX(): number {
    return 0;
  }

  getRenderedHiddenLineCount(): number {
    return this.renderedHiddenLineCount;
  }

  setText(text: string): void {
    this.text = text;
    this.cursor = text.length;
    this.scrollOffset = 0;
    this.renderedHiddenLineCount = 0;
  }

  isShowingAutocomplete(): boolean {
    return this.listItems !== undefined;
  }

  render(width: number): string[] {
    const textLines = this.text.split("\n");
    const layoutWidth = Math.max(1, width - 1); // Editor reserves one cursor cell with zero padding.
    const chunksByLine = textLines.map((line) => editorWordWrapLine(line, layoutWidth));
    const cursorLine = this.getCursor().line;
    const cursorColumn = this.getCursor().col;
    let cursorVisualRow = chunksByLine.slice(0, cursorLine).reduce((rows, chunks) => rows + chunks.length, 0);
    const cursorChunks = chunksByLine[cursorLine] ?? [];
    const cursorChunk = cursorChunks.findIndex((chunk, index) =>
      cursorColumn >= chunk.startIndex
      && (index === cursorChunks.length - 1 || cursorColumn < chunk.endIndex));
    cursorVisualRow += Math.max(0, cursorChunk);
    const layoutLines = chunksByLine.flatMap((chunks, logicalLine) => chunks.map((chunk, chunkIndex) => ({
      chunk,
      logicalLine,
      isLastChunk: chunkIndex === chunks.length - 1,
    })));
    if (cursorVisualRow < this.scrollOffset) this.scrollOffset = cursorVisualRow;
    else if (cursorVisualRow >= this.scrollOffset + this.maxVisibleLines) {
      this.scrollOffset = cursorVisualRow - this.maxVisibleLines + 1;
    }
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, layoutLines.length - this.maxVisibleLines));
    this.renderedHiddenLineCount = this.scrollOffset;
    const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleLines);
    const lines = ["─".repeat(width), ...visibleLines.map((visualLine, index) => {
      const absoluteRow = this.scrollOffset + index;
      const prefix = visualLine.logicalLine === 0 && visualLine.chunk.startIndex === 0 ? "[field:" : "  ";
      const suffix = visualLine.logicalLine === textLines.length - 1 && visualLine.isLastChunk ? "]" : "";
      const cursor = absoluteRow === cursorVisualRow ? "\x1b_pi:c\x07" : "";
      return `${prefix}${visualLine.chunk.text}${suffix}${cursor}`;
    }), "─".repeat(width)];
    for (const item of this.listItems ?? []) lines.push(`  ${item}`);
    return lines;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    this.inputLog.push(data);
    // The bridge's interceptions, emulated at the instance boundary.
    if (data === ESCAPE && !this.listItems) {
      this.onFieldSettle?.(undefined); // app.interrupt
      return;
    }
    if (data === CTRL_D && this.text.length === 0) {
      this.onFieldSettle?.(undefined); // app.exit, empty editor only
      return;
    }
    // The host's copied app.clear handler: Ctrl+C clears the draft, never cancels.
    if (data === CTRL_C) {
      this.text = "";
      this.cursor = 0;
      this.scrollOffset = 0;
      return;
    }
    if (data === TAB) {
      if (!this.listItems) this.listItems = [...this.completionItems];
      return;
    }
    if (data === UP) {
      const lineStart = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
      if (lineStart > 0) {
        const column = this.cursor - lineStart;
        const previousLineEnd = lineStart - 1;
        const previousLineStart = this.text.lastIndexOf("\n", previousLineEnd - 1) + 1;
        this.cursor = previousLineStart + Math.min(column, previousLineEnd - previousLineStart);
      }
      return;
    }
    if (data === ESCAPE && this.listItems) {
      this.listItems = undefined; // dismiss the visible list first
      return;
    }
    if (data === ENTER && this.listItems) {
      this.insert(this.listItems[0]!); // confirm the highlighted completion
      this.listItems = undefined;
      return;
    }
    // Bracketed paste: the base Editor strips the markers and inserts the payload.
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      this.insert(data.slice("\x1b[200~".length, -"\x1b[201~".length));
      return;
    }
    if (data === LEFT) {
      if (this.cursor > 0) this.cursor -= 1;
      return;
    }
    if (data === RIGHT) {
      if (this.cursor < this.text.length) this.cursor += 1;
      return;
    }
    if (data === BACKSPACE) {
      if (this.cursor > 0) {
        this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
        this.cursor -= 1;
      }
      return;
    }
    if (data === ENTER) {
      // The native submitValue: trim, clear state, then the taken-over onSubmit.
      const value = this.text.trim();
      this.text = "";
      this.cursor = 0;
      this.onSubmit?.(value);
      return;
    }
    // Unrecognized terminal sequences are ignored; printable runs (single
    // keystrokes or coalesced chunks) insert at the cursor.
    if ([...data].every((ch) => ch >= " ")) this.insert(data);
  }

  private insert(text: string): void {
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }
}

function makeTuiHost() {
  const visibleWidth = (text: string): number => text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return {
    matchesKey(data: string, keyId: string): boolean {
      if (keyId === QUESTION_LIST_SHORTCUT_KEY) return data === CHORD;
      const popupScrollKeys: Record<string, string> = {
        "ctrl+alt+pageup": CTRL_ALT_PAGE_UP,
        "ctrl+alt+pagedown": CTRL_ALT_PAGE_DOWN,
        "shift+alt+up": SHIFT_ALT_UP,
        "shift+alt+down": SHIFT_ALT_DOWN,
      };
      return popupScrollKeys[keyId] === data;
    },
    visibleWidth,
    wrapEditorLine(text: string, width: number): EditorLineChunk[] {
      return editorWordWrapLine(text, width);
    },
    wrapTextWithAnsi(text: string, width: number): string[] {
      const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
      if (visibleWidth(plain) <= width) return [text];
      const words = plain.split(/(\s+)/).filter((part) => part.length > 0);
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current && visibleWidth(current + word) > width) {
          lines.push(current);
          current = /^\s+$/.test(word) ? "" : word;
        } else {
          current += word;
        }
      }
      if (current.length > 0) lines.push(current);
      return lines.length > 0 ? lines : [""];
    },
  };
}

const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

interface Fixture {
  controller: UserQuestionController;
  identity: object;
  sent: Array<{ message: string; options?: { deliverAs?: "steer" | "followUp" } }>;
  done: Array<unknown>;
  component: ReturnType<typeof createQuestionListComponent>;
  /** The host-wired native field instance (undefined when the seams are unavailable). */
  field: FakeNativeField | undefined;
}

function makeFixture(options: {
  field?: boolean;
  getViewportRows?: () => number;
  keybindings?: ReturnType<typeof makeKeybindings>;
} = {}): Fixture {
  const sent: Fixture["sent"] = [];
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
  const field = options.field === false ? undefined : new FakeNativeField();
  const component = createQuestionListComponent({
    controller,
    keybindings: options.keybindings ?? makeKeybindings(),
    theme: THEME,
    tuiHost: makeTuiHost(),
    shortcutLabel: "Ctrl+Alt+Up",
    nativeField: field,
    getViewportRows: options.getViewportRows,
    onDone: (result) => done.push(result),
  });
  return { controller, identity, sent, done, component, field };
}

function register(fixture: Fixture, question: string, options: { choices?: string[]; mode?: "async" | "sync" } = {}) {
  const result = fixture.controller.register(
    { toolCallId: `t${fixture.controller.listPending().length + 1}`, question, choices: options.choices, mode: options.mode ?? "async" },
    fixture.identity,
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("registration failed");
  return result.question.id;
}

function registerNotice(fixture: Fixture, body: string): string {
  const result = fixture.controller.registerNotice({
    toolCallId: `notice${fixture.controller.listPending().length + 1}`,
    title: "Scroll regression notice",
    body,
  }, fixture.identity);
  assert.ok(result.ok);
  if (!result.ok) throw new Error("notice registration failed");
  return result.notice.id;
}

test("the list renders pending questions with the shortcut hint and waiting tags", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite", "Postgres"], mode: "sync" });
  register(fixture, "Include raw counts?");
  const lines = fixture.component.render(80);
  const text = lines.join("\n");
  assert.match(text, /Pending questions \(2\)/);
  assert.match(text, /Ctrl\+Alt\+Up to close/);
  assert.match(text, /q1: Which database\? \[waiting\]/);
  assert.match(text, /q2: Include raw counts\?/);
  assert.ok(!/\[waiting\]/.test(lines.find((line) => line.includes("q2")) ?? ""), "async questions are not waiting");
});

test("popup page shortcuts scroll with overlap and preserve plain PageUp/PageDown fallback", () => {
  const fixture = makeFixture({ getViewportRows: () => 6 });
  registerNotice(fixture, [
    "# Scroll regression body",
    ...Array.from({ length: 18 }, (_, index) => `Unique notice line ${String(index + 1).padStart(2, "0")}.`),
    "DISTANT_NOTICE_SCROLL_SENTINEL",
  ].join("\n"));
  fixture.component.handleInput(ENTER); // open the selected notice

  const assertOneLineOverlap = (before: string[], key: string, direction: "up" | "down" = "down"): string[] => {
    fixture.component.handleInput(key);
    const after = fixture.component.render(80);
    assert.equal(after.length, 6);
    if (direction === "down") {
      assert.deepEqual(after.slice(0, -1), before.slice(1),
        "the layout-less fallback advances exactly one line and cannot skip unseen content");
    } else {
      assert.deepEqual(after.slice(1), before.slice(0, -1),
        "the layout-less fallback moves back one line with overlapping coverage");
    }
    return after;
  };

  const observedLines = new Set<string>();
  const record = (lines: string[]): void => lines.forEach((line) => observedLines.add(line));
  let frame = fixture.component.render(80);
  record(frame);
  frame = assertOneLineOverlap(frame, CTRL_ALT_PAGE_DOWN);
  record(frame);
  frame = assertOneLineOverlap(frame, SHIFT_ALT_DOWN);
  record(frame);
  frame = assertOneLineOverlap(frame, PAGE_DOWN);
  record(frame);
  for (let page = 0; page < 100 && !(frame.some((line) => line.includes("DISTANT_NOTICE_SCROLL_SENTINEL"))
    && frame.some((line) => line.includes("Close"))); page += 1) {
    frame = assertOneLineOverlap(frame, page % 2 === 0 ? CTRL_ALT_PAGE_DOWN : SHIFT_ALT_DOWN);
    record(frame);
  }
  assert.ok(frame.some((line) => line.includes("DISTANT_NOTICE_SCROLL_SENTINEL")), "the distant body sentinel is reachable");
  assert.ok(frame.some((line) => line.includes("More details")) && frame.some((line) => line.includes("Close")),
    "both notice actions remain reachable after the complete body");
  const observed = [...observedLines].join("\n");
  for (let line = 1; line <= 18; line += 1) {
    assert.ok(observed.includes(`Unique notice line ${String(line).padStart(2, "0")}`), `scrolling exposes body line ${line}`);
  }
  frame = assertOneLineOverlap(frame, PAGE_UP, "up");
  frame = assertOneLineOverlap(frame, SHIFT_ALT_UP, "up");
  frame = assertOneLineOverlap(frame, CTRL_ALT_PAGE_UP, "up");
  assert.equal(fixture.controller.listPending().length, 1, "popup-local scrolling leaves the notice pending");
  assert.equal(fixture.sent.length, 0, "scrolling sends no model message");
});

test("bounded pending-list navigation keeps the selected identifier visible", () => {
  let rows = 5;
  const fixture = makeFixture({ getViewportRows: () => rows });
  for (let index = 1; index <= 6; index += 1) register(fixture, `Question ${index}?`);
  for (let index = 1; index <= 6; index += 1) {
    const frame = fixture.component.render(80);
    assert.ok(frame.length <= rows);
    assert.ok(frame.some((line) => line.includes(`> q${index}: Question ${index}?`)));
    if (index < 6) fixture.component.handleInput(DOWN);
  }
  rows = 2;
  assert.match(fixture.component.render(80).join("\n"), /> q6: Question 6\?/);
  for (let index = 5; index >= 1; index -= 1) {
    fixture.component.handleInput(UP);
    assert.match(fixture.component.render(80).join("\n"), new RegExp(`> q${index}: Question ${index}\\?`));
  }
  assert.equal(fixture.controller.listPending().length, 6);
  assert.equal(fixture.sent.length, 0);
});

test("arrow navigation and Enter open the answer view with choices, free text, and decline", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite", "Postgres"], mode: "sync" });
  fixture.component.handleInput(DOWN);
  assert.equal(fixture.controller.listPending().length, 1, "navigation alone never resolves a question");
  fixture.component.handleInput(UP);
  fixture.component.handleInput(ENTER);
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /Which database\?/);
  assert.match(text, /> 1\. SQLite/, "first choice selected by default");
  assert.match(text, /2\. Postgres/);
  assert.match(text, /Type something…/);
  assert.match(text, /Decline \(no answer will be sent\)/);
});

test("answering with a supplied choice delivers it and closes when the list empties", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite", "Postgres"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view (first question selected)
  fixture.component.handleInput(DOWN); // move to "2. Postgres"
  fixture.component.handleInput(ENTER); // confirm the choice
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Answer to pending question "Which database\?": Postgres/);
});

test("free-text answers support typing, cursor movement, and backspace", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  // Rows with one choice: [1. SQLite, Type something…, Decline].
  fixture.component.handleInput(ENTER); // open answer view (row 0 selected)
  fixture.component.handleInput(DOWN); // row 1: Type something…
  fixture.component.handleInput(DOWN); // row 2: Decline — then back out without confirming
  fixture.component.handleInput(ESCAPE); // back to list; nothing declined
  assert.equal(fixture.controller.listPending().length, 1);
  fixture.component.handleInput(ENTER); // open answer view again (row 0)
  fixture.component.handleInput(DOWN); // row 1: Type something…
  fixture.component.handleInput(ENTER); // start editing
  for (const char of "yes") fixture.component.handleInput(char);
  fixture.component.handleInput(BACKSPACE); // "ye"
  fixture.component.handleInput(LEFT);
  fixture.component.handleInput("X"); // "yXe"
  fixture.component.handleInput(RIGHT);
  fixture.component.handleInput(RIGHT);
  fixture.component.handleInput("s"); // "yXes"
  fixture.component.handleInput(ENTER); // submit
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": yXes$/);
});

test("empty or whitespace-only free text never submits; an empty Enter clears the draft like the main chat", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  fixture.component.handleInput(ENTER); // empty draft: nothing to send, still editing
  assert.equal(fixture.done.length, 0);
  fixture.component.handleInput("   "); // whitespace only: still no submission
  fixture.component.handleInput(ENTER);
  assert.equal(fixture.done.length, 0);
  assert.equal(fixture.field!.getText(), "", "the native submit path cleared the state before settling");
  fixture.component.handleInput("ok");
  fixture.component.handleInput(ENTER); // trimmed and submitted
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": ok$/);
});

test("backing out of free text keeps the draft in the shared instance", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  for (const char of "partial draft") fixture.component.handleInput(char);
  fixture.component.handleInput(ESCAPE); // back to the option rows; draft kept
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /> Type something…/, "selection stays on the free-text row");
  assert.equal(fixture.field!.getText(), "partial draft", "the draft survives backing out");
  fixture.component.handleInput(ENTER); // resume editing with the draft
  fixture.component.handleInput(" done");
  fixture.component.handleInput(ENTER); // submit
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": partial draft done$/);
});

test("the bounded answer viewport follows selected rows and keeps the native editor box/completions visible", () => {
  const viewportRows = 5;
  const fixture = makeFixture({ getViewportRows: () => viewportRows });
  const question = [
    "# A long Markdown question",
    ...Array.from({ length: 16 }, (_, index) => `Question detail ${index + 1} explains the complete decision context.`),
    "The answer rows are below the complete question body.",
  ].join("\n\n");
  register(fixture, question, { choices: ["Keep the current release lane"] });

  fixture.component.handleInput(ENTER);
  let frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows, "the long question uses the bounded shared viewport");
  assert.match(frame.join("\n"), /> 1\. Keep the current release lane/,
    "opening the answer view scrolls the selected choice into view");

  fixture.component.handleInput(DOWN);
  frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows);
  assert.match(frame.join("\n"), /> Type something…/,
    "moving to the free-text row scrolls that selected row into view");
  fixture.component.handleInput(ENTER);
  frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows);
  assert.ok(frame.join("\n").includes("[field:]"), "the active native answer editor is visible");
  assert.ok(frame.join("\n").includes("\x1b_pi:c\x07"), "the native cursor row is visible");

  fixture.component.handleInput("\x1b[200~first line\nsecond line\nthird line\x1b[201~");
  frame = fixture.component.render(48);
  const multilineDraft = frame.join("\n");
  assert.ok(frame.length <= viewportRows);
  assert.match(multilineDraft, /\[field:first line/);
  assert.match(multilineDraft, /second line/);
  assert.match(multilineDraft, /third line\].*\x1b_pi:c\x07/,
    "the native editor's own cursor marker remains available in the visible end of its growing box");

  fixture.component.handleInput(TAB);
  frame = fixture.component.render(48);
  const completionFrame = frame.join("\n");
  assert.ok(frame.length <= viewportRows);
  assert.match(completionFrame, /\x1b_pi:c\x07/);
  assert.match(completionFrame, /assets\//, "completion growth remains visible beside the active editor");
  assert.match(completionFrame, /guide\.md/);

  fixture.component.handleInput(ESCAPE); // native completion dismisses before the answer UI
  frame = fixture.component.render(48);
  assert.ok(frame.join("\n").includes("\x1b_pi:c\x07"), "dismissed completions leave the editor cursor visible");
  fixture.component.handleInput(ESCAPE); // return to the options without losing the draft
  frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows);
  assert.match(frame.join("\n"), /> Type something…/);
  assert.equal(fixture.field!.getText(), "first line\nsecond line\nthird line");
});

test("an oversized native field keeps its active cursor row visible through completions and viewport shrink", () => {
  let viewportRows = 5;
  const fixture = makeFixture({ getViewportRows: () => viewportRows });
  register(fixture, "Which deployment lane?", { choices: ["Canary"] });
  fixture.component.handleInput(ENTER); // answer view
  fixture.component.handleInput(DOWN); // free-text row
  fixture.component.handleInput(ENTER); // editing
  fixture.component.handleInput("\x1b[200~line 1\nline 2\nline 3\nline 4\nline 5\nline 6\x1b[201~");
  for (let index = 0; index < 5; index += 1) fixture.component.handleInput(UP);

  assert.equal(fixture.field!.getCursor().line, 0, "the native editor cursor returns to the first pasted line");
  let frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows);
  assert.match(frame.join("\n"), /\[field:line 1/,
    "the first logical cursor row remains visible in a five-row popup even though the editor box is taller");

  fixture.field!.completionItems = Array.from({ length: 8 }, (_, index) => `suggestion ${index + 1}`);
  fixture.component.handleInput(TAB);
  assert.equal(fixture.field!.isShowingAutocomplete(), true);
  const nativeBoxWithCompletions = fixture.field!.render(46);
  assert.ok(nativeBoxWithCompletions.length > viewportRows,
    "the oversized completion list makes the native editor box taller than the popup viewport");
  assert.ok(nativeBoxWithCompletions.some((line) => line.includes("suggestion 8")),
    "the native editor contains completion rows beyond the popup's visible height");
  frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows);
  assert.match(frame.join("\n"), /\[field:line 1/,
    "an oversized completion list cannot push the active cursor row out of the popup");

  viewportRows = 3;
  frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows, "the popup respects the smaller resized viewport");
  assert.match(frame.join("\n"), /\[field:line 1/,
    "viewport shrink repositions around the public native cursor row");
});

test("popup focus accounts for text hidden by the native editor's internal scroll", () => {
  let viewportRows = 3;
  const fixture = makeFixture({ getViewportRows: () => viewportRows });
  register(fixture, "Which deployment lane?", { choices: ["Canary"] });
  fixture.component.handleInput(ENTER); // answer view
  fixture.component.handleInput(DOWN); // free-text row
  fixture.component.handleInput(ENTER); // editing
  fixture.component.handleInput("\x1b[200~line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\x1b[201~");

  let frame = fixture.component.render(48);
  assert.equal(fixture.field!.getRenderedHiddenLineCount(), 5,
    "a five-row native editor viewport clips the five-line prefix at the end of the ten-line draft");
  assert.ok(frame.length <= viewportRows);
  assert.ok(frame.some((row) => row.includes("line 10") && row.includes("\x1b_pi:c\x07")),
    "the cursor on the final line is visible in the three-row popup");

  for (const expectedLine of ["line 9", "line 8", "line 7"]) {
    fixture.component.handleInput(UP);
    frame = fixture.component.render(48);
    assert.ok(frame.length <= viewportRows);
    assert.ok(frame.some((row) => row.includes(expectedLine) && row.includes("\x1b_pi:c\x07")),
      `the actual cursor-bearing row ${expectedLine} remains visible after rendering each Up input`);
  }

  fixture.field!.completionItems = Array.from({ length: 8 }, (_, index) => `suggestion ${index + 1}`);
  fixture.component.handleInput(TAB);
  frame = fixture.component.render(48);
  assert.equal(fixture.field!.isShowingAutocomplete(), true);
  assert.ok(frame.length <= viewportRows);
  assert.ok(frame.some((row) => row.includes("line 7") && row.includes("\x1b_pi:c\x07")),
    "the cursor remains visible when the native box also contains an oversized completion list");

  viewportRows = 2;
  frame = fixture.component.render(48);
  assert.ok(frame.length <= viewportRows, "the popup respects the shrunken viewport");
  assert.ok(frame.some((row) => row.includes("line 7") && row.includes("\x1b_pi:c\x07")),
    "the cursor remains visible after resize with the native editor still internally scrolled");
});

test("native cursor mapping preserves wrapped whitespace rows", () => {
  const fixture = makeFixture({ getViewportRows: () => 3 });
  register(fixture, "Which deployment lane?", { choices: ["Canary"] });
  fixture.component.handleInput(ENTER); // answer view
  fixture.component.handleInput(DOWN); // free-text row
  fixture.component.handleInput(ENTER); // editing
  fixture.component.handleInput(`\x1b[200~a${" ".repeat(100)}\nb\x1b[201~`);

  // Component width 14 gives the native Editor width 12 and its eleven-cell
  // layout after the reserved cursor cell, matching the review regression.
  const frame = fixture.component.render(14);
  assert.equal(fixture.field!.getRenderedHiddenLineCount(), 6,
    "the five-row native viewport clips six visual rows above the cursor");
  assert.ok(frame.length <= 3);
  assert.ok(frame.some((row) => row.includes("b") && row.includes("\x1b_pi:c\x07")),
    "the cursor-bearing row after preserved whitespace wraps remains visible");
});

test("native cursor mapping uses complete-line chunks at an interior word-wrap boundary", () => {
  const fixture = makeFixture({ getViewportRows: () => 3 });
  register(fixture, "Which deployment lane?", { choices: ["Canary"] });
  fixture.component.handleInput(ENTER); // answer view
  fixture.component.handleInput(DOWN); // free-text row
  fixture.component.handleInput(ENTER); // editing
  const line = "alpha beta gamma delta epsilon zeta eta theta";
  const cursorColumn = 23; // Start of the fifth native visual chunk at width six.
  const chunks = editorWordWrapLine(line, 6);
  assert.equal(chunks[4]?.startIndex, cursorColumn);
  assert.equal(editorWordWrapLine(line.slice(0, cursorColumn), 6).length, 4,
    "wrapping the cursor prefix does not identify its full-line visual chunk");
  fixture.component.handleInput(`\x1b[200~${line}\x1b[201~`);
  for (let index = cursorColumn; index < line.length; index += 1) fixture.component.handleInput(LEFT);
  fixture.field!.completionItems = Array.from({ length: 8 }, (_, index) => `suggestion ${index + 1}`);
  fixture.component.handleInput(TAB);

  const frame = fixture.component.render(9); // Native Editor width seven; layout width six.
  assert.deepEqual(fixture.field!.getCursor(), { line: 0, col: cursorColumn });
  assert.equal(fixture.field!.getRenderedHiddenLineCount(), 0);
  assert.equal(fixture.field!.isShowingAutocomplete(), true);
  assert.ok(frame.length <= 3);
  assert.ok(frame.some((row) => row.includes("epsilo") && row.includes("\x1b_pi:c\x07")),
    "the cursor at the word-wrap boundary remains visible despite an oversized completion list");
});

test("Ctrl+C clears the field draft and never cancels", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  for (const char of "some text") fixture.component.handleInput(char);
  fixture.component.handleInput(CTRL_C); // the default binding is both cancel and clear
  assert.equal(fixture.done.length, 0, "Ctrl+C does not close the list");
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /\[field:\]/, `the draft was cleared: ${text}`);
  assert.match(text, /Enter submit · Esc back to options/, "still editing after the clear");
  for (const char of "again") fixture.component.handleInput(char);
  fixture.component.handleInput(ENTER); // submit what remains
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": again$/);
});

test("Esc dismisses a visible completion list first, then returns to the rows", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  for (const char of "docs/") fixture.component.handleInput(char);
  fixture.component.handleInput(TAB); // open the completion list
  assert.equal(fixture.field!.isShowingAutocomplete(), true, "the list is visible");
  fixture.component.handleInput(ESCAPE); // first Esc: dismiss the list only
  assert.equal(fixture.field!.isShowingAutocomplete(), false, "the list was dismissed");
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /\[field:docs\//, `still editing with the draft kept: ${text}`);
  fixture.component.handleInput(ESCAPE); // second Esc: back to the option rows
  const rows = fixture.component.render(80).join("\n");
  assert.match(rows, /> Type something…/, "back on the option rows");
  assert.equal(fixture.field!.getText(), "docs/", "the draft survived both presses");
});

test("bracketed paste inserts its payload without escape-marker residue", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  // The host forwards bracketed-paste sequences verbatim to the focused component.
  fixture.component.handleInput("\x1b[200~pasted answer\x1b[201~");
  fixture.component.handleInput(ENTER); // submit
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": pasted answer$/);
  assert.ok(!/200~|201~/.test(fixture.sent[0]!.message), "no paste markers reach the model");
});

test("the native field keeps and submits drafts beyond 4000 characters without data loss", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  // A large bracketed paste (5000 chars) is inserted in full — no UI-side cap.
  fixture.component.handleInput(`\x1b[200~${"p".repeat(5000)}\x1b[201~`);
  fixture.component.handleInput(BACKSPACE); // remains editable: drop the last char
  fixture.component.handleInput("z");
  fixture.component.handleInput(ENTER); // submit
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.ok(
    fixture.sent[0]!.message.endsWith("p".repeat(4999) + "z"),
    "every character beyond 4000 reached the model",
  );
});

test("an unavailable native field renders an unavailable row; confirming it is a no-op", async () => {
  const fixture = makeFixture({ field: false });
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  const text = fixture.component.render(80).join("\n");
  const flat = text.replace(/\n\s*/g, " ");
  assert.match(flat, /Free text unavailable/, "the free-text row names the unavailable native editor");
  assert.match(flat, /choices and\s+Decline still work/);
  fixture.component.handleInput(DOWN); // Type something… (unavailable)
  fixture.component.handleInput(ENTER); // confirming it is a no-op
  const still = fixture.component.render(80).join("\n");
  assert.match(still, /Free text unavailable/, "editing was never entered");
  fixture.component.handleInput(UP); // back to the choice
  fixture.component.handleInput(ENTER); // choices keep working
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": SQLite$/);
});

test("unrecognized terminal sequences never insert printable tails into the draft", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  for (const char of "yes") fixture.component.handleInput(char);
  const unknown = [
    "\x1b[A", // Up
    "\x1b[B", // Down
    "\x1b[H", // Home
    "\x1b[1~", // Home (numeric)
    "\x1b[F", // End
    "\x1b[4~", // End (numeric)
    "\x1b[3~", // Delete
    PAGE_UP, // PageUp
    PAGE_DOWN, // PageDown
    CTRL_ALT_PAGE_UP,
    CTRL_ALT_PAGE_DOWN,
    SHIFT_ALT_UP,
    SHIFT_ALT_DOWN,
    "\x1b[1;2A", // unrecognized modifier chord (Ctrl+Up)
  ];
  for (const sequence of unknown) fixture.component.handleInput(sequence);
  const rendered = fixture.component.render(80).join("\n");
  assert.match(rendered, /\[field:yes\]/, "the draft is unchanged by unknown sequences");
  assert.ok([CTRL_ALT_PAGE_UP, CTRL_ALT_PAGE_DOWN, SHIFT_ALT_UP, SHIFT_ALT_DOWN]
    .every((sequence) => fixture.field!.inputLog.includes(sequence)),
  "all popup scroll alternatives remain owned by the native field while editing");
  assert.ok(!/\[A|\[B|\[H|\[F|\[1~|\[4~|\[3~|\[5~|\[6~|;2A/.test(rendered), "no printable tails reach the draft");
  // Ordinary text and bracketed paste remain usable after rejected sequences.
  fixture.component.handleInput(" ");
  fixture.component.handleInput("\x1b[200~and no\x1b[201~");
  fixture.component.handleInput(ENTER); // submit
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": yes and no$/);
});

for (const rawChoice of ["__type__", "__decline__"]) {
  test(`choice ${rawChoice} cannot collide with an internal answer action`, async () => {
    const fixture = makeFixture();
    register(fixture, "Which literal value?", { choices: [rawChoice], mode: "async" });
    fixture.component.handleInput(ENTER);
    const rendered = fixture.component.render(80).join("\n");
    assert.ok(rendered.includes(`1. ${rawChoice}`), "the original choice is displayed as a choice");
    assert.ok(rendered.includes("Type something…"), "the separate free-text action remains available");
    assert.ok(rendered.includes("Decline (no answer will be sent)"), "the separate decline action remains available");
    fixture.component.handleInput(ENTER);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.sent[0]!.message, `Answer to pending question "Which literal value?": ${rawChoice}`);
    assert.equal(fixture.controller.listPending().length, 0, "only the submitted question resolves");
    assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }],
      "the choice neither opens editing nor declines");
  });
}

test("choice labels escape terminal controls for display but submit the original raw value", async () => {
  const fixture = makeFixture();
  const rawChoice = "**Canary** \u001b[2J lane\\label";
  register(fixture, "Which release lane?", { choices: [rawChoice], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  const rendered = fixture.component.render(80).join("\n");
  assert.ok(!rendered.includes("\u001b"), "hostile choice ESC never reaches the terminal output");
  assert.ok(rendered.includes(`1. ${visibleTerminalText(rawChoice)}`), "the plain label is reversibly escaped without Markdown parsing");
  assert.ok(rendered.includes("**Canary**"), "choice Markdown-like punctuation remains ordinary plain text");
  assert.ok(!rendered.includes(rawChoice), "the raw hostile label is not rendered");

  fixture.component.handleInput(ENTER); // choose the selected raw label
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0]!.message, `Answer to pending question "Which release lane?": ${rawChoice}`,
    "display escaping never rewrites the stored choice or the selected answer sent to the model");
});

test("the shortcut chord collapses from free-text editing without submitting", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  for (const char of "partial") fixture.component.handleInput(char);
  fixture.component.handleInput(CHORD); // approved collapse chord
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
  assert.equal(fixture.controller.listPending().length, 1, "the question stays pending");
  assert.equal(fixture.sent.length, 0, "no answer was submitted");
});

test("decline is an explicit two-step action with no second confirmation", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(DOWN); // Decline row
  const before = fixture.component.render(80).join("\n");
  assert.match(before, /> Decline/, "Decline row selected");
  fixture.component.handleInput(ENTER); // confirm decline
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "declined", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 0, "an async decline sends nothing to the model");
});

test("Escape never declines: it backs out of the answer view and then closes the list", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ESCAPE); // back to list — still pending
  assert.equal(fixture.controller.listPending().length, 1);
  assert.equal(fixture.done.length, 0);
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /Pending questions \(1\)/);
  fixture.component.handleInput(ESCAPE); // close the list (defer)
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
  assert.equal(fixture.controller.listPending().length, 1, "deferring keeps the question pending");
});

test("the shortcut chord closes the list from both modes", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // answer view
  fixture.component.handleInput(CHORD);
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
  assert.equal(fixture.controller.listPending().length, 1);

  const second = makeFixture();
  register(second, "Which database?", { choices: ["SQLite"], mode: "async" });
  second.component.handleInput(CHORD); // list mode
  assert.deepEqual(second.done, [{ kind: "closed" }]);

  const conflicting = makeFixture({
    keybindings: makeKeybindings({ "tui.editor.pageUp": [CHORD] }),
  });
  register(conflicting, "Which database?", { choices: ["SQLite"], mode: "async" });
  conflicting.component.handleInput(CHORD);
  assert.deepEqual(conflicting.done, [{ kind: "closed" }],
    "the reserved open/close chord takes precedence over an overlapping page-up binding");
});

test("a question registered while the list is open appears without re-opening", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  assert.ok(!fixture.component.render(80).join("\n").includes("q2"));
  register(fixture, "Include raw counts?");
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /Pending questions \(2\)/);
  assert.match(text, /q2: Include raw counts\?/);
});

test("resolving one of several questions keeps the list open on a live selection", () => {
  const fixture = makeFixture();
  register(fixture, "First question?", { choices: ["a"], mode: "async" });
  register(fixture, "Second question?", { choices: ["b"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view for q1
  fixture.component.handleInput(ESCAPE); // back to list (q1 selected)
  fixture.component.handleInput(DOWN); // select q2
  fixture.component.handleInput(UP); // back to q1
  fixture.component.handleInput(ENTER); // open q1's answer view
  fixture.component.handleInput(ENTER); // confirm choice "a"
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /Pending questions \(1\)/);
  assert.match(text, /> q2: Second question\?/, "selection falls back to a live question");
  assert.equal(fixture.done.length, 0, "the list stays open while questions remain");
});

test("stale submissions close the UI without touching the model", async () => {
  const fixture = makeFixture();
  const id = register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // answer view
  // Simulate a session replacement while the list is open.
  fixture.controller.beginSession({ sessionManager: "OTHER" });
  fixture.component.handleInput(ENTER); // confirm on stale state
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 0);
  assert.ok(!fixture.controller.get(id), "the stale question is gone");
});

test("rendering is width-aware and degrades without host helpers", () => {
  const fixture = makeFixture();
  register(fixture, "A very long question that should wrap across multiple lines because it exceeds the available width of this narrow terminal pane indeed");
  const wide = fixture.component.render(100).join("\n");
  assert.ok(wide.split("\n").length > 3);
  const narrow = fixture.component.render(24).join("\n");
  for (const line of narrow) {
    assert.ok(line.replace(/\x1b\[[0-9;]*m/g, "").length <= 24 + 2, `line too wide: ${JSON.stringify(line)}`);
  }

  // Degraded: no tui host at all (naive width handling).
  const controller = new UserQuestionController({ pi: {}, uiAvailable: () => true });
  const identity = { sessionManager: "UI" };
  controller.beginSession(identity);
  const done: unknown[] = [];
  const component = createQuestionListComponent({
    controller,
    keybindings: makeKeybindings(),
    theme: THEME,
    shortcutLabel: "Ctrl+Alt+Up",
    onDone: (result) => done.push(result),
  });
  const registered = controller.register({ toolCallId: "t1", question: "short?", mode: "async" }, identity);
  assert.ok(registered.ok);
  const lines = component.render(40);
  assert.match(lines.join("\n"), /Pending questions \(1\)/);
  component.handleInput(ESCAPE);
  assert.deepEqual(done, [{ kind: "closed" }]);
});
