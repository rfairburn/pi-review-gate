/**
 * #419: Escape ownership for the `/review-settings` transaction on the actual
 * installed Pi 1.5.0 runtime.
 *
 * Real host objects, no copied dispatcher: a fixture terminal hands its
 * `terminal.start` callback to the host's own `TuiMainScreen`, so every key
 * below travels Pi's real input path (extension raw listeners first, then the
 * focused component), and `InteractiveMode.createExtensionUIContext()` supplies
 * the production `custom()` slot, editor-slot dialog stack, and focus
 * handling. The settings menus are built from the REAL installed pi-tui
 * `SelectList`/`Container`/`Text` plus the agent's `DynamicBorder`, with the
 * live `KeybindingsManager`. Production code under test:
 * `registerReviewSettings` and the whole settings menu transaction,
 * `registerCommands`, `createReviewTurnCoordinator`, and the review
 * abort/cancellation paths. Settings surfaces exercised here include the menus
 * and pickers and the host confirmation dialog opened from a settings menu
 * (browser-YOLO enablement), which the host puts in the editor slot rather than
 * a custom component.
 *
 * Fixtures are limited to terminal IO, the config file, the synthetic Git
 * workspace, and one controlled reviewer child (`node -e` writing its pid and
 * waiting for a release file). No model/provider call, no private corpus, no
 * installed-runtime patch. This is headless native input dispatch, not a
 * physical-keyboard or platform certification.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { beginAgentRun, createState, rememberUserRequest, snapshotReviewBaseline } from "../src/state";
import { recordToolCallEvidence, recordToolResultEvidence } from "../src/evidence";
import { createReviewTurnCoordinator } from "../src/activation/review-turn";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import { registerCommands } from "../src/commands";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import { registerUserQuestions, userQuestionsBeginSession } from "../src/user-question";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";
import { setNativeEditorHost, __resetActiveNativeEditorFieldForTest } from "../src/native-editor-bridge";
import { loadRealBridgeHost, REAL_IDENTITY_THEME, skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDirs, loadRealMenuTuiHost } from "./menu-tui-fakes";
import { fakeNeedsChangesConfig } from "./helpers";

const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

type Fixture = NonNullable<Awaited<ReturnType<typeof fixture>>>;

async function until(label: string, probe: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await probe()) {
    assert.ok(Date.now() < deadline, `bounded fixture readiness timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** Bounded teardown race: cleanup must never mask where a body actually hung. */
