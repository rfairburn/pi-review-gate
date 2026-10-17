import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { UserQuestionController } from "../src/user-question/controller";
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import type { QuestionSelectionCopy, QuestionUiTheme } from "../src/user-question/components";
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
const CTRL_X = "\x18";
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
const compositeTuiLine = (createRequire(__filename)("pi-session-host-tui/dist/tui.js") as {
  compositeTuiLine: (baseLine: string, overlayLine: string, startCol: number, overlayWidth: number, totalWidth: number) => string;
}).compositeTuiLine;

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
    const layoutWidth = Math.max(1, width - 1); // The native Editor reserves one cursor cell with zero padding.
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
      const prefix = visualLine.logicalLine === 0 && visualLine.chunk.startIndex === 0 ? "[field:" : "";
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
  const visibleWidth = (text: string): number => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:c\x07/g, "").length;
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
  isStale?: () => boolean;
  keybindings?: ReturnType<typeof makeKeybindings>;
  theme?: QuestionUiTheme;
  tuiHost?: ReturnType<typeof makeTuiHost>;
  getTerminalSize?: () => { columns: number; rows: number } | undefined;
  selectionCopy?: QuestionSelectionCopy;
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
    theme: options.theme ?? THEME,
    tuiHost: options.tuiHost ?? makeTuiHost(),
    shortcutLabel: "Ctrl+Alt+Up",
    nativeField: field,
    getViewportRows: options.getViewportRows,
    isStale: options.isStale,
    getTerminalSize: options.getTerminalSize,
    selectionCopy: options.selectionCopy,
    onDone: (result) => done.push(result),
  });
  return { controller, identity, sent, done, component, field };
}

