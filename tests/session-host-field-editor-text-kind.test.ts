/**
 * Focused regression tests for the generic `text` kind of the shared session-host
 * text field (issue #653 groundwork).
 *
 * The contract these tests pin is exactly two-sided:
 *
 * - A generic `text` field edits a long, multi-line persisted-settings value
 *   (a scheduled instruction or the shared URL blocklist) with the SAME pinned
 *   public Editor every other session-host field uses: full prefill with no
 *   truncation, native keyboard editing, the native newLine chord, bracketed
 *   paste, clear, cancel, and the host-owned external-editor seam.
 * - Every pre-existing rule is unchanged: name and path bounds, the single-line
 *   paste/control sanitization, the paste/input-chunk byte budget, Enter as the
 *   submit chord, and the host's ownership of the external-editor process.
 *
 * No terminal, process, filesystem, or configuration work is involved: the
 * external editor stays the injected host callback it has always been.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { getKeybindings, matchesKey, visibleWidth } from "pi-session-host-tui";
import {
  createSessionHostTextField,
  MAX_TEXT_FIELD_BYTES,
  type SessionHostFieldRejection,
  type SessionHostFieldSubmission,
} from "../src/session-host/field-editor";
import { MAX_RENAME_NAME_BYTES } from "../src/session-host/protocol";
import { MAX_NATIVE_CONFIG_BYTES } from "../src/session-host/launch";

const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const CTRL_G = "\x07";
const CTRL_J = "\n";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

interface TextFieldOptions {
  readonly multiline?: boolean;
  readonly maxTextBytes?: number;
  readonly initialText?: string;
  readonly onChange?: (text: string) => void;
  readonly onReject?: (reason: SessionHostFieldRejection) => void;
  readonly onSubmit?: (submission: SessionHostFieldSubmission) => void;
  readonly onCancel?: () => void;
  readonly onExternalEditor?: (
    text: string,
    maxTextBytes?: number,
    preserveFinalLineTerminator?: boolean,
  ) => string | undefined | Promise<string | undefined>;
}

function makeTextField(options: TextFieldOptions = {}) {
  return createSessionHostTextField({
    kind: "text",
    ...(options.multiline === undefined ? {} : { multiline: options.multiline }),
    ...(options.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
    ...(options.initialText === undefined ? {} : { initialText: options.initialText }),
    ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
    ...(options.onReject === undefined ? {} : { onReject: options.onReject }),
    ...(options.onSubmit === undefined ? {} : { onSubmit: options.onSubmit }),
    ...(options.onCancel === undefined ? {} : { onCancel: options.onCancel }),
    ...(options.onExternalEditor === undefined ? {} : { onExternalEditor: options.onExternalEditor }),
  });
}

function typeText(field: ReturnType<typeof makeTextField>, text: string): void {
  for (const character of text) field.handleInput(character);
}

function paste(field: ReturnType<typeof makeTextField>, body: string): void {
  field.handleInput(`${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`);
}

function pasteInChunks(field: ReturnType<typeof makeTextField>, body: string, chunkSize: number): void {
  field.handleInput(BRACKETED_PASTE_START);
  for (let index = 0; index < body.length; index += chunkSize) {
    field.handleInput(body.slice(index, index + chunkSize));
  }
  field.handleInput(BRACKETED_PASTE_END);
}

/** One realistic long persisted-settings value: many lines, well over 8 KiB. */
function longInstructions(): string {
  const line = "Run the nightly integration sweep, collect the report, and file any regression. ";
  return Array.from({ length: 120 }, (_unused, index) => `${index + 1}. ${line}#${index}`).join("\n");
}

// ---------------------------------------------------------------------------
// The generic text kind: shape and bounds
// ---------------------------------------------------------------------------

test("the generic text bound is the existing persisted-config bound, never an invented smaller one", () => {
  assert.equal(MAX_TEXT_FIELD_BYTES, MAX_NATIVE_CONFIG_BYTES);
  // A value the persisted config could hold is editable in full: this is far
  // above the 8192-byte external-editor default and far below the config cap.
  const value = "x".repeat(200_000);
  const field = makeTextField({ multiline: true, initialText: value });
  assert.equal(field.getText(), value);
  assert.equal(field.getValue(), value);
});

