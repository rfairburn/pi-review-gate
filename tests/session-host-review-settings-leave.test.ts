/**
 * Issue #723 acceptance contract: leaving the session-host sidebar's Review
 * settings editor from the LEFT BAR (the roster column drawn beside the pane).
 *
 * Required behavior of the left-sidebar leave:
 * - A left click on another actionable left-bar row leaves Review settings and
 *   performs that row's ordinary action exactly once, from a menu screen or a
 *   text field.
 * - Clicking the left-bar **Settings** row, blank roster space, or using the
 *   wheel never leaves the editor. The Settings row — the row this pane belongs
 *   to — is the deciding row, not the drawn highlight: a click on a currently
 *   highlighted NON-Settings row still leaves.
 * - A clean draft leaves directly. A draft that changed at any depth, including
 *   text typed into a settings field and never submitted, confirms first.
 * - Declining (the highlighted "No", or Escape) restores the exact screen, the
 *   staged draft, and the unsubmitted typed text with its caret position.
 *   Confirming ("Yes") discards and activates the clicked row once. Neither
 *   path ever saves.
 * - No Yes comes from a confirmation frame the operator was never shown
 *   (unwritten or clipped) or from a click whose target row is gone.
 * - Every existing keyboard exit (nested Back, root Escape, Cancel) is unchanged.
 *
 * ## Status
 *
 * This began as a clean-room `.acceptance.ts` contract written before the
 * behavior existed, run only when named directly. Once every case was green it
 * was promoted, unchanged in its assertions, into the regular suite as this
 * `*.test.ts` file. No case is skipped, softened, or conditional. Cases marked
 * GUARD already held before the leave landed and keep it from regressing them.
 *
 * ## What the fixtures are
 *
 * - `leaveFixture` runs the REAL `SidebarController` in its wide two-pane
 *   layout (roster + form slot) with the REAL LOCAL transaction
 *   (`openLocalReviewSettings` -> `runPersistedReviewSettings`) over the
 *   sidebar's own custom-screen host, and reports the drawn frames as written
 *   the way Main's frame writer does. Clicks use the draw-derived maps Main
 *   itself drives: `captureMousePresentation()` then either the ordinary
 *   press-time `activateRosterAt` (a host action row) or the held
 *   `beginSessionPointerAt`/`finishSessionPointerAt` pair (a session card, which
 *   Main activates on RELEASE).
 * - Every case is black-box: nothing here reaches into the transaction, the
 *   draft, or any host seam. Staged state is read where the operator reads it —
 *   the value the drawn menu shows against the value the disk still holds — and
 *   leaving, confirming, discarding, and saving are read from the drawn frames,
 *   the emitted `SidebarAction`s, and the config bytes.
 * - The last case runs the real `main.ts` controller through the shared Main
 *   harness and sends raw SGR left-press and left-release packets.
 *
 * ## Presentation assumptions this contract makes
 *
 * The leave confirmation is read the way every other sidebar confirmation is
 * read: the pane states that the unsaved draft will be discarded and offers
 * ordinary `Yes` / `No` list rows (the shared `→ ` or the pane's own `> `
 * selection marker), answered by the screen's normal confirm key, with Escape
 * as Cancel. Wording is matched case-insensitively on the word "discard". If
 * the integration renders the choice any other way, that is a contract change
 * to agree first — not something to soften here. "Exact screen" includes the
 * caret: `renderForm` returns it beside the drawn lines, and the field cases
 * compare both.
 *
 * Every HOME, agent directory, and config is synthetic and owned here; no real
 * config, provider, network, or Pi session is touched. Scratch is a fresh
 * `mkdtemp` removed by `t.after`, including when a case throws.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  SidebarController,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarMousePresentation,
} from "../src/session-host/sidebar";
import { openLocalReviewSettings } from "../src/session-host/review-settings";
import { loadNativeFieldKeybindings, withNativeFieldKeybindings } from "../src/session-host/form-support";
import type { ReviewSettingsCatalog } from "../src/session-host/review-settings-catalog";
import type { SidebarReviewSettingsHost } from "../src/session-host/review-settings-ui";
import {
  closeWithSignal,
  createHarness,
  emitMouse,
  makeMainTestDirectory,
  nextTurn,
  plain,
  ready,
  type Harness,
} from "./helpers/session-host-main-harness";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";

/** Wide two-pane geometry: a real roster column beside the Review settings pane. */
const ROSTER_COLS = 32;
const FORM_COLS = 47;
const PANE_ROWS = 24;

const TEST_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 15_000;
/** Bounded so a transaction that stays open (a declined or refused leave) cannot hang the file. */
const FLUSH_TIMEOUT_MS = 4_000;

const PI_EXECUTABLE = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

/** One saved config whose every edited value is distinguishable from the staged one. */
const DISK_A = Object.freeze({
  enabled: true,
  youShouldKnow: { enabled: true, completionGuidance: true },
  operatingMode: "execute",
  unrelatedFutureField: { keep: true },
});

const TYPED_UNSUBMITTED = "^https://typed-but-never-submitted";

