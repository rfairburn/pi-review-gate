/**
 * Real public Main lifecycle regressions (session-host native lifecycle phase).
 *
 * Four bounded cases share the owned-PTY Main harness from
 * tests/helpers/session-host-native-main-harness.ts and the same pinned real
 * Pi 1.0.4 runtime as the basic native Main proof:
 *
 * 1. A real offline scripted-provider (public pi.registerProvider + faux
 *    provider, zero external AI/API requests or credential copies)
 *    AskUserQuestion dispatched through the full native agent/gate/tool/TUI
 *    pipeline in child A — fresh sidebar pending-badge presence, answer
 *    through the real UI, fresh clearance after the answer turn and native
 *    completion transcript — while sibling child B stays an independent idle
 *    native session (A/B ownership isolation).
 * 2. External SIGTERM to the owned outer Main PTY with both native children
 *    still live: graceful shutdown of every owned child and full outer TTY
 *    restoration.
 * 3. The same proof for external SIGHUP.
 * 4. Confirmed Quit (real confirmation pane, the displayed choice) with both
 *    native children still live.
 *
 * Graceful-child proof chain (bounded-failure TERM/KILL cleanup and
 * process-gone alone never count): the manager-owned PTY's real public
 * @lydell/node-pty onExit event with exitCode 0 and no signal (observed by
 * the test-only runner wrapper on the exact module instance production
 * lazily loads) + the public session_shutdown lifecycle record + the kernel
 * EVFILT_PROC/NOTE_EXIT for the exact owned PID + runSessionHost return 0
 * with no forced cleanup. The kernel watcher proves process exit only:
 * NOTE_EXITSTATUS is valid only on child processes, and these native children
 * are grandchildren of the test, so the exit status comes from the PTY's own
 * public onExit event, never from the kernel.
 *
 * macOS owned-PTY scoped (same as the basic native Main proof); the signals
 * are direct process signals to the still-owned outer PTY, not physical
 * terminal disconnects or hardware restoration proofs. Test-only surface:
 * this file, the shared harness, and the existing uniquely named fixtures.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, watch as fsWatch, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ChangeSignal,
  CleanupOutcome,
  EVENT_TIMEOUT_MS,
  KEYS,
  MainPtyDriver,
  OBSERVER_FIXTURE,
  TEST_TIMEOUT_MS,
  type OwnedSession,
  type RuntimePin,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  makeRuntimeEnvironment,
  makeNativeAgentRoot,
  makeWorkspace,
  processIsAlive,
  removeOwnedScratchTreePruningTerraform,
  resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";

// Paced Main-lifecycle specialization of the scripted faux provider (public
// tokensPerSecond option): deterministic running window for the rendered
// sidebar observation. The standalone question fixture stays untouched.
const PROVIDER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-provider.cjs");

// --- Distinctive content markers for the scripted question and its answer ---
const QUESTION_TEXT = "Native question probe: which option should the fixture use?";
const CHOICE_A = "Alpha option";
const CHOICE_B = "Beta option";
const INITIAL_PROMPT = "Please ask me which option to use.";
const ECHO_PREFIX = "Fixture echo of delivered answer: ";

/** CSI for Ctrl+Alt+Up; pi-tui's matchesKey maps this to `ctrl+alt+up`. */
const KEY_CTRL_ALT_UP = "\x1b[1;7A";

// Guards the immutable startup-option contract and the fixture boundary.
const FORBIDDEN_SESSION_ARGS = new Set([
  "--session", "--session-id", "--sessionID", "--session-dir", "--no-session",
  "--continue", "--resume", "--fork",
]);

function sidebarPaneText(frame: string): string {
  return frame.split("\n").slice(1).map((line) => line.slice(0, 32)).join("\n");
}

function nativePaneText(frame: string): string {
  return frame.split("\n").slice(1).map((line) => line.slice(33)).join("\n");
}

/** Match wrapped native text without interleaved sidebar/divider columns. */
function frameContains(frame: string, needle: string): boolean {
  const collapse = (text: string): string => text.replace(/\s+/g, "");
  return collapse(nativePaneText(frame)).includes(collapse(needle));
}

function assertSidebarHasNoQuestionContent(frame: string): void {
  const sidebar = sidebarPaneText(frame);
  assert.ok(!sidebar.includes("Native question probe"),
    "the sidebar contains no question text, including clipped question text");
  assert.ok(!sidebar.includes("Please ask me"),
    "the sidebar contains no native prompt text");
  assert.ok(!sidebar.includes("Fixture echo"),
    "the sidebar contains no native answer transcript");
}