test("an explicit maxTextBytes is honoured, bounded by the config cap, and never truncates", () => {
  const rejections: SessionHostFieldRejection[] = [];
  const field = makeTextField({
    multiline: true,
    maxTextBytes: 64,
    initialText: "short value",
    onReject: (reason) => rejections.push(reason),
  });
  assert.equal(field.getText(), "short value");
  typeText(field, "y".repeat(60));
  assert.ok(rejections.includes("text-limit"), `expected a text-limit rejection, got ${JSON.stringify(rejections)}`);
  assert.ok(field.getText().startsWith("short value"), "the accepted value is never rewritten");
  assert.equal(
    Buffer.byteLength(field.getText(), "utf8"),
    64,
    "input fills to the bound and the excess is refused: nothing is silently truncated or accepted over the bound",
  );

  assert.throws(() => makeTextField({ maxTextBytes: 0 }), /maxTextBytes must be an integer/);
  assert.throws(
    () => makeTextField({ maxTextBytes: MAX_TEXT_FIELD_BYTES + 1 }),
    /maxTextBytes must be an integer/,
    "no field may exceed the persisted config file's own size bound",
  );
});

// ---------------------------------------------------------------------------
// Multi-line values: prefill, keyboard, paste, submit
// ---------------------------------------------------------------------------

test("a long multi-line settings value prefills, edits, and submits with no truncation", () => {
  const value = longInstructions();
  assert.ok(Buffer.byteLength(value, "utf8") > 8_192, "the fixture is genuinely past the external-editor default");
  const rejections: SessionHostFieldRejection[] = [];
  let submission: SessionHostFieldSubmission | undefined;
  const field = makeTextField({
    multiline: true,
    initialText: value,
    onReject: (reason) => rejections.push(reason),
    onSubmit: (next) => {
      submission = next;
    },
  });

  assert.equal(field.getText(), value, "prefill is byte-exact");
  assert.deepEqual(rejections, [], "a valid long value is never rejected");

  // The prefill leaves the native caret at the end of the value, so typing
  // lands there and the stored value only ever grows.
  const before = field.getText();
  typeText(field, "EDIT: ");
  assert.equal(field.getText(), `${before}EDIT: `, "typing lands at the caret and nothing is dropped");
  assert.ok(field.getText().startsWith("1. "), "the head of the value survives");
  assert.equal(field.getText().length, before.length + 6);

  field.handleInput(ENTER);
  assert.ok(submission !== undefined, "Enter submits the field");
  assert.equal(submission?.source, "typed");
  assert.equal(submission?.value, field.getText());
  assert.ok(submission!.value.includes("\n"), "the submitted value is still multi-line");
});

test("the native newLine chord inserts line breaks while Enter stays the submit chord", () => {
  let submits = 0;
  const field = makeTextField({ multiline: true, initialText: "first", onSubmit: () => { submits += 1; } });

  let expected = "first";

  // ctrl+j is Pi's published `tui.input.newLine` default.
  field.handleInput(CTRL_J);
  typeText(field, "second");
  expected += "\nsecond";
  assert.equal(field.getText(), expected);

  // shift+enter is the other published default and reaches the same chord.
  if (matchesKey("\x1b[13;2~", "shift+enter")) {
    field.handleInput("\x1b[13;2~");
    typeText(field, "third");
    expected += "\nthird";
    assert.equal(field.getText(), expected);
  }

  // Backspace crosses the break like any other edit.
  field.handleInput("\x7f");
  expected = expected.slice(0, -1);
  assert.equal(field.getText(), expected);

  // Enter still submits rather than inserting a line.
  field.handleInput(ENTER);
  assert.equal(submits, 1);
});

test("a pasted multi-line body keeps its line breaks and stays inside the unchanged paste budget", () => {
  const field = makeTextField({ multiline: true, initialText: "" });
  paste(field, "one\r\ntwo\rtree\x1b[31m four\x07\n\nfive\u2028six");
  assert.equal(field.getText(), "one\ntwo\ntree four\n\nfivesix", "CR/CRLF normalize to LF and terminal controls are stripped");

  // The paste byte budget itself is the existing one, unchanged for this kind.
  const rejections: SessionHostFieldRejection[] = [];
  const bounded = makeTextField({ multiline: true, onReject: (reason) => rejections.push(reason) });
  pasteInChunks(bounded, "y".repeat(8_193), 1024);
  assert.deepEqual(rejections, ["paste-limit"]);
  assert.equal(bounded.getText(), "", "an over-budget paste inserts nothing at all");
});