function fakeCatalog(): ReviewSettingsCatalog {
  return {
    scoped: [{ model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] }],
    tools: [{ name: "bash", description: "Execute a command." }, { name: "read" }, { name: "tool_search" }],
    warnings: [],
    modelScope: { source: "enabledModels", patterns: ["acme/deep"] },
  };
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function ticks(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Owned scratch: one fresh temporary directory per case, removed even on throw
// ---------------------------------------------------------------------------

interface Owned {
  root: string;
  home: string;
  agentDir: string;
  canonical: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

function owned(t: TestContext): Owned {
  const root = mkdtempSync(join(tmpdir(), "rs723-leave-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const agentDir = realpathSync(join(home, ".pi", "agent"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  return { root, home, agentDir, canonical: join(agentDir, "review-gate.json"), workspace, env: { HOME: home, USERPROFILE: home } };
}

/** Write the canonical config and return its exact bytes, the "disk A" witness. */
function writeConfig(path: string, body: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const text = JSON.stringify(body, null, 2);
  writeFileSync(path, text, "utf8");
  return text;
}

type SessionInput = Parameters<SidebarController["updateItems"]>[0][number];

function card(id: string, workspace: string): SessionInput {
  return {
    id,
    label: `label-${id}`,
    workspace,
    agentDir: "/synthetic/agent",
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  };
}

/**
 * The contract's own card first, then `count - 1` extra cards. Enough of them
 * overflow the written roster, so a wheel notch really moves the viewport.
 */
function sessions(count: number): SessionInput[] {
  const items: SessionInput[] = [card("keep-me", "/synthetic/workspace")];
  for (let index = 1; index < count; index += 1) {
    items.push(card(`extra-${index}`, `/synthetic/workspace-${index}`));
  }
  return items;
}

// ---------------------------------------------------------------------------
// The written Sidebar fixture: real controller, real wide layout, real clicks
// ---------------------------------------------------------------------------

interface LeaveFixtureOptions {
  /** Override the sidebar options the fixture composes. */
  readonly sidebarOptions?: Partial<SidebarControllerOptions>;
  /** Session cards the roster holds; more than the pane fits makes the wheel scroll. */
  readonly sessionCount?: number;
  /**
   * Native keybindings this open reads from its agent directory, scoped around
   * every screen operation exactly as Main scopes them. Omitted: Pi's defaults.
   */
  readonly keybindings?: Record<string, string | string[]>;
}

/**
 * Which pane the wide layout's right slot holds, read from what that slot
 * actually drew plus the controller's public focus. The controller's own form
 * kind is private (every existing sidebar test reads the drawn frame too), so
 * this contract uses only what the operator can see.
 */
type PaneKind = "review-settings" | "settings" | "other" | "none";

interface LeaveFixture {
  sidebar: SidebarController;
  /** True (default) while every drawn Review settings frame is reported written, as Main's writer does. */
  writes: boolean;
  /** The pane's row budget; shrinking it exercises the clipped-screen paths. */
  rows: number;
  actions: SidebarAction[];
  mark(): void;
  since(): SidebarAction[];
  roster(): string[];
  pane(): string[];
  /** The form slot exactly as the renderer returns it: drawn lines plus the caret. */
  paneFrame(): ReturnType<SidebarController["renderForm"]>;
  paneText(): string;
  paneKind(): PaneKind;
  key(data: string): void;
  openReviewSettings(
    onScreen?: (text: string) => boolean,
    what?: string,
  ): Promise<void>;
  moveToFormRow(label: string): void;
  moveToMenuRow(label: string): void;
  waitForPane(what: string, predicate: (text: string) => boolean): Promise<void>;
  /** The pane row of the written roster that begins the entry containing `needle`. */
  rosterRow(needle: string): number;
  /** One ordinary press-time roster click (a host action row). */
  clickRosterRow(row: number): boolean;
  /** One held session-card press and its release, on the SAME captured maps. */
  pressAndReleaseCard(row: number): { held: boolean; released: boolean };
  /** One wheel notch inside the written roster. */
  wheelRoster(row: number, direction: -1 | 1): boolean;
  /** Let the open transaction settle, bounded: a run that never ends cannot hang a case. */
  flush(): Promise<void>;
}

function leaveFixture(t: TestContext, l: Owned, options: LeaveFixtureOptions = {}): LeaveFixture {
  const actions: SidebarAction[] = [];
  const runs: Array<Promise<void>> = [];
  let controller!: SidebarController;

  const host: SidebarReviewSettingsHost = {
    open: (ui, signal) => {
      const run = openLocalReviewSettings({
        env: l.env,
        agentDir: l.agentDir,
        piExecutable: PI_EXECUTABLE,
        args: [],
        cwd: l.workspace,
        ui,
      }, { loadChoices: async () => fakeCatalog() });
      // A declined or refused leave keeps the transaction open; never let its
      // rejection surface as an unhandled rejection.
      runs.push(Promise.resolve(run).then(() => undefined, () => undefined));
      return run;
    },
    ...(options.keybindings === undefined ? {} : {
      loadKeybindings: () => {
        const loaded = loadNativeFieldKeybindings(l.agentDir);
        return { manager: loaded.manager, run: <T>(operation: () => T): T => withNativeFieldKeybindings(loaded.manager, operation) };
      },
    }),
  };
  if (options.keybindings !== undefined) {
    writeFileSync(join(l.agentDir, "keybindings.json"), JSON.stringify(options.keybindings), "utf8");
  }
  controller = new SidebarController({
    settingsAvailable: true,
    reviewSettings: host,
    onAction: (action) => actions.push(action),
    ...options.sidebarOptions,
  });
  controller.updateItems(sessions(options.sessionCount ?? 1));
  // Whatever a case does, the open ends with it: the pane's lifetime aborts and
  // every outstanding screen/edit settles as a cancel, so nothing late writes.
  t.after(() => {
    controller.cancelReviewSettings();
  });

  const state: LeaveFixture = {
    sidebar: controller,
    writes: true,
    rows: PANE_ROWS,
    actions,
    mark(): void {
      actions.length = 0;
    },
    since(): SidebarAction[] {
      return [...actions];
    },
    roster(): string[] {
      return controller.renderRoster(ROSTER_COLS, state.rows).lines.map(strip);
    },
    pane(): string[] {
      return state.paneFrame().lines;
    },
    paneFrame(): ReturnType<SidebarController["renderForm"]> {
      const { lines, cursor } = controller.renderForm(FORM_COLS, state.rows);
      if (state.writes) {
        const presentation = controller.captureReviewSettingsPresentation();
        if (presentation !== undefined) controller.settleReviewSettingsRender(presentation.renderToken);
      }
      return { lines: lines.map(strip), cursor };
    },
    paneText(): string {
      return state.pane().join("\n");
    },
    paneKind(): PaneKind {
      if (controller.focus !== "form") return "none";
      const text = state.pane().join("\n");
      if (text.includes("Review settings (local)")) return "review-settings";
      // The grouped Settings submenu states the active appearance on its own row.
      if (text.includes("theme:")) return "settings";
      return "other";
    },
    key(data: string): void {
      controller.handleInput(data);
    },
    moveToFormRow(label: string): void {
      for (let step = 0; step < 40; step += 1) {
        if (state.pane().some((line) => line.startsWith(`> ${label}`))) return;
        state.key(DOWN);
      }
      assert.fail(`the Settings submenu never highlighted ${JSON.stringify(label)}:\n${state.paneText()}`);
    },
    moveToMenuRow(label: string): void {
      for (let step = 0; step < 80; step += 1) {
        if (state.pane().some((line) => line.trimStart().startsWith(`→ ${label}`))) return;
        state.key(DOWN);
      }
      assert.fail(`the settings screen never highlighted ${JSON.stringify(label)}:\n${state.paneText()}`);
    },
    async waitForPane(what: string, predicate: (text: string) => boolean): Promise<void> {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (predicate(state.paneText())) return;
        await delay(2);
      }
      assert.fail(`timed out waiting for ${what}:\n${state.paneText()}`);
    },
    async openReviewSettings(
      onScreen: (text: string) => boolean = (text) => text.includes("→ Operating mode"),
      what = "the shared root menu",
    ): Promise<void> {
      for (let step = 0; step < 40; step += 1) {
        if (state.roster().some((line) => line.startsWith("> Settings"))) break;
        state.key(DOWN);
      }
      state.roster();
      state.key(ENTER);
      state.moveToFormRow("Review settings");
      state.pane();
      state.key(ENTER);
      await state.waitForPane(what, onScreen);
    },
    rosterRow(needle: string): number {
      const row = state.roster().findIndex((line) => line.includes(needle));
      assert.ok(row >= 0, `the written roster drew no ${JSON.stringify(needle)} row:\n${state.roster().join("\n")}`);
      return row;
    },
    clickRosterRow(row: number): boolean {
      const captured: SidebarMousePresentation = controller.captureMousePresentation();
      return captured.activateRosterAt(1, row, ROSTER_COLS, state.rows);
    },
    pressAndReleaseCard(row: number): { held: boolean; released: boolean } {
      // One capture for the whole gesture, exactly as Main holds one written
      // presentation until the release: a session-card press is HELD and only
      // its release activates.
      const captured: SidebarMousePresentation = controller.captureMousePresentation();
      const held = captured.beginSessionPointerAt(1, row, ROSTER_COLS, state.rows);
      const released = held ? captured.finishSessionPointerAt(1, row, ROSTER_COLS, state.rows) : false;
      return { held, released };
    },
    wheelRoster(row: number, direction: -1 | 1): boolean {
      const captured: SidebarMousePresentation = controller.captureMousePresentation();
      return captured.scrollRosterAt(1, row, ROSTER_COLS, state.rows, direction);
    },
    async flush(): Promise<void> {
      const pending = runs.map((run) => run.then(() => undefined, () => undefined));
      await Promise.race([Promise.all(pending), delay(FLUSH_TIMEOUT_MS)]);
      await ticks();
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/** The pane offers a discard confirmation: its message, and a Yes and a No choice. */
function showsDiscardConfirmation(pane: readonly string[]): boolean {
  const text = pane.join("\n");
  return /discard/i.test(text) && /(^|\s)Yes(\s|$)/.test(text) && /(^|\s)No(\s|$)/.test(text);
}

function assertConfirmation(d: LeaveFixture, why: string): void {
  const pane = d.pane();
  assert.ok(showsDiscardConfirmation(pane), `${why}\n${pane.join("\n")}`);
}

function assertNoConfirmation(d: LeaveFixture, why: string): void {
  const pane = d.pane();
  assert.ok(!showsDiscardConfirmation(pane), `${why}\n${pane.join("\n")}`);
}

/** The staged nested value, as the drawn menu shows it. */
const STAGED_NOTICE_OFF = /YouShouldKnow notices\s+Off/;

/**
 * Return to the real menu that holds the staged change and read the staged
 * value there. A prompt an implementation kept open is dismissed; one it
 * retired on the unsafe answer is simply already gone. Either way the staged
 * edit has to be visible on a real menu screen — a still-drawn dialog beside an
 * emptied draft proves nothing.
 */
async function returnToStagedChange(d: LeaveFixture): Promise<void> {
  if (showsDiscardConfirmation(d.pane())) d.key(ESC);
  await d.waitForPane("the staged nested value after the refused leave",
    (text) => STAGED_NOTICE_OFF.test(text));
}

/**
 * Move the confirmation's own highlight onto `label`, reporting whether it got
 * there instead of failing: the unwritten-frame case needs to try, and fall
 * back when navigation itself is receipt-gated.
 */
function tryHighlightChoice(d: LeaveFixture, label: "Yes" | "No"): boolean {
  const pattern = new RegExp(`^\\s*[→>]\\s*${label}\\b`);
  for (let step = 0; step < 6; step += 1) {
    if (d.pane().some((line) => pattern.test(line))) return true;
    // Two choices: alternate so a clamped or a wrapping list both reach either row.
    d.key(step % 2 === 0 ? UP : DOWN);
  }
  return d.pane().some((line) => pattern.test(line));
}

/** Move the confirmation's own highlight onto `label`, proving it is drawn there. */
function highlightChoice(d: LeaveFixture, label: "Yes" | "No"): void {
  if (!tryHighlightChoice(d, label)) {
    assert.fail(`the confirmation never offered a highlighted ${label}:\n${d.pane().join("\n")}`);
  }
}

/** The drawn row of the highlighted choice, marker included. */
function highlightedRow(pane: readonly string[], label: "Yes" | "No"): number {
  return pane.findIndex((line) => new RegExp(`^\\s*[→>]\\s*${label}\\b`).test(line));
}

/** The drawn row that names the choice, highlighted or not. */
function choiceRow(pane: readonly string[], label: "Yes" | "No"): number {
  return pane.findIndex((line) => new RegExp(`^\\s*${label}\\b`).test(line));
}

/** Move the confirmation's own highlight onto `label`, then press its confirm key. */
function answerConfirmation(d: LeaveFixture, label: "Yes" | "No"): void {
  highlightChoice(d, label);
  d.key(ENTER);
}

/**
 * The same left-bar click again, on a frame that IS reported written: the
 * positive control that shows the earlier refusal was the missing presentation
 * and not a broken leave path. It never reuses the refused dialog.
 */
async function acceptFreshWrittenConfirmation(d: LeaveFixture): Promise<void> {
  const row = d.rosterRow("label-keep-me");
  assert.equal(d.pressAndReleaseCard(row).held, true, "the retry press is held for its release");
  await d.waitForPane("a fresh written discard confirmation",
    (text) => showsDiscardConfirmation(text.split("\n")));
  answerConfirmation(d, "Yes");
  await d.flush();
}

/** Stage one real change two levels deep and stay nested there (Tools -> YouShouldKnow notices). */
async function stageNestedChange(d: LeaveFixture): Promise<void> {
  d.moveToMenuRow("Tools");
  d.key(ENTER);
  await d.waitForPane("the Tools submenu", (text) => text.includes("YouShouldKnow notices"));
  d.moveToMenuRow("YouShouldKnow notices");
  d.key(ENTER);
  await d.waitForPane("the staged nested change", (text) => /YouShouldKnow notices\s+Off/.test(text));
}

// ---------------------------------------------------------------------------
// A clean draft leaves
// ---------------------------------------------------------------------------

test("left-bar leave: a clean draft leaves on a session-card click and that row performs its ordinary action once", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();

  const row = d.rosterRow("label-keep-me");
  d.mark();
  const gesture = d.pressAndReleaseCard(row);
  assert.equal(gesture.held, true, "a session-card press beside an open right-hand pane is held for its release");
  await d.flush();

  assert.deepEqual(d.since(), [{ type: "select", id: "keep-me" }],
    "the clicked row performs its ordinary action exactly once");
  assert.equal(d.paneKind(), "none",
    "Review settings left, and the Settings submenu was not re-shown in its place");
  assertNoConfirmation(d, "a clean draft must leave directly, not confirm first");
  assert.equal(d.sidebar.focus, "main", "the clicked row became the Main input owner");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "leaving a clean draft never writes the config");
});

test("left-bar leave: clicking the left-bar Settings row never leaves, even when another row holds the highlight [GUARD]", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();

  // Move the LEFT highlight off Settings (a backend-driven selection), then
  // click Settings: the deciding row is Settings, not the drawn highlight.
  d.sidebar.select("keep-me");
  const row = d.rosterRow("Settings");
  d.mark();
  d.clickRosterRow(row);
  await ticks();

  assert.deepEqual(d.since(), [], "clicking Settings emits nothing at all");
  assert.equal(d.paneKind(), "review-settings", "the editor stays open");
  assert.match(d.paneText(), /→ Operating mode/, "the same screen is still on screen");
  assert.equal(d.sidebar.focus, "form", "input ownership did not move");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "a Settings click never writes the config");
});

test("left-bar leave: blank roster space never leaves the editor [GUARD]", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();

  const roster = d.roster();
  const blank = roster.findIndex((line, index) => index > 5 && index < d.rows - 4 && line.trim() === "");
  assert.ok(blank >= 0, `the written roster drew no blank row:\n${roster.join("\n")}`);
  d.mark();
  assert.equal(d.clickRosterRow(blank), false, "a click on blank space activates nothing");
  await ticks();

  assert.deepEqual(d.since(), [], "blank space emits no action");
  assert.equal(d.paneKind(), "review-settings", "the editor stays open");
  assert.match(d.paneText(), /→ Operating mode/, "the same screen is still on screen");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "blank space writes nothing");
});