interface ProviderJournalRecord {
  event?: string;
  requestIndex?: number;
  lastUserPreview?: string;
  [key: string]: unknown;
}

function providerJournalRecords(path: string): ProviderJournalRecord[] {
  if (!existsSync(path)) return [];
  const records: ProviderJournalRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as ProviderJournalRecord);
    } catch {
      // An append may be observed between its write and trailing newline.
    }
  }
  return records;
}

function rowHasInputBadge(text: string, label: string): boolean {
  return sidebarPaneText(text).split("\n").some((line) => line.includes(label) && line.includes("[input]"));
}

/** The [AGENT: …] badge state of one owner's sidebar row, if rendered. */
function rowBadgeState(text: string, label: string): "running" | "idle" | "unknown" | undefined {
  const line = sidebarPaneText(text).split("\n").find((candidate) => candidate.includes(label) && candidate.includes("[AGENT:"));
  if (line === undefined) return undefined;
  if (line.includes("[AGENT: running]")) return "running";
  if (line.includes("[AGENT: idle]")) return "idle";
  if (line.includes("[AGENT: unknown]")) return "unknown";
  return undefined;
}

interface CaseState {
  scratch: string;
  driver?: MainPtyDriver;
  closeProviderWatch?: () => void;
  /** True only after every scenario assertion, including exit/restore. */
  assertionsCompleted?: boolean;
}

function registerCaseCleanup(t: { after(fn: () => Promise<void>): void }, state: CaseState): void {
  t.after(async () => {
    let cleanup: CleanupOutcome | undefined;
    if (state.driver) {
      try {
        cleanup = await state.driver.boundedCleanup();
      } catch {
        try { cleanup = await state.driver.forceCleanupAndObserve(); } catch {
          cleanup = state.driver.cleanupStatus(true);
        }
      } finally {
        state.driver.dispose();
      }
    }
    const cleanupConfirmed = cleanup?.childrenExited === true
      && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit
      && !cleanup.forced;
    // Preserve failed witnesses. The compatibility cleanup entry point also
    // retains successful runtime trees until positive per-entry ownership
    // receipts exist; root creation alone never authorizes recursive removal.
    if (state.assertionsCompleted === true && cleanupConfirmed) {
      try {
        if (!removeOwnedScratchTreePruningTerraform(state.scratch)) {
          process.stderr.write(`preserved Main runtime witness (per-entry ownership receipts unavailable): ${state.scratch}\n`);
        }
      } catch {
        process.stderr.write("preserved owned Main scratch: bounded cleanup could not positively remove every entry\n");
      }
    } else {
      const status = cleanup
        ? `childrenExited=${cleanup.childrenExited} shutdownEvents=${cleanup.shutdownEventsObserved} hostExited=${cleanup.hostExited} gracefulHostExit=${cleanup.gracefulHostExit} forced=${cleanup.forced}`
        : "cleanup status unavailable";
      process.stderr.write(`preserved owned Main scratch ${state.scratch}; assertionsCompleted=${state.assertionsCompleted === true}; ${status}\n`);
    }
    try { state.closeProviderWatch?.(); } catch { /* owned fixture-state directory watcher only */ }
  });
}

interface TwoChildSetup {
  runtime: RuntimePin;
  scratch: string;
  driver: MainPtyDriver;
  labelA: string;
  labelB: string;
  sessionA: OwnedSession;
  sessionB: OwnedSession;
}

