/**
 * AskUserQuestion free-text parity with the host-wired native editor.
 *
 * The free-text row embeds the SAME host-wired CustomEditor instance the
 * /review-settings text fields use, acquired through the shared bridge
 * (src/native-editor-bridge.ts) before the list's custom slot opens. Three
 * tiers, mirroring the bridge test split:
 *
 * 1. Wiring tier (always runs): createBridgeUi + structural CustomEditor
 *    stand-in + acquireNativeEditorField drive the REAL question component
 *    with the acquired instance. Pins: acquisition before the custom slot,
 *    prepare("") after the host's draft capture (the field starts empty and
 *    the displaced chat draft is recorded), Enter submits the whole answer
 *    through the native submit path (never a chat message), empty Enter
 *    stays open, Esc returns to the choice rows with the draft kept (both
 *    through the component's cancel pre-check and through the bridge's
 *    app.interrupt interception under a rebound cancel), Ctrl+D-empty
 *    returns to the rows, list-first completion semantics, per-answer-view
 *    draft reset on the shared instance, chat-draft survival exactly once,
 *    ownership-checked restore (foreign factory by identity + notice), and
 *    the session-reset abort.
 *
 * 2. Real-host tier (installed Pi; skip-or-fail via PI_REVIEW_GATE_REQUIRE_PI_HOST):
 *    the installed CustomEditor + pi-tui with a real KeybindingsManager,
 *    driven through the same component: native Tab path completion, the
 *    fd-backed `@` picker, Ctrl+C clears (never cancels) through the host's
 *    copied app handler, Ctrl+G external editing of the field instance,
 *    Ctrl+V image paste to a temp path, exact bracketed multiline `.png`
 *    paste visibility before another keypress, Shift+Enter newlines with intact
 *    multi-line submission, Esc list-first dismissal, and user keybinding
 *    overrides. Both tiers drive through the createBridgeUi host simulator
 *    and simulated app-handler bodies (the real-host tier additionally runs
 *    the installed CustomEditor + pi-tui); every native behavior above is
 *    observed against the installed host wherever it is resolvable.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UserQuestionController } from "../src/user-question/controller";
test.afterEach(() => {
  setNativeEditorHost(undefined);
  __resetActiveNativeEditorFieldForTest();
});
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import {
  acquireNativeEditorField,
  abortActiveNativeEditorField,
  editTextWithNativeEditor,
  setNativeEditorHost,
  __resetActiveNativeEditorFieldForTest,
} from "../src/native-editor-bridge";
import type {
  NativeEditorFactory,
  NativeEditorFieldHandle,
  NativeEditorFieldResult,
  NativeEditorFieldSemantics,
} from "../src/native-editor-bridge";
import {
  APP_KEY_DEFAULTS,
  CTRL_C,
  CTRL_D,
  CTRL_G,
  CTRL_V,
  ENTER,
  ESCAPE,
  SHIFT_ENTER,
  TAB,
  createBridgeUi,
  fakeHost,
  fakeKeybindingsManager,
  createFakeCustomEditorClass,
  findFdBinary,
  loadRealBridgeHost,
  makeDocsFixture,
  realHostAfter,
  REAL_IDENTITY_THEME,
  settle,
  skipOrFail,
  typeText,
  createRealKeybindingsManager,
} from "./bridge-fakes";
import type { BridgeComponent, BridgeUiState, FakeBridgeEditor } from "./bridge-fakes";

// ---------------------------------------------------------------------------
// Raw key sequences
// ---------------------------------------------------------------------------

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER_KEY = ENTER;
const ESCAPE_KEY = ESCAPE;
const F6 = "\x1b[17~";
const F8 = "\x1b[19~";
const CHORD = "\x1b[1;64A";

/** The question free-text row's field semantics (mirrors src/user-question/index.ts). */
const QUESTION_SEMANTICS: NativeEditorFieldSemantics = {
  onSubmitKey: (text) => (text.length > 0 ? text : null),
};

const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

/**
 * The component-level key matcher. In production this is the host's live
 * KeybindingsManager; here it mirrors the pi 0.87.1 defaults for the keys
 * the component itself interprets (navigation + cancel/clear pre-checks).
 */