test("left-bar leave: a wheel notch that really scrolls the roster never leaves the editor [GUARD]", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  // Enough cards that the written roster overflows its viewport, so a notch has
  // somewhere to go: a wheel that only fits-cannot-scroll would prove nothing.
  const d = leaveFixture(t, l, { sessionCount: 12 });
  await d.openReviewSettings();

  const before = d.roster();
  assert.ok(before.some((line) => line.includes("label-extra-")), `the roster drew the extra cards:\n${before.join("\n")}`);
  // Any completely drawn card inside the current window: the wheel moves the
  // window, so the notch must be reported inside the roster the frame drew.
  const cardRow = before.findIndex((line) => line.includes("label-"));
  assert.ok(cardRow >= 0, `the written roster drew no card row:\n${before.join("\n")}`);
  const paneBefore = d.pane();
  d.mark();

  assert.equal(d.wheelRoster(cardRow, -1), true, "the wheel scrolls the overflowing written roster");
  const after = d.roster();
  assert.notEqual(after.join("\n"), before.join("\n"), "the notch moved the roster viewport");
  await ticks();

  assert.deepEqual(d.since(), [], "the wheel emits no activation of any kind");
  assert.equal(d.paneKind(), "review-settings", "the editor stays open");
  assert.deepEqual(d.pane(), paneBefore, "the same Review settings screen is still drawn, unchanged");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "the wheel writes nothing");
});