async function bounded(promise: Promise<unknown> | undefined, ms = 2000): Promise<void> {
  if (!promise) return;
  await Promise.race([promise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ms))]);
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** The live Pi 1.5.0 interactive host plus the registered review-gate surface. */
async function fixture(t: Parameters<typeof skipOrFail>[0], root: string) {
  const real = await loadRealBridgeHost();
  if (!real) { skipOrFail(t, "no installed Pi is resolvable in this environment"); return undefined; }
  const menuHost = await loadRealMenuTuiHost();
  if (!menuHost) { skipOrFail(t, "the installed pi-tui menu components are not resolvable"); return undefined; }
  const agentRoot = findInstalledAgentDirs()[0]!;
  const requireHost = createRequire(join(agentRoot, "package.json"));
  const manifest = requireHost("./package.json");
  if (manifest.version !== "1.5.0") { skipOrFail(t, "this ownership regression requires Pi 1.5.0"); return undefined; }
  const { InteractiveMode } = requireHost("./dist/modes/interactive/interactive-mode.js");
  const themeModule = requireHost("./dist/modes/interactive/theme/theme.js");
  themeModule.setThemeInstance(REAL_IDENTITY_THEME);
  // The production settings renderer builds its menus from these real
  // components; injecting the resolved host is the same seam a Pi install
  // feeds it through production peer loading.
  setMenuTuiHost(menuHost);
  const tui = real.tui as Record<string, any>;
  let dispatch!: (data: string) => void;
  const terminal = {
    columns: 100, rows: 36,
    start(input: typeof dispatch) { dispatch = input; }, stop() {}, write() {},
    hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
  };
  const screen = new tui.TuiMainScreen(terminal, false, root);
  const agent = requireHost("./dist/index.js");
  const { KeybindingsManager } = requireHost("./dist/core/keybindings.js");
  const keybindings = new KeybindingsManager({});
  tui.setKeybindings(keybindings);
  const mode = Object.create(InteractiveMode.prototype);
  mode.ui = screen;
  mode.keybindings = keybindings;
  // Object.create skips InteractiveMode's class-field initializers; the host
  // paths exercised here (showExtensionCustom, the dialog stack, extension
  // terminal-input subscriptions) read that constructor-owned state.
  mode.extensionDialogs = [];
  mode.extensionTerminalInputSubscriptions = new Set();
  // showTopExtensionDialog reports the dialog stack's blocking state; the
  // stand-in only has to accept the call the real host makes on every slot
  // open and close.
  mode.programStatus = { setBlocked: () => {} };
  mode.editorContainer = new tui.Container();
  mode.defaultEditor = new agent.CustomEditor(screen, themeModule.getEditorTheme(), keybindings);
  mode.editor = mode.defaultEditor;
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "one.md"), "one");
  mode.autocompleteProvider = new tui.CombinedAutocompleteProvider([], root, process.env.PI_REVIEW_GATE_FD ?? null);
  mode.defaultEditor.setAutocompleteProvider(mode.autocompleteProvider);
  mode.editor.setText("independent chat draft");
  let hostEscapes = 0;
  mode.defaultEditor.onEscape = () => { hostEscapes++; };
  mode.defaultEditor.onAction("app.clear", () => mode.clearEditor());
  mode.editorContainer.addChild(mode.editor);
  screen.addChild(mode.editorContainer);
  screen.setFocus(mode.editor);
  screen.start();
  setNativeEditorHost(real.host);
  setUserQuestionTuiHost({
    matchesKey: tui.matchesKey, visibleWidth: tui.visibleWidth,
    truncateToWidth: tui.truncateToWidth, wrapTextWithAnsi: tui.wrapTextWithAnsi,
  });
  const notices: string[] = [];
  const sent: string[] = [];
  const shortcuts = new Map<string, { handler(ctx: unknown): Promise<void> }>();
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const hooks = new Map<string, Array<() => void>>();
  const pi = {
    registerTool() {},
    registerShortcut(key: string, value: { handler(ctx: unknown): Promise<void> }) { shortcuts.set(key, value); },
    registerCommand(key: string, value: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(key, value); },
    on(key: string, handler: () => void) { hooks.set(key, [...(hooks.get(key) ?? []), handler]); },
    sendUserMessage(message: string) { sent.push(message); },
  };
  const sessionManager = {};
  // Pi hands a fresh ui object to every command and shortcut press; keep the
  // real createExtensionUIContext seams (custom, onTerminalInput, editor) in
  // each one, plus the scoped models the settings reviewer picker lists.
  const context = () => ({
    sessionManager, mode: "tui", isIdle: () => true, cwd: root,
    scopedModels: [{ model: { provider: "fixture", id: "model-a", reasoning: true, thinkingLevelMap: {} } }],
    ui: { ...mode.createExtensionUIContext(),
      notify(message: string) { notices.push(message); }, setStatus() {}, setWidget() {},
    },
  });
  const questionSurface = registerUserQuestions(pi)!;
  questionSurface.setInteractiveUi(true);
  questionSurface.noteContext(context());
  userQuestionsBeginSession(questionSurface.controller, sessionManager);
  return {
    screen, mode, context, pi, commands, hooks, sessionManager, notices, sent, questionSurface,
    dispatch: (data: string) => dispatch(data),
    focused: () => (screen as unknown as { getFocusedComponent(): unknown }).getFocusedComponent(),
    hostEscapes: () => hostEscapes,
    openQuestions: () => shortcuts.get("ctrl+alt+up")!.handler(context()),
    openSettings: () => {
      const command = commands.get("review-settings");
      assert.ok(command, "registerReviewSettings must register /review-settings");
      return command.handler("", context());
    },
    close: () => {
      for (const hook of hooks.get("session_shutdown") ?? []) hook();
      questionSurface.controller.endSession();
      // Retire listeners, then let the native stale-component path close any
      // still-open custom interaction even after a failed assertion.
      mode.clearExtensionTerminalInputListeners();
      for (let level = 0; level < 8; level += 1) dispatch(KEY_ESCAPE);
      screen.stop();
      setMenuTuiHost(undefined);
      setNativeEditorHost(undefined); setUserQuestionTuiHost(undefined); __resetActiveNativeEditorFieldForTest();
    },
  };
}