test("all shared-popup rows fill the viewport opaquely in list, answer, notice, and resized views", () => {
  const backgroundStart = "\x1b[48;5;236m";
  const backgroundEnd = "\x1b[49m";
  const theme: QuestionUiTheme = {
    fg: (_color, text) => `\x1b[38;5;203m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    bg: (color, text) => {
      assert.equal(color, "customMessageBg", "the shared popup uses Pi's native message surface token");
      return `${backgroundStart}${text}${backgroundEnd}`;
    },
  };
  const fixture = makeFixture({ theme, getViewportRows: () => 20 });
  register(fixture, "Which database?", { choices: ["SQLite"] });
  registerNotice(fixture, "# Notice body\nA retained detail row.");

  const assertOpaqueFullWidth = (rows: string[], width: number, view: string): void => {
    assert.ok(rows.length > 0, `${view} renders popup rows`);
    for (const [index, row] of rows.entries()) {
      assert.equal(makeTuiHost().visibleWidth(row), width, `${view} row ${index} fills the current viewport width`);
      assert.ok(row.startsWith(backgroundStart), `${view} row ${index} starts with the opaque surface background`);
      const resetParts = row.split(/\x1b\[0?m/);
      for (const tail of resetParts.slice(1)) {
        assert.ok(tail.length === 0 || tail.startsWith(backgroundStart),
          `${view} row ${index} reapplies the opaque background after nested full resets`);
      }

      const leftUnderlay = "CHAT_LEFT_UNDERLAY";
      const rightUnderlay = "CHAT_RIGHT_UNDERLAY";
      const underlay = `${leftUnderlay}${".".repeat(Math.max(0, width - leftUnderlay.length - rightUnderlay.length))}${rightUnderlay}`;
      const composed = compositeTuiLine(underlay, row, 0, width, width)
        .replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(composed.includes(leftUnderlay) || composed.includes(rightUnderlay), false,
        `${view} row ${index} removes both left and right underlying conversation margins`);
    }
  };

  assertOpaqueFullWidth(fixture.component.render(72), 72, "pending list");
  fixture.component.handleInput(ENTER);
  assertOpaqueFullWidth(fixture.component.render(72), 72, "question answer");
  fixture.component.handleInput(ESCAPE);
  fixture.component.handleInput(DOWN);
  fixture.component.handleInput(ENTER);
  assertOpaqueFullWidth(fixture.component.render(72), 72, "notice details");
  assertOpaqueFullWidth(fixture.component.render(43), 43, "resized notice details");
});

function register(fixture: Fixture, question: string, options: { choices?: string[]; mode?: "async" | "sync" } = {}) {
  const result = fixture.controller.register(
    { toolCallId: `t${fixture.controller.listPending().length + 1}`, question, choices: options.choices, mode: options.mode ?? "async" },
    fixture.identity,
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("registration failed");
  return result.question.id;
}

function registerNotice(fixture: Fixture, body: string, context?: string): string {
  const result = fixture.controller.registerNotice({
    toolCallId: `notice${fixture.controller.listPending().length + 1}`,
    title: "Scroll regression notice",
    body,
    ...(context === undefined ? {} : { context }),
  }, fixture.identity);
  assert.ok(result.ok);
  if (!result.ok) throw new Error("notice registration failed");
  return result.notice.id;
}

test("explicit copy: the configured copy key consumes only a live host selection and mirrors Pi's own policy", async () => {
  const copies: string[] = [];
  let copyOnSelect = false;
  let activeSelection = true;
  let rejectSeam = false;
  const selectionCopy: QuestionSelectionCopy = {
    copyOnSelect: () => copyOnSelect,
    hasActiveSelection: () => activeSelection,
    async copyActiveSelection() {
      copies.push("copy");
      if (rejectSeam) throw new Error("clipboard unavailable");
      return true;
    },
  };
  const fixture = makeFixture({
    keybindings: makeKeybindings({ "app.message.copy": [CTRL_X] }),
    selectionCopy,
  });
  register(fixture, "Copy me?", { choices: ["yes"] });
  fixture.component.handleInput(ENTER); // open the answer view
  fixture.component.handleInput(DOWN); // select the Type row
  fixture.component.handleInput(ENTER); // enter native editing
  const field = fixture.field!;
  assert.equal(field.focused, true, "editing began on the native field");

  // A live selection with copy-on-select off: the popup consumes the key and
  // copies once through the injected host surface; the field never sees it.
  fixture.component.handleInput(CTRL_X);
  assert.deepEqual(copies, ["copy"], "the configured copy key copied exactly once");
  assert.ok(!field.inputLog.includes(CTRL_X), "a consumed copy key never reaches the native field");

  // Any other key keeps its existing editing behavior.
  field.inputLog.length = 0;
  fixture.component.handleInput("a");
  assert.deepEqual(copies, ["copy"], "an ordinary key is not a copy");
  assert.ok(field.inputLog.includes("a"), "and still reaches the native field");

  // No active selection: not ours to consume; the field keeps the key.
  activeSelection = false;
  field.inputLog.length = 0;
  fixture.component.handleInput(CTRL_X);
  assert.deepEqual(copies, ["copy"], "no selection: nothing copied");
  assert.ok(field.inputLog.includes(CTRL_X), "with no selection the key keeps its existing editor behavior");

  // Copy-on-select on: Pi already copied on release; the popup adds nothing.
  copyOnSelect = true;
  activeSelection = true;
  field.inputLog.length = 0;
  fixture.component.handleInput(CTRL_X);
  assert.deepEqual(copies, ["copy"], "copy-on-select on: the popup adds no second copy");
  assert.ok(field.inputLog.includes(CTRL_X), "and does not consume the key");

  // A rejected host clipboard seam is swallowed (no unhandled rejection) while
  // the live selection still owns the key.
  copyOnSelect = false;
  rejectSeam = true;
  field.inputLog.length = 0;
  fixture.component.handleInput(CTRL_X);
  assert.deepEqual(copies, ["copy", "copy"], "the host seam was invoked once more for the live selection");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(!field.inputLog.includes(CTRL_X), "the live selection still consumes the key");

  // Without the injected host surface the key is never consumed or copied.
  const plain = makeFixture({ keybindings: makeKeybindings({ "app.message.copy": [CTRL_X] }) });
  register(plain, "No host surface?", { choices: ["yes"] });
  plain.component.handleInput(ENTER);
  plain.component.handleInput(DOWN);
  plain.component.handleInput(ENTER);
  plain.field!.inputLog.length = 0;
  plain.component.handleInput(CTRL_X);
  assert.ok(plain.field!.inputLog.includes(CTRL_X), "without a host surface the key keeps its existing behavior");
  assert.equal(plain.done.length, 0, "and never closes the popup");
});

test("the list renders pending questions with the shortcut hint and waiting tags", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite", "Postgres"], mode: "sync" });
  register(fixture, "Include raw counts?");
  const lines = fixture.component.render(80);
  const text = lines.join("\n");
  assert.match(text, /Pending input \(2\)/);
  assert.match(text, /Ctrl\+Alt\+Up to close/);
  assert.match(text, /q1: Which database\? \[waiting\]/);
  assert.match(text, /q2: Include raw counts\?/);
  assert.ok(!/\[waiting\]/.test(lines.find((line) => line.includes("q2")) ?? ""), "async questions are not waiting");
});

test("the shared question popup has full-width top and bottom rules with padded, side-border-free rows", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?");
  const lines = fixture.component.render(36);
  const header = lines.findIndex((line) => line.includes("Pending input (1)"));

  assert.ok(header > 1, `header follows the top rule and vertical padding: ${lines.join("\n")}`);
  assert.equal(lines[0], "─".repeat(36), "the top rule spans the full popup width");
  assert.equal(lines.at(-1), "─".repeat(36), "the bottom rule spans the full popup width");
  assert.match(lines[header]!, /^ Pending input \(1\)/, "content starts after exactly one padding cell");
  assert.equal(lines[header - 1], " ".repeat(36), "the header has a blank row of vertical padding above it");
  assert.equal(lines.at(-2), " ".repeat(36), "the content has a blank row of vertical padding below it");
  for (const line of lines.slice(1, -1)) {
    assert.equal(line.length, 36, `every content row fills the popup width: ${JSON.stringify(line)}`);
    assert.equal(line[0], " ", `the left column is padding, not a side border: ${JSON.stringify(line)}`);
    assert.equal(line.at(-1), " ", `the right column is padding, not a side border: ${JSON.stringify(line)}`);
  }
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
    const contentRows = (lines: readonly string[]): readonly string[] => lines.slice(2, -2);
    const beforeContent = contentRows(before);
    const afterContent = contentRows(after);
    assert.equal(afterContent.length, beforeContent.length, "the rules and padding keep a stable viewport budget");
    const overlap = afterContent.filter((line) => beforeContent.includes(line));
    assert.ok(overlap.length > 0, "each popup-local page retains visible content overlap");
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
  let sentinelSeen = frame.some((line) => line.includes("DISTANT_NOTICE_SCROLL_SENTINEL"));
  let closeSeen = frame.some((line) => line.includes("Close"));
  for (let page = 0; page < 100 && !(sentinelSeen && closeSeen); page += 1) {
    frame = assertOneLineOverlap(frame, page % 2 === 0 ? CTRL_ALT_PAGE_DOWN : SHIFT_ALT_DOWN);
    record(frame);
    sentinelSeen ||= frame.some((line) => line.includes("DISTANT_NOTICE_SCROLL_SENTINEL"));
    closeSeen ||= frame.some((line) => line.includes("Close"));
  }
  const observed = [...observedLines].join("\n");
  assert.ok(sentinelSeen && observed.includes("DISTANT_NOTICE_SCROLL_SENTINEL"), "the distant body sentinel is reachable");
  assert.ok(observed.includes("More details") && closeSeen, "both notice actions remain reachable after the complete body");
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
  rows = 5; // Border and vertical padding leave one content row at this height.
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
  const viewportRows = 11;
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
  // #413: a long question opens at its beginning instead of jumping to the
  // first choice; the next Up/Down reveals the selected row.
  assert.match(frame[2] ?? "", /^ q1:/,
    "opening the answer view starts at the beginning of the long question");
  assert.doesNotMatch(frame.join("\n"), /> 1\. Keep the current release lane/,
    "opening does not auto-jump past the question to the first choice");

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
  let viewportRows = 7;
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

  viewportRows = 5;
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

  // The outer width 11 leaves nine cells inside the one-cell side padding, two
  // of which indent the native editor; its public layout wraps at six cells.
  const frame = fixture.component.render(11);
  assert.equal(fixture.field!.getRenderedHiddenLineCount(), 13,
    "the five-row native viewport clips thirteen visual rows above the cursor after padding-aware wrapping");
  assert.ok(frame.length <= 3);
  assert.ok(frame.some((row) => row.includes("b") && row.includes("\x1b_pi:c\x07")),
    `the cursor-bearing row after preserved whitespace wraps remains visible: frame=${frame.join("\n")} field=${fixture.field!.render(8).join("\n")}`);
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

  const frame = fixture.component.render(11); // Side padding leaves editor width seven; layout width six.
  assert.deepEqual(fixture.field!.getCursor(), { line: 0, col: cursorColumn });
  assert.equal(fixture.field!.getRenderedHiddenLineCount(), 0);
  assert.equal(fixture.field!.isShowingAutocomplete(), true);
  assert.ok(frame.length <= 3);
  assert.ok(frame.some((row) => row.includes("epsilo") && row.includes("\x1b_pi:c\x07")),
    `the cursor at the word-wrap boundary remains visible despite an oversized completion list: frame=${frame.join("\n")} field=${fixture.field!.render(7).join("\n")} cursor=${JSON.stringify(fixture.field!.getCursor())} hidden=${fixture.field!.getRenderedHiddenLineCount()}`);
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
  assert.match(text, /Pending input \(1\)/);
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
  assert.match(text, /Pending input \(2\)/);
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
  assert.match(text, /Pending input \(1\)/);
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
  assert.match(lines.join("\n"), /Pending input \(1\)/);
  component.handleInput(ESCAPE);
  assert.deepEqual(done, [{ kind: "closed" }]);
});

// ---------------------------------------------------------------------------
// Shared viewport: fixed hints, initial position, selection reveal (#413)
// ---------------------------------------------------------------------------

const NOTICE_KEY_HINT = "arrows select · Enter choose · Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll · Esc back";
const ANSWER_KEY_HINT = "arrows select · Enter confirm · Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll · Esc back";
const SCROLL_KEY_HINT = "Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll";

/** Rows between the frame's full-width rules, minus one side-padding cell, right-trimmed. */
function frameInterior(frame: readonly string[]): string[] {
  const top = frame.findIndex((line) => /^─+$/u.test(line));
  const bottom = frame.length - 1 - [...frame].reverse().findIndex((line) => /^─+$/u.test(line));
  assert.ok(top >= 0 && bottom > top, `the frame has top and bottom rules: ${frame.join("\n")}`);
  return frame.slice(top + 1, bottom).map((line) => line.slice(1).replace(/ +$/u, ""));
}

/**
 * Split interior rows into the scrolled body and the fixed trailing hint rows.
 * Frames from viewports of at least six rows keep one blank padding row at the
 * top and bottom; the blank separator appears only before the complete hint.
 */
function splitFixedHint(interior: readonly string[], hint: string, viewportRows: number): { body: string[]; hint: string[] } {
  const padded = viewportRows >= 6;
  const rows = padded ? interior.slice(1, -1) : [...interior];
  let hintStart = rows.length;
  while (hintStart > 0 && rows[hintStart - 1]!.trim().length > 0
    && (hint.includes(rows[hintStart - 1]!.trim()) || rows[hintStart - 1]!.endsWith("…"))) hintStart -= 1;
  const hintRows = rows.slice(hintStart);
  const complete = hintRows.join(" ").replace(/\s+/gu, " ") === hint;
  const bodyEnd = complete && hintStart > 0 && rows[hintStart - 1]!.trim().length === 0 ? hintStart - 1 : hintStart;
  return { body: rows.slice(0, bodyEnd), hint: hintRows };
}

function longNoticeBody(rows: number): string {
  return Array.from({ length: rows }, (_, index) => `Body row ${String(index + 1).padStart(2, "0")}`).join("\n");
}

test("the shared popup keeps its keyboard hint fixed while body, context, and actions scroll together", () => {
  const rows = 12;
  const fixture = makeFixture({ getViewportRows: () => rows });
  registerNotice(fixture, longNoticeBody(24), "Context opening row\nCONTEXT-END");
  fixture.component.handleInput(ENTER);

  const frames: string[][] = [];
  let frame = fixture.component.render(60);
  const opening = splitFixedHint(frameInterior(frame), NOTICE_KEY_HINT, rows);
  assert.equal(opening.body[0], "n1: Scroll regression notice", "a long notice opens at its beginning");
  assert.ok(!opening.body.some((line) => line.includes("More details")), "actions are body content, not a fixed control area");
  frames.push(frame);
  const assertFixedHint = (lines: readonly string[], view: string): void => {
    assert.equal(lines.length, rows, `${view} keeps the exact bounded frame height`);
    const parts = splitFixedHint(frameInterior(lines), NOTICE_KEY_HINT, rows);
    assert.equal(parts.hint.join(" ").replace(/\s+/gu, " "), NOTICE_KEY_HINT, `${view} shows the complete fixed hint`);
    assert.equal(parts.body.length, opening.body.length, `${view} keeps a stable scrolled body height`);
  };
  assertFixedHint(frame, "beginning");

  let middleSeen = false;
  for (let page = 0; page < 80 && !frame.some((line) => line.includes("Close")); page += 1) {
    fixture.component.handleInput(SHIFT_ALT_DOWN);
    const next = fixture.component.render(60);
    const before = splitFixedHint(frameInterior(frame), NOTICE_KEY_HINT, rows).body;
    const after = splitFixedHint(frameInterior(next), NOTICE_KEY_HINT, rows).body;
    assert.deepEqual(after.slice(0, -1), before.slice(1), "each keyboard step moves the scrolled body by exactly one line");
    frame = next;
    frames.push(frame);
    assertFixedHint(frame, `page ${page + 1}`);
    if (!frame.some((line) => line.includes("n1:")) && !frame.some((line) => line.includes("More details"))) middleSeen = true;
  }
  assert.ok(middleSeen, "a middle page shows neither the title nor the actions");
  const reached = new Set(frames.flatMap((lines) => splitFixedHint(frameInterior(lines), NOTICE_KEY_HINT, rows).body));
  for (let row = 1; row <= 24; row += 1) assert.ok(reached.has(`Body row ${String(row).padStart(2, "0")}`), `body row ${row} is reachable`);
  assert.ok(reached.has("Context opening row") && reached.has("CONTEXT-END"), "the complete context is reachable");
  assert.ok(reached.has("> More details") && reached.has("  Close"), "both actions scroll into view after the context");

  const end = fixture.component.render(60).join("\n");
  fixture.component.handleInput(CTRL_ALT_PAGE_DOWN);
  assert.equal(fixture.component.render(60).join("\n"), end, "paging is bounded at the end");
  for (let page = 0; page < 80; page += 1) fixture.component.handleInput(SHIFT_ALT_UP);
  assert.deepEqual(fixture.component.render(60), frames[0], "paging back returns to the exact opening frame");
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.controller.listPending().length, 1, "scrolling leaves the notice pending");
});

test("a long question opens at its beginning; Up/Down reveal the selection even at a boundary", async () => {
  const rows = 10;
  const fixture = makeFixture({ getViewportRows: () => rows });
  register(fixture, Array.from({ length: 20 }, (_, index) => `Question paragraph ${index + 1}.`).join("\n\n"), {
    choices: ["Alpha", "Beta", "Gamma"],
  });
  fixture.component.handleInput(ENTER);
  let body = splitFixedHint(frameInterior(fixture.component.render(60)), ANSWER_KEY_HINT, rows).body;
  assert.equal(body[0], "q1:", "the answer view opens at the beginning of the question");
  assert.ok(!body.some((line) => line.startsWith("> ")), "opening does not jump to the selected choice");

  fixture.component.handleInput(UP); // boundary: the selection cannot move up
  body = splitFixedHint(frameInterior(fixture.component.render(60)), ANSWER_KEY_HINT, rows).body;
  assert.ok(body.includes("> 1. Alpha"), "Up at the first choice still reveals it");
  for (let page = 0; page < 100; page += 1) fixture.component.handleInput(SHIFT_ALT_UP);
  body = splitFixedHint(frameInterior(fixture.component.render(60)), ANSWER_KEY_HINT, rows).body;
  assert.equal(body[0], "q1:", "keyboard paging returns to the beginning without moving the selection");
  fixture.component.handleInput(DOWN);
  body = splitFixedHint(frameInterior(fixture.component.render(60)), ANSWER_KEY_HINT, rows).body;
  assert.ok(body.includes("> 2. Beta"), "Down reveals the newly selected choice");
  fixture.component.handleInput(DOWN);
  fixture.component.handleInput(DOWN);
  fixture.component.handleInput(DOWN);
  fixture.component.handleInput(DOWN); // boundary: Decline is last
  body = splitFixedHint(frameInterior(fixture.component.render(60)), ANSWER_KEY_HINT, rows).body;
  assert.ok(body.includes("> Decline (no answer will be sent)"), "Down at the last row reveals Decline");
  fixture.component.handleInput(UP);
  fixture.component.handleInput(UP);
  fixture.component.handleInput(ENTER); // choose Gamma
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.sent.length, 1, "choice semantics are unchanged");
  assert.match(fixture.sent[0]!.message, /Gamma/);
});

test("notice actions are revealed by Up/Down and keep their semantics", () => {
  const rows = 10;
  const fixture = makeFixture({ getViewportRows: () => rows });
  registerNotice(fixture, longNoticeBody(30));
  register(fixture, "Still pending?");
  fixture.component.handleInput(ENTER);
  fixture.component.handleInput(DOWN); // select Close
  let body = splitFixedHint(frameInterior(fixture.component.render(60)), NOTICE_KEY_HINT, rows).body;
  assert.ok(body.includes("> Close"), "Down reveals the Close action from the beginning of a long notice");
  for (let page = 0; page < 100; page += 1) fixture.component.handleInput(SHIFT_ALT_UP);
  fixture.component.handleInput(UP); // More details
  body = splitFixedHint(frameInterior(fixture.component.render(60)), NOTICE_KEY_HINT, rows).body;
  assert.ok(body.includes("> More details"), "Up reveals More details");
  fixture.component.handleInput(DOWN);
  fixture.component.handleInput(ENTER); // Close only this notice
  assert.deepEqual(fixture.controller.listPending().map((entry) => entry.id), ["q1"]);
  assert.equal(fixture.sent.length, 0, "Close sends nothing");
});

test("popup scrolling is keyboard-only: wheel input is never handled, so Pi keeps native wheel behavior", () => {
  const fixture = makeFixture({ getViewportRows: () => 12 });
  registerNotice(fixture, longNoticeBody(30));
  fixture.component.handleInput(ENTER);
  fixture.component.handleInput(SHIFT_ALT_DOWN);
  const before = fixture.component.render(60);
  // Fullscreen item clicks (#431) add a mouse handler, but it declines every
  // wheel event: pi-tui then applies its own unhandled-wheel behavior, and
  // the popup's single scroll offset never moves by wheel.
  assert.equal(typeof fixture.component.handleMouse, "function");
  for (const [y] of before.entries()) {
    for (const wheelDelta of [-3, -1, 1, 3]) {
      const event = { type: "wheel", button: "none", x: 4, y, width: 60, height: before.length, wheelDelta } as Parameters<typeof fixture.component.handleMouse>[0];
      assert.equal(fixture.component.handleMouse(event), undefined, `row ${y}: wheel ${wheelDelta} is left to the host`);
    }
  }
  assert.deepEqual(fixture.component.render(60), before, "wheel input never scrolls or changes the popup");
  assert.doesNotMatch(before.join("\n"), /wheel|mouse|click/iu, "no view advertises mouse behavior");
});

test("keyboard scrolling while editing stays with the native field; the next editing input re-reveals the cursor", async () => {
  const fixture = makeFixture({ getViewportRows: () => 12 });
  register(fixture, Array.from({ length: 12 }, (_, index) => `Detail ${index + 1}.`).join("\n\n"), { choices: ["Canary"] });
  fixture.component.handleInput(ENTER);
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // editing
  fixture.component.handleInput("draft");
  let frame = fixture.component.render(60);
  assert.ok(frame.length <= 12, "the editing popup stays within its bounded frame");
  assert.ok(frame.some((line) => line.includes("[field:draft]") && line.includes("\x1b_pi:c\x07")), "the cursor row is visible");
  assert.ok(frame.join(" ").replace(/\s+/gu, " ").includes("Enter submit · Esc back to options to scroll"),
    "the editing hint names the Esc exception for the scroll keys");

  // While editing, the popup scroll keys belong to the native field.
  fixture.component.handleInput(SHIFT_ALT_UP);
  frame = fixture.component.render(60);
  assert.ok(fixture.field!.inputLog.includes(SHIFT_ALT_UP), "the scroll key reaches the native field while editing");
  assert.ok(frame.some((line) => line.includes("[field:draft]")), "the viewport keeps the editing cursor in view");

  // After Esc the scroll keys page the shared viewport without touching the draft.
  fixture.component.handleInput(ESCAPE);
  for (let page = 0; page < 100; page += 1) fixture.component.handleInput(SHIFT_ALT_UP);
  frame = fixture.component.render(60);
  assert.ok(frame.some((line) => line.trim() === "q1:"), "keyboard paging returns to the question beginning");
  assert.ok(!frame.some((line) => line.includes("[field:")), "rendering does not snap back to the field");
  assert.equal(fixture.field!.getText(), "draft", "paging never edits the draft");
  assert.equal(fixture.sent.length, 0, "paging never submits");

  fixture.component.handleInput(ENTER); // Type something… is still selected: edit again
  fixture.component.handleInput("!");
  frame = fixture.component.render(60);
  assert.ok(frame.some((line) => line.includes("[field:draft!]") && line.includes("\x1b_pi:c\x07")),
    "the next editing input brings the cursor row back into view");
  fixture.component.handleInput(ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.sent.length, 1, "free-text submission semantics are unchanged");
  assert.match(fixture.sent[0]!.message, /draft!/);
});

test("regular-mode editing hints explain that keyboard scrolling resumes after Esc", () => {
  const fixture = makeFixture({ getViewportRows: () => 20 });
  register(fixture, "Which lane?", { choices: ["Canary"] });
  fixture.component.handleInput(ENTER);
  fixture.component.handleInput(DOWN);
  fixture.component.handleInput(ENTER);
  const text = fixture.component.render(60).join("\n");
  assert.match(text, /Enter submit · Esc back to options to scroll/);
  assert.doesNotMatch(text, /wheel|mouse/iu, "the popup advertises no mouse behavior");
});

test("resize keeps the authoritative offset within its new bounds and all wrapped content reachable", () => {
  let rows = 14;
  let width = 60;
  const fixture = makeFixture({ getViewportRows: () => rows });
  const words = Array.from({ length: 60 }, (_, index) => `word${String(index + 1).padStart(2, "0")}`).join(" ");
  registerNotice(fixture, `${longNoticeBody(20)}\n${words}\nWRAPPED-END`);
  fixture.component.handleInput(ENTER);
  const bodyOf = (lines: readonly string[]) => splitFixedHint(frameInterior(lines), NOTICE_KEY_HINT, rows).body;
  const openingBody = bodyOf(fixture.component.render(width));
  for (let step = 0; step < 6; step += 1) fixture.component.handleInput(SHIFT_ALT_DOWN);
  const scrolledFirst = bodyOf(fixture.component.render(width))[0];
  assert.equal(scrolledFirst, openingBody[6], "six keyboard steps moved six lines");

  rows = 11;
  assert.equal(bodyOf(fixture.component.render(width))[0], scrolledFirst, "a shorter viewport keeps the same offset");
  rows = 200;
  const tall = fixture.component.render(width);
  assert.ok(tall.length < 200, "a viewport taller than the content shrinks to it");
  assert.equal(bodyOf(tall)[0], "n1: Scroll regression notice", "the offset clamps to the new bounds");
  rows = 9;
  width = 24;
  const reached = new Set<string>();
  for (let index = 0; index < 120; index += 1) {
    const frame = fixture.component.render(width);
    for (const line of frame) assert.ok(line.length <= width, `every row fits the resized width: ${JSON.stringify(line)}`);
    for (const line of splitFixedHint(frameInterior(frame), NOTICE_KEY_HINT, rows).body) reached.add(line);
    fixture.component.handleInput(SHIFT_ALT_DOWN);
  }
  const joined = [...reached].join(" ");
  for (let index = 1; index <= 60; index += 1) {
    assert.ok(joined.includes(`word${String(index).padStart(2, "0")}`), `wrapped word ${index} is reachable after resize`);
  }
  assert.ok(reached.has("WRAPPED-END") && reached.has("  Close"));
});

test("short content renders a compact popup with its hint and nothing to scroll", () => {
  const rows = 30;
  const fixture = makeFixture({ getViewportRows: () => rows });
  registerNotice(fixture, "One short row.");
  fixture.component.handleInput(ENTER);
  const frame = fixture.component.render(60);
  assert.ok(frame.length < 30, "short content does not stretch to the viewport");
  const parts = splitFixedHint(frameInterior(frame), NOTICE_KEY_HINT, rows);
  assert.equal(parts.hint.join(" ").replace(/\s+/gu, " "), NOTICE_KEY_HINT);
  assert.ok(parts.body.includes("One short row.") && parts.body.includes("  Close"));
  fixture.component.handleInput(SHIFT_ALT_DOWN);
  assert.deepEqual(fixture.component.render(60), frame, "nothing moves when everything fits");
});

test("tiny budgets keep a compact fixed hint before giving up padding, and never hide the body", () => {
  let rows = 6;
  const fixture = makeFixture({ getViewportRows: () => rows });
  registerNotice(fixture, longNoticeBody(8));
  fixture.component.handleInput(ENTER);

  let interior = frameInterior(fixture.component.render(40));
  assert.deepEqual(interior.map((line) => line.trim().length === 0), [true, false, false, true],
    "a six-row frame keeps its blank padding with one body row and one hint row");
  assert.equal(interior[1], "n1: Scroll regression notice");
  assert.ok(interior[2]!.startsWith("Shift+Alt+Up/Down or") && interior[2]!.endsWith("…"),
    `the compact scroll hint is truncated to its row: ${interior[2]}`);

  rows = 5;
  const frame = fixture.component.render(80);
  interior = frameInterior(frame);
  assert.equal(frame.length, 5);
  assert.equal(interior.length, 3, "a five-row frame drops only its blank padding rows");
  assert.equal(interior[0], "n1: Scroll regression notice", "one body row remains");
  assert.ok(interior.slice(1).join(" ").replace(/\s+/gu, " ").includes(SCROLL_KEY_HINT), "the compact hint stays visible");

  const reached = new Set<string>();
  for (let index = 0; index < 30; index += 1) {
    reached.add(frameInterior(fixture.component.render(80))[0]!);
    fixture.component.handleInput(SHIFT_ALT_DOWN);
  }
  for (let row = 1; row <= 8; row += 1) assert.ok(reached.has(`Body row 0${row}`), `body row ${row} stays reachable`);

  rows = 3;
  interior = frameInterior(fixture.component.render(80));
  assert.equal(interior.length, 1, "a one-row budget keeps only the body");
  assert.ok(!interior[0]!.includes("Shift+Alt"), "the body row is never replaced by the hint");
  rows = 8;
  for (const line of fixture.component.render(4)) assert.ok(line.length <= 4, `tiny widths stay width-safe: ${JSON.stringify(line)}`);
});

test("one- and two-row budgets drop the rules so retained content stays visible and scrollable", () => {
  for (const rows of [1, 2]) {
    const fixture = makeFixture({ getViewportRows: () => rows });
    registerNotice(fixture, longNoticeBody(6), "CONTEXT-END");
    fixture.component.handleInput(ENTER);
    const contentRow = (): string => {
      const frame = fixture.component.render(40);
      assert.equal(frame.length, rows, `a ${rows}-row budget renders exactly ${rows} rows`);
      assert.ok(frame.every((line) => !/^─+$/u.test(line)), `a ${rows}-row budget spends no row on a rule`);
      for (const line of frame) assert.ok(line.length <= 40, "rows stay width-safe");
      if (rows === 2) {
        assert.ok(frame[1]!.trim().startsWith("Shift+Alt+Up/Down or"), `the second row keeps a compact hint: ${frame[1]}`);
      }
      return frame[0]!.slice(1).trimEnd();
    };
    assert.equal(contentRow(), "n1: Scroll regression notice", `a ${rows}-row popup opens at its first content row`);
    const reached = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      reached.add(contentRow());
      fixture.component.handleInput(index % 2 === 0 ? SHIFT_ALT_DOWN : CTRL_ALT_PAGE_DOWN);
    }
    for (let row = 1; row <= 6; row += 1) assert.ok(reached.has(`Body row 0${row}`), `${rows}-row budget reaches body row ${row}`);
    assert.ok(reached.has("CONTEXT-END") && reached.has("  Close"), `${rows}-row budget reaches the context and actions`);
    for (let page = 0; page < 100; page += 1) fixture.component.handleInput(SHIFT_ALT_UP);
    assert.equal(contentRow(), "n1: Scroll regression notice", "keyboard paging returns a tiny popup to its beginning");
    fixture.component.handleInput(DOWN); // select Close
    assert.equal(contentRow(), "> Close", "selection still reveals the chosen action in a one-row body");
  }
  const editing = makeFixture({ getViewportRows: () => 1 });
  register(editing, "Which lane?", { choices: ["Canary"] });
  editing.component.handleInput(ENTER);
  editing.component.handleInput(DOWN);
  editing.component.handleInput(ENTER);
  editing.component.handleInput("draft");
  const frame = editing.component.render(40);
  assert.equal(frame.length, 1);
  assert.match(frame[0]!, /\[field:draft\]/, "the active editor's cursor row remains visible in a one-row budget");
});

test("short popups keep their natural content height; long content grows only to the viewport cap", () => {
  const rows = 38; // A 40-row terminal minus the overlay's one-row top and bottom margins.
  const height = (setup: (fixture: Fixture) => void): number => {
    const fixture = makeFixture({ getViewportRows: () => rows });
    setup(fixture);
    return fixture.component.render(160).length;
  };
  // Pre-#413 natural layout: two rules, two blank padding rows, the content
  // lines, one blank separator, and the hint (one row at this wide width).
  const natural = (contentLines: number): number => 2 + 2 + contentLines + 1 + 1;
  // List: "Pending input (n)", a blank row, then one row per entry.
  assert.equal(height((fixture) => register(fixture, "One?")), natural(2 + 1), "a one-item list is sized to its entry");
  assert.equal(height((fixture) => { register(fixture, "One?"); register(fixture, "Two?"); }), natural(2 + 2),
    "a two-item list grows by exactly one row");
  // This fixture host has no native Markdown, so question and notice views
  // add the visible plain-text disclosure line and its blank separator.
  // A short question: "q1:", the disclosure and a blank row, its text, a
  // blank row, Type something…, and Decline.
  assert.equal(height((fixture) => { register(fixture, "Short question?"); fixture.component.handleInput(ENTER); }),
    natural(7), "a short question uses only its natural rows");
  // A notice: its title and a blank row, the disclosure and a blank row, its
  // body rows, a blank row, More details, and Close.
  const noticeLines = (bodyRows: number): number => 2 + 2 + bodyRows + 1 + 2;
  assert.equal(height((fixture) => { registerNotice(fixture, "One short row."); fixture.component.handleInput(ENTER); }),
    natural(noticeLines(1)), "a short notice uses only its natural rows");
  const sizes = [4, 12, 24, 60].map((bodyRows) => height((fixture) => {
    registerNotice(fixture, longNoticeBody(bodyRows));
    fixture.component.handleInput(ENTER);
  }));
  assert.deepEqual(sizes.slice(0, 3), [natural(noticeLines(4)), natural(noticeLines(12)), natural(noticeLines(24))],
    "growing content grows the popup row for row");
  assert.equal(sizes[3], rows, "long content is capped at the overlay's row budget, never the full terminal");
});

test("stale popups close on scroll input instead of scrolling", () => {
  let stale = false;
  const fixture = makeFixture({ getViewportRows: () => 10, isStale: () => stale });
  registerNotice(fixture, longNoticeBody(20));
  fixture.component.handleInput(ENTER);
  stale = true;
  fixture.component.handleInput(SHIFT_ALT_DOWN);
  assert.deepEqual(fixture.done, [{ kind: "closed" }], "the stale popup closes without acting");
  assert.deepEqual(fixture.component.render(60), []);
  assert.equal(fixture.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Fullscreen pointer input (#431): native-style single click, layered on the
// #413 single scroll offset, body slice, fixed hint area, and tiny layouts.
// ---------------------------------------------------------------------------

type PopupMouseEvent = Parameters<Fixture["component"]["handleMouse"]>[0];
type PopupMouseType = PopupMouseEvent["type"];
type PopupMouseButton = PopupMouseEvent["button"];

const realTextHelpers = createRequire(__filename)("pi-session-host-tui/dist/utils.js") as {
  visibleWidth(text: string): number;
  wrapTextWithAnsi(text: string, width: number): string[];
};

/** The fake host with pi-tui's real cell-width and wrapping helpers. */
function makeRealWidthTuiHost(): ReturnType<typeof makeTuiHost> {
  return {
    ...makeTuiHost(),
    visibleWidth: (text: string) => realTextHelpers.visibleWidth(text),
    wrapTextWithAnsi: (text: string, width: number) => realTextHelpers.wrapTextWithAnsi(text, width),
  };
}

interface DrawnFrame {
  lines: string[];
  width: number;
}

function draw(fixture: Fixture, width = 80): DrawnFrame {
  return { lines: fixture.component.render(width), width };
}

function plainRow(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function plainFrame(frame: DrawnFrame): string {
  return frame.lines.map(plainRow).join("\n");
}

/** The drawn cell where `text` starts (cell columns, measured with real widths). */
function cellOf(frame: DrawnFrame, text: string, occurrence = 0): { x: number; y: number } {
  let seen = 0;
  for (const [y, line] of frame.lines.entries()) {
    const row = plainRow(line);
    const index = row.indexOf(text);
    if (index < 0) continue;
    if (seen++ < occurrence) continue;
    return { x: realTextHelpers.visibleWidth(row.slice(0, index)), y };
  }
  throw new Error(`"${text}" is not drawn in:\n${plainFrame(frame)}`);
}

function pointer(
  frame: DrawnFrame,
  type: PopupMouseType,
  x: number,
  y: number,
  button: PopupMouseButton = "left",
  extra: Partial<PopupMouseEvent> = {},
): PopupMouseEvent {
  return {
    type,
    button: type === "wheel" ? "none" : button,
    x,
    y,
    screenX: x,
    screenY: y + 3,
    width: frame.width,
    height: frame.lines.length,
    ...extra,
  };
}

/**
 * pi-tui's stationary gesture: press, then release and the synthesized click
 * on the same cell, both retargeted with the press-time bounds. `between`
 * runs after the press, where the host's requested render would happen.
 */
function clickCell(
  fixture: Fixture,
  frame: DrawnFrame,
  cell: { x: number; y: number },
  options: { between?: () => void; clickCount?: number } = {},
): Array<ReturnType<Fixture["component"]["handleMouse"]>> {
  const results = [fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y))];
  options.between?.();
  results.push(fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y)));
  results.push(fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y, "left", {
    clickCount: options.clickCount ?? 1,
  })));
  return results;
}

async function flushDelivery(): Promise<void> {
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

/** Keyboard-page the popup one line at a time until `done` holds for the drawn frame. */
function pageUntil(fixture: Fixture, width: number, done: (frame: DrawnFrame) => boolean, key = CTRL_ALT_PAGE_DOWN): DrawnFrame {
  for (let step = 0; step <= 80; step += 1) {
    const frame = draw(fixture, width);
    if (done(frame)) return frame;
    fixture.component.handleInput(key);
  }
  throw new Error(`the paging target was not reached:\n${plainFrame(draw(fixture, width))}`);
}

test("mouse: a press highlights a list row without acting; the completed click matches Enter", () => {
  const keyboard = makeFixture();
  register(keyboard, "First question?", { choices: ["a"] });
  register(keyboard, "Second question?", { choices: ["b"] });
  keyboard.component.handleInput(DOWN);
  keyboard.component.handleInput(ENTER);
  const expected = keyboard.component.render(80);

  const fixture = makeFixture();
  register(fixture, "First question?", { choices: ["a"] });
  register(fixture, "Second question?", { choices: ["b"] });
  const frame = draw(fixture);
  const cell = cellOf(frame, "q2: Second question?");
  const press = fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y));
  assert.deepEqual(press, { handled: true, render: true });
  const highlighted = fixture.component.render(80).map(plainRow).join("\n");
  assert.match(highlighted, /> q2: Second question\?/, "the press moves the highlight to the pressed row");
  assert.match(highlighted, /Pending input \(2\)/, "a press alone never opens the item");

  assert.deepEqual(fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y)), { handled: true, render: false });
  assert.deepEqual(fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y, "left", { clickCount: 1 })),
    { handled: true, render: true });
  assert.deepEqual(fixture.component.render(80), expected, "the click runs exactly the keyboard Enter action");
  assert.equal(fixture.controller.listPending().length, 2, "opening a question resolves nothing");
  assert.equal(fixture.done.length, 0);
});

test("mouse: clicking a choice submits its raw stored label exactly like Enter", async () => {
  const rawChoice = "**Canary** \u001b[2J lane\\label";
  const fixture = makeFixture();
  register(fixture, "Which release lane?", { choices: ["Other", rawChoice] });
  fixture.component.handleInput(ENTER);
  const frame = draw(fixture);
  clickCell(fixture, frame, cellOf(frame, `2. ${visibleTerminalText(rawChoice)}`));
  await flushDelivery();
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0]!.message, `Answer to pending question "Which release lane?": ${rawChoice}`);
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
});

test("mouse: Type something begins native editing and Decline declines a waiting question", async () => {
  const fixture = makeFixture();
  const id = register(fixture, "Which database?", { choices: ["SQLite"], mode: "sync" });
  const wait = fixture.controller.waitForAnswer(id);
  fixture.component.handleInput(ENTER);
  let frame = draw(fixture);
  clickCell(fixture, frame, cellOf(frame, "Type something…"));
  assert.equal(fixture.field!.fieldActive, true, "the existing confirm action opened the editing episode");
  assert.equal(fixture.field!.focused, true);
  assert.equal(fixture.controller.listPending().length, 1, "starting to type resolves nothing");

  fixture.component.handleInput(ESCAPE); // leave editing through the keyboard path
  frame = draw(fixture);
  clickCell(fixture, frame, cellOf(frame, "Decline (no answer will be sent)"));
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "declined", empty: true } }]);
  assert.deepEqual(await wait, { outcome: "declined" });
  assert.equal(fixture.sent.length, 0, "declining sends nothing to the model");
});

test("mouse: notice rows, More details, and Close run their existing notice actions", () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"] });
  const noticeId = registerNotice(fixture, "A retained detail row.");
  const notice = fixture.controller.getPending(noticeId);
  let frame = draw(fixture);
  clickCell(fixture, frame, cellOf(frame, `${noticeId}: Scroll regression notice`));
  frame = draw(fixture);
  assert.match(plainFrame(frame), /> More details/, "the notice view opened with its default action");
  clickCell(fixture, frame, cellOf(frame, "Close"));
  assert.equal(fixture.controller.getPending(noticeId), undefined, "Close removed only the notice");
  assert.equal(fixture.controller.listPending().length, 1);
  assert.equal(fixture.done.length, 0, "the list stays open while input remains");
  assert.match(plainFrame(draw(fixture)), /Pending input \(1\)/);

  const details = makeFixture();
  const detailsId = registerNotice(details, "Body for details.");
  const record = details.controller.getPending(detailsId);
  details.component.handleInput(ENTER);
  const detailFrame = draw(details);
  clickCell(details, detailFrame, cellOf(detailFrame, "More details"));
  assert.equal(details.done.length, 1);
  const result = details.done[0] as { kind: string; noticeId: string; expectedNotice: unknown };
  assert.equal(result.kind, "notice-details");
  assert.equal(result.noticeId, detailsId);
  assert.equal(result.expectedNotice, record, "the exact notice snapshot is reported for owner-session delivery");
  assert.notEqual(notice, undefined);
});

test("mouse: non-left buttons, motion, releases, stray clicks, and wheel never activate", () => {
  const fixture = makeFixture({ getViewportRows: () => 16 });
  register(fixture, "Which database?", { choices: ["SQLite", "Postgres", "MySQL", "DuckDB"] });
  fixture.component.handleInput(ENTER);
  const frame = draw(fixture);
  const cell = cellOf(frame, "1. SQLite");
  const before = fixture.component.render(80);

  for (const button of ["right", "middle"] as const) {
    assert.deepEqual(fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y, button)),
      { handled: true, render: false }, `${button} presses keep the popup's foreground ownership (right-click paste path)`);
    assert.equal(fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y, button)), undefined,
      `${button} releases complete no claimed item press and are left to the host`);
    assert.equal(fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y, button, { clickCount: 1 })), undefined,
      `${button} clicks never activate`);
  }
  for (const type of ["move", "drag", "release"] as const) {
    assert.equal(fixture.component.handleMouse(pointer(frame, type, cell.x, cell.y, type === "move" ? "none" : "left")),
      undefined, `${type} without a claimed item press is left to the host's native selection`);
  }
  assert.equal(fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y, "left", { clickCount: 1 })),
    undefined, "a click with no paired press in this popup never activates");
  // Scrolling stays keyboard-only: wheel is never handled, so it neither
  // activates nor scrolls the popup body.
  for (const wheelDelta of [1, -1, 3]) {
    assert.equal(fixture.component.handleMouse(pointer(frame, "wheel", cell.x, cell.y, "none", { wheelDelta } as Partial<PopupMouseEvent>)),
      undefined, "wheel policy is left to the host");
  }
  assert.deepEqual(fixture.component.render(80), before, "nothing highlighted or scrolled");
  assert.equal(fixture.controller.listPending().length, 1);
  assert.equal(fixture.done.length, 0);
});

