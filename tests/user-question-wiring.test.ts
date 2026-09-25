/**
 * Issue #182: production wiring for the pending-question list UI.
 *
 * The component tests drive createQuestionListComponent directly and the
 * editor-parity tests drive the shared bridge with a replicated custom-slot
 * sequence. This test pins the remaining link: the real
 * registerUserQuestions → shortcut handler → openQuestionList path that
 * acquires the host-wired native editor BEFORE the list's ctx.ui.custom slot
 * opens, prepares it empty inside the factory, hands the instance to the
 * component, and restores the prior editor factory in finally. A regression
 * there (acquisition after the slot opens, missing prepare/finish, dropped
 * session identity recheck) would leave every other test green while the
 * feature silently degrades or a chat draft is lost.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  registerUserQuestions,
  userQuestionsBeginSession,
  type UserQuestionSurface,
} from "../src/user-question";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";
import { QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import {
  setNativeEditorHost,
  __resetActiveNativeEditorFieldForTest,
} from "../src/native-editor-bridge";
import { createBridgeUi, fakeHost, type BridgeComponent, type FakeBridgeEditor, type BridgeUiState } from "./bridge-fakes";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const CHORD = "\x1b[1;64A";

test.afterEach(() => {
  setNativeEditorHost(undefined);
  setUserQuestionTuiHost(undefined);
  __resetActiveNativeEditorFieldForTest();
});

/** Poll until the condition holds (the factory runs after an await hop). */
async function until(predicate: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface WiringFixture {
  surface: UserQuestionSurface;
  shortcuts: Map<string, { description?: string; handler: (ctx: unknown) => unknown }>;
  hooks: Map<string, () => void>;
  notices: string[];
  sent: Array<{ message: string; options?: unknown }>;
  sessionManager: object;
  state: BridgeUiState;
  instances: FakeBridgeEditor[];
  ctx: Record<string, unknown>;
  /** Set once the custom slot's factory has run (via the fake's driver hook). */
  component: { current: BridgeComponent | undefined };
}

function makeFixture(options: { withNativeHost?: boolean; draft?: string } = {}): WiringFixture {
  const instances: FakeBridgeEditor[] = [];
  if (options.withNativeHost !== false) setNativeEditorHost(fakeHost(instances));
  // Deterministic loader result for every test (no real discovery).
  setUserQuestionTuiHost({ matchesKey: (data, keyId) => data === CHORD && keyId === QUESTION_LIST_SHORTCUT_KEY });

  const tools = new Map<string, unknown>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
  const hooks = new Map<string, () => void>();
  const notices: string[] = [];
  const sent: WiringFixture["sent"] = [];
  const pi: Record<string, unknown> = {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerShortcut(shortcut: string, options: { description?: string; handler: (ctx: unknown) => unknown }) {
      shortcuts.set(shortcut, options);
    },
    notify(message: string) {
      notices.push(message);
    },
    sendUserMessage(message: string, opts?: unknown) {
      sent.push({ message, options: opts });
      return Promise.resolve();
    },
    on(name: string, handler: () => void) {
      hooks.set(name, handler);
      return () => {};
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

  // The live manager the host passes to the custom factory: navigation and
  // the bridge's intercepted keys resolve through it exactly as in production.
  const table: Record<string, string[]> = {
    "tui.input.submit": [ENTER],
    "tui.select.up": [UP],
    "tui.select.down": [DOWN],
    "tui.select.confirm": [ENTER],
    "tui.select.cancel": [ESCAPE, CTRL_C], // the pi 0.87.1 defaults
    "app.interrupt": [ESCAPE],
    "app.exit": ["\x04"],
    "app.clear": [CTRL_C],
  };
  const keybindings = { matches: (data: string, keybinding: string) => (table[keybinding] ?? []).includes(data) };

  const component: WiringFixture["component"] = { current: undefined };
  const { ui, state } = createBridgeUi({
    keybindings,
    draft: options.draft ?? "",
    drivers: [(captured) => {
      component.current = captured;
    }],
  });
  const ctx = {
    sessionManager,
    mode: "tui",
    isIdle: () => true,
    ui: { setWidget() {}, ...ui },
  };

  return { surface, shortcuts, hooks, notices, sent, sessionManager, state, instances, ctx, component };
}

function register(fixture: WiringFixture, question: string, choices?: string[]): void {
  const result = fixture.surface.controller.register(
    { toolCallId: `t${fixture.surface.controller.listPending().length + 1}`, question, choices, mode: "async" },
    fixture.sessionManager,
  );
  assert.ok(result.ok);
}

function pressShortcut(fixture: WiringFixture): Promise<void> {
  // Race a timer so a list that never closes fails fast instead of hanging
  // the process on an empty event loop.
  const opened = (fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>)(fixture.ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the question list never closed")), 5000);
  });
  return Promise.race([opened, guard]).finally(() => clearTimeout(timer));
}

test("the shortcut path acquires the host-wired editor before opening the list", async () => {
  const fixture = makeFixture({ draft: "chat draft" });
  register(fixture, "Which database?", ["SQLite"]);

  const opened = pressShortcut(fixture);
  await until(() => fixture.instances.length === 1);
  assert.equal(fixture.instances[0]!.getText(), "", "prepare(\"\") emptied the field after the host's draft capture");
  await until(() => fixture.component.current !== undefined);

  // Drive: answer view → free-text row → type → submit the whole answer.
  const component = fixture.component.current!;
  component.handleInput!(ENTER); // q1's answer view
  component.handleInput!(DOWN); // Type something…
  component.handleInput!(ENTER); // start editing the native field
  for (const ch of "yes please") component.handleInput!(ch);
  component.handleInput!(ENTER); // submit the whole answer

  await opened;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Answer to pending question "Which database\?": yes please/);
  assert.equal(fixture.state.draft, "chat draft", "the chat draft survived the round trip exactly once");
  assert.equal(fixture.state.slotFactory, undefined, "the prior (default) factory was restored in finally");
  assert.deepEqual(fixture.state.chatSubmits, [], "no chat message was sent");
});

test("unavailable native seams keep the list open with an unavailable row", async () => {
  const fixture = makeFixture({ withNativeHost: false });
  register(fixture, "Which database?", ["SQLite"]);

  const opened = pressShortcut(fixture);
  await until(() => fixture.component.current !== undefined);
  const component = fixture.component.current!;
  assert.equal(fixture.instances.length, 0, "no field instance was constructed");

  component.handleInput!(ENTER); // answer view
  const frame = component.render!(80).join("\n").replace(/\n\s*/g, " ");
  assert.match(frame, /Free text unavailable/, "the free-text row names the unavailable native editor");
  assert.match(frame, /choices and\s+Decline still work/);

  component.handleInput!(UP); // the choice
  component.handleInput!(ENTER); // confirm it — choices keep working
  await opened;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": SQLite$/);
  assert.equal(fixture.state.slotFactory, undefined, "the editor slot was never touched");
});

test("the collapse chord closes the list without submitting", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", ["SQLite"]);

  const opened = pressShortcut(fixture);
  await until(() => fixture.component.current !== undefined);
  const component = fixture.component.current!;
  component.handleInput!(CHORD); // the approved collapse chord

  await opened;
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.surface.controller.listPending().length, 1, "the question stays pending");
  assert.equal(fixture.state.slotFactory, undefined, "the prior factory was restored in finally");
});