function componentKeys(overrides: Record<string, string[]> = {}) {
  const table: Record<string, string[]> = {
    "tui.select.up": [UP],
    "tui.select.down": [DOWN],
    "tui.select.confirm": [ENTER_KEY],
    // The host default for cancel is escape + ctrl+c; the component's
    // editing pre-check must let ctrl+c through to the native clear.
    "tui.select.cancel": [ESCAPE_KEY, CTRL_C],
    "app.clear": [CTRL_C],
    ...overrides,
  };
  return {
    matches(data: string, keybinding: string): boolean {
      return (table[keybinding] ?? []).includes(data);
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring-tier fixture: bridge acquisition + real component
// ---------------------------------------------------------------------------

interface WiringFixtureOptions {
  draft?: string;
  priorFactory?: unknown;
  appHandlers?: Record<string, (editor: FakeBridgeEditor) => () => void>;
  onPasteImage?: (editor: FakeBridgeEditor) => () => void;
  keys?: ReturnType<typeof componentKeys>;
  /** Registered before the field is acquired and the list opens. */
  questions?: Array<{ question: string; choices?: string[]; mode?: "async" | "sync" }>;
  /** Drives the component once it is constructed (after prepare("")). */
  driver: (component: BridgeComponent, fixture: WiringFixture) => void | Promise<void>;
}

interface WiringFixture {
  controller: UserQuestionController;
  identity: object;
  sent: Array<{ message: string; options?: unknown }>;
  done: unknown[];
  state: BridgeUiState;
  instances: FakeBridgeEditor[];
  handle: NativeEditorFieldHandle;
  /** Resolves when the custom slot closes (done called), after finish(). */
  settled: Promise<void>;
}

async function makeWiringFixture(options: WiringFixtureOptions): Promise<WiringFixture> {
  // The driver runs as a microtask after this function returns; hand it the
  // fixture through a reference that is assigned before any microtask runs.
  let fixtureRef: WiringFixture | undefined;
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const sent: WiringFixture["sent"] = [];
  const controller = new UserQuestionController({
    pi: {
      sendUserMessage(message: string, opts?: unknown) {
        sent.push({ message, options: opts });
        return Promise.resolve();
      },
    },
    uiAvailable: () => true,
  });
  const identity = { sessionManager: "wiring" };
  controller.beginSession(identity);
  for (const q of options.questions ?? []) {
    registerQuestion(controller, identity, q.question, q.choices, q.mode);
  }
  const done: unknown[] = [];

  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: options.draft ?? "chat draft",
    priorFactory: options.priorFactory,
    appHandlers: options.appHandlers,
    onPasteImage: options.onPasteImage,
    drivers: [(component) => { void options.driver(component, fixtureRef!); }],
  });

  // Production order (src/user-question/index.ts): acquire BEFORE the custom
  // slot opens; prepare("") inside the factory; finish() in finally.
  const acquired = await acquireNativeEditorField(ui, { semantics: QUESTION_SEMANTICS });
  assert.equal(acquired.kind, "acquired", `acquisition succeeds: ${JSON.stringify(acquired)}`);
  const handle = (acquired as { kind: "acquired"; handle: NativeEditorFieldHandle }).handle;

  const opened = ui.custom!((tui: unknown, theme: unknown, liveKeybindings: unknown, close: (value: string | undefined) => void) => {
    handle.prepare("");
    assert.equal(handle.isolatePromptForOverlay(tui, theme, liveKeybindings), true,
      "the production popup path isolates prompt rendering without replacing the active editor");
    return createQuestionListComponent({
      controller,
      keybindings: options.keys ?? componentKeys(),
      theme: THEME,
      shortcutLabel: "Ctrl+Alt+Up",
      tuiHost: {
        matchesKey: (data: string, keyId: string) => keyId === QUESTION_LIST_SHORTCUT_KEY && data === CHORD,
      },
      nativeField: handle.instance,
      onDone: (result) => {
        done.push(result);
        close(undefined);
      },
    });
  });
  const settled = guardClose(opened.then(
    () => {
      handle.finish();
    },
    (error: unknown) => {
      handle.finish();
      // Surface driver/factory failures instead of reading them as a clean close.
      throw error;
    },
  ));

  fixtureRef = { controller, identity, sent, done, state, instances, handle, settled };
  return fixtureRef;
}

/** Race the close against a timer so an unclosed list fails fast instead of hanging on an empty event loop. */
function guardClose(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the question list never closed")), 5000);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function registerQuestion(
  controller: UserQuestionController,
  identity: object,
  question: string,
  choices?: string[],
  mode?: "async" | "sync",
): string {
  const result = controller.register(
    {
      toolCallId: `t${controller.listPending().length + 1}`,
      question,
      choices,
      mode: mode ?? "async",
    },
    identity,
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("registration failed");
  return result.question.id;
}

/** Open the answer view and confirm the free-text row (one choice registered). */
function enterEditing(component: BridgeComponent): void {
  component.handleInput?.(ENTER_KEY); // answer view (row 0 = the choice)
  component.handleInput?.(DOWN); // row 1: Type something…
  component.handleInput?.(ENTER_KEY); // start editing
}

// ---------------------------------------------------------------------------
// Wiring tier
// ---------------------------------------------------------------------------

test("wiring: prepare empties the field after the host's draft capture; Enter submits the answer, not a chat message", async () => {
  const fixture = await makeWiringFixture({
    draft: "my chat draft",
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      // The factory ran before this driver: prepare("") already applied.
      assert.equal(fixture.instances[0]!.getText(), "", "the field starts empty, not with the chat draft");
      enterEditing(component);
      for (const ch of "yes please") component.handleInput?.(ch);
      component.handleInput?.(ENTER_KEY); // submit the whole answer
    },
  });

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /Answer to pending question "Which database\?": yes please/);
  assert.equal(fixture.state.draft, "my chat draft", "the chat draft survives the round trip exactly once");
  assert.equal(fixture.state.slotFactory, undefined, "the prior (default) factory was restored");
  assert.deepEqual(fixture.state.chatSubmits, [], "no chat message was sent");
});

test("wiring: empty Enter stays open in editing; a later non-empty Enter submits", async () => {
  const fixture = await makeWiringFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      component.handleInput?.(ENTER_KEY); // empty draft: nothing to send
      assert.equal(fixture.done.length, 0, "empty Enter does not submit or close");
      for (const ch of "ok") component.handleInput?.(ch);
      component.handleInput?.(ENTER_KEY); // trimmed and submitted
    },
  });

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": ok$/);
});

test("wiring: Esc returns to the choice rows keeping the draft (component cancel pre-check)", async () => {
  const fixture = await makeWiringFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      for (const ch of "partial draft") component.handleInput?.(ch);
      component.handleInput?.(ESCAPE_KEY); // default cancel binding: back to the rows

      assert.equal(fixture.instances[0]!.getText(), "partial draft", "the draft survives backing out");
      const frame = component.render?.(80)?.join("\n") ?? "";
      assert.ok(frame.includes("Type something"), `selection stays on the free-text row: ${frame}`);

      component.handleInput?.(ENTER_KEY); // resume editing with the draft
      for (const ch of " done") component.handleInput?.(ch);
      component.handleInput?.(ENTER_KEY); // submit
    },
  });

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": partial draft done$/);
});

test("wiring: with cancel rebound, Esc reaches the bridge and settles as cancel-equivalent", async () => {
  const fixture = await makeWiringFixture({
    keys: componentKeys({ "tui.select.cancel": [F6] }), // Esc is no longer the component's cancel
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      for (const ch of "kept") component.handleInput?.(ch);
      component.handleInput?.(ESCAPE_KEY); // forwarded to the instance; the bridge intercepts app.interrupt

      assert.equal(fixture.instances[0]!.getText(), "kept", "the draft is kept");
      const frame = component.render?.(80)?.join("\n") ?? "";
      assert.ok(frame.includes("Type something"), `back on the option rows: ${frame}`);
      // The rebound cancel still works from editing.
      component.handleInput?.(ENTER_KEY); // resume editing
      component.handleInput?.(F6); // back to the answer rows again
      const frame2 = component.render?.(80)?.join("\n") ?? "";
      assert.ok(frame2.includes("Type something"), `the rebound cancel returns to the rows: ${frame2}`);
      // With cancel rebound, Esc no longer navigates either — F6 does.
      component.handleInput?.(F6); // answer rows → list
      component.handleInput?.(F6); // close the list
    },
  });

  await fixture.settled;
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
  assert.equal(fixture.sent.length, 0);
});

test("wiring: Ctrl+D on an empty editor returns to the rows instead of exiting", async () => {
  const fixture = await makeWiringFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      component.handleInput?.(CTRL_D); // empty field: cancel-equivalent, not a Pi exit

      assert.equal(fixture.state.shutdowns, 0, "the host exit path never fired");
      const frame = component.render?.(80)?.join("\n") ?? "";
      assert.ok(frame.includes("Type something"), `back on the option rows: ${frame}`);
      component.handleInput?.(ESCAPE_KEY); // answer rows → list
      component.handleInput?.(ESCAPE_KEY); // close the list
    },
  });

  await fixture.settled;
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
});

