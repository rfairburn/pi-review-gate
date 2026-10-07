/**
 * Question widget-sink context separation (issue #323).
 *
 * Pi 1.0.4 gives each shortcut press a fresh RAW ui whose setWidget bypasses
 * observers of the session surface (e.g. the session-host reporter's wrapped
 * setter). Routing the pending-question panel through the per-press context
 * made real native answers clear the TUI while leaving observers with a stale
 * pending presence. These tests pin the agreed separation:
 *
 * - the panel's widget sink stays bound to the session_start context (set and
 *   clear both go through it), distinct from — or identical to — the
 *   shortcut's raw ui;
 * - a foreign wrapper around the session setWidget keeps receiver, args, and
 *   forwarding in the call chain;
 * - a replacement session context retires the old sink even when its own ui
 *   is missing or throwing (best-effort clear of the old panel only, never a
 *   new-session display);
 * - a missing, throwing, or foreign shortcut identity never opens the list or
 *   retargets the sink;
 * - a session rebind (even with the same SessionManager object reused across
 *   /new/resume) fences an in-flight open and an already-open list.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  registerUserQuestions,
  userQuestionsBeginSession,
  pendingQuestionPanelLine,
  USER_QUESTION_PANEL_KEY,
  type UserQuestionSurface,
} from "../src/user-question";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";
import { QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import {
  setNativeEditorHost,
  __resetActiveNativeEditorFieldForTest,
} from "../src/native-editor-bridge";
import { createBridgeUi, fakeHost, type BridgeComponent, type BridgeUiState, type FakeBridgeEditor } from "./bridge-fakes";

const ENTER = "\r";
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

interface WidgetCall {
  key: string;
  lines: string[] | undefined;
  options?: { placement?: string };
  receiver: unknown;
}

/** A recording setWidget that also captures its method receiver. */
function makeRecordingUi() {
  const calls: WidgetCall[] = [];
  const ui: Record<string, unknown> = {
    setWidget(this: unknown, key: string, lines: string[] | undefined, options?: { placement?: string }) {
      calls.push({ key, lines, options, receiver: this });
    },
  };
  return { calls, ui };
}

interface Fixture {
  surface: UserQuestionSurface;
  shortcuts: Map<string, { description?: string; handler: (ctx: unknown) => unknown }>;
  notices: string[];
  sent: Array<{ message: string; options?: unknown }>;
  sessionManager: object;
}

function makeFixture(): Fixture {
  const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
  const notices: string[] = [];
  const sent: Fixture["sent"] = [];
  const pi: Record<string, unknown> = {
    registerTool() {},
    registerShortcut(shortcut: string, options: { description?: string; handler: (ctx: unknown) => unknown }) {
      shortcuts.set(shortcut, options);
    },
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, opts?: unknown) { sent.push({ message, options: opts }); return Promise.resolve(); },
    on() { return () => {}; },
  };
  const surface = registerUserQuestions(pi);
  assert.ok(surface, "registerUserQuestions returns the surface");
  // The session_start hook sets this in a real host; the shortcut path
  // requires it through the controller's uiAvailable gate.
  surface.setInteractiveUi(true);
  return { surface, shortcuts, notices, sent, sessionManager: { id: "session" } };
}

/** A session-bound context (what session_start carries) with a recording sink. */
function sessionContext(fixture: Fixture) {
  const recording = makeRecordingUi();
  const ctx = {
    sessionManager: fixture.sessionManager,
    mode: "tui",
    isIdle: () => true,
    ui: recording.ui,
  };
  return { ctx, calls: recording.calls };
}

function registerQuestion(fixture: Fixture, question: string, choices?: string[], identity?: object): void {
  const result = fixture.surface.controller.register(
    { toolCallId: `t${fixture.surface.controller.listPending().length + 1}`, question, choices, mode: "async" },
    identity ?? fixture.sessionManager,
  );
  assert.ok(result.ok, `question registered: ${result.ok ? "" : (result as { message: string }).message}`);
}

