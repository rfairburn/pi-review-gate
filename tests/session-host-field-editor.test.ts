import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  visibleWidth,
} from "pi-session-host-tui";
import {
  SessionHostTextField,
  createSessionHostTextField,
  type SessionHostFieldRejection,
  type SessionHostFieldSubmission,
} from "../src/session-host/field-editor";
import { isValidRenameName, MAX_RENAME_NAME_BYTES } from "../src/session-host/protocol";

const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function makeFixture(t: TestContext): string {
  const root = mkdtempSync(join(process.cwd(), "tests", "session-host-field-editor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function displayPath(path: string): string {
  return path.split(sep).join("/");
}

function makePathField(options: {
  basePath?: string;
  initialText?: string;
  keybindings?: ReturnType<typeof getKeybindings>;
  onInvalidate?: () => void;
  onCancel?: () => void;
  onClear?: () => void;
  onChange?: (text: string) => void;
  onSubmit?: (submission: SessionHostFieldSubmission) => void;
  onReject?: (reason: SessionHostFieldRejection) => void;
} = {}): SessionHostTextField {
  return createSessionHostTextField({
    kind: "path",
    workspaceBasePath: options.basePath ?? process.cwd(),
    ...(options.initialText === undefined ? {} : { initialText: options.initialText }),
    ...(options.keybindings === undefined ? {} : { keybindings: options.keybindings }),
    ...(options.onInvalidate === undefined ? {} : { onInvalidate: options.onInvalidate }),
    ...(options.onCancel === undefined ? {} : { onCancel: options.onCancel }),
    ...(options.onClear === undefined ? {} : { onClear: options.onClear }),
    ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
    ...(options.onSubmit === undefined ? {} : { onSubmit: options.onSubmit }),
    ...(options.onReject === undefined ? {} : { onReject: options.onReject }),
  });
}

function typeText(field: SessionHostTextField, text: string): void {
  for (const character of text) field.handleInput(character);
}

async function waitForAutocomplete(field: SessionHostTextField): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!field.isShowingAutocomplete() && Date.now() < deadline) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  assert.ok(field.isShowingAutocomplete(), "the native Editor displayed the provider's async suggestions");
}

async function waitForCompletionOrImmediateAcceptance(
  field: SessionHostTextField,
  previousText: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!field.isShowingAutocomplete() && field.getText() === previousText && Date.now() < deadline) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  assert.ok(field.isShowingAutocomplete() || field.getText() !== previousText,
    "the native Editor displayed suggestions or immediately accepted its single native result");
}

async function acceptCompletion(
  field: SessionHostTextField,
  text: string,
  key: string = TAB,
): Promise<void> {
  typeText(field, text);
  // A forced Tab may directly apply one native result, or show a list for several.
  if (!field.isShowingAutocomplete()) {
    const previousText = field.getText();
    field.handleInput(TAB);
    await waitForCompletionOrImmediateAcceptance(field, previousText);
  }
  if (field.isShowingAutocomplete()) field.handleInput(key);
  else if (key !== TAB) field.handleInput(key);
}

function resolveFieldPath(value: string, home?: string): string {
  if (value === "~") return home ?? value;
  if (value.startsWith("~/") && home) return resolve(home, value.slice(2));
  return resolve(value);
}

test("uses the real public Editor, native path provider, and a non-writing TUI render delegate", () => {
  const invalidations: number[] = [];
  const field = makePathField({ onInvalidate: () => invalidations.push(1) });
  try {
    assert.ok(field.editor instanceof Editor);
    assert.ok(field.nativeAutocompleteProvider instanceof CombinedAutocompleteProvider);
    assert.ok(field.tui instanceof TuiMainScreen);

    field.handleInput("x");
    field.invalidate();
    const frame = field.render(18, 4);
    assert.ok(invalidations.length > 0, "Editor invalidations are delegated to the host");
    assert.equal(field.tui.terminalWriteAttempts, 0, "the second TUI never writes terminal escape sequences");
    assert.ok(frame.lines.length <= 4);
    assert.equal(frame.cursor.visible, true);
    for (const line of frame.lines) {
      assert.ok(visibleWidth(line) <= 18);
      assert.ok(!line.includes(CURSOR_MARKER));
      assert.ok(!line.replace(SGR_PATTERN, "").includes("\x1b"));
    }
    if (frame.cursor.visible) {
      assert.ok(frame.cursor.column >= 0 && frame.cursor.column < 18);
      assert.ok(frame.cursor.row >= 0 && frame.cursor.row < 4);
    }
  } finally {
    field.dispose();
  }
});