/** Start the real public Main with two live, watched native children. */
async function startTwoLiveChildren(
  t: { skip(message?: string): void },
  state: CaseState,
): Promise<TwoChildSetup | undefined> {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return undefined;
  const scratch = state.scratch;
  const workspaceA = makeWorkspace(scratch, "workspace-a");
  const workspaceB = makeWorkspace(scratch, "workspace-b");
  const nativeAgentDir = makeNativeAgentRoot(scratch);
  const editorTarget = join(workspaceA, "editor-target");
  mkdirSync(editorTarget, { mode: 0o700 });
  const observerFile = join(scratch, "observer", "native-main.jsonl");
  const editorLog = createEditorLog(scratch);
  const editor = createEditorExecutable(scratch, editorTarget, editorLog);
  const candidate = compileAndStageCandidate(scratch);

  const startEnv = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");
  const args = ["--offline", "--no-context-files", "--no-themes", "--no-tools", "--extension", OBSERVER_FIXTURE];
  assert.equal(args.some((arg) => FORBIDDEN_SESSION_ARGS.has(arg)), false,
    "the real native sessions receive no forced/resumed/no-session override");

  const driver = await MainPtyDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    candidate,
    runtime,
    observerFile,
    editor,
    editorLog,
    editorValue: "",
    args,
    env: startEnv,
  });
  state.driver = driver;
  await driver.waitFrame((text) => text.includes("Welcome") && text.includes("New session") && text.includes("Quit host"),
    "fresh real Main displays its empty welcome/sidebar state");
  const suffix = Math.random().toString(16).slice(2, 8);
  const labelA = `A-${suffix}`;
  const labelB = `B-${suffix}`;
  const sessionA = await driver.createNativeSession(workspaceA);
  await driver.renameNativeSession(sessionA, labelA);
  const sessionB = await driver.createNativeSession(workspaceB);
  await driver.renameNativeSession(sessionB, labelB);
  assert.equal(sessionA.record.agentDir, nativeAgentDir, "A uses the fixture's shared normal native agent root");
  assert.equal(sessionB.record.agentDir, nativeAgentDir, "B uses the same shared normal native agent root");
  assert.notEqual(sessionA.record.pid, sessionB.record.pid, "the native children own distinct PIDs");
  assert.notEqual(sessionA.record.sessionId, sessionB.record.sessionId,
    "the shared native root still contains independently owned conversations");
  assert.notEqual(sessionA.record.sessionFile, sessionB.record.sessionFile,
    "each native child retains its own conversation file under shared discovery");
  assert.equal(sessionA.record.cwd, workspaceA, "A owns its explicitly selected workspace");
  assert.equal(sessionB.record.cwd, workspaceB, "B owns its explicitly selected workspace");
  for (const session of [sessionA, sessionB]) {
    assert.equal(session.record.tty, true, `${session.rowProbe} has its own real native PTY`);
    assert.deepEqual(session.record.credentialLikeEnvironmentNames, [],
      `${session.rowProbe} inherited no external credential-like environment variables`);
    assert.equal(processIsAlive(session.record.pid), true, `${session.rowProbe} is a live native child before the shutdown case`);
  }
  return { runtime, scratch, driver, labelA, labelB, sessionA, sessionB };
}

/** Assert the full graceful live-child shutdown evidence chain for both children. */
async function assertLiveChildShutdown(
  setup: TwoChildSetup,
  cause: string,
): Promise<void> {
  const { driver, sessionA, sessionB } = setup;
  const shutdownRecords = await driver.waitForRecords((records) => [sessionA, sessionB].every((session) =>
    records.some((record) => record.type === "session_shutdown" && record.pid === session.record.pid),
  ), `real A/B session_shutdown lifecycle events after ${cause}`);
  const signalShutdown = cause.includes("SIGTERM") || cause.includes("SIGHUP");
  // Both outer signals enter Main's graceful manager shutdown; native Pi may
  // report its quit disposition or the child-side SIGTERM. Never copy the
  // outer cause into this public native event.
  const allowedNativeReasons = signalShutdown ? new Set(["quit", "SIGTERM"]) : new Set(["quit"]);
  for (const session of [sessionA, sessionB]) {
    const shutdown = shutdownRecords.filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).at(-1);
    assert.ok(shutdown && allowedNativeReasons.has(shutdown.reason ?? ""),
      `${session.rowProbe} reports an observed native quit reason after ${cause}; got ${shutdown?.reason ?? "missing"}`);
  }
  await sessionA.exitWatcher.waitForExit(EVENT_TIMEOUT_MS);
  await sessionB.exitWatcher.waitForExit(EVENT_TIMEOUT_MS);
  assert.equal(sessionA.exitWatcher.observedExit, true,
    "A received the kernel EVFILT_PROC/NOTE_EXIT event for its exact owned PID");
  assert.equal(sessionB.exitWatcher.observedExit, true,
    "B received the kernel EVFILT_PROC/NOTE_EXIT event for its exact owned PID");
  // The host returns only after manager-owned onExit handling for every child;
  // wait for the outer exit before reading the runner's asynchronous onExit
  // journal records so a correct shutdown is never failed by append ordering.
  const exit = await driver.waitForNormalOuterExit();
  await driver.assertGracefulPtyExits([sessionA, sessionB]);
  assert.equal(exit.signal ?? 0, 0, `the outer Main PTY exited normally after ${cause}`);
}