function liveKeybindings() {
  const table: Record<string, string[]> = {
    "tui.input.submit": [ENTER],
    "tui.select.up": ["\x1b[A"],
    "tui.select.down": ["\x1b[B"],
    "tui.select.confirm": [ENTER],
    "tui.select.cancel": ["\x1b", "\x03"],
    "app.interrupt": ["\x1b"],
    "app.exit": ["\x04"],
    "app.clear": ["\x03"],
  };
  return { matches: (data: string, keybinding: string) => (table[keybinding] ?? []).includes(data) };
}

interface ShortcutContext {
  ctx: Record<string, unknown>;
  rawCalls: WidgetCall[];
  bridgeState: BridgeUiState;
  instances: FakeBridgeEditor[];
}

/** The per-press shortcut context: a DISTINCT raw ui plus the list's custom slot. */
function makeShortcutContext(
  fixture: Fixture,
  component: { current: BridgeComponent | undefined },
): ShortcutContext {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  setUserQuestionTuiHost({ matchesKey: (data, keyId) => data === CHORD && keyId === QUESTION_LIST_SHORTCUT_KEY });
  const rawUi = makeRecordingUi();
  const bridge = createBridgeUi({
    keybindings: liveKeybindings(),
    draft: "",
    drivers: [(captured) => { component.current = captured; }],
  });
  return {
    ctx: {
      sessionManager: fixture.sessionManager,
      mode: "tui",
      isIdle: () => true,
      ui: { setWidget: rawUi.ui.setWidget, ...bridge.ui },
    },
    rawCalls: rawUi.calls,
    bridgeState: bridge.state,
    instances,
  };
}

function pressShortcut(fixture: Fixture, ctx: unknown): Promise<void> {
  // Race a timer so a list that never closes fails fast instead of hanging
  // the process on an empty event loop.
  const opened = (fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>)(ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the question list never closed")), 5000);
  });
  return Promise.race([opened, guard]).finally(() => clearTimeout(timer));
}

test("panel set and clear stay on the session-bound sink, never the shortcut's raw ui", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);

  registerQuestion(fixture, "Which database?", ["SQLite"]);
  assert.equal(session.calls.length, 1, "the panel set went through the session sink");
  assert.equal(session.calls[0]!.key, USER_QUESTION_PANEL_KEY);
  assert.deepEqual(session.calls[0]!.lines, [pendingQuestionPanelLine()]);

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const shortcut = makeShortcutContext(fixture, component);

  const opened = pressShortcut(fixture, shortcut.ctx);
  await until(() => component.current !== undefined);
  component.current!.handleInput!(ENTER); // answer view
  component.current!.handleInput!(ENTER); // confirm the choice

  await opened;
  assert.equal(fixture.sent.length, 1, "the answer was delivered");
  assert.match(fixture.sent[0]!.message, /": SQLite$/);

  const sessionClears = session.calls.filter((call) => call.lines === undefined);
  assert.equal(sessionClears.length, 1, "the panel clear went through the session sink");
  assert.equal(shortcut.rawCalls.length, 0, "the shortcut's raw ui never received a panel write");
});

test("identical session and shortcut ui objects keep the panel lifecycle intact", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const shared = makeRecordingUi();
  fixture.surface.noteContext({
    sessionManager: fixture.sessionManager,
    mode: "tui",
    isIdle: () => true,
    ui: shared.ui,
  });

  registerQuestion(fixture, "Which database?", ["SQLite"]);
  assert.equal(shared.calls.length, 1, "the panel set went through the shared ui");

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  setUserQuestionTuiHost({ matchesKey: (data, keyId) => data === CHORD && keyId === QUESTION_LIST_SHORTCUT_KEY });
  const bridge = createBridgeUi({
    keybindings: liveKeybindings(),
    draft: "",
    drivers: [(captured) => { component.current = captured; }],
  });
  // The SAME ui object carries both the sink and the list's custom slot.
  Object.assign(shared.ui, bridge.ui);
  const shortcutCtx = {
    sessionManager: fixture.sessionManager,
    mode: "tui",
    isIdle: () => true,
    ui: shared.ui,
  };

  const opened = pressShortcut(fixture, shortcutCtx);
  await until(() => component.current !== undefined);
  component.current!.handleInput!(ENTER);
  component.current!.handleInput!(ENTER);
  await opened;

  assert.equal(fixture.sent.length, 1, "the answer was delivered");
  const clears = shared.calls.filter((call) => call.lines === undefined);
  assert.equal(clears.length, 1, "the clear still went through the shared (session) ui");
});

