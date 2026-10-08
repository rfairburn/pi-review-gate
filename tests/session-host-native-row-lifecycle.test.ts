/**
 * Real public Pi 1.1.0 POSIX (macOS/Linux; Windows ConPTY is a separate
 * acceptance) native row-lifecycle acceptance for followup #323/PR328:
 *
 * - Two independently live native children share one ordinary agent dir in
 *   separate workspaces; switching, F8 hide/show, and Space expansion never
 *   stop either child.
 * - A genuine scripted-provider user turn saves conversation A; public /new
 *   rebinds the same process to current C (distinct ID/file) and a second
 *   genuine turn saves C; the observer binding history is A then C.
 * - Public native quit exits A (exact PTY + kernel 0); the exited placeholder
 *   remains. ENTER on it runs a fresh catalog/admission/revalidation and
 *   resumes CURRENT C as a new independently owned child in the same cwd —
 *   never the original process, PID, or newest-guessed conversation.
 * - Exiting a positively never-saved /new binding and ENTERing its placeholder
 *   starts a fresh conversation with a new opaque ID in the exact same
 *   workspace, with no synthetic messages and no fabricated session file.
 * - Main-focus d stays native text; sidebar d stops only the exact selected
 *   row: positive complete idleness stops directly, otherwise the frozen
 *   confirmation is cancelled once and then confirmed only after the full
 *   warning is drawn. Stopping one row keeps the live sibling's original
 *   handle, auto-activates nothing, and deletes no saved file.
 *
 * Every child exit is witnessed by its public PTY onExit (code 0, no signal)
 * plus the retained exact-PID kernel watcher; the outer host restores fully
 * with no force attempt and no outer cleanup signal.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";

import { SidebarController, type SidebarAction } from "../src/session-host/sidebar";

import {
  KEYS,
  OUTER_COLS,
  OUTER_ROWS,
  OBSERVER_FIXTURE,
  PROVIDER_FIXTURE,
  SavedMainDriver,
  TEST_TIMEOUT_MS,
  assertNoForbiddenSessionArgs,
  canonicalWorkspace,
  createSavedMainAgentRoot,
  createSavedMainCandidate,
  createSavedMainChildEnvironment,
  createSavedMainEditor,
  createSavedMainScratchRoot,
  createSavedMainWorkspace,
  currentBinding,
  findBinding,
  frameHeader,
  getWorkspaceFieldValue,
  isEmptyWorkspaceField,
  isQuitConfirmationFrame,
  isSidebarFocusedFrame,
  nativeFormFieldIsEmpty,
  originalNodeOptions,
  processIsAlive,
  processIsStillOwnedAndLive,
  ptyJournalHasForceAttempt,
  ptySpawnCount,
  parseRosterFrame,
  readOwnedJsonl,
  renderedTitleMatches,
  requirePublicRuntimeDependencies,
  rosterEntries,
  selectedRosterEntry,
  sessionFileHasStoredName,
  shortBaselineFitsTwentyFourColumns,
  sidebarRosterHidden,
  validateSharedRuntimeEnvironment,
  workspaceOnlyNewFrame,
  type ConversationBinding,
  type JournalSnapshot,
  type ProcessIncarnation,
  type RosterEntry,
  type SessionRecord,
} from "./helpers/session-host-native-saved-main-harness";
import {
  assertRowLifecycleCallerAdmission,
  hasStopRemoveConfirmationContents,
  isStopRemoveConfirmationFrame,
  isCompleteMainFocusedRoster,
  resolveRowLifecycleRuntimePin,
} from "./helpers/session-host-native-row-lifecycle";

interface ProviderRecord {
  readonly event?: string;
  readonly requestIndex?: number;
  readonly lastUserPreview?: string;
}

/** The exact revalidation-race notice the host shows when a rendered-idle stop is refused. */
const STOP_REPRESS_NOTICE = "Press d again to confirm stopping this session";

function isCompleteRosterFrame(text: string): boolean {
  return parseRosterFrame(text, 32).complete;
}

function nativeCardCount(text: string): number {
  return rosterEntries(text).filter((entry) => entry.kind === "native").length;
}

function isSidebarFocus(text: string): boolean {
  return isSidebarFocusedFrame(text, 32);
}

function selectedPosition(text: string): number | undefined {
  return selectedRosterEntry(text)?.position;
}

function exactCurrentHeader(driver: SavedMainDriver): string {
  return driver.currentText().split("\n")[0] ?? "";
}

/** Status row text of a native card, or undefined for an action/absent entry. */
function entryStatus(entry: RosterEntry | undefined): string | undefined {
  return entry !== undefined && entry.kind === "native" ? entry.status : undefined;
}

/** Title of a native card, or undefined for an action/absent entry. */
function renderedTitleOf(entry: RosterEntry | undefined): string | undefined {
  return entry !== undefined && entry.kind === "native" ? entry.title : undefined;
}

function sessionStarts(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((record) => record.type === "session_start");
}

async function assertNoStartsAfter(driver: SavedMainDriver, snapshot: JournalSnapshot, description: string): Promise<void> {
  await driver.ptySignal.waitForQuiet(() => driver.ptyRecords().slice(snapshot.ptyOffset)
    .some((record) => ["pty_spawn", "force_attempt", "pty_observation_failed"].includes(record.type)),
  300, `${description}: no new public PTY spawn/force evidence`);
  await driver.journalSignal.waitForQuiet(() => driver.records().slice(snapshot.observerOffset)
    .some((record) => ["session_start", "session_shutdown", "agent_start", "agent_settled"].includes(record.type)),
  300, `${description}: no new public Pi process/agent lifecycle event`);
}

async function ensureSidebarFocus(driver: SavedMainDriver): Promise<void> {
  // Never infer focus from a partially repainted header or missing footer.
  // Activation itself waits for the complete Main footer before this helper
  // can observe it; no toggle flapping is needed to guess the focus domain.
  await driver.waitFrame((text) => isSidebarFocus(text)
    || isCompleteMainFocusedRoster(text) || sidebarRosterHidden(text),
  "the complete existing focus domain is rendered before a reserved focus shortcut");
  const text = driver.currentText();
  if (isSidebarFocus(text)) return;
  const visible = isCompleteRosterFrame(text);
  const snapshot = driver.snapshot();
  driver.pty.write(KEYS.f8);
  await driver.waitFrame(isSidebarFocus, visible
    ? "one F8 press focuses the completely rendered visible Main-focused sidebar without hiding it"
    : "one F8 press shows and completely focuses the hidden sidebar", snapshot.frameRevision);
  assert.ok(isSidebarFocus(driver.currentText()), "actual rendered sidebar-only footer establishes host focus");
}