test("native Editor supplies grapheme, word/cursor, kill-ring yank, undo, and single-line paste editing", () => {
  const manager = getKeybindings();
  const field = createSessionHostTextField({ kind: "name", keybindings: manager });
  try {
    field.handleInput("A👨‍👩‍👧");
    field.handleInput("\x7f"); // native grapheme-aware backspace
    assert.equal(field.getText(), "A");

    field.setText("one two");
    field.handleInput("\x01"); // Ctrl+A, native line start
    assert.equal(field.getCursor().col, 0);
    field.handleInput("\x1b[1;5C"); // Ctrl+Right, native word movement
    assert.ok(field.getCursor().col > 0 && field.getCursor().col < field.getText().length);
    field.handleInput("\x15"); // Ctrl+U, native kill-to-line-start
    assert.equal(field.getText(), " two");
    field.handleInput("\x19"); // Ctrl+Y, native kill-ring yank
    assert.equal(field.getText(), "one two");
    field.handleInput("\x1f"); // Ctrl+-, native undo
    assert.equal(field.getText(), " two");

    field.setText("");
    field.handleInput("\x1b[20");
    field.handleInput("0~A\x1b]52;c;YWJj\x07B\x1b[31mC\x1b[20");
    field.handleInput("1~tail");
    assert.equal(field.getText(), "ABCtail", "split OSC/CSI payloads are stripped before native paste insertion");
    assert.equal(field.render(24, 3).lines.some((line) => line.includes(CURSOR_MARKER)), false);
    assert.equal(field.tui.terminalWriteAttempts, 0);
  } finally {
    field.dispose();
  }
});

test("encoded native editing bindings work at the field limit", () => {
  const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.editor.cursorLineStart": "a",
    "tui.editor.deleteCharBackward": "shift+space",
  });
  const rejected: SessionHostFieldRejection[] = [];
  const field = createSessionHostTextField({
    kind: "name",
    maxNameBytes: 80,
    keybindings: manager,
    onReject: (reason) => rejected.push(reason),
  });
  try {
    field.setText("x".repeat(80));
    field.handleInput("\x1b[97u");
    assert.equal(field.getCursor().col, 0);
    assert.equal(field.getText(), "x".repeat(80));

    field.setText("x".repeat(80));
    field.handleInput("\x1b[32;2u");
    assert.equal(field.getText(), "x".repeat(79));
    assert.deepEqual(rejected, []);
  } finally {
    field.dispose();
  }
});

test("native character-jump targets work at the field limit", () => {
  const rejected: SessionHostFieldRejection[] = [];
  const field = createSessionHostTextField({
    kind: "name",
    maxNameBytes: 80,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    onReject: (reason) => rejected.push(reason),
  });
  const text = "a".repeat(39) + "B" + "a".repeat(40);
  try {
    field.setText(text);
    for (const target of ["B", "\x1b[66u", "\x1b[27;2;66~"]) {
      field.handleInput("\x01");
      field.handleInput("\x1d");
      field.handleInput(target);
      assert.equal(field.getCursor().col, 39);
      assert.equal(field.getText(), text);
    }
    assert.deepEqual(rejected, []);
    field.handleInput("x");
    assert.equal(field.getText(), text);
    assert.deepEqual(rejected, ["text-limit"]);
  } finally {
    field.dispose();
  }
});

test("name and path limits reject an edit atomically instead of persisting truncated values", () => {
  const rejected: SessionHostFieldRejection[] = [];
  const name = createSessionHostTextField({
    kind: "name",
    maxNameBytes: 80,
    onReject: (reason) => rejected.push(reason),
  });
  const path = makePathField({ onReject: (reason) => rejected.push(reason) });
  try {
    name.handleInput("a".repeat(80));
    name.handleInput("b");
    assert.equal(name.getText(), "a".repeat(80));
    assert.equal(name.getText().length, 80);

    const emoji = "🙂";
    name.setText(emoji.repeat(20));
    name.handleInput(emoji);
    assert.equal(name.getText(), emoji.repeat(20), "80-byte test limit rejects the next 4-byte grapheme without truncation");

    path.handleInput("p".repeat(2048));
    path.handleInput("q");
    assert.equal([...path.getText()].length, 2048);
    assert.equal(path.getText(), "p".repeat(2048));
    assert.ok(rejected.includes("text-limit"));
  } finally {
    name.dispose();
    path.dispose();
  }
});

