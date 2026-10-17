/**
 * Issue #431: fullscreen pointer input for the shared pending-input popup,
 * driven through the INSTALLED Pi's actual native dispatch.
 *
 * The production path runs unmodified: registerUserQuestions → shortcut
 * handler → native editor acquisition → `ctx.ui.custom(factory, { overlay })`.
 * The test host's `custom` mirrors Pi's InteractiveMode.showExtensionCustom
 * overlay branch (the factory's component is passed straight to
 * `tui.showOverlay` with the production overlay options; `done` hides it), on
 * the installed pi-tui's real TuiAltScreen over a virtual terminal. SGR mouse
 * packets enter through the terminal's input callback, so TuiAltScreen's own
 * parser, overlay hit testing, press capture, drag tracking, and click
 * synthesis decide what reaches the popup. Text input, Escape, and the native
 * free-text editor (the installed CustomEditor through the shared bridge) take
 * the same real path.
 *
 * Evidence boundary: this is headless. It proves the dispatch the installed
 * runtime performs for given terminal bytes; it does not prove which bytes a
 * particular physical terminal emits, and it does not exercise the
 * session-host pane forwarding or InteractiveMode itself.
 *
 * Installed-runtime discovery follows the established helpers
 * (PI_REVIEW_GATE_INSTALLED_AGENT, else ambient global installs); without a
 * resolvable install the tests skip, or fail under PI_REVIEW_GATE_REQUIRE_PI_HOST=1.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { registerUserQuestions, userQuestionsBeginSession, type UserQuestionSurface } from "../src/user-question";
import { QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import { setUserQuestionTuiHost, setUserQuestionTuiHostEntryProvider } from "../src/user-question/pi-tui-host";
import { __resetActiveNativeEditorFieldForTest, setNativeEditorHost } from "../src/native-editor-bridge";
import {
  REAL_IDENTITY_THEME,
  createRealKeybindingsManager,
  loadRealBridgeAgent,
  loadRealBridgeHost,
  skipOrFail,
} from "./bridge-fakes";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

interface MouseEventLike {
  type: string;
  button: string;
  x: number;
  y: number;
}

interface TuiScreen {
  start(): void;
  stop(): void;
  addChild(component: unknown): void;
  addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  showOverlay(component: unknown, options?: unknown): { hide(): void; isFocused(): boolean };
  hasOverlay(): boolean;
  hasActiveSelection(): boolean;
  getCopyOnSelect(): boolean;
  resetTextSelection(): void;
  copyActiveSelectionToClipboard(): Promise<boolean>;
  getScreenLines(): string[];
  renderNow(force?: boolean): void;
  requestRender(force?: boolean): void;
}

interface InstalledRuntime {
  agentDir: string;
  tui: Record<string, unknown>;
  theme: unknown;
}

const UP = "\x1b[A";
const ENTER = "\r";
const ESCAPE = "\x1b";
/** The shipped default for `app.message.copy` (Pi's explicit copy). */
const CTRL_X = "\x18";
/** The shipped default for `app.clear` in the native editor. */
const CTRL_C = "\x03";
const DOWN = "\x1b[B";
/** A valid terminal key used to prove a live copy-binding remap. */
const F6 = "\x1b[17~";

async function resolveRuntime(): Promise<InstalledRuntime | undefined> {
  for (const agentDir of findInstalledAgentDirs()) {
    try {
      const requireFromAgent = createRequire(join(agentDir, "package.json"));
      const tui = requireFromAgent("@earendil-works/pi-tui") as Record<string, unknown>;
      if (typeof tui.TuiAltScreen !== "function" || typeof tui.TuiMainScreen !== "function"
        || typeof tui.MouseRegion !== "function" || typeof tui.Text !== "function") continue;
      const agent = await loadRealBridgeAgent(agentDir);
      if (!agent || typeof agent.initTheme !== "function" || typeof agent.CustomEditor !== "function") continue;
      (agent.initTheme as (name: string, watch: boolean) => void)("dark", false);
      let theme: unknown;
      try {
        // Pi passes this live theme proxy to custom-component factories.
        theme = (requireFromAgent(join(agentDir, "dist", "modes", "interactive", "theme", "theme.js")) as { theme?: unknown }).theme;
      } catch {
        theme = undefined;
      }
      return { agentDir, tui, theme };
    } catch {
      // Unusable install: try the next candidate.
    }
  }
  return undefined;
}

const runtimePromise = resolveRuntime();
const SKIP_REASON = "installed Pi runtime with pi-tui TuiAltScreen not found (set PI_REVIEW_GATE_INSTALLED_AGENT)";