async function moveRosterToPosition(driver: SavedMainDriver, targetPosition: number): Promise<void> {
  const initial = rosterEntries(driver.currentText());
  assert.ok(initial[targetPosition], `visible roster position ${targetPosition} exists before targeting`);
  let selected = selectedRosterEntry(driver.currentText());
  if (!selected) {
    const snapshot = driver.snapshot();
    const header = exactCurrentHeader(driver);
    driver.pty.write(KEYS.down);
    await driver.waitFrame((text) => selectedPosition(text) === 0 && (text.split("\n")[0] ?? "") === header,
      "one genuine Down establishes a fresh visible roster highlight without activation",
      snapshot.frameRevision);
    await assertNoStartsAfter(driver, snapshot, "establishing a roster highlight");
    selected = selectedRosterEntry(driver.currentText());
  }
  assert.ok(selected, "a real highlighted roster entry is observed before navigation");
  const count = initial.length;
  let remaining = (targetPosition - selected!.position + count) % count;
  const direction = remaining <= count / 2 ? 1 : -1;
  if (direction < 0) remaining = count - remaining;
  for (let step = 0; step < remaining; step += 1) {
    selected = selectedRosterEntry(driver.currentText());
    assert.ok(selected, "the current visible roster position is re-observed before each key");
    const nextPosition = (selected!.position + direction + count) % count;
    const snapshot = driver.snapshot();
    driver.pty.write(direction > 0 ? KEYS.down : KEYS.up);
    await driver.waitFrame((text) => isCompleteRosterFrame(text)
      && rosterEntries(text).length === count && selectedPosition(text) === nextPosition,
    `one genuine roster arrow completely paints selection at visible position ${nextPosition}`, snapshot.frameRevision);
    assert.equal(rosterEntries(driver.currentText()).length, count,
      "roster navigation did not create, remove, or adopt a row");
    await assertNoStartsAfter(driver, snapshot, "roster arrow navigation");
  }
  assert.equal(selectedPosition(driver.currentText()), targetPosition,
    "the exact visible roster position, not a caption-only match, is highlighted");
}

async function moveRosterToAction(driver: SavedMainDriver, label: "Saved conversations" | "New session" | "Quit host"): Promise<number> {
  await ensureSidebarFocus(driver);
  const entry = rosterEntries(driver.currentText()).find((candidate) => candidate.label === label);
  assert.ok(entry, `the actual roster visibly contains ${label}`);
  await moveRosterToPosition(driver, entry!.position);
  assert.equal(selectedRosterEntry(driver.currentText())?.label, label,
    `the exact public host action ${label} is highlighted before Enter`);
  return entry!.position;
}

async function activateRow(driver: SavedMainDriver, position: number, expectedHeader: string): Promise<void> {
  await ensureSidebarFocus(driver);
  await moveRosterToPosition(driver, position);
  const selected = selectedRosterEntry(driver.currentText());
  assert.ok(selected, "the target row remains visibly highlighted before explicit activation");
  const before = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => frameHeader(text) === expectedHeader
    && isCompleteMainFocusedRoster(text)
    && text.split("\n").slice(1).map((line) => line.slice(33)).join("\n").includes(`• ${expectedHeader}`),
    "a deliberate host-row Enter completely paints the exact owner header, native name footer, roster, and Main-focus hints", before.frameRevision);
}

async function renameRow(
  driver: SavedMainDriver,
  process: ProcessIncarnation,
  binding: ConversationBinding,
  name: string,
): Promise<void> {
  await ensureSidebarFocus(driver);
  assert.ok(process.rosterPosition !== undefined, "the process row was correlated to a visible position at genuine creation");
  await moveRosterToPosition(driver, process.rosterPosition!);
  const beforeEdit = driver.snapshot();
  driver.pty.write("e");
  await driver.waitFrame((text) => text.includes("Edit native session name") && text.includes("> New name:")
    && nativeFormFieldIsEmpty(text, "> New name:"),
  "the actual host Edit form opens with a genuinely empty replacement field", beforeEdit.frameRevision);
  await driver.writeAndWait(name, (text) => text.includes(name),
    "the deliberate canonical name is typed through the actual Edit field");
  const beforeSave = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const records = await driver.waitForRecords((fresh) => fresh.some((record) =>
    record.type === "native_session_name" && record.pid === process.pid && record.cwd === process.cwd
      && record.sessionId === binding.sessionId && record.storedName === name),
  "the real public SessionManager freshly reports the exact renamed conversation", beforeSave.observerOffset);
  const nameRecord = records.slice(beforeSave.observerOffset).filter((record) => record.type === "native_session_name"
    && record.pid === process.pid && record.cwd === process.cwd
    && record.sessionId === binding.sessionId && record.storedName === name).at(-1);
  assert.ok(nameRecord, "native_session_name metadata came from the actual public observer fixture");
  driver.ledger.appendNativeName(process, nameRecord!, records.indexOf(nameRecord!));
  await driver.waitFrame((text) => isSidebarFocus(text)
    && selectedRosterEntry(text)?.position === process.rosterPosition
    && selectedRosterEntry(text)?.label === name,
  "the host row shows the exact actual canonical name after Edit completion", beforeSave.frameRevision);
  await driver.assertNoNewPtyRecords(beforeSave, "native rename does not create another child PTY");
}

async function submitWorkspaceOnlyNew(
  driver: SavedMainDriver,
  scratch: string,
  prefix: string,
  workspace: string,
  previousWorkspaceDraft = "",
): Promise<{ process: ProcessIncarnation; binding: ConversationBinding }> {
  await moveRosterToAction(driver, "New session");
  const beforeOpen = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => workspaceOnlyNewFrame(text)
    && getWorkspaceFieldValue(text) === previousWorkspaceDraft,
    "the genuine Workspace-only New form completely paints its expected initial or retained draft", beforeOpen.frameRevision);
  if (previousWorkspaceDraft !== "") {
    // New retains its prior workspace draft. Clear it through the real Editor,
    // not by changing that existing behavior or injecting an editor value.
    const beforeClear = driver.snapshot();
    driver.pty.write(KEYS.ctrlC);
    await driver.waitFrame((text) => workspaceOnlyNewFrame(text)
      && isEmptyWorkspaceField(text) && getWorkspaceFieldValue(text) === "",
    "one deliberate form-owned Ctrl+C clears the retained workspace draft without closing New", beforeClear.frameRevision);
    await assertNoStartsAfter(driver, beforeClear, "clearing the New workspace draft");
  }
  assert.equal(isEmptyWorkspaceField(driver.currentText()), true,
    "the exact native bordered Workspace field body is empty before the next workspace prefix");

  const beforePrefix = driver.snapshot();
  await driver.writeAndWait(prefix, (text) => text.includes(prefix),
    "the canonical workspace prefix is typed through Pi's real native Editor");
  const basename = workspace.slice(workspace.lastIndexOf(sep) + 1);
  await driver.waitFrame((text) => workspaceOnlyNewFrame(text) && text.includes(basename),
    "the native filesystem provider displays the owned workspace completion", beforePrefix.frameRevision);
  assert.equal(getWorkspaceFieldValue(driver.currentText()), prefix,
    "the bordered New field contains the literal typed prefix before accepting completion");

  const beforeCompletionEnter = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => workspaceOnlyNewFrame(text)
    && getWorkspaceFieldValue(text) === `${workspace}/`,
  "the first genuine Enter accepts the exact owned folder while New remains open", beforeCompletionEnter.frameRevision);

  const beforeSubmit = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const process = await driver.awaitSpawn(beforeSubmit, workspace);
  const binding = await driver.awaitSessionStart(process, beforeSubmit,
    (record) => record.cwd === workspace && record.displayName === "(no messages)");
  await driver.waitFrame((text) => frameHeader(text) === "(no messages)"
    && isCompleteMainFocusedRoster(text)
    && selectedRosterEntry(text)?.label === "(no messages)",
  "the genuine New completion activates the fresh no-messages row as the Main input owner", beforeSubmit.frameRevision);
  const selected = selectedRosterEntry(driver.currentText());
  assert.ok(selected, "the completed New process is tied to its actual active highlight");
  driver.ledger.setRosterPosition(process, selected!.position);
  assert.equal(processIsAlive(process.pid), true, "the exact public PTY-owned process is live after creation");
  assert.equal(process.cwd, workspace);
  assert.equal(binding.cwd, workspace);
  assert.equal(existsSync(binding.sessionFile), false,
    "the native planned session file remains absent before any real user turn");
  return { process, binding };
}