test("real public Main dispatches a scripted AskUserQuestion with sidebar pending presence/clearance and A/B isolation", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return;

  const scratch = createOwnedScratchRoot();
  const state: CaseState = { scratch };
  registerCaseCleanup(t, state);

  const workspaceA = makeWorkspace(scratch, "workspace-a");
  const workspaceB = makeWorkspace(scratch, "workspace-b");
  const nativeAgentDir = makeNativeAgentRoot(scratch, { deferredPiTools: false });
  const editorTarget = join(workspaceA, "editor-target");
  mkdirSync(editorTarget, { mode: 0o700 });
  const observerFile = join(scratch, "observer", "native-main.jsonl");
  const editorLog = createEditorLog(scratch);
  const editor = createEditorExecutable(scratch, editorTarget, editorLog);
  const candidate = compileAndStageCandidate(scratch);

  // Scripted turn sequence for the faux provider (test-only fixture).
  const stateDir = join(scratch, "fixture-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const providerJournalFile = join(stateDir, "provider-journal.jsonl");
  const turnScript = {
    steps: [
      // Request 1 (initial prompt): ask the user through the real tool.
      {
        toolCalls: [{
          toolName: "AskUserQuestion",
          arguments: { question: QUESTION_TEXT, choices: [CHOICE_A, CHOICE_B], mode: "async" },
        }],
      },
      // Request 2 (tool result): continue without assuming an answer.
      { text: "Question recorded; continuing without assuming an answer." },
      // Request 3 (delivered answer as a user message): echo it back so the
      // test can prove the UI-delivered answer reached the model context.
      { echoLastUser: ECHO_PREFIX },
    ],
  };
  writeFileSync(join(stateDir, "turn-script.json"), JSON.stringify(turnScript), { mode: 0o600 });

  const startEnv = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  startEnv.PRG_FIXTURE_AGENT_DIR = runtime.agentDir;
  startEnv.PRG_FIXTURE_STATE_DIR = stateDir;
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");
  const args = [
    "--offline",
    "--no-context-files",
    "--no-skills",
    "--no-themes",
    "--extension",
    OBSERVER_FIXTURE,
    "--extension",
    PROVIDER_FIXTURE,
  ];
  assert.equal(args.some((arg) => FORBIDDEN_SESSION_ARGS.has(arg)), false,
    "the real native sessions receive no forced/resumed/no-session override");

  const driver = await MainPtyDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    candidate,
    runtime,
    observerFile,
    editor,
    editorLog,
    editorValue: "",
    args,
    env: startEnv,
  });
  state.driver = driver;

  await driver.waitFrame((text) => text.includes("Welcome") && text.includes("New session") && text.includes("Quit host"),
    "fresh real Main displays its empty welcome/sidebar state");
  // Short labels: the 32-column sidebar truncates owner labels to five
  // columns while a running row carries both badges, so only labels that fit
  // the smallest width can be matched against their real rendered rows.
  const labelA = "QA";
  const labelB = "QB";
  const sessionA = await driver.createNativeSession(workspaceA);
  assert.equal(sessionA.record.displayName, "(no messages)", "A begins with the actual native empty-conversation fallback");
  await driver.renameNativeSession(sessionA, labelA);
  const sessionB = await driver.createNativeSession(workspaceB);
  assert.equal(sessionB.record.displayName, "(no messages)", "B begins with the actual native empty-conversation fallback");
  await driver.renameNativeSession(sessionB, labelB);

  assert.equal(sessionA.record.agentDir, nativeAgentDir, "A uses the fixture's one shared normal native root");
  assert.equal(sessionB.record.agentDir, nativeAgentDir, "B uses the same shared normal native root");
  assert.notEqual(sessionA.record.pid, sessionB.record.pid, "the native children own distinct PIDs");
  assert.notEqual(sessionA.record.sessionId, sessionB.record.sessionId,
    "Pi's public native SessionManager generated distinct conversation ids");
  assert.notEqual(sessionA.record.sessionFile, sessionB.record.sessionFile,
    "the children keep independent conversation files under shared discovery");
  for (const session of [sessionA, sessionB]) {
    assert.equal(processIsAlive(session.record.pid), true, `${session.rowProbe} is a live native child`);
    assert.equal(session.record.tty, true, `each actual Pi process has a real owned PTY`);
    assert.deepEqual(session.record.credentialLikeEnvironmentNames, [],
      "the native process inherited no credential-like environment variables");
  }
  // AskUserQuestion is launch-active in both real gate sessions through the
  // shared native root's ordinary deferredPiTools:false config.
  assert.ok(Array.isArray(sessionA.record.activeTools) && sessionA.record.activeTools.includes("AskUserQuestion"),
    "AskUserQuestion is launch-active in A's real gate session");
  assert.ok(Array.isArray(sessionB.record.activeTools) && sessionB.record.activeTools.includes("AskUserQuestion"),
    "AskUserQuestion is launch-active in B's real gate session");

  // Both children auto-selected the scripted faux model (public setModel).
  const providerSignal = new ChangeSignal();
  const providerWatch = fsWatch(stateDir, (_event, filename) => {
    if (filename === null || filename.toString() === "provider-journal.jsonl") providerSignal.notify();
  });
  state.closeProviderWatch = () => providerWatch.close();
  await providerSignal.waitFor(
    () => providerJournalRecords(providerJournalFile).filter((record) => record.event === "auto_model_selected").length >= 2,
    EVENT_TIMEOUT_MS,
    "both real native children auto-selected the scripted faux model",
  );

  // Establish a distinctive B draft before the question flow so ownership
  // isolation can be proven against B's real native surface.
  const bDraft = "B-draft-isolation-probe";
  await driver.activateRoster(labelB);
  await driver.writeAndWait(bDraft, (text) => text.includes(bDraft),
    "B receives its own distinctive native editor draft");

  await driver.activateRoster(labelA);
  assert.ok(!rowHasInputBadge(driver.currentText(), labelA),
    "A's sidebar row shows no pending badge before any prompt (fresh idle state)");
  const beforePrompt = driver.frameRevision;
  await driver.writeAndWait(INITIAL_PROMPT, (text) => frameContains(text, INITIAL_PROMPT),
    "A receives the initial prompt as its native editor draft");
  await driver.writeKeys(KEYS.enter, "the initial prompt is submitted to A's real native Pi process");

  // First run: agent_start → real AskUserQuestion tool call in A only.
  await driver.waitForRecords((records) => records.some((record) => record.type === "agent_start"
    && record.pid === sessionA.record.pid), "first native agent run start in A");
  await driver.waitForRecords((records) => records.some((record) => record.type === "tool_call"
    && record.toolName === "AskUserQuestion" && record.pid === sessionA.record.pid),
    "real AskUserQuestion tool call executed in A's native process");

  // Fresh sidebar pending presence on A's row.
  await driver.waitFrame((text) => rowHasInputBadge(text, labelA),
    "the real Main sidebar shows the fresh [input] pending badge for A", beforePrompt);

  // The collapsed pending-question panel line is visible in A's native pane.
  const panelLine = process.platform === "darwin"
    ? "Pending questions · Press Ctrl+Option+Up"
    : "Pending questions · Press Ctrl+Alt+Up";
  await driver.waitFrame((frame) => frameContains(frame, panelLine),
    "real pending-question panel line in A's native frame", beforePrompt);
  assertSidebarHasNoQuestionContent(driver.currentText());

  // The first turn is async: the scripted continuation streams paced and may
  // still be running while q1 stays pending. Require its real settlement
  // boundary and a fresh rendered idle row — badge and panel still present —
  // before answering, so the UI answer starts a NEW ordinary native agent
  // turn instead of steering a busy run.
  const beforeFirstSettle = driver.frameRevision;
  await driver.waitForRecords((records) => records.some((record) => record.type === "agent_settled"
    && record.pid === sessionA.record.pid),
    "first public agent_settled boundary in A closes the pending-question turn");
  await driver.waitFrame((text) => rowBadgeState(text, labelA) === "idle"
    && rowHasInputBadge(text, labelA) && frameContains(text, panelLine),
    "A's sidebar row is fresh idle with q1 still pending before the answer", beforeFirstSettle);

  // Ownership isolation while A holds the pending question: switch to B
  // through the real roster; B keeps its own draft and neither surface nor
  // the sidebar carries A's question content.
  const beforeSwitchB = driver.frameRevision;
  await driver.activateRoster(labelB, bDraft);
  assert.ok(driver.frameRevision > beforeSwitchB, "the roster switch to B produced a fresh frame");
  assertSidebarHasNoQuestionContent(driver.currentText());
  assert.ok(!frameContains(driver.currentText(), QUESTION_TEXT),
    "A's pending question text does not leak into B's native surface or the sidebar while A holds it");
  assert.ok(!frameContains(driver.currentText(), INITIAL_PROMPT),
    "A's prompt does not leak into B's native surface or the sidebar");

  // Return to A with its pending-question surface intact.
  const beforeReturnA = driver.frameRevision;
  await driver.activateRoster(labelA);
  await driver.waitFrame((frame) => frameContains(frame, panelLine),
    "A's pending-question panel is still present after returning from B", beforeReturnA);
  assertSidebarHasNoQuestionContent(driver.currentText());

  // Open the real pending-question list through the public shortcut.
  const beforeList = driver.frameRevision;
  driver.pty.write(KEY_CTRL_ALT_UP);
  await driver.waitFrame((frame) => frameContains(frame, "Pending questions (1)")
    && frameContains(frame, `q1: ${QUESTION_TEXT}`)
    && frameContains(frame, "arrows select · Enter answer · Esc defer and close"),
    "real pending-question list opens with the scripted question", beforeList);

  // Enter answer mode.
  const beforeAnswer = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((frame) => frameContains(frame, `q1: ${QUESTION_TEXT}`)
    && frameContains(frame, `1. ${CHOICE_A}`)
    && frameContains(frame, `2. ${CHOICE_B}`)
    && frameContains(frame, "Type something…")
    && frameContains(frame, "Decline (no answer will be sent)")
    && frameContains(frame, "arrows select · Enter confirm · Esc back"),
    "real answer mode shows the scripted choices plus free text and decline", beforeAnswer);

  // Submit the approved canned choice.
  const beforeSubmit = driver.frameRevision;
  driver.pty.write(KEYS.enter);

  // Second ordinary native agent turn from the UI-delivered answer.
  await driver.waitForRecords((records) => records.filter((record) => record.type === "agent_start"
    && record.pid === sessionA.record.pid).length >= 2,
    "second native agent run start in A from the UI-delivered answer");

  // Fresh running observation for the answer turn.
  await driver.waitFrame((text) => rowBadgeState(text, labelA) === "running",
    "A's sidebar row shows the fresh [AGENT: running] state for the answer turn", beforeSubmit);
  const afterRunning = driver.frameRevision;

  // Native completion frame/transcript: delivered answer and its echo.
  await driver.waitFrame((frame) => frameContains(frame, `Answer to pending question "${QUESTION_TEXT}": ${CHOICE_A}`)
    && frameContains(frame, `${ECHO_PREFIX}Answer to pending question "${QUESTION_TEXT}": ${CHOICE_A}`),
    "delivered answer and its echo are visible in A's real native transcript", beforeSubmit);

  // Public settlement boundary for the answer turn: completion is proven by
  // the lifecycle event, never inferred from transcript text alone.
  await driver.waitForRecords((records) => records.filter((record) => record.type === "agent_settled"
    && record.pid === sessionA.record.pid).length >= 2,
    "second public agent_settled boundary in A closes the answer turn");

  // Fresh sidebar clearance after the observed running state: idle badge, no
  // pending badge, and the native pending panel removed.
  await driver.waitFrame((text) => rowBadgeState(text, labelA) === "idle"
    && !rowHasInputBadge(text, labelA) && !frameContains(text, panelLine),
    "the real Main sidebar clears A's [input] badge to idle after the answer turn", afterRunning);
  assertSidebarHasNoQuestionContent(driver.currentText());

  // B ownership isolation: no agent turns or tool calls despite shared setup.
  // Legitimate pane-resize observations from the roster switches are allowed;
  // any agent/tool activity would break the isolation contract.
  const bRecords = driver.records().filter((record) => record.pid === sessionB.record.pid);
  for (const record of bRecords) {
    assert.ok(record.type === "session_start" || record.type === "native_session_name" || record.type === "resize",
      `B's independent idle native child received only start/name/resize observations (saw ${record.type})`);
  }
  assert.deepEqual(bRecords.filter((record) => record.type === "native_session_name").map((record) => record.storedName), [labelB],
    "B's only additional lifecycle metadata is its own intentionally persisted native name");
  assert.equal(bRecords.filter((record) => record.type === "session_start").length, 1,
    "B observed exactly one session_start lifecycle event");
  assert.equal(sessionA.record.agentDir, sessionB.record.agentDir,
    "the question flow leaves both children on their shared native root");
  assert.ok(!JSON.stringify(driver.records()).includes(QUESTION_TEXT),
    "the native status-observation journal never captures question text as session-name metadata");

  // Faux provider journal: exactly three scripted requests, all from A; the
  // third carries the UI-delivered answer as an ordinary user message.
  const providerJournal = providerJournalRecords(providerJournalFile);
  const requests = providerJournal.filter((record) => record.event === "model_request");
  assert.equal(requests.length, 3, "exactly three scripted faux model requests (no external AI/API calls)");
  const answerRequest = requests[2];
  assert.ok(answerRequest, "the third request exists for the delivered answer");
  assert.ok(String(answerRequest.lastUserPreview ?? "").includes(`Answer to pending question "${QUESTION_TEXT}": ${CHOICE_A}`),
    "the UI-delivered answer reached A's model context as an ordinary user message");

  // Orderly completion: close A, then B, then quit the host.
  await driver.closeNativeNormally(sessionA);
  await driver.activateRoster(labelB);
  await driver.closeNativeNormally(sessionB);
  const hostExit = await driver.finishHostNormally();
  assert.equal(hostExit.signal ?? 0, 0, "the public Main returned after every owned native child had exited normally");
  state.assertionsCompleted = true;
});