/** The focused component's own rendered frame (the real settings menu). */
function frame(f: Fixture): string {
  const component = f.focused() as { render?(width: number): string[] } | null;
  return typeof component?.render === "function" ? component.render(120).join("\n") : "";
}

/** True when a component other than the host chat editor holds input. */
function settingsForeground(f: Fixture): boolean {
  const component = f.focused();
  return component !== null && component !== undefined && component !== f.mode.editor;
}

/** The settings menu's own title line, rendered above its rows. */
function menuTitle(f: Fixture): string {
  return (frame(f).split("\n")[0] ?? "").trim();
}

/** True when the focused settings frame matches (aligned labels use two spaces). */
function frameMatches(f: Fixture, pattern: RegExp): boolean {
  return pattern.test(frame(f));
}

/** Highlight one settings row by its label, exactly as a user arrows to it. */
function focusRow(f: Fixture, label: string): void {
  for (let press = 0; press < 30; press += 1) {
    if (frame(f).split("\n").some((line) => line.includes("→") && line.includes(label))) return;
    f.dispatch(KEY_DOWN);
  }
  throw new Error(`settings row "${label}" was never highlighted:\n${frame(f)}`);
}

function noCancellation(f: Fixture, what: string): void {
  assert.doesNotMatch(f.notices.join("\n"), /cancelling|cancelled/, `${what} must not touch the review`);
}

/**
 * One real review over a synthetic Git workspace, driven through the
 * production command/coordinator registration with a controlled external
 * reviewer child that stays alive until `releasePath` appears.
 */