test("a foreign wrapper around the session setWidget keeps receiver and args", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);

  // A foreign decorator (like the session-host reporter's) replaces
  // setWidget on the same ui object and forwards to the captured original.
  const forwarded: Array<{ receiver: unknown; key: string; lines: string[] | undefined; options?: unknown }> = [];
  const originalUi = {
    setWidget(this: unknown, key: string, lines: string[] | undefined, options?: unknown) {
      forwarded.push({ receiver: this, key, lines, options });
    },
  };
  const wrapper = function (this: unknown, key: string, lines: string[] | undefined, options?: unknown) {
    return originalUi.setWidget.call(this, key, lines, options);
  };
  const wrappedUi: Record<string, unknown> = { ...originalUi, setWidget: wrapper };
  fixture.surface.noteContext({
    sessionManager: fixture.sessionManager,
    mode: "tui",
    isIdle: () => true,
    ui: wrappedUi,
  });

  registerQuestion(fixture, "Which database?");

  assert.equal(forwarded.length, 1, "the panel set went through the wrapper to the original");
  assert.equal(forwarded[0]!.receiver, wrappedUi, "the method receiver is the ui object, not undefined");
  assert.equal(forwarded[0]!.key, USER_QUESTION_PANEL_KEY);
  assert.deepEqual(forwarded[0]!.lines, [pendingQuestionPanelLine()]);
  assert.deepEqual(forwarded[0]!.options, { placement: "aboveEditor" });
});

test("a healthy rebind moves the panel to the new session's sink", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const first = sessionContext(fixture);
  fixture.surface.noteContext(first.ctx);
  registerQuestion(fixture, "First session question?");

  // A healthy /new: a new identity and a new context with its own sink.
  const secondManager = { id: "second" };
  userQuestionsBeginSession(fixture.surface.controller, secondManager);
  const secondRecording = makeRecordingUi();
  fixture.surface.noteContext({
    sessionManager: secondManager,
    mode: "tui",
    isIdle: () => true,
    ui: secondRecording.ui,
  });
  fixture.surface.syncPanel();

  assert.ok(first.calls.some((call) => call.lines === undefined), "the old session's panel was cleared");
  assert.equal(
    first.calls.filter((call) => call.lines !== undefined).length,
    1,
    "the old sink shows no new panel",
  );

  registerQuestion(fixture, "New session question?", undefined, secondManager);
  const last = secondRecording.calls[secondRecording.calls.length - 1];
  assert.deepEqual(last?.lines, [pendingQuestionPanelLine()], "the new panel renders through the new sink");
  assert.equal(
    first.calls.filter((call) => call.lines !== undefined).length,
    1,
    "the retired sink never shows the new session's panel",
  );
});

test("a replacement session context retires the old sink when its ui is unusable", async () => {
  const badContexts: Array<() => Record<string, unknown>> = [
    () => {
      // A stale/invalidated runner's ui getter throws.
      const ctx: Record<string, unknown> = {};
      Object.defineProperty(ctx, "ui", { get(): unknown { throw new Error("stale runner"); } });
      return ctx;
    },
    () => ({ ui: {} }), // no setWidget
    () => ({}),         // no ui at all
  ];
  for (const makeBad of badContexts) {
    const fixture = makeFixture();
    userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
    const first = sessionContext(fixture);
    fixture.surface.noteContext(first.ctx);

    registerQuestion(fixture, "First session question?");
    assert.ok(first.calls.some((call) => call.lines !== undefined), "panel visible for the first session");

    // A new session reuses the same SessionManager object (native /new may)
    // and its context's ui is unusable.
    userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
    const bad = makeBad();
    bad.sessionManager = fixture.sessionManager;
    bad.mode = "tui";
    fixture.surface.noteContext(bad);
    fixture.surface.syncPanel();

    assert.equal(
      first.calls.filter((call) => call.lines !== undefined).length,
      1,
      "no new panel renders through the retired sink",
    );
    assert.ok(first.calls.some((call) => call.lines === undefined), "the old panel was cleared best-effort on rebind");

    // The new session's questions fail closed: no usable sink, no panel.
    registerQuestion(fixture, "New session question?");
    assert.equal(
      first.calls.filter((call) => call.lines !== undefined).length,
      1,
      "the new session's panel never renders through the old sink",
    );
  }
});