test("default name limit matches the exact 1024-byte persisted rename contract", () => {
  const rejected: SessionHostFieldRejection[] = [];
  assert.equal(MAX_RENAME_NAME_BYTES, 1024);
  const asciiLimit = "a".repeat(MAX_RENAME_NAME_BYTES);
  const unicodeLimit = "🙂".repeat(255) + "é\u0301";
  assert.equal(Buffer.byteLength(asciiLimit, "utf8"), MAX_RENAME_NAME_BYTES);
  assert.equal(Buffer.byteLength(unicodeLimit, "utf8"), MAX_RENAME_NAME_BYTES);
  assert.equal(isValidRenameName(asciiLimit), true);
  assert.equal(isValidRenameName(unicodeLimit), true);
  assert.equal(isValidRenameName(`${asciiLimit}a`), false);

  const field = createSessionHostTextField({
    kind: "name",
    onReject: (reason) => rejected.push(reason),
  });
  try {
    assert.equal(field.setText(asciiLimit), true);
    field.handleInput("\x1b[D");
    const caret = field.getCursor().col;
    field.handleInput("b");
    assert.equal(field.getText(), asciiLimit);
    assert.equal(field.getCursor().col, caret, "over-limit printable input preserves the native caret");

    field.editor.insertTextAtCursor("b");
    assert.equal(field.getText(), asciiLimit, "the native mutation callback rejects and undoes an over-limit edit");
    assert.equal(field.getCursor().col, caret, "native rollback preserves the accepted caret");
    field.handleInput("\x1f");
    assert.equal(field.getText(), "", "rejected native input does not pollute the undo stack");

    assert.equal(field.setText(unicodeLimit), true, "emoji and combining sequences count by UTF-8 bytes, not UTF-16 units or code points");
    assert.equal(field.getText(), unicodeLimit);
    field.handleInput("\x1b[D");
    const unicodeCaret = field.getCursor().col;
    assert.equal(field.setText(`${unicodeLimit}x`), false);
    assert.equal(field.getText(), unicodeLimit);
    assert.equal(field.getCursor().col, unicodeCaret, "over-limit replacement preserves the Unicode caret");
    assert.ok(rejected.filter((reason) => reason === "text-limit").length >= 3);
  } finally {
    field.dispose();
  }
});

test("custom name byte limit covers initial text, setText, paste, and external-editor replacement", async () => {
  const rejected: SessionHostFieldRejection[] = [];
  const changes: string[] = [];
  assert.throws(() => createSessionHostTextField({
    kind: "name",
    maxNameBytes: 5,
    initialText: "🙂xx",
  }), /initial text exceeds its name limit/);

  const field = createSessionHostTextField({
    kind: "name",
    maxNameBytes: 5,
    initialText: "🙂e",
    onChange: (text) => changes.push(text),
    onExternalEditor: () => "🙂xy",
    onReject: (reason) => rejected.push(reason),
  });
  try {
    assert.equal(field.getText(), "🙂e", "an exactly 5-byte initial value is retained");
    assert.equal(field.setText("🙂ee"), false);
    assert.equal(field.getText(), "🙂e");

    assert.equal(field.setText("é\u0301"), true);
    field.handleInput(`${BRACKETED_PASTE_START}x${BRACKETED_PASTE_END}`);
    assert.equal(field.getText(), "é\u0301x", "paste uses the same byte limit as setText");
    field.handleInput(`${BRACKETED_PASTE_START}y${BRACKETED_PASTE_END}`);
    assert.equal(field.getText(), "é\u0301x", "over-limit paste leaves the complete prior value unchanged");

    field.setText("ok");
    field.handleInput("\x07");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(field.getText(), "ok", "over-limit external-editor output is rejected atomically");
    assert.deepEqual(changes, ["é\u0301", "é\u0301x", "ok"]);
    assert.ok(rejected.filter((reason) => reason === "text-limit").length >= 3);
  } finally {
    field.dispose();
  }
});