test("left-bar leave: a clean draft leaves on the currently highlighted NON-Settings row too", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();

  // The same-row no-op that other panes use must not apply here: the deciding
  // row is Settings, so a highlighted session card still leaves.
  d.sidebar.select("keep-me");
  const row = d.rosterRow("label-keep-me");
  assert.equal(d.sidebar.selectedId, "keep-me", "the LEFT highlight really sits on the clicked row");
  d.mark();
  const gesture = d.pressAndReleaseCard(row);
  assert.equal(gesture.held, true, "the press is held for its release");
  await d.flush();

  assert.deepEqual(d.since(), [{ type: "select", id: "keep-me" }],
    "the highlighted non-Settings row leaves and performs its ordinary action once");
  assert.equal(d.paneKind(), "none", "Review settings left");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "a clean leave never writes the config");
});

test("left-bar leave: a change staged two levels deep confirms, and both No and Escape restore the exact screen and draft", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await stageNestedChange(d);

  const nested = d.pane();
  assert.match(nested.join("\n"), / Tools/, "the operator is inside the Tools submenu");

  // Decline with the explicit No row: not just a screen that mentions the same
  // section, but the byte-for-byte screen the operator left, highlight and
  // scroll position included, with the staged value still staged.
  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the dirty left-bar click showed no discard confirmation");
  answerConfirmation(d, "No");
  await ticks();

  assert.deepEqual(d.since(), [], "declining activates nothing");
  assert.equal(d.paneKind(), "review-settings", "declining keeps the editor open");
  assert.deepEqual(d.pane(), nested, "the declined screen comes back exactly, highlight and scroll included");
  assert.match(d.paneText(), /YouShouldKnow notices\s+Off/, "the staged nested change is still staged");

  // Decline again, this time with Escape, and prove the same exact restoration.
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the second press is held too");
  await d.flush();
  assertConfirmation(d, "the second dirty left-bar click showed no discard confirmation");
  d.key(ESC);
  await ticks();

  assert.deepEqual(d.since(), [], "Escape answers No and activates nothing");
  assert.equal(d.paneKind(), "review-settings", "Escape keeps the editor open");
  assert.deepEqual(d.pane(), nested, "Escape restores the same screen exactly too");
  assert.match(d.paneText(), /YouShouldKnow notices\s+Off/, "the staged nested change survives Escape too");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "declining never writes the config");
});