test("wiring: a visible completion list is dismissed first by Esc, then the field settles", async () => {
  const fixture = await makeWiringFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      for (const ch of "docs/") component.handleInput?.(ch);
      component.handleInput?.(TAB); // open the (fake) list
      assert.equal(fixture.instances[0]!.showingList, true, "the list is visible");
      component.handleInput?.(ESCAPE_KEY); // first Esc: dismiss the list only
      assert.equal(fixture.instances[0]!.showingList, false, "the list was dismissed");
      assert.equal(fixture.instances[0]!.getText(), "docs/", "the draft survives the dismissal");
      const frame = component.render?.(80)?.join("\n") ?? "";
      assert.ok(frame.includes("[field:docs/]"), `still editing after the dismissal: ${frame}`);
      component.handleInput?.(ESCAPE_KEY); // second Esc: back to the rows
      const frame2 = component.render?.(80)?.join("\n") ?? "";
      assert.ok(frame2.includes("Type something"), `back on the option rows: ${frame2}`);
      component.handleInput?.(ENTER_KEY); // resume editing with the kept draft
      component.handleInput?.(ENTER_KEY); // submit it
    },
  });

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": docs\/$/);
});

test("wiring: Ctrl+C is forwarded to the instance (native clear), never a cancel", async () => {
  const fixture = await makeWiringFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      for (const ch of "x") component.handleInput?.(ch);
      component.handleInput?.(CTRL_C); // default binding is BOTH cancel and clear

      assert.equal(fixture.done.length, 0, "Ctrl+C does not close the list");
      assert.ok(fixture.instances[0]!.received.includes(CTRL_C), "the key reached the instance for the native clear");
      const frame = component.render?.(80)?.join("\n") ?? "";
      assert.ok(frame.includes("[field:"), `still editing (the structural stand-in has no app handler): ${frame}`);
      component.handleInput?.(ESCAPE_KEY); // editing → answer rows
      component.handleInput?.(ESCAPE_KEY); // answer rows → list
      component.handleInput?.(ESCAPE_KEY); // close the list
    },
  });

  await fixture.settled;
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
});

test("wiring: a new answer view clears the shared instance's text", async () => {
  const fixture = await makeWiringFixture({
    questions: [
      { question: "First question?", choices: ["a"] },
      { question: "Second question?", choices: ["b"] },
    ],
    driver: (component, fixture) => {
      component.handleInput?.(ENTER_KEY); // q1's answer view
      enterEditingFromRows(component);
      for (const ch of "draft one") component.handleInput?.(ch);
      component.handleInput?.(ESCAPE_KEY); // rows — draft kept within this session
      assert.equal(fixture.instances[0]!.getText(), "draft one");

      component.handleInput?.(ESCAPE_KEY); // list (q1 selected)
      component.handleInput?.(DOWN); // select q2
      component.handleInput?.(ENTER_KEY); // q2's answer view: fresh session
      assert.equal(fixture.instances[0]!.getText(), "", "the previous draft never leaks into a new answer view");
      component.handleInput?.(ESCAPE_KEY); // rows
      component.handleInput?.(ESCAPE_KEY); // close the list
    },
  });

  await fixture.settled;
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.controller.listPending().length, 2);
});

function enterEditingFromRows(component: BridgeComponent): void {
  component.handleInput?.(DOWN); // row 1: Type something…
  component.handleInput?.(ENTER_KEY); // start editing
}

test("wiring: the chat draft survives exactly once and the foreign prior factory is restored by identity", async () => {
  const foreignFactory = (() => ({})) as never;
  const fixture = await makeWiringFixture({
    draft: "foreign-kept draft",
    priorFactory: foreignFactory,
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      for (const ch of "answer") component.handleInput?.(ch);
      component.handleInput?.(ENTER_KEY);
    },
  });

  await fixture.settled;
  assert.equal(fixture.state.slotFactory, foreignFactory, "the foreign factory is restored by identity");
  assert.equal(fixture.state.draft, "foreign-kept draft", "the displaced draft survived exactly once");
  assert.ok(
    fixture.state.notices.some((n) => n.type === "info" && /another extension/i.test(n.message)),
    `foreign ownership is named: ${JSON.stringify(fixture.state.notices)}`,
  );
});

test("wiring: a session-reset abort ends the episode and restores the draft into the instance", async () => {
  const fixture = await makeWiringFixture({
    draft: "precious draft",
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      for (const ch of "partial") component.handleInput?.(ch);
      abortActiveNativeEditorField(); // the session_shutdown hook

      assert.equal(fixture.instances[0]!.getText(), "precious draft", "the displaced chat draft is back in the instance");
      assert.equal(fixture.handle.instance.fieldActive, false, "the open episode was ended");
      assert.deepEqual(fixture.instances[0]!.render(80), ["─".repeat(80), "[field:precious draft]"],
        "session reset restores ordinary rendering on the same host-owned editor");
    },
  });

  // The list intentionally never closes here: the host owns the slot from the
  // abort on, and finish() (already run) must be a no-op. Capture any
  // driver/factory failure instead of swallowing it — the guard's late
  // "never closed" rejection arrives after this assertion and is expected.
  let failure: unknown;
  void fixture.settled.catch((error: unknown) => {
    failure = error;
  });
  await new Promise((resolve) => setImmediate(resolve)); // let an already-rejected settled land
  assert.equal(failure, undefined, `driver/factory failure: ${String(failure)}`);
  fixture.handle.finish();
  assert.notEqual(fixture.state.slotFactory, undefined, "the bridge did not touch the slot after the abort");
});

test("wiring: a non-assignable onSubmit fails closed even without a live key matcher", async () => {
  // Exotic host: onSubmit is a read-only accessor bound to the chat
  // submitter, and there is no live key matcher. Intercepting Enter would
  // be unreliable, so the bridge must refuse acquisition before any field
  // input could reach the chat submitter.
  const instances: FakeBridgeEditor[] = [];
  const Base = createFakeCustomEditorClass(instances);
  class LockedSubmitEditor extends Base {
    private chatSubmit?: (text: string) => void;
    constructor(tui: unknown, theme: unknown, keybindings: unknown) {
      super(tui, theme, keybindings);
      Object.defineProperty(this, "onSubmit", {
        get: (): ((text: string) => void) | undefined => this.chatSubmit,
        set: (_value: (text: string) => void): void => {
          throw new Error("onSubmit is read-only on this host");
        },
        configurable: true,
      });
    }
  }
  const chatSubmits: string[] = [];
  let slotFactory: NativeEditorFactory | undefined;
  const ui = {
    setEditorComponent(factory: NativeEditorFactory | undefined): void {
      slotFactory = factory;
      if (!factory) return;
      const editor = factory({}, REAL_IDENTITY_THEME, null) as FakeBridgeEditor;
      (editor as unknown as { chatSubmit?: (text: string) => void }).chatSubmit = (text: string) => {
        chatSubmits.push(text);
      };
    },
    getEditorComponent(): NativeEditorFactory | undefined {
      return slotFactory;
    },
    notify(): void {},
  };
  setNativeEditorHost({ CustomEditor: LockedSubmitEditor as never });

  assert.deepEqual(await acquireNativeEditorField(ui, { semantics: QUESTION_SEMANTICS }), {
    kind: "unavailable",
    reason: "the native submit path could not be taken over",
  });
  assert.equal(slotFactory, undefined, "the prior editor factory was restored");
  assert.deepEqual(chatSubmits, [], "no field input reached the chat submitter");
});