test("session_shutdown aborts an open field and restores the chat draft", async () => {
  const fixture = makeFixture({ draft: "precious" });
  register(fixture, "Which database?", ["SQLite"]);

  const opened = pressShortcut(fixture);
  await until(() => fixture.component.current !== undefined);
  const component = fixture.component.current!;
  component.handleInput!(ENTER); // answer view
  component.handleInput!(DOWN); // Type something…
  component.handleInput!(ENTER); // editing
  for (const ch of "partial") component.handleInput!(ch);

  assert.ok(fixture.hooks.has("session_shutdown"), "the abort hook is registered");
  fixture.hooks.get("session_shutdown")!();
  await until(() => fixture.instances[0]!.getText() === "precious");
  assert.equal(fixture.instances[0]!.getText(), "precious", "the displaced chat draft is back in the instance");

  // The abort settled the episode back to the answer rows; close from there.
  const frame = component.render!(80).join("\n");
  assert.ok(frame.includes("Type something"), `back on the option rows: ${frame}`);
  component.handleInput!(ESCAPE); // answer rows → list
  component.handleInput!(ESCAPE); // close the list

  await opened;
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.state.draft, "precious", "the reset carries the draft, not the partial answer");
});

test("a stale session identity never opens another session's list", async () => {
  const fixture = makeFixture();
  register(fixture, "Which database?", ["SQLite"]);

  const otherSession = { id: "other-session" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the shortcut never resolved")), 5000);
  });
  const opened = Promise.race([
    (fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>)({
      ...fixture.ctx,
      sessionManager: otherSession,
    }),
    guard,
  ]).finally(() => clearTimeout(timer));
  await opened; // resolves immediately — nothing was presented

  assert.equal(fixture.instances.length, 0, "no field was acquired for a foreign session");
  assert.equal(fixture.component.current, undefined, "the list never opened");
});

test("with no pending questions the shortcut only notifies", async () => {
  const fixture = makeFixture();

  const opened = pressShortcut(fixture);
  await opened;

  assert.equal(fixture.instances.length, 0);
  assert.equal(fixture.component.current, undefined, "the list never opened");
  assert.ok(
    fixture.notices.some((n) => /no pending questions/i.test(n)),
    `an explicit notice is sent: ${JSON.stringify(fixture.notices)}`,
  );
});
