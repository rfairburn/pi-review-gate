/**
 * The field adapter's editable-body anchor (#482 field-label alignment).
 *
 * A host that labels a session-host field must place the label beside the row
 * that actually carries the editable content, and that row must stay put while
 * the caret moves. `SessionHostTextField.render` reports it from the pinned
 * public Editor's own layout contract — top border first, editable rows after
 * it — instead of making every pane re-derive it from the caret or from
 * rendered text. These tests drive the real pinned Editor; no fake renderer and
 * no session screen-text scraping is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSessionHostTextField } from "../src/session-host/field-editor";

const HOME = "\x1b[H";
const END = "\x1b[4~";

function nameField(initialText = "") {
  return createSessionHostTextField({ kind: "name", initialText });
}

test("the field render names the Editor's editable body row below its own top border", () => {
  const field = nameField();
  try {
    const frame = field.render(40, 6);
    assert.equal(frame.contentRow, 1, "the public Editor's editable body starts after its top border");
    assert.equal(frame.lines[0], "─".repeat(40), "row 0 is the Editor's own top border row");
    assert.equal((frame.lines[frame.contentRow] ?? "").trim(), "", "the body row is the empty editable row");
    assert.equal(frame.cursor.row, frame.contentRow, "an empty field's caret is on the body row");
    assert.equal(frame.lines.at(-1), "─".repeat(40), "the bottom border stays a separate, unlabeled row");
  } finally {
    field.dispose();
  }
});

test("the editable body anchor never follows the caret across a wrapped value", () => {
  const field = nameField("abcdefghijklmno");
  try {
    const wrapped = field.render(12, 8);
    assert.equal(wrapped.contentRow, 1, "a wrapped value keeps the same body anchor");
    assert.equal(wrapped.lines[0], "─".repeat(12));
    assert.equal((wrapped.lines[1] ?? "").trimEnd(), "abcdefghijk",
      "the anchor row carries the first wrapped segment of the value");
    assert.ok(wrapped.cursor.visible, "the native caret is inside the bounded frame");
    assert.ok(wrapped.cursor.row > wrapped.contentRow,
      `the caret sits on a later wrapped row than the anchor: ${JSON.stringify(wrapped.cursor)}`);

    field.handleInput(END);
    const atEnd = field.render(12, 8);
    assert.equal(atEnd.contentRow, 1, "End keeps the anchor");
    assert.ok(atEnd.cursor.row > atEnd.contentRow, "the caret is still on the wrapped tail row");

    field.handleInput(HOME);
    const atHome = field.render(12, 8);
    assert.equal(atHome.contentRow, 1, "Home keeps the anchor");
    assert.equal(atHome.cursor.row, atHome.contentRow,
      "the caret returning to the first body row coincides with the anchor again");
    assert.equal((atHome.lines[atHome.contentRow] ?? "").trimEnd().startsWith("abcdefghijk"), true,
      "the anchor row still carries the start of the value");
  } finally {
    field.dispose();
  }
});

test("a frame clipped to the border alone reports no editable body row", () => {
  const field = nameField("draft");
  try {
    const borderOnly = field.render(12, 1);
    assert.equal(borderOnly.lines.length, 1, "the bounded frame holds only the Editor's top border");
    assert.ok(borderOnly.contentRow >= borderOnly.lines.length,
      "the reported body row lies outside a border-only frame, so a labeling host refuses it");
    assert.equal(borderOnly.cursor.visible, false, "a border-only frame shows no native caret either");

    // One row more reaches the body row, and the caret is inside it.
    const usable = field.render(12, 2);
    assert.ok(usable.contentRow < usable.lines.length, "the body row is inside a two-row frame");
    assert.equal(usable.cursor.visible, true);
    assert.equal(usable.cursor.row, usable.contentRow);
    assert.equal((usable.lines[usable.contentRow] ?? "").trim(), "draft");
  } finally {
    field.dispose();
  }
});