test("mouse: header, blank, rule, padding, hint, side-padding, and trailing blank cells are not items", () => {
  const fixture = makeFixture({ getViewportRows: () => 20 });
  register(fixture, "Which database?", { choices: ["SQLite"] });
  fixture.component.handleInput(ENTER);
  const frame = draw(fixture, 40);
  const choice = cellOf(frame, "1. SQLite");
  const hint = cellOf(frame, "arrows select");
  const header = cellOf(frame, "q1:");
  const blankRow = frame.lines.findIndex((line, index) => index > header.y && plainRow(line).trim() === "");
  const drawnEnd = choice.x + "1. SQLite".length;
  const hintRows = frame.lines.flatMap((line, index) => (index >= hint.y && index < frame.lines.length - 2 ? [index] : []));
  assert.ok(hintRows.length > 1, `the fixed hint wraps onto several rows at width 40:\n${plainFrame(frame)}`);
  const misses: Array<[string, number, number]> = [
    ["top rule", 3, 0],
    ["top padding row", 3, 1],
    ["question header", header.x, header.y],
    ["blank separator row", 3, blankRow],
    ["blank row between body and fixed hint", 3, hint.y - 1],
    ...hintRows.map((y): [string, number, number] => [`fixed hint row ${y}`, 3, y]),
    ["bottom rule", 3, frame.lines.length - 1],
    ["bottom padding row", 3, frame.lines.length - 2],
    ["left side padding", 0, choice.y],
    ["trailing blank after the label", drawnEnd, choice.y],
    ["right side padding", 39, choice.y],
    ["outside the frame", 3, frame.lines.length],
  ];
  for (const [name, x, y] of misses) {
    const results = clickCell(fixture, frame, { x, y });
    assert.deepEqual(results, [undefined, undefined, undefined],
      `${name}: a non-item gesture is left to the host's native selection; nothing is claimed or activated`);
  }
  assert.equal(fixture.controller.listPending().length, 1);
  assert.equal(fixture.sent.length, 0);
  // The last drawn label cell is still the item.
  clickCell(fixture, frame, { x: drawnEnd - 1, y: choice.y });
  assert.equal(fixture.controller.listPending().length, 0);
});