test("left-bar leave: Yes discards the nested staged change, activates the clicked row once, and never saves", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await stageNestedChange(d);

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the dirty left-bar click showed no discard confirmation");
  answerConfirmation(d, "Yes");
  await d.flush();

  assert.deepEqual(d.since(), [{ type: "select", id: "keep-me" }],
    "the accepted confirmation activates the clicked row exactly once");
  assert.equal(d.paneKind(), "none", "the editor left, and the Settings submenu was not re-shown");
  assert.equal(d.sidebar.focus, "main", "the clicked row became the Main input owner");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA,
    "a discarded draft is never saved: the config is byte-for-byte what the open read");
});

// ---------------------------------------------------------------------------
// A Yes only comes from a frame the operator was actually shown
// ---------------------------------------------------------------------------

test("left-bar leave: an unwritten confirmation cannot answer Yes, and the written frame can", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await stageNestedChange(d);

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();

  // From here to the attempted acceptance no frame of this confirmation is ever
  // reported written: the synthetic writer stops before the first render of the
  // confirmation, so no earlier receipt can carry the answer either.
  d.writes = false;
  assertConfirmation(d, "the dirty left-bar click showed no discard confirmation");
  if (!tryHighlightChoice(d, "Yes")) {
    // Navigation may itself need a receipt. Present only the frame that shows
    // the choice NOT selected, then move to Yes without ever presenting the
    // frame that shows Yes selected.
    d.writes = true;
    highlightChoice(d, "No");
    const shown = d.pane();
    const noRow = highlightedRow(shown, "No");
    const yesRow = choiceRow(shown, "Yes");
    assert.ok(noRow >= 0 && yesRow >= 0, `the written No frame shows both choices:\n${shown.join("\n")}`);
    d.writes = false;
    d.key(yesRow < noRow ? UP : DOWN);
    assert.ok(highlightedRow(d.pane(), "Yes") >= 0,
      "Yes is selected, but no frame showing that selection was ever written");
  }
  // Enter now carries the Yes selection on a frame the operator was never shown.
  d.key(ENTER);
  await ticks();

  assert.deepEqual(d.since(), [], "a confirmation the operator was never shown answers nothing");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "nothing is discarded or saved from an unwritten frame");

  // Positive control: back to the real menu with the staged value still drawn,
  // then a fresh click whose frame IS written. Whether the refused dialog is
  // still up or was retired on the unsafe answer is the implementation's choice.
  d.writes = true;
  await returnToStagedChange(d);
  assert.deepEqual(d.since(), [], "returning to the staged menu activates nothing");
  await acceptFreshWrittenConfirmation(d);

  assert.deepEqual(d.since(), [{ type: "select", id: "keep-me" }],
    "the written confirmation answers Yes once");
  assert.equal(d.paneKind(), "none", "the editor left");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "Yes discards: it never saves");
});