test("wiring: overlapping acquisitions across the host-load await install only one field", async () => {
  // Two opens that overlap across the awaited host load (e.g. a repeated
  // shortcut chord during the cold host-module load) must not both install:
  // the second would clobber the first's session and capture the bridge's
  // own factory as "foreign" prior.
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const ui1 = createBridgeUi({ keybindings: fakeKeybindingsManager(), draft: "draft one", drivers: [] });
  const ui2 = createBridgeUi({ keybindings: fakeKeybindingsManager(), draft: "draft two", drivers: [] });

  // Fire both without awaiting the first — the overlap across the await.
  const first = acquireNativeEditorField(ui1.ui, { semantics: QUESTION_SEMANTICS });
  const second = acquireNativeEditorField(ui2.ui, { semantics: QUESTION_SEMANTICS });
  const [r1, r2] = (await Promise.all([first, second])) as Array<
    | { kind: "acquired"; handle: NativeEditorFieldHandle }
    | { kind: "unavailable"; reason: string }
  >;

  assert.deepEqual(
    [r1.kind, r2.kind].sort(),
    ["acquired", "unavailable"],
    `exactly one installation: ${JSON.stringify([r1, r2])}`,
  );
  const loser = r1.kind === "acquired" ? r2 : r1;
  assert.equal((loser as { kind: "unavailable"; reason: string }).reason, "a native editor field is already open");
  assert.equal(instances.length, 1, "only one field instance was created");

  // The winner's session is live and finishable; the loser's slot is untouched.
  const winner = (r1.kind === "acquired" ? r1 : r2) as { kind: "acquired"; handle: NativeEditorFieldHandle };
  const loserUi = r1.kind === "acquired" ? ui2 : ui1;
  assert.equal(loserUi.state.slotFactory, undefined, "the refused open never touched its slot");
  winner.handle.finish();
});

test("wiring: overlapping settings-field opens across the host-load await install only one field", async () => {
  // The same one-field invariant on the settings entry point. With the
  // post-await re-check, exactly one open installs and the other is refused
  // before it touches its slot; without it, both would install (two
  // instances) and the clobbered session could never be told apart.
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const uiA = createBridgeUi({ keybindings: fakeKeybindingsManager(), draft: "draft A", drivers: [] });
  const uiB = createBridgeUi({ keybindings: fakeKeybindingsManager(), draft: "draft B", drivers: [] });

  // Fire both without awaiting the first — the overlap across the await.
  const a = editTextWithNativeEditor(uiA.ui, { title: "T", prefill: "" });
  const b = editTextWithNativeEditor(uiB.ui, { title: "T", prefill: "" });

  // Let both continuations run; the refusal (when present) is immediate.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(instances.length, 1, "only one settings field instance was created");

  // Settle the live field as a cancel and collect both outcomes.
  abortActiveNativeEditorField();
  const [ra, rb] = (await Promise.all([a, b])) as [NativeEditorFieldResult, NativeEditorFieldResult];
  assert.deepEqual(
    [ra.kind, rb.kind].sort(),
    ["cancel", "unavailable"],
    `one live field settled by the abort, one refused: ${JSON.stringify([ra, rb])}`,
  );
});

test("wiring: unavailable native seams render an unavailable row; choices and Decline still work", async () => {
  const sent: Array<{ message: string }> = [];
  const controller = new UserQuestionController({
    pi: {
      sendUserMessage(message: string) {
        sent.push({ message });
        return Promise.resolve();
      },
    },
    uiAvailable: () => true,
  });
  const identity = { sessionManager: "unavailable" };
  controller.beginSession(identity);
  const done: unknown[] = [];
  const component = createQuestionListComponent({
    controller,
    keybindings: componentKeys(),
    theme: THEME,
    shortcutLabel: "Ctrl+Alt+Up",
    onDone: (result) => done.push(result),
  });
  const result = controller.register(
    { toolCallId: "t1", question: "Which database?", choices: ["SQLite"], mode: "async" },
    identity,
  );
  assert.ok(result.ok);

  component.handleInput(ENTER_KEY); // answer view
  const frame = component.render(80).join("\n").replace(/\n\s*/g, " ");
  assert.match(frame, /Free text unavailable/, "the free-text row names the unavailable native editor");
  assert.match(frame, /choices and\s+Decline still work/);

  component.handleInput(DOWN); // Type something… (unavailable)
  component.handleInput(ENTER_KEY); // confirming it is a no-op — nothing to edit
  const frame2 = component.render(80).join("\n");
  assert.ok(frame2.includes("Free text unavailable"), "still on the rows; editing was never entered");

  component.handleInput(UP); // back to the choice
  component.handleInput(ENTER_KEY); // confirm the choice
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, "the choice still works");
  assert.match(sent[0]!.message, /": SQLite$/);
});

test("wiring: acquisition is refused while another field is open", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui } = createBridgeUi({ keybindings: fakeKeybindingsManager(), drivers: [] });
  const first = await acquireNativeEditorField(ui, { semantics: QUESTION_SEMANTICS });
  assert.equal(first.kind, "acquired");
  try {
    const second = await acquireNativeEditorField(ui, { semantics: QUESTION_SEMANTICS });
    assert.deepEqual(second, { kind: "unavailable", reason: "a native editor field is already open" });
  } finally {
    (first as { kind: "acquired"; handle: NativeEditorFieldHandle }).handle.finish();
  }
});

test("wiring: missing seams fail closed with an unavailable result", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const full = createBridgeUi({ keybindings: fakeKeybindingsManager(), drivers: [] });
  const noSeams = { custom: full.ui.custom } as never;
  const result = await acquireNativeEditorField(noSeams, { semantics: QUESTION_SEMANTICS });
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    assert.match(result.reason, /setEditorComponent\/getEditorComponent/);
  }
});