test("invalid custom name byte limits are rejected instead of clamped", () => {
  for (const maxNameBytes of [0, -1, MAX_RENAME_NAME_BYTES + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createSessionHostTextField({ kind: "name", maxNameBytes }), /maxNameBytes/);
  }
});

test("native name fields allow an empty draft for caller-side submission validation", () => {
  const submissions: SessionHostFieldSubmission[] = [];
  const field = createSessionHostTextField({
    kind: "name",
    onSubmit: (submission) => submissions.push(submission),
  });
  try {
    assert.equal(isValidRenameName(""), false);
    assert.equal(field.setText(""), true);
    field.handleInput(ENTER);
    assert.deepEqual(submissions, [{ text: "", value: "", source: "typed" }]);
  } finally {
    field.dispose();
  }
});

test("rejected over-limit and unsafe edits preserve the native undo stack and caret", () => {
  const rejected: SessionHostFieldRejection[] = [];
  const field = createSessionHostTextField({
    kind: "name",
    maxNameBytes: 80,
    onReject: (reason) => rejected.push(reason),
  });
  try {
    field.setText("a".repeat(80));
    field.handleInput("\x1b[D");
    const insertionPoint = field.getCursor().col;
    assert.equal(insertionPoint, 79);
    field.handleInput("x");
    assert.equal(field.getText(), "a".repeat(80));
    assert.equal(field.getCursor().col, insertionPoint, "prospective rejection does not move a nonterminal caret");
    field.editor.insertTextAtCursor("x");
    assert.equal(field.getText(), "a".repeat(80), "guarded public native Undo rolls back a mutation that bypassed preflight");
    assert.equal(field.getCursor().col, insertionPoint, "native rollback restores the original caret");
    field.handleInput("\x1f");
    assert.equal(field.getText(), "", "the first Undo reaches the prior accepted state, not the rejected edit");
    field.handleInput("\x1f");
    assert.equal(field.getText(), "", "repeated Undo cannot resurrect rejected text");

    field.setText("safe");
    field.handleInput("\x1b[D");
    const safeCaret = field.getCursor().col;
    field.handleInput("\x1b]52;c;YWJj\x07");
    assert.equal(field.getText(), "safe");
    assert.equal(field.getCursor().col, safeCaret);
    field.editor.insertTextAtCursor("unsafe\x1b]52;c;YWJj\x07");
    assert.equal(field.getText(), "safe", "guarded native Undo removes unsafe public-editor mutations");
    assert.equal(field.getCursor().col, safeCaret);
    field.handleInput("\x1f");
    assert.equal(field.getText(), "");
    field.handleInput("\x1f");
    assert.equal(field.getText(), "");
    assert.ok(rejected.includes("text-limit"));
    assert.ok(rejected.includes("unsafe-text"));
  } finally {
    field.dispose();
  }
});

test("bracketed paste has a bounded raw-byte budget and preserves only one safe line", () => {
  const rejected: SessionHostFieldRejection[] = [];
  const field = makePathField({ onReject: (reason) => rejected.push(reason) });
  try {
    field.setText("kept");
    field.handleInput(BRACKETED_PASTE_START);
    field.handleInput("x".repeat(5000));
    field.handleInput("y".repeat(5000));
    field.handleInput(BRACKETED_PASTE_END);
    assert.equal(field.getText(), "kept");
    assert.ok(rejected.includes("paste-limit"));

    field.handleInput(`${BRACKETED_PASTE_START}a\nb\r\nc${BRACKETED_PASTE_END}`);
    assert.equal(field.getText(), "keptabc", "native Editor receives a sanitized, single-line paste");
  } finally {
    field.dispose();
  }
});