test("mouse: every visible line of a wrapped choice maps to it, and a drag-off cancels", async () => {
  const longChoice = "Use the managed Postgres cluster with read replicas in every region we deploy to";
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite", longChoice] });
  fixture.component.handleInput(ENTER);
  const frame = draw(fixture, 32);
  const first = cellOf(frame, "2. Use");
  const continuation = frame.lines.slice(first.y + 1).findIndex((line) => plainRow(line).startsWith("   ") && plainRow(line).trim().length > 0);
  assert.ok(continuation >= 0, `the choice wraps: ${plainFrame(frame)}`);
  const lastY = first.y + 1 + continuation;

  // Press on the wrapped continuation, drag away, release elsewhere: no click.
  fixture.component.handleMouse(pointer(frame, "press", 5, lastY));
  assert.match(fixture.component.render(32).map(plainRow).join("\n"), /> 2\. Use/, "the continuation press highlights its choice");
  fixture.component.handleMouse(pointer(frame, "drag", 5, lastY + 1));
  fixture.component.handleMouse(pointer(frame, "release", 5, lastY + 1));
  assert.equal(fixture.controller.listPending().length, 1, "a drag-off never activates");

  clickCell(fixture, frame, { x: 5, y: lastY });
  await flushDelivery();
  assert.equal(fixture.sent[0]?.message, `Answer to pending question "Which database?": ${longChoice}`);
});