test("row-lifecycle admission rejects original role/catalog case aliases", () => {
  for (const canonical of ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"]) {
    for (const name of [canonical, canonical.toLowerCase(), `Pi${canonical.slice(2)}`]) {
      for (const value of ["executor", ""]) {
        assert.throws(() => assertRowLifecycleCallerAdmission({ [name]: value }),
          /rejects the actual delegated role\/catalog markers/);
      }
    }
  }
  assert.doesNotThrow(() => assertRowLifecycleCallerAdmission({ NODE_OPTIONS: "--enable-source-maps" }));
});

test("row-lifecycle activation witness rejects old or mixed focus footers", () => {
  const controller = new SidebarController({ toggleKey: "f8" });
  controller.updateItems([{
    id: "focus-owner", label: "F8 toggle | enter open", workspace: "/owned/focus", agentDir: "/owned/agent",
    lifecycle: "alive", hasLiveProcess: true, busy: false, pendingInput: false, inputSurface: false,
    backgroundTasks: 0, backgroundShells: 0, activity: [],
  }]);
  controller.select("focus-owner");
  const sidebarFrame = controller.renderRoster(32, 50).lines.join("\n");
  assert.equal(isCompleteMainFocusedRoster(sidebarFrame), false,
    "a caption that imitates the Main footer and a complete sidebar-focus roster do not establish Main focus");
  controller.handleInput(KEYS.enter);
  const mainFrame = controller.renderRoster(32, 50).lines.join("\n");
  assert.equal(isCompleteMainFocusedRoster(mainFrame), true);
  assert.equal(isCompleteMainFocusedRoster(`${mainFrame}\ne edit name | d stop/remove`), false,
    "stale sidebar-focus hints cannot coexist with a completed Main-focus witness");
  assert.equal(isCompleteMainFocusedRoster(mainFrame.replace("esc hide | q quit", "")), false,
    "a partial Main footer is not completed activation");
});

test("public SidebarController renders the complete frozen Stop confirmation at the 32-column sidebar width", () => {
  const controller = new SidebarController();
  controller.updateItems([{
    id: "row-lifecycle-a3",
    label: "(no messages)",
    workspace: "/owned/workspace",
    agentDir: "/owned/native-agent",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
  }]);
  // Explicitly select the fixture row and paint the complete roster so the
  // deliberate d targets it (the initial highlight is a host action, not the row).
  controller.select("row-lifecycle-a3");
  controller.renderRoster(32, 50);
  assert.equal(controller.focus, "sidebar", "the actual public controller starts on the visible roster");
  controller.handleInput("d");
  assert.equal(controller.focus, "confirm",
    "a non-idle or unknown live row freezes an explicit Stop confirmation instead of stopping directly");
  const rendered = controller.render(32, 50);
  assert.equal(hasStopRemoveConfirmationContents(rendered.lines), true,
    "the 32-column public renderer preserves the full wrapped stop warning and both complete hints (joined into one row at this width)");
  const composedFrame = ["Session host", ...rendered.lines.map((line) =>
    `${line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 32).padEnd(32)}│native surface`)].join("\n");
  assert.equal(isStopRemoveConfirmationFrame(composedFrame), true,
    "the native-frame predicate reads only the rendered 32-column sidebar, not Main's wider content pane");
});

test("public SidebarController stops a positively idle live row directly without opening a confirmation", () => {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({ onAction: (action) => actions.push(action) });
  controller.updateItems([{
    id: "row-lifecycle-idle",
    label: "RowA-idle",
    workspace: "/owned/workspace",
    agentDir: "/owned/native-agent",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: false,
    pendingInput: false,
    inputSurface: false,
    backgroundTasks: 0,
    backgroundShells: 0,
    activity: [],
  }]);
  // Explicitly select the fixture row and paint the complete roster so the
  // deliberate d targets it (the initial highlight is a host action, not the row).
  controller.select("row-lifecycle-idle");
  controller.renderRoster(32, 50);
  controller.handleInput("d");
  assert.equal(controller.focus, "sidebar",
    "a positively complete-idle row never opens the frozen stop confirmation");
  assert.deepEqual(actions.filter((action) => action.type === "stop-remove"),
    [{ type: "stop-remove", id: "row-lifecycle-idle", confirmed: false }],
  "the public controller requests the exact-row stop directly and leaves fresh-idle revalidation to the parent");
});