test("native relative completion with spaces, quotes, Unicode, and nesting yields an actual fixture path", async (t) => {
  const fixture = makeFixture(t);
  const quotedDirectory = join(fixture, 'space "quoted" 🌱');
  mkdirSync(join(quotedDirectory, "nested 雪"), { recursive: true });
  writeFileSync(join(fixture, "space file.txt"), "fixture");

  const submissions: SessionHostFieldSubmission[] = [];
  const field = makePathField({ onSubmit: (submission) => submissions.push(submission) });
  try {
    const parent = displayPath(relative(process.cwd(), fixture));
    const query = `${parent}/space`;
    const direct = await field.nativeAutocompleteProvider?.getSuggestions(
      [query], 0, query.length, { signal: new AbortController().signal, force: true },
    );
    const quotedNativeItem = direct?.items.find((item) => item.label === 'space "quoted" 🌱/');
    assert.ok(quotedNativeItem);
    assert.ok(quotedNativeItem.value.startsWith('"') && quotedNativeItem.value.endsWith('"'),
      "the pinned provider inserts a generated outer quote pair for a path with spaces");
    assert.ok(direct?.items.some((item) => item.label === "space file.txt"), "native provider keeps file suggestions");

    await acceptCompletion(field, `${parent}/space`);
    assert.equal(submissions.length, 0, "Tab accepts the suggestion; it does not submit the field");
    const completed = field.getValue();
    assert.equal(resolveFieldPath(completed), quotedDirectory);
    assert.equal(statSync(resolveFieldPath(completed)).isDirectory(), true);
    assert.equal(field.getText(), quotedNativeItem.value, "the native Editor keeps the insertion syntax for display");
    assert.equal(completed, `${displayPath(relative(process.cwd(), quotedDirectory))}/`,
      "the field's completion value strips only the provider-proven outer syntax and preserves literal filename quotes");
    field.handleInput(ENTER);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.value, completed);
    assert.equal(submissions[0]?.source, "native-completion");

    // Continue through a space-bearing directory to a nested Unicode directory.
    const nestedRoot = join(fixture, "nest folder");
    mkdirSync(join(nestedRoot, "nested 雪"), { recursive: true });
    const nestedField = makePathField();
    try {
      await acceptCompletion(nestedField, `${parent}/nest`);
      typeText(nestedField, "nested");
      const beforeNestedTab = nestedField.getText();
      nestedField.handleInput(TAB);
      await waitForCompletionOrImmediateAcceptance(nestedField, beforeNestedTab);
      if (nestedField.isShowingAutocomplete()) nestedField.handleInput(TAB);
      const nestedValue = nestedField.getValue();
      assert.equal(resolveFieldPath(nestedValue), join(nestedRoot, "nested 雪"));
      assert.equal(statSync(resolveFieldPath(nestedValue)).isDirectory(), true);
    } finally {
      nestedField.dispose();
    }
  } finally {
    field.dispose();
  }
});

test("native completion provenance preserves an untouched child suffix after the caret", async (t) => {
  const fixture = makeFixture(t);
  const target = join(fixture, "parent folder", "child");
  mkdirSync(target, { recursive: true });
  const prefix = `${displayPath(relative(process.cwd(), fixture))}/parent`;
  const initialText = `${prefix}child`;
  const submissions: SessionHostFieldSubmission[] = [];
  const field = makePathField({
    initialText,
    onSubmit: (submission) => submissions.push(submission),
  });
  try {
    for (let count = 0; count < "child".length; count += 1) field.handleInput("\x1b[D");
    assert.equal(field.getCursor().col, prefix.length);

    field.handleInput(TAB);
    await waitForCompletionOrImmediateAcceptance(field, initialText);
    if (field.isShowingAutocomplete()) field.handleInput(TAB);

    const value = field.getValue();
    assert.equal(resolve(value), target);
    assert.equal(statSync(resolve(value)).isDirectory(), true);
    assert.ok(field.getText().endsWith("child"), "native applyCompletion retained the text after the cursor");
    field.handleInput(ENTER);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.value, value, "submit resolves the complete displayed path, not only item.value");
    assert.equal(submissions[0]?.source, "native-completion");
  } finally {
    field.dispose();
  }
});