test("mouse: wide labels and sub-padding widths hit exactly their drawn cells", () => {
  const fixture = makeFixture({ tuiHost: makeRealWidthTuiHost() });
  register(fixture, "Which?", { choices: ["数据库选择"] });
  fixture.component.handleInput(ENTER);
  const frame = draw(fixture, 30);
  const cell = cellOf(frame, "1. 数据库选择");
  const lastCell = cell.x + realTextHelpers.visibleWidth("1. 数据库选择") - 1;
  const results = clickCell(fixture, frame, { x: lastCell + 1, y: cell.y });
  assert.equal(results[2], undefined, "the cell after the last wide glyph is blank and left to native selection");
  assert.equal(fixture.controller.listPending().length, 1);
  clickCell(fixture, frame, { x: lastCell, y: cell.y });
  assert.equal(fixture.controller.listPending().length, 0, "the second cell of the last wide glyph is drawn label");

  // Below three cells the frame has no side padding and notice actions draw
  // their selection marker on its own row; the marker and every label row
  // belong to that action.
  const narrow = makeFixture({ tuiHost: makeRealWidthTuiHost() });
  const noticeId = registerNotice(narrow, "Body.");
  narrow.component.handleInput(ENTER);
  const tiny = draw(narrow, 2);
  assert.ok(tiny.lines.every((line) => realTextHelpers.visibleWidth(line) <= 2));
  const rows = tiny.lines.map(plainRow);
  const closeStart = rows.findIndex((row, index) => row === "Cl" && rows[index + 1] === "os");
  assert.ok(closeStart > 0, `Close is wrapped at width 2: ${JSON.stringify(rows)}`);
  const blankAfterE = clickCell(narrow, tiny, { x: 1, y: closeStart + 2 });
  assert.equal(blankAfterE[2], undefined, "the blank cell after the final \"e\" is not Close and is left to native selection");
  assert.notEqual(narrow.controller.getPending(noticeId), undefined);
  clickCell(narrow, tiny, { x: 0, y: closeStart + 2 }); // "e" of Close
  assert.equal(narrow.controller.getPending(noticeId), undefined, "the last wrapped Close cell runs Close");
});