class VirtualTerminal {
  readonly writes: string[] = [];
  private inputHandler: ((data: string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;

  constructor(public columns: number, public rows: number) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }

  stop(): void {
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}

  /** Bytes arriving from the terminal, through TuiBase's real input callback. */
  input(data: string): void {
    assert.ok(this.inputHandler, "the TUI is started");
    this.inputHandler(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.resizeHandler?.();
  }
}

/** SGR 1006 packets as the terminal sends them (1-based cells). */
const sgr = {
  press: (x: number, y: number, button = 0) => `\x1b[<${button};${x + 1};${y + 1}M`,
  release: (x: number, y: number, button = 0) => `\x1b[<${button};${x + 1};${y + 1}m`,
  drag: (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`,
  move: (x: number, y: number) => `\x1b[<35;${x + 1};${y + 1}M`,
  wheelDown: (x: number, y: number) => `\x1b[<65;${x + 1};${y + 1}M`,
};

function plain(line: string): string {
  return line
    .replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

async function settle(ms = 5): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the condition");
    await settle();
  }
}

interface Harness {
  runtime: InstalledRuntime;
  terminal: VirtualTerminal;
  screen: TuiScreen;
  surface: UserQuestionSurface;
  sessionManager: object;
  sent: Array<{ message: string; options?: unknown }>;
  backgroundEvents: MouseEventLike[];
  /** Text handed to the injected native clipboard seam (never the OS clipboard). */
  copied: string[];
  /** Raw input observed by a later extension listener (the popup's Escape router position). */
  extensionListenerInput: string[];
  chatDraft: { text: string };
  /** Opens the popup; `closed` settles when the production shortcut handler returns. */
  open(): Promise<{ closed: Promise<void> }>;
  frame(): string[];
  /** Cell where `text` is drawn on screen (zero-based). */
  cell(text: string, occurrence?: number): { x: number; y: number };
  draw(): Promise<void>;
  click(cell: { x: number; y: number }): Promise<void>;
  dispose(): void;
}

interface HarnessOptions {
  /** User keybindings.json overrides applied to the live KeybindingsManager. */
  userBindings?: Record<string, string | string[]>;
  /** Replacement native clipboard seam (defaults to a recording success). */
  copySelection?: (text: string) => Promise<boolean | string>;
  /** Host copy-on-select setting; defaults to off so an explicit copy is required. */
  copyOnSelect?: boolean;
  /**
   * When false the transcript is a plain, unhandled component, so Pi's own
   * native selection anchors on the transcript's scroll view (the inherited-
   * selection regression). Defaults to true: a MouseRegion observes and claims
   * background gestures, as the other dispatch tests need.
   */
  transcriptHandlesMouse?: boolean;
}

async function createHarness(
  t: { skip(message?: string): void; after(fn: () => void): void },
  options: HarnessOptions = {},
): Promise<Harness | undefined> {
  const runtime = await runtimePromise;
  if (!runtime) {
    skipOrFail(t, SKIP_REASON);
    return undefined;
  }
  const bridge = await loadRealBridgeHost();
  if (!bridge) {
    skipOrFail(t, "installed Pi CustomEditor not resolvable for the native free-text field");
    return undefined;
  }
  const { tui } = runtime;
  setNativeEditorHost(bridge.host);
  // The production loader resolves pi-tui (and the agent's Markdown theme)
  // from the "running Pi" entry, here the installed agent's own CLI entry.
  setUserQuestionTuiHost(undefined);
  setUserQuestionTuiHostEntryProvider(() => join(runtime.agentDir, "dist", "cli.js"));
  const keybindings = createRealKeybindingsManager(tui, options.userBindings);

  // Background transcript content under the popup, with its own pointer handler.
  const backgroundEvents: MouseEventLike[] = [];
  // The public host clipboard seam: copyOnSelect stays off in this harness, so
  // only an explicit copyActiveSelectionToClipboard() (the configured copy key,
  // or a direct call) reaches it. The text the host actually resolved from its
  // own visible screen is recorded verbatim.
  const copied: string[] = [];
  const terminal = new VirtualTerminal(80, 30);
  const TuiAltScreen = tui.TuiAltScreen as new (terminal: unknown, showHardwareCursor?: boolean, logDirectory?: string, options?: unknown) => TuiScreen;
  const screen = new TuiAltScreen(terminal, false, undefined, {
    mouse: true,
    copyOnSelect: options.copyOnSelect ?? false,
    copySelection: options.copySelection ?? (async (text: string) => {
      copied.push(text);
      return true;
    }),
  });

  const Text = tui.Text as new (text: string, paddingX?: number, paddingY?: number) => unknown;
  const MouseRegion = tui.MouseRegion as new (child: unknown, onMouse: (event: MouseEventLike) => unknown) => unknown;
  const transcript = Array.from({ length: 40 }, (_, index) => `transcript line ${String(index + 1).padStart(2, "0")} ${"·".repeat(50)}`).join("\n");
  const transcriptView = new Text(transcript, 0, 0);
  screen.addChild(options.transcriptHandlesMouse === false
    ? transcriptView
    : new MouseRegion(transcriptView, (event) => {
        backgroundEvents.push({ type: event.type, button: event.button, x: event.x, y: event.y });
        return { handled: true };
      }));
  screen.start();

  const extensionListenerInput: string[] = [];
  screen.addInputListener((data) => {
    extensionListenerInput.push(data);
    return undefined;
  });

  // Host editor slot mirroring InteractiveMode.setCustomEditorComponent for
  // the shared bridge (the installed CustomEditor, constructed with this TUI).
  const chatDraft = { text: "chat draft" };
  let slotFactory: unknown;
  let editor: { getText(): string; setText(text: string): void } = {
    getText: () => chatDraft.text,
    setText: (text: string) => { chatDraft.text = text; },
  };
  const defaultEditor = editor;
  const ui: Record<string, unknown> = {
    setWidget() {},
    notify() {},
    onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => screen.addInputListener(handler),
    getEditorComponent: () => slotFactory,
    setEditorComponent(factory: unknown) {
      slotFactory = factory;
      if (typeof factory !== "function") {
        chatDraft.text = editor.getText();
        editor = defaultEditor;
        return;
      }
      const currentText = editor.getText();
      const created = (factory as (tuiArg: unknown, theme: unknown, keys: unknown) => Record<string, unknown>)(
        screen, REAL_IDENTITY_THEME, keybindings);
      created.onSubmit = () => {};
      created.onChange = () => {};
      if (!created.onEscape) created.onEscape = () => {};
      if (!created.onCtrlD) created.onCtrlD = () => {};
      (created.setText as (text: string) => void)(currentText);
      editor = created as unknown as typeof editor;
    },
    // Pi's showExtensionCustom overlay branch.
    custom(factory: (tuiArg: unknown, theme: unknown, keys: unknown, done: (result?: unknown) => void) => unknown, options?: {
      overlay?: boolean;
      overlayOptions?: unknown;
      onHandle?: (handle: unknown) => void;
    }) {
      const savedText = editor.getText();
      return new Promise((resolvePromise, reject) => {
        let handle: { hide(): void } | undefined;
        let closed = false;
        const close = (result?: unknown) => {
          if (closed) return;
          closed = true;
          if (options?.overlay) handle?.hide();
          else editor.setText(savedText);
          resolvePromise(result);
        };
        Promise.resolve(factory(screen, runtime.theme ?? REAL_IDENTITY_THEME, keybindings, close)).then((component) => {
          if (closed) return;
          assert.equal(options?.overlay, true, "the shared popup is a public custom overlay");
          const overlayOptions = typeof options?.overlayOptions === "function"
            ? (options.overlayOptions as () => unknown)()
            : options?.overlayOptions;
          handle = screen.showOverlay(component, overlayOptions);
          options?.onHandle?.(handle);
        }).catch(reject);
      });
    },
  };

  const sent: Harness["sent"] = [];
  const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
  const pi = {
    registerTool() {},
    registerShortcut(key: string, options: { handler: (ctx: unknown) => Promise<void> }) {
      shortcuts.set(key, options);
    },
    on() {
      return () => {};
    },
    notify() {},
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options });
      return Promise.resolve();
    },
  };
  const surface = registerUserQuestions(pi);
  assert.ok(surface);
  surface.setInteractiveUi(true);
  const sessionManager = { id: "mouse-host-session" };
  userQuestionsBeginSession(surface.controller, sessionManager);
  const ctx = { sessionManager, mode: "tui", isIdle: () => true, ui };

  const harness: Harness = {
    runtime,
    terminal,
    screen,
    surface,
    sessionManager,
    sent,
    backgroundEvents,
    copied,
    extensionListenerInput,
    chatDraft,
    async open() {
      const shortcut = shortcuts.get(QUESTION_LIST_SHORTCUT_KEY);
      assert.ok(shortcut, "the popup shortcut is registered");
      const closed = shortcut.handler(ctx);
      await until(() => screen.hasOverlay());
      await harness.draw();
      return { closed };
    },
    frame: () => screen.getScreenLines().map(plain),
    cell(text: string, occurrence = 0) {
      const visibleWidth = tui.visibleWidth as (text: string) => number;
      let seen = 0;
      for (const [y, row] of harness.frame().entries()) {
        const index = row.indexOf(text);
        if (index < 0 || seen++ < occurrence) continue;
        return { x: visibleWidth(row.slice(0, index)), y };
      }
      throw new Error(`"${text}" is not on screen:\n${harness.frame().join("\n")}`);
    },
    async draw() {
      await settle();
      screen.renderNow();
    },
    async click(cell) {
      terminal.input(sgr.press(cell.x, cell.y));
      await harness.draw();
      terminal.input(sgr.release(cell.x, cell.y));
      await harness.draw();
    },
    dispose() {
      try {
        screen.stop();
      } catch {
        // Already stopped.
      }
    },
  };
  t.after(() => {
    harness.dispose();
    setNativeEditorHost(undefined);
    setUserQuestionTuiHost(undefined);
    setUserQuestionTuiHostEntryProvider(undefined);
    __resetActiveNativeEditorFieldForTest();
  });
  return harness;
}

function registerQuestion(harness: Harness, question: string, choices?: string[]): string {
  const result = harness.surface.controller.register(
    { toolCallId: `t${harness.surface.controller.listPending().length + 1}`, question, choices, mode: "async" },
    harness.sessionManager,
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("registration failed");
  return result.question.id;
}

function registerNotice(harness: Harness, title: string, body: string, context?: string): string {
  const result = harness.surface.controller.registerNotice(
    { toolCallId: `n${harness.surface.controller.listPending().length + 1}`, title, body, context },
    harness.sessionManager,
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("notice registration failed");
  return result.notice.id;
}

function popupTop(harness: Harness): number {
  const frame = harness.frame();
  const header = frame.findIndex((row) => row.includes("Pending input ("));
  assert.ok(header >= 0, `the popup list is drawn:\n${frame.join("\n")}`);
  return header;
}

test("native fullscreen dispatch: press highlights, a completed click runs list, choice, and notice actions", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  const longChoice = "Use the managed Postgres cluster with read replicas in every region we deploy to across all continents";
  registerQuestion(harness, "Which database?", ["SQLite", longChoice]);
  registerQuestion(harness, "Include raw counts?", ["yes", "no"]);
  const noticeId = registerNotice(harness, "Heads up", "The nightly build moved.");
  const { closed: opened } = await harness.open();

  // Press only: the row highlights, nothing opens, and nothing else saw it.
  const q2 = harness.cell("q2: Include raw counts?");
  harness.terminal.input(sgr.press(q2.x, q2.y));
  await harness.draw();
  assert.match(harness.frame()[q2.y]!, /> q2: Include raw counts\?/, "the press highlights the pressed row");
  assert.ok(harness.frame().some((row) => row.includes("Pending input (3)")), "a press alone opens nothing");
  harness.terminal.input(sgr.release(q2.x, q2.y));
  await harness.draw();
  assert.ok(harness.frame().some((row) => /^\s*q2:\s*$/.test(row)),
    `the completed click opened q2's answer view:\n${harness.frame().join("\n")}`);
  assert.ok(harness.frame().some((row) => row.includes("1. yes")));

  // Keyboard still works alongside the pointer: Escape back, Up, Enter opens q1.
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(UP);
  harness.terminal.input(ENTER);
  await harness.draw();
  assert.ok(harness.frame().some((row) => row.includes("1. SQLite")), `keyboard opened q1:\n${harness.frame().join("\n")}`);

  // Clicking the last visual line of the wrapped choice submits its raw label.
  const start = harness.cell("2. Use the managed");
  const frame = harness.frame();
  let lastLine = start.y;
  const isContinuation = (row: string | undefined): boolean =>
    row !== undefined && /^\s+\S/.test(row) && !/^\s+(?:> )?(?:\d+\. |Type something|Decline)/.test(row);
  while (isContinuation(frame[lastLine + 1])) lastLine += 1;
  assert.ok(lastLine > start.y, `the long choice wraps on screen:\n${frame.join("\n")}`);
  const continuationX = frame[lastLine]!.search(/\S/);
  await harness.click({ x: continuationX, y: lastLine });
  await settle();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]!.message, `Answer to pending question "Which database?": ${longChoice}`);
  assert.equal(harness.surface.controller.listPending().length, 2, "only q1 resolved");

  // Notice row → notice view → More details closes the popup and delivers it.
  await harness.click(harness.cell(`${noticeId}: Heads up`));
  assert.ok(harness.frame().some((row) => row.includes("The nightly build moved.")), "the notice view opened");
  await harness.click(harness.cell("More details"));
  await opened;
  await until(() => harness.sent.length === 2);
  assert.match(harness.sent[1]!.message, /Heads up/);
  assert.equal(harness.surface.controller.getPending(noticeId), undefined);

  assert.deepEqual(harness.backgroundEvents, [], "no popup pointer event reached the background transcript");
  assert.equal(harness.screen.hasActiveSelection(), false, "no transcript text selection started under the popup");
  assert.equal(harness.extensionListenerInput.filter((data) => data.startsWith("\x1b[<")).length, 0,
    "pointer packets are consumed before the popup's Escape router and any extension listener");
});

test("native fullscreen dispatch: drag-off, a shifted centered origin, resize, and wheel never activate", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  registerQuestion(harness, "First question?", ["a"]);
  registerQuestion(harness, "Second question?", ["b"]);
  await harness.open();
  const listOpen = () => harness.frame().some((row) => row.includes("Pending input ("));

  // Drag-off: press, move away with the button held, release elsewhere.
  const q1 = harness.cell("q1: First question?");
  harness.terminal.input(sgr.press(q1.x, q1.y));
  await harness.draw();
  harness.terminal.input(sgr.drag(q1.x, q1.y + 1));
  harness.terminal.input(sgr.release(q1.x, q1.y + 1));
  await harness.draw();
  assert.ok(listOpen(), "a drag-off never activates");

  // A press on the popup's blank rule cells is not a menu item, so the popup
  // leaves the whole gesture to the host: Pi's native selection anchors on the
  // visible popup, and an in-popup drag extends it (issue #436). No item is
  // claimed, highlighted, or activated, and nothing reaches the transcript.
  const rule = popupTop(harness) - 2;
  assert.match(harness.frame()[rule]!, /^─+$/, `the popup top rule is drawn above the padding:\n${harness.frame().join("\n")}`);
  assert.match(harness.frame()[0]!, /^transcript line/, "row 0 is transcript outside the popup");
  harness.terminal.input(sgr.press(70, rule));
  harness.terminal.input(sgr.drag(30, rule + 4));
  await harness.draw();
  harness.terminal.input(sgr.release(30, rule + 4));
  await harness.draw();
  assert.equal(harness.screen.hasActiveSelection(), true,
    "a non-item press starts Pi's native selection over the visible popup");
  assert.equal(harness.backgroundEvents.length, 0, "an in-popup selection gesture never leaked to the transcript");
  assert.ok(listOpen(), "and activates no popup item");
  assert.equal(harness.sent.length, 0);

  // A re-render between press and release moves the centered popup: the
  // release lands on the same screen cell but over different popup content.
  const topBefore = popupTop(harness);
  const q2 = harness.cell("q2: Second question?");
  harness.terminal.input(sgr.press(q2.x, q2.y));
  await harness.draw();
  registerQuestion(harness, "Third question?", ["c"]);
  registerQuestion(harness, "Fourth question?", ["d"]);
  await harness.draw();
  assert.notEqual(popupTop(harness), topBefore, "the centered origin moved between press and release");
  harness.terminal.input(sgr.release(q2.x, q2.y));
  await harness.draw();
  assert.ok(listOpen(), `the shifted gesture did not activate:\n${harness.frame().join("\n")}`);

  // A resize between press and release.
  const q3 = harness.cell("q3: Third question?");
  harness.terminal.input(sgr.press(q3.x, q3.y));
  await harness.draw();
  harness.terminal.resize(72, 30);
  await harness.draw();
  harness.terminal.input(sgr.release(q3.x, q3.y));
  await harness.draw();
  assert.ok(listOpen(), "a resized gesture did not activate");

  // Wheel over the popup is not a click: no item activates (wheel policy is #413's).
  const q4 = harness.cell("q4: Fourth question?");
  harness.terminal.input(sgr.wheelDown(q4.x, q4.y));
  await harness.draw();
  assert.ok(listOpen(), "wheel never activates a popup item");

  // Hover motion with no button is inert as well.
  harness.terminal.input(sgr.move(q4.x, q4.y));
  await harness.draw();
  assert.ok(listOpen());
  assert.equal(harness.surface.controller.listPending().length, 4);
  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.backgroundEvents.filter((event) => event.type !== "wheel"), [],
    "no press, drag, release, or click reached the background");

  // Ordinary routing is restored when the popup closes, and reopening owns input again.
  harness.terminal.input(ESCAPE);
  await harness.draw();
  assert.equal(harness.screen.hasOverlay(), false);
  const background = { x: q4.x, y: q4.y };
  await harness.click(background);
  assert.deepEqual(harness.backgroundEvents.map((event) => event.type), ["press", "release", "click"],
    "after close the same cell routes to the background normally");
  harness.backgroundEvents.length = 0;
  await harness.open();
  await harness.click(harness.cell("q1: First question?"));
  assert.ok(harness.frame().some((row) => row.includes("1. a")), "the reopened popup handles clicks again");
  assert.deepEqual(harness.backgroundEvents, []);
});