test("absolute-leading slash routes to native file suggestions instead of slash commands", async (t) => {
  const fixture = makeFixture(t);
  const target = join(fixture, "absolute-space dir");
  mkdirSync(target);
  const absolutePrefix = join(fixture, "absolute");
  let canceled = 0;
  let invalidations = 0;
  const field = makePathField({
    onCancel: () => { canceled += 1; },
    onInvalidate: () => { invalidations += 1; },
  });
  try {
    const suggestions = await field.autocompleteProvider?.getSuggestions(
      [absolutePrefix], 0, absolutePrefix.length, { signal: new AbortController().signal },
    );
    assert.ok(suggestions?.items.some((item) => item.label === "absolute-space dir/"));

    field.setText(absolutePrefix); // Avoid querying `/` itself; completion reads only the explicit fixture parent.
    const beforeTab = invalidations;
    field.handleInput(TAB);
    const afterTab = invalidations;
    await waitForAutocomplete(field);
    assert.ok(invalidations > afterTab && afterTab >= beforeTab, "async provider completion invalidates the host frame");
    field.handleInput(ENTER);
    assert.equal(canceled, 0);
    assert.equal(resolve(field.getValue()), target, "native directory slash is a valid path delimiter, not shell quoting");
    assert.equal(statSync(field.getValue()).isDirectory(), true);
    assert.equal(canceled, 0);
  } finally {
    field.dispose();
  }
});

test("typed absolute, relative, tilde, spaces, and literal quotes remain unchanged without completion provenance", (t) => {
  const fixture = makeFixture(t);
  const home = join(fixture, "home");
  const literal = join(fixture, 'actual "quoted" directory');
  mkdirSync(home);
  mkdirSync(join(home, "folder with spaces"));
  mkdirSync(literal);

  const changes: string[] = [];
  const submissions: SessionHostFieldSubmission[] = [];
  const field = makePathField({
    onChange: (value) => changes.push(value),
    onSubmit: (submission) => submissions.push(submission),
  });
  try {
    const values = [
      displayPath(relative(process.cwd(), literal)),
      literal,
      "~/folder with spaces",
      'folder "literal quote" with spaces',
    ];
    for (const value of values) {
      assert.equal(field.setText(value), true);
      assert.equal(field.getText(), value);
      assert.equal(field.getValue(), value, "typed syntax is preserved and never shell-decoded");
    }
    assert.equal(resolveFieldPath(values[0] ?? ""), literal);
    assert.equal(resolveFieldPath(values[1] ?? ""), literal);
    assert.equal(resolveFieldPath(values[2] ?? "", home), resolve(home, "folder with spaces"));
    assert.equal(statSync(resolveFieldPath(values[0] ?? "")).isDirectory(), true);
    assert.equal(statSync(resolveFieldPath(values[1] ?? "")).isDirectory(), true);
    assert.equal(statSync(resolveFieldPath(values[2] ?? "", home)).isDirectory(), true);
    assert.equal(resolveFieldPath(field.getValue(), home), resolve(process.cwd(), 'folder "literal quote" with spaces'));
    assert.deepEqual(changes, values);
    field.handleInput(ENTER);
    assert.deepEqual(submissions, [{
      text: values[3],
      value: values[3],
      source: "typed",
    }]);
  } finally {
    field.dispose();
  }
});

