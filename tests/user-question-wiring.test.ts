/**
 * Issue #182: production wiring for the embedded answer editor.
 *
 * The component tests drive createQuestionListComponent with their own
 * editor factory, and the host-load tests cover only loader extraction. This
 * test pins the remaining link: the real registerUserQuestions → shortcut
 * handler → openQuestionList path that builds the createAnswerEditor
 * factory, applies the isUsableTui guard, and points the standalone pi-tui
 * module's keybinding state at the app's live KeybindingsManager via
 * setKeybindings. A regression there (dropped terminal.rows guard, missing
 * setKeybindings call) would leave every other test green while silently
 * disabling the feature or the user's keybindings.json overrides.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  registerUserQuestions,
  userQuestionsBeginSession,
  type UserQuestionSurface,
} from "../src/user-question";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

interface WiringFixture {
  surface: UserQuestionSurface;
  shortcuts: Map<string, { description?: string; handler: (ctx: unknown) => unknown }>;
  notices: string[];
  sent: Array<{ message: string; options?: unknown }>;
  sessionManager: object;
}

function makeFixture(): WiringFixture {
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
  const notices: string[] = [];
  const sent: WiringFixture["sent"] = [];
  const pi: Record<string, unknown> = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerShortcut(shortcut: string, options: { description?: string; handler: (ctx: unknown) => unknown }) {
      shortcuts.set(shortcut, options);
    },
    notify(message: string) {
      notices.push(message);
    },
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options });
      return Promise.resolve();
    },
  };
  const surface = registerUserQuestions(pi);
  assert.ok(surface, "registerUserQuestions returns the surface");
  assert.ok(tools.has("AskUserQuestion"), "the tool is registered");
  // The session_start hook sets this in a real host; the shortcut path
  // requires it through the controller's uiAvailable gate.
  surface.setInteractiveUi(true);
  const sessionManager = { id: "wiring-session" };
  userQuestionsBeginSession(surface.controller, sessionManager);
  return { surface, shortcuts, notices, sent, sessionManager };
}

/** Records every instance the factory constructs (one per answer-view session). */
class FakeWiringEditor {
  static instances: FakeWiringEditor[] = [];
  readonly tui: unknown;
  readonly theme: unknown;
  focused = true;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  private text = "";

  constructor(tui: unknown, theme: unknown) {
    this.tui = tui;
    this.theme = theme;
    FakeWiringEditor.instances.push(this);
  }

  getExpandedText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.onChange?.(this.text);
  }

  render(_width: number): string[] {
    return ["|", this.text, "|"];
  }

  handleInput(_data: string): void {}

  invalidate(): void {}
}