test("native fullscreen dispatch: the native editor box is inert; a clicked menu row leaves editing and runs its action", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  registerQuestion(harness, "Which database?", ["SQLite", "Postgres"]);
  registerQuestion(harness, "Another?", ["x"]);
  const { closed: opened } = await harness.open();
  await harness.click(harness.cell("q1: Which database?"));
  await harness.click(harness.cell("Type something…"));
  for (const char of "my draft") harness.terminal.input(char);
  await harness.draw();
  const draftCell = harness.cell("my draft");
  assert.ok(!harness.frame().some((row) => row.includes("Type something…")), "the native editor box replaced the type row");

  // Pointer input inside the editor box never submits the draft.
  await harness.click({ x: draftCell.x + 1, y: draftCell.y });
  harness.terminal.input(sgr.press(draftCell.x + 3, draftCell.y));
  harness.terminal.input(sgr.drag(draftCell.x + 5, draftCell.y));
  harness.terminal.input(sgr.release(draftCell.x + 5, draftCell.y));
  await harness.draw();
  assert.equal(harness.sent.length, 0, "no draft was submitted by pointer input");
  assert.ok(harness.frame().some((row) => row.includes("my draft")), "the draft is unchanged and still editing");

  // A press on a visible choice highlights it while the editor stays in place.
  const postgres = harness.cell("2. Postgres");
  harness.terminal.input(sgr.press(postgres.x, postgres.y));
  await harness.draw();
  assert.match(harness.frame()[postgres.y]!, /> 2\. Postgres/);
  assert.ok(harness.frame().some((row) => row.includes("my draft")));
  // Drag-off clears it; typing still goes to the native editor.
  harness.terminal.input(sgr.drag(postgres.x, postgres.y - 1));
  harness.terminal.input(sgr.release(postgres.x, postgres.y - 1));
  harness.terminal.input("!");
  await harness.draw();
  assert.doesNotMatch(harness.frame()[postgres.y]!, /> 2\. Postgres/);
  assert.ok(harness.frame().some((row) => row.includes("my draft!")), "native keyboard editing is unchanged");
  assert.equal(harness.sent.length, 0);

  // The completed click leaves editing and submits the choice, never the draft.
  await harness.click(harness.cell("2. Postgres"));
  await settle();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]!.message, `Answer to pending question "Which database?": Postgres`);
  assert.equal(harness.surface.controller.listPending().length, 1);
  assert.ok(harness.frame().some((row) => row.includes("Pending input (1)")), "the list returns with the other question");

  harness.terminal.input(ESCAPE);
  await opened;
  assert.equal(harness.chatDraft.text, "chat draft", "the displaced chat draft is restored after close");
  assert.deepEqual(harness.backgroundEvents, []);
});

test("native fullscreen dispatch: a rebound session closes the popup on pointer input without answering", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  registerQuestion(harness, "Old session question?", ["keep"]);
  const { closed: opened } = await harness.open();
  await harness.click(harness.cell("q1: Old session question?"));
  const choice = harness.cell("1. keep");
  harness.terminal.input(sgr.press(choice.x, choice.y));
  await harness.draw();
  // Session replacement while the pointer is down: same per-session IDs reappear.
  const replacement = { id: "replacement-session" };
  harness.surface.noteContext({ sessionManager: replacement });
  userQuestionsBeginSession(harness.surface.controller, replacement);
  const fresh = harness.surface.controller.register(
    { toolCallId: "fresh", question: "Replacement question?", choices: ["keep"], mode: "async" }, replacement);
  assert.ok(fresh.ok && fresh.question.id === "q1", "the replacement reuses the per-session ID");
  harness.terminal.input(sgr.release(choice.x, choice.y));
  await opened;
  await settle();
  assert.equal(harness.sent.length, 0, "nothing was answered into either session");
  assert.equal(harness.surface.controller.listPending().length, 1, "the replacement question stays pending");
  await harness.draw();
  assert.equal(harness.screen.hasOverlay(), false);
});

test("regular mode stays terminal-owned: no mouse tracking and no mouse parser; fullscreen enables both", async (t) => {
  const runtime = await runtimePromise;
  if (!runtime) return skipOrFail(t, SKIP_REASON);
  const TuiMainScreen = runtime.tui.TuiMainScreen as new (terminal: unknown) => TuiScreen;
  const TuiAltScreen = runtime.tui.TuiAltScreen as new (terminal: unknown, showHardwareCursor?: boolean, logDirectory?: string, options?: unknown) => TuiScreen;
  assert.equal(typeof (TuiMainScreen.prototype as { handleMouseEvent?: unknown }).handleMouseEvent, "undefined");
  assert.equal(typeof (TuiAltScreen.prototype as { handleMouseEvent?: unknown }).handleMouseEvent, "function");
  const tracking = /\x1b\[\?100[0236]h/;
  const regularTerminal = new VirtualTerminal(80, 24);
  const regular = new TuiMainScreen(regularTerminal);
  regular.start();
  regular.renderNow();
  regular.stop();
  assert.equal(regularTerminal.writes.some((data) => tracking.test(data)), false, "regular mode never enables mouse reporting");
  const fullscreenTerminal = new VirtualTerminal(80, 24);
  const fullscreen = new TuiAltScreen(fullscreenTerminal, false, undefined, { mouse: true });
  fullscreen.start();
  fullscreen.stop();
  assert.equal(fullscreenTerminal.writes.some((data) => tracking.test(data)), true, "fullscreen enables mouse reporting");
});

test("native fullscreen dispatch: a resize released before any redraw never activates; a fresh click afterwards does", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  registerQuestion(harness, "First question?", ["a"]);
  registerQuestion(harness, "Second question?", ["b"]);
  const { closed } = await harness.open();
  await harness.click(harness.cell("q1: First question?"));
  const listOrAnswer = () => harness.frame().some((row) => row.includes("1. a"));
  assert.ok(listOrAnswer(), "q1's answer view is open");

  for (const [name, columns, rows] of [["width-only", 72, 30], ["height-only", 72, 26]] as const) {
    const choice = harness.cell("1. a");
    harness.terminal.input(sgr.press(choice.x, choice.y));
    // Pi's resize callback only schedules a render: the release (and the
    // click TuiAltScreen synthesizes from it) is delivered synchronously,
    // before any redraw, with the press-time bounds.
    harness.terminal.resize(columns, rows);
    harness.terminal.input(sgr.release(choice.x, choice.y));
    await settle();
    assert.equal(harness.sent.length, 0, `${name}: no answer was submitted from the pre-resize geometry`);
    assert.equal(harness.surface.controller.listPending().length, 2, `${name}: both questions stay pending`);
    await harness.draw();
    assert.ok(listOrAnswer(), `${name}: the answer view remains after the redraw`);
  }

  // After the redraw, a fresh click on the newly drawn choice acts.
  await harness.click(harness.cell("1. a"));
  await settle();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]!.message, `Answer to pending question "First question?": a`);
  assert.equal(harness.backgroundEvents.length, 0, "no resize-race gesture leaked to the background");
  harness.terminal.input(ESCAPE);
  await closed;
});