test("tilde completion stays rooted at the explicitly supplied test HOME", async (t) => {
  const fixture = makeFixture(t);
  const home = join(fixture, "home");
  const target = join(home, "tilde space 🌙");
  mkdirSync(target, { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const field = makePathField();
  try {
    const query = "~/tilde ";
    const suggestions = await field.nativeAutocompleteProvider?.getSuggestions(
      [`\"${query}`], 0, query.length + 1, { signal: new AbortController().signal, force: true },
    );
    assert.ok(suggestions?.items.some((item) => item.label === "tilde space 🌙/"));

    await acceptCompletion(field, `\"${query}`);
    assert.equal(resolveFieldPath(field.getValue(), home), target);
    assert.equal(statSync(resolveFieldPath(field.getValue(), home)).isDirectory(), true);
  } finally {
    field.dispose();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("injected native app keybindings stay live for clear and external-editor actions", async () => {
  const manager = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.clear": { defaultKeys: "ctrl+c" },
    "app.interrupt": { defaultKeys: "escape" },
    "app.editor.external": { defaultKeys: "ctrl+g" },
    "app.cancel": { defaultKeys: "ctrl+x" },
  });
  let cleared = 0;
  let externalEdits = 0;
  const field = createSessionHostTextField({
    kind: "path",
    workspaceBasePath: process.cwd(),
    keybindings: manager,
    actionBindings: { cancel: "app.cancel" },
    onClear: () => { cleared += 1; },
    onExternalEditor: (text) => {
      externalEdits += 1;
      return `${text}-external`;
    },
  });
  try {
    field.setText("draft");
    field.handleInput("\x03");
    assert.equal(field.getText(), "");
    assert.equal(cleared, 1, "the native app.clear default Ctrl+C is honored");

    manager.setUserBindings({ "app.clear": "ctrl+k", "app.editor.external": "ctrl+e" });
    field.setText("still live");
    field.handleInput("\x03");
    assert.equal(field.getText(), "still live", "custom app.clear replaces its Ctrl+C default");
    assert.equal(cleared, 1);
    field.handleInput("\x0b");
    assert.equal(field.getText(), "");
    assert.equal(cleared, 2);

    field.setText("external");
    field.handleInput("\x07");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(field.getText(), "external", "custom app.editor.external replaces the Ctrl+G default");
    assert.equal(externalEdits, 0);
    field.handleInput("\x05");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(field.getText(), "external-external");
    assert.equal(externalEdits, 1);

    manager.setUserBindings({ "app.clear": "ctrl+l", "app.editor.external": "ctrl+o" });
    field.setText("still live");
    field.handleInput("\x0b");
    assert.equal(field.getText(), "still live", "the previous clear action key stops matching");
    field.handleInput("\x0c");
    assert.equal(field.getText(), "");
    assert.equal(cleared, 3);

    field.setText("another external edit");
    field.handleInput("\x05");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(field.getText(), "another external edit", "the previous external-editor key stops matching");
    assert.equal(externalEdits, 1);
    field.handleInput("\x0f");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(field.getText(), "another external edit-external");
    assert.equal(externalEdits, 2);
  } finally {
    field.dispose();
  }
});

test("native app Escape interrupts without clearing and preserves completion-first cancellation", async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture, "entry-one"));
  mkdirSync(join(fixture, "entry-two"));
  const manager = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.clear": { defaultKeys: "ctrl+c" },
    "app.interrupt": { defaultKeys: "escape" },
    "app.editor.external": { defaultKeys: "ctrl+g" },
  });
  const prefix = `${displayPath(relative(process.cwd(), fixture))}/entry`;
  let cleared = 0;
  let canceled = 0;
  const field = createSessionHostTextField({
    kind: "path",
    workspaceBasePath: process.cwd(),
    initialText: prefix,
    keybindings: manager,
    onClear: () => { cleared += 1; },
    onCancel: () => { canceled += 1; },
  });
  try {
    field.handleInput(TAB);
    await waitForAutocomplete(field);
    field.handleInput(ESCAPE);
    assert.equal(field.isShowingAutocomplete(), false, "the first Escape dismisses native suggestions");
    assert.equal(field.getText(), prefix);
    assert.equal(canceled, 0);
    assert.equal(cleared, 0, "app.interrupt Escape is never mistaken for app.clear");

    field.handleInput(ESCAPE);
    assert.equal(canceled, 1, "the next Escape cancels the field");
    assert.equal(cleared, 0);
  } finally {
    field.dispose();
  }
});

test("remapped submit accepts native completion and custom cancel dismisses it without submitting", async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture, "entry-one"));
  mkdirSync(join(fixture, "entry-two"));
  const manager = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "tui.input.submit": { defaultKeys: "ctrl+s" },
    "app.cancel": { defaultKeys: "ctrl+x" },
  });
  const prefix = `${displayPath(relative(process.cwd(), fixture))}/entry`;
  const submissions: SessionHostFieldSubmission[] = [];
  let cancels = 0;
  const field = createSessionHostTextField({
    kind: "path",
    workspaceBasePath: process.cwd(),
    initialText: prefix,
    keybindings: manager,
    actionBindings: { cancel: "app.cancel" },
    onSubmit: (submission) => submissions.push(submission),
    onCancel: () => { cancels += 1; },
  });
  try {
    field.handleInput(TAB);
    await waitForAutocomplete(field);
    field.handleInput("\x18");
    assert.equal(field.isShowingAutocomplete(), false, "the field cancel action is bridged to native list dismissal");
    assert.equal(cancels, 0, "dismissing suggestions does not cancel the field");
    assert.deepEqual(submissions, []);

    field.handleInput(TAB);
    await waitForAutocomplete(field);
    field.handleInput("\x13");
    assert.equal(field.isShowingAutocomplete(), false);
    assert.notEqual(field.getText(), "", "the custom submit key accepts the selected suggestion without clearing the draft");
    assert.deepEqual(submissions, [], "accepting a suggestion is not field submission");
    assert.equal(statSync(resolve(field.getValue())).isDirectory(), true);

    field.handleInput("\x13");
    assert.equal(submissions.length, 1);
    assert.equal((submissions as SessionHostFieldSubmission[])[0]?.source, "native-completion");
    assert.equal(cancels, 0);
  } finally {
    field.dispose();
  }
});

