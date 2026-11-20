/**
 * Shared native caret routing for extension text fields (#714).
 *
 * These tests drive the REAL pinned pi-tui `Editor` (behind the session-host
 * field adapter) and `Input` through the one shared mouse seam. Every caret
 * assertion is proven by the editing that follows it — a click must change
 * where the next keystroke, paste, undo, or rejected-edit rollback lands — so
 * the native component's own width/wrap/scroll/grapheme mapping is what is
 * exercised, never a duplicated caret algorithm.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Input } from "pi-session-host-tui";
import {
  createSessionHostTextField,
  type SessionHostFieldRejection,
  type SessionHostFieldSubmission,
  type SessionHostTextField,
} from "../src/session-host/field-editor";
import {
  completeNativeMouseEvent,
  hostCaretEvent,
  isUsableTextFieldRegion,
  nativeMouseHandled,
  routeNativeTextFieldMouse,
  translateTextFieldMouse,
  type TextFieldMouseEvent,
} from "../src/text-field-mouse";

const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";
const HOME = "\x1b[H";
const END = "\x1b[4~";
const CTRL_K = "\x0b";
const CTRL_Y = "\x19";
const UNDO = "\x1f";
const JUMP_FORWARD = "\x1d";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function nameField(initialText: string, extra: {
  maxNameBytes?: number;
  onReject?: (reason: SessionHostFieldRejection) => void;
  onSubmit?: (submission: SessionHostFieldSubmission) => void;
  onCancel?: () => void;
} = {}): SessionHostTextField {
  return createSessionHostTextField({ kind: "name", initialText, ...extra });
}

function type(field: SessionHostTextField, text: string): void {
  for (const character of text) field.handleInput(character);
}

/** One host-owned caret press at a field-frame cell, through the shared seam. */
function caretClick(field: SessionHostTextField, x: number, y: number, cols: number, rows: number): boolean {
  const result = routeNativeTextFieldMouse(field, hostCaretEvent("editor", x, y, cols, rows), {
    left: 0, top: 0, width: cols, rows, firstRow: 0, height: rows,
  });
  return nativeMouseHandled(result);
}

// ---------------------------------------------------------------------------
// The seam itself
// ---------------------------------------------------------------------------

test("the seam translates only cells inside the written region and preserves the native event", () => {
  const region = { left: 4, top: 2, width: 10, rows: 3, firstRow: 5, height: 9 };
  const event: TextFieldMouseEvent = {
    type: "drag", button: "left", x: 6, y: 3, width: 40, height: 20, shift: true, clickCount: 2,
  };
  const local = translateTextFieldMouse(event, region);
  assert.deepEqual(local, { ...event, x: 2, y: 6, width: 10, height: 9 },
    "coordinates and bounds change; type, button, modifiers, and click count do not");
  for (const [x, y] of [[3, 3], [14, 3], [6, 1], [6, 5], [-1, 3], [6.5, 3]] as const) {
    assert.equal(translateTextFieldMouse({ ...event, x, y }, region), undefined, `refuses (${x}, ${y})`);
  }
  assert.equal(isUsableTextFieldRegion({ ...region, firstRow: 7 }), false, "rows past the component's height");
  assert.equal(isUsableTextFieldRegion({ ...region, width: 0 }), false);
  assert.equal(routeNativeTextFieldMouse({}, event, region), undefined, "a target without handleMouse");
  assert.equal(routeNativeTextFieldMouse({ handleMouse: () => { throw new Error("native"); } }, event, region),
    undefined, "a throwing native handler never escapes");
});

