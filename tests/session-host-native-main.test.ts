import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import test from "node:test";

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
  sessionFileHasStoredName,
  sha256,
} from "./helpers/session-host-native-main-harness";

// Scope boundary: this is an owned virtual-PTY proof of the public Main API,
// not a physical-keyboard or full-CLI test. The question flow and live-child
// SIGTERM/SIGHUP/quit regressions live in
// tests/session-host-native-main-lifecycle.test.ts on the same harness.

async function settingsSmoke(driver: MainPtyDriver, session: OwnedSession, workspaceEditValue: string, editorMarker: string): Promise<void> {
  assert.equal(driver.focus, "main");
  const beforeCommand = driver.frameRevision;
  driver.pty.write("/review-settings");
  await driver.waitFrame((text) => text.includes("/review-settings"),
    "A's real native command draft is visible before Enter", beforeCommand);
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

// Guards the immutable startup-option contract as well as this alpha's
// no-provider/no-session-override fixture boundary.
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
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");
  const args = ["--offline", "--no-context-files", "--no-themes", "--no-tools", "--extension", OBSERVER_FIXTURE];
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
  const unselectedGuard = `focusGuard${suffix}`;
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
  driver.pty.write(`highlightOnly${suffix}`);
  await driver.waitForFrameQuiet("B's highlight-only input is followed by a bounded stable frame");
  const afterUnselectedBGuard = driver.currentText();
  assert.ok(!afterUnselectedBGuard.includes(`highlightOnly${suffix}`),
    `B's highlight-only input never appears in the native child or host frame:\n${afterUnselectedBGuard.slice(-1_000)}`);
  assert.ok(afterUnselectedBGuard.includes("Welcome"), "B remains only highlighted in the empty Main view");
  await driver.activateRoster(labelB);
  const initialSessions = [sessionA, sessionB];
  for (const session of initialSessions) {
    assert.equal(session.record.columns, 87, "the outer wide sidebar rectangle determines the initial native child width");
    assert.equal(session.record.rows, 49, "the native child excludes the outer header row");
    assert.equal(processIsAlive(session.record.pid), true, "the native child remains independently alive while another row is selected");
  }

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
  const wrappedHints = driver.currentText().replace(/\s+/g, " ");
  for (const hint of ["enter create", "esc cancel", "tab complete", "ctrl+c clear", "ctrl+g external editor"]) {
    assert.ok(wrappedHints.includes(hint), `the narrow New form keeps its wrapped ${hint} hint readable`);
  }
  await driver.setOuterSize(24, 5, initialSessions, 24, 4);
  assert.ok(driver.currentText().includes("too small"),
    "the real New form falls back to its bounded tiny-pane message without fabricating a field");
  await driver.setOuterSize(52, 30, initialSessions, 52, 29);
  assert.ok(driver.currentText().includes("Workspace:"), "the New form returns after restoring usable geometry");
  await driver.clearWorkspaceField("the native clear binding empties B's retained workspace before filesystem completion");
  const partialWorkspace = join(scratch, "workspace-new-");
  await driver.writeAndWait(partialWorkspace, (text) => text.includes(partialWorkspace.slice(-18)),
    "the New form's real workspace Editor accepts an absolute fixture-only completion prefix");
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
  const beforeFormCancel = driver.frameRevision;
  driver.pty.write(KEYS.escape);
  driver.focus = "main";
  driver.sidebarVisible = false;
  await driver.waitFrame((text) => !text.includes("New session") && !text.includes("Workspace:"),
    "the second Escape cancels New and returns focus to B", beforeFormCancel);
  assert.ok(driver.currentText().includes(draftB), "canceling New restores B's unchanged native prompt draft");
  assert.equal(processIsAlive(bPid), true, "canceling New never stops B's native process");
  await driver.toggleSidebar();
  await driver.setOuterSize(OUTER_COLS, OUTER_ROWS, initialSessions, 87, 49);
  await driver.activateRoster(labelB, draftB);

  await driver.writeAndWait("qQ", (text) => text.includes(`${draftB}qQ`), "native q/Q are forwarded unchanged in Main focus");
  const beforeEscape = driver.frameRevision;
  driver.pty.write(KEYS.escape);
  await driver.waitFrame((text) => text.includes("New session") && text.includes("Quit host"),
    "native Escape is forwarded without hiding the still-visible host sidebar", beforeEscape);
  assert.equal(driver.focus, "main", "Escape did not move Main ownership to the sidebar");
  assert.equal(processIsAlive(bPid), true, "native q/Q/Escape did not quit or pause B");
  await driver.writeAndWait(KEYS.ctrlC, (text) => !text.includes(`${draftB}qQ`),
    "one native Ctrl+C clears the actual Pi prompt instead of quitting Main");
  assert.equal(processIsAlive(bPid), true, "a single native Ctrl+C clears the editor but leaves the native Pi child alive");
  assert.equal(driver.exitEvent, undefined, "native Ctrl+C did not become a host-wide quit");
  await driver.writeAndWait(draftB, (text) => text.includes(draftB), "B's private draft is re-entered for focus-retention checks");

  const recordCountBeforeWideHide = driver.records().length;
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

  await driver.toggleSidebar();
  assert.ok(driver.currentText().includes(draftA), "A's draft remains intact when F8 hides the sidebar");
  assert.equal(processIsAlive(sessionA.record.pid), true, "the actual F8 press is consumed by Main while A's child stays alive");
  await driver.toggleSidebar();
  assert.ok(driver.currentText().includes(draftA), "F8 reopens the sidebar without altering A's native draft");
  await driver.moveRosterTo(labelB);
  assert.ok(driver.currentText().includes(draftA), "highlighting B does not reroute A's native input");
  const beforeSelectB = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "main";
  await driver.waitFrame((text) => text.includes(draftB) && !text.includes(draftA),
    "only explicit Enter returns ownership to B while both native drafts remain private", beforeSelectB);

  await driver.setOuterSize(100, 30, initialSessions, 67, 29);
  assert.equal(driver.surface.frame().cols, 100, "the real outer PTY and terminal emulator observe the resized outer width");
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
  await driver.waitFrame((text) => text.includes("Session host · ") && !text.includes("New session"),
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
  // Hide the roster to provide the verified full 120-column native surface;
  // do not mistake legitimate native clipping for a missing editor feature.
  await driver.toggleSidebar();
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
  assert.equal(afterSettingsRecords.filter((record) => record.type === "agent_start").length, 0,
    "no native model turn or external API request was started");
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
  await driver.writeAndWait(`/resume ${originalBSessionId}`, (text) => text.includes(originalBSessionId),
    "the real native Pi /resume command targets B's own previously observed session id");
  await driver.writeKeys(KEYS.enter, "the public native Pi /resume command is submitted through the native UI");
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
  await driver.waitFrame((text) => text.split("\n")[0]?.includes(`Session host · ${labelB} ·`) === true,
    "Main's active header reflects the resumed native conversation caption");
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 0,
    "the public /new and /resume UI checks started no native model turn");
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
  assert.equal(runtime.version, "1.0.4");
  assert.ok(runtime.piExecutable.endsWith(".js"), "the integration uses the pinned Node CLI entry, never a shell shim");
  assert.equal(candidate.entry, join(candidate.root, "dist", "src", "index.js"));
  assertionsCompleted = true;
});