test("mouse: scrolled viewports map rows through the authoritative offset, not the keyboard selection", async () => {
  const fixture = makeFixture({ getViewportRows: () => 7 });
  register(fixture, "Pick one?", { choices: ["alpha", "beta", "gamma", "delta"] });
  fixture.component.handleInput(ENTER);
  // One body row remains above the two fixed hint rows: page until it draws
  // the unselected second choice, with the selected first choice offscreen.
  const frame = pageUntil(fixture, 80, (current) => plainFrame(current).includes("  2. beta"));
  assert.doesNotMatch(plainFrame(frame), /1\. alpha/, "the keyboard selection is scrolled away");
  const { body, hint } = splitFixedHint(frameInterior(frame.lines.map(plainRow)), ANSWER_KEY_HINT, 7);
  assert.deepEqual(body, ["  2. beta"], "exactly one body row is visible");
  assert.ok(hint.join(" ").includes("Esc back"), "the fixed hint stays below the body");
  const beta = cellOf(frame, "2. beta");
  fixture.component.handleMouse(pointer(frame, "press", beta.x, beta.y));
  const pressed = draw(fixture);
  assert.deepEqual(splitFixedHint(frameInterior(pressed.lines.map(plainRow)), ANSWER_KEY_HINT, 7).body, ["> 2. beta"],
    "the press highlights the visible row and never reveals or scrolls");
  fixture.component.handleMouse(pointer(frame, "release", beta.x, beta.y));
  fixture.component.handleMouse(pointer(frame, "click", beta.x, beta.y, "left", { clickCount: 1 }));
  await flushDelivery();
  assert.equal(fixture.sent[0]?.message, `Answer to pending question "Pick one?": beta`);
});

test("mouse: fixed hint rows below a scrolled body stay inert while the body rows above them map exactly", async () => {
  const fixture = makeFixture({ getViewportRows: () => 9 });
  const choices = Array.from({ length: 8 }, (_, index) => `option-${index + 1}`);
  register(fixture, "Which option?", { choices });
  fixture.component.handleInput(ENTER);
  const frame = pageUntil(fixture, 80, (current) => /  [56]\. option-[56]/.test(plainFrame(current)));
  const interior = frameInterior(frame.lines.map(plainRow));
  const { body, hint } = splitFixedHint(interior, ANSWER_KEY_HINT, 9);
  assert.ok(hint.length > 0 && body.length > 0, `body and fixed hint are both drawn:\n${plainFrame(frame)}`);
  // Content continues below the body, but the cells directly under it draw
  // the fixed hint, which belongs to no item.
  assert.ok(!body.some((row) => row.includes("Decline")), "later items are hidden below the body");
  const firstHintY = frame.lines.findIndex((line) => plainRow(line).includes(hint.find((row) => row.trim().length > 0)!.trim()));
  for (let y = firstHintY - 1; y < frame.lines.length; y += 1) {
    const results = clickCell(fixture, frame, { x: 4, y });
    assert.equal(results[0], undefined, `row ${y} below the body is not an item and is left to native selection`);
    assert.equal(results[2], undefined);
  }
  assert.equal(fixture.sent.length, 0);
  const lastBodyRow = body[body.length - 1]!;
  const label = /(\d+)\. (option-\d+)/.exec(lastBodyRow);
  assert.ok(label, `the last body row is a choice: ${JSON.stringify(body)}`);
  clickCell(fixture, frame, cellOf(frame, `${label[1]}. ${label[2]}`));
  await flushDelivery();
  assert.equal(fixture.sent[0]?.message, `Answer to pending question "Which option?": ${label[2]}`,
    "the last visible body row answers with exactly the choice it draws");
});

test("mouse: tiny budgets without padding or rules map only their remaining body rows", async () => {
  for (const rows of [4, 3, 2, 1]) {
    const fixture = makeFixture({ getViewportRows: () => rows });
    register(fixture, "Tiny?", { choices: ["alpha", "beta"] });
    fixture.component.handleInput(ENTER);
    const frame = pageUntil(fixture, 60, (current) => plainFrame(current).includes("2. beta"));
    assert.equal(frame.lines.length, rows, `${rows} rows: the frame uses the whole tiny budget`);
    const plain = frame.lines.map(plainRow);
    const betaY = plain.findIndex((row) => row.includes("2. beta"));
    for (const [y, row] of plain.entries()) {
      if (y === betaY) continue;
      const results = clickCell(fixture, frame, { x: Math.max(0, row.search(/\S/)), y });
      assert.equal(results[2], undefined, `${rows} rows: row ${y} (${JSON.stringify(row)}) is inert and left to native selection`);
    }
    if (rows <= 2) {
      assert.ok(!plain.some((row) => /^─+$/.test(row)), `${rows} rows: the rules gave way to content`);
    }
    assert.equal(fixture.sent.length, 0);
    clickCell(fixture, frame, cellOf(frame, "2. beta"));
    await flushDelivery();
    assert.equal(fixture.sent[0]?.message, `Answer to pending question "Tiny?": beta`, `${rows} rows: the body row acts`);
  }
});

test("mouse: a press keeps the scroll offset and reveal state; keyboard selection later reveals from the pressed row", () => {
  const fixture = makeFixture({ getViewportRows: () => 10 });
  for (let index = 1; index <= 9; index += 1) register(fixture, `Question ${index}?`, { choices: ["x"] });
  // The list opens revealing q1; page down until q1 is offscreen.
  const frame = pageUntil(fixture, 80, (current) => !plainFrame(current).includes("q1: Question 1?"));
  const before = frame.lines.map(plainRow);
  const target = /\s(q\d): Question \d\?/.exec(before.find((row) => /\s{3}q\d: /.test(row)) ?? "");
  assert.ok(target, `an unselected row is visible:\n${before.join("\n")}`);
  const cell = cellOf(frame, `${target[1]}:`);
  fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y));
  const after = draw(fixture).lines.map(plainRow);
  assert.equal(after.length, before.length);
  for (const [y, row] of after.entries()) {
    if (y === cell.y) assert.equal(row, before[y]!.replace(`  ${target[1]}:`, `> ${target[1]}:`), "only the pressed row's marker changes");
    else assert.equal(row, before[y], `row ${y} did not move: no reveal, reflow, or scroll`);
  }
  // A drag-off cancels the click but keeps the pressed selection, which the
  // keyboard then moves and reveals as usual.
  fixture.component.handleMouse(pointer(frame, "drag", cell.x, cell.y + 1));
  fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y + 1));
  assert.deepEqual(draw(fixture).lines.map(plainRow), after, "a drag-off release changes nothing visible");
  fixture.component.handleInput(UP);
  const next = `q${Number(target[1]!.slice(1)) - 1}:`;
  assert.match(plainFrame(draw(fixture)), new RegExp(`> ${next}`), "Up moves from the pressed row and reveals it");
  assert.equal(fixture.controller.listPending().length, 9);
});