// ---------------------------------------------------------------------------
// Scrolled content: the popup's existing manual keyboard scrolling
// (Shift+Alt+Up/Down; plain PageUp/PageDown belong to the fullscreen
// transcript), then real SGR press/release through TuiAltScreen. Every cell is
// derived from the frame actually drawn after the scroll; no layout constant
// is assumed. Wheel input is deliberately not used here (#413 owns that policy).
// ---------------------------------------------------------------------------

const SHIFT_ALT_UP = "\x1b[1;4A";
const SHIFT_ALT_DOWN = "\x1b[1;4B";

function onScreen(harness: Harness, text: string): boolean {
  return harness.frame().some((row) => row.includes(text));
}

/** Popup top/bottom rule rows of the drawn frame (full-width rules only). */
function popupRules(harness: Harness): { top: number; bottom: number } {
  const frame = harness.frame();
  const rules = frame.flatMap((row, index) => (/^─+$/.test(row) ? [index] : []));
  assert.equal(rules.length, 2, `exactly the popup's two rules are drawn:\n${frame.join("\n")}`);
  return { top: rules[0]!, bottom: rules[1]! };
}

/** Bounded keyboard page scrolling until `done`; returns the steps taken. */
async function scrollPopupUntil(harness: Harness, key: string, done: () => boolean, limit = 80): Promise<number> {
  for (let steps = 0; steps <= limit; steps += 1) {
    if (done()) return steps;
    harness.terminal.input(key);
    await harness.draw();
  }
  throw new Error(`the scroll target was not reached in ${limit} steps:\n${harness.frame().join("\n")}`);
}

/** Every pending record by ID, as the identical controller objects. */
function pendingSnapshot(harness: Harness): Map<string, unknown> {
  return new Map(harness.surface.controller.listPending().map((record) => [record.id, record]));
}

/** The remaining records are exactly the earlier objects minus `removed`. */
function assertOthersUntouched(harness: Harness, before: Map<string, unknown>, removed: string[], label: string): void {
  const now = pendingSnapshot(harness);
  assert.deepEqual([...now.keys()], [...before.keys()].filter((id) => !removed.includes(id)), `${label}: only ${removed.join(", ") || "nothing"} left the pending list`);
  for (const [id, record] of now) assert.equal(record, before.get(id), `${label}: ${id} is the same untouched record`);
}

/** Consumed blank cells: nothing highlights, scrolls, or acts. */
async function assertInertClicks(harness: Harness, cells: Array<[string, { x: number; y: number }]>): Promise<void> {
  for (const [name, cell] of cells) {
    const before = harness.frame();
    await harness.click(cell);
    await settle();
    assert.deepEqual(harness.frame(), before, `${name}: a click there changes nothing on screen`);
  }
}

test("native fullscreen dispatch: after keyboard page scrolling, clicks hit the visible list row and the visible choice", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  harness.terminal.resize(80, 14);
  const questions = Array.from({ length: 8 }, (_, index) => `Question ${String(index + 1).padStart(2, "0")}?`);
  const choicesFor = (question: number) => Array.from({ length: 6 }, (_, index) => `answer-${question}-${index + 1}`);
  questions.forEach((question, index) => registerQuestion(harness, question, choicesFor(index + 1)));
  const noticeId = registerNotice(harness, "Short notice", "Nothing long.");
  const before = pendingSnapshot(harness);
  const { closed } = await harness.open();
  const transcriptRows = () => {
    const { top, bottom } = popupRules(harness);
    return harness.frame().filter((_, index) => index < top || index > bottom);
  };
  const transcriptBefore = transcriptRows();
  assert.ok(transcriptBefore.length > 0 && transcriptBefore.every((row) => row.startsWith("transcript line")),
    `the transcript is visible around the overflowing popup:\n${harness.frame().join("\n")}`);
  assert.ok(onScreen(harness, "q1: Question 01?") && !onScreen(harness, `${noticeId}: Short notice`),
    `the list overflows its viewport:\n${harness.frame().join("\n")}`);
  const oldQ1 = harness.cell("q1: Question 01?");

  // The existing popup page shortcut scrolls the list until q1 is offscreen.
  const steps = await scrollPopupUntil(harness, SHIFT_ALT_DOWN,
    () => !onScreen(harness, "q1: Question 01?") && onScreen(harness, `${noticeId}: Short notice`));
  assert.ok(steps > 0);
  assert.deepEqual(transcriptRows(), transcriptBefore, "popup page keys never scrolled the transcript");

  // Blank and non-item cells of the scrolled frame are inert.
  const { top, bottom } = popupRules(harness);
  const noticeRow = harness.cell(`${noticeId}: Short notice`);
  const noticeEnd = noticeRow.x + (harness.runtime.tui.visibleWidth as (text: string) => number)(`${noticeId}: Short notice [notice]`);
  const blankRows = harness.frame().flatMap((row, index) => (index > top && index < bottom && row.trim() === "" ? [index] : []));
  assert.ok(blankRows.length > 0, "the scrolled frame has blank padding/separator rows");
  await assertInertClicks(harness, [
    ...blankRows.map((y) => [`blank row ${y}`, { x: noticeRow.x, y }] as [string, { x: number; y: number }]),
    ["top rule", { x: noticeRow.x, y: top }],
    ["trailing blank after the notice row", { x: noticeEnd + 1, y: noticeRow.y }],
  ]);

  // q1's old cell now draws a different row: the press highlights that row
  // without moving the viewport, and the click opens it (never offscreen q1).
  const shown = /^\s*(?:> )?(q\d+): (Question \d+\?)/.exec(harness.frame()[oldQ1.y]!);
  assert.ok(shown && shown[1] !== "q1", `q1's old cell shows another question now:\n${harness.frame().join("\n")}`);
  const [, shownId, shownQuestion] = shown;
  harness.terminal.input(sgr.press(oldQ1.x, oldQ1.y));
  await harness.draw();
  assert.match(harness.frame()[oldQ1.y]!, new RegExp(`> ${shownId}: `), "the press highlights the row drawn under the pointer");
  assert.ok(!onScreen(harness, "q1: Question 01?"), "the press never scrolled back to the keyboard selection");
  harness.terminal.input(sgr.release(oldQ1.x, oldQ1.y));
  await harness.draw();
  assert.ok(harness.frame().some((row) => row.trim() === `${shownId}:`) && onScreen(harness, shownQuestion!),
    `the click opened ${shownId}, the visible row:\n${harness.frame().join("\n")}`);
  const shownNumber = Number(shownId!.slice(1));
  assert.ok(onScreen(harness, `1. answer-${shownNumber}-1`), "its answer view starts at its first choice");
  assertOthersUntouched(harness, before, [], "opening");

  // Scroll its answer view until the first choice is offscreen; the old cell
  // now draws a later choice, and clicking it submits exactly that label.
  const oldFirst = harness.cell(`1. answer-${shownNumber}-1`);
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => !onScreen(harness, `1. answer-${shownNumber}-1`)
    && /\d+\. answer-/.test(harness.frame()[oldFirst.y]!));
  const drawn = /(\d+)\. (answer-\d+-\d+)/.exec(harness.frame()[oldFirst.y]!);
  assert.ok(drawn && drawn[1] !== "1", `a later choice is drawn at the first choice's old cell:\n${harness.frame().join("\n")}`);
  assert.deepEqual(transcriptRows(), transcriptBefore);
  // The row just past the drawn label is blank: inert.
  const choiceCell = harness.cell(`${drawn[1]}. ${drawn[2]}`);
  await assertInertClicks(harness, [["trailing blank after the choice", { x: choiceCell.x + `${drawn[1]}. ${drawn[2]}`.length + 1, y: choiceCell.y }]]);
  await harness.click(oldFirst);
  await settle();
  assert.deepEqual(harness.sent.map((entry) => entry.message), [`Answer to pending question "${shownQuestion}": ${drawn[2]}`],
    "the visible choice under the pointer answered its own question");
  assertOthersUntouched(harness, before, [shownId!], "answering");
  assert.ok(onScreen(harness, "Pending input (8)"), "the list returns with every other record");

  // Keyboard is unchanged after pointer use: scroll up/down still works.
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, `${noticeId}: Short notice`));
  await scrollPopupUntil(harness, SHIFT_ALT_UP, () => onScreen(harness, "Pending input (8)"));
  harness.terminal.input(ESCAPE);
  await closed;
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.backgroundEvents, [], "no popup pointer event reached the background transcript");
  assert.equal(harness.screen.hasActiveSelection(), false);
  assert.equal(harness.extensionListenerInput.filter((data) => data.startsWith("\x1b[<")).length, 0);
});