// ---------------------------------------------------------------------------
// Real-host tier (installed Pi's CustomEditor + pi-tui, real keys)
// ---------------------------------------------------------------------------

interface RealFixtureOptions {
  draft?: string;
  userBindings?: Record<string, string | string[]>;
  appHandlers?: Record<string, (editor: FakeBridgeEditor) => () => void>;
  onPasteImage?: (editor: FakeBridgeEditor) => () => void;
  withProvider?: boolean;
  /** Host slash commands to expose through the real autocomplete provider
   * (the leak sentinel for the shared leading-`/` file routing). */
  commands?: Array<{ name: string; description?: string }>;
  /** Registered before the field is acquired and the list opens. */
  questions?: Array<{ question: string; choices?: string[] }>;
  driver: (component: BridgeComponent, fixture: RealFixture) => void | Promise<void>;
}

interface RealFixture {
  controller: UserQuestionController;
  identity: object;
  sent: Array<{ message: string; options?: unknown }>;
  done: unknown[];
  state: BridgeUiState;
  instances: FakeBridgeEditor[];
  handle: NativeEditorFieldHandle;
  settled: Promise<void>;
}

async function makeRealFixture(options: RealFixtureOptions): Promise<RealFixture | undefined> {
  const loaded = await loadRealBridgeHost();
  if (!loaded) return undefined;
  let fixtureRef: RealFixture | undefined;
  const instances: FakeBridgeEditor[] = [];
  const NativeCustomEditor = loaded.host.CustomEditor;
  setNativeEditorHost({
    ...loaded.host,
    CustomEditor: class extends NativeCustomEditor {
      constructor(tui: unknown, theme: unknown, keybindings: unknown, options?: unknown) {
        super(tui, theme, keybindings, options);
        // Observe the exact host-created instance at the public factory seam;
        // this is the object the bridge must keep as the active slot owner.
        instances.push(this as unknown as FakeBridgeEditor);
      }
    },
  });
  const sent: RealFixture["sent"] = [];
  const controller = new UserQuestionController({
    pi: {
      sendUserMessage(message: string, opts?: unknown) {
        sent.push({ message, options: opts });
        return Promise.resolve();
      },
    },
    uiAvailable: () => true,
  });
  const identity = { sessionManager: "real" };
  controller.beginSession(identity);
  for (const q of options.questions ?? []) {
    registerQuestion(controller, identity, q.question, q.choices);
  }
  const done: unknown[] = [];

  const keybindings = options.userBindings
    ? createRealKeybindingsManagerWithOverrides(loaded.tui, options.userBindings)
    : createRealKeybindingsManager(loaded.tui);
  let provider: unknown;
  if (options.withProvider !== false) {
    const root = await makeDocsFixture();
    const fdPath = findFdBinary();
    provider = new (loaded.tui.CombinedAutocompleteProvider as new (commands: Array<{ name: string; description?: string }>, basePath: string, fdPath?: string) => unknown)(options.commands ?? [], root, fdPath);
  }
  const { ui, state } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    customTheme: THEME,
    keybindings,
    draft: options.draft ?? "chat draft",
    provider,
    appHandlers: options.appHandlers,
    onPasteImage: options.onPasteImage,
    drivers: [(component) => { void options.driver(component, fixtureRef!); }],
  });

  const acquired = await acquireNativeEditorField(ui, { semantics: QUESTION_SEMANTICS });
  if (acquired.kind !== "acquired") throw new Error(`real acquisition failed: ${JSON.stringify(acquired)}`);
  const handle = acquired.handle;

  const opened = ui.custom!((tui: unknown, theme: unknown, hostKeybindings: unknown, close: (value: string | undefined) => void) => {
    handle.prepare("");
    assert.equal(handle.isolatePromptForOverlay(tui, theme, hostKeybindings), true,
      "the production popup path isolates prompt rendering without replacing the active editor");
    return createQuestionListComponent({
      controller,
      keybindings, // the live manager drives both the component and the instance
      theme: THEME,
      shortcutLabel: "Ctrl+Alt+Up",
      tuiHost: {
        matchesKey: (data: string, keyId: string) => keyId === QUESTION_LIST_SHORTCUT_KEY && data === CHORD,
        visibleWidth: (text: string) => (loaded.tui.visibleWidth as (value: string) => number)(text),
      },
      nativeField: handle.instance,
      onDone: (result) => {
        done.push(result);
        close(undefined);
      },
    });
  });
  const settled = guardClose(opened.then(
    () => {
      handle.finish();
    },
    (error: unknown) => {
      handle.finish();
      // Surface driver/factory failures instead of reading them as a clean close.
      throw error;
    },
  ));

  fixtureRef = { controller, identity, sent, done, state, instances, handle, settled };
  return fixtureRef;
}

/**
 * A real KeybindingsManager with user overrides applied (the shared
 * createRealKeybindingsManager hardcodes empty user bindings; bridge-fakes.ts
 * is owned by another slice, so the override variant lives here).
 */
function createRealKeybindingsManagerWithOverrides(
  tui: Record<string, unknown>,
  userBindings: Record<string, string | string[]>,
): { matches(data: string, keybinding: string): boolean } {
  const definitions = {
    ...(tui.TUI_KEYBINDINGS as Record<string, unknown>),
    ...Object.fromEntries(Object.entries(APP_KEY_DEFAULTS).map(([id, keys]) => [id, { defaultKeys: keys, description: "" }])),
  };
  const manager = new (tui.KeybindingsManager as new (definitions: unknown, userBindings: unknown) => {
    matches(data: string, keybinding: string): boolean;
  })(definitions, userBindings);
  (tui.setKeybindings as (keybindings: unknown) => void)(manager);
  return manager;
}

/** Rendered lines with the hardware-cursor marker and ANSI styles removed. */
function plainLines(tui: Record<string, unknown>, lines: string[]): string[] {
  const marker = typeof tui.CURSOR_MARKER === "string" ? (tui.CURSOR_MARKER as string) : "\x1b_pi:c\x07";
  return lines.map((line) => line.split(marker).join(""));
}