test("the shortcut path wires the host editor and the live keybindings manager", async () => {
  FakeWiringEditor.instances = [];
  const seenManagers: unknown[] = [];
  // Injected host: the production loader is short-circuited (same seam the
  // host-load tests use), but openQuestionList's glue runs unmodified.
  setUserQuestionTuiHost({
    Editor: FakeWiringEditor,
    setKeybindings: (manager) => {
      seenManagers.push(manager);
    },
    matchesKey: () => false, // the collapse chord is not exercised here
  });
  try {
    const fixture = makeFixture();
    fixture.surface.controller.register(
      { toolCallId: "t1", question: "First?", choices: ["a"], mode: "async" },
      fixture.sessionManager,
    );
    fixture.surface.controller.register(
      { toolCallId: "t2", question: "Second?", choices: ["b"], mode: "async" },
      fixture.sessionManager,
    );

    // The live manager the host passes to the custom factory; navigation in
    // this test resolves through it exactly as in production.
    const raw: Record<string, string[]> = {
      "tui.select.up": [UP],
      "tui.select.down": [DOWN],
      "tui.select.confirm": [ENTER],
      "tui.select.cancel": [ESCAPE],
    };
    const liveManager = {
      matches: (data: string, keybinding: string) => (raw[keybinding] ?? []).includes(data),
    };
    const tui = { terminal: { rows: 40 } };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    let component: any;
    const doneResults: unknown[] = [];
    const ctx = {
      sessionManager: fixture.sessionManager,
      ui: {
        setWidget() {},
        custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => unknown) {
          component = factory(tui, theme, liveManager, (result?: unknown) => doneResults.push(result));
          return Promise.resolve();
        },
      },
    };

    const shortcut = fixture.shortcuts.get("ctrl+alt+up");
    assert.ok(shortcut, "the approved chord is registered");
    await shortcut!.handler(ctx);
    assert.ok(component, "the custom factory produced the question component");

    // The standalone module's keybinding state points at the live manager —
    // the call that makes user keybindings.json overrides reach the editor.
    assert.equal(seenManagers.length, 1, "setKeybindings is called once per list open");
    assert.equal(seenManagers[0], liveManager, "the injected live manager reaches setKeybindings");

    // The editor is created lazily on first entry into editing.
    component.handleInput(ENTER); // q1's answer view
    assert.equal(FakeWiringEditor.instances.length, 0, "no editor until editing is entered");
    component.handleInput(DOWN); // Type something…
    component.handleInput(ENTER); // start editing
    assert.equal(FakeWiringEditor.instances.length, 1, "entering editing constructs the host editor");
    const first = FakeWiringEditor.instances[0]!;
    assert.equal(first.tui, tui, "the editor is constructed with the live TUI");
    assert.equal(typeof (first.theme as { borderColor?: unknown }).borderColor, "function", "the editor theme carries a border color function");
    assert.equal((first.theme as { borderColor: (text: string) => string }).borderColor("rule"), "rule");

    // A new answer-view session constructs a fresh instance (text, cursor and
    // undo history all start empty).
    component.handleInput(ESCAPE); // rows
    component.handleInput(ESCAPE); // list
    component.handleInput(DOWN); // select q2
    component.handleInput(ENTER); // q2's answer view
    assert.equal(FakeWiringEditor.instances.length, 1, "still lazy for the new session");
    component.handleInput(DOWN); // Type something…
    component.handleInput(ENTER); // start editing q2
    assert.equal(FakeWiringEditor.instances.length, 2, "a new answer view gets a fresh editor instance");

    // The list still closes through done() and nothing was submitted.
    component.handleInput(ESCAPE); // rows
    component.handleInput(ESCAPE); // list
    component.handleInput(ESCAPE); // close
    assert.deepEqual(doneResults, [undefined]);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.surface.controller.listPending().length, 2, "both questions stay pending");
  } finally {
    setUserQuestionTuiHost(undefined);
  }
});

test("an unusable TUI keeps the fallback editor on the production path", async () => {
  FakeWiringEditor.instances = [];
  const seenManagers: unknown[] = [];
  setUserQuestionTuiHost({
    Editor: FakeWiringEditor,
    setKeybindings: (manager) => {
      seenManagers.push(manager);
    },
    matchesKey: () => false,
  });
  try {
    const fixture = makeFixture();
    fixture.surface.controller.register(
      { toolCallId: "t1", question: "Only?", choices: ["a"], mode: "async" },
      fixture.sessionManager,
    );

    const raw: Record<string, string[]> = {
      "tui.select.up": [UP],
      "tui.select.down": [DOWN],
      "tui.select.confirm": [ENTER],
      "tui.select.cancel": [ESCAPE],
    };
    const liveManager = {
      matches: (data: string, keybinding: string) => (raw[keybinding] ?? []).includes(data),
    };
    // No terminal geometry: the isUsableTui guard must keep the fallback.
    const tui = {};
    let component: any;
    const ctx = {
      sessionManager: fixture.sessionManager,
      ui: {
        setWidget() {},
        custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => unknown) {
          component = factory(tui, liveTheme(), liveManager, () => {});
          return Promise.resolve();
        },
      },
    };

    await fixture.shortcuts.get("ctrl+alt+up")!.handler(ctx);
    assert.ok(component, "the list still opens without a usable TUI");
    component.handleInput(ENTER); // answer view
    component.handleInput(DOWN); // Type something…
    component.handleInput(ENTER); // start editing (fallback editor)
    assert.equal(FakeWiringEditor.instances.length, 0, "no host editor is constructed without terminal geometry");

    // The fallback still accepts text and submits.
    for (const char of "ok") component.handleInput(char);
    component.handleInput(ENTER);
    assert.equal(fixture.sent.length, 1, "the fallback path submitted the answer");
  } finally {
    setUserQuestionTuiHost(undefined);
  }
});

function liveTheme(): { fg: (color: string, text: string) => string; bold: (text: string) => string } {
  return { fg: (_color, text) => text, bold: (text) => text };
}