test("a missing, throwing, or foreign shortcut identity never opens the list or retargets the sink", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);

  registerQuestion(fixture, "Which database?", ["SQLite"]);
  assert.ok(session.calls.some((call) => call.lines !== undefined), "panel visible before the presses");

  const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>;
  await handler({ ui: {}, mode: "tui" }); // missing identity
  await handler({ ui: {}, mode: "tui", get sessionManager(): unknown { throw new Error("stale"); } }); // throwing getter
  await handler({ ui: {}, mode: "tui", sessionManager: { id: "other" } }); // foreign identity

  assert.equal(fixture.notices.length, 0, "stale and foreign presses are ignored silently");
  assert.equal(fixture.sent.length, 0);

  // The sink is still the session context: a new question renders through it.
  registerQuestion(fixture, "Second question?");
  assert.equal(
    session.calls.filter((call) => call.lines !== undefined).length,
    2,
    "the panel still renders through the session sink",
  );
});

test("a throwing shortcut ui getter fails closed without opening UI or touching the sink", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);
  registerQuestion(fixture, "Which database?", ["SQLite"]);
  assert.ok(session.calls.some((call) => call.lines !== undefined), "panel visible before the press");

  // The CURRENT session identity, but a stale runner whose ui getter throws.
  const throwingCtx: Record<string, unknown> = {
    sessionManager: fixture.sessionManager,
    mode: "tui",
    isIdle: () => true,
  };
  Object.defineProperty(throwingCtx, "ui", { get(): unknown { throw new Error("stale runner"); } });

  const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>;
  await handler(throwingCtx); // must resolve, not reject

  assert.equal(fixture.notices.length, 0, "a stale press is ignored silently");
  assert.equal(fixture.sent.length, 0);
  registerQuestion(fixture, "Second question?");
  assert.equal(
    session.calls.filter((call) => call.lines !== undefined).length,
    2,
    "the session sink is intact",
  );
});

test("a throwing editor-seam getter fails closed without opening UI or touching the sink", async () => {
  for (const seam of ["setEditorComponent", "getEditorComponent", "notify"] as const) {
    const fixture = makeFixture();
    userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
    const session = sessionContext(fixture);
    fixture.surface.noteContext(session.ctx);
    registerQuestion(fixture, "Which database?", ["SQLite"]);

    const component: { current: BridgeComponent | undefined } = { current: undefined };
    const shortcut = makeShortcutContext(fixture, component);
    const ui = shortcut.ctx.ui as Record<string, unknown>;
    delete ui[seam];
    Object.defineProperty(ui, seam, { get(): unknown { throw new Error("stale runner"); } });

    const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>;
    await handler(shortcut.ctx); // must resolve, not reject

    assert.equal(component.current, undefined, `${seam}: no list UI opened`);
    assert.equal(shortcut.instances.length, 0, `${seam}: no editor instance created`);
    assert.equal(shortcut.bridgeState.slotFactory, undefined, `${seam}: the editor slot was untouched`);
    assert.equal(fixture.sent.length, 0, `${seam}: no answer delivered`);
    registerQuestion(fixture, "Second question?");
    assert.equal(
      session.calls.filter((call) => call.lines !== undefined).length,
      2,
      `${seam}: the session sink is intact`,
    );
  }
});