async function createReviewHarness(input: {
  f: Fixture;
  root: string;
  config: ReviewGateConfig;
  state: ReturnType<typeof createState>;
  cancellation: ReturnType<typeof createReviewCancellationCoordinator>;
  path: "automatic" | "command";
}) {
  const { f, root, config, state, cancellation, path } = input;
  const snapshotOptions = { maxFileBytes: 1048576, maxSnapshotBytes: 52428800 };
  const pidPath = join(root, "pid");
  const releasePath = join(root, "release");
  const reviewer = [
    "const fs=require('node:fs');process.stdin.resume();",
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
    `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);process.stdout.write(JSON.stringify({verdict:'pass',summary:'real controlled verdict',findings:[]}));}},10);`,
  ].join("");
  config.externalAgents = {
    controlled: { adapter: "generic-cli", command: process.execPath, args: [], review: { args: ["-e", reviewer], timeoutMs: 30000 } },
  };
  config.review = { activeReviewers: [{ source: "external", id: "controlled" }] };
  registerCommands({ pi: f.pi, cwd: () => root, config, state, cancellation });
  registerReviewSettings({ pi: f.pi, config, configPath: join(root, "review-gate.json"), onScopedModels: () => {} });
  const coordinator = createReviewTurnCoordinator({
    pi: f.pi, state, config, cancellation, scopedModels: () => [], isSessionActive: () => true,
    observeCwd() {}, cwd: () => root, syncExecutionContext() {}, checkpointRestartBlocked: () => undefined,
    effectiveReviewConfig: () => config, persist: async () => {}, persistAutomaticDelivery: async () => true,
    backgroundShell: () => undefined, reviewReadiness: () => [], reapplyDeferredTools() {},
    orchestratorTurns: { hasRunsInFlight: () => false, noteMessageObserved: () => false, noteMessageArmingFailed() {} },
  });

  // Own fixture repository: ancestor checkout ignore rules must not hide this
  // file when TMPDIR is an ignored in-checkout directory.
  await exec("git", ["init", root]);
  await writeFile(join(root, "index.ts"), "before\n");
  rememberUserRequest(state, "change index");
  const window = state.reviewWindow!;
  window.baseline = snapshotReviewBaseline(await createWorkspaceSnapshot(root, snapshotOptions));
  const baseline = window.baseline;
  const write = { toolName: "write", toolInput: { path: "index.ts", content: "after\n" } };
  // Automatic review requires agent tool activity: model the agent's write
  // tool around the actual write. The command path stays an intentionally
  // filesystem-only control.
  let exchangeSequence: number | undefined;
  if (path === "automatic") {
    beginAgentRun(state);
    exchangeSequence = window.activeExchange!.sequence;
    await recordToolCallEvidence({ state: window.evidence, cwd: root, ...write, snapshotOptions, exchangeSequence });
  }
  await writeFile(join(root, "index.ts"), "after\n");
  if (path === "automatic") {
    recordToolResultEvidence({ state: window.evidence, ...write, result: { content: [{ type: "text", text: "Wrote index.ts" }] }, exchangeSequence });
  }

  const start = (): Promise<void> => {
    const pending = path === "automatic"
      ? coordinator.onAgentSettled([f.context()])
      : f.commands.get("review-now")!.handler("", f.context());
    return pending;
  };
  const launch = async () => {
    const pending = start();
    await until("reviewer child pid file", () => exists(pidPath));
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.equal(alive(pid), true, "the controlled reviewer child really launched");
    return { pid, pending };
  };
  return { window, baseline, releasePath, launch };
}

/** The nested Reviewers → model-choices walk, then one staged toggle. */
async function walkSettingsMenus(f: Fixture): Promise<void> {
  await until("settings root frame", () => frame(f).includes("Review settings"));
  focusRow(f, "Reviewers");
  f.dispatch(KEY_ENTER);
  await until("review submenu", () => frame(f).includes("Automatic primary review"));
  focusRow(f, "Primary reviewers");
  f.dispatch(KEY_ENTER);
  await until("model picker", () => frame(f).includes("Enter toggles"));
  assert.match(frame(f), /model-a \[fixture\]/, "the real model choice is listed");
  focusRow(f, "model-a [fixture]");
  // Back out of the model/selection control without changing any choice.
  f.dispatch(KEY_ESCAPE);
  await until("review submenu", () => frame(f).includes("Automatic primary review"));
  // One staged choice for the root-apply assertion; the running review has
  // already captured its own inputs independently of this draft.
  focusRow(f, "Automatic subtask review");
  f.dispatch(KEY_ENTER);
  await until("staged subtask toggle", () => frameMatches(f, /Automatic subtask review\s+Off/));
  // Back from the nested submenu to the settings root (navigation only).
  f.dispatch(KEY_ESCAPE);
  await until("settings root again", () => frameMatches(f, /Review settings/));
}

