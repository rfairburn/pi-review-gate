import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import test from "node:test";

import { SidebarController } from "../src/session-host/sidebar";
import { stripGeneratedSgr } from "../src/session-host/terminal-surface";

import {
  CleanupOutcome,
  KEYS,
  MainPtyDriver,
  OBSERVER_FIXTURE,
  OUTER_COLS,
  OUTER_ROWS,
  RUNNER_FIXTURE,
  TEST_TIMEOUT_MS,
  OwnedSession,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  editorRecords,
  makeRuntimeEnvironment,
  makeNativeAgentRoot,
  makeWorkspace,
  processIsAlive,
  removeOwnedScratchTreePruningTerraform,
  resolveRuntimePin,
  restoredNativeEditorFrame,
  sessionFileHasStoredName,
  sha256,
} from "./helpers/session-host-native-main-harness";
import { frameHeader, frameHeaderMatches, isSidebarFocusedFrame, parseRosterFrame } from "./helpers/session-host-native-roster-witness";

// Scope boundary: this is an owned virtual-PTY proof of the public Main API,
// not a physical-keyboard or full-CLI test. The question flow and live-child
// SIGTERM/SIGHUP/quit regressions live in
// tests/session-host-native-main-lifecycle.test.ts on the same harness.

async function settingsSmoke(driver: MainPtyDriver, session: OwnedSession, workspaceEditValue: string, editorMarker: string): Promise<void> {
  assert.equal(driver.focus, "main");
  const beforeCommand = driver.frameRevision;
  driver.pty.write("/review-settings");
  const exactSettingsDraft = (text: string): boolean => text.split("\n")
    .some((line) => line.trim() === "/review-settings");
  await driver.waitFrame(exactSettingsDraft,
    "A's exact native command draft, not an earlier notice mentioning the command, is visible before Enter", beforeCommand);
  // A native slash list may still be visible while its async suggestions
  // settle. Real Escape dismisses it without changing the idle draft/owner.
  driver.pty.write(KEYS.escape);
  await driver.waitForFrameQuiet("A's native completion dismissal reaches a bounded stable frame");
  assert.equal(exactSettingsDraft(driver.currentText()), true,
    "native completion dismissal preserves the exact settings command draft");
  await driver.writeKeys(KEYS.enter, "A's /review-settings command is submitted to its native Pi process");
  await driver.waitFrame((text) => text.includes("Review settings") && text.includes("Operating mode"),
    "the production review-gate root settings menu opens in A's native process");

  await driver.moveNativeMenuTo("Scheduled tasks", 16);
  await driver.writeKeys(KEYS.enter, "the actual Scheduled tasks gate submenu opens");
  await driver.waitFrame((text) => text.includes("Scheduled tasks") && text.includes("Add scheduled task"),
    "the actual scheduled-task settings list renders");
  await driver.moveNativeMenuTo("Add scheduled task", 3);
  await driver.writeKeys(KEYS.enter, "the actual scheduled-task name field opens");
  await driver.waitFrame((text) => text.includes("Scheduled task name") && text.includes("Ctrl+G external editor"),
    "the real host-wired native editor renders for a gate settings field");

  const taskName = `native-main-${editorMarker}`;
  await driver.writeAndWait(taskName, (text) => text.includes(taskName), "the scheduled-task name is entered through Pi's native field editor");
  await driver.writeKeys(KEYS.enter, "the task name is staged in the real gate settings menu");
  await driver.waitFrame((text) => text.includes("Schedule (cron)") && text.includes("Instructions"),
    "the real task detail selector opens");

  await driver.moveNativeMenuTo("Schedule (cron)", 2);
  await driver.writeKeys(KEYS.enter, "the task cron editor opens");
  await driver.waitFrame((text) => text.includes("Cron expression"), "the actual cron editor is visible");
  await driver.writeAndWait("* * * * *", (text) => text.includes("* * * * *"), "a valid cron expression is entered");
  await driver.writeKeys(KEYS.enter, "the cron expression is staged");
  await driver.waitFrame((text) => driver.nativeMenuSelected(text, "Schedule (cron)"), "the task selector returns after cron editing");

  await driver.moveNativeMenuTo("Instructions", 4);
  await driver.writeKeys(KEYS.enter, "the task instruction field opens");
  await driver.waitFrame((text) => text.includes("Instructions for the scheduled subtask"),
    "the real native editor opens for task instructions");
  const instructions = `native-main-staged-${editorMarker}`;
  await driver.writeAndWait(instructions, (text) => text.includes(instructions), "the test-only instructions are entered");
  await driver.writeKeys(KEYS.enter, "the task instructions are staged");
  await driver.waitFrame((text) => driver.nativeMenuSelected(text, "Instructions"), "the task selector returns after instruction editing");

  await driver.moveNativeMenuTo("Workspace", 3);
  await driver.writeKeys(KEYS.enter, "the new task workspace field opens empty");
  await driver.waitFrame((text) => text.includes("Authorized target workspace directory")
    && text.includes("Ctrl+G external editor"), "the native workspace editor and Ctrl+G hint are visible");
  const editorLogCount = editorRecords(driver.editorLog).length;
  const beforeCtrlG = driver.frameRevision;
  driver.pty.write(KEYS.ctrlG);
  await driver.waitFrame((text) => text.includes("Authorized target workspace directory") && text.includes(editorMarker),
    "the native workspace editor is restored with the external editor's returned value", beforeCtrlG);
  assert.ok(editorRecords(driver.editorLog).length > editorLogCount, "the owned external editor executable actually ran");
  assert.ok(driver.currentText().includes(editorMarker), "the native UI displays the external editor's returned value");
  await driver.writeKeys(KEYS.enter, "the externally edited workspace is staged by the native gate settings field");
  await driver.waitFrame((text) => driver.nativeMenuSelected(text, "Workspace"), "the task selector is restored after Ctrl+G field submission");

  await driver.writeKeys(KEYS.enter, "the staged workspace field is reopened");
  await driver.waitFrame((text) => text.includes("Authorized target workspace directory") && text.includes(editorMarker),
    "reopening the real native editor shows its staged external-editor value");
  await driver.writeKeys(KEYS.escape, "the native workspace field is canceled without losing its staged value");
  await driver.waitFrame((text) => driver.nativeMenuSelected(text, "Workspace"), "the native task selector returns after field cancel");

  await driver.moveNativeMenuTo("Enabled", 8);
  await driver.writeKeys(KEYS.enter, "the test task is disabled so this fixture can never schedule execution");
  await driver.waitFrame((text) => driver.nativeMenuSelected(text, "Enabled") && text.includes("Off"),
    "the real gate menu stages the disabled task state");
  await driver.moveNativeMenuTo("Back", 6);
  await driver.writeKeys(KEYS.enter, "the task detail menu returns to the task list");
  await driver.waitFrame((text) => text.includes("Add scheduled task"), "the real task list returns");
  await driver.moveNativeMenuTo("Back", 3);
  await driver.writeKeys(KEYS.enter, "the scheduled-task list returns to the staged root settings menu");
  await driver.waitFrame((text) => text.includes("Review settings") && driver.nativeMenuSelected(text, "Scheduled tasks"),
    "the same root settings transaction is restored after editing the scheduled task");
  await driver.moveNativeMenuTo("Save changes", 4);
  await driver.writeKeys(KEYS.enter, "the staged gate settings are saved through the real root menu");
  await driver.waitFrame((text) => text.includes("Review settings saved.") && !text.includes("Save changes"),
    "the actual native settings UI closes and reports a successful save");

  const sharedConfig = join(session.record.agentDir!, "review-gate.json");
  const saved = JSON.parse(readFileSync(sharedConfig, "utf8")) as {
    scheduledTasks?: Record<string, { name?: string; cron?: string; enabled?: boolean; instructions?: string; workspace?: string }>;
  };
  const entry = Object.values(saved.scheduledTasks ?? {}).find((task) => task.name === taskName);
  assert.ok(entry, "the real /review-settings Save persisted A's staged task");
  assert.equal(entry!.cron, "* * * * *");
  assert.equal(entry!.enabled, false, "the test task stays disabled; no scheduled work is run");
  assert.equal(entry!.instructions, instructions);
  assert.equal(entry!.workspace, workspaceEditValue, "the actual Ctrl+G editor's changed value was persisted");
}