test("the custom slot is invoked with its original ui receiver", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);
  registerQuestion(fixture, "Which database?", ["SQLite"]);

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const shortcut = makeShortcutContext(fixture, component);
  const ui = shortcut.ctx.ui as Record<string, unknown>;
  const originalCustom = ui.custom as (factory: (...args: unknown[]) => unknown) => Promise<unknown>;
  // A receiver-dependent forwarding wrapper (like a foreign decorator).
  ui.custom = function (this: unknown, factory: (...args: unknown[]) => unknown) {
    assert.equal(this, ui, "the custom slot keeps its ui receiver");
    return originalCustom.call(ui, factory);
  };

  const opened = pressShortcut(fixture, shortcut.ctx);
  await until(() => component.current !== undefined);
  component.current!.handleInput!(ENTER); // answer view
  component.current!.handleInput!(ENTER); // confirm the choice
  await opened;

  assert.equal(fixture.sent.length, 1, "the answer was delivered through the forwarding wrapper");
});

test("a session rebind while the list is opening fences the stale press before any editor install", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);
  registerQuestion(fixture, "Which database?", ["SQLite"]);

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const shortcut = makeShortcutContext(fixture, component);

  const opened = (fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>)(shortcut.ctx);
  // Rebind before the handler resumes past its first await — the same
  // SessionManager object is reused, so only the generation fence sees it.
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  fixture.surface.noteContext({ sessionManager: fixture.sessionManager, mode: "tui", ui: {} });
  registerQuestion(fixture, "New session question?");

  await opened; // resolves without opening
  assert.equal(component.current, undefined, "the stale press never opened the list UI");
  assert.equal(shortcut.instances.length, 0, "no editor instance was created");
  assert.equal(shortcut.bridgeState.slotFactory, undefined, "no editor factory was installed into the replacement session");
  assert.equal(fixture.sent.length, 0);
  assert.equal(
    session.calls.filter((call) => call.lines !== undefined).length,
    1,
    "the new session's panel never rendered through the retired sink",
  );
});

test("a session rebind during editor acquisition never installs the stale press's editor", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);
  registerQuestion(fixture, "Which database?", ["SQLite"]);

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const shortcut = makeShortcutContext(fixture, component);

  // Count reads of the original ui's editor seams to prove the rebind lands
  // inside acquisition (after the post-load check), not before it.
  let seamReads = 0;
  const ui = shortcut.ctx.ui as Record<string, unknown>;
  const setEditorComponent = ui.setEditorComponent;
  const getEditorComponent = ui.getEditorComponent;
  Object.defineProperty(ui, "setEditorComponent", { get: () => { seamReads += 1; return setEditorComponent; } });
  Object.defineProperty(ui, "getEditorComponent", { get: () => { seamReads += 1; return getEditorComponent; } });

  const opened = (fixture.shortcuts.get("ctrl+alt+up")!.handler as (ctx: unknown) => Promise<void>)(shortcut.ctx);
  // Rebind exactly during the bridge acquisition's internal host load: two
  // microtask hops land after the handler's post-load check and before the
  // bridge's install step.
  queueMicrotask(() => {
    queueMicrotask(() => {
      userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
      fixture.surface.noteContext({ sessionManager: fixture.sessionManager, mode: "tui", ui: {} });
      registerQuestion(fixture, "New session question?");
    });
  });

  await opened; // resolves without opening
  assert.ok(seamReads > 0, "the rebind landed after the post-load check, inside acquisition");
  assert.equal(component.current, undefined, "the stale press never opened the list UI");
  assert.equal(shortcut.instances.length, 0, "no editor instance was created");
  assert.equal(shortcut.bridgeState.slotFactory, undefined, "no editor factory was installed into the replacement session");
  assert.equal(fixture.sent.length, 0);
});