test("a text field without multiline keeps the unchanged strict single-line rule", () => {
  assert.throws(
    () => makeTextField({ initialText: "one\ntwo" }),
    /initial text must be safe single-line text/,
    "a single-line text field cannot be prefilled with a line break",
  );

  // Measured against the base commit before this change: a bare LF (ctrl+J)
  // resolves through the submit binding for `name` and `path` and submits — it
  // is not refused. A single-line `text` field must land on exactly that same
  // existing behaviour, kind for kind, and only the new explicitly multi-line
  // kind inserts a break instead (next test file section).
  const outcomes: Record<string, string> = {};
  const cases: ReadonlyArray<readonly [string, { readonly kind: "name" } | { readonly kind: "path"; readonly workspaceBasePath: string } | { readonly kind: "text" }]> = [
    ["name", { kind: "name" }],
    ["path", { kind: "path", workspaceBasePath: process.cwd() }],
    ["text", { kind: "text" }],
  ];
  for (const [label, options] of cases) {
    let submitted = 0;
    const rejected: SessionHostFieldRejection[] = [];
    const field = createSessionHostTextField({
      ...options,
      initialText: "alpha",
      onSubmit: () => { submitted += 1; },
      onReject: (reason) => rejected.push(reason),
    });
    field.handleInput(CTRL_J);
    outcomes[label] = `${submitted} submit, ${rejected.length} rejection, text ${JSON.stringify(field.getText())}`;
  }
  assert.equal(outcomes.text, outcomes.name, `ctrl+J parity with name: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.text, outcomes.path, `ctrl+J parity with path: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.text, "1 submit, 0 rejection, text \"alpha\"");

  // A pasted line break is stripped for a single-line field, byte-for-byte the
  // base commit's name-field behaviour ("alpha" + "one\r\ntwo" -> "alphaonetwo").
  const field = makeTextField({ initialText: "alpha" });
  paste(field, "one\r\ntwo");
  assert.equal(field.getText(), "alphaonetwo", "a pasted line break is stripped, exactly as before");
});