test("external SIGTERM to the real public Main exits both live native children gracefully and restores the outer terminal", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const state: CaseState = { scratch: createOwnedScratchRoot() };
  registerCaseCleanup(t, state);
  const setup = await startTwoLiveChildren(t, state);
  if (!setup) return;

  assert.equal(processIsAlive(setup.sessionA.record.pid), true, "A is still alive before the external SIGTERM");
  assert.equal(processIsAlive(setup.sessionB.record.pid), true, "B is still alive before the external SIGTERM");
  setup.driver.pty.kill("SIGTERM"); // only the retained owned outer PTY handle
  await assertLiveChildShutdown(setup, "the external SIGTERM");
  state.assertionsCompleted = true;
});

test("external SIGHUP to the real public Main exits both live native children gracefully and restores the outer terminal", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const state: CaseState = { scratch: createOwnedScratchRoot() };
  registerCaseCleanup(t, state);
  const setup = await startTwoLiveChildren(t, state);
  if (!setup) return;

  assert.equal(processIsAlive(setup.sessionA.record.pid), true, "A is still alive before the external SIGHUP");
  assert.equal(processIsAlive(setup.sessionB.record.pid), true, "B is still alive before the external SIGHUP");
  setup.driver.pty.kill("SIGHUP"); // only the retained owned outer PTY handle
  await assertLiveChildShutdown(setup, "the external SIGHUP");
  state.assertionsCompleted = true;
});

