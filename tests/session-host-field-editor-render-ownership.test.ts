/**
 * Render ownership at the field adapter's native Editor seam (issue #725).
 *
 * `SessionHostTextField.render` consumes the rows the pinned public `Editor`
 * returns. Pi's own Component contract makes those rows borrowed, not owned:
 * the result is read-only, a component may hand back the SAME cached array
 * while nothing changed, and callers must copy before modifying it. Rewriting
 * a borrowed row in place would therefore corrupt the component's own render
 * cache — and on a frozen array it throws outright.
 *
 * Every test here forces that production seam to receive one shared rows object
 * over and over — frozen in most cases, and one plain mutable caching
 * component's array in another — which is exactly what a caching component
 * returns, and pins that the adapter never writes back while the painted lines,
 * the border and caret geometry, and the body-boundary caret fence stay what the
 * real Editor produces. The shared rows are installed on the field's own public
 * `editor` instance, so no production seam exists for the tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionHostTextField,
  type SessionHostTextField,
} from "../src/session-host/field-editor";
import { hostCaretEvent } from "../src/text-field-mouse";

const COLS = 40;
const ROWS = 6;
/** The Editor's own bottom border row for a one-line value at this frame size. */
const BOTTOM_BORDER_ROW = 2;

function nameField(initialText: string): SessionHostTextField {
  return createSessionHostTextField({ kind: "name", initialText });
}

/**
 * Make the field's own public `Editor` instance hand back one frozen rows
 * object on every render, the way a caching pi-tui component does. This only
 * shadows the prototype method on that instance; the field adapter, its
 * protected bottom-border hook, and every editing rule stay untouched.
 */
function borrowSharedRows(editor: SessionHostTextField["editor"], rows: readonly string[]): void {
  const owner = editor as unknown as { render(width: number): readonly string[] };
  owner.render = () => rows;
}

/** Capture one real render's rows as the shared, frozen array a caching component would reuse. */
function sharedRowsFrom(field: SessionHostTextField): readonly string[] {
  // Render once for real first, so the rows are captured with the field's own
  // terminal geometry and autocomplete settings already applied.
  field.render(COLS, ROWS);
  return Object.freeze([...field.editor.render(COLS)]);
}

test("the field never rewrites the Editor's borrowed rows across repeated renders", () => {
  // What the real Editor paints at this size, with no test seam in place.
  const reference = nameField("draft");
  let referenceFrame;
  try {
    referenceFrame = reference.render(COLS, ROWS);
  } finally {
    reference.dispose();
  }

  const field = nameField("draft");
  try {
    const shared = sharedRowsFrom(field);
    const snapshot = [...shared];
    borrowSharedRows(field.editor, shared);

    const first = field.render(COLS, ROWS);
    const firstKey = field.mouseFrameKey();
    const second = field.render(COLS, ROWS);

    assert.notEqual(firstKey, undefined, "the reused frame is accepted as the drawn frame");
    assert.equal(field.mouseFrameKey(), firstKey,
      "an identical reused frame keeps one drawn-frame identity, which is what a host compares at press time");
    assert.deepEqual([...shared], snapshot, "rendering never writes into the rows the Editor returned");
    assert.ok(Object.isFrozen(shared), "the reused rows are read-only, as Pi's Component contract declares");
    assert.ok(shared.some((row) => row.includes("\x07")),
      "the Editor's rows keep their BEL-terminated render tags after the field rendered them");

    assert.deepEqual(second.lines, first.lines, "reusing the same rows paints the same lines");
    assert.deepEqual(second.cursor, first.cursor, "reusing the same rows reports the same caret");
    assert.equal(second.contentRow, first.contentRow, "the editable body anchor is unchanged");
    assert.deepEqual(first.lines, referenceFrame.lines,
      "the borrowed-rows frame paints exactly what the real Editor paints");
    assert.deepEqual(first.cursor, referenceFrame.cursor, "with the real Editor's caret geometry");
    assert.equal(first.contentRow, referenceFrame.contentRow);

    // The frame the caller receives is the adapter's own array, never the
    // Editor's shared one, so a host can keep or reshape it safely.
    assert.notEqual(first.lines, second.lines, "each render hands back its own lines array");
    assert.notEqual(first.lines, shared);
    assert.ok(first.lines.every((line) => !line.includes("\x1b") && !line.includes("\x07")),
      "no native render tag survives into pane text");
  } finally {
    field.dispose();
  }
});

test("the body-boundary caret fence still works when the same rows are reused", () => {
  const field = nameField("draft text");
  try {
    borrowSharedRows(field.editor, sharedRowsFrom(field));

    field.render(COLS, ROWS);
    assert.notEqual(field.mouseFrameKey(), undefined, "the reused frame is still accepted as the drawn frame");
    assert.notEqual(field.handleMouse(hostCaretEvent("editor", 3, 1, COLS, ROWS)), undefined,
      "the drawn editable body row still takes a host caret click, so the tagged bottom border was counted");

    field.render(COLS, ROWS);
    assert.equal(field.handleMouse(hostCaretEvent("editor", 3, BOTTOM_BORDER_ROW, COLS, ROWS)), undefined,
      "the tagged bottom border row and everything below it stay non-editable on a reused frame");

    field.render(COLS, ROWS);
    assert.equal(field.handleMouse({ ...hostCaretEvent("editor", 3, 1, COLS + 1, ROWS) }), undefined,
      "a width the reused frame was not rendered at is still refused");
  } finally {
    field.dispose();
  }
});

test("a reused but mutable rows array is never rewritten, so the next frame keeps its fence", () => {
  // A caching pi-tui Container keeps a plain mutable array and simply declares
  // it read-only, so the realistic failure is silent corruption, not a throw:
  // a tag stripped out of the shared rows disappears from every later frame
  // and the body/completion boundary quietly stops existing.
  const field = nameField("draft text");
  try {
    field.render(COLS, ROWS);
    const shared = [...field.editor.render(COLS)];
    const snapshot = [...shared];
    borrowSharedRows(field.editor, shared);

    const first = field.render(COLS, ROWS);
    const second = field.render(COLS, ROWS);

    assert.deepEqual([...shared], snapshot,
      "the adapter never strips its own body-boundary tag out of the rows a component reuses");
    assert.deepEqual(second.lines, first.lines, "the next frame still paints the same lines");
    assert.notEqual(field.handleMouse(hostCaretEvent("editor", 3, 1, COLS, ROWS)), undefined,
      "the second frame still knows where its editable body rows end");
  } finally {
    field.dispose();
  }
});

test("a wrapped value keeps its painted rows and caret across reused renders", () => {
  const reference = nameField("abcdefghijklmno");
  let referenceFrame;
  try {
    referenceFrame = reference.render(12, 8);
  } finally {
    reference.dispose();
  }

  const field = nameField("abcdefghijklmno");
  try {
    field.render(12, 8);
    const shared = Object.freeze([...field.editor.render(12)]);
    const snapshot = [...shared];
    borrowSharedRows(field.editor, shared);

    const first = field.render(12, 8);
    const second = field.render(12, 8);

    assert.deepEqual([...shared], snapshot, "a wrapped value's rows are borrowed too");
    assert.deepEqual(second.lines, first.lines);
    assert.deepEqual(second.cursor, first.cursor);
    assert.deepEqual(first.lines, referenceFrame.lines, "the wrapped painted lines match the real Editor");
    assert.deepEqual(first.cursor, referenceFrame.cursor, "including the caret on its wrapped tail row");
    assert.equal(first.contentRow, 1, "the editable body anchor stays below the Editor's top border");
  } finally {
    field.dispose();
  }
});