test("cancel and dispose abort delayed native completions before they can mutate the field", async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture, "single"));
  const prefix = `${displayPath(relative(process.cwd(), fixture))}/singl`;

  function delayProvider(field: SessionHostTextField): { started: Promise<void>; release: () => void } {
    const provider = field.nativeAutocompleteProvider;
    assert.ok(provider);
    const original = provider.getSuggestions.bind(provider);
    let announceStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { announceStarted = resolveStarted; });
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    provider.getSuggestions = async (lines, cursorLine, cursorCol, options) => {
      const suggestions = await original(lines, cursorLine, cursorCol, options);
      announceStarted();
      await gate;
      return suggestions;
    };
    return { started, release };
  }

  let canceled = 0;
  let cancelChanges = 0;
  const canceledField = makePathField({
    initialText: prefix,
    onCancel: () => { canceled += 1; },
    onChange: () => { cancelChanges += 1; },
  });
  const canceledRequest = delayProvider(canceledField);
  try {
    canceledField.handleInput(TAB);
    await canceledRequest.started;
    assert.equal(canceledField.isShowingAutocomplete(), false, "the request is still pending before its delayed result");
    canceledField.handleInput(ESCAPE);
    assert.equal(canceled, 1);
    canceledRequest.release();
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(canceledField.getText(), prefix);
    assert.equal(canceledField.isShowingAutocomplete(), false, "late suggestions cannot resurrect the dismissed list");
    assert.equal(cancelChanges, 0, "late provider completion cannot call onChange after cancellation");
  } finally {
    canceledField.dispose();
  }

  let disposeChanges = 0;
  const disposedField = makePathField({ initialText: prefix, onChange: () => { disposeChanges += 1; } });
  const disposedRequest = delayProvider(disposedField);
  disposedField.handleInput(TAB);
  await disposedRequest.started;
  disposedField.dispose();
  disposedRequest.release();
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(disposedField.getText(), prefix);
  assert.equal(disposedField.isShowingAutocomplete(), false);
  assert.equal(disposeChanges, 0, "late provider completion cannot mutate a disposed field");
});

test("Ctrl+C clears, Ctrl+G is an explicit async external-editor hook, and Escape is list-first", async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture, "dir"));
  mkdirSync(join(fixture, "dir-two"));
  let canceled = 0;
  let cleared = 0;
  const field = createSessionHostTextField({
    kind: "path",
    workspaceBasePath: process.cwd(),
    keybindings: getKeybindings(),
    onCancel: () => { canceled += 1; },
    onClear: () => { cleared += 1; },
    onExternalEditor: async (text) => `${text}-external`,
  });
  try {
    field.setText("draft");
    field.handleInput("\x03");
    assert.equal(field.getText(), "");
    assert.equal(cleared, 1);

    field.setText("draft");
    field.handleInput("\x07");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(field.getText(), "draft-external");

    const prefix = `${displayPath(relative(process.cwd(), fixture))}/d`;
    field.setText("");
    typeText(field, prefix);
    if (!field.isShowingAutocomplete()) field.handleInput(TAB);
    await waitForAutocomplete(field);
    field.handleInput(ESCAPE);
    assert.equal(canceled, 0, "Escape first dismisses the native completion list");
    assert.equal(field.isShowingAutocomplete(), false);
    field.handleInput(ESCAPE);
    assert.equal(canceled, 1);
  } finally {
    field.dispose();
  }
});
