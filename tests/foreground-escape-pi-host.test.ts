/**
 * #387: actual installed Pi 1.3 terminal.start → raw listener Set → focused
 * overlay dispatch, with production popup, automatic settlement and commands.
 * Only the terminal IO, persistence and model-independent reviewer are fixtures.
 * No agent prompt/provider is invoked and no installed runtime is patched.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { createWorkspaceSnapshot } from "../src/capture";
import { publishForegroundEscape, routeForegroundEscape } from "../src/foreground-escape";
import { beginAgentRun, createState, rememberUserRequest, snapshotReviewBaseline } from "../src/state";
import { recordToolCallEvidence, recordToolResultEvidence } from "../src/evidence";
import { createReviewTurnCoordinator } from "../src/activation/review-turn";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import { registerCommands } from "../src/commands";
import { registerUserQuestions, userQuestionsBeginSession } from "../src/user-question";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";
import { setNativeEditorHost, __resetActiveNativeEditorFieldForTest } from "../src/native-editor-bridge";
import { loadRealBridgeHost, REAL_IDENTITY_THEME, skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { fakeNeedsChangesConfig } from "./helpers";

async function until(probe: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await probe()) {
    assert.ok(Date.now() < deadline, "bounded fixture readiness timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

// Runtime objects are intentionally structural: this test loads the exact host
// designated by the existing required-host test seam, not a compile-time peer.
async function fixture(t: Parameters<typeof skipOrFail>[0], root: string) {
  const real = await loadRealBridgeHost();
  if (!real) { skipOrFail(t, "no installed Pi is resolvable in this environment"); return undefined; }
  const agentRoot = findInstalledAgentDirs()[0]!;
  const requireHost = createRequire(join(agentRoot, "package.json"));
  const manifest = requireHost("./package.json");
  if (manifest.version !== "1.4.0") { skipOrFail(t, "this dispatch regression requires Pi 1.4.0"); return undefined; }
  const { InteractiveMode } = requireHost("./dist/modes/interactive/interactive-mode.js");
  const themeModule = requireHost("./dist/modes/interactive/theme/theme.js");
  themeModule.setThemeInstance(REAL_IDENTITY_THEME);
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
  mode.extensionTerminalInputSubscriptions = new Set();
  mode.editorContainer = new tui.Container();
  mode.defaultEditor = new agent.CustomEditor(screen, themeModule.getEditorTheme(), keybindings);
  mode.editor = mode.defaultEditor;
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "one.md"), "one");
  await writeFile(join(root, "docs", "two.md"), "two");
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
  // Pi supplies fresh ui objects to each event and shortcut press. Preserve the
  // real createExtensionUIContext listener/custom/editor seams in each of them.
  const context = () => ({
    sessionManager, mode: "tui", isIdle: () => true,
    ui: { ...mode.createExtensionUIContext(),
      notify(message: string) { notices.push(message); }, setStatus() {}, setWidget() {},
    },
  });
  const surface = registerUserQuestions(pi)!;
  surface.setInteractiveUi(true);
  surface.noteContext(context());
  userQuestionsBeginSession(surface.controller, sessionManager);
  return { screen, mode, dispatch: (data: string) => dispatch(data), context, pi, surface, sessionManager,
    notices, sent, commands, hooks, hostEscapes: () => hostEscapes,
    open: () => shortcuts.get("ctrl+alt+up")!.handler(context()),
    close: () => {
      for (const hook of hooks.get("session_shutdown") ?? []) hook();
      surface.controller.endSession();
      // Retire listeners, then let the native stale-component path close any
      // still-open custom interaction even after a failed assertion.
      mode.clearExtensionTerminalInputListeners();
      dispatch("\x1b");
      screen.stop();
      setNativeEditorHost(undefined); setUserQuestionTuiHost(undefined); __resetActiveNativeEditorFieldForTest();
    },
  };
}

for (const retirement of ["rebind", "shutdown", "inactive-ui"] as const) {
  test(`Pi 1.3 popup lease retires synchronously on ${retirement}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-popup-retire-"));
    const f = await fixture(t, root);
    if (!f) { await rm(root, { recursive: true, force: true }); return; }
    let opened: Promise<void> | undefined;
    try {
      f.surface.controller.register({ toolCallId: "q", question: "Which?", mode: "async" }, f.sessionManager);
      assert.equal(routeForegroundEscape(f.context(), "\x1b"), false, "pending-only is not foreground ownership");
      opened = f.open();
      await until(() => f.screen.hasOverlay());
      assert.equal(routeForegroundEscape({ sessionManager: {} }, "\x1b"), false, "foreign context cannot use this lease");
      const oldSubscription = [...f.mode.extensionTerminalInputSubscriptions][0];
      assert.ok(oldSubscription);
      if (retirement === "rebind") f.surface.noteContext(f.context()); // Same SessionManager, new generation.
      else if (retirement === "shutdown") for (const hook of f.hooks.get("session_shutdown") ?? []) hook();
      else f.surface.setInteractiveUi(false);
      assert.equal(routeForegroundEscape(f.context(), "\x1b"), false, "retired lease cannot suppress cancellation");
      // A captured callback can outlive unsubscribe in a forwarding host.
      // It must not borrow a new generation's ownership for the same manager.
      let replacementInputs = 0;
      const retireReplacement = publishForegroundEscape(f.context(), {
        handleInput: () => { replacementInputs++; }, isForeground: () => true, isCurrent: () => true,
      });
      try {
        assert.equal(oldSubscription.handler("\x1b"), undefined);
        assert.equal(replacementInputs, 0);
      } finally { retireReplacement(); }
      f.dispatch("\x1b"); // Native stale/close semantics still settle the custom UI.
      await opened;
      assert.equal(f.mode.editor.getText(), "independent chat draft");
    } finally {
      f.close();
      await opened?.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["question", "notice"] as const) {
  for (const path of ["automatic", "command"] as const) {
    for (const order of ["review-first", "popup-first"] as const) {
      for (const outcome of ["verdict", "cancel"] as const) {
        test(`Pi 1.3 ${path} ${kind} ${order}: popup Escape then ${outcome}`, { timeout: 20000 }, async (t) => {
          const root = await mkdtemp(join(tmpdir(), "pi-popup-escape-"));
          const f = await fixture(t, root);
          if (!f) { await rm(root, { recursive: true, force: true }); return; }
          let pendingReview: Promise<void> | undefined;
          let opened: Promise<void> | undefined;
          const cancellation = createReviewCancellationCoordinator();
          try {
            if (kind === "question") {
              assert.ok(f.surface.controller.register({ toolCallId: "q", question: "Which?", choices: ["Yes"], mode: "async" }, f.sessionManager).ok);
            } else {
              assert.ok(f.surface.controller.registerNotice({ toolCallId: "n", title: "Notice", body: "Full body" }, f.sessionManager).ok);
            }
            // Own fixture repository: ancestor checkout ignore rules must not
            // hide this file when TMPDIR is an ignored in-checkout directory.
            await exec("git", ["init", root]);
            await writeFile(join(root, "index.ts"), "before\n");
            const state = createState();
            rememberUserRequest(state, "change index");
            const window = state.reviewWindow!;
            const snapshotOptions = { maxFileBytes: 1048576, maxSnapshotBytes: 52428800 };
            window.baseline = snapshotReviewBaseline(await createWorkspaceSnapshot(root, snapshotOptions));
            const baseline = window.baseline;
            // Automatic review requires agent tool activity: model the agent's
            // write tool around the actual write. The command path stays an
            // intentionally filesystem-only control.
            const write = { toolName: "write", toolInput: { path: "index.ts", content: "after\n" } };
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
            const pidPath = join(root, "pid");
            const releasePath = join(root, "release");
            const reviewer = [
              "const fs=require('node:fs');process.stdin.resume();",
              `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
              `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);process.stdout.write(JSON.stringify({verdict:'pass',summary:'real controlled verdict',findings:[]}));}},10);`,
            ].join("");
            const config = { ...fakeNeedsChangesConfig(),
              externalAgents: { controlled: { adapter: "generic-cli" as const, command: process.execPath, args: [], review: { args: ["-e", reviewer], timeoutMs: 15000 } } },
              review: { activeReviewers: [{ source: "external" as const, id: "controlled" }] },
            };
            registerCommands({ pi: f.pi, cwd: () => root, config, state, cancellation });
            const coordinator = createReviewTurnCoordinator({
              pi: f.pi, state, config, cancellation, scopedModels: () => [], isSessionActive: () => true,
              observeCwd() {}, cwd: () => root, syncExecutionContext() {}, checkpointRestartBlocked: () => undefined,
              effectiveReviewConfig: () => config, persist: async () => {}, persistAutomaticDelivery: async () => true,
              backgroundShell: () => undefined, reviewReadiness: () => [], reapplyDeferredTools() {},
              orchestratorTurns: { hasRunsInFlight: () => false, noteMessageObserved: () => false, noteMessageArmingFailed() {} },
            });
            const startReview = () => path === "automatic"
              ? coordinator.onAgentSettled([f.context()])
              : f.commands.get("review-now")!.handler("", f.context());
            if (order === "popup-first") {
              opened = f.open();
              await until(() => f.screen.hasOverlay());
            }
            pendingReview = startReview();
            await until(() => exists(pidPath)).catch((error) => { throw new Error(`${error.message}; notices=${f.notices.join(" | ")}`); });
            const pid = Number(await readFile(pidPath, "utf8"));
            assert.equal(alive(pid), true);
            const activeReview = cancellation.current();
            assert.ok(activeReview);
            if (order === "review-first") {
              opened = f.open();
              await until(() => f.screen.hasOverlay());
            }
            // Non-Escape keys still use the real native focus path. Enter opens
            // the selected question-answer or notice-detail view.
            f.dispatch("\r");
            if (kind === "question" && path === "automatic" && order === "review-first" && outcome === "verdict") {
              f.dispatch("\x1b[B"); // Type something…
              f.dispatch("\r");
              for (const ch of "docs/") f.dispatch(ch);
              f.dispatch("\t");
              await until(() => f.mode.editor.isShowingAutocomplete());
              f.dispatch("\x1b"); // Native list-first completion dismissal only.
              assert.equal(f.mode.editor.isShowingAutocomplete(), false);
              assert.equal(f.mode.editor.getText(), "docs/");
              assert.equal(alive(pid), true);
              assert.doesNotMatch(f.notices.join("\n"), /cancelling|cancelled/);
              f.dispatch("\x03"); // Native Ctrl+C clear stays in the field.
              assert.equal(f.mode.editor.getText(), "");
              f.dispatch("\x1b"); // Field → choice rows, not review cancellation.
              assert.equal(f.screen.hasOverlay(), true);
            }
            f.dispatch("\x1b"); // Existing back, not decline/notice Close/review abort.
            assert.equal(f.screen.hasOverlay(), true);
            assert.equal(alive(pid), true);
            assert.equal(state.reviewWindow, window);
            assert.equal(window.baseline, baseline);
            assert.equal(state.reviewsPaused, false);
            assert.equal(config.enabled, true);
            assert.equal(cancellation.current(), activeReview);
            assert.doesNotMatch(f.notices.join("\n"), /cancelling|cancelled/);
            assert.equal(f.surface.controller.listPending().length, 1);
            // Synchronous done/hideOverlay. A later raw cancellation listener
            // MUST NOT see this same packet after the lease has been retired.
            f.dispatch("\x1b");
            assert.equal(f.screen.hasOverlay(), false);
            assert.equal(alive(pid), true);
            assert.doesNotMatch(f.notices.join("\n"), /cancelling|cancelled/);
            assert.equal(f.hostEscapes(), 0, "raw consumption prevents underlying editor abort");
            if (outcome === "cancel") {
              // No await/microtask/grace period between dismissal and this press.
              f.dispatch("\x1b");
              assert.match(f.notices.join("\n"), /cancelling.*waiting for reviewer processes to stop/);
              assert.doesNotMatch(f.notices.join("\n"), /reviewer processes stopped/);
              await pendingReview;
              assert.equal(alive(pid), false, "child exit is evidenced before completion notice");
              assert.match(f.notices.join("\n"), /review cancelled; reviewer processes stopped/);
              assert.equal(f.sent.length, 0, "cancelled review produces no verdict delivery");
              assert.equal(window.baseline, baseline, "cancel keeps the review baseline");
            } else {
              await writeFile(releasePath, "pass");
              await pendingReview;
              await until(() => !alive(pid));
              assert.match(f.notices.join("\n"), /review gate: passed/);
              assert.equal(window.reviewHistory.at(-1)?.verdict, "pass");
              assert.match(f.sent.join("\n"), /Gate verdict: pass/);
            }
            await opened;
            assert.equal(f.mode.editor.getText(), "independent chat draft");
            assert.equal(f.surface.controller.listPending().length, 1, "Escape neither answers nor dismisses pending input");
            assert.equal(cancellation.current(), undefined);
          } finally {
            cancellation.current()?.requestCancel("manual");
            await pendingReview?.catch(() => {});
            f.close();
            await opened?.catch(() => {});
            await rm(root, { recursive: true, force: true });
          }
        });
      }
    }
  }
}