test("left-bar leave: a Yes selected while the confirmation is readable is refused once the frame clips it away", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await stageNestedChange(d);

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the dirty left-bar click showed no discard confirmation");

  // Yes is chosen on a full, readable, written frame...
  highlightChoice(d, "Yes");

  // ...then the pane shrinks to three rows and that frame is replaced by one
  // that shows neither the whole message nor the chosen choice. The stored
  // selection may not be taken from a frame the operator cannot read.
  d.rows = 3;
  // The frame the operator now sees no longer carries the readable message and
  // its choices, which is the whole point: no Yes may come from it.
  assertNoConfirmation(d, "the clipped frame must not offer a readable confirmation");
  d.key(ENTER);
  await ticks();

  assert.deepEqual(d.since(), [], "a confirmation clipped out of the frame performs no action");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "a clipped refusal saves nothing");

  // Positive control: at a readable height again, the real menu still shows the
  // staged value, and a fresh written click is accepted. The clipped frame
  // renders the generic too-small pane, so it proves nothing about liveness.
  d.rows = PANE_ROWS;
  await returnToStagedChange(d);
  assert.deepEqual(d.since(), [], "returning to the staged menu activates nothing");
  await acceptFreshWrittenConfirmation(d);

  assert.deepEqual(d.since(), [{ type: "select", id: "keep-me" }],
    "the readable written confirmation answers Yes exactly once");
  assert.equal(d.paneKind(), "none", "the editor left");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "Yes discards: it never saves");
});

test("left-bar leave: a confirmation whose clicked card was replaced activates neither card and discards nothing", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await stageNestedChange(d);

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the dirty left-bar click showed no discard confirmation");
  // Yes is selected while the dialog still has its real target, so the attempt
  // below never depends on navigating an already-invalidated dialog.
  highlightChoice(d, "Yes");

  // The clicked card is gone and a DIFFERENT card now occupies that very
  // written coordinate, so a stale acceptance cannot quietly activate the
  // replacement either.
  d.sidebar.updateItems([card("replacement-card", "/synthetic/workspace")]);
  const replaced = d.roster();
  assert.ok((replaced[row] ?? "").includes("label-replacement-card"),
    `the replacement card sits at the clicked coordinate:\n${replaced.join("\n")}`);
  await ticks();
  // The Yes selection is already the old one. If invalidation reset it, try to
  // select it again, but a dialog that fences stale navigation is allowed to.
  if (showsDiscardConfirmation(d.pane()) && tryHighlightChoice(d, "Yes")) d.key(ENTER);
  await ticks();

  assert.deepEqual(d.since(), [],
    "neither the vanished card nor the card that replaced it at that coordinate is activated");
  // Retiring the confirmation the moment its target changed is a valid rejection;
  // what is not allowed is losing the editor or its staged change.
  await returnToStagedChange(d);
  assert.deepEqual(d.since(), [], "returning to the staged menu activates neither card");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "nothing is saved while the target is being refused");
});

// ---------------------------------------------------------------------------
// An edit typed into a field and never submitted is a change
// ---------------------------------------------------------------------------

test("left-bar leave: unsubmitted field text is a change; declining restores it exactly, accepting leaves without saving", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();

  // Three levels deep, in the sidebar's own shared text field.
  d.moveToMenuRow("Tools");
  d.key(ENTER);
  await d.waitForPane("the Tools submenu", (text) => text.includes("Web"));
  d.moveToMenuRow("Web");
  d.key(ENTER);
  await d.waitForPane("the Web submenu", (text) => text.includes("URL blocklist"));
  d.moveToMenuRow("URL blocklist");
  d.key(ENTER);
  await d.waitForPane("the shared text field", (text) => text.includes("Blocked URL patterns"));

  for (const character of TYPED_UNSUBMITTED) d.key(character);
  // Move the caret INSIDE the unsubmitted value: a field rebuilt with the same
  // text but a caret parked at the end must not pass the restoration checks.
  const endCursor = d.paneFrame().cursor;
  d.key(LEFT);
  const typedField = d.paneFrame();
  assert.ok(endCursor !== undefined && typedField.cursor !== undefined, "the field draws a caret");
  assert.notDeepEqual(typedField.cursor, endCursor, "the caret sits inside the unsubmitted text, not at its end");
  assert.ok(typedField.lines.join("\n").includes(TYPED_UNSUBMITTED),
    `the typed text is on screen:\n${typedField.lines.join("\n")}`);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA,
    "typing into the field saves nothing: the unsubmitted text lives only on the screen");

  const row = d.rosterRow("label-keep-me");

  // Decline with the highlighted No: the same field, drawn exactly as it was,
  // unsubmitted text and caret position included.
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assert.deepEqual(d.since(), [], "the unsubmitted edit confirms before anything is activated");
  assertConfirmation(d, "an unsubmitted field edit showed no discard confirmation");
  answerConfirmation(d, "No");
  await ticks();

  assert.deepEqual(d.since(), [], "declining activates nothing");
  assert.equal(d.paneKind(), "review-settings", "the editor stays open");
  assert.deepEqual(d.paneFrame(), typedField,
    "after No the field is restored exactly, unsubmitted text and caret position included");

  // Decline the same edit with Escape, and prove the same exact restoration.
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the second press is held too");
  await d.flush();
  assertConfirmation(d, "the second unsubmitted-edit click showed no discard confirmation");
  d.key(ESC);
  await ticks();

  assert.deepEqual(d.since(), [], "Escape answers No and activates nothing");
  assert.equal(d.paneKind(), "review-settings", "the editor stays open after Escape");
  assert.deepEqual(d.paneFrame(), typedField,
    "after Escape the field is restored exactly, unsubmitted text and caret position included");

  // Accept: the editor leaves, the row acts once, and nothing is ever saved.
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the third press is held too");
  await d.flush();
  assertConfirmation(d, "the third unsubmitted-edit click showed no discard confirmation");
  answerConfirmation(d, "Yes");
  await d.flush();

  assert.deepEqual(d.since(), [{ type: "select", id: "keep-me" }],
    "the accepted confirmation activates the clicked row exactly once");
  assert.equal(d.paneKind(), "none", "the editor left, with its field and its draft");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA,
    "the unsubmitted edit is discarded, never saved");
});

// ---------------------------------------------------------------------------
// The confirmation is modal until its answer is fully settled
// ---------------------------------------------------------------------------

const PASTE = "\x1b[200~pasted-in-the-same-batch\x1b[201~";