test("confirmed Quit in the real public Main exits both live native children gracefully and restores the outer terminal", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const state: CaseState = { scratch: createOwnedScratchRoot() };
  registerCaseCleanup(t, state);
  const setup = await startTwoLiveChildren(t, state);
  if (!setup) return;

  assert.equal(processIsAlive(setup.sessionA.record.pid), true, "A is still alive before the confirmed Quit");
  assert.equal(processIsAlive(setup.sessionB.record.pid), true, "B is still alive before the confirmed Quit");
  await setup.driver.ensureSidebarFocus();
  // The 32-column sidebar truncates the confirmation lines; resize the owned
  // outer PTY to a narrow overlay width where the full confirmation renders,
  // and await both native resize observations before confirming.
  await setup.driver.setOuterSize(52, 50, [setup.sessionA, setup.sessionB], 52, 49);
  await setup.driver.moveRosterTo("Quit host");
  const beforeConfirm = setup.driver.frameRevision;
  setup.driver.pty.write(KEYS.enter);
  await setup.driver.waitFrame((text) => text.includes("Quit host?")
    && text.includes("2 session(s) starting, alive, or host-owned")
    && text.includes("enter/y = quit host | esc/n = cancel"),
    "the real Main confirmation pane opens with both live sessions counted", beforeConfirm);
  setup.driver.pty.write(KEYS.enter); // confirm the actually displayed choice (enter/y = quit host)
  await assertLiveChildShutdown(setup, "the confirmed Quit");
  state.assertionsCompleted = true;
});