test("native fullscreen dispatch: scrolled long notices run Close and More details, also after a narrowing resize", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  harness.terminal.resize(80, 16);
  const longBody = (tag: string) => Array.from({ length: 24 }, (_, index) => `${tag} body line ${String(index + 1).padStart(2, "0")}.`).join("\n\n");
  const keepId = registerQuestion(harness, "Keep me pending?", ["keep"]);
  const firstBody = longBody("Alpha");
  const secondBody = longBody("Beta");
  const firstId = registerNotice(harness, "Alpha notice", firstBody);
  const secondId = registerNotice(harness, "Beta notice", secondBody);
  const before = pendingSnapshot(harness);
  const { closed } = await harness.open();

  // Open the first notice: its actions start far below the viewport.
  await harness.click(harness.cell(`${firstId}: Alpha notice`));
  assert.ok(onScreen(harness, "Alpha body line 01."), `the notice view opened:\n${harness.frame().join("\n")}`);
  assert.ok(!onScreen(harness, "More details") && !onScreen(harness, "Close"), "the actions are offscreen before scrolling");
  const oldBodyCell = harness.cell("Alpha body line 01.");
  await assertInertClicks(harness, [["unscrolled body text", oldBodyCell]]);

  // Keyboard-scroll until both actions are drawn, then probe the frame.
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "More details") && onScreen(harness, "Close"));
  assert.ok(!onScreen(harness, "Alpha body line 01."), "the scrolled body moved its first line offscreen");
  const moreDetails = harness.cell("More details");
  const closeCell = harness.cell("Close");
  const frame = harness.frame();
  const { top, bottom } = popupRules(harness);
  const blankRows = frame.flatMap((row, index) => (index > top && index < bottom && row.trim() === "" ? [index] : []));
  assert.ok(blankRows.includes(moreDetails.y - 1), `a blank separator row precedes the actions:\n${frame.join("\n")}`);
  const bodyRow = frame.findIndex((row) => /Alpha body line \d+\./.test(row));
  assert.ok(bodyRow > top, "scrolled body text is still drawn above the actions");
  await assertInertClicks(harness, [
    ...blankRows.map((y) => [`blank row ${y}`, { x: closeCell.x, y }] as [string, { x: number; y: number }]),
    ["scrolled body text", { x: frame[bodyRow]!.search(/\S/), y: bodyRow }],
    ["the old first-body-line cell", oldBodyCell],
    ["trailing blank after Close", { x: closeCell.x + "Close".length + 1, y: closeCell.y }],
  ]);
  assertOthersUntouched(harness, before, [], "inert notice clicks");

  // Close: dismisses exactly this notice, sends nothing, returns to the list.
  await harness.click(closeCell);
  await settle();
  assert.equal(harness.sent.length, 0, "Close never delivers");
  assertOthersUntouched(harness, before, [firstId], "Close");
  assert.ok(onScreen(harness, "Pending input (2)"), `the list returned:\n${harness.frame().join("\n")}`);

  // Narrow and shorten the terminal. The list keeps its (clamped) offset and
  // reveals its selection, q1, so the second notice row starts below the
  // shortened body: scroll the list by keyboard, then click that row.
  harness.terminal.resize(48, 12);
  await harness.draw();
  assert.ok(onScreen(harness, "> q1: Keep me pending?") && !onScreen(harness, `${secondId}: Beta notice`),
    `the shortened list body shows only its selection:\n${harness.frame().join("\n")}`);
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, `${secondId}: Beta notice`));
  assert.ok(onScreen(harness, "Shift+Alt+Up/Down"), "the fixed hint stays drawn below the scrolled list");
  await harness.click(harness.cell(`${secondId}: Beta notice`));
  // The shortened notice opens at its beginning: the title row, with its body
  // and actions below the two-row body area above the fixed hint.
  assert.ok(onScreen(harness, `${secondId}: Beta notice`) && !onScreen(harness, "More details"),
    `the second notice opened at its beginning after the resize:\n${harness.frame().join("\n")}`);
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "Beta body line 01."));
  assert.ok(!onScreen(harness, `${secondId}: Beta notice`), "keyboard scrolling moved the title offscreen");
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "More details"));
  const narrowRules = popupRules(harness);
  assert.ok(harness.frame().every((row) => row.length <= 48), "the frame fits the narrowed terminal");
  const narrowMore = harness.cell("More details");
  assert.ok(narrowMore.y > narrowRules.top && narrowMore.y < narrowRules.bottom);
  const narrowBlank = harness.frame().findIndex((row, index) => index > narrowRules.top && index < narrowRules.bottom && row.trim() === "");
  assert.ok(narrowBlank > 0, "the narrowed frame keeps a blank row");
  await assertInertClicks(harness, [
    ["narrowed blank row", { x: narrowMore.x, y: narrowBlank }],
    ["trailing blank after More details", { x: narrowMore.x + "More details".length + 1, y: narrowMore.y }],
  ]);
  assertOthersUntouched(harness, before, [firstId], "narrowed inert clicks");

  // More details closes the popup and delivers exactly this notice's snapshot.
  await harness.click(narrowMore);
  await closed;
  await until(() => harness.sent.length === 1);
  assert.equal(harness.sent[0]!.message,
    `More details requested for "Beta notice":\n\n${secondBody}\n\nPlease elaborate on these details in your normal conversation reply.`);
  assertOthersUntouched(harness, before, [firstId, secondId], "More details");
  assert.ok(harness.surface.controller.getPending(keepId), "the unrelated question stays pending");
  assert.equal(harness.screen.hasOverlay(), false);
  assert.deepEqual(harness.backgroundEvents, [], "no popup pointer event reached the background transcript");
  assert.equal(harness.screen.hasActiveSelection(), false);
  assert.equal(harness.extensionListenerInput.filter((data) => data.startsWith("\x1b[<")).length, 0);
});

test("native fullscreen dispatch: after a resize and re-scroll, the visible type row edits, a visible choice answers, and Decline declines", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  harness.terminal.resize(80, 14);
  const choices = Array.from({ length: 8 }, (_, index) => `option-${index + 1}`);
  const targetId = registerQuestion(harness, "Which option?", choices);
  const declineId = registerQuestion(harness, "Decline this one?", choices);
  const noticeId = registerNotice(harness, "Unrelated notice", "Stay pending.");
  const before = pendingSnapshot(harness);
  const { closed } = await harness.open();
  await harness.click(harness.cell(`${targetId}: Which option?`));
  assert.ok(onScreen(harness, "1. option-1") && !onScreen(harness, "Decline"), `the answer view overflows:\n${harness.frame().join("\n")}`);
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "Decline"));
  const preResizeDecline = harness.cell("Decline");
  const firstChoiceRow = (): string | undefined => /\d+\. option-\d+/.exec(harness.frame().find((row) => /\d+\. option-\d+/.test(row)) ?? "")?.[0];
  const firstBeforeResize = firstChoiceRow();
  assert.ok(firstBeforeResize && firstBeforeResize !== "1. option-1", "the scrolled body starts at a later choice");

  // Narrow/shorten: the viewport keeps its scroll position (#413 clamps it to
  // the new bounds and does not re-reveal the non-editing answer selection),
  // so the shorter body ends above Decline and the old Decline cell no longer
  // draws Decline; a gesture there never declines.
  harness.terminal.resize(56, 12);
  await harness.draw();
  assert.ok(!onScreen(harness, "Decline") && !onScreen(harness, "1. option-1"),
    `the resized viewport kept its offset instead of revealing the selection:\n${harness.frame().join("\n")}`);
  assert.equal(firstChoiceRow(), firstBeforeResize, "the first visible body row is unchanged by the resize");
  const resizedRules = popupRules(harness);
  assert.ok(preResizeDecline.y >= resizedRules.top && preResizeDecline.y <= resizedRules.bottom,
    "the old Decline cell is still inside the resized popup");
  assert.doesNotMatch(harness.frame()[preResizeDecline.y]!, /Decline|\d+\. option-|Type something/,
    `the old Decline cell draws no item now:\n${harness.frame().join("\n")}`);
  await assertInertClicks(harness, [["the pre-resize Decline cell", preResizeDecline]]);
  assert.equal(harness.sent.length, 0);
  assertOthersUntouched(harness, before, [], "pre-resize cell");

  // Re-scroll by keyboard; the type row is visible again and begins editing.
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "Decline") && onScreen(harness, "Type something…"));
  assert.ok(!onScreen(harness, "1. option-1"), "the first choice is scrolled offscreen");
  await harness.click(harness.cell("Type something…"));
  for (const char of "scrolled draft") harness.terminal.input(char);
  await harness.draw();
  const draft = harness.cell("scrolled draft");
  assert.ok(!onScreen(harness, "Type something…"), `the native editor box replaced the type row:\n${harness.frame().join("\n")}`);

  // The editor box stays inert; the draft is never submitted by pointer input.
  await harness.click({ x: draft.x + 2, y: draft.y });
  await settle();
  assert.equal(harness.sent.length, 0);
  assertOthersUntouched(harness, before, [], "editor box click");
  assert.ok(onScreen(harness, "scrolled draft"), "still editing with the draft intact");

  // A choice still visible above the editor answers with its own label, never the draft.
  const visibleChoice = /(\d+)\. (option-\d+)/.exec(harness.frame().find((row) => /\d+\. option-\d+/.test(row)) ?? "");
  assert.ok(visibleChoice && visibleChoice[1] !== "1", `a later choice is visible while editing:\n${harness.frame().join("\n")}`);
  await harness.click(harness.cell(`${visibleChoice[1]}. ${visibleChoice[2]}`));
  await settle();
  assert.deepEqual(harness.sent.map((entry) => entry.message), [`Answer to pending question "Which option?": ${visibleChoice[2]}`]);
  assertOthersUntouched(harness, before, [targetId], "choice while editing");
  // The shortened list reveals its selection, the next question, below the
  // offscreen header.
  assert.ok(onScreen(harness, `> ${declineId}: Decline this one?`) && !onScreen(harness, "Which option?"),
    `the list returned:\n${harness.frame().join("\n")}`);

  // The second question in the resized viewport: scrolled Decline declines it alone.
  await harness.click(harness.cell(`${declineId}: Decline this one?`));
  assert.ok(!onScreen(harness, "Decline (no answer"), "Decline starts below the resized viewport");
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "Decline (no answer"));
  const decline = harness.cell("Decline (no answer");
  await assertInertClicks(harness, [["trailing blank after Decline",
    { x: decline.x + "Decline (no answer will be sent)".length + 1, y: decline.y }]]);
  await harness.click(decline);
  await settle();
  assert.equal(harness.sent.length, 1, "Decline sends nothing");
  assertOthersUntouched(harness, before, [targetId, declineId], "Decline");
  assert.ok(harness.surface.controller.getPending(noticeId));
  harness.terminal.input(ESCAPE);
  await closed;
  assert.equal(harness.chatDraft.text, "chat draft", "the displaced chat draft is restored after close");
  assert.deepEqual(harness.backgroundEvents, [], "no popup pointer event reached the background transcript");
  assert.equal(harness.screen.hasActiveSelection(), false);
  assert.equal(harness.extensionListenerInput.filter((data) => data.startsWith("\x1b[<")).length, 0);
});

