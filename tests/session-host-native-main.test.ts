import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  makeWorkspace,
  processIsAlive,
  removeOwnedScratchTreePruningTerraform,
  resolveRuntimePin,
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

  const profileConfig = join(session.record.agentDir!, "review-gate.json");
  const saved = JSON.parse(readFileSync(profileConfig, "utf8")) as {
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
    // Scratch is removed only after a fully successful body AND confirmed
    // graceful cleanup; any assertion failure preserves the 0700-owned tree
    // (even when cleanup itself was graceful) as test-debug evidence.
    if (scratchOwned && assertionsCompleted && cleanupConfirmed) {
      try {
        if (!removeOwnedScratchTreePruningTerraform(scratch)) {
          process.stderr.write("preserved owned Main scratch: a .terraform subtree was intentionally pruned from cleanup\n");
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

  const profilesRoot = join(scratch, "native-state", "profiles");
  const workspaceA = makeWorkspace(scratch, "workspace-a");
  const workspaceB = makeWorkspace(scratch, "workspace-b");
  const editorMarker = `editor-${Math.random().toString(16).slice(2, 8)}`;
  const workspaceEditTarget = join(workspaceA, editorMarker);
  mkdirSync(workspaceEditTarget, { mode: 0o700 });
  // A relative spelling stays out of absolute-path autocomplete while still
  // resolving inside A's explicitly owned workspace during save validation.
  const workspaceEditValue = `./${editorMarker}/`;
  const observerFile = join(scratch, "observer", "native-main.jsonl");
  const editorLog = createEditorLog(scratch);
  const editor = createEditorExecutable(scratch, workspaceEditTarget, editorLog);
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
  );
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
  assert.equal(existsSync(profilesRoot), false, "the initial empty welcome creates no session profile or observed native TUI child");
  assert.deepEqual(driver.records(), [], "no native lifecycle observer ran before an explicit New session");
  const suffix = Math.random().toString(16).slice(2, 8);
  const labelA = `A-${suffix}`;
  const labelB = `B-${suffix}`;
  const sessionA = await driver.createNativeSession(labelA, workspaceA);
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

  const sessionB = await driver.createNativeSession(labelB, workspaceB);
  assert.equal(driver.selected(labelB), true, "B is highlighted after asynchronous creation");
  assert.equal(driver.focus, "sidebar");
  const mainFrameA = join(sessionA.record.agentDir!, "review-gate.json");
  const mainFrameB = join(sessionB.record.agentDir!, "review-gate.json");
  assert.notEqual(sessionA.record.agentDir, sessionB.record.agentDir, "each native child owns a fresh private profile");
  assert.notEqual(sessionA.record.sessionId, sessionB.record.sessionId, "Pi's public native SessionManager generated distinct conversation ids");
  assert.ok(typeof sessionA.record.sessionId === "string" && sessionA.record.sessionId.length > 0);
  assert.ok(typeof sessionB.record.sessionId === "string" && sessionB.record.sessionId.length > 0);
  assert.equal(sessionA.record.cwd, workspaceA, "A runs in the explicitly selected canonical workspace");
  assert.equal(sessionB.record.cwd, workspaceB, "B runs in the explicitly selected canonical workspace");
  assert.equal(sessionA.record.agentDir!.startsWith(profilesRoot + sep), true, "A's profile is generated under the isolated state root");
  assert.equal(sessionB.record.agentDir!.startsWith(profilesRoot + sep), true, "B's profile is generated under the isolated state root");
  for (const session of [sessionA, sessionB]) {
    assert.equal(session.record.tty, true, "each actual Pi process has a real owned PTY");
    assert.deepEqual(session.record.credentialLikeEnvironmentNames, [], "the native process inherited no credential-like environment variables");
    assert.ok(session.record.sessionFile && isAbsolute(session.record.sessionFile), "Pi's public SessionManager reports its native session file");
  }
  const profileBDigestBeforeGateEdit = sha256(mainFrameB);

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
    `hiding the wide sidebar creates a fresh full-width 120x49 resize for ${session.label}`);
  }
  assert.equal(processIsAlive(bPid), true, "hiding the sidebar does not pause its native owner");
  const recordCountBeforeWideShow = driver.records().length;
  await driver.toggleSidebar();
  for (const session of initialSessions) {
    await driver.waitForRecords((records) => records.slice(recordCountBeforeWideShow).some((record) => record.type === "resize"
      && record.pid === session.record.pid && record.columns === 87 && record.rows === 49),
    `showing the wide sidebar creates a fresh 87x49 resize for ${session.label}`);
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
    `${session.label} receives a fresh restored 87x49 native geometry record`);
  }
  assert.equal(driver.focus, "main");

  const profileBDigestBeforeSettings = sha256(mainFrameB);
  assert.equal(profileBDigestBeforeSettings, profileBDigestBeforeGateEdit,
    "B's native settings file remains unchanged before editing A");
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
  assert.equal(sha256(mainFrameB), profileBDigestBeforeSettings,
    "A's saved review-gate settings did not change B's independent profile file");
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
  await driver.closeNativeNormally(sessionB);
  assert.ok(driver.records().some((record) => record.type === "session_shutdown" && record.pid === sessionB.record.pid),
    "the actual public Pi session_shutdown lifecycle ran for B");

  const hostExit = await driver.finishHostNormally();
  assert.equal(hostExit.signal ?? 0, 0, "the public Main returned after every owned native child had exited normally");

  // Keep explicit local verification assertions close to the end-to-end proof.
  assert.equal(runtime.version, "1.0.4");
  assert.ok(runtime.piExecutable.endsWith(".js"), "the integration uses the pinned Node CLI entry, never a shell shim");
  assert.equal(candidate.entry, join(candidate.root, "dist", "src", "index.js"));
  assertionsCompleted = true;
});