test("the complete restored-native-editor witness rejects stale narrow frames, partial repaints, and altered drafts", () => {
  const controller = new SidebarController({ toggleKey: "f8" });
  controller.updateItems([{
    id: "owned-native-row", label: "BGT", workspace: "/owned/workspace", agentDir: "/owned/agent",
    lifecycle: "alive", busy: false, pendingInput: false, inputSurface: false, activity: [],
  }]);
  const ownerLabel = "BGT";
  const draft = "nativeDraftB";
  const nativeWidth = OUTER_COLS - 32 - 1;
  // A visible controller starts sidebar-focused; draw the roster first so the
  // complete-card fence authorizes the roster-only Alt+Right Main-focus return.
  controller.renderRoster(32, 49);
  controller.handleInput(KEYS.altRight);
  assert.equal(controller.focus, "main");
  assert.equal(controller.visible, true);
  const left = controller.renderRoster(32, 49).lines.map((line) => stripGeneratedSgr(line));
  const nativePane = (top: string, content: string, closing: string): string[] => {
    const rows = Array.from({ length: 49 }, () => "");
    rows[20] = top;
    rows[21] = content;
    rows[22] = closing;
    return rows;
  };
  const compose = (sidebar: readonly string[], main: readonly string[]): string =>
    [ownerLabel, ...sidebar.map((line, index) => `${line.padEnd(32)}│${main[index] ?? ""}`)].join("\n");
  const rule = "─".repeat(nativeWidth);
  const options = { ownerLabel, draft, sidebarColumns: 32, nativeWidth };
  assert.equal(restoredNativeEditorFrame(compose(left, nativePane(rule, `> ${draft}`, rule)), options), true,
    "the complete restored editor at the current width is accepted");
  assert.equal(restoredNativeEditorFrame(compose(left, nativePane("─".repeat(52), `> ${draft}`, "─".repeat(52))), options), false,
    "a resized stale narrow frame is rejected");
  assert.equal(restoredNativeEditorFrame(compose(left, nativePane(rule, `> ${draft}`, "")), options), false,
    "a partial repaint that never drew the closing border is rejected");
  assert.equal(restoredNativeEditorFrame(compose(left, nativePane(rule, `> ${draft}qQ`, rule)), options), false,
    "an appended draft is rejected");
  assert.equal(restoredNativeEditorFrame(compose(left, nativePane(rule, `> x-${draft}`, rule)), options), false,
    "an altered draft is rejected");
  assert.equal(restoredNativeEditorFrame(compose([...left, "e edit name"], nativePane(rule, `> ${draft}`, rule)), options), false,
    "a stale sidebar-only footer is rejected");
  assert.equal(restoredNativeEditorFrame([ownerLabel, ...Array.from({ length: 49 }, () => "")].join("\n"), options), false,
    "a missing roster and editor are rejected");
});

// Guards the immutable startup-option contract as well as this alpha's
// local-scripted-provider/no-session-override fixture boundary.
const FORBIDDEN_SESSION_ARGS = new Set([
  "--session", "--session-id", "--sessionID", "--session-dir", "--no-session",
  "--continue", "--resume", "--fork",
]);