test("rendering a multi-line value stays inside the pane with every row clipped to its columns", () => {
  const field = makeTextField({ multiline: true, initialText: longInstructions() });
  const cols = 40;
  const rows = 6;
  const frame = field.render(cols, rows);
  assert.ok(frame.lines.length <= rows, "the field never overflows the pane");
  assert.equal(frame.contentRow, 1, "the editable body row is the Editor's own structural row");
  for (const line of frame.lines) {
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), "no raw escape survives outside a generated SGR");
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than the pane: ${visibleWidth(text)} > ${cols}`);
  }
  assert.equal(field.getText(), longInstructions(), "clipping a render never changes the value");
});

// ---------------------------------------------------------------------------
// Ownership seams: clear, cancel, external editor
// ---------------------------------------------------------------------------

test("clear and cancel keep their existing ownership on a generic text field", () => {
  let cancels = 0;
  const field = makeTextField({ multiline: true, initialText: "keep\nme", onCancel: () => { cancels += 1; } });

  field.handleInput(CTRL_C);
  assert.equal(field.getText(), "");
  assert.equal(cancels, 0, "clear is not a cancel");

  typeText(field, "typed\nline");
  field.handleInput(ESCAPE);
  assert.equal(cancels, 1);
  assert.equal(field.isShowingAutocomplete(), false);

  // A settled field accepts no further input.
  typeText(field, "late");
  assert.equal(field.getText(), "typed\nline");
});

test("the external-editor seam reports the text field's bound and applies a long multi-line result whole", async () => {
  const calls: Array<[string, number | undefined, boolean | undefined]> = [];
  const edited = `${longInstructions()}\nfinal line`;
  const field = makeTextField({
    multiline: true,
    initialText: "stale\nvalue",
    onExternalEditor: (text, maxTextBytes, preserveFinalLineTerminator) => {
      calls.push([text, maxTextBytes, preserveFinalLineTerminator]);
      return edited;
    },
  });

  field.handleInput(CTRL_G);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(calls.map((call) => call[0]), ["stale\nvalue"]);
  assert.deepEqual(calls.map((call) => call[1]), [MAX_TEXT_FIELD_BYTES]);
  // The host's only signal that a trailing newline is content, not the
  // temporary file's closing newline, so it can preserve it end to end.
  assert.deepEqual(calls.map((call) => call[2]), [true]);
  assert.equal(field.getText(), edited, "the host's result is applied byte-exact, with no trimming");
});

test("a single-line text field reports that no final line terminator needs preserving", async () => {
  const preserve: Array<boolean | undefined> = [];
  const field = makeTextField({
    initialText: "one-line",
    onExternalEditor: (_text, _maxTextBytes, preserveFinalLineTerminator) => {
      preserve.push(preserveFinalLineTerminator);
      return "kept";
    },
  });

  field.handleInput(CTRL_G);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(preserve, [false], "a single-line value keeps the existing terminator removal");
});

test("name and path fields keep the one-argument external-editor call and their own unchanged limits", async () => {
  const nameCalls: unknown[][] = [];
  const nameField = createSessionHostTextField({
    kind: "name",
    initialText: "a-name",
    // A real function expression, so `arguments.length` proves the arity the
    // field actually used rather than an enclosing scope's.
    onExternalEditor(this: unknown, text: string) {
      nameCalls.push([text, arguments.length]);
      return "one\ntwo";
    },
  });
  nameField.handleInput(CTRL_G);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(
    nameCalls,
    [["a-name", 1]],
    "an existing kind receives exactly one argument, as it always did",
  );
  assert.equal(nameField.getText(), "a-name", "a multi-line result is refused, not silently flattened");

  // The unchanged name byte limit still applies.
  const rejections: SessionHostFieldRejection[] = [];
  const boundedName = createSessionHostTextField({ kind: "name", onReject: (reason) => rejections.push(reason) });
  boundedName.handleInput("n".repeat(MAX_RENAME_NAME_BYTES + 1));
  assert.ok(rejections.includes("text-limit"));

  // The unchanged path code-point limit still applies.
  const pathRejections: SessionHostFieldRejection[] = [];
  const pathField = createSessionHostTextField({
    kind: "path",
    workspaceBasePath: process.cwd(),
    onReject: (reason) => pathRejections.push(reason),
  });
  pathField.handleInput("/".repeat(2_049));
  assert.ok(pathRejections.includes("text-limit"));
  assert.equal(pathField.getText(), "");
});

test("a generic text field installs no filesystem completion at all", () => {
  const field = makeTextField({ multiline: true, initialText: "/" });
  assert.equal(field.nativeAutocompleteProvider, undefined);
  assert.equal(field.autocompleteProvider, undefined);
  assert.equal(field.workspaceBasePath, undefined);
});

test("the shared field manager default is unaffected by the new kind", () => {
  // The new kind changes no global keybinding state: the live manager is still
  // the host's own, and a text field resolves its chords through it.
  const manager = getKeybindings();
  const field = makeTextField({ multiline: true });
  assert.equal(getKeybindings(), manager);
  assert.equal(field.getText(), "");
});

// ---------------------------------------------------------------------------
// CRLF and lone-CR values: a real Windows-spelled value must open and apply
// ---------------------------------------------------------------------------

/** A long multi-line value spelled with CRLF, past the 8192-byte editor default. */
function longCrlfInstructions(): string {
  return longInstructions().replace(/\n/g, "\r\n");
}

test("a CRLF or lone-CR multi-line prefill opens as LF with every line intact", () => {
  // The exact shape the reviewer reported: it used to throw.
  const field = makeTextField({ multiline: true, initialText: "first\r\nsecond\rthird" });
  assert.equal(field.getText(), "first\nsecond\nthird");
  assert.equal(field.getValue(), "first\nsecond\nthird");

  // A long CRLF persisted value survives in full, as LF, with no lost line.
  const crlf = longCrlfInstructions();
  const longField = makeTextField({ multiline: true, initialText: crlf });
  const expected = crlf.replace(/\r\n/g, "\n");
  assert.equal(longField.getText(), expected);
  assert.equal(longField.getText().split("\n").length, crlf.split("\r\n").length);
  assert.ok(Buffer.byteLength(longField.getText(), "utf8") > 8_192);

  // A single-line field keeps its existing strict refusal for the same input.
  assert.throws(
    () => makeTextField({ initialText: "one\r\ntwo" }),
    /initial text must be safe single-line text/,
  );
});

test("setText normalizes a CRLF value for a multi-line field and reports the stored text", () => {
  const changes: string[] = [];
  const rejections: SessionHostFieldRejection[] = [];
  const field = makeTextField({
    multiline: true,
    initialText: "old",
    onChange: (text: string) => changes.push(text),
    onReject: (reason) => rejections.push(reason),
  });

  assert.equal(field.setText("a\r\nb\r\nc"), true, "a CRLF replacement is applied, not refused");
  assert.equal(field.getText(), "a\nb\nc");
  assert.deepEqual(changes, ["a\nb\nc"], "the host is told exactly what the field stored");

  // Genuine terminal control content is still refused for this kind.
  assert.equal(field.setText("keep\u001b[31mred\nnext"), false);
  assert.ok(rejections.includes("unsafe-text"));
  assert.equal(field.getText(), "a\nb\nc", "a refused replacement leaves the value untouched");
});

test("an external editor's CRLF multi-line result beyond the default bound is applied whole", async () => {
  const crlf = longCrlfInstructions();
  assert.ok(Buffer.byteLength(crlf, "utf8") > 8_192, "the fixture is past the unchanged 8192-byte editor default");
  const field = makeTextField({
    multiline: true,
    initialText: "stale",
    onExternalEditor: () => crlf,
  });

  field.handleInput(CTRL_G);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

  const applied = field.getText();
  assert.equal(applied, crlf.replace(/\r\n/g, "\n"), "every line survives, spelled as LF");
  assert.equal(applied.split("\n").length, crlf.split("\r\n").length, "no line is dropped or merged");
  assert.ok(!applied.includes("\r"), "no stray carriage return is left in the value");
  assert.ok(applied.startsWith("1. ") && applied.endsWith(field.getText().slice(-8)));
});

// ---------------------------------------------------------------------------
// TAB parity with the pinned native Editor (issue #653 review): the native
// Editor stores every TAB as four spaces (`Editor.normalizeText`) when text is
// set, pasted, or returned. A valid settings value spelled with a TAB must open,
// paste, and apply as exactly that expansion — never refused or deleted — while
// name/path fields and terminal-control safety stay unchanged.
// ---------------------------------------------------------------------------

const NATIVE_TAB = "    ";

test("a TAB in a generic text prefill opens as the native four spaces, single- and multi-line", () => {
  for (const multiline of [true, false]) {
    const field = makeTextField({ multiline, initialText: "first\tsecond" });
    assert.equal(field.getText(), `first${NATIVE_TAB}second`, `multiline=${multiline}`);
    assert.equal(field.getValue(), `first${NATIVE_TAB}second`, `multiline=${multiline}`);
  }
  // A multi-line value with tabs and CRLF together normalizes both, natively.
  const field = makeTextField({ multiline: true, initialText: "\tindented\r\nnext\tcol\rlast\t" });
  assert.equal(field.getText(), `${NATIVE_TAB}indented\nnext${NATIVE_TAB}col\nlast${NATIVE_TAB}`);
  // A single-line text field still refuses a line break even beside a TAB.
  assert.throws(() => makeTextField({ initialText: "a\tb\r\nc" }), /initial text must be safe single-line text/);
});

test("a long CRLF and TAB multi-line prefill survives whole as the native expansion", () => {
  const source = longInstructions().split("\n").map((line, index) => (index % 2 === 0 ? `\t${line}` : line)).join("\r\n");
  const expected = source.replace(/\r\n/g, "\n").replace(/\t/g, NATIVE_TAB);
  assert.ok(Buffer.byteLength(expected, "utf8") > 8_192);
  const field = makeTextField({ multiline: true, initialText: source });
  assert.equal(field.getText(), expected);
  assert.equal(field.getText().split("\n").length, source.split("\r\n").length, "no line is dropped or merged");
});

test("a pasted TAB joining two words becomes four spaces instead of being deleted", () => {
  for (const multiline of [true, false]) {
    const field = makeTextField({ multiline, initialText: "" });
    paste(field, "first\tsecond");
    assert.equal(field.getText(), `first${NATIVE_TAB}second`, `multiline=${multiline}`);
  }
  const multi = makeTextField({ multiline: true, initialText: "" });
  paste(multi, "a\tb\r\nc\td\x1b[31m!\x07");
  assert.equal(multi.getText(), `a${NATIVE_TAB}b\nc${NATIVE_TAB}d!`, "CRLF normalizes and other controls are still stripped");
  // A single-line text field keeps stripping a pasted line break exactly as before.
  const single = makeTextField({ initialText: "x" });
  paste(single, "\ty\r\nz");
  assert.equal(single.getText(), `x${NATIVE_TAB}yz`);
});

test("an external editor result with TABs is applied as the native expansion, not rejected", async () => {
  for (const multiline of [true, false]) {
    const rejections: SessionHostFieldRejection[] = [];
    const field = makeTextField({
      multiline,
      initialText: "stale",
      onReject: (reason) => rejections.push(reason),
      onExternalEditor: () => (multiline ? "first\tsecond\r\n\tthird\n" : "first\tsecond"),
    });
    field.handleInput(CTRL_G);
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.deepEqual(rejections, [], `multiline=${multiline}`);
    assert.equal(
      field.getText(),
      multiline ? `first${NATIVE_TAB}second\n${NATIVE_TAB}third\n` : `first${NATIVE_TAB}second`,
    );
  }
});

test("TAB normalization admits no other control: ANSI, C0, and C1 content is still refused", () => {
  for (const multiline of [true, false]) {
    assert.throws(() => makeTextField({ multiline, initialText: "a\tb\x1b[31m" }), /initial text must be safe/);
    assert.throws(() => makeTextField({ multiline, initialText: "a\t\x07" }), /initial text must be safe/);
    assert.throws(() => makeTextField({ multiline, initialText: "a\t\u009b31m" }), /initial text must be safe/);
    const rejections: SessionHostFieldRejection[] = [];
    const field = makeTextField({ multiline, initialText: "keep", onReject: (reason) => rejections.push(reason) });
    assert.equal(field.setText("x\ty\x1b]52;c;cGF5\x07"), false);
    assert.equal(field.setText("x\ty\x00"), false);
    assert.deepEqual(rejections, ["unsafe-text", "unsafe-text"]);
    assert.equal(field.getText(), "keep");
  }
});

test("name and path fields keep their exact strict TAB behaviour", () => {
  // Prefill: still refused, exactly as before.
  assert.throws(
    () => createSessionHostTextField({ kind: "name", initialText: "first\tsecond" }),
    /initial text must be safe single-line text/,
  );
  assert.throws(
    () => createSessionHostTextField({ kind: "path", initialText: "/tmp/a\tb", workspaceBasePath: process.cwd() }),
    /initial text must be safe single-line text/,
  );
  // setText: still rejected as unsafe text.
  const rejections: SessionHostFieldRejection[] = [];
  const name = createSessionHostTextField({ kind: "name", initialText: "keep", onReject: (reason) => rejections.push(reason) });
  assert.equal(name.setText("first\tsecond"), false);
  assert.deepEqual(rejections, ["unsafe-text"]);
  assert.equal(name.getText(), "keep");
  // Paste: a TAB is still stripped by the unchanged single-line sanitizer.
  const pastedName = createSessionHostTextField({ kind: "name", initialText: "" });
  pastedName.handleInput(`${BRACKETED_PASTE_START}first\tsecond${BRACKETED_PASTE_END}`);
  assert.equal(pastedName.getText(), "firstsecond");
  const pastedPath = createSessionHostTextField({ kind: "path", initialText: "", workspaceBasePath: process.cwd() });
  pastedPath.handleInput(`${BRACKETED_PASTE_START}/tmp/a\tb${BRACKETED_PASTE_END}`);
  assert.equal(pastedPath.getText(), "/tmp/ab");
});