for (const path of ["automatic", "command"] as const) {
  const orders = path === "automatic"
    ? (["review-first", "settings-first"] as const)
    : (["review-first"] as const);
  for (const order of orders) {
    for (const outcome of ["verdict", "cancel"] as const) {
      test(
        `Pi 1.5 ${path} review (${order}): settings nested/model/root Escape survives to the ${outcome}`,
        { timeout: 30000 },
        async (t) => {
          const root = await mkdtemp(join(tmpdir(), "prg-settings-escape-"));
          const f = await fixture(t, root);
          if (!f) { await rm(root, { recursive: true, force: true }); return; }
          const cancellation = createReviewCancellationCoordinator();
          const state = createState();
          const config = normalizeConfig(fakeNeedsChangesConfig());
          let pendingReview: Promise<void> | undefined;
          let settings: Promise<void> | undefined;
          try {
            await writeFile(join(root, "review-gate.json"), "{}\n");
            const configOnDiskBefore = await readFile(join(root, "review-gate.json"), "utf8");
            const harness = await createReviewHarness({ f, root, config, state, cancellation, path });
            let review = order === "review-first" ? await harness.launch() : undefined;
            settings = f.openSettings();
            await until("settings foreground", () => settingsForeground(f));
            if (!review) {
              // The reported shape: the automatic review starts while the
              // settings UI already holds the foreground, so its abort
              // listener registers AFTER the settings menu publishes.
              review = await harness.launch();
              assert.ok(settingsForeground(f), "launching the review did not take the settings foreground");
            }

            await walkSettingsMenus(f);
            if (review) {
              assert.equal(alive(review.pid), true, "every settings Escape left the reviewer child running");
              noCancellation(f, "a nested settings Escape");
            }

            // The root exit is the settings transaction's own session-only
            // apply; it completes without waiting for the reviewer.
            f.dispatch(KEY_ESCAPE);
            await settings;
            settings = undefined;
            assert.equal(f.focused(), f.mode.editor, "the host editor is foreground again");
            assert.match(f.notices.join("\n"), /applied for this session \(not saved to disk\)/);
            assert.equal(await readFile(join(root, "review-gate.json"), "utf8"), configOnDiskBefore,
              "the session-only apply wrote nothing to disk");
            assert.equal(config.review?.subtaskEnabled, false, "the staged choice applied for this session");
            noCancellation(f, "the settings root Escape");

            const activeReview = cancellation.current();
            assert.ok(activeReview, "the review is still the active, uncancelled review");
            assert.equal(alive(review.pid), true, "the reviewer child is still running after the settings UI closed");
            assert.equal(state.reviewWindow, harness.window);
            assert.equal(harness.window.baseline, harness.baseline, "the captured baseline is untouched");
            assert.equal(f.hostEscapes(), 0, "raw consumption never exposed these Escapes to the host editor");

            if (outcome === "cancel") {
              // A separate press, with no settings UI owning input, is
              // ordinary explicit cancellation, and the completion notice
              // waits for positive settlement of the real child.
              f.dispatch(KEY_ESCAPE);
              assert.match(f.notices.join("\n"), /cancelling.*waiting for reviewer processes to stop/);
              assert.doesNotMatch(f.notices.join("\n"), /reviewer processes stopped/);
              await writeFile(harness.releasePath, "pass");
              pendingReview = review.pending;
              await pendingReview;
              await until("reviewer child exit", () => !alive(review!.pid));
              assert.match(f.notices.join("\n"), /review cancelled; reviewer processes stopped/);
              assert.equal(f.sent.length, 0, "a cancelled review delivers no verdict");
              assert.equal(harness.window.baseline, harness.baseline);
              assert.equal(cancellation.current(), undefined);
            } else {
              // The intended review keeps running and delivers its real
              // verdict; nothing about the menu Escape bypassed or faked it.
              await writeFile(harness.releasePath, "pass");
              pendingReview = review.pending;
              await pendingReview;
              await until("reviewer child exit", () => !alive(review!.pid));
              assert.match(f.notices.join("\n"), /review gate: passed/);
              assert.equal(harness.window.reviewHistory.at(-1)?.verdict, "pass");
              assert.match(f.sent.join("\n"), /Gate verdict: pass/);
              assert.equal(f.hostEscapes(), 0);
            }
          } finally {
            cancellation.current()?.requestCancel("manual");
            await bounded(pendingReview);
            f.close();
            await bounded(settings);
            await rm(root, { recursive: true, force: true });
          }
        },
      );
    }
  }
}