test("native fullscreen dispatch: fixed hint rows stay inert, and tiny unpadded or unruled budgets click their body row", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  harness.terminal.resize(80, 16);
  const firstId = registerQuestion(harness, "Hint question?", ["alpha", "beta"]);
  const secondId = registerQuestion(harness, "Tiny question?", ["gamma", "delta"]);
  const thirdId = registerQuestion(harness, "Tinier question?", ["epsilon", "zeta"]);
  const before = pendingSnapshot(harness);
  const { closed } = await harness.open();
  await harness.click(harness.cell(`${firstId}: Hint question?`));
  assert.ok(onScreen(harness, "1. alpha"), `the answer view opened:\n${harness.frame().join("\n")}`);

  // Every row of the fixed keyboard hint area below the body is inert.
  const { top, bottom } = popupRules(harness);
  const hintStart = harness.cell("arrows select").y;
  const hintRows = harness.frame().flatMap((row, index) => (index >= hintStart - 1 && index < bottom ? [index] : []));
  assert.ok(hintRows.length >= 2 && hintStart > top, `the fixed hint is drawn below the body:\n${harness.frame().join("\n")}`);
  await assertInertClicks(harness, hintRows.map((y) => [`hint-area row ${y}`, { x: 4, y }] as [string, { x: number; y: number }]));
  assertOthersUntouched(harness, before, [], "hint clicks");

  // A 5-row terminal leaves a 3-row budget: rule, one body row, rule.
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.resize(80, 5);
  await harness.draw();
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, `${secondId}: Tiny question?`));
  await harness.click(harness.cell(`${secondId}: Tiny question?`));
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "2. delta"));
  const ruled = popupRules(harness);
  assert.equal(ruled.bottom - ruled.top, 2, `one body row between the rules:\n${harness.frame().join("\n")}`);
  await assertInertClicks(harness, [["top rule", { x: 4, y: ruled.top }], ["bottom rule", { x: 4, y: ruled.bottom }]]);
  await harness.click(harness.cell("2. delta"));
  await settle();
  assert.deepEqual(harness.sent.map((entry) => entry.message), [`Answer to pending question "Tiny question?": delta`]);
  assertOthersUntouched(harness, before, [secondId], "3-row budget");

  // A 4-row terminal leaves a 2-row budget: the rules give way; one body row
  // above the one-row compact hint.
  harness.terminal.resize(80, 4);
  await harness.draw();
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, `${thirdId}: Tinier question?`));
  await harness.click(harness.cell(`${thirdId}: Tinier question?`));
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => onScreen(harness, "2. zeta"));
  assert.ok(!harness.frame().some((row) => /^─+$/.test(row)), `no rules remain:\n${harness.frame().join("\n")}`);
  const zeta = harness.cell("2. zeta");
  const compactHint = harness.cell("Shift+Alt+Up/Down");
  assert.equal(compactHint.y, zeta.y + 1, "the compact hint is fixed directly below the body row");
  await assertInertClicks(harness, [["compact hint", compactHint]]);
  await harness.click(zeta);
  await settle();
  assert.equal(harness.sent.at(-1)?.message, `Answer to pending question "Tinier question?": zeta`);
  assertOthersUntouched(harness, before, [secondId, thirdId], "2-row budget");

  harness.terminal.input(ESCAPE);
  await closed;
  assert.deepEqual(harness.backgroundEvents, [], "no popup pointer event reached the background transcript");
  assert.equal(harness.screen.hasActiveSelection(), false);
  assert.equal(harness.extensionListenerInput.filter((data) => data.startsWith("\x1b[<")).length, 0);
});

// ---------------------------------------------------------------------------
// Issue #436: a non-item press inside the popup belongs to Pi's native text
// selection over the visible popup rows. The popup claims only a live drawn
// menu item, so the host's own selection and clipboard paths (never a private
// selection state) copy exactly what is visible. A gesture that starts on
// non-item content cannot gain an action by crossing or releasing over one,
// and a gesture that leaves the overlay falls back to the host's normal
// routing: session-host's own coverage (tests/session-host-main.test.ts)
// already proves that an initial left press above a pane is required, so
// stray drag/release callbacks cannot activate a different session or review.
// ---------------------------------------------------------------------------