test("real public Main owns native Pi focus, settings/editor, resize, normal child exit, and outer TTY restoration", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return;

  const scratch = createOwnedScratchRoot();
  let driver: MainPtyDriver | undefined;
  let scratchOwned = true;
  // True only after every scenario assertion, including exit/restore.
  let assertionsCompleted = false;
  t.after(async () => {
    let cleanup: CleanupOutcome | undefined;
    if (driver) {
      try {
        cleanup = await driver.boundedCleanup();
      } catch {
        try { cleanup = await driver.forceCleanupAndObserve(); } catch {
          cleanup = driver.cleanupStatus(true);
        }
      } finally {
        driver.dispose();
      }
    }
    const cleanupConfirmed = cleanup?.childrenExited === true
      && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit
      && !cleanup.forced;
    // Preserve failed witnesses. The compatibility cleanup entry point also
    // retains successful runtime trees until positive per-entry ownership
    // receipts exist; root creation alone never authorizes recursive removal.
    if (scratchOwned && assertionsCompleted && cleanupConfirmed) {
      try {
        if (!removeOwnedScratchTreePruningTerraform(scratch)) {
          process.stderr.write(`preserved Main runtime witness (per-entry ownership receipts unavailable): ${scratch}\n`);
        }
      } catch {
        process.stderr.write("preserved owned Main scratch: bounded cleanup could not positively remove every entry\n");
      }
    } else if (scratchOwned) {
      const status = cleanup
        ? `childrenExited=${cleanup.childrenExited} shutdownEvents=${cleanup.shutdownEventsObserved} hostExited=${cleanup.hostExited} gracefulHostExit=${cleanup.gracefulHostExit} forced=${cleanup.forced}`
        : "cleanup status unavailable";
      process.stderr.write(`preserved owned Main scratch ${scratch}; assertionsCompleted=${assertionsCompleted}; ${status}\n`);
    }
  });

  const workspaceA = makeWorkspace(scratch, "workspace-a");
  const workspaceB = makeWorkspace(scratch, "workspace-b");
  const nativeAgentDir = makeNativeAgentRoot(scratch);
  const editorMarker = `editor-${Math.random().toString(16).slice(2, 8)}`;
  const workspaceEditTarget = join(workspaceA, editorMarker);
  mkdirSync(workspaceEditTarget, { mode: 0o700 });
  // A relative spelling stays out of absolute-path autocomplete while still
  // resolving inside A's explicitly owned workspace during save validation.
  const workspaceEditValue = `./${editorMarker}/`;
  const observerFile = join(scratch, "observer", "native-main.jsonl");
  const editorLog = createEditorLog(scratch);
  const editor = createEditorExecutable(scratch, workspaceEditTarget, editorLog);
  writeFileSync(join(nativeAgentDir, "settings.json"), JSON.stringify({ externalEditor: editor }) + "\n", {
    flag: "wx", mode: 0o600,
  });
  const candidate = compileAndStageCandidate(scratch);
  const nodePath = runtime.nodePath.split(delimiter);
  assert.ok(nodePath.includes(join(resolve(process.cwd()), "node_modules")), "the candidate uses the workspace dependency root, not an absolute node_modules link");

  const startEnv = makeRuntimeEnvironment(
    scratch,
    runtime,
    editor,
    observerFile,
    editorLog,
    workspaceEditValue,
    nativeAgentDir,
  );
  startEnv.EDITOR = join(scratch, "unavailable-editor-must-not-be-selected");
  // Native Pi creates a saved conversation only after an actual user message.
  // Two explicit UI-delivered seed turns exercise ordinary persistence; this
  // existing public faux-provider seam makes no external AI/API requests.
  const seedStateDir = join(scratch, "fixture-state");
  mkdirSync(seedStateDir, { mode: 0o700 });
  writeFileSync(join(seedStateDir, "turn-script.json"), JSON.stringify({
    steps: [{ text: "native-save-seed-complete" }],
  }), { flag: "wx", mode: 0o600 });
  startEnv.PRG_FIXTURE_AGENT_DIR = runtime.agentDir;
  startEnv.PRG_FIXTURE_STATE_DIR = seedStateDir;
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");
  const args = ["--offline", "--no-context-files", "--no-themes", "--no-tools", "--extension", OBSERVER_FIXTURE,
    "--extension", resolve(process.cwd(), "tests", "fixtures", "session-host-main-provider.cjs")];
  assert.equal(args.some((arg) => FORBIDDEN_SESSION_ARGS.has(arg)), false,
    "the real native sessions receive no forced/resumed/no-session override");
  const compiledMain = join(candidate.root, "dist", "src", "session-host", "main.js");
  assert.ok(existsSync(compiledMain), "the test drives the privately staged compiled production public Main API");
  assert.ok(existsSync(RUNNER_FIXTURE) && existsSync(OBSERVER_FIXTURE));

  driver = await MainPtyDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    candidate,
    runtime,
    observerFile,
    editor,
    editorLog,
    editorValue: workspaceEditValue,
    args,
    env: startEnv,
  });

  await driver.waitFrame((text) => text.includes("Welcome") && text.includes("New session") && text.includes("Quit host"),
    "fresh real Main displays its empty welcome/sidebar state");
  assert.equal(existsSync(nativeAgentDir), true, "the fixture owns one normal shared native agent root before child creation");
  assert.deepEqual(driver.records(), [], "no native lifecycle observer ran before an explicit New session");
  const suffix = Math.random().toString(16).slice(2, 8);
  let labelA = `A-${suffix}`;
  const labelB = `B-${suffix}`;
  const sessionA = await driver.createNativeSession(workspaceA);
  assert.equal(sessionA.record.displayName, "(no messages)", "a fresh native conversation uses Pi's real no-messages fallback");
  assert.equal(sessionA.record.storedName, undefined, "the fresh conversation has no fabricated stored name");
  await driver.renameNativeSession(sessionA, labelA);
  assert.ok(driver.currentText().includes("Welcome"), "A's highlighted completion has not activated or replaced the empty Main frame");
  assert.equal(driver.selected(labelA), true, "A is highlighted after asynchronous creation");
  assert.equal(driver.focus, "sidebar", "creation completion returns ownership to the roster, not native input");
  // Printable digits exercise non-owner input without invoking host commands
  // such as `e` (Edit), which can legitimately occur in a hexadecimal suffix.
  const unselectedGuard = `314159265358${suffix.replace(/[a-f]/g, "9")}`;
  driver.pty.write(unselectedGuard);
  await driver.waitForFrameQuiet("A's highlight-only input is followed by a bounded stable frame");
  const afterUnselectedGuard = driver.currentText();
  assert.ok(!afterUnselectedGuard.includes(unselectedGuard),
    `the highlight-only input never appears in the native child or host frame:\n${afterUnselectedGuard.slice(-1_000)}`);
  assert.ok(afterUnselectedGuard.includes("Welcome"), "the empty Main frame remains visible while A is only highlighted");

  const sessionB = await driver.createNativeSession(workspaceB);
  assert.equal(sessionB.record.displayName, "(no messages)", "B also starts with Pi's real no-messages fallback");
  assert.equal(sessionB.record.storedName, undefined, "B has no fabricated stored name");
  await driver.renameNativeSession(sessionB, labelB);
  assert.equal(driver.selected(labelB), true, "B is highlighted after asynchronous creation");
  assert.equal(driver.focus, "sidebar");
  const sharedGateConfigA = join(sessionA.record.agentDir!, "review-gate.json");
  const sharedGateConfigB = join(sessionB.record.agentDir!, "review-gate.json");
  assert.equal(sessionA.record.agentDir, nativeAgentDir, "A uses the fixture's ordinary shared native agent root");
  assert.equal(sessionB.record.agentDir, nativeAgentDir, "B uses the same ordinary shared native agent root");
  assert.equal(sharedGateConfigA, sharedGateConfigB, "both children discover the same shared native review-gate config");
  assert.notEqual(sessionA.record.pid, sessionB.record.pid, "the native children have independently owned process ids");
  assert.notEqual(sessionA.record.sessionId, sessionB.record.sessionId, "Pi's public native SessionManager generated distinct conversation ids");
  assert.ok(typeof sessionA.record.sessionId === "string" && sessionA.record.sessionId.length > 0);
  assert.ok(typeof sessionB.record.sessionId === "string" && sessionB.record.sessionId.length > 0);
  assert.equal(sessionA.record.cwd, workspaceA, "A runs in the explicitly selected canonical workspace");
  assert.equal(sessionB.record.cwd, workspaceB, "B runs in the explicitly selected canonical workspace");
  assert.notEqual(sessionA.record.sessionFile, sessionB.record.sessionFile,
    "the two native conversations retain independent files under shared discovery");
  assert.equal(sessionA.record.sessionFile!.startsWith(nativeAgentDir + sep), true,
    "A's native conversation file belongs to the shared fixture root");
  assert.equal(sessionB.record.sessionFile!.startsWith(nativeAgentDir + sep), true,
    "B's native conversation file belongs to the shared fixture root");
  for (const session of [sessionA, sessionB]) {
    assert.equal(session.record.tty, true, "each actual Pi process has a real owned PTY");
    assert.deepEqual(session.record.credentialLikeEnvironmentNames, [], "the native process inherited no credential-like environment variables");
    assert.ok(session.record.sessionFile && isAbsolute(session.record.sessionFile), "Pi's public SessionManager reports its native session file");
  }
  const unselectedBGuard = `271828182845${suffix.replace(/[a-f]/g, "9")}`;
  driver.pty.write(unselectedBGuard);
  await driver.waitForFrameQuiet("B's highlight-only input is followed by a bounded stable frame");
  const afterUnselectedBGuard = driver.currentText();
  assert.ok(!afterUnselectedBGuard.includes(unselectedBGuard),
    `B's highlight-only input never appears in the native child or host frame:\n${afterUnselectedBGuard.slice(-1_000)}`);
  assert.ok(afterUnselectedBGuard.includes("Welcome"), "B remains only highlighted in the empty Main view");
  await driver.activateRoster(labelB);
  const initialSessions = [sessionA, sessionB];
  for (const session of initialSessions) {
    assert.equal(session.record.columns, 87, "the outer wide sidebar rectangle determines the initial native child width");
    assert.equal(session.record.rows, 49, "the native child excludes the outer header row");
    assert.equal(processIsAlive(session.record.pid), true, "the native child remains independently alive while another row is selected");
  }

  for (const session of initialSessions) {
    assert.equal(existsSync(session.record.sessionFile!), false,
      "native names alone do not force an empty conversation file into shared saved discovery");
    await driver.activateRoster(session.rowProbe);
    const beforeSeed = driver.records().length;
    const seedPrompt = `native-save-seed-${session.rowProbe}`;
    await driver.writeAndWait(seedPrompt, (text) => text.includes(seedPrompt),
      "the deliberate saved-conversation seed is typed through its actual native editor");
    await driver.writeKeys(KEYS.enter, "the actual native UI submits the seed user message");
    await driver.waitForRecords((records) => records.slice(beforeSeed).some((record) =>
      record.type === "agent_settled" && record.pid === session.record.pid),
    "the real local scripted turn settles in the exact owned native child");
    await driver.waitFrame((text) => text.includes("native-save-seed-complete"),
      "the actual native pane renders the locally scripted response");
    assert.equal(sessionFileHasStoredName(session.record.sessionFile!, session.currentName), true,
      "ordinary Pi persistence writes the previously set exact native name after a real user message");
  }
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 2,
    "only the two deliberately submitted local scripted seed turns ran");

  const draftB = `nativeDraftB${suffix}`;
  await driver.writeAndWait(draftB, (text) => text.includes(draftB), "B receives a unique real native draft");
  assert.equal(driver.focus, "main");
  const bPid = sessionB.record.pid;
  assert.ok(processIsAlive(bPid), "B is live before testing native keys and sidebar focus");

  const maxNamePrefix = `A-${suffix}-`;
  const maxName = `${maxNamePrefix}${"x".repeat(1022 - Buffer.byteLength(maxNamePrefix))}é`;
  assert.equal(Buffer.byteLength(maxName, "utf8"), 1024, "the native rename fixture is exactly 1024 UTF-8 bytes");
  await driver.renameNativeSession(sessionA, maxName);
  labelA = sessionA.rowProbe;
  assert.equal(sessionFileHasStoredName(sessionA.record.sessionFile!, maxName), true,
    "the real native session file persists the exact full stored name, not its clipped caption");
  const persistedNameRecord = driver.records().find((record) => record.type === "native_session_name"
    && record.pid === sessionA.record.pid && record.sessionId === sessionA.record.sessionId
    && record.storedName === maxName);
  assert.ok(persistedNameRecord,
    "the test-only public SessionManager journal observes the full persisted name and exact native session tuple");
  assert.equal(persistedNameRecord!.displayName, Array.from(maxName).slice(0, 256).join(""),
    "the observer caption is the native bounded display name, separate from the exact full stored name");
  await driver.renameNativeSession(sessionA, labelA);
  assert.equal(sessionA.currentName, labelA, "A returns to its short persisted alias before the remaining row/header checks");
  assert.equal(sessionFileHasStoredName(sessionA.record.sessionFile!, labelA), true,
    "restoring the short alias persists a separately navigable native row name");
  await driver.toggleSidebar();
  assert.equal(driver.focus, "main", "editing inactive A leaves B as the active input owner");
  assert.ok(driver.currentText().includes(draftB), "editing inactive A preserves B's native prompt draft");
  assert.equal(processIsAlive(bPid), true, "B stays live while the host edits inactive A");

  // Exercise the actual Workspace-only New form beside B, including its
  // native path completion's first-Escape dismissal and second-Escape cancel.
  await driver.toggleSidebar();
  const bHeaderBeforeNew = driver.currentText().split("\n")[0];
  const completionTargetA = makeWorkspace(scratch, "workspace-new-alpha");
  const completionTargetB = makeWorkspace(scratch, "workspace-new-beta");
  const completionTargetNameA = completionTargetA.split(sep).at(-1)!;
  const completionTargetNameB = completionTargetB.split(sep).at(-1)!;
  await driver.moveRosterTo("New session");
  const resizeCountBeforeNewForm = driver.records().filter((record) => record.type === "resize").length;
  const beforeNewForm = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "form";
  await driver.waitFrame((text) => text.includes("New session") && text.includes("Workspace:")
    && !text.includes("Label:") && !text.includes("Profile:")
    && text.includes("tab complete") && text.includes("ctrl+g external editor"),
  "the real right-pane New form has only Workspace and readable native-editor hints", beforeNewForm);
  assert.equal(driver.records().filter((record) => record.type === "resize").length, resizeCountBeforeNewForm,
    "opening the right-pane New form leaves both native child geometries unchanged");
  assert.equal(driver.currentText().split("\n")[0], bHeaderBeforeNew,
    "the New form does not transfer the active Main conversation away from B");
  assert.equal(processIsAlive(bPid), true, "B remains live while the New form owns the right pane");
  const beforeHostEditorLog = editorRecords(driver.editorLog).length;
  const beforeHostEditorFrame = driver.frameRevision;
  driver.pty.write(KEYS.ctrlG);
  await driver.waitFrame((text) => text.includes("New session") && text.includes(workspaceEditValue),
    "the real host Workspace form returns from the native-global external editor", beforeHostEditorFrame);
  assert.ok(editorRecords(driver.editorLog).length > beforeHostEditorLog,
    "host Ctrl+G ran the configured global editor despite an unavailable EDITOR fallback");
  assert.equal(driver.currentText().split("\n")[0], bHeaderBeforeNew,
    "external-editor handoff restores the same active native owner");
  assert.equal(driver.records().filter((record) => record.type === "resize").length, resizeCountBeforeNewForm,
    "host external-editor handoff does not resize native children");
  assert.equal(processIsAlive(bPid), true, "B remains live after the actual host editor handoff");

  await driver.setOuterSize(52, 30, initialSessions, 52, 29);
  const expectedHints = ["enter create", "escape cancel", "tab complete", "ctrl+c clear", "ctrl+g external editor"];
  await driver.waitFrame((text) => expectedHints.every((hint) => text.replace(/\s+/g, " ").includes(hint)),
    "the actual narrow New form finishes painting every wrapped native hint after resize");
  const wrappedHints = driver.currentText().replace(/\s+/g, " ");
  for (const hint of expectedHints) {
    assert.ok(wrappedHints.includes(hint), `the narrow New form keeps its wrapped ${hint} hint readable\n${driver.currentText()}`);
  }
  await driver.setOuterSize(24, 5, initialSessions, 24, 4);
  await driver.waitFrame((text) => text.includes("too small") && !text.includes("Workspace:"),
    "the real New form paints its bounded tiny-pane message without fabricating a field");
  await driver.setOuterSize(52, 30, initialSessions, 52, 29);
  await driver.waitFrame((text) => text.includes("Workspace:"), "the New form returns after restoring usable geometry");
  await driver.clearWorkspaceField("the native clear binding empties B's retained workspace before filesystem completion");
  const partialWorkspace = join(scratch, "workspace-new-");
  await driver.writeAndWait(partialWorkspace, (text) => text.includes(partialWorkspace.slice(-18)),
    "the New form's real workspace Editor accepts an absolute fixture-only completion prefix");
  await driver.waitFrame((text) => text.includes(completionTargetNameA) && text.includes(completionTargetNameB),
    "typing the native path prefix automatically displays both owned folder suggestions");
  // Native Tab accepts an already visible selection. Dismiss that list first
  // so this separate Tab action tests opening completion, not accepting alpha.
  const beforeAutomaticDismiss = driver.frameRevision;
  driver.pty.write(KEYS.escape);
  await driver.waitFrame((text) => text.includes("Workspace:")
    && !text.includes(completionTargetNameA) && !text.includes(completionTargetNameB),
  "native Escape dismisses the automatically opened completion while retaining New", beforeAutomaticDismiss);
  const beforeCompletion = driver.frameRevision;
  driver.pty.write("\t");
  await driver.waitFrame((text) => text.includes(completionTargetNameA) && text.includes(completionTargetNameB),
    "the native filesystem provider displays both fixture-owned matching workspace completions", beforeCompletion);
  const beforeCompletionEscape = driver.frameRevision;
  driver.pty.write(KEYS.escape);
  await driver.waitFrame((text) => text.includes("New session") && text.includes("Workspace:")
    && !text.includes(completionTargetNameA) && !text.includes(completionTargetNameB),
  "the first Escape dismisses native completion without canceling New", beforeCompletionEscape);
  assert.equal(driver.focus, "form", "completion dismissal retains form ownership");
  const escapeControlsBeforeFormCancel = driver.nativeEscapeControlCount(bPid, sessionB.workspace);
  const lifecycleBeforeFormCancel = driver.records().filter((record) =>
    (record.type === "session_shutdown" || record.type === "session_start") && record.pid === bPid).length;
  const resizesBeforeFormCancel = driver.records().filter((record) => record.type === "resize").length;
  const beforeFormCancel = driver.frameRevision;
  driver.pty.write(KEYS.escape);
  // Escape cancels ONLY New. At 52x30 the roster is a full-width overlay, so the
  // native pane (and B's retained draft) is genuinely not rendered here:
  // require the complete current roster/focus/footer and the unchanged owner,
  // never a fabricated view of the hidden native draft.
  const narrowColumns = 52;
  driver.focus = "sidebar";
  driver.sidebarVisible = true;
  await driver.waitFrame((text) => !text.includes("> Workspace:")
    && parseRosterFrame(text, narrowColumns).complete
    && isSidebarFocusedFrame(text, narrowColumns)
    && frameHeaderMatches(text, labelB),
  "the second Escape cancels only New and finishes painting the complete narrow roster with B's unchanged owner",
  beforeFormCancel);
  assert.equal(driver.sidebarVisible, true, "canceling New returns to the visible roster instead of hiding the sidebar");
  assert.equal(driver.focus, "sidebar", "canceling New returns ownership to the visible roster, not Main");
  assert.equal(processIsAlive(bPid), true, "canceling New never stops B's native process");
  assert.equal(driver.nativeEscapeControlCount(bPid, sessionB.workspace), escapeControlsBeforeFormCancel,
    "cancelling New writes no native Escape to B's owned PTY");
  assert.equal(driver.records().filter((record) =>
    (record.type === "session_shutdown" || record.type === "session_start") && record.pid === bPid).length,
  lifecycleBeforeFormCancel, "cancelling New mutates no native lifecycle for B");
  assert.equal(driver.records().filter((record) => record.type === "resize").length, resizesBeforeFormCancel,
    "cancelling New resizes no native child");
  // Deliberate, individually witnessed Main-focus return: one roster-only
  // Alt+Right moves host input focus to the existing Main owner without
  // activating the highlighted row, hiding the pane, or resizing any child.
  driver.pty.write(KEYS.altRight);
  driver.focus = "main";
  driver.sidebarVisible = true;
  const beforeRestoredNative = driver.frameRevision;
  await driver.setOuterSize(OUTER_COLS, OUTER_ROWS, initialSessions, OUTER_COLS - 32 - 1, 49);
  // setOuterSize only observes first outer output and the resize records, so
  // require the COMPLETE restored editor: the exact owner header, the complete
  // roster with its Main-focused footer (no stale sidebar-only hints), a
  // width-correct bordered editor block, and B's exact unchanged draft. A
  // stale narrow frame, a partial repaint, or an altered draft never passes.
  await driver.waitFrame((text) => restoredNativeEditorFrame(text, {
    ownerLabel: labelB, draft: draftB, sidebarColumns: 32, nativeWidth: OUTER_COLS - 32 - 1,
  }),
  "Main completely repaints the restored wide native editor with B's unchanged exact draft",
  beforeRestoredNative);
  assert.equal(driver.surface.frame().cols, OUTER_COLS, "the restored outer geometry is the full latest width");
  assert.equal(driver.focus, "main", "the deliberate Main-focus return keeps the existing owner");
  assert.equal(driver.sidebarVisible, true, "the deliberate Main-focus return never hides the visible sidebar");
  await driver.activateRoster(labelB, draftB);

  await driver.writeAndWait("qQ", (text) => text.includes(`${draftB}qQ`), "native q/Q are forwarded unchanged in Main focus");
  await driver.sendNativeEscapeAndObserve(sessionB);
  assert.ok(driver.currentText().includes("New session") && driver.currentText().includes("Quit host"),
    "native Escape is forwarded without hiding the still-visible host sidebar");
  assert.equal(driver.focus, "main", "Escape did not move Main ownership to the sidebar");
  assert.equal(processIsAlive(bPid), true, "native q/Q/Escape did not quit or pause B");
  await driver.writeAndWait(KEYS.ctrlC, (text) => !text.includes(`${draftB}qQ`),
    "one native Ctrl+C clears the actual Pi prompt instead of quitting Main");
  assert.equal(processIsAlive(bPid), true, "a single native Ctrl+C clears the editor but leaves the native Pi child alive");
  assert.equal(driver.exitEvent, undefined, "native Ctrl+C did not become a host-wide quit");
  await driver.writeAndWait(draftB, (text) => text.includes(draftB), "B's private draft is re-entered for focus-retention checks");

  const recordCountBeforeWideHide = driver.records().length;
  // Two explicit presses from the visible Main focus: the first only focuses
  // the sidebar (no hide, no resize), the second deliberately hides it.
  await driver.toggleSidebar();
  assert.equal(driver.sidebarVisible, true,
    "the first explicit press focuses the visible sidebar instead of hiding it");
  await driver.toggleSidebar();
  for (const session of initialSessions) {
    await driver.waitForRecords((records) => records.slice(recordCountBeforeWideHide).some((record) => record.type === "resize"
      && record.pid === session.record.pid && record.columns === 120 && record.rows === 49),
     `hiding the wide sidebar creates a fresh full-width 120x49 resize for ${session.rowProbe}`);
  }
  assert.equal(processIsAlive(bPid), true, "hiding the sidebar does not pause its native owner");
  const recordCountBeforeWideShow = driver.records().length;
  await driver.toggleSidebar();
  for (const session of initialSessions) {
    await driver.waitForRecords((records) => records.slice(recordCountBeforeWideShow).some((record) => record.type === "resize"
      && record.pid === session.record.pid && record.columns === 87 && record.rows === 49),
     `showing the wide sidebar creates a fresh 87x49 resize for ${session.rowProbe}`);
  }
  assert.ok(driver.currentText().includes(draftB), "B's native prompt remains visible behind the reopened sidebar");
  assert.equal(processIsAlive(bPid), true, "opening the sidebar does not pause the child");

  await driver.moveRosterTo(labelA);
  assert.ok(driver.currentText().includes(draftB), "highlighting A alone leaves B as the active input owner");
  const beforeSelectA = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "main";
  await driver.waitFrame((text) => !text.includes(draftB), "Enter transfers Main focus to A and only then changes the visible native surface", beforeSelectA);
  const draftA = `nativeDraftA${suffix}`;
  await driver.writeAndWait(draftA, (text) => text.includes(draftA), "A receives its own unique native draft");
  assert.ok(!driver.currentText().includes(draftB), "input from B is not broadcast into A");

  // Two-step reserved chord from a visible Main-focused frame: the first press
  // only focuses the sidebar (no hide, no native resize), and a second
  // deliberate press from that focused state hides it back to Main.
  await driver.waitFrame((text) => frameHeaderMatches(text, labelA)
    && text.includes(draftA) && parseRosterFrame(text, 32).complete,
  "A's exact active header, private draft, and complete roster are drawn before the focus-only press");
  const resizeCountBeforeFocus = driver.records().filter((record) => record.type === "resize").length;
  const headerBeforeFocus = frameHeader(driver.currentText());
  await driver.toggleSidebar();
  assert.equal(driver.sidebarVisible, true, "the first F8 press keeps the visible sidebar shown");
  assert.equal(driver.focus, "sidebar", "the first F8 press moves ownership to the visible sidebar");
  assert.ok(isSidebarFocusedFrame(driver.currentText(), 32), "the first F8 press draws the complete sidebar-only roster");
  assert.equal(frameHeader(driver.currentText()), headerBeforeFocus, "the focus-first press leaves A as the active Main owner");
  assert.ok(driver.currentText().includes(draftA), "the focus-first press preserves A's native draft");
  assert.equal(processIsAlive(sessionA.record.pid), true, "the focus-first press never stops A's child");
  assert.equal(driver.records().filter((record) => record.type === "resize").length, resizeCountBeforeFocus,
    "the focus-first press does not resize any native child");
  await driver.toggleSidebar();
  assert.equal(driver.sidebarVisible, false, "the next deliberate F8 press hides the sidebar-focused pane");
  assert.equal(driver.focus, "main", "hiding the sidebar returns ownership to Main");
  assert.ok(driver.currentText().includes(draftA), "A's draft remains intact when the second press hides the sidebar");
  assert.equal(processIsAlive(sessionA.record.pid), true, "the actual second F8 press leaves A's child alive");
  await driver.toggleSidebar();
  assert.ok(driver.currentText().includes(draftA), "F8 reopens the sidebar without altering A's native draft");
  await driver.moveRosterTo(labelB);
  assert.ok(driver.currentText().includes(draftA), "highlighting B does not reroute A's native input");
  const beforeSelectB = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "main";
  await driver.waitFrame((text) => frameHeaderMatches(text, labelB)
    && text.includes(draftB) && !text.includes(draftA) && parseRosterFrame(text, 32).complete,
    "only explicit Enter returns ownership to B with its exact header, private draft, and complete roster", beforeSelectB);

  await driver.setOuterSize(100, 30, initialSessions, 67, 29);
  assert.equal(driver.surface.frame().cols, 100, "the real outer PTY and terminal emulator observe the resized outer width");
  // A native resize receipt or first output byte is not a complete outer redraw.
  // Observe B's exact owner and the full roster before capturing the header for F8.
  await driver.waitFrame((text) => frameHeaderMatches(text, labelB)
    && text.includes(draftB) && parseRosterFrame(text, 32).complete,
  "the 100-column redraw completes B's exact active header, private draft, and full roster before F8");
  // A narrow pane overlays only while the roster owns focus. Establish that
  // state before testing a visible overlay's close/reopen transitions.
  await driver.ensureSidebarFocus();
  await driver.setOuterSize(52, 20, initialSessions, 52, 19);
  assert.equal(driver.surface.frame().rows, 20, "the outer frame writer remains bounded to the resized terminal rows");
  const resizeCountsBeforeNarrowFocus = new Map(initialSessions.map((session) => [
    session.record.pid!,
    driver.records().filter((record) => record.type === "resize" && record.pid === session.record.pid).length,
  ]));
  await driver.toggleSidebar(); // the visible narrow overlay closes; native dimensions stay full-width
  await driver.toggleSidebar(); // reopening focuses the narrow overlay, still without native geometry change
  await driver.moveRosterTo(labelA);
  const beforeNarrowSelectA = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "main";
  await driver.waitFrame((text) => frameHeaderMatches(text, labelA) && !text.includes("New session"),
    "narrow overlay selection returns to Main without changing the native rectangle", beforeNarrowSelectA);
  await driver.assertNoJournalEvent((records) => initialSessions.some((session) => records.filter((record) =>
    record.type === "resize" && record.pid === session.record.pid).length
      > (resizeCountsBeforeNarrowFocus.get(session.record.pid!) ?? 0)),
  "narrow overlay focus changes do not resize any native child");
  for (const session of initialSessions) {
    const latest = driver.records().filter((record) => record.type === "resize" && record.pid === session.record.pid).at(-1);
    assert.equal(latest?.columns, 52);
    assert.equal(latest?.rows, 19);
  }
  assert.ok(driver.currentText().includes(draftA), "switching to A preserves its private draft after the narrow overlay focus change");
  assert.ok(!driver.currentText().includes(draftB), "switching to A preserves the separate B draft");

  // Restore enough width for the real nested gate menu/editor interaction.
  const resizeOutputBefore = driver.outputRevision;
  const resizeRecordCountBeforeRestore = driver.records().length;
  driver.pty.resize(OUTER_COLS, OUTER_ROWS);
  driver.surface.resize(OUTER_COLS, OUTER_ROWS);
  await driver.waitForOuterOutput(resizeOutputBefore, "the real Main redraws after restoring wide outer geometry");
  for (const session of initialSessions) {
    await driver.waitForRecords((records) => records.slice(resizeRecordCountBeforeRestore).some((record) =>
      record.type === "resize" && record.pid === session.record.pid && record.columns === 87 && record.rows === 49),
     `${session.rowProbe} receives a fresh restored 87x49 native geometry record`);
  }
  assert.equal(driver.focus, "main");

  const sharedGateDigestBeforeSettings = sha256(sharedGateConfigA);
  const afterCtrlC = driver.frameRevision;
  driver.pty.write(KEYS.ctrlC);
  await driver.waitFrame((text) => !text.includes(draftA), "native Ctrl+C clears A's draft before issuing a slash command", afterCtrlC);
  assert.equal(processIsAlive(sessionA.record.pid), true, "native Ctrl+C remains an editor action, not a host quit");
  // The native field's complete help line is wider than the 87-column pane.
  // Two explicit presses provide the verified full 120-column native surface:
  // the first only focuses the visible sidebar, the second deliberately hides
  // it. Never bundle presses that could silently hide a visible Main frame.
  await driver.toggleSidebar();
  assert.equal(driver.sidebarVisible, true,
    "the first explicit press focuses the visible sidebar instead of hiding it");
  await driver.toggleSidebar();
  assert.equal(driver.sidebarVisible, false,
    "the second explicit press hides the sidebar for the full native surface");
  await settingsSmoke(driver, sessionA, workspaceEditValue, editorMarker);
  await driver.writeAndWait(draftA, (text) => text.includes(draftA), "A can enter a fresh draft after its native settings transaction closes");
  assert.notEqual(sha256(sharedGateConfigA), sharedGateDigestBeforeSettings,
    "A's saved gate settings intentionally update the one shared native configuration file");
  const sharedGateSettings = JSON.parse(readFileSync(sharedGateConfigA, "utf8")) as {
    scheduledTasks?: Record<string, { name?: string; enabled?: boolean }>;
  };
  assert.ok(Object.values(sharedGateSettings.scheduledTasks ?? {}).some((task) => typeof task.name === "string"
    && task.name.startsWith(`native-main-${editorMarker}`) && task.enabled === false),
  "the shared saved settings contain A's disabled native fixture task");
  const afterSettingsRecords = driver.records();
  assert.equal(afterSettingsRecords.filter((record) => record.type === "agent_start").length, 2,
    "the settings/editor flow adds no turn beyond the two explicit local scripted seeds");
  assert.equal(afterSettingsRecords.filter((record) => record.type === "tool_call").length, 0,
    "the real settings/editor flow called no native tools");
  assert.ok(editorRecords(driver.editorLog).some((record) => record.type === "external-editor"
    && record.original !== record.value && record.value === workspaceEditValue),
  "the owned editor changed the field through the real Pi Ctrl+G action");

  await driver.activateRoster(labelB, draftB);
  assert.ok(driver.currentText().includes(draftB), "B's native chat draft survives A's settings/editor interaction");
  assert.ok(!driver.currentText().includes(draftA), "A's text is not copied into B");
  await driver.activateRoster(labelA, draftA);
  assert.ok(driver.currentText().includes(draftA), "A's native draft remains independent after switching back");

  await driver.closeNativeNormally(sessionA);
  assert.ok(driver.records().some((record) => record.type === "session_shutdown" && record.pid === sessionA.record.pid),
    "the actual public Pi session_shutdown lifecycle ran for A");
  await driver.activateRoster(labelB, draftB);
  assert.ok(driver.currentText().includes(draftB), "B's prompt survived A's normal native exit");
  const activeBHeaderBeforeARemoval = driver.currentText().split("\n")[0];
  await driver.removeExitedNativeSession(sessionA);
  assert.equal(driver.currentText().split("\n")[0], activeBHeaderBeforeARemoval,
    "removing inactive exited A preserves B as Main's active owner");
  assert.ok(driver.currentText().includes(draftB), "inactive A removal preserves B's unsent native draft");
  assert.equal(processIsAlive(sessionB.record.pid), true, "inactive A removal never stops B's live native process");
  assert.deepEqual(driver.sessions().map((session) => session.workspace), [workspaceB],
    "the current roster excludes removed A while retaining B");
  assert.equal(existsSync(sessionA.record.sessionFile!), true, "A's native conversation file survives row removal");
  assert.equal(existsSync(sessionB.record.sessionFile!), true, "B's native conversation file survives sibling removal");
  await driver.activateRoster(labelB, draftB);

  const originalBSessionId = sessionB.record.sessionId!;
  const bStartCountBeforeNew = driver.records().filter((record) => record.type === "session_start"
    && record.pid === sessionB.record.pid).length;
  await driver.writeAndWait(KEYS.ctrlC, (text) => !text.includes(draftB),
    "B's unsent draft is cleared before testing its native session commands");
  await driver.writeAndWait("/new", (text) => text.includes("/new"),
    "the real native Pi /new command is entered through B's editor");
  await driver.writeKeys(KEYS.enter, "the public native Pi /new command is submitted");
  const newSessionRecords = await driver.waitForRecords((records) => records.filter((record) => record.type === "session_start"
    && record.pid === sessionB.record.pid).length > bStartCountBeforeNew,
  "the real public /new action starts a new native conversation");
  const newBSession = newSessionRecords.filter((record) => record.type === "session_start"
    && record.pid === sessionB.record.pid).at(-1)!;
  assert.notEqual(newBSession.sessionId, originalBSessionId, "/new changes B's observed native conversation id");
  assert.notEqual(newBSession.sessionFile, sessionB.record.sessionFile, "/new gives B a distinct native conversation file");
  assert.equal(newBSession.displayName, "(no messages)", "/new exposes the native no-messages caption rather than a fabricated title");
  await driver.waitFrame((text) => text.includes(newBSession.displayName!),
    "Main renders the caption of the conversation actually created by /new");

  const bStartCountBeforeResume = driver.records().filter((record) => record.type === "session_start"
    && record.pid === sessionB.record.pid).length;
  const nativeResumeSelectsB = (text: string): boolean => text.includes("Resume Session (Current Folder)")
    && text.split("\n").some((line) => line.slice(33).trimStart().startsWith(`› ${labelB} `));
  await driver.writeAndWait("/resume", (text) => text.split("\n").some((line) => line.slice(33).trim() === "/resume"),
    "the exact public Pi /resume picker command is entered in B's native editor");
  await driver.writeAndWait(KEYS.enter, nativeResumeSelectsB,
    "Pi's real current-folder resume picker visibly highlights B's own saved native conversation");
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 2,
    "opening the public resume picker is not submitted as a model turn");
  assert.ok(nativeResumeSelectsB(driver.currentText()), "native resume selection names B before the explicit Enter action");
  driver.pty.write(KEYS.enter); // Select the observed native picker row, not a host roster row.
  const resumedRecords = await driver.waitForRecords((records) => {
    const starts = records.filter((record) => record.type === "session_start" && record.pid === sessionB.record.pid);
    const latest = starts.at(-1);
    return starts.length > bStartCountBeforeResume
      && latest?.sessionId === originalBSessionId && latest.displayName === labelB;
  },
  "the real public /resume action restores B's own observed native conversation and caption");
  const resumedBSession = resumedRecords.filter((record) => record.type === "session_start"
    && record.pid === sessionB.record.pid).at(-1)!;
  assert.equal(resumedBSession.sessionId, originalBSessionId, "/resume restores the original observed native conversation id");
  assert.equal(resumedBSession.sessionFile, sessionB.record.sessionFile, "/resume restores the original owned conversation file");
  assert.equal(resumedBSession.displayName, labelB, "/resume restores the actual persisted native caption");
  assert.equal(sessionFileHasStoredName(sessionB.record.sessionFile!, labelB), true,
    "the resumed conversation's own native session file retains its persisted title");
  await driver.waitFrame((text) => frameHeaderMatches(text, labelB),
    "Main's active header reflects the resumed native conversation caption");
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 2,
    "the public /new and /resume UI checks add no turn beyond the two local scripted seeds");
  assert.equal(driver.records().filter((record) => record.type === "tool_call").length, 0,
    "the public /new and /resume UI checks invoked no native tools");

  await driver.closeNativeNormally(sessionB);
  assert.ok(driver.records().some((record) => record.type === "session_shutdown" && record.pid === sessionB.record.pid),
    "the actual public Pi session_shutdown lifecycle ran for B");
  await driver.removeExitedNativeSession(sessionB);
  assert.equal(driver.sessions().length, 0, "the current Main roster is empty after active B's exited row is deleted");
  assert.deepEqual(driver.ownedSessions().map((session) => session.record.pid), [sessionA.record.pid, sessionB.record.pid],
    "both positively owned process records remain available for strict exit and cleanup evidence after row removal");
  assert.equal(driver.currentText().split("\n")[0]?.trimEnd(), "Session host",
    "deleting the active exited row clears Main ownership instead of implicitly selecting another session");
  assert.equal(processIsAlive(sessionB.record.pid), false, "active-row removal does not alter B's already-confirmed exit");
  assert.equal(existsSync(sessionA.record.sessionFile!), true, "A's persisted conversation remains after both row removals");
  assert.equal(existsSync(sessionB.record.sessionFile!), true, "B's persisted conversation remains after its row removal");

  const hostExit = await driver.finishHostNormally();
  assert.equal(hostExit.signal ?? 0, 0, "the public Main returned after every owned native child had exited normally");

  // Keep explicit local verification assertions close to the end-to-end proof.
  assert.equal(runtime.version, "1.1.0");
  assert.ok(runtime.piExecutable.endsWith(".js"), "the integration uses the pinned Node CLI entry, never a shell shim");
  assert.equal(candidate.entry, join(candidate.root, "dist", "src", "index.js"));
  assertionsCompleted = true;
});