test("mouse: resized, mismatched, or shifted frames between press and click never activate", () => {
  let rows = 20;
  const fixture = makeFixture({ getViewportRows: () => rows });
  register(fixture, "First question?", { choices: ["a"] });
  register(fixture, "Second question?", { choices: ["b"] });
  let frame = draw(fixture);
  let cell = cellOf(frame, "q2: Second question?");

  // Bounds that do not match the last composited frame are rejected.
  const mismatched = fixture.component.handleMouse({ ...pointer(frame, "press", cell.x, cell.y), width: 79 });
  assert.equal(mismatched, undefined, "a press whose bounds do not describe the drawn frame is left to the host's native selection");

  // A resize render between press and click.
  clickCell(fixture, frame, cell, { between: () => fixture.component.render(60) });
  assert.match(plainFrame(draw(fixture)), /Pending input \(2\)/, "a width change cancels the click");

  // A viewport-budget change between press and click (rows-only resize):
  // the compact natural height is unchanged, but the budget differs.
  frame = draw(fixture);
  cell = cellOf(frame, "q2: Second question?");
  clickCell(fixture, frame, cell, {
    between: () => {
      rows = 18;
      assert.equal(fixture.component.render(80).length, frame.lines.length, "the compact popup keeps its natural height");
    },
  });
  assert.match(plainFrame(draw(fixture)), /Pending input \(2\)/, "a viewport change cancels the click");

  // The list shifts under the pointer between press and click.
  frame = draw(fixture);
  cell = cellOf(frame, "q2: Second question?");
  clickCell(fixture, frame, cell, {
    between: () => {
      fixture.component.handleMouse(pointer(frame, "move", cell.x, cell.y, "none"));
      fixture.controller.submitDecline("q1");
      fixture.component.render(80);
    },
  });
  assert.equal(fixture.controller.listPending().length, 1);
  assert.match(plainFrame(draw(fixture)), /Pending input \(1\)/, "a shifted row under the pointer cancels the click");

  // A press, render with the highlight, then click on the unchanged geometry acts.
  frame = draw(fixture);
  cell = cellOf(frame, "q2: Second question?");
  clickCell(fixture, frame, cell, { between: () => fixture.component.render(80) });
  const answered = plainFrame(draw(fixture));
  assert.match(answered, /^ q2:/m, "the pressed question's answer view opened");
  assert.doesNotMatch(answered, /Pending input/);
});

test("mouse: removed records and rebound sessions never answer another record", async () => {
  const fixture = makeFixture();
  register(fixture, "Old question?", { choices: ["old"] });
  fixture.component.handleInput(ENTER);
  const frame = draw(fixture);
  const cell = cellOf(frame, "1. old");
  fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y));
  // Session reset reuses the per-session ID before any render happens.
  fixture.controller.beginSession({ sessionManager: "replacement" });
  const replacement = fixture.controller.register(
    { toolCallId: "t-new", question: "Replacement question?", choices: ["old"], mode: "async" },
    { sessionManager: "replacement" },
  );
  assert.ok(!replacement.ok, "a foreign identity cannot register into the replacement");
  fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y));
  fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y, "left", { clickCount: 1 }));
  await flushDelivery();
  assert.equal(fixture.sent.length, 0, "the stale frame never submits");

  let stale = false;
  const fenced = makeFixture({ isStale: () => stale });
  register(fenced, "Fenced question?", { choices: ["yes"] });
  fenced.component.handleInput(ENTER);
  const fencedFrame = draw(fenced);
  const fencedCell = cellOf(fencedFrame, "1. yes");
  fenced.component.handleMouse(pointer(fencedFrame, "press", fencedCell.x, fencedCell.y));
  stale = true;
  fenced.component.handleMouse(pointer(fencedFrame, "release", fencedCell.x, fencedCell.y));
  assert.deepEqual(fenced.done, [{ kind: "closed" }], "a rebound popup closes on pointer input without submitting");
  assert.equal(fenced.component.handleMouse(pointer(fencedFrame, "click", fencedCell.x, fencedCell.y)), undefined,
    "a closed popup intercepts nothing");
  await flushDelivery();
  assert.equal(fenced.sent.length, 0);
  assert.equal(fenced.controller.listPending().length, 1);

  // Same session, same ID, replaced record: the snapshot identity differs.
  const reused = makeFixture();
  register(reused, "First?", { choices: ["one"] });
  const reusedFrame = draw(reused);
  const reusedCell = cellOf(reusedFrame, "q1: First?");
  reused.controller.beginSession(reused.identity);
  register(reused, "Different?", { choices: ["two"] });
  clickCell(reused, reusedFrame, reusedCell);
  assert.match(plainFrame(draw(reused)), /Pending input \(1\)/,
    "a reused ID never opens the replacement record from an old frame");
});

test("mouse: one gesture activates once; a quick second click on new content needs its own press", async () => {
  const fixture = makeFixture();
  register(fixture, "First?", { choices: ["one"] });
  register(fixture, "Second?", { choices: ["two"] });
  const frame = draw(fixture);
  const cell = cellOf(frame, "q1: First?");
  clickCell(fixture, frame, cell);
  // A repeated click event with no new press, and a double click whose press
  // lands before the answer view was drawn, both stay inert.
  assert.equal(fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y, "left", { clickCount: 2 })),
    undefined, "a click with no paired press is left to the host");
  clickCell(fixture, frame, cell, { clickCount: 2 });
  await flushDelivery();
  assert.equal(fixture.controller.listPending().length, 2, "no answer was chosen by the repeated click");
  assert.equal(fixture.sent.length, 0);
});

test("mouse: keyboard input cancels a pending gesture and keyboard parity holds under remapped bindings", async () => {
  const remapped = makeKeybindings({
    "tui.select.confirm": [TAB],
    "tui.select.down": ["j"],
    "tui.select.up": ["k"],
  });
  const fixture = makeFixture({ keybindings: remapped });
  register(fixture, "First?", { choices: ["one", "two"] });
  let frame = draw(fixture);
  const cell = cellOf(frame, "q1: First?");
  fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y));
  fixture.component.handleInput("j"); // keyboard during the gesture
  fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y));
  fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y));
  assert.match(plainFrame(draw(fixture)), /Pending input \(1\)/, "the interrupted gesture is cancelled");

  fixture.component.handleInput(ENTER);
  assert.match(plainFrame(draw(fixture)), /Pending input \(1\)/, "a remapped-away Enter does not confirm");
  clickCell(fixture, frame, cell);
  frame = draw(fixture);
  assert.match(plainFrame(frame), /> 1\. one/, "the click opens the answer view regardless of key remaps");
  // A pointer press moves the selection the keyboard then confirms.
  const two = cellOf(frame, "2. two");
  fixture.component.handleMouse(pointer(frame, "press", two.x, two.y));
  fixture.component.handleMouse(pointer(frame, "drag", two.x + 1, two.y));
  fixture.component.handleMouse(pointer(frame, "release", two.x + 1, two.y));
  fixture.component.handleInput(TAB);
  await flushDelivery();
  assert.equal(fixture.sent[0]?.message, `Answer to pending question "First?": two`);
});

test("mouse: while editing, the editor box is inert and a clicked menu row leaves editing then runs its action", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite", "Postgres"] });
  register(fixture, "Another?", { choices: ["x"] });
  fixture.component.handleInput(ENTER);
  fixture.component.handleInput(DOWN);
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  for (const char of "my draft") fixture.component.handleInput(char);
  let frame = draw(fixture);
  const box = cellOf(frame, "[field:my draft]");

  // Clicking inside the native editor box never submits or changes the draft.
  clickCell(fixture, frame, { x: box.x + 2, y: box.y });
  assert.equal(fixture.field!.fieldActive, true, "editing continues");
  assert.equal(fixture.field!.getText(), "my draft");
  assert.equal(fixture.controller.listPending().length, 2);
  assert.equal(fixture.sent.length, 0);

  // A press on a visible choice highlights it without touching the field.
  frame = draw(fixture);
  const postgres = cellOf(frame, "2. Postgres");
  fixture.component.handleMouse(pointer(frame, "press", postgres.x, postgres.y));
  const pressed = plainFrame(draw(fixture));
  assert.match(pressed, /> 2\. Postgres/, "the pressed menu row is highlighted");
  assert.match(pressed, /\[field:my draft\]/, "the native editor box stays in place");
  assert.equal(fixture.field!.fieldActive, true);
  assert.equal(fixture.field!.focused, true, "the native field keeps focus during the press");
  assert.equal(fixture.field!.getText(), "my draft");

  // Drag-off clears the highlight; native keyboard editing is unchanged.
  fixture.component.handleMouse(pointer(frame, "drag", postgres.x, postgres.y + 1));
  fixture.component.handleMouse(pointer(frame, "release", postgres.x, postgres.y + 1));
  assert.doesNotMatch(plainFrame(draw(fixture)), /> 2\. Postgres/);
  fixture.component.handleInput("!");
  assert.equal(fixture.field!.getText(), "my draft!", "typing still reaches the native field");
  assert.equal(fixture.field!.inputLog.filter((data) => data.startsWith("\x1b[<")).length, 0,
    "no pointer bytes reached the native field");

  // A completed click on the choice leaves editing (draft kept) and submits the choice.
  frame = draw(fixture);
  clickCell(fixture, frame, cellOf(frame, "2. Postgres"));
  await flushDelivery();
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0]!.message, `Answer to pending question "Which database?": Postgres`);
  assert.equal(fixture.field!.fieldActive, false, "editing ended");
  assert.equal(fixture.field!.getText(), "my draft!", "the draft was kept, never submitted");
  assert.equal(fixture.controller.listPending().length, 1, "only the clicked question resolved");

  // Decline is equally clickable while editing.
  const declining = makeFixture();
  register(declining, "Decline me?", { choices: ["a"] });
  declining.component.handleInput(ENTER);
  declining.component.handleInput(DOWN);
  declining.component.handleInput(ENTER);
  for (const char of "draft") declining.component.handleInput(char);
  const declineFrame = draw(declining);
  clickCell(declining, declineFrame, cellOf(declineFrame, "Decline (no answer will be sent)"));
  assert.deepEqual(declining.done, [{ kind: "submitted", result: { status: "declined", empty: true } }]);
  assert.equal(declining.field!.getText(), "draft");
});