function stripSgr(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Recover the native text rows from the first bordered popup frame. The exact
 * popup-side borders, one-cell popup padding, and two-cell answer-row indent
 * are structural; content glyphs and editor padding are otherwise preserved.
 */
function nativeEditorTextRowsInPopup(
  tui: Record<string, unknown>,
  frameRows: string[],
  nativeEditorBox: string[],
): string[] {
  const top = frameRows.findIndex((line) => /^┌─+┐$/u.test(line));
  const bottom = top < 0 ? -1 : frameRows.findIndex((line, index) => index > top && /^└─+┘$/u.test(line));
  assert.ok(top >= 0 && bottom > top, `the first post-paste frame has a bounded popup: ${frameRows.join("\n")}`);
  const popupWidth = frameRows[top]!.length;
  assert.equal(frameRows[bottom]!.length, popupWidth, "popup borders have the same measured width");
  const popupContentRows = frameRows.slice(top + 1, bottom);
  assert.ok(popupContentRows.every((line) => line.length === popupWidth
    && line.startsWith("│") && line.endsWith("│")),
  `every popup content row is enclosed by its vertical borders: ${frameRows.join("\n")}`);

  const editorWidth = popupWidth - 6; // outer border + popup padding + the two-cell answer-row indent
  const editorStart = 4; // left border + popup padding + answer-row indent
  const editorEnd = editorStart + editorWidth;
  assert.ok(editorWidth > 0 && editorEnd === popupWidth - 2,
    "the measured editor box fits exactly between popup padding cells");
  const embeddedRows = popupContentRows.map((line) => line.slice(editorStart, editorEnd));
  assert.ok(nativeEditorBox.every((line) => typeof line === "string"),
    `the host theme rendered editor borders rather than undefined rows: ${frameRows.join("\n")}`);
  const renderedBox = plainLines(tui, nativeEditorBox).map(stripSgr);
  assert.ok(renderedBox.length >= 3, "the native editor rendered its top border, content, and bottom border");
  assert.ok(renderedBox[0]!.startsWith("─") && renderedBox.at(-1)!.startsWith("─"),
    "the real editor's border formatter returned both horizontal borders");
  assert.ok(renderedBox.every((line) => line.length === editorWidth),
    "the captured native editor rows match the measured popup editor width");

  let embeddedAt = -1;
  for (let start = 0; start <= embeddedRows.length - renderedBox.length; start += 1) {
    if (renderedBox.every((line, offset) => embeddedRows[start + offset] === line)) {
      embeddedAt = start;
      break;
    }
  }
  assert.ok(embeddedAt >= 0,
    `the exact native editor box is present inside the bounded popup: ${frameRows.join("\n")}`);
  return renderedBox.slice(1, -1);
}

/** Match every expected character in order across rendered wrap rows. */
function renderedRowsContainOrderedText(rows: readonly string[], expected: string): boolean {
  let offset = 0;
  for (const row of rows) {
    if (offset === expected.length) return true;
    if (expected[offset] === "\n") offset += 1; // logical editor newline: the next rendered row
    if (offset === expected.length) return true;

    const leadingSpaces = /^ */u.exec(row)?.[0].length ?? 0;
    let bestMatch = 0;
    for (let start = 0; start <= leadingSpaces; start += 1) {
      let matched = 0;
      while (offset + matched < expected.length
        && expected[offset + matched] !== "\n"
        && row[start + matched] === expected[offset + matched]) {
        matched += 1;
      }
      if (matched > 0 && /^ *$/u.test(row.slice(start + matched))) bestMatch = Math.max(bestMatch, matched);
    }
    if (bestMatch === 0) return false;
    offset += bestMatch;
  }
  return offset === expected.length;
}

test("real host: `/se` in the question free-text row never lists slash commands and submits raw text", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const fixture = await makeRealFixture({
    withProvider: true,
    // The host slash-command menu the screenshot showed for `/se` in
    // AskUserQuestion answers — the leak sentinel.
    commands: [
      { name: "settings", description: "Host settings" },
      { name: "session", description: "Session commands" },
      { name: "subtasks", description: "Background subtasks" },
      { name: "review-settings", description: "Review gate settings" },
    ],
    questions: [{ question: "Which file?", choices: ["none"] }],
    driver: async (component, fixture) => {
      enterEditing(component);
      typeText(component, "/se");
      await settle(300); // the natural trigger request completes
      const frame = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame.includes("/se"), `the typed token is the draft: ${frame}`);
      assert.ok(!frame.includes("review-settings"), `no review-settings command offered: ${frame}`);
      assert.ok(!frame.includes("Host settings"), `no host command offered: ${frame}`);
      assert.ok(!frame.includes("Session commands"), `no session command offered: ${frame}`);
      assert.ok(!frame.includes("Background subtasks"), `no subtasks command offered: ${frame}`);
      component.handleInput?.(ENTER_KEY); // submits the raw text as the answer
    },
  });
  if (!fixture) return; // unreachable: the host was resolved above

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": \/se$/);
  assert.deepEqual(fixture.state.chatSubmits, [], "no chat message was sent");
});

test("real host: Tab path completion works in the question field; Esc dismisses first, then returns to rows", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const fixture = await makeRealFixture({
    withProvider: true,
    questions: [{ question: "Which file?", choices: ["none"] }],
    driver: async (component, fixture) => {
      enterEditing(component);
      typeText(component, "docs/");
      await settle();
      component.handleInput?.(TAB); // open the native list
      await settle();
      const frame = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame.includes("assets/"), `folder listed: ${frame}`);
      assert.ok(frame.includes("guide.md"), `file listed: ${frame}`);
      component.handleInput?.(TAB); // apply the highlighted folder natively
      await settle();
      assert.equal(fixture.handle.instance.getText(), "docs/assets/", "the completion was applied to the field");

      component.handleInput?.(ESCAPE_KEY); // back to the answer rows, draft kept
      const frame2 = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame2.includes("Type something"), `back on the option rows: ${frame2}`);
      component.handleInput?.(ENTER_KEY); // resume editing with the completed draft
      component.handleInput?.(ENTER_KEY); // submit it
    },
  });
  if (!fixture) return; // unreachable: the host was resolved above

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": docs\/assets\/$/);
  assert.deepEqual(fixture.state.chatSubmits, [], "no chat message was sent");
});

test("real host: the fd-backed @ picker applies a fuzzy match into the answer", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  const fdPath = findFdBinary();
  if (!fdPath) {
    skipOrFail(t, "fd is not resolvable (PATH and PI_REVIEW_GATE_FD); the @ picker cannot be exercised");
    return;
  }
  realHostAfter(t);

  const fixture = await makeRealFixture({
    questions: [{ question: "Which file?", choices: ["none"] }],
    driver: async (component, fixture) => {
      enterEditing(component);
      typeText(component, "@gui"); // fuzzy prefix for docs/guide.md
      component.handleInput?.(TAB); // forced fuzzy file search
      await settle(400); // the fd round trip completes; a single match auto-applies
      const frame = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame.includes("@docs/guide.md"), `the fuzzy match was applied natively: ${frame}`);
      component.handleInput?.(ENTER_KEY); // submit the answer with the picked file
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /@docs\/guide\.md/);
});