test("native fullscreen dispatch: a non-item press selects and copies the visible popup natively, never an action", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  harness.terminal.resize(80, 26);

  const question = "Keep this pending?";
  const questionId = registerQuestion(harness, question, ["keep"]);
  // A distinct wrapped body, an explicit context, and a distinct transcript
  // underneath: the copy must read the visible popup, never the background.
  const body = "noticebody alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
    + "mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
  const context = "noticecontext mike november oscar papa quebec romeo";
  const shortId = registerNotice(harness, "Selection notice", body, context);
  const longId = registerNotice(harness, "Long selection notice",
    Array.from({ length: 40 }, (_, index) => `longbody line ${String(index + 1).padStart(2, "0")}`).join("\n\n"));
  const before = pendingSnapshot(harness);
  const { closed: opened } = await harness.open();

  // Open the short notice; its body wraps over several visible rows.
  await harness.click(harness.cell(`${shortId}: Selection notice`));
  const bodyStart = harness.cell("noticebody alpha");
  const bodyTail = harness.cell("zulu");
  const contextCell = harness.cell("noticecontext mike");
  assert.ok(bodyTail.y > bodyStart.y, `the notice body wraps over visible rows:\n${harness.frame().join("\n")}`);
  assert.ok(contextCell.y > bodyStart.y, "the context is drawn below the body");

  // Press on body text (no menu item) and drag through the context: the popup
  // must leave the whole gesture to the host's native selection.
  harness.terminal.input(sgr.press(bodyStart.x, bodyStart.y));
  harness.terminal.input(sgr.drag(78, contextCell.y));
  await harness.draw();
  harness.terminal.input(sgr.release(78, contextCell.y));
  await harness.draw();
  assert.equal(harness.screen.hasActiveSelection(), true, "the popup left the non-item gesture to native text selection");
  assert.equal(harness.backgroundEvents.length, 0, "an in-popup selection gesture never reached the transcript");
  assert.equal(harness.sent.length, 0);
  assertOthersUntouched(harness, before, [], "body selection");

  // The host's public clipboard path copies exactly the visible popup text,
  // including the wrapped body rows and the context, and never the background.
  assert.equal(harness.copied.length, 0, "copyOnSelect is off; nothing copied implicitly");
  assert.equal(await harness.screen.copyActiveSelectionToClipboard(), true);
  assert.equal(harness.copied.length, 1, "the explicit public copy used the local clipboard seam once");
  const copied = harness.copied[0]!;
  const copiedLines = copied.split("\n").map((line) => line.trimEnd());
  assert.ok(copiedLines.some((line) => line.includes("noticebody alpha")), `copied the visible body start:\n${copied}`);
  assert.ok(copiedLines.some((line) => line.includes("zulu")), `copied the wrapped body tail:\n${copied}`);
  assert.ok(copiedLines.some((line) => line.includes("noticecontext mike november")), `copied the visible context:\n${copied}`);
  assert.ok(copiedLines.every((line) => !line.includes("transcript line")), `the background transcript was never copied:\n${copied}`);
  assert.equal(harness.copied.length, 1, "one copy call copied once");
  assert.equal(harness.sent.length, 0);
  assertOthersUntouched(harness, before, [], "body copy");

  // A body-originated drag that crosses and releases over the Close action
  // cannot gain it: the notice stays pending and nothing is delivered.
  const close = harness.cell("Close");
  harness.terminal.input(sgr.press(bodyStart.x, bodyStart.y));
  harness.terminal.input(sgr.drag(close.x, close.y));
  await harness.draw();
  harness.terminal.input(sgr.release(close.x, close.y));
  await harness.draw();
  assert.equal(harness.surface.controller.getPending(shortId), before.get(shortId), "the crossed Close action never ran");
  assert.equal(harness.sent.length, 0);
  assertOthersUntouched(harness, before, [], "cross-action release");

  // Negative control for the narrowed ownership: a deliberate click on the
  // real action still runs it once, with its own claimed press, and it neither
  // starts a native selection nor copies anything.
  await harness.click(harness.cell("Close"));
  await settle();
  assert.equal(harness.surface.controller.getPending(shortId), undefined, "the deliberate Close click ran exactly once");
  assert.equal(harness.copied.length, 1, "a claimed item click never copies");
  assert.equal(harness.screen.hasActiveSelection(), false, "a claimed item click owns the gesture, not native selection");
  assert.equal(harness.sent.length, 0);
  assertOthersUntouched(harness, before, [shortId], "deliberate Close");
  assert.ok(onScreen(harness, "Pending input (2)"), `the list returns with the other records:\n${harness.frame().join("\n")}`);

  // A scrolled notice copies only its currently visible rows: the first body
  // line has left the viewport and must not appear in the selection source.
  await harness.click(harness.cell(`${longId}: Long selection notice`));
  assert.ok(onScreen(harness, "longbody line 01"), "the long notice opens at its beginning");
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN,
    () => !onScreen(harness, "longbody line 01") && onScreen(harness, "longbody line 40"));
  const visibleBody = harness.frame().flatMap((row, y) => {
    const match = /longbody line \d+/.exec(row);
    return match ? [{ y, text: match[0] }] : [];
  });
  assert.ok(visibleBody.length >= 2, `two body rows are visible after scrolling:\n${harness.frame().join("\n")}`);
  const [firstVisible, secondVisible] = visibleBody;
  assert.ok(!firstVisible!.text.includes("01"), "the first body line scrolled out of the viewport");
  harness.terminal.input(sgr.press(harness.cell(firstVisible!.text).x, firstVisible!.y));
  harness.terminal.input(sgr.drag(harness.cell(secondVisible!.text).x + 20, secondVisible!.y));
  await harness.draw();
  harness.terminal.input(sgr.release(harness.cell(secondVisible!.text).x + 20, secondVisible!.y));
  await harness.draw();
  assert.equal(await harness.screen.copyActiveSelectionToClipboard(), true, "the visible scrolled rows are selectable");
  const scrolledCopy = harness.copied[1]!;
  assert.ok(scrolledCopy.includes(firstVisible!.text) && scrolledCopy.includes(secondVisible!.text));
  assert.ok(!scrolledCopy.includes("longbody line 01"), `offscreen popup content is not part of the visible selection source:\n${scrolledCopy}`);
  assert.equal(harness.sent.length, 0);

  // A gesture that starts on non-item content and leaves the overlay falls
  // back to the host's ordinary routing: the synthetic transcript region may
  // legitimately see the drag/release callbacks, but no new press or click,
  // and no popup action, answer, or other session may be triggered.
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await opened;
  const reopened = await harness.open();
  await harness.click(harness.cell(`${questionId}: ${question}`));
  assert.ok(onScreen(harness, "1. keep"), `the reopened popup answers clicks:\n${harness.frame().join("\n")}`);
  const backgroundBefore = harness.backgroundEvents.length;
  const questionText = harness.cell(question);
  harness.terminal.input(sgr.press(questionText.x, questionText.y));
  harness.terminal.input(sgr.drag(10, 0));
  await harness.draw();
  harness.terminal.input(sgr.release(10, 0));
  await harness.draw();
  const outsideEvents = harness.backgroundEvents.slice(backgroundBefore);
  assert.notEqual(outsideEvents.length, 0, "the outside drag/release reaches the host's ordinary layout routing");
  for (const event of outsideEvents) {
    assert.ok(event.type === "drag" || event.type === "release",
      "no fresh press or click is fabricated while a selection leaves the popup");
  }
  assert.equal(harness.sent.length, 0, "leaving the popup never answers the question");
  assert.ok(harness.surface.controller.getPending(questionId), "the question stays pending");
  assert.ok(onScreen(harness, "1. keep"), "the popup and its visible choice are unchanged");
  assert.equal(harness.screen.hasOverlay(), true);

  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await reopened.closed;
  assert.equal(harness.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Issue #436 explicit copy: with Pi's copy-on-select off, Pi's own configured
// explicit copy shortcut (`app.message.copy`, Ctrl+X by default) must copy the
// visible popup selection while the overlay owns keyboard focus. These tests
// send the real configured key bytes through the installed runtime's parser,
// overlay dispatch, native selection, and clipboard seam — they never call the
// component's copy path or `copyActiveSelectionToClipboard` directly.
// ---------------------------------------------------------------------------

/** Drag a live native text selection from one drawn cell to another. */
async function dragSelect(harness: Harness, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  harness.terminal.input(sgr.press(from.x, from.y));
  harness.terminal.input(sgr.drag(to.x, to.y));
  await harness.draw();
  harness.terminal.input(sgr.release(to.x, to.y));
  await harness.draw();
}

/** Send the configured copy key and return the exact text the host copied. */
async function copyWithKey(harness: Harness, key: string): Promise<string> {
  const before = harness.copied.length;
  harness.terminal.input(key);
  await until(() => harness.copied.length > before, 1000);
  assert.equal(harness.copied.length, before + 1, "the configured copy key copied exactly once");
  return harness.copied[before]!;
}

test("native fullscreen dispatch: the configured copy key copies the visible popup selection once, never hidden text", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  harness.terminal.resize(80, 26);

  const question = "Keep this pending?";
  const questionId = registerQuestion(harness, question, ["keep"]);
  // A distinct wrapped body, an explicit context, and a distinct transcript
  // underneath: the explicit copy must read the visible popup, never the chat.
  const body = "noticebody alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
    + "mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
  const context = "noticecontext mike november oscar papa quebec romeo";
  const noticeId = registerNotice(harness, "Copyable notice", body, context);
  const before = pendingSnapshot(harness);
  const { closed: opened } = await harness.open();
  assert.equal(harness.screen.getCopyOnSelect(), false, "the host's copy-on-select setting stays off");

  // List mode: with no selection the configured copy key copies nothing and
  // leaves the popup's own navigation untouched.
  const q1Row = harness.cell(`q1: ${question}`);
  harness.terminal.input(CTRL_X);
  await harness.draw();
  assert.equal(harness.copied.length, 0, "no selection: the copy key copies nothing");
  harness.terminal.input(DOWN);
  await harness.draw();
  assert.doesNotMatch(harness.frame()[q1Row.y]!, /> q1: /, "arrow navigation still moves the list selection");
  harness.terminal.input(UP);
  await harness.draw();
  assert.match(harness.frame()[q1Row.y]!, /> q1: /, "and back");
  assert.equal(harness.screen.getCopyOnSelect(), false, "the copy key never changes the host setting");

  // Notice view: select the visible wrapped body through its context. With
  // copy-on-select off the release itself copies nothing.
  await harness.click(harness.cell(`${noticeId}: Copyable notice`));
  const bodyStart = harness.cell("noticebody alpha");
  const contextCell = harness.cell("noticecontext mike");
  assert.ok(contextCell.y > bodyStart.y, `the notice body wraps above its context:\n${harness.frame().join("\n")}`);
  await dragSelect(harness, bodyStart, { x: 78, y: contextCell.y });
  assert.equal(harness.screen.hasActiveSelection(), true,
    "the popup left the non-item gesture to Pi's native selection");
  assert.equal(harness.copied.length, 0, "copy-on-select is off: the release itself copies nothing");

  const copied = await copyWithKey(harness, CTRL_X);
  const copiedLines = copied.split("\n").map((line) => line.trimEnd());
  assert.ok(copiedLines.some((line) => line.includes("noticebody alpha")), `copied the visible body start:\n${copied}`);
  assert.ok(copiedLines.some((line) => line.includes("zulu")), `copied the wrapped body tail:\n${copied}`);
  assert.ok(copiedLines.some((line) => line.includes("noticecontext mike november")), `copied the visible context:\n${copied}`);
  assert.ok(copiedLines.every((line) => !line.includes("transcript line")), `no hidden transcript text was copied:\n${copied}`);
  assert.equal(harness.sent.length, 0, "the copy key never answers, declines, or acts");
  assertOthersUntouched(harness, before, [], "explicit copy key");
  assert.equal(harness.screen.getCopyOnSelect(), false, "the host's copy-on-select setting is never overridden");

  // A deliberate click on the real action still runs it exactly once: the copy
  // key consumed none of the popup's existing pointer semantics.
  await harness.click(harness.cell("Close"));
  await settle();
  assert.equal(harness.surface.controller.getPending(noticeId), undefined, "the deliberate Close click still ran exactly once");
  assert.equal(harness.sent.length, 0);
  assertOthersUntouched(harness, before, [noticeId], "deliberate Close");
  assert.equal(harness.copied.length, 1, "a claimed item click never copies");

  // Answer view: select the visible question text and copy it with the same
  // configured key; the visible source is the question, not the notice or the
  // transcript.
  await harness.click(harness.cell(`q1: ${question}`));
  assert.ok(onScreen(harness, "1. keep"), `the answer view opened:\n${harness.frame().join("\n")}`);
  const questionCell = harness.cell(question);
  await dragSelect(harness, questionCell, { x: questionCell.x + question.length - 1, y: questionCell.y });
  const questionCopy = await copyWithKey(harness, CTRL_X);
  assert.ok(questionCopy.includes(question), `copied the visible question text:\n${questionCopy}`);
  assert.ok(!questionCopy.includes("noticebody"), `the closed notice is not the copy source:\n${questionCopy}`);
  assert.ok(questionCopy.split("\n").every((line) => !line.includes("transcript line")));
  assert.equal(harness.sent.length, 0, "copying the question text never answers it");
  assertOthersUntouched(harness, before, [noticeId], "question copy");

  // Shared native editing: the configured copy key with no selection leaves the
  // native field's own keys untouched. Ctrl+C is app.clear, not the copy
  // binding, so it never reaches the explicit-copy path: nothing is copied,
  // submitted, cancelled, or closed. (The native clear itself is covered by
  // tests/user-question-editor-parity.test.ts against the real host, which
  // registers the host's app.clear handler exactly as InteractiveMode does.)
  await harness.click(harness.cell("Type something…"));
  for (const char of "draft answer") harness.terminal.input(char);
  await harness.draw();
  assert.ok(onScreen(harness, "draft answer"), `the native draft shows:\n${harness.frame().join("\n")}`);
  harness.terminal.input(CTRL_C);
  await harness.draw();
  assert.equal(harness.copied.length, 2, "Ctrl+C is not the copy binding and copied nothing");
  assert.equal(harness.sent.length, 0, "Ctrl+C never submits or cancels");
  assert.equal(harness.screen.hasOverlay(), true, "Ctrl+C never closes the popup");
  assert.ok(onScreen(harness, "Enter submit"), "the native field is still editing after Ctrl+C");
  assertOthersUntouched(harness, before, [noticeId], "Ctrl+C");

  // Close/reopen copy ownership: after the popup closes, background routing
  // resumes; a reopened popup owns the copy key for its own new selection.
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await opened;
  assert.equal(harness.screen.hasOverlay(), false);
  const background = harness.cell("transcript line");
  await harness.click({ x: 2, y: background.y });
  assert.ok(harness.backgroundEvents.some((event) => event.type === "click"),
    "background routing resumed after the popup closed");
  harness.backgroundEvents.length = 0;
  const reopened = await harness.open();
  await harness.click(harness.cell(`q1: ${question}`));
  const reopenedCell = harness.cell(question);
  await dragSelect(harness, reopenedCell, { x: reopenedCell.x + question.length - 1, y: reopenedCell.y });
  const reopenedCopy = await copyWithKey(harness, CTRL_X);
  assert.ok(reopenedCopy.includes(question), `the reopened popup copied its own visible selection:\n${reopenedCopy}`);
  assert.equal(harness.sent.length, 0);
  assert.ok(harness.surface.controller.getPending(questionId), "the question stays pending");
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await reopened.closed;
  assert.deepEqual(harness.backgroundEvents, []);
});