/** Tools -> Web -> URL blocklist, type the unsubmitted text, and park the caret inside it. */
async function openTypedBlocklistField(d: LeaveFixture): Promise<ReturnType<LeaveFixture["paneFrame"]>> {
  d.moveToMenuRow("Tools");
  d.key(ENTER);
  await d.waitForPane("the Tools submenu", (text) => text.includes("Web"));
  d.moveToMenuRow("Web");
  d.key(ENTER);
  await d.waitForPane("the Web submenu", (text) => text.includes("URL blocklist"));
  d.moveToMenuRow("URL blocklist");
  d.key(ENTER);
  await d.waitForPane("the shared text field", (text) => text.includes("Blocked URL patterns"));
  for (const character of TYPED_UNSUBMITTED) d.key(character);
  d.key(LEFT);
  const frame = d.paneFrame();
  assert.ok(frame.lines.join("\n").includes(TYPED_UNSUBMITTED), `the typed text is on screen:\n${frame.lines.join("\n")}`);
  return frame;
}

test("left-bar leave: keys and a paste in the same batch as No never reach the restored field before it is written", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  const typedField = await openTypedBlocklistField(d);

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the unsubmitted edit showed no discard confirmation");
  highlightChoice(d, "No");
  // The answer and more input arrive back to back, with no frame written in
  // between: the terminal still shows the confirmation for all of it.
  d.key(ENTER);
  d.key("z");
  d.key(PASTE);
  d.key(ENTER);
  await ticks();

  assert.deepEqual(d.since(), [], "declining activates nothing, and the trailing Enter submits nothing");
  assert.deepEqual(d.paneFrame(), typedField,
    "the restored field is exactly as it was: no key or paste from the unwritten frame reached it");
  // Positive control: once the restored field was written, a fresh key types.
  d.key("q");
  assert.ok(d.paneText().includes("q"), `a fresh key reaches the written field:\n${d.paneText()}`);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "nothing was saved");
});

test("left-bar leave: keys and a paste in the same batch as Yes cannot reach the field or refuse the leave", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await openTypedBlocklistField(d);

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the unsubmitted edit showed no discard confirmation");
  highlightChoice(d, "Yes");
  d.key(ENTER);
  d.key("z");
  d.key(PASTE);
  d.key(ENTER);
  // A fresh Escape (Cancel) queued behind the Yes cannot pre-empt the leave.
  d.key(ESC);
  await d.flush();

  assert.deepEqual(d.since(), [{ type: "select", id: "keep-me" }],
    "the accepted Yes leaves and activates the clicked row exactly once");
  assert.equal(d.paneKind(), "none", "the editor left, field and draft included");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "the suspended field was never submitted or saved");
});

test("left-bar leave: a physical Escape answers No even when Escape is bound to Confirm", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l, {
    keybindings: { "tui.select.confirm": ["enter", "escape"], "tui.select.cancel": "ctrl+x" },
  });
  await d.openReviewSettings();
  await stageNestedChange(d);
  const nested = d.pane();

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the dirty left-bar click showed no discard confirmation");
  highlightChoice(d, "Yes");
  d.key(ESC);
  await ticks();

  assert.deepEqual(d.since(), [], "Escape never confirms the discard");
  assert.equal(d.paneKind(), "review-settings", "the editor stays open");
  assert.deepEqual(d.pane(), nested, "the declined screen comes back exactly");
  assert.match(d.paneText(), STAGED_NOTICE_OFF, "the staged nested change is still staged");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "nothing was discarded into a save");
});

test("left-bar leave: declining returns to the open notice reader at the same position", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  const typedField = await openTypedBlocklistField(d);
  assert.match(typedField.lines.join("\n"), /ctrl\+o read all/, "the field's long notice is clipped and offers its reader");

  d.key("\x0f");
  const top = d.paneFrame();
  d.key(DOWN);
  d.key(DOWN);
  const reader = d.paneFrame();
  assert.notDeepEqual(reader, top, "the reader scrolled away from its top");
  assert.ok(!reader.lines.join("\n").includes(TYPED_UNSUBMITTED), "the reader covers the field");

  const row = d.rosterRow("label-keep-me");
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the session-card press is held for its release");
  await d.flush();
  assertConfirmation(d, "the unsubmitted edit under the reader showed no discard confirmation");
  answerConfirmation(d, "No");
  // Queued behind the answer, before the restored reader is written: neither
  // may scroll or close it.
  d.key(DOWN);
  d.key(ESC);
  await ticks();

  assert.deepEqual(d.since(), [], "declining activates nothing");
  assert.deepEqual(d.paneFrame(), reader, "the same reader comes back at the same scroll position");
  d.key(ESC);
  await ticks();
  assert.deepEqual(d.paneFrame(), typedField, "leaving the reader returns to the same field, text and caret included");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "nothing was saved");
});

test("left-bar leave: a second decline after navigating deeper fences the newly restored screen, not the old one", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await stageNestedChange(d);
  const row = d.rosterRow("label-keep-me");

  // First decline, on Tools, and its restored frame is written.
  d.mark();
  assert.equal(d.pressAndReleaseCard(row).held, true, "the first press is held for its release");
  await d.flush();
  assertConfirmation(d, "the first dirty click showed no discard confirmation");
  answerConfirmation(d, "No");
  await ticks();
  assert.match(d.paneText(), STAGED_NOTICE_OFF, "the first decline restored Tools with its staged change");

  // Enter Web and write that frame; no key reaches Web before the next click.
  d.moveToMenuRow("Web");
  d.key(ENTER);
  await d.waitForPane("the Web submenu", (text) => text.includes("URL blocklist"));
  const web = d.pane();

  // Second decline, with an Escape queued before any redraw.
  assert.equal(d.pressAndReleaseCard(row).held, true, "the second press is held for its release");
  await d.flush();
  assertConfirmation(d, "the second dirty click showed no discard confirmation");
  answerConfirmation(d, "No");
  d.key(ESC);
  await ticks();

  assert.deepEqual(d.since(), [], "neither decline activates anything");
  assert.deepEqual(d.pane(), web, "the first returned frame is still the Web submenu: the queued Escape was fenced");
  // Positive control: once Web is written, a fresh Escape goes Back normally.
  d.key(ESC);
  await d.waitForPane("Tools after Back from Web", (text) => STAGED_NOTICE_OFF.test(text) && !text.includes("URL blocklist"));
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "nothing was saved");
});