test("real host: Ctrl+C clears the field draft and never cancels", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const fixture = await makeRealFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      typeText(component, "some text");
      component.handleInput?.(CTRL_C); // the real key matches app.clear through the copied handler

      assert.equal(fixture.state.shutdowns, 0, "a single Ctrl+C never exits");
      const frame = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(!frame.includes("some text"), `the draft was cleared: ${frame}`);
      assert.ok(frame.includes("Enter submit · Esc back to options"), `still editing after the clear: ${frame}`);

      typeText(component, "again");
      component.handleInput?.(ENTER_KEY); // submit what remains
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": again$/);
});

test("real host: Ctrl+G runs the external editor against the field instance", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const externalEdits: string[] = [];
  const fixture = await makeRealFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    appHandlers: {
      "app.editor.external": (editor) => () => {
        const content = editor.getExpandedText();
        externalEdits.push(content);
        editor.setText(`${content} [externally edited]`);
      },
    },
    driver: (component, fixture) => {
      enterEditing(component);
      typeText(component, "base line");
      component.handleInput?.(CTRL_G); // the real key matches app.editor.external
      component.handleInput?.(ENTER_KEY);
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.deepEqual(externalEdits, ["base line"], "the external editor saw the field's expanded text exactly once");
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": base line \[externally edited\]$/);
});