test("mouse: while editing in a bounded popup, a press highlight keeps the cursor-revealed offset", () => {
  const fixture = makeFixture({ getViewportRows: () => 12 });
  const choices = Array.from({ length: 6 }, (_, index) => `option-${index + 1}`);
  register(fixture, "Which option?", { choices });
  fixture.component.handleInput(ENTER);
  for (let step = 0; step < choices.length; step += 1) fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER);
  for (const char of "draft") fixture.component.handleInput(char);
  const frame = draw(fixture);
  const before = frame.lines.map(plainRow);
  assert.ok(before.some((row) => row.includes("[field:draft]")), `the editing cursor is revealed:\n${before.join("\n")}`);
  const visible = /(\d+)\. (option-\d+)/.exec(before.find((row) => /\d+\. option-/.test(row)) ?? "");
  assert.ok(visible, "a choice is visible above the editor");
  const cell = cellOf(frame, `${visible[1]}. ${visible[2]}`);
  fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y));
  const after = draw(fixture).lines.map(plainRow);
  for (const [y, row] of after.entries()) {
    if (y === cell.y) assert.match(row, new RegExp(`> ${visible[1]}\\. ${visible[2]}`));
    else assert.equal(row, before[y], `row ${y} is unchanged by the press`);
  }
  fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y + 5));
  assert.deepEqual(draw(fixture).lines.map(plainRow), before, "the release restores the exact editing frame");
  assert.equal(fixture.field!.fieldActive, true);
});

test("mouse: a terminal resize before the redraw invalidates the gesture; a fresh click after redraw acts", async () => {
  for (const resize of [
    { name: "width-only", columns: 72, rows: 30 },
    { name: "height-only", columns: 80, rows: 26 },
  ]) {
    let size: { columns: number; rows: number } | undefined = { columns: 80, rows: 30 };
    const fixture = makeFixture({ getTerminalSize: () => size, getViewportRows: () => 28 });
    register(fixture, "Which database?", { choices: ["SQLite"] });
    fixture.component.handleInput(ENTER);
    let frame = draw(fixture);
    let cell = cellOf(frame, "1. SQLite");
    // Press, then the terminal resizes; the release and click arrive before
    // any redraw with the press-time bounds the host retargets them to.
    clickCell(fixture, frame, cell, { between: () => { size = { columns: resize.columns, rows: resize.rows }; } });
    await flushDelivery();
    assert.equal(fixture.sent.length, 0, `${resize.name}: no answer is submitted from stale geometry`);
    assert.equal(fixture.controller.listPending().length, 1);
    // A new press on the not-yet-redrawn frame is inert as well.
    const stalePress = fixture.component.handleMouse(pointer(frame, "press", cell.x, cell.y));
    assert.equal(stalePress, undefined, `${resize.name}: a press before redraw is left to native selection instead of highlighting a stale frame`);
    fixture.component.handleMouse(pointer(frame, "release", cell.x, cell.y));
    fixture.component.handleMouse(pointer(frame, "click", cell.x, cell.y));
    assert.equal(fixture.controller.listPending().length, 1);

    // After the host redraws at the new size, a fresh click works.
    frame = draw(fixture, resize.columns);
    cell = cellOf(frame, "1. SQLite");
    clickCell(fixture, frame, cell);
    await flushDelivery();
    assert.equal(fixture.sent[0]?.message, `Answer to pending question "Which database?": SQLite`, `${resize.name}: fresh click acts`);

    // An unknown live size never matches a recorded one.
    const unknown = makeFixture({ getTerminalSize: () => size, getViewportRows: () => 28 });
    register(unknown, "Unknown size?", { choices: ["no"] });
    unknown.component.handleInput(ENTER);
    const unknownFrame = draw(unknown);
    size = undefined;
    clickCell(unknown, unknownFrame, cellOf(unknownFrame, "1. no"));
    assert.equal(unknown.controller.listPending().length, 1, `${resize.name}: an unreadable terminal size fails closed`);
  }
});

test("mouse: a resize keeps the clamped offset for the answer view and clicks map the re-wrapped rows", async () => {
  let rows = 12;
  const fixture = makeFixture({ getViewportRows: () => rows });
  const choices = Array.from({ length: 8 }, (_, index) => `option-${index + 1}`);
  register(fixture, "Which option?", { choices });
  fixture.component.handleInput(ENTER);
  const scrolled = pageUntil(fixture, 80, (current) => plainFrame(current).includes("Decline"));
  assert.doesNotMatch(plainFrame(scrolled), /1\. option-1/, "the selected first choice is scrolled away");
  // Narrow and shorten: the re-wrapped content keeps the clamped offset and
  // the non-editing answer selection is not re-revealed, so the old Decline
  // cell no longer draws Decline.
  rows = 11;
  const resized = draw(fixture, 64);
  assert.doesNotMatch(plainFrame(resized), /1\. option-1/, "the non-editing answer selection is not re-revealed");
  assert.doesNotMatch(plainFrame(resized), /Decline/, "the re-wrapped body moved Decline below the clamped offset");
  const bodyRows = splitFixedHint(frameInterior(resized.lines.map(plainRow)), ANSWER_KEY_HINT, 11).body;
  const label = /(\d+)\. (option-\d+)/.exec(bodyRows.find((row) => /\d+\. option-/.test(row)) ?? "");
  assert.ok(label && label[1] !== "1", `a later choice is drawn after the resize:\n${plainFrame(resized)}`);
  // A gesture recorded on the pre-resize frame never acts on the new one.
  const stale = cellOf(scrolled, "Decline");
  clickCell(fixture, { lines: scrolled.lines, width: 80 }, stale);
  assert.equal(fixture.sent.length, 0);
  clickCell(fixture, resized, cellOf(resized, `${label[1]}. ${label[2]}`));
  await flushDelivery();
  assert.equal(fixture.sent[0]?.message, `Answer to pending question "Which option?": ${label[2]}`);
});

test("mouse: a narrow notice press highlights without reflowing the wrapped actions; the click acts once", () => {
  const accent = "\x1b[36m";
  const theme: QuestionUiTheme = {
    fg: (color, text) => (color === "accent" ? `${accent}${text}\x1b[39m` : text),
    bold: (text) => text,
  };
  for (const width of [2, 3]) {
    const fixture = makeFixture({ tuiHost: makeRealWidthTuiHost(), theme });
    register(fixture, "Keep me?", { choices: ["keep"] });
    const noticeId = registerNotice(fixture, "Body.");
    fixture.component.handleInput(DOWN);
    fixture.component.handleInput(ENTER);
    const frame = draw(fixture, width);
    const before = frame.lines.map(plainRow);
    const markerY = before.findIndex((row) => row.trim() === ">");
    assert.ok(markerY >= 0, `width ${width}: the selected More details draws its marker row: ${JSON.stringify(before)}`);
    const closeStart = before.findIndex((_, index) => index > markerY
      && before.slice(index).map((row) => row.trim()).join("").startsWith("Close"));
    assert.ok(closeStart > markerY + 1, `width ${width}: Close is drawn below More details: ${JSON.stringify(before)}`);
    const x = width >= 3 ? 1 : 0; // the drawn cell after any side padding
    let closeRows = 0;
    while (before.slice(closeStart, closeStart + closeRows).map((row) => row.trim()).join("") !== "Close") closeRows += 1;

    // Press Close, then the host redraws before the release arrives.
    const press = fixture.component.handleMouse(pointer(frame, "press", x, closeStart));
    assert.deepEqual(press, { handled: true, render: true });
    const pressedFrame = draw(fixture, width);
    assert.deepEqual(pressedFrame.lines.map(plainRow), before,
      `width ${width}: no row moved, appeared, or disappeared during press feedback`);
    for (let row = closeStart; row < closeStart + closeRows; row += 1) {
      assert.ok(pressedFrame.lines[row]!.includes(accent), `width ${width}: pressed Close row ${row} is highlighted`);
    }
    assert.ok(!frame.lines[closeStart]!.includes(accent), `width ${width}: Close was not highlighted before the press`);
    assert.equal(pressedFrame.lines.length, frame.lines.length);

    assert.deepEqual(fixture.component.handleMouse(pointer(pressedFrame, "release", x, closeStart)), { handled: true, render: true });
    assert.deepEqual(draw(fixture, width).lines, frame.lines, `width ${width}: the release restores the exact frame`);
    assert.deepEqual(fixture.component.handleMouse(pointer(pressedFrame, "click", x, closeStart, "left", { clickCount: 1 })),
      { handled: true, render: true }, `width ${width}: the paired click activates`);
    assert.equal(fixture.controller.getPending(noticeId), undefined, `width ${width}: Close removed the notice`);
    assert.equal(fixture.controller.listPending().length, 1);
    // A repeated click without its own press never acts again.
    assert.equal(fixture.component.handleMouse(pointer(pressedFrame, "click", x, closeStart, "left", { clickCount: 2 })),
      undefined, `width ${width}: a click with no paired press is left to the host`);
    assert.equal(fixture.controller.listPending().length, 1, `width ${width}: exactly one activation`);
    assert.equal(fixture.done.length, 0);
    assert.equal(fixture.sent.length, 0);

    // A drag-off from a narrow press leaves the keyboard selection where it was.
    const other = makeFixture({ tuiHost: makeRealWidthTuiHost(), theme });
    registerNotice(other, "Body.");
    other.component.handleInput(ENTER);
    const otherFrame = draw(other, width);
    assert.deepEqual(otherFrame.lines.map(plainRow), before, `width ${width}: the same notice layout`);
    assert.deepEqual(other.component.handleMouse(pointer(otherFrame, "press", x, closeStart)), { handled: true, render: true });
    other.component.handleMouse(pointer(otherFrame, "drag", x, 0));
    other.component.handleMouse(pointer(otherFrame, "release", x, 0));
    other.component.handleMouse(pointer(otherFrame, "click", x, 0));
    assert.deepEqual(draw(other, width).lines, otherFrame.lines, `width ${width}: a cancelled narrow press changes nothing`);
  }
});