// ---------------------------------------------------------------------------
// The keyboard exits the operator already has stay exactly as they are
// ---------------------------------------------------------------------------

test("left-bar leave: nested Back, root Escape, and Cancel still discard without saving [GUARD]", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const d = leaveFixture(t, l);
  await d.openReviewSettings();
  await stageNestedChange(d);

  // Nested Back navigates only, and keeps this visit's draft staged: re-entering
  // Tools still shows the staged value, and nothing was written on the way.
  d.key(ESC);
  await d.waitForPane("the root menu after Back", (text) => text.includes("→ Tools"));
  d.moveToMenuRow("Tools");
  d.key(ENTER);
  await d.waitForPane("the Tools submenu after Back", (text) => /YouShouldKnow notices\s+Off/.test(text));
  assert.match(d.paneText(), /YouShouldKnow notices\s+Off/, "nested Back keeps the staged draft");
  d.key(ESC);
  await d.waitForPane("the root menu again", (text) => text.includes("→ Tools"));
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "nested Back writes nothing");

  // A held root Escape never replays; a fresh one leaves and discards.
  d.key(`${ESC}[27;1:2u`);
  d.key(`${ESC}[27;1:3u`);
  assert.match(d.paneText(), /→ Tools/, "the held Escape did not close the root");
  d.key(ESC);
  await d.waitForPane("the Settings submenu", (text) => text.includes("> Review settings"));
  assert.equal(d.paneKind(), "settings", "root Escape returns to the Settings submenu");
  await d.flush();
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "root Escape leaves disk A");

  // Cancel discards the same way on a fresh open.
  d.key(ENTER);
  await d.waitForPane("the reopened root menu", (text) => text.includes("→ Operating mode"));
  d.moveToMenuRow("Cancel");
  d.key(ENTER);
  await d.waitForPane("the Settings submenu after Cancel", (text) => text.includes("> Review settings"));
  await d.flush();
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "Cancel leaves disk A");
});

// ---------------------------------------------------------------------------
// Production routing: raw SGR left press and release through the real Main
// ---------------------------------------------------------------------------

test("left-bar leave: a raw left press and release on another roster row leaves the clean editor and performs that row's action", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const l = owned(t);
  const bytesA = writeConfig(l.canonical, DISK_A);
  const agentDir = makeMainTestDirectory("rs723-leave-agent");
  writeFileSync(join(agentDir, "keybindings.json"), "{}", "utf8");
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  // The Main harness resolves this host's own config target from its agent dir.
  const harness: Harness = createHarness({ env: { PATH: process.env.PATH, HOME: l.home, USERPROFILE: l.home } }, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("the synthetic harness prepares no profile"); } },
    }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({
      status: "opened",
      state: {
        agentDir: ownedDir, hostId, ownershipPath: join(ownedDir, "synthetic-owner"),
        roster: undefined, problem: undefined, persist: () => true, release: () => true,
      },
    }),
    openLocalReviewSettings: (input) => openLocalReviewSettings(input, { loadChoices: async () => fakeCatalog() }),
  });
  t.after(async () => { await closeWithSignal(harness); });
  const canonical = join(agentDir, "review-gate.json");
  const written = writeConfig(canonical, DISK_A);

  await ready(harness);
  await nextTurn();
  const frame = (): string => plain(harness.writer.frames.at(-1)?.frame);
  const mainMoveTo = async (pattern: RegExp, what: string): Promise<void> => {
    for (let step = 0; step < 60; step += 1) {
      if (frame().split("\n").some((line) => pattern.test(line))) return;
      harness.terminal.emitInput(DOWN);
      await nextTurn();
    }
    assert.fail(`Main never highlighted ${what}:\n${frame()}`);
  };

  await mainMoveTo(/> Settings/, "Settings");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await mainMoveTo(/> Review settings/, "Review settings");
  harness.terminal.emitInput(ENTER);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!frame().includes("→ Operating mode")) {
    assert.ok(Date.now() < deadline, `Main never showed the shared root menu:\n${frame()}`);
    await delay(2);
  }
  assert.ok(frame().includes("Review settings (local)"), "the real Main owns the open editor");
  assert.equal(harness.sidebar?.focus, "form", "the Review settings pane owns the form slot");

  // One real left click: an SGR press and its matching release on the row the
  // written frame actually drew beside the editor.
  const savedRow = frame().split("\n").findIndex((line) => line.includes("Saved conversations"));
  assert.ok(savedRow > 0, `the written frame drew no Saved row:\n${frame()}`);
  emitMouse(harness.terminal, 3, savedRow, 0, "M");
  emitMouse(harness.terminal, 3, savedRow, 0, "m");
  await nextTurn();
  await nextTurn();

  assert.equal(harness.sidebar?.focus, "form", "the clicked row opened its own pane");
  assert.ok(!frame().includes("Review settings (local)"),
    "the raw click left Review settings: its pane is really off the screen");
  assert.ok(frame().includes("No saved conversations"),
    "the clicked row performed its ordinary action: its own Saved picker is on screen");
  assert.ok(!frame().includes("theme:"), "the Settings submenu was not re-shown in its place");
  assert.equal(readFileSync(canonical, "utf8"), written, "a clean leave through Main never writes the config");
});