test("real public Main proves current-binding exited-restart and isolated d-stop row lifecycle", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRowLifecycleRuntimePin(t);
  if (!runtime) return;
  requirePublicRuntimeDependencies(runtime);
  assert.equal(shortBaselineFitsTwentyFourColumns(), true,
    "the complete primary-screen witness fits in a 24-column terminal baseline");
  assert.equal(runtime.version, "1.1.0", "the row-lifecycle proof pins the actual public Pi 1.1.0 runtime");

  const suffix = Math.random().toString(16).slice(2, 8);
  const nameA = `RowA-${suffix}`;
  const nameB = `RowB-${suffix}`;
  const nameC = `RowC-${suffix}`;
  const promptA = `row-lifecycle-a-turn-${suffix}`;
  const responseA = `row-response:${promptA}`;
  const promptC = `row-lifecycle-c-turn-${suffix}`;
  const responseC = `row-response:${promptC}`;
  // B's distinctive unsubmitted native draft: the ownership witness that must
  // survive A's restart and the isolated d-stop without focus seizure.
  const bDraft = `row-b-draft-${suffix}`;

  const scratch = createSavedMainScratchRoot();
  const workspaceA = canonicalWorkspace(createSavedMainWorkspace(scratch, `row-lifecycle-a-${suffix}`));
  const workspaceB = canonicalWorkspace(createSavedMainWorkspace(scratch, `row-lifecycle-b-${suffix}`));
  const isolatedHome = join(scratch, "home");
  mkdirSync(isolatedHome, { mode: 0o700 });
  const nativeAgentRoot = createSavedMainAgentRoot(isolatedHome);
  for (const path of [join(isolatedHome, ".cache"), join(isolatedHome, ".local", "share"), join(isolatedHome, ".local", "state")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const observerFile = join(scratch, "observer", "row-lifecycle.jsonl");
  const editorFixture = createSavedMainEditor(scratch, workspaceA);
  const candidate = createSavedMainCandidate(scratch);
  const fixtureState = join(scratch, "fixture-state");
  mkdirSync(fixtureState, { mode: 0o700 });
  const providerJournal = join(fixtureState, "provider-journal.jsonl");
  writeFileSync(join(fixtureState, "turn-script.json"), JSON.stringify({
    // Public /new may reload the provider, resetting its local request ordinal.
    // Identify each genuine UI-delivered turn by its echoed prompt instead.
    steps: [{ echoLastUser: "row-response:" }, { echoLastUser: "row-response:" }],
  }) + "\n", { flag: "wx", mode: 0o600 });

  const childEnv = createSavedMainChildEnvironment(scratch, runtime, editorFixture.editor, observerFile, editorFixture.log, nativeAgentRoot);
  childEnv.XDG_CACHE_HOME = join(isolatedHome, ".cache");
  childEnv.XDG_DATA_HOME = join(isolatedHome, ".local", "share");
  childEnv.XDG_STATE_HOME = join(isolatedHome, ".local", "state");
  childEnv.PRG_FIXTURE_AGENT_DIR = runtime.agentDir;
  childEnv.PRG_FIXTURE_STATE_DIR = fixtureState;
  validateSharedRuntimeEnvironment(childEnv, runtime, nativeAgentRoot, scratch);
  assert.equal(childEnv.NODE_OPTIONS, originalNodeOptions(), "trusted NODE_OPTIONS is preserved without role/catalog stripping");
  const args = [
    "--offline",
    "--no-context-files",
    "--no-themes",
    "--no-tools",
    "--extension", OBSERVER_FIXTURE,
    "--extension", PROVIDER_FIXTURE,
  ];
  assertNoForbiddenSessionArgs(args);
  const driver = await SavedMainDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    candidate,
    runtime,
    observerFile,
    args,
    env: childEnv,
  });
  let assertionsCompleted = false;
  let failureCleanupRequested = false;
  t.after(async () => {
    let safeToDispose = driver.exitEvent !== undefined
      && driver.ledger.all().every((owned) => owned.exitWatcher.observedExit);
    if (!assertionsCompleted && !driver.exitEvent) {
      failureCleanupRequested = true;
      try {
        await driver.terminateExactOuterForFailure();
      } catch (error) {
        process.stderr.write(`failure teardown remains blocked: ${error instanceof Error ? error.message : "bounded owner cleanup failed"}\n`);
      }
      safeToDispose = driver.exitEvent !== undefined
        && driver.ledger.all().every((owned) => owned.exitWatcher.observedExit);
    }
    // Runtime trees are evidence on success and failure; never enumerate or
    // delete descendants based only on having created the root.
    for (const owned of driver.ledger.all()) {
      if (!owned.exitWatcher.observedExit) {
        process.stderr.write(`retained native row-lifecycle PID watcher ${owned.pid}; kernel exit remains unconfirmed\n`);
      }
    }
    const childForceObserved = ptyJournalHasForceAttempt(driver.ptyRecords());
    if (!assertionsCompleted || failureCleanupRequested || childForceObserved) {
      process.stderr.write(`preserved row-lifecycle runtime tree ${scratch}; assertionsCompleted=${assertionsCompleted}; failureCleanupRequested=${failureCleanupRequested}; childForceAttemptObserved=${childForceObserved}\n`);
    }
    if (safeToDispose) {
      try {
        await driver.stopExitedWatchers();
      } catch {
        process.stderr.write(`preserved row-lifecycle runtime tree ${scratch}; an exited-PID watcher could not be stopped cleanly\n`);
      } finally {
        driver.dispose();
      }
    } else {
      process.stderr.write(`retained live owner and watchers for row-lifecycle tree ${scratch}; no unconfirmed child or owner was destroyed\n`);
    }
  });

  // Anchor the baseline on the exact canonical header plus the whole empty
  // roster, never a partial first-output/divider repaint.
  await driver.waitFrame((text) => frameHeader(text) === "Session host"
    && text.includes("Welcome") && isSidebarFocus(text)
    && parseRosterFrame(text, 32).count === 0,
    "fresh real public Main completely paints its empty roster and sidebar-only focus footer before the first key");
  assert.deepEqual(driver.records(), [], "the public native observer has no fabricated pre-session events");
  assert.equal(driver.surface.frame().cols, OUTER_COLS);
  assert.equal(driver.surface.frame().rows, OUTER_ROWS);

  // --- Phase 1: two independently live native children share one agent dir. ---
  const createdA = await submitWorkspaceOnlyNew(driver, scratch, join(scratch, "row-lifecycle-a-"), workspaceA);
  const processA = createdA.process;
  const bindingA0 = createdA.binding;
  assert.equal(bindingA0.displayName, "(no messages)");
  assert.equal(bindingA0.storedName, undefined, "Pi's fresh no-message conversation has no invented name");
  await renameRow(driver, processA, bindingA0, nameA);

  const createdB = await submitWorkspaceOnlyNew(driver, scratch, join(scratch, "row-lifecycle-b-"), workspaceB, `${workspaceA}/`);
  const processB = createdB.process;
  const bindingB0 = createdB.binding;
  assert.equal(bindingB0.displayName, "(no messages)");
  await renameRow(driver, processB, bindingB0, nameB);
  // Establish B's ownership witness: a distinctive unsubmitted native draft in
  // B's own editor that must survive every later A restart and the d-stop.
  await activateRow(driver, processB.rosterPosition!, nameB);
  await driver.writeAndWait(bDraft, (text) => text.includes(bDraft),
    "B's distinctive native draft is typed through B's actual owned Pi editor");
  assert.ok(processIsStillOwnedAndLive(processA), "establishing B's draft never stops A");

  assert.notEqual(processA.pid, processB.pid, "the two native children are independently owned PIDs");
  assert.notEqual(processA.receipt.receipt, processB.receipt.receipt, "each child has its own public PTY spawn receipt");
  assert.equal(processA.cwd, workspaceA);
  assert.equal(processB.cwd, workspaceB);
  assert.notEqual(workspaceA, workspaceB, "the two children use separate workspaces");
  assert.ok(processIsStillOwnedAndLive(processA));
  assert.ok(processIsStillOwnedAndLive(processB));
  const rosterAfterCreation = rosterEntries(driver.currentText());
  assert.equal(rosterAfterCreation.length, 5, "two native cards plus the exact ordered three-action tail");
  assert.equal(renderedTitleOf(rosterAfterCreation[0]), nameA);
  assert.equal(renderedTitleOf(rosterAfterCreation[1]), nameB);
  assert.deepEqual(rosterAfterCreation.slice(2).map((entry) => entry.label),
    ["Saved conversations", "New session", "Quit host"], "the ordered action tail is exact");
  assert.equal(parseRosterFrame(driver.currentText(), 32).count, 2, "the roster header declares exactly two native sessions");

  // --- Phase 2: switching, hiding, and Space never stop either child. ---
  const phase2Before = driver.snapshot();
  await activateRow(driver, processA.rosterPosition!, nameA);
  assert.ok(processIsStillOwnedAndLive(processA), "activating A keeps A live");
  assert.ok(processIsStillOwnedAndLive(processB), "activating A never stops the independent B child");
  await activateRow(driver, processB.rosterPosition!, nameB);
  assert.ok(processIsStillOwnedAndLive(processA), "switching to B keeps A live");
  assert.ok(processIsStillOwnedAndLive(processB));

  // F8: Main focus -> sidebar focus (visible).
  const f8FocusBefore = driver.snapshot();
  driver.pty.write(KEYS.f8);
  await driver.waitFrame((text) => isSidebarFocus(text),
    "one F8 press focuses the visible sidebar without hiding it", f8FocusBefore.frameRevision);
  // F8: sidebar focus -> hidden.
  const f8HideBefore = driver.snapshot();
  driver.pty.write(KEYS.f8);
  await driver.waitFrame((text) => sidebarRosterHidden(text, 32),
    "one F8 press hides the sidebar-focused pane and returns Main", f8HideBefore.frameRevision);
  // F8: hidden -> shown and focused.
  const f8ShowBefore = driver.snapshot();
  driver.pty.write(KEYS.f8);
  await driver.waitFrame((text) => isSidebarFocus(text),
    "one F8 press shows and focuses the hidden sidebar", f8ShowBefore.frameRevision);

  // Space: collapse then expand B's card; neither child is touched.
  await moveRosterToPosition(driver, processB.rosterPosition!);
  const spaceCollapseBefore = driver.snapshot();
  driver.pty.write(" ");
  await driver.waitFrame((text) => {
    const entry = rosterEntries(text).find((candidate) => candidate.position === processB.rosterPosition);
    return isCompleteRosterFrame(text) && entry?.kind === "native" && entry.rows === 3;
  }, "one genuine Space press collapses the exact selected card from five rows to three", spaceCollapseBefore.frameRevision);
  const spaceExpandBefore = driver.snapshot();
  driver.pty.write(" ");
  await driver.waitFrame((text) => {
    const entry = rosterEntries(text).find((candidate) => candidate.position === processB.rosterPosition);
    return isCompleteRosterFrame(text) && entry?.kind === "native" && entry.rows === 5;
  }, "one genuine Space press expands the exact selected card back to five rows", spaceExpandBefore.frameRevision);
  await assertNoStartsAfter(driver, phase2Before, "switching, hiding, and Space expansion");
  assert.ok(processIsStillOwnedAndLive(processA), "no switching/hiding/Space input ever stopped A");
  assert.ok(processIsStillOwnedAndLive(processB), "no switching/hiding/Space input ever stopped B");

  // --- Phase 3: save A through one genuine scripted-provider user turn. ---
  await activateRow(driver, processA.rosterPosition!, nameA);
  await driver.writeAndWait(promptA, (text) => text.includes(promptA),
    "the deliberate user turn is typed through the actual native Pi editor");
  const beforeSubmitA = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "agent_start"
    && record.pid === processA.pid && record.cwd === workspaceA && record.sessionId === bindingA0.sessionId),
  "fresh public agent_start for the exact owned process and initial native conversation", beforeSubmitA.observerOffset);
  await driver.waitFrame((text) => text.includes(promptA),
    "the submitted real user turn appears in the actual native Pi surface", beforeSubmitA.frameRevision);
  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "agent_settled"
    && record.pid === processA.pid && record.cwd === workspaceA && record.sessionId === bindingA0.sessionId),
  "fresh public agent_settled for the exact owned PID/conversation", beforeSubmitA.observerOffset);
  await driver.waitFrame((text) => text.includes(responseA),
    "the actual local scripted public faux-provider response renders in Pi", beforeSubmitA.frameRevision);
  assert.equal(existsSync(bindingA0.sessionFile), true,
    "only the real user turn caused the native planned session file to exist");
  assert.equal(sessionFileHasStoredName(bindingA0.sessionFile, nameA), true,
    "the actual native session file persisted the exact renamed conversation after a real user turn");
  assert.equal(driver.records().filter((record) => record.type === "agent_start" && record.pid === processA.pid).length, 1,
    "one deliberate prompt caused exactly one real native agent turn in A");
  assert.equal(driver.records().filter((record) => record.type === "tool_call").length, 0,
    "the offline public faux-provider turn invoked no tools");

  // --- Phase 4: /new rebinds A to current C (not original A); save C. ---
  await driver.writeAndWait("/new", (text) => text.includes("/new"),
    "the exact public native /new command is entered through the same owned Pi process");
  const beforeNew = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const newRecords = await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "session_start"
    && record.pid === processA.pid && record.cwd === workspaceA && record.sessionId !== bindingA0.sessionId),
  "actual native /new emits a fresh public session_start on the exact same PID/cwd", beforeNew.observerOffset);
  const newSessionStart = newRecords.slice(beforeNew.observerOffset).filter((record) => record.type === "session_start"
    && record.pid === processA.pid && record.cwd === workspaceA).at(-1);
  assert.ok(newSessionStart, "the same owned process produced the fresh native /new binding");
  const bindingC = driver.ledger.bindSessionStart(processA, newSessionStart!, newRecords.indexOf(newSessionStart!));
  assert.notEqual(bindingC.sessionId, bindingA0.sessionId, "/new creates a distinct current conversation ID");
  assert.notEqual(bindingC.sessionFile, bindingA0.sessionFile, "/new plans a distinct session file");
  assert.equal(bindingC.displayName, "(no messages)", "the new native conversation uses Pi's real no-message caption");
  assert.equal(existsSync(bindingC.sessionFile), false, "Pi's planned /new file remains absent before a real turn");
  assert.equal(existsSync(bindingA0.sessionFile), true, "the original actually saved file survives /new");
  await driver.waitFrame((text) => frameHeader(text) === "(no messages)",
    "Main renders Pi's actual new no-messages conversation caption", beforeNew.frameRevision);
  await renameRow(driver, processA, bindingC, nameC);
  await activateRow(driver, processA.rosterPosition!, nameC);

  await driver.writeAndWait(promptC, (text) => text.includes(promptC),
    "the second deliberate user turn is typed into the current /new conversation");
  const beforeSubmitC = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "agent_start"
    && record.pid === processA.pid && record.cwd === workspaceA && record.sessionId === bindingC.sessionId),
  "fresh public agent_start for the exact current /new conversation", beforeSubmitC.observerOffset);
  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "agent_settled"
    && record.pid === processA.pid && record.cwd === workspaceA && record.sessionId === bindingC.sessionId),
  "fresh public agent_settled for the exact current /new conversation", beforeSubmitC.observerOffset);
  await driver.waitFrame((text) => text.includes(responseC),
    "the actual local scripted public faux-provider response renders in the current conversation", beforeSubmitC.frameRevision);
  assert.equal(existsSync(bindingC.sessionFile), true,
    "only the real user turn caused the current /new session file to exist");
  assert.equal(sessionFileHasStoredName(bindingC.sessionFile, nameC), true,
    "the actual native session file persisted the exact current conversation name");
  assert.equal(processA.bindings.length, 2, "the ledger keeps both exact conversation bindings for one process incarnation");
  assert.equal(currentBinding(processA).sessionId, bindingC.sessionId,
    "the observer-visible current binding history is original A then current C");
  assert.equal(ptySpawnCount(driver.ptyRecords()), 2, "/new did not spawn or adopt a second native process");

  // --- Phase 5: exit A through the public native quit; the placeholder remains. ---
  await activateRow(driver, processA.rosterPosition!, nameC);
  const childExitBefore = driver.snapshot();
  driver.pty.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "session_shutdown"
    && record.pid === processA.pid && record.cwd === workspaceA
      && record.sessionId === bindingC.sessionId && record.contextSessionId === bindingC.sessionId
      && record.reason === "quit"),
  "the real native Ctrl+C pair causes the exact current conversation's public quit lifecycle", childExitBefore.observerOffset);
  await driver.waitForKernelExit(processA);
  await driver.assertPtyExit(processA);
  await driver.waitFrame((text) => {
    const row = rosterEntries(text).find((entry) => entry.position === processA.rosterPosition);
    return (frameHeader(text) === nameC || frameHeader(text) === "(session name unavailable)")
      && entryStatus(row) === "exited (code 0)";
  }, "Main renders the truthful exited card only after exact public PTY and retained kernel exit witnesses",
  childExitBefore.frameRevision);
  assert.ok(processIsStillOwnedAndLive(processB), "exiting A never stops the independent B child");
  assert.equal(existsSync(bindingC.sessionFile), true, "the current saved file survives A's graceful exit");

  // --- Phase 6: ENTER the exited row resumes CURRENT C as a new owned child. ---
  await ensureSidebarFocus(driver);
  await moveRosterToPosition(driver, processA.rosterPosition!);
  assert.equal(entryStatus(selectedRosterEntry(driver.currentText())), "exited (code 0)",
    "the exact exited placeholder is highlighted before the deliberate resume Enter");
  const beforeResume = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const processA2 = await driver.awaitSpawn(beforeResume, workspaceA);
  assert.notEqual(processA2.pid, processA.pid, "no adoption: the resumed conversation is a new independently owned PID");
  assert.notEqual(processA2.receipt.receipt, processA.receipt.receipt, "the replacement child has a fresh public PTY spawn receipt");
  const bindingC2 = await driver.awaitSessionStart(processA2, beforeResume,
    (record) => record.sessionId === bindingC.sessionId && record.sessionFile === bindingC.sessionFile);
  assert.equal(bindingC2.displayName, nameC, "the resumed row reports the persisted current caption");
  assert.equal(bindingC2.storedName, nameC, "the reopened SessionManager reports the exact stored name");
  await driver.waitFrame((text) => {
    const entries = rosterEntries(text);
    return isCompleteRosterFrame(text)
      && frameHeader(text) === nameC
      && !entries.some((entry) => entry.kind === "native" && entryStatus(entry) === "exited (code 0)")
      && nativeCardCount(text) === 2
      && entries.some((entry) => entry.kind === "native" && renderedTitleMatches(entry.title, nameC));
  }, "success replaces the old dead placeholder with the exact resumed current conversation row", beforeResume.frameRevision);
  const a2Entry = rosterEntries(driver.currentText()).find((entry) => entry.kind === "native"
    && renderedTitleMatches(entry.title, nameC));
  assert.ok(a2Entry, "the resumed current conversation row is visibly present");
  driver.ledger.setRosterPosition(processA2, a2Entry.position);
  assert.equal(processA.exitWatcher.observedExit, true, "the original A incarnation remains dead and is never adopted");
  assert.ok(processIsStillOwnedAndLive(processB), "resuming A's row never touches the independent B child");
  assert.equal(ptySpawnCount(driver.ptyRecords()), 3, "one deliberate exited-row resume adds exactly one real child PTY");
  assert.equal(existsSync(bindingC.sessionFile), true, "the resumed conversation uses the exact saved file without deleting it");

  // --- Phase 7: /new on A2 creates a positively never-saved binding D. ---
  await driver.writeAndWait("/new", (text) => text.includes("/new"),
    "the exact public native /new command is entered through the resumed child");
  const beforeNew2 = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const newRecords2 = await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "session_start"
    && record.pid === processA2.pid && record.cwd === workspaceA && record.sessionId !== bindingC.sessionId),
  "actual native /new on the resumed child emits a fresh public session_start", beforeNew2.observerOffset);
  const newSessionStart2 = newRecords2.slice(beforeNew2.observerOffset).filter((record) => record.type === "session_start"
    && record.pid === processA2.pid && record.cwd === workspaceA).at(-1);
  assert.ok(newSessionStart2, "the resumed child produced the fresh native /new binding");
  const bindingD = driver.ledger.bindSessionStart(processA2, newSessionStart2!, newRecords2.indexOf(newSessionStart2!));
  assert.equal(bindingD.displayName, "(no messages)");
  assert.equal(existsSync(bindingD.sessionFile), false, "the never-saved /new file remains absent");
  assert.equal(existsSync(bindingC.sessionFile), true, "the saved current C file survives A2's /new");

  // --- Phase 8: exit the never-saved A2 through the public native quit. ---
  const a2ExitBefore = driver.snapshot();
  driver.pty.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "session_shutdown"
    && record.pid === processA2.pid && record.cwd === workspaceA
      && record.sessionId === bindingD.sessionId && record.contextSessionId === bindingD.sessionId
      && record.reason === "quit"),
  "the real native Ctrl+C pair causes the exact never-saved conversation's public quit lifecycle", a2ExitBefore.observerOffset);
  await driver.waitForKernelExit(processA2);
  await driver.assertPtyExit(processA2);
  await driver.waitFrame((text) => {
    const row = rosterEntries(text).find((entry) => entry.position === processA2.rosterPosition);
    return (frameHeader(text) === "(no messages)" || frameHeader(text) === "(session name unavailable)")
      && entryStatus(row) === "exited (code 0)";
  }, "Main renders the truthful exited card for the never-saved conversation", a2ExitBefore.frameRevision);
  assert.ok(processIsStillOwnedAndLive(processB), "exiting A2 never stops the independent B child");

  // --- Phase 9: ENTER the never-saved placeholder starts fresh A3 in the same workspace. ---
  await ensureSidebarFocus(driver);
  await moveRosterToPosition(driver, processA2.rosterPosition!);
  assert.equal(entryStatus(selectedRosterEntry(driver.currentText())), "exited (code 0)",
    "the exact never-saved exited placeholder is highlighted before the deliberate resume Enter");
  const beforeResume2 = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const processA3 = await driver.awaitSpawn(beforeResume2, workspaceA);
  assert.notEqual(processA3.pid, processA2.pid, "the never-saved fallback is a new independently owned PID");
  const bindingE = await driver.awaitSessionStart(processA3, beforeResume2,
    (record) => record.sessionId !== bindingD.sessionId && record.displayName === "(no messages)");
  assert.notEqual(bindingE.sessionId, bindingD.sessionId, "the fresh conversation has a new opaque ID, never the never-saved old one");
  assert.equal(existsSync(bindingE.sessionFile), false, "the fresh fallback conversation has no fabricated session file");
  await driver.waitFrame((text) => {
    const entries = rosterEntries(text);
    return isCompleteRosterFrame(text)
      && frameHeader(text) === "(no messages)"
      && !entries.some((entry) => entry.kind === "native" && entryStatus(entry) === "exited (code 0)")
      && nativeCardCount(text) === 2
      && entries.some((entry) => entry.kind === "native" && entry.label === "(no messages)");
  }, "the never-saved fallback replaces the old placeholder with a fresh no-messages row in the exact same workspace",
  beforeResume2.frameRevision);
  const a3Entry = rosterEntries(driver.currentText()).find((entry) => entry.kind === "native" && entry.label === "(no messages)");
  assert.ok(a3Entry, "the fresh fallback row is visibly present");
  driver.ledger.setRosterPosition(processA3, a3Entry.position);
  assert.equal(processA3.cwd, workspaceA, "the fresh fallback child uses the exact same owned workspace");
  assert.ok(!driver.currentText().includes(promptC), "the fresh fallback surface shows no resumed transcript from the saved sibling");
  assert.ok(!driver.currentText().includes(responseC), "no synthetic or newest-guessed message is replayed into the fresh conversation");
  assert.equal(existsSync(bindingC.sessionFile), true, "the saved C file is untouched by the never-saved fallback");
  assert.equal(sessionFileHasStoredName(bindingC.sessionFile, nameC), true);

  // --- Phase 10: d stays native in Main focus; sidebar d stops only the exact row. ---
  const mainDraft = `dD-main-focus-stays-native-${suffix}`;
  await driver.writeAndWait(mainDraft, (text) => text.includes(mainDraft),
    "the leading d/D keypresses in Main focus become ordinary native editor text");
  assert.equal(isStopRemoveConfirmationFrame(driver.currentText()), false,
    "Main-focus d never opens a host stop confirmation");
  assert.ok(processIsStillOwnedAndLive(processA3), "Main-focus d never stops the active child");
  const clearDraftBefore = driver.snapshot();
  driver.pty.write(KEYS.ctrlC);
  await driver.waitFrame((text) => !text.includes(mainDraft),
    "one genuine native Ctrl+C clears the draft without exiting Pi", clearDraftBefore.frameRevision);
  assert.ok(processIsAlive(processA3.pid));

  // Establish B as the active owner BEFORE the isolated stop: if stopping the
  // inactive A3 seizes focus or loses B's draft, this complete-frame witness
  // fails without any repairing reactivation.
  const bOwnerVisible = (text: string): boolean => isCompleteRosterFrame(text)
    && frameHeader(text) === nameB && text.includes(bDraft);
  const bOwnerEntry = rosterEntries(driver.currentText()).find((entry) => entry.kind === "native"
    && renderedTitleMatches(entry.title, nameB));
  assert.ok(bOwnerEntry, "B's original row is present before the isolated stop");
  const beforeBOwner = driver.snapshot();
  await activateRow(driver, bOwnerEntry.position, nameB);
  await driver.waitFrame(bOwnerVisible,
    "B owns Main with its complete roster and preserved native draft before stopping inactive A3",
    beforeBOwner.frameRevision);

  await ensureSidebarFocus(driver);
  await moveRosterToPosition(driver, processA3.rosterPosition!);
  const a3Card = rosterEntries(driver.currentText()).find((entry) => entry.position === processA3.rosterPosition);
  assert.ok(a3Card?.kind === "native", "the exact fresh fallback row is highlighted before d");
  // Honest observation of the actually rendered idle evidence; the parser already
  // validated the nullable status/background grammar. No branch assumes zero.
  const a3PositiveIdle = a3Card!.status === "agent idle | input none" && a3Card!.background === "bg tasks 0 | shells 0";

  const dBefore = driver.snapshot();
  driver.pty.write("d");
  await driver.waitFrame((text) => isStopRemoveConfirmationFrame(text)
    || nativeCardCount(text) === 1
    || text.includes(STOP_REPRESS_NOTICE),
  "sidebar d either stops a positively idle row, freezes an explicit confirmation, or reports the revalidation race",
  dBefore.frameRevision);

  // An unconfirmed direct stop is acceptable only on positively observed
  // complete idleness for the exact row; a deliberate confirmation is tracked
  // separately and set only after the full frozen warning plus its key.
  let deliberatelyConfirmed = false;
  let directStopPositivelyIdle = false;

  const confirmAndExit = async (label: string): Promise<void> => {
    // Cancel once: no native input is sent and nothing is stopped.
    const cancelBefore = driver.snapshot();
    driver.pty.write(KEYS.escape);
    await driver.waitFrame((text) => isCompleteRosterFrame(text) && !isStopRemoveConfirmationFrame(text)
      && nativeCardCount(text) === 2,
    "one genuine Escape cancels only the frozen stop confirmation", cancelBefore.frameRevision);
    assert.ok(processIsStillOwnedAndLive(processA3), "cancellation sends no native input and stops nothing");
    await driver.assertNoNewObserverRecords(cancelBefore, "the cancelled stop confirmation creates no lifecycle event");
    // Deliberate second press; confirm only after the FULL warning is drawn.
    const repressBefore = driver.snapshot();
    driver.pty.write("d");
    await driver.waitFrame(isStopRemoveConfirmationFrame,
      `the frozen stop warning is completely redrawn before any confirmation key (${label})`, repressBefore.frameRevision);
    driver.pty.write(KEYS.enter);
    deliberatelyConfirmed = true;
  };

  const afterFirstD = driver.currentText();
  if (isStopRemoveConfirmationFrame(afterFirstD)) {
    assert.equal(a3PositiveIdle, false, "a non-idle or unknown card is what froze the explicit confirmation");
    await confirmAndExit("first press");
  } else if (afterFirstD.includes(STOP_REPRESS_NOTICE)) {
    // The rendered idle state changed before the parent's fresh revalidation:
    // re-observe the exact row's current idle evidence, then press d again.
    const reCard = rosterEntries(driver.currentText()).find((entry) => entry.position === processA3.rosterPosition);
    assert.ok(reCard?.kind === "native", "the exact row is still present during the revalidation race");
    const rePositiveIdle = reCard!.status === "agent idle | input none" && reCard!.background === "bg tasks 0 | shells 0";
    const repressBefore = driver.snapshot();
    driver.pty.write("d");
    await driver.waitFrame((text) => isStopRemoveConfirmationFrame(text) || nativeCardCount(text) === 1,
      "the second sidebar d either freezes the confirmation or stops the now-observed-idle row", repressBefore.frameRevision);
    if (isStopRemoveConfirmationFrame(driver.currentText())) {
      await confirmAndExit("revalidation race");
    } else {
      assert.equal(rePositiveIdle, true,
        "the re-press direct stop required positively observed complete idleness for the exact row");
      directStopPositivelyIdle = true;
    }
  } else {
    assert.equal(a3PositiveIdle, true,
      "the unconfirmed direct stop required positively observed complete idleness for the exact row");
    directStopPositivelyIdle = true;
  }
  assert.ok(deliberatelyConfirmed || directStopPositivelyIdle,
    "the exact-row stop was either deliberately confirmed after the full warning or accepted only on positively observed complete idleness");

  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "session_shutdown"
    && record.pid === processA3.pid && record.cwd === workspaceA
      && record.sessionId === bindingE.sessionId && record.contextSessionId === bindingE.sessionId
      && record.reason === "quit"),
  "the isolated d-stop produces the exact current conversation's public quit lifecycle", dBefore.observerOffset);
  await driver.waitForKernelExit(processA3);
  await driver.assertPtyExit(processA3);
  await driver.waitFrame((text) => isCompleteRosterFrame(text) && nativeCardCount(text) === 1
    && renderedTitleMatches(renderedTitleOf(rosterEntries(text)[0]), nameB)
    && bOwnerVisible(text),
  "the d-stop removes only the exact stopped row and leaves the live sibling", dBefore.frameRevision);
  assert.ok(processIsStillOwnedAndLive(processB), "stopping A3 keeps B's original handle alive");
  assert.equal(frameHeader(driver.currentText()), nameB,
    "stopping inactive A3 preserves B's existing active ownership");
  assert.equal(existsSync(bindingC.sessionFile), true, "the d-stop deletes no saved file");

  // B's ownership survived the isolated stop without any reactivation: its
  // original handle, kernel watcher, PTY receipt, and conversation binding are intact.
  assert.ok(processIsStillOwnedAndLive(processB), "B's original live handle is intact after the isolated d-stop");
  assert.equal(processB.exitWatcher.observedExit, false, "B's exact kernel watcher has not observed an exit");
  assert.equal(processB.receipt.receipt, 2, "B retains its original public PTY spawn receipt");
  assert.equal(currentBinding(processB), bindingB0, "B retains its original conversation binding");

  // --- Phase 11: quit the remaining B only after full restoration proof. ---
  await ensureSidebarFocus(driver);
  await moveRosterToAction(driver, "Quit host");
  assert.equal(selectedRosterEntry(driver.currentText())?.label, "Quit host",
    "the real Quit host entry is visibly highlighted before q invokes its shortcut");
  const finalBeforeQuit = driver.snapshot();
  driver.pty.write("q");
  await driver.waitFrame((text) => isQuitConfirmationFrame(text, 1),
    "the real q shortcut opens the actual confirmation for the one live child", finalBeforeQuit.frameRevision);
  const beforeConfirm = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitForRecords((fresh) => fresh.some((record) => record.type === "session_shutdown"
    && record.pid === processB.pid && record.cwd === workspaceB
      && record.sessionId === bindingB0.sessionId && record.contextSessionId === bindingB0.sessionId
      && record.reason === "quit"),
  "confirmed host Quit produces the exact live child's public quit lifecycle", beforeConfirm.observerOffset);
  await driver.waitForKernelExit(processB);
  await driver.assertPtyExit(processB);
  await driver.waitForNormalOuterExit();
  assert.equal(driver.exitEvent?.exitCode, 0, "the real public Main completed graceful runSessionHost return zero");
  assert.ok(!driver.exitEvent?.signal, "the actual outer PTY returned normally without a signal");

  // --- Final evidence: every incarnation, binding, and file is exactly accounted for. ---
  const allProcesses = driver.ledger.all();
  assert.deepEqual(allProcesses.map((entry) => entry.receipt.receipt), [1, 2, 3, 4],
    "all and only the four actual public spawn receipts remain in the process-incarnation ledger");
  assert.deepEqual(allProcesses.map((entry) => entry.cwd), [workspaceA, workspaceB, workspaceA, workspaceA],
    "the three A-workspace incarnations share the exact canonical workspace with B's separate one");
  assert.equal(processA.bindings.length, 2, "the first process keeps original and /new native conversation bindings");
  assert.equal(currentBinding(processA).sessionId, bindingC.sessionId, "A's current binding history ends at C");
  assert.equal(findBinding(processA, bindingA0.sessionId, bindingA0.sessionFile), bindingA0,
    "the original A binding remains available after /new changes only the latest binding");
  assert.equal(processA2.bindings.length, 2, "the resumed process keeps both the reopened C and its /new D bindings");
  assert.equal(findBinding(processA2, bindingC.sessionId, bindingC.sessionFile), bindingC2,
    "A2's first binding is the exact resumed current C conversation");
  assert.equal(processA2.bindings[0].sessionId, bindingC.sessionId, "A2's ordered history begins with the resumed C");
  assert.equal(processA2.bindings[1].sessionId, bindingD.sessionId, "A2's ordered history ends with the never-saved D");
  assert.equal(currentBinding(processA2).sessionId, bindingD.sessionId, "A2's current binding is the never-saved D");
  assert.equal(processA3.bindings.length, 1);
  assert.equal(currentBinding(processA3).sessionId, bindingE.sessionId, "A3's only binding is the fresh E");
  assert.equal(processB.bindings.length, 1);
  assert.equal(allProcesses.every((entry) => entry.exitWatcher.observedExit), true,
    "every exact registered kernel watcher observed its owned PID exit");
  assert.equal(ptySpawnCount(driver.ptyRecords()), allProcesses.length,
    "every process incarnation has exactly one real public PTY spawn receipt");
  assert.equal(driver.records().filter((record) => record.type === "session_start").length,
    allProcesses.reduce((total, process) => total + process.bindings.length, 0),
  "every fresh public session_start is retained as one exact process-receipt conversation binding");
  for (const record of sessionStarts(driver.records())) {
    assert.ok(allProcesses.some((process) => process.bindings.some((binding) =>
      binding.spawnReceipt === process.receipt.receipt && binding.pid === record.pid && binding.cwd === record.cwd
        && binding.sessionId === record.sessionId && binding.sessionFile === record.sessionFile)),
    "each public lifecycle start maps to its own exact spawn receipt/PID/cwd/session ID/file");
    assert.equal(record.agentDir, nativeAgentRoot, "each public child uses the one shared native root inside isolated HOME");
    assert.equal(record.tty, true, "each owned native process is a real terminal child");
    assert.deepEqual(record.credentialLikeEnvironmentNames, [], "no child inherited credential-like environment names");
  }
  assert.equal(driver.ptyRecords().filter((record) => record.type === "pty_exit").length, allProcesses.length,
    "every process incarnation has one real public @lydell/node-pty onExit receipt with code zero and no signal");
  assert.equal(ptyJournalHasForceAttempt(driver.ptyRecords()), false,
    "the real runner observed no child force/kill attempt or failed public observer attachment");
  assert.deepEqual(driver.outerKillAttempts, [], "successful graceful restoration required no outer cleanup signal");
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 2,
    "only the two deliberate user turns (A and C) ran native agents");
  assert.equal(driver.records().filter((record) => record.type === "tool_call").length, 0,
    "no native tool was called during any row-lifecycle operation");

  const providerLog = readOwnedJsonl<ProviderRecord>(providerJournal);
  const modelRequests = providerLog.filter((record) => record.event === "model_request");
  assert.equal(modelRequests.length, 2, "exactly two real user turns reached the public faux provider");
  assert.ok(modelRequests.some((record) => record.lastUserPreview?.includes(promptA)),
    "the first scripted request served A's actual UI-delivered turn");
  assert.ok(modelRequests.some((record) => record.lastUserPreview?.includes(promptC)),
    "the second scripted request served C's actual UI-delivered turn");
  assert.equal(providerLog.filter((record) => record.event === "auto_model_selected").length,
    driver.records().filter((record) => record.type === "session_start").length,
    "every public session start (four spawns plus two /new) auto-selected the scripted model");

  assert.equal(existsSync(bindingC.sessionFile), true, "the retained current saved file is never deleted");
  assert.equal(sessionFileHasStoredName(bindingC.sessionFile, nameC), true);
  assert.equal(existsSync(bindingD.sessionFile), false, "the never-saved D file was never fabricated");
  assert.equal(existsSync(bindingE.sessionFile), false, "the fresh E conversation stayed a genuinely absent native file");
  assert.equal(OUTER_COLS, 120);
  assert.equal(OUTER_ROWS, 50);
  assertionsCompleted = true;
});