for (const outcome of ["verdict", "cancel"] as const) {
  test(
    `Pi 1.5 settings YOLO confirmation: Escape cancels the dialog, YOLO stays Off, review reaches the ${outcome}`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "prg-settings-escape-yolo-"));
      const f = await fixture(t, root);
      if (!f) { await rm(root, { recursive: true, force: true }); return; }
      const cancellation = createReviewCancellationCoordinator();
      const state = createState();
      const config = normalizeConfig(fakeNeedsChangesConfig());
      let pendingReview: Promise<void> | undefined;
      let settings: Promise<void> | undefined;
      try {
        await writeFile(join(root, "review-gate.json"), "{}\n");
        const harness = await createReviewHarness({ f, root, config, state, cancellation, path: "automatic" });
        const review = await harness.launch();
        pendingReview = review.pending;
        settings = f.openSettings();
        await until("settings foreground", () => settingsForeground(f));

        // Tools → Web → Browser permissions → the YOLO row (Off), which opens
        // the host confirmation DIALOG (ui.confirm, not ui.custom).
        focusRow(f, "Tools");
        f.dispatch(KEY_ENTER);
        await until("the Tools menu", () => menuTitle(f) === "Tools");
        focusRow(f, "Web");
        f.dispatch(KEY_ENTER);
        await until("the Web settings menu", () => menuTitle(f) === "Web settings");
        focusRow(f, "Browser permissions");
        f.dispatch(KEY_ENTER);
        await until("the browser permissions menu", () => menuTitle(f) === "Browser permissions");
        focusRow(f, "YOLO / allow everything");
        f.dispatch(KEY_ENTER);
        await until("the YOLO confirmation dialog", () => frameMatches(f, /Enable YOLO \/ allow everything\?/));
        const dialog = f.focused();
        assert.notEqual(dialog, f.mode.editor, "the host dialog holds the foreground");

        // Escape is the dialog's own cancel binding: it declines, YOLO stays
        // Off, and neither review aborter sees the press.
        f.dispatch(KEY_ESCAPE);
        assert.doesNotMatch(frame(f), /Enable YOLO/, "the confirmation dismissed itself");
        await until("the existing decline notice", () => /YOLO stays Off\./.test(f.notices.join("\n")));
        noCancellation(f, "the settings confirmation Escape");
        assert.equal(alive(review.pid), true, "the reviewer child is untouched by the confirmation Escape");
        assert.equal(config.web?.browserPermissions?.yolo, false, "YOLO stayed Off");
        await until("back at the browser permissions menu", () => menuTitle(f) === "Browser permissions");

        // Back out through each level and take the root exit; every press is a
        // settings action, and closing the menu never waits for the review.
        for (const [label, marker] of [
          ["the Web settings menu", "Web settings"],
          ["the Tools menu", "Tools"],
          ["the settings root", "Review settings"],
        ] as const) {
          f.dispatch(KEY_ESCAPE);
          await until(label, () => menuTitle(f) === marker);
        }
        f.dispatch(KEY_ESCAPE);
        await settings;
        settings = undefined;
        assert.match(f.notices.join("\n"), /applied for this session \(not saved to disk\)/);
        noCancellation(f, "the settings root exit after the confirmation");
        assert.equal(config.web?.browserPermissions?.yolo, false, "the session apply kept YOLO Off");
        assert.equal(alive(review.pid), true);
        assert.equal(state.reviewWindow, harness.window);
        assert.equal(harness.window.baseline, harness.baseline);
        assert.equal(f.hostEscapes(), 0, "no settings press reached the host editor path");

        if (outcome === "cancel") {
          // Independent later cancellation, with positive child settlement.
          f.dispatch(KEY_ESCAPE);
          assert.match(f.notices.join("\n"), /cancelling.*waiting for reviewer processes to stop/);
          await writeFile(harness.releasePath, "pass");
          await pendingReview;
          await until("reviewer child exit", () => !alive(review.pid));
          assert.match(f.notices.join("\n"), /review cancelled; reviewer processes stopped/);
          assert.equal(f.sent.length, 0);
        } else {
          // The intended review delivers its real verdict unchanged.
          await writeFile(harness.releasePath, "pass");
          await pendingReview;
          await until("reviewer child exit", () => !alive(review.pid));
          assert.match(f.notices.join("\n"), /review gate: passed/);
          assert.equal(harness.window.reviewHistory.at(-1)?.verdict, "pass");
          assert.match(f.sent.join("\n"), /Gate verdict: pass/);
        }
      } finally {
        cancellation.current()?.requestCancel("manual");
        await bounded(pendingReview);
        f.close();
        await bounded(settings);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  "Pi 1.5: a popup overlay above an open settings menu keeps its own Escape and hands ownership back",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "prg-settings-escape-overlay-"));
    const f = await fixture(t, root);
    if (!f) { await rm(root, { recursive: true, force: true }); return; }
    const cancellation = createReviewCancellationCoordinator();
    const state = createState();
    const config = normalizeConfig(fakeNeedsChangesConfig());
    let pendingReview: Promise<void> | undefined;
    let settings: Promise<void> | undefined;
    try {
      await writeFile(join(root, "review-gate.json"), "{}\n");
      const harness = await createReviewHarness({ f, root, config, state, cancellation, path: "automatic" });
      const review = await harness.launch();
      pendingReview = review.pending;
      settings = f.openSettings();
      await until("settings foreground", () => settingsForeground(f));
      const settingsComponent = f.focused();
      assert.ok(f.questionSurface.controller.registerNotice({ toolCallId: "n", title: "Notice", body: "Full body" }, f.sessionManager).ok);
      const popup = f.openQuestions();
      await until("popup overlay", () => f.screen.hasOverlay());
      assert.notEqual(f.focused(), settingsComponent, "the overlay took foreground from the settings menu");

      // The popup keeps its existing back/close behavior and the press never
      // reaches the review: the settings menu underneath does not claim an
      // Escape over a focused overlay, and the overlay is what dismissed.
      f.dispatch(KEY_ESCAPE);
      assert.equal(f.screen.hasOverlay(), false, "the popup's own cancel binding closed the overlay");
      assert.equal(f.focused(), settingsComponent, "the closed overlay hands foreground back to the settings menu");
      noCancellation(f, "a popup Escape over an open settings menu");
      assert.equal(alive(review.pid), true);

      // The settings menu owns Escape again: its root exit is a menu action.
      f.dispatch(KEY_ESCAPE);
      await settings;
      settings = undefined;
      assert.match(f.notices.join("\n"), /applied for this session \(not saved to disk\)/);
      noCancellation(f, "the settings root Escape under a dismissed popup");
      assert.equal(alive(review.pid), true);

      // With nothing but the editor in the foreground, a separate press
      // cancels for real, with positive settlement of the child.
      f.dispatch(KEY_ESCAPE);
      assert.match(f.notices.join("\n"), /cancelling.*waiting for reviewer processes to stop/);
      await writeFile(harness.releasePath, "pass");
      await pendingReview;
      await until("reviewer child exit", () => !alive(review.pid));
      assert.match(f.notices.join("\n"), /review cancelled; reviewer processes stopped/);
      assert.equal(f.sent.length, 0);
      await popup;
    } finally {
      cancellation.current()?.requestCancel("manual");
      await bounded(pendingReview);
      f.close();
      await bounded(settings);
      await rm(root, { recursive: true, force: true });
    }
  },
);