test("native fullscreen dispatch: the configured copy key copies only the currently visible scrolled rows", async (t) => {
  const harness = await createHarness(t);
  if (!harness) return;
  harness.terminal.resize(80, 16);
  registerQuestion(harness, "Keep me pending?", ["keep"]);
  const longId = registerNotice(harness, "Long copyable notice",
    Array.from({ length: 40 }, (_, index) => `longbody line ${String(index + 1).padStart(2, "0")}`).join("\n\n"));
  const { closed } = await harness.open();
  await harness.click(harness.cell(`${longId}: Long copyable notice`));
  assert.ok(onScreen(harness, "longbody line 01"), `the long notice opens at its beginning:\n${harness.frame().join("\n")}`);
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN,
    () => !onScreen(harness, "longbody line 01") && onScreen(harness, "longbody line 40"));

  // Narrow the terminal and scroll again: the popup re-wraps the complete body,
  // and the copy source must be the rows currently drawn at the new width.
  harness.terminal.resize(56, 14);
  await harness.draw();
  assert.ok(harness.frame().every((row) => row.length <= 56), "the frame fits the narrowed terminal");
  await scrollPopupUntil(harness, SHIFT_ALT_DOWN, () => !onScreen(harness, "longbody line 01"));

  // Two body rows are currently drawn; the first body line has left the viewport.
  const visible = harness.frame().flatMap((row, y) => {
    const match = /longbody line \d+/.exec(row);
    return match ? [{ x: row.search(/\S/), y, text: match[0] }] : [];
  });
  assert.ok(visible.length >= 2, `two body rows are visible after scrolling:\n${harness.frame().join("\n")}`);
  const first = visible[0]!;
  const second = visible[1]!;
  assert.ok(!first.text.includes("01"), "the first body line scrolled out of the viewport");

  await dragSelect(harness, { x: first.x, y: first.y }, { x: second.x + second.text.length, y: second.y });
  const copied = await copyWithKey(harness, CTRL_X);
  assert.ok(copied.includes(first.text) && copied.includes(second.text),
    `copied the currently visible scrolled rows:\n${copied}`);
  assert.ok(!copied.includes("longbody line 01"),
    `offscreen popup content is not part of the visible selection source:\n${copied}`);
  assert.equal(harness.sent.length, 0);
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await closed;
});

test("native fullscreen dispatch: a live remapped copy binding is honored while the popup owns focus", async (t) => {
  const harness = await createHarness(t, { userBindings: { "app.message.copy": "f6" } });
  if (!harness) return;
  harness.terminal.resize(80, 24);
  registerQuestion(harness, "Copy this question?", ["yes"]);
  const { closed } = await harness.open();
  await harness.click(harness.cell("q1: Copy this question?"));
  const questionCell = harness.cell("Copy this question?");
  await dragSelect(harness, questionCell, { x: questionCell.x + "Copy this question?".length - 1, y: questionCell.y });
  assert.equal(harness.screen.hasActiveSelection(), true);
  // The remapped-away default no longer copies; the live remapped key does.
  harness.terminal.input(CTRL_X);
  await harness.draw();
  assert.equal(harness.copied.length, 0, "the remapped-away default key no longer copies");
  const copied = await copyWithKey(harness, F6);
  assert.ok(copied.includes("Copy this question?"), `the remapped binding copied the visible selection:\n${copied}`);
  assert.equal(harness.sent.length, 0);
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await closed;
});

test("native fullscreen dispatch: copy-on-select on is preserved and the copy key does not intercept", async (t) => {
  const harness = await createHarness(t, { copyOnSelect: true });
  if (!harness) return;
  harness.terminal.resize(80, 24);
  registerQuestion(harness, "Select over this question?", ["yes"]);
  const { closed } = await harness.open();
  await harness.click(harness.cell("q1: Select over this question?"));
  const questionCell = harness.cell("Select over this question?");
  await dragSelect(harness, questionCell, { x: questionCell.x + "Select over this question?".length - 1, y: questionCell.y });
  assert.equal(harness.copied.length, 1, "copy-on-select copied the finished selection on release");
  harness.terminal.input(CTRL_X);
  await harness.draw();
  assert.equal(harness.copied.length, 1, "with copy-on-select on the copy key adds no second copy");
  assert.equal(harness.screen.getCopyOnSelect(), true, "the host's copy-on-select setting is never changed");
  assert.equal(harness.sent.length, 0);
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await closed;
});

test("native fullscreen dispatch: a failing native clipboard seam stays truthful and never leaks an unhandled rejection", async (t) => {
  const seamCalls: string[] = [];
  const harness = await createHarness(t, {
    copySelection: async (text: string) => {
      seamCalls.push(text);
      throw new Error("clipboard unavailable");
    },
  });
  if (!harness) return;
  harness.terminal.resize(80, 24);
  registerQuestion(harness, "Copy with a broken clipboard?", ["yes"]);
  const { closed } = await harness.open();
  await harness.click(harness.cell("q1: Copy with a broken clipboard?"));
  const questionCell = harness.cell("Copy with a broken clipboard?");
  await dragSelect(harness, questionCell, { x: questionCell.x + "Copy with a broken clipboard?".length - 1, y: questionCell.y });
  harness.terminal.input(CTRL_X);
  await settle(20);
  assert.equal(seamCalls.length, 1, "the configured copy key still reached the host clipboard seam once");
  assert.equal(harness.screen.hasOverlay(), true, "a rejected clipboard seam never closes the popup");
  assert.equal(harness.sent.length, 0, "and never fabricates an answer or action");
  // The popup remains fully usable afterwards.
  assert.ok(onScreen(harness, "1. yes"), `the answer view is intact:\n${harness.frame().join("\n")}`);
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await closed;
});

test("native fullscreen dispatch: a selection inherited from the transcript is fenced at popup entry and never copied", async (t) => {
  // The transcript is left unhandled so Pi's own native selection anchors on its
  // scroll view. That inherited anchor is exactly what would make the popup's
  // explicit copy read hidden scroll content instead of the visible popup.
  const harness = await createHarness(t, { transcriptHandlesMouse: false });
  if (!harness) return;
  harness.terminal.resize(80, 24);
  const question = "Fresh popup question?";
  registerQuestion(harness, question, ["yes"]);
  await harness.draw();

  // Select transcript text before the popup exists.
  const transcriptCell = harness.cell("transcript line");
  await dragSelect(harness, transcriptCell, { x: transcriptCell.x + 20, y: transcriptCell.y + 1 });
  assert.equal(harness.screen.hasActiveSelection(), true, "the transcript selection is live before the popup opens");
  assert.equal(harness.copied.length, 0, "copy-on-select is off: the release copied nothing");
  // Control: Pi's own explicit copy of that inherited selection resolves the
  // transcript's scroll source, which is the hidden-content hazard.
  assert.equal(await harness.screen.copyActiveSelectionToClipboard(), true,
    "the inherited transcript selection is directly copyable before the popup opens");
  assert.ok(harness.copied[0]!.includes("transcript line"),
    `the inherited selection copies transcript content:\n${harness.copied[0]}`);
  const inheritedCopies = harness.copied.length;

  // Open the popup with no new pointer gesture: the inherited selection is
  // dropped at entry, so the configured copy key copies nothing.
  const { closed } = await harness.open();
  assert.equal(harness.screen.hasActiveSelection(), false,
    "popup entry drops the inherited transcript selection");
  harness.terminal.input(CTRL_X);
  await harness.draw();
  assert.equal(harness.copied.length, inheritedCopies, "the inherited transcript selection was never copied through the popup");
  assert.equal(harness.sent.length, 0);
  assert.ok(onScreen(harness, `${question}`), `the popup stays open:\n${harness.frame().join("\n")}`);

  // A fresh selection over the visible popup still copies normally.
  await harness.click(harness.cell(`q1: ${question}`));
  const questionCell = harness.cell(question);
  await dragSelect(harness, questionCell, { x: questionCell.x + question.length - 1, y: questionCell.y });
  const copied = await copyWithKey(harness, CTRL_X);
  assert.ok(copied.includes(question), `a fresh popup selection still copies:\n${copied}`);
  assert.ok(copied.split("\n").every((line) => !line.includes("transcript line")),
    `and never the transcript:\n${copied}`);
  assert.equal(harness.sent.length, 0);
  harness.terminal.input(ESCAPE);
  await harness.draw();
  harness.terminal.input(ESCAPE);
  await closed;
});