test("real host: Ctrl+V image paste inserts the temp path into the answer", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const FAKE_IMAGE_PATH = "/tmp/pi-clipboard-question-1234.png";
  const fixture = await makeRealFixture({
    questions: [{ question: "Attach a screenshot?", choices: ["none"] }],
    onPasteImage: (editor) => () => {
      editor.insertTextAtCursor(FAKE_IMAGE_PATH);
    },
    driver: (component, fixture) => {
      enterEditing(component);
      component.handleInput?.(CTRL_V); // real keypress through the real editor
      const frame = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame.includes(FAKE_IMAGE_PATH), `the temp path is in the field: ${frame}`);
      component.handleInput?.(ENTER_KEY); // submit with the pasted path
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, new RegExp(FAKE_IMAGE_PATH.replace(/\//g, "\\/")));
});

test("real host: bracketed multiline paste shows the complete owned .png path before submit and restores the draft", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const imageRoot = await mkdtemp(join(tmpdir(), "pi-question-paste-"));
  t.after(async () => rm(imageRoot, { recursive: true, force: true }));
  const imageDirectory = join(imageRoot, "My Screenshots");
  await mkdir(imageDirectory, { recursive: true });
  const imagePath = join(imageDirectory, `clipboard-${"image-".repeat(6)}owned.png`);
  await writeFile(imagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ));

  const savedDraft = "  preserve this exact chat draft\nwith its second line  ";
  const pastedAnswer = [
    imagePath,
    "OCR notes: the complete clipboard path must be visible without another keypress.",
    `long line: ${"the first settled frame preserves the full answer and attachment path. ".repeat(2)}`,
    "tail sentinel: bracketed paste is complete",
  ].join("\n");
  const fixture = await makeRealFixture({
    draft: savedDraft,
    withProvider: false,
    questions: [{ question: "Attach a screenshot?", choices: ["none"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      const field = fixture.handle.instance;
      assert.equal(field, fixture.instances[0], "the captured host factory instance remains the active popup field");
      const renderForPopup = field.renderForPopup;
      assert.ok(renderForPopup, "the host field exposes its popup render path");
      let firstNativeEditorBox: string[] | undefined;
      field.renderForPopup = (width) => {
        const rendered = renderForPopup.call(field, width);
        firstNativeEditorBox ??= rendered;
        return rendered;
      };

      const bracketedPaste = `\x1b[200~${pastedAnswer}\x1b[201~`;
      component.handleInput?.(bracketedPaste);

      // Observe the first render after the complete paste; do not send a
      // Backspace, retype, or other input before checking the terminal frame.
      const firstFrameRows = plainLines(loaded.tui, component.render!(120)).map(stripSgr);
      const firstSettledFrame = firstFrameRows.join("\n");
      assert.ok(!firstFrameRows.some((line) => line.includes("undefined")),
        `the first frame has no undefined editor-border row: ${firstSettledFrame}`);
      assert.ok(firstNativeEditorBox, "the first popup render observed the native editor's own rows");
      const nativeTextRows = nativeEditorTextRowsInPopup(loaded.tui, firstFrameRows, firstNativeEditorBox);
      assert.ok(renderedRowsContainOrderedText(nativeTextRows, imagePath),
        `the complete owned image path, including .png, is visible in order in the first post-paste frame: ${firstSettledFrame}`);
      assert.ok(renderedRowsContainOrderedText(nativeTextRows, pastedAnswer),
        `the complete multiline answer is visible in order before another keypress: ${firstSettledFrame}`);
      assert.equal(field.getText(), pastedAnswer, "the field contains the exact bracketed-paste payload");
      component.handleInput?.(ENTER_KEY);
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.equal(
    fixture.sent[0]!.message,
    `Answer to pending question "Attach a screenshot?": ${pastedAnswer}`,
    "the submitted message preserves the exact canonical multiline answer",
  );
  assert.equal(fixture.state.draft, savedDraft, "submit restores the exact suspended chat draft");
  assert.deepEqual(fixture.state.chatSubmits, [], "the pasted answer never enters the chat submit path");
});

test("real host: isolated free text keeps native actions on the popup and restores the exact chat draft", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const savedDraft = "  exact chat draft\nwith a second line  ";
  const externalEdits: string[] = [];
  const clipboardText = " [clipboard insertion]";
  const submitted = await makeRealFixture({
    draft: savedDraft,
    withProvider: false,
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    appHandlers: {
      "app.editor.external": (editor) => () => {
        const content = editor.getExpandedText();
        externalEdits.push(content);
        editor.setText(`${content} [externally edited]`);
      },
    },
    onPasteImage: (editor) => () => editor.insertTextAtCursor(clipboardText),
    driver: (component, fixture) => {
      const cursorMarker = typeof loaded.tui.CURSOR_MARKER === "string"
        ? loaded.tui.CURSOR_MARKER as string
        : "\x1b_pi:c\x07";
      const assertPromptIsolated = (expectedPopupText: string): void => {
        const popup = component.render!(120).join("\n");
        const ordinaryRows = fixture.instances[0]!.render(120);
        const ordinaryPrompt = ordinaryRows.join("\n");
        assert.ok(popup.includes(expectedPopupText), `answer remains visible in the popup: ${popup}`);
        assert.equal(fixture.handle.instance.focused, true, "the same native editor owns popup input focus");
        assert.equal(popup.split("\x1b[7m").length - 1, 1,
          `the popup has exactly one inverse-video native caret: ${popup}`);
        assert.equal(popup.split(cursorMarker).length - 1, 1,
          `the popup has exactly one hardware-cursor marker: ${popup}`);
        assert.deepEqual(ordinaryRows, [], "the underlying prompt contributes no editor rows while the popup owns the field");
        assert.equal(ordinaryPrompt.includes(expectedPopupText), false,
          `answer text is absent from the ordinary prompt: ${ordinaryPrompt}`);
        assert.equal(ordinaryPrompt.includes(cursorMarker), false,
          `the native cursor marker is absent from the ordinary prompt: ${ordinaryPrompt}`);
        assert.equal(ordinaryPrompt.includes("\x1b[7m"), false,
          `the unfocused native editor's inverse fake cursor is absent from the ordinary prompt: ${ordinaryPrompt}`);
      };

      assert.equal(fixture.instances.length, 1, "the host-owned native field is the only editor created for the popup");
      assert.equal(fixture.handle.instance, fixture.instances[0],
        "the popup field remains the host's active editor-slot owner");
      enterEditing(component);
      typeText(component, "discard this draft");
      assertPromptIsolated("discard this draft");
      component.handleInput?.(CTRL_C);
      assert.equal(fixture.handle.instance.getText(), "", "Ctrl+C clears the popup field");

      typeText(component, "answer");
      component.handleInput?.(CTRL_G);
      assert.deepEqual(externalEdits, ["answer"], "Ctrl+G reads the popup field through the host's dynamic editor target");
      component.handleInput?.(CTRL_V);
      const expectedAnswer = `answer [externally edited]${clipboardText}`;
      assert.equal(fixture.handle.instance.getText(), expectedAnswer,
        "external-editor and clipboard actions modify the popup field, not the prompt renderer");
      assertPromptIsolated(expectedAnswer);
      component.handleInput?.(ENTER_KEY);
    },
  });
  if (!submitted) return;
  await submitted.settled;
  assert.equal(submitted.sent.length, 1);
  assert.equal(submitted.sent[0]!.message, 'Answer to pending question "Which database?": answer [externally edited] [clipboard insertion]');
  assert.equal(submitted.state.draft, savedDraft, "submit restores the exact suspended chat draft");
  assert.equal(submitted.handle.instance.getText(), savedDraft, "the same host editor regains the exact independent chat draft");
  assert.equal(submitted.handle.instance.focused, false, "the ordinary editor is unfocused after the popup closes");
  const restoredPrompt = submitted.handle.instance.render(120).join("\n");
  assert.ok(restoredPrompt.includes("exact chat draft"), `ordinary prompt rendering returns after submit: ${restoredPrompt}`);
  assert.ok(restoredPrompt.includes("\x1b[7m"),
    "the real unfocused native editor still emits its inverse fake cursor when ordinary rendering is restored");
  assert.deepEqual(submitted.state.chatSubmits, [], "the answer never enters the chat submit path");

  for (const closeMode of ["cancel", "toggle"] as const) {
    const fixture = await makeRealFixture({
      draft: savedDraft,
      withProvider: false,
      questions: [{ question: "Which database?", choices: ["SQLite"] }],
      driver: (component) => {
        enterEditing(component);
        typeText(component, `partial ${closeMode} draft`);
        if (closeMode === "cancel") {
          component.handleInput?.(ESCAPE_KEY); // leave native editing
          component.handleInput?.(ESCAPE_KEY); // return to the pending list
          component.handleInput?.(ESCAPE_KEY); // close without submitting
        } else {
          component.handleInput?.(CHORD); // close the overlay without submitting
        }
      },
    });
    if (!fixture) return;
    await fixture.settled;
    assert.equal(fixture.state.draft, savedDraft, `${closeMode} restores the exact chat draft`);
    assert.equal(fixture.handle.instance.getText(), savedDraft, `${closeMode} restores the draft into the original editor`);
    assert.ok(fixture.handle.instance.render(120).join("\n").includes("exact chat draft"),
      `${closeMode} restores ordinary editor rendering`);
    assert.equal(fixture.sent.length, 0, `${closeMode} does not submit an answer`);
    assert.equal(fixture.controller.listPending().length, 1, `${closeMode} leaves the question pending`);
  }
});

test("real host: Shift+Enter inserts a newline and the multi-line answer submits intact", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const fixture = await makeRealFixture({
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      typeText(component, "line one");
      component.handleInput?.(SHIFT_ENTER); // native newline
      typeText(component, "line two");
      component.handleInput?.(ENTER_KEY);
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": line one\nline two$/);
});

test("real host: user keybinding overrides reach the question field", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  // Rebind submit to F8; Enter must stop submitting from the field.
  const fixture = await makeRealFixture({
    userBindings: { "tui.input.submit": ["f8"] },
    questions: [{ question: "Which database?", choices: ["SQLite"] }],
    driver: (component, fixture) => {
      enterEditing(component);
      typeText(component, "one two three");

      component.handleInput?.(ENTER_KEY);
      assert.equal(fixture.done.length, 0, "Enter no longer submits after the rebind");
      const frame = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame.includes("one two three"), `the draft is untouched by the inert Enter: ${frame}`);

      component.handleInput?.(F8); // the user's submit binding
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0]!.message, /": one two three$/);
});

test("real host: Esc dismisses a visible completion list first, then returns to the rows", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const fixture = await makeRealFixture({
    withProvider: true,
    questions: [{ question: "Which file?", choices: ["none"] }],
    driver: async (component, fixture) => {
      enterEditing(component);
      typeText(component, "docs/");
      await settle();
      component.handleInput?.(TAB); // open the list
      await settle();
      const frame = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame.includes("assets/"), "the list is visible");

      component.handleInput?.(ESCAPE_KEY); // first Esc: dismiss the list only
      await settle();
      const frame2 = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(!frame2.includes("assets/"), `the list was dismissed: ${frame2}`);
      assert.ok(frame2.includes("docs/"), "the draft text survives the dismissal");
      assert.ok(frame2.includes("Enter submit · Esc back to options"), `still editing after the dismissal: ${frame2}`);

      component.handleInput?.(ESCAPE_KEY); // second Esc: back to the answer rows
      const frame3 = plainLines(loaded.tui, component.render!(200)).join("\n");
      assert.ok(frame3.includes("Type something"), `back on the option rows: ${frame3}`);
      component.handleInput?.(ESCAPE_KEY); // answer rows → list
      component.handleInput?.(ESCAPE_KEY); // close the list
    },
  });
  if (!fixture) return;

  await fixture.settled;
  assert.deepEqual(fixture.done, [{ kind: "closed" }]);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.state.draft, "chat draft", "the chat draft survived");
});
