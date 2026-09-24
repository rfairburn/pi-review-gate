import assert from "node:assert/strict";
import test from "node:test";
import { UserQuestionController } from "../src/user-question/controller";
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";

/** Raw sequence used by the fakes for the approved chord (Kitty-style). */
const CHORD = "\x1b[1;64A";

function makeKeybindings() {
  const bindings: Record<string, string[]> = {
    "tui.select.up": ["\x1b[A"],
    "tui.select.down": ["\x1b[B"],
    "tui.select.confirm": ["\r"],
    "tui.select.cancel": ["\x1b"],
    "tui.editor.cursorLeft": ["\x1b[D"],
    "tui.editor.cursorRight": ["\x1b[C"],
    "tui.editor.deleteCharBackward": ["\x7f"],
  };
  return {
    matches(data: string, keybinding: string): boolean {
      return (bindings[keybinding] ?? []).includes(data);
    },
  };
}

function makeTuiHost() {
  const visibleWidth = (text: string): number => text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return {
    matchesKey(data: string, keyId: string): boolean {
      return keyId === QUESTION_LIST_SHORTCUT_KEY && data === CHORD;
    },
    visibleWidth,
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
}

function makeFixture(): Fixture {
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
  const component = createQuestionListComponent({
    controller,
    keybindings: makeKeybindings(),
    theme: THEME,
    tuiHost: makeTuiHost(),
    shortcutLabel: "Ctrl+Alt+Up",
    onDone: (result) => done.push(result),
  });
  return { controller, identity, sent, done, component };
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

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";

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

test("empty or whitespace-only free text does not submit; the draft survives backing out", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", { choices: ["SQLite"], mode: "async" });
  fixture.component.handleInput(ENTER); // open answer view
  fixture.component.handleInput(DOWN); // Type something…
  fixture.component.handleInput(ENTER); // start editing
  fixture.component.handleInput(ENTER); // empty buffer: no submission
  assert.equal(fixture.done.length, 0);
  fixture.component.handleInput("   "); // whitespace only: still no submission
  fixture.component.handleInput(ENTER);
  assert.equal(fixture.done.length, 0);
  fixture.component.handleInput(ESCAPE); // back to the option rows; draft kept
  const text = fixture.component.render(80).join("\n");
  assert.match(text, /> Type something…/, "selection stays on the free-text row");
  fixture.component.handleInput(ENTER); // resume editing with the draft
  fixture.component.handleInput("ok"); // "   ok"
  fixture.component.handleInput(ENTER); // trimmed to "ok" and submitted
  assert.deepEqual(fixture.done, [{ kind: "submitted", result: { status: "delivered", empty: true } }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Which database\?": ok$/);
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

test("the fallback editor keeps and submits drafts beyond 4000 characters without data loss", async () => {
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
    "\x1b[5~", // PageUp
    "\x1b[6~", // PageDown
    "\x1b[1;2A", // unrecognized modifier chord (Ctrl+Up)
  ];
  for (const sequence of unknown) fixture.component.handleInput(sequence);
  const rendered = fixture.component.render(80).join("\n");
  assert.match(rendered, /Your answer: yes/, "the draft is unchanged by unknown sequences");
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