test("a host-owned press stands for each native component's own convention", () => {
  const editor = hostCaretEvent("editor", 3, 1, 20, 4);
  assert.equal(editor.type, "click", "Editor positions only on a completed click");
  assert.equal(editor.clickCount, 1);
  const input = hostCaretEvent("input", 3, 0, 20, 1);
  assert.equal(input.type, "press", "Input positions on the press itself");
  assert.equal(input.button, "left");
  const completed = completeNativeMouseEvent({ type: "click", button: "left", x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(completed, {
    type: "click", button: "left", x: 1, y: 2, width: 3, height: 4, screenX: 1, screenY: 2,
    shift: false, alt: false, ctrl: false,
  });
});

// ---------------------------------------------------------------------------
// Session-host field adapter over the real pinned Editor
// ---------------------------------------------------------------------------

test("Workspace click-then-X: /srv/example click after /srv/ then X yields /srv/Xexample", (t: TestContext) => {
  const base = mkdtempSync(join(tmpdir(), "text-field-mouse-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const field = createSessionHostTextField({ kind: "path", workspaceBasePath: base, initialText: "/srv/example" });
  try {
    const frame = field.render(40, 6);
    assert.equal(frame.lines[1]?.trimEnd(), "/srv/example");
    assert.equal(caretClick(field, 5, 1, 40, 6), true, "the native Editor consumed the caret click");
    assert.deepEqual(field.getCursor(), { line: 0, col: 5 });
    field.handleInput("X");
    assert.equal(field.getText(), "/srv/Xexample");
    let submitted: SessionHostFieldSubmission | undefined;
    const second = createSessionHostTextField({
      kind: "path", workspaceBasePath: base, initialText: "/srv/example", onSubmit: (value) => { submitted = value; },
    });
    try {
      second.render(40, 6);
      assert.equal(caretClick(second, 5, 1, 40, 6), true);
      second.handleInput("X");
      second.handleInput(ENTER);
      assert.deepEqual(submitted, { text: "/srv/Xexample", value: "/srv/Xexample", source: "typed" });
    } finally {
      second.dispose();
    }
  } finally {
    field.dispose();
  }
});

test("wide, combining, and emoji graphemes keep the native column mapping", () => {
  const cases: Array<{ text: string; x: number; expected: string; note: string }> = [
    { text: "a界b", x: 2, expected: "aX界b", note: "the second cell of a wide glyph targets that glyph" },
    { text: "a界b", x: 3, expected: "a界Xb", note: "the cell after a wide glyph" },
    { text: "éxy", x: 1, expected: "éXxy", note: "a combining mark stays with its base" },
    { text: "👍🏽ok", x: 1, expected: "X👍🏽ok", note: "a modified emoji is one two-cell grapheme" },
    { text: "👍🏽ok", x: 2, expected: "👍🏽Xok", note: "the cell after the emoji" },
  ];
  for (const { text, x, expected, note } of cases) {
    const field = nameField(text);
    try {
      field.render(30, 5);
      assert.equal(caretClick(field, x, 1, 30, 5), true, note);
      field.handleInput("X");
      assert.equal(field.getText(), expected, note);
    } finally {
      field.dispose();
    }
  }
});

test("wrapped rows use the Editor's visual-line map, including its native continuation end column", () => {
  const field = nameField("abcdefghijklmno");
  try {
    const frame = field.render(12, 8);
    assert.equal(frame.lines[1]?.trimEnd(), "abcdefghijk");
    assert.equal(frame.lines[2]?.trimEnd(), "lmno");
    assert.equal(caretClick(field, 1, 2, 12, 8), true);
    field.handleInput("X");
    assert.equal(field.getText(), "abcdefghijklXmno", "a click on the wrapped row lands in that row's text");

    const clipped = nameField("abcdefghijklmno");
    try {
      clipped.render(12, 8);
      // Past the end of a non-final wrapped segment the native Editor keeps the
      // caret on that segment's last grapheme; this is preserved, not "fixed".
      assert.equal(caretClick(clipped, 11, 1, 12, 8), true);
      clipped.handleInput("X");
      assert.equal(clipped.getText(), "abcdefghijXklmno");
    } finally {
      clipped.dispose();
    }
  } finally {
    field.dispose();
  }
});

test("a vertically scrolled value maps through the Editor's own scroll window", () => {
  // Width 6 lays out five-character chunks; terminal rows 8 keep five visible
  // lines, so the caret at the end scrolls the first chunk out of view.
  const field = nameField("aaaaabbbbbcccccdddddeeeeefffff");
  try {
    const frame = field.render(6, 8);
    assert.notEqual(frame.lines[0], "─".repeat(6), "the top border is the native scroll border, not a plain rule");
    assert.equal(frame.lines[1]?.trimEnd(), "bbbbb", "the first drawn body row is the second chunk");
    assert.equal(caretClick(field, 0, 1, 6, 8), true);
    field.handleInput("X");
    assert.equal(field.getText(), "aaaaaXbbbbbcccccdddddeeeeefffff");
  } finally {
    field.dispose();
  }
});

test("clipped frames, borders, and other widths are not editable targets", () => {
  const field = nameField("draft text");
  try {
    field.render(20, 2); // top border + first body row only
    assert.equal(caretClick(field, 2, 0, 20, 2), false, "the top border row");
    assert.equal(caretClick(field, 2, 2, 20, 3), false, "a row the clipped frame never drew");
    assert.equal(field.handleMouse(hostCaretEvent("editor", 2, 1, 19, 2)), undefined, "a width the render did not use");
    assert.equal(field.handleMouse({ ...hostCaretEvent("editor", 2, 1, 20, 2), type: "press" }), undefined,
      "only the native completed click positions the caret");
    assert.deepEqual(field.getCursor(), { line: 0, col: 10 }, "nothing moved");
    assert.equal(caretClick(field, 2, 1, 20, 2), true, "the drawn body row works");
    field.handleInput("X");
    assert.equal(field.getText(), "drXaft text");

    field.render(20, 6);
    assert.equal(caretClick(field, 2, 2, 20, 6), false, "the bottom border row");
  } finally {
    field.dispose();
  }
});

test("a frame made stale by input, a resize, or disposal refuses the click", () => {
  const field = nameField("hello");
  try {
    field.render(20, 5);
    const staleKey = field.mouseFrameKey();
    assert.ok(staleKey !== undefined);
    field.handleInput("!");
    assert.equal(field.mouseFrameKey(), undefined, "typing retires the drawn frame");
    assert.equal(caretClick(field, 1, 1, 20, 5), false, "an undrawn edit refuses the press");
    assert.deepEqual(field.getCursor(), { line: 0, col: 6 });
    field.render(20, 5);
    assert.notEqual(field.mouseFrameKey(), staleKey, "the new frame has its own identity");
    assert.equal(caretClick(field, 1, 1, 20, 5), true);
    field.handleInput("X");
    assert.equal(field.getText(), "hXello!");
  } finally {
    field.dispose();
  }
  assert.equal(field.mouseFrameKey(), undefined);
  assert.equal(caretClick(field, 1, 1, 20, 5), false, "a disposed field refuses");

  let cancelled = false;
  const settled = nameField("hello", { onCancel: () => { cancelled = true; } });
  settled.render(20, 5);
  settled.handleInput(ESCAPE);
  assert.equal(cancelled, true);
  assert.equal(caretClick(settled, 1, 1, 20, 5), false, "a settled field refuses");
  settled.dispose();
});

test("a bracketed paste in flight refuses the click; a completed paste lands at the clicked caret", () => {
  const field = nameField("abcdef");
  try {
    field.render(20, 5);
    assert.equal(caretClick(field, 2, 1, 20, 5), true);
    field.render(20, 5);
    field.handleInput(`${PASTE_START}12`);
    field.render(20, 5);
    assert.equal(caretClick(field, 5, 1, 20, 5), false, "no caret move while the paste is assembled");
    field.handleInput(`3${PASTE_END}`);
    assert.equal(field.getText(), "ab123cdef", "the paste landed at the caret the click placed before it");
    field.render(20, 5);
    assert.equal(caretClick(field, 0, 1, 20, 5), true);
    field.handleInput(`${PASTE_START}Z${PASTE_END}`);
    assert.equal(field.getText(), "Zab123cdef");
  } finally {
    field.dispose();
  }
});

test("keyboard navigation, undo, and an armed character jump keep their native behavior after a click", () => {
  const field = nameField("alpha beta");
  try {
    field.render(30, 5);
    assert.equal(caretClick(field, 6, 1, 30, 5), true);
    type(field, "big");
    assert.equal(field.getText(), "alpha bigbeta");
    field.handleInput(UNDO);
    assert.equal(field.getText(), "alpha beta", "native undo removes the typed word at the clicked caret");
    field.handleInput(HOME);
    field.handleInput("<");
    field.handleInput(END);
    field.handleInput(">");
    assert.equal(field.getText(), "<alpha beta>", "Home/End still navigate");

    // Arm the native character jump, click, then press the target: the native
    // Editor keeps the jump armed across a click, so the key jumps rather
    // than inserting.
    field.render(30, 5);
    field.handleInput(JUMP_FORWARD);
    field.render(30, 5);
    assert.equal(caretClick(field, 0, 1, 30, 5), true);
    field.handleInput("b");
    assert.equal(field.getText(), "<alpha beta>", "the armed jump consumed the key exactly as natively");
    field.handleInput("_");
    assert.equal(field.getText(), "<alpha _beta>", "the jump moved the caret to the next 'b'");
  } finally {
    field.dispose();
  }
});

test("a rejected native edit rolls back to the clicked caret, not the pre-click one", () => {
  const rejections: SessionHostFieldRejection[] = [];
  const field = nameField("abcdef", { maxNameBytes: 7, onReject: (reason) => rejections.push(reason) });
  try {
    field.render(20, 5);
    assert.equal(caretClick(field, 3, 1, 20, 5), true);
    field.handleInput(CTRL_K); // kill "def"
    assert.equal(field.getText(), "abc");
    field.handleInput(CTRL_Y); // yank it back at the end
    assert.equal(field.getText(), "abcdef");
    field.render(20, 5);
    assert.equal(caretClick(field, 1, 1, 20, 5), true);
    field.handleInput(CTRL_Y); // "adefbcdef" exceeds the limit
    assert.deepEqual(rejections, ["text-limit"]);
    assert.equal(field.getText(), "abcdef", "the rejected yank was rolled back");
    assert.deepEqual(field.getCursor(), { line: 0, col: 1 }, "the caret is the clicked one");
    field.handleInput("X");
    assert.equal(field.getText(), "aXbcdef");
  } finally {
    field.dispose();
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a visible completion list: body text takes host clicks, completion rows never do; provenance survives a caret-only click", async (t: TestContext) => {
  const base = mkdtempSync(join(tmpdir(), "text-field-mouse-complete-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "alpha-one"));
  mkdirSync(join(base, "alpha-two"));
  writeFileSync(join(base, "zeta.txt"), "");
  const submissions: SessionHostFieldSubmission[] = [];
  const field = createSessionHostTextField({
    kind: "path", workspaceBasePath: base, onSubmit: (value) => submissions.push(value),
  });
  try {
    type(field, "al");
    field.handleInput(TAB);
    await waitFor(() => field.isShowingAutocomplete());
    assert.equal(field.isShowingAutocomplete(), true, "two matches keep the native list open");
    const listed = field.render(40, 12).lines.map((line) => line.trimEnd());
    // Top border, the one body row, the bottom border, then the native list.
    assert.equal(listed[1], "al", `the editable body row:\n${listed.join("\n")}`);
    const itemRows = listed.flatMap((line, row) => /alpha-(one|two)/u.test(line) ? [row] : []);
    assert.equal(itemRows.length, 2, `both completion items are drawn:\n${listed.join("\n")}`);
    assert.ok(itemRows.every((row) => row >= 3), "completion rows sit below the Editor's bottom border");
    for (const row of [...itemRows, 2]) {
      for (const x of [0, 2, 6]) {
        assert.equal(caretClick(field, x, row, 40, 12), false, `a host click at (${x}, ${row}) is not body text`);
      }
    }
    assert.equal(field.getText(), "al", "no host click applied or confirmed a completion item");
    assert.deepEqual(field.getCursor(), { line: 0, col: 2 }, "no refused click moved the caret");
    assert.equal(field.isShowingAutocomplete(), true, "the list stays open after refused clicks");

    // The editable body text itself is clickable while the list is visible.
    assert.equal(caretClick(field, 1, 1, 40, 12), true, "the body text accepts the host click with the list visible");
    assert.deepEqual(field.getCursor(), { line: 0, col: 1 }, "the native Editor placed the caret between a and l");
    assert.equal(field.getText(), "al", "the caret click applied no completion");
    field.handleInput("X");
    assert.equal(field.getText(), "aXl", "the next key edited at the clicked caret");
    if (field.isShowingAutocomplete()) field.handleInput(ESCAPE); // native first Escape dismisses the list only
    assert.equal(field.isShowingAutocomplete(), false);
    assert.equal(field.setText("al"), true);
    field.handleInput("p");
    field.handleInput("h");
    field.handleInput("a");
    field.handleInput("-");
    field.handleInput("t");
    field.handleInput(TAB);
    await waitFor(() => field.getText() !== "alpha-t");
    const completed = field.getText();
    assert.match(completed, /alpha-two/u, "the single match was applied natively");
    field.render(40, 12);
    assert.equal(caretClick(field, 0, 1, 40, 12), true);
    field.handleInput(ENTER);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.source, "native-completion", "a caret-only click keeps completion provenance");

    const edited = createSessionHostTextField({
      kind: "path", workspaceBasePath: base, onSubmit: (value) => submissions.push(value),
    });
    try {
      type(edited, "zet");
      edited.handleInput(TAB);
      await waitFor(() => edited.getText() !== "zet");
      edited.render(40, 12);
      assert.equal(caretClick(edited, 0, 1, 40, 12), true);
      edited.handleInput("X");
      edited.handleInput(ENTER);
      assert.equal(submissions[1]?.source, "typed", "an edit after the click drops completion provenance");
      assert.ok(submissions[1]?.text.startsWith("X"), "the edit landed at the clicked caret");
    } finally {
      edited.dispose();
    }
  } finally {
    field.dispose();
  }
});

// ---------------------------------------------------------------------------
// The pinned Input through the same seam
// ---------------------------------------------------------------------------

test("the pinned Input maps a press through its horizontal scroll window", () => {
  const input = new Input();
  input.focused = true;
  for (const character of "/srv/example") input.handleInput(character);
  const region = { left: 0, top: 3, width: 30, rows: 1, firstRow: 0, height: 1 };
  input.render(30);
  const pressed = routeNativeTextFieldMouse(
    { handleMouse: (event) => input.handleMouse(completeNativeMouseEvent(event)) },
    hostCaretEvent("input", 2 + 5, 3, 40, 10),
    region,
  );
  assert.equal(nativeMouseHandled(pressed), true);
  input.handleInput("X");
  assert.equal(input.getValue(), "/srv/Xexample");

  // A long value scrolled to its end: the first drawn cell is not value column 0.
  const scrolled = new Input();
  const long = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (const character of long) scrolled.handleInput(character);
  const line = scrolled.render(12)[0] ?? "";
  const target = { handleMouse: (event: TextFieldMouseEvent) => scrolled.handleMouse(completeNativeMouseEvent(event)) };
  assert.equal(nativeMouseHandled(routeNativeTextFieldMouse(target, hostCaretEvent("input", 2, 0, 12, 1),
    { left: 0, top: 0, width: 12, rows: 1, firstRow: 0, height: 1 })), true);
  scrolled.handleInput("X");
  const value = scrolled.getValue();
  const inserted = value.indexOf("X");
  assert.ok(inserted > 0, `the press mapped into the scrolled window (${JSON.stringify(line)} -> ${value})`);
  assert.equal(value.replace("X", ""), long);
});