test("an open list closes on session rebind and never shows or submits the new session's questions", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);
  registerQuestion(fixture, "Which database?", ["SQLite"]);

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const shortcut = makeShortcutContext(fixture, component);

  const opened = pressShortcut(fixture, shortcut.ctx);
  await until(() => component.current !== undefined);
  const frame = component.current!.render!(80).join("\n");
  assert.ok(frame.includes("Which database?"), "the list shows the original session's question");

  // Rebind while the list is open (same SessionManager object — native /new reuse).
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  fixture.surface.noteContext({ sessionManager: fixture.sessionManager, mode: "tui", ui: {} });
  registerQuestion(fixture, "New session question?");

  const staleFrame = component.current!.render!(80).join("\n");
  assert.ok(!staleFrame.includes("New session question"), "the stale list never displays the new session's questions");
  assert.ok(!staleFrame.includes("Which database?"), "the stale list no longer renders its old view either");

  component.current!.handleInput!(ENTER); // must not submit into the new session
  assert.equal(fixture.sent.length, 0, "a stale UI never submits an answer");

  await opened; // the stale close settled the custom slot
  assert.equal(shortcut.bridgeState.slotFactory, undefined, "the editor factory was restored on close");
});

test("a stale free-text settle callback never submits into the replacement session", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);
  registerQuestion(fixture, "Which database?", ["SQLite"]);

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const shortcut = makeShortcutContext(fixture, component);

  const opened = pressShortcut(fixture, shortcut.ctx);
  await until(() => component.current !== undefined);
  // Enter the free-text editing episode on the native field.
  component.current!.handleInput!(ENTER); // answer view
  component.current!.handleInput!("\x1b[B"); // down to the Type row
  component.current!.handleInput!(ENTER); // begin editing
  const field = shortcut.instances[0]!;
  assert.equal(field.fieldActive, true, "the editing episode activated the field");
  const staleSettle = field.onFieldSettle;
  assert.equal(typeof staleSettle, "function", "the episode attached the settle callback");

  // Rebind with the same SessionManager object; the replacement session's
  // first question reuses id q1.
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  fixture.surface.noteContext({ sessionManager: fixture.sessionManager, mode: "tui", ui: {} });
  registerQuestion(fixture, "New session question?", ["Fresh choice"]);

  // The captured settle callback fires BEFORE any post-rebind render: it
  // closes the component and clears its cache, so the next render must not
  // fall through to the replacement session's live controller state.
  staleSettle!("stale answer");
  assert.equal(fixture.sent.length, 0, "the stale settle never delivered an answer");

  const staleFrame = component.current!.render!(80).join("\n");
  assert.ok(staleFrame.includes("Session changed"), "the closed stale UI renders its inert notice");
  assert.ok(!staleFrame.includes("New session question"), "no replacement-session question is displayed");
  assert.equal(
    fixture.surface.controller.listPending().length,
    1,
    "the replacement session's question stays pending",
  );
  assert.equal(field.fieldActive, false, "the episode was ended");
  assert.equal(field.onFieldSettle, undefined, "the settle callback was cleared");

  await opened;
});

test("stale input closing first never renders the replacement session", async () => {
  const fixture = makeFixture();
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  const session = sessionContext(fixture);
  fixture.surface.noteContext(session.ctx);
  registerQuestion(fixture, "Which database?", ["SQLite"]);

  const component: { current: BridgeComponent | undefined } = { current: undefined };
  const shortcut = makeShortcutContext(fixture, component);

  const opened = pressShortcut(fixture, shortcut.ctx);
  await until(() => component.current !== undefined);

  // Rebind while the list is open (same SessionManager object — native /new reuse).
  userQuestionsBeginSession(fixture.surface.controller, fixture.sessionManager);
  fixture.surface.noteContext({ sessionManager: fixture.sessionManager, mode: "tui", ui: {} });
  registerQuestion(fixture, "New session question?", ["Fresh choice"]);

  // Stale input closes the component first (clearing its cache); the next
  // render must not fall through to live controller state.
  component.current!.handleInput!(ENTER);
  const frame = component.current!.render!(80).join("\n");
  assert.ok(frame.includes("Session changed"), "the closed stale UI renders its inert notice");
  assert.ok(!frame.includes("New session question"), "no replacement-session question is displayed");
  assert.equal(fixture.sent.length, 0, "a stale UI never submits an answer");

  await opened;
});
