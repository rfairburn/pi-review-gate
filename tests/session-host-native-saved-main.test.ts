import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";

import { SidebarController, type SidebarAction, type SidebarItem } from "../src/session-host/sidebar";

import {
  EVENT_TIMEOUT_MS,
  KEYS,
  OUTER_RESTORATION_BASELINE,
  OUTER_COLS,
  OUTER_ROWS,
  OBSERVER_FIXTURE,
  PROVIDER_FIXTURE,
  ProcessIncarnationLedger,
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
  isSavedConversationsPane as isSavedPane,
  isSidebarFocusedFrame,
  hasQuitConfirmationContents,
  nativeFormFieldIsEmpty,
  latestDimensions,
  originalNodeOptions,
  processIsAlive,
  processIsStillOwnedAndLive,
  ptyJournalHasForceAttempt,
  ptySpawnCount,
  parseRosterFrame,
  readOwnedJsonl,
  recordHasCurrentConversation,
  requirePublicRuntimeDependencies,
  resolveSavedRuntimePin,
  rosterEntries,
  isCompleteSavedSelection,
  hasFullWidthNativeEditorRule,
  selectedRosterEntry,
  sessionFileHasStoredName,
  shortBaselineFitsTwentyFourColumns,
  sidebarRosterHidden,
  validateSharedRuntimeEnvironment,
  waitForJsonl,
  workspaceOnlyNewFrame,
  type ConversationBinding,
  type JournalSnapshot,
  type ProcessIncarnation,
  type RosterEntry,
  type SessionRecord,
} from "./helpers/session-host-native-saved-main-harness";

import { sidebarPaneLines } from "./helpers/session-host-native-roster-witness";

interface ProviderRecord {
  readonly event?: string;
  readonly requestIndex?: number;
  readonly lastUserPreview?: string;
}

function isCompleteRosterFrame(text: string): boolean {
  return parseRosterFrame(text, 32).complete;
}

function isCompleteMainFocus(text: string): boolean {
  const parsed = parseRosterFrame(text, 32);
  if (!parsed.complete) return false;
  const pane = sidebarPaneLines(text, 32);
  const offset = /^\s*Sessions \(/u.test(pane[0] ?? "") ? 0 : 1;
  const footer = pane.slice(offset + 1 + parsed.entryEnd).map((line) => line.trim()).filter(Boolean);
  return footer.length === 2 && footer[0] === "F8 toggle | enter open" && footer[1] === "esc hide | q quit";
}

function isCompleteWelcome(text: string): boolean {
  return frameHeader(text) === "Session host" && text.includes("Welcome")
    && parseRosterFrame(text, 32).count === 0 && isSidebarFocus(text)
    && selectedRosterEntry(text)?.label === "New session";
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

function sessionStarts(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((record) => record.type === "session_start");
}

function shutdownFor(records: readonly SessionRecord[], process: ProcessIncarnation, binding: ConversationBinding): SessionRecord | undefined {
  return records.filter((record) => record.type === "session_shutdown"
    && record.pid === process.pid && record.cwd === process.cwd
    && record.sessionId === binding.sessionId && record.contextSessionId === binding.sessionId).at(-1);
}

function liveBindingsToCheck(processes: readonly ProcessIncarnation[]): Array<{ process: ProcessIncarnation; binding: ConversationBinding }> {
  return processes.map((process) => ({ process, binding: currentBinding(process) }));
}

function rosterEntryAt(driver: SavedMainDriver, position: number): RosterEntry | undefined {
  return rosterEntries(driver.currentText()).find((entry) => entry.position === position);
}

function assertEarlierNativeRowsStayAtTheirObservedPositions(before: readonly RosterEntry[], after: readonly RosterEntry[]): void {
  const actions = new Set(["Saved conversations", "New session", "Quit host"]);
  for (const entry of before) {
    if (actions.has(entry.label)) continue;
    assert.equal(after[entry.position]?.label, entry.label,
      `previous process row ${entry.position} stays at its creation-correlated visible roster position`);
  }
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
  if (isSavedPane(driver.currentText())) throw new Error("close the actual Saved conversations pane before selecting a roster row");
  // Observe a completed focus domain before deciding whether to send a key.
  // A partial/stale footer never authorizes four speculative toggle presses.
  await driver.waitFrame((text) => isSidebarFocus(text) || isCompleteMainFocus(text) || sidebarRosterHidden(text),
    "the complete roster/footer or fully hidden pane establishes the current focus domain");
  if (isSidebarFocus(driver.currentText())) return;
  const snapshot = driver.snapshot();
  driver.pty.write(KEYS.f8);
  await driver.waitFrame(isSidebarFocus,
    "one deliberate F8 focuses the visible Main roster or shows the fully hidden sidebar", snapshot.frameRevision);
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
      "after confirmed exited-row removal, one genuine Down establishes a fresh visible roster highlight without activation",
      snapshot.frameRevision);
    await assertNoStartsAfter(driver, snapshot, "establishing a roster highlight after exited-row removal");
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

async function openSavedPane(driver: SavedMainDriver, savedName: string, recordedWorkspace: string): Promise<void> {
  await moveRosterToAction(driver, "Saved conversations");
  const beforeOpen = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame(isSavedPane,
    "the genuine host Saved conversations action opens its right-hand public picker", beforeOpen.frameRevision);
  await driver.waitFrame((text) => isCompleteSavedSelection(text, savedName, recordedWorkspace),
    "fresh native catalog completely paints one selected caption/path summary and exact recorded workspace in its bottom details", beforeOpen.frameRevision);
  assert.equal(isSavedPane(driver.currentText()), true);
}

async function cancelSavedPane(driver: SavedMainDriver): Promise<JournalSnapshot> {
  const snapshot = driver.snapshot();
  driver.pty.write(KEYS.escape);
  await driver.waitFrame((text) => isSidebarFocus(text) && !isSavedPane(text),
    "genuine Escape cancels only the actual Saved conversations pane", snapshot.frameRevision);
  return snapshot;
}

async function activateProcessRow(driver: SavedMainDriver, process: ProcessIncarnation, expectedHeader: string): Promise<void> {
  await ensureSidebarFocus(driver);
  assert.ok(process.rosterPosition !== undefined, "the process row was correlated to a visible position at genuine creation");
  await moveRosterToPosition(driver, process.rosterPosition!);
  const selected = selectedRosterEntry(driver.currentText());
  assert.ok(selected, "the target row remains visibly highlighted before explicit activation");
  const before = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => frameHeader(text) === expectedHeader && isCompleteMainFocus(text),
    "a later explicit host-row Enter completes the exact owner header and full Main-focus footer", before.frameRevision);
}

async function editFirstNativeName(
  driver: SavedMainDriver,
  process: ProcessIncarnation,
  binding: ConversationBinding,
  savedName: string,
): Promise<void> {
  await ensureSidebarFocus(driver);
  assert.equal(selectedPosition(driver.currentText()), process.rosterPosition,
    "the genuine New completion row remains the exact selected process row before Edit");
  const beforeEdit = driver.snapshot();
  driver.pty.write("e");
  await driver.waitFrame((text) => text.includes("Edit native session name") && text.includes("> New name:")
    && nativeFormFieldIsEmpty(text, "> New name:"),
  "the actual host Edit form opens with a genuinely empty replacement field", beforeEdit.frameRevision);
  await driver.writeAndWait(savedName, (text) => text.includes(savedName),
    "the deliberate canonical name is typed through the actual Edit field");
  const beforeSave = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const records = await driver.waitForRecords((fresh) => fresh.some((record) =>
    record.type === "native_session_name" && record.pid === process.pid && record.cwd === process.cwd
      && record.sessionId === binding.sessionId && record.storedName === savedName),
  "the real public SessionManager freshly reports the exact renamed conversation", beforeSave.observerOffset);
  const nameRecord = records.slice(beforeSave.observerOffset).filter((record) => record.type === "native_session_name"
    && record.pid === process.pid && record.cwd === process.cwd && record.sessionId === binding.sessionId
    && record.storedName === savedName).at(-1);
  assert.ok(nameRecord, "native_session_name metadata came from the actual public observer fixture");
  driver.ledger.appendNativeName(process, nameRecord!, records.indexOf(nameRecord!));
  await driver.waitFrame((text) => isSidebarFocus(text)
    && selectedRosterEntry(text)?.position === process.rosterPosition
    && selectedRosterEntry(text)?.label === savedName,
  "the host row shows the exact actual canonical name after Edit completion", beforeSave.frameRevision);
  await assertNoNewPtyRecords(driver, beforeSave, "native rename does not create another child PTY");
}

async function assertNoNewPtyRecords(driver: SavedMainDriver, snapshot: JournalSnapshot, description: string): Promise<void> {
  await driver.assertNoNewPtyRecords(snapshot, description);
}

async function submitWorkspaceOnlyNew(
  driver: SavedMainDriver,
  scratch: string,
  workspace: string,
): Promise<{ process: ProcessIncarnation; binding: ConversationBinding }> {
  await moveRosterToAction(driver, "New session");
  const beforeOpen = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame(workspaceOnlyNewFrame,
    "the genuine New form is Workspace-only and contains no synthetic Label/Profile fields", beforeOpen.frameRevision);
  assert.equal(isEmptyWorkspaceField(driver.currentText()), true,
    "the exact native bordered Workspace field body is initially empty");

  const prefix = join(scratch, "saved-main-workspace-");
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
  assert.equal(getWorkspaceFieldValue(driver.currentText()), `${workspace}/`,
    "the bordered field body confirms the accepted canonical workspace, including its native trailing slash");

  const beforeSubmit = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const process = await driver.awaitSpawn(beforeSubmit, workspace);
  const binding = await driver.awaitSessionStart(process, beforeSubmit,
    (record) => record.cwd === workspace && record.displayName === "(no messages)");
  await driver.waitFrame((text) => frameHeader(text) === "(no messages)"
    && isCompleteMainFocus(text)
    && selectedRosterEntry(text)?.label === "(no messages)",
  "the genuine New completion activates the fresh no-messages row as the Main input owner", beforeSubmit.frameRevision);
  const selected = selectedRosterEntry(driver.currentText());
  assert.ok(selected, "the completed New process is tied to its actual visible highlight");
  driver.ledger.setRosterPosition(process, selected!.position);
  assert.equal(process.rosterPosition, 0,
    "the first genuine New row has the observed visible roster position, not a cwd-derived label");
  assert.equal(processIsAlive(process.pid), true, "the exact public PTY-owned process is live after creation");
  assert.equal(process.cwd, workspace);
  assert.equal(binding.cwd, workspace);
  assert.equal(existsSync(binding.sessionFile), false,
    "the native planned session file remains absent before any real user turn");
  assert.equal(driver.ptyRecords().slice(beforeSubmit.ptyOffset).filter((record) => record.type === "pty_spawn").length, 1,
    "the actual New submission produced exactly one fresh public PTY spawn receipt");
  assert.equal(driver.records().slice(beforeSubmit.observerOffset).filter((record) => record.type === "session_start").length, 1,
    "the actual New submission produced exactly one fresh public native session_start");
  return { process, binding };
}

async function createSavedConversation(
  driver: SavedMainDriver,
  process: ProcessIncarnation,
  binding: ConversationBinding,
  prompt: string,
  response: string,
): Promise<void> {
  const actualCaption = binding.nameHistory.at(-1)?.storedName ?? binding.displayName;
  await activateProcessRow(driver, process, actualCaption);
  const beforePrompt = driver.snapshot();
  await driver.writeAndWait(prompt, (text) => text.includes(prompt),
    "the deliberate user turn is typed through the actual native Pi editor");
  const beforeSubmit = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const started = await driver.waitForRecords((fresh) => fresh.some((record) =>
    record.type === "agent_start" && record.pid === process.pid && record.cwd === process.cwd
      && record.sessionId === binding.sessionId),
  "fresh public agent_start for the exact owned process and initial native conversation", beforeSubmit.observerOffset);
  assert.ok(started.some((record) => record.type === "agent_start" && record.pid === process.pid
    && record.sessionId === binding.sessionId));
  await driver.waitFrame((text) => text.includes(prompt),
    "the submitted real user turn appears in the actual native Pi surface", beforeSubmit.frameRevision);
  const settled = await driver.waitForRecords((fresh) => fresh.some((record) =>
    record.type === "agent_settled" && record.pid === process.pid && record.cwd === process.cwd
      && record.sessionId === binding.sessionId),
  "fresh public agent_settled for the exact owned PID/conversation", beforeSubmit.observerOffset);
  assert.ok(settled.some((record) => record.type === "agent_settled" && record.pid === process.pid
    && record.sessionId === binding.sessionId));
  await driver.waitFrame((text) => text.includes(response),
    "the actual local scripted public faux-provider response renders in Pi", beforeSubmit.frameRevision);
  assert.equal(existsSync(binding.sessionFile), true,
    "only the real user turn caused the native planned session file to exist");
  assert.equal(sessionFileHasStoredName(binding.sessionFile, ""), false,
    "an empty requested name is not invented as persisted metadata");
  assert.equal(sessionFileHasStoredName(binding.sessionFile, binding.nameHistory.at(-1)?.storedName ?? ""), true,
    "the actual native session file persisted the exact name after a real user turn");
  assert.equal(driver.records().filter((record) => record.type === "agent_start" && record.pid === process.pid).length, 1,
    "one deliberate prompt caused exactly one real native agent turn");
  assert.equal(driver.records().filter((record) => record.type === "tool_call" && record.pid === process.pid).length, 0,
    "the offline public faux-provider turn invoked no tools");
  assert.equal(processIsAlive(process.pid), true, "the child stays live after its real provider turn settles");
  assert.equal(driver.frameRevision > beforePrompt.frameRevision, true);
}

async function assertSavedListingAndDuplicateRefusal(
  driver: SavedMainDriver,
  savedName: string,
  activeHeader: string,
  recordedWorkspace: string,
): Promise<void> {
  await openSavedPane(driver, savedName, recordedWorkspace);
  const beforeOpen = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => isSavedPane(text) && text.includes("That saved conversation is already open in this host"),
    "the actual host Saved picker visibly refuses the exact already-live native conversation", beforeOpen.frameRevision);
  assert.equal(exactCurrentHeader(driver), activeHeader,
    "duplicate refusal does not transfer or rewrite the active native Main header");
  await assertNoStartsAfter(driver, beforeOpen, "known-live same-conversation duplicate refusal");
}

async function assertNoFreshResizeOrStart(
  driver: SavedMainDriver,
  snapshot: JournalSnapshot,
  pid: number,
  previousDimensions: { readonly columns?: number; readonly rows?: number },
): Promise<void> {
  await assertNoStartsAfter(driver, snapshot, "Saved listing cancellation");
  const records = driver.records();
  assert.deepEqual(latestDimensions(records, pid), previousDimensions,
    "the exact active child's latest real dimensions remain unchanged by picker cancellation");
  assert.equal(records.filter((record) => record.type === "resize" && record.pid === pid).length,
    records.slice(0, snapshot.observerOffset).filter((record) => record.type === "resize" && record.pid === pid).length,
    "no child resize record was emitted during the canceled listing");
}

async function awaitSavedOpen(
  driver: SavedMainDriver,
  snapshot: JournalSnapshot,
  expectedWorkspace: string,
  expectedSessionId: string,
  expectedFile: string,
): Promise<{ process: ProcessIncarnation; binding: ConversationBinding }> {
  const process = await driver.awaitSpawn(snapshot, expectedWorkspace);
  const binding = await driver.awaitSessionStart(process, snapshot,
    (record) => record.cwd === expectedWorkspace && record.sessionId === expectedSessionId
      && record.sessionFile === expectedFile);
  return { process, binding };
}

async function openSavedSuccessfully(
  driver: SavedMainDriver,
  savedName: string,
  workspace: string,
  sessionId: string,
  sessionFile: string,
  priorProcesses: readonly ProcessIncarnation[],
): Promise<{ process: ProcessIncarnation; binding: ConversationBinding }> {
  await openSavedPane(driver, savedName, workspace);
  const beforeRoster = rosterEntries(driver.currentText());
  const before = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const opened = await awaitSavedOpen(driver, before, workspace, sessionId, sessionFile);
  await driver.waitFrame((text) => frameHeader(text) === savedName
    && isCompleteMainFocus(text)
    && selectedRosterEntry(text)?.label === savedName,
  "saved-open activates the restored exact persisted-conversation row as the Main input owner", before.frameRevision);
  const selected = selectedRosterEntry(driver.currentText());
  assert.ok(selected, "the actual successful saved-open row is the active highlighted owner");
  driver.ledger.setRosterPosition(opened.process, selected!.position);
  assert.equal(frameHeader(driver.currentText()), savedName,
    "successful saved-open transfers Main ownership to the restored conversation");
  assertEarlierNativeRowsStayAtTheirObservedPositions(beforeRoster, rosterEntries(driver.currentText()));
  for (const prior of priorProcesses) {
    assert.ok(prior.rosterPosition !== undefined);
    assert.equal(rosterEntryAt(driver, prior.rosterPosition!)?.position, prior.rosterPosition,
      "a same-workspace saved-open never overwrites a prior process's visible row position");
  }
  assert.equal(opened.process.rosterPosition, selected!.position);
  assert.ok(priorProcesses.every((prior) => prior.pid !== opened.process.pid),
    "the saved conversation is owned by a new PID rather than an adopted live process");
  assert.equal(opened.binding.cwd, workspace);
  assert.equal(opened.binding.sessionId, sessionId);
  assert.equal(opened.binding.sessionFile, sessionFile);
  assert.equal(processIsAlive(opened.process.pid), true);
  assert.equal(opened.process.exitWatcher.observedExit, false);
  return opened;
}

test("pure saved-pane predicate distinguishes the real right picker from roster text and cancellation", () => {
  const compose = (left: readonly string[], right: readonly string[]): string => {
    const rows = Math.max(left.length, right.length);
    return ["Session host", ...Array.from({ length: rows }, (_, index) =>
      `${(left[index] ?? "").padEnd(32)}│${right[index] ?? ""}`)].join("\n");
  };
  const welcomeRoster = compose(
    ["Sessions (0)", "Saved conversations", "New session", "Quit host", "enter open"],
    ["Welcome"],
  );
  const openPicker = compose(
    ["Sessions (1)", "Saved conversations", "New session", "Quit host"],
    ["Saved conversations", "up/down select", "enter open"],
  );
  const canceledPicker = compose(
    ["Sessions (1)", "Saved conversations", "New session", "Quit host", "enter open"],
    ["Saved A", "native transcript"],
  );

  assert.equal(isSavedPane(welcomeRoster), false,
    "the ordinary roster's Saved action and shared enter-open hint are not picker evidence");
  assert.equal(isSavedPane(openPicker), true,
    "the actual right-hand Saved header and picker-specific navigation hint identify the pane");
  assert.equal(isSavedPane(canceledPicker), false,
    "after cancellation, left-roster text cannot make the native Main pane look like the picker");

  const controller = new SidebarController({ toggleKey: "f8" });
  controller.renderRoster(32, 49);
  controller.handleInput(KEYS.up);
  controller.renderRoster(32, 49); // The selected Saved action must be fully displayed before Enter.
  controller.handleInput(KEYS.enter);
  assert.equal(controller.focus, "form");
  const plain = (lines: readonly string[]): string[] =>
    lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const publicRoster = plain(controller.renderRoster(32, 49).lines);
  const publicForm = plain(controller.renderForm(87, 49).lines);
  assert.ok(publicForm.some((line) => line.split(" | ").includes("up/down select")),
    "the actual 87-column Saved renderer combines picker navigation with its other footer hints");
  const publicPicker = compose(publicRoster, publicForm);
  assert.equal(isSavedPane(publicPicker), true,
    "the right-pane predicate recognizes the combined footer from the actual public Saved renderer");
});

test("Saved startup and activation witnesses refuse partial or mixed focus frames", () => {
  const controller = new SidebarController({ toggleKey: "f8" });
  const rows = controller.renderRoster(32, 49).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const compose = (left: readonly string[]) => ["Session host", ...left.map((line, index) =>
    `${line.padEnd(32)}│${index === 0 ? "Welcome — select a session" : ""}`)].join("\n");
  const complete = compose(rows);
  assert.equal(isCompleteWelcome(complete), true);
  assert.equal(isCompleteMainFocus(complete), false);
  assert.equal(isCompleteWelcome("Session host\nWelcome — select a session\nNew session\nQuit host"), false);
  const incomplete = [...rows];
  const hint = incomplete.findIndex((line) => line.includes("d stop/remove"));
  assert.ok(hint >= 0);
  incomplete[hint] = "";
  assert.equal(isCompleteWelcome(compose(incomplete)), false);
  // renderRoster's public pure contract renders independently of visibility.
  const mainController = new SidebarController({ toggleKey: "f8", initialVisible: false });
  const main = mainController.renderRoster(32, 49).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(isCompleteMainFocus(compose(main)), true);
  assert.equal(isCompleteWelcome(compose(main)), false);
  assert.equal(isCompleteMainFocus(compose([...main, "e edit name | d stop/remove"])), false);
});

test("native Saved witness requires a single selected summary and complete recorded-workspace details", () => {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({ toggleKey: "f8", onAction: (action) => actions.push(action) });
  controller.renderRoster(32, 49);
  controller.handleInput(KEYS.up);
  controller.renderRoster(32, 49);
  controller.handleInput(KEYS.enter);
  const request = actions.at(-1);
  assert.ok(request?.type === "saved-list");
  const caption = "Saved fixture";
  const cwd = `/recorded/workspace/${"abcdef".repeat(16)}`;
  assert.equal(controller.completeSavedList(request.requestId, [{ id: "fixture", file: "/fixture.jsonl", caption, cwd }], 0), true);
  const plain = (lines: readonly string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const left = plain(controller.renderRoster(32, 49).lines);
  const right = plain(controller.renderForm(87, 49).lines);
  const compose = (pane: readonly string[]): string => ["Session host", ...left.map((line, index) =>
    `${line.padEnd(32)}│${pane[index] ?? ""}`)].join("\n");
  const complete = compose(right);
  assert.equal(isCompleteSavedSelection(complete, caption, cwd), true);
  assert.equal(isCompleteSavedSelection(complete, caption, `${cwd}-wrong`), false);
  assert.equal(isCompleteSavedSelection(complete, "Wrong caption", cwd), false);
  const noFooter = [...right]; noFooter[48] = "";
  assert.equal(isCompleteSavedSelection(compose(noFooter), caption, cwd), false);
  const partialDetails = [...right]; partialDetails[47] = "";
  assert.equal(isCompleteSavedSelection(compose(partialDetails), caption, cwd), false);
  const duplicateRow = [...right]; duplicateRow[2] = duplicateRow[1];
  assert.equal(isCompleteSavedSelection(compose(duplicateRow), caption, cwd), false);
  assert.equal(hasFullWidthNativeEditorRule(compose(["─".repeat(47)]), 87), false);
  assert.equal(hasFullWidthNativeEditorRule(compose(["─".repeat(87)]), 87), true);
});

test("pure complete-roster witness rejects duplicate action rows during incremental repaint", () => {
  const controller = new SidebarController();
  controller.updateItems([{
    id: "synthetic-owned-row", label: "Saved synthetic", workspace: "/owned/workspace",
    agentDir: "/owned/agent", lifecycle: "alive", busy: false, pendingInput: false,
    inputSurface: false, activity: [],
  }]);
  const lines = controller.renderRoster(32, 49).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const compose = (left: readonly string[]): string => ["Session host",
    ...left.map((line) => `${line.padEnd(32)}│owned native pane`)].join("\n");
  assert.equal(isCompleteRosterFrame(compose(lines)), true,
    "the public renderer has one native row and exactly three ordered actions");
  const newRow = lines.find((line) => line.trim() === "New session" || line.trim() === "> New session");
  assert.ok(newRow);
  assert.equal(isCompleteRosterFrame(compose([...lines, newRow!])), false,
    "a stale duplicated action line cannot satisfy a complete roster witness");
  assert.equal(isCompleteRosterFrame(compose(lines.filter((line) => line !== newRow))), false,
    "a partially erased action row cannot satisfy a complete roster witness");
});

// Exercise the actual public pure renderer so wrapped confirmation text cannot
// be misrepresented by a terminal-wide substring assertion.
test("public SidebarController renders wrapped Quit confirmation at the 32-column sidebar width", () => {
  const controller = new SidebarController();
  const liveItems: SidebarItem[] = ["saved-process-a", "new-process-b"].map((id) => ({
    id,
    label: id,
    workspace: "/owned/workspace",
    agentDir: "/owned/native-agent",
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  }));
  controller.updateItems(liveItems);
  controller.handleInput("q");
  assert.equal(controller.focus, "confirm", "the actual public controller opens Quit confirmation for live rows");
  const rendered = controller.render(32, 50);
  assert.equal(hasQuitConfirmationContents(rendered.lines, 2), true,
    "the 32-column public renderer preserves the full live count and both distinct confirmation hint rows");
  const composedFrame = ["Session host", ...rendered.lines.map((line) =>
    `${line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 32).padEnd(32)}│native surface`)].join("\n");
  assert.equal(isQuitConfirmationFrame(composedFrame, 2), true,
    "the native-frame predicate reads only the rendered 32-column sidebar, not Main's wider content pane");
});

// The corrected geometry-aware witness must reject every partial, stale, or
// foreign stand-in: a footer-only pane, a missing header/count, altered hints,
// a mismatched live count, or the same text appearing only in the wider native
// content pane are all non-evidence for the sidebar confirmation body.
test("the 32-column Quit confirmation witness rejects missing, altered, count-drifted, and native-pane-only bodies", () => {
  const renderConfirm = (liveIds: readonly string[]): string[] => {
    const controller = new SidebarController();
    controller.updateItems(liveIds.map((id) => ({
      id,
      label: id,
      workspace: "/owned/workspace",
      agentDir: "/owned/native-agent",
      lifecycle: "alive",
      busy: false,
      pendingInput: false,
      inputSurface: false,
      activity: [],
    })));
    controller.handleInput("q");
    assert.equal(controller.focus, "confirm");
    return controller.render(32, 50).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  };
  const compose = (sidebar: readonly string[], native = "native surface"): string =>
    ["Session host", ...sidebar.map((line) => `${line.slice(0, 32).padEnd(32)}│${native}`)].join("\n");
  const complete = renderConfirm(["saved-process-a", "new-process-b"]);
  assert.equal(isQuitConfirmationFrame(compose(complete), 2), true,
    "the genuine complete rendered 32-column confirmation is accepted");

  const footerOnly = complete.filter((line) => /enter\/y = quit host|esc\/n = cancel/.test(line));
  assert.equal(isQuitConfirmationFrame(compose(footerOnly), 2), false,
    "footer hints alone never prove the confirmation body");
  const noCount = complete.filter((line) => !/session\(s\)/.test(line));
  assert.equal(isQuitConfirmationFrame(compose(noCount), 2), false,
    "a missing owned/live session count is rejected");
  const noHeader = complete.filter((line) => !/Quit host\?/.test(line));
  assert.equal(isQuitConfirmationFrame(compose(noHeader), 2), false,
    "a missing confirmation header is rejected");
  const noHints = complete.filter((line) => !/enter\/y = quit host|esc\/n = cancel/.test(line));
  assert.equal(isQuitConfirmationFrame(compose(noHints), 2), false,
    "missing confirmation hints are rejected");
  assert.equal(isQuitConfirmationFrame(compose(complete), 1), false,
    "a mismatched owned/live count is rejected even when every row is present");
  const alteredHints = compose(complete).replace("esc/n = cancel", "esc/n = close");
  assert.equal(isQuitConfirmationFrame(alteredHints, 2), false,
    "altered confirmation hint text is rejected");
  const corruptedHeader = compose(complete).replace("Quit host?", "Quit hosts");
  assert.equal(isQuitConfirmationFrame(corruptedHeader, 2), false,
    "a corrupted confirmation header is rejected");
  const nativePaneOnly = ["Session host", ...complete.map((line) => `${" ".repeat(32)}│${line}`)].join("\n");
  assert.equal(isQuitConfirmationFrame(nativePaneOnly, 2), false,
    "the same text appearing only in the wider native content pane is never sidebar body authority");
  const staleSingleLine = compose([complete.join(" ")]);
  assert.equal(isQuitConfirmationFrame(staleSingleLine, 2), false,
    "a single flattened line outside the canonical 32-column rows is rejected");
});

// The synthetic contract is deliberately separate from native UI evidence: it
// verifies only that the append-only ledger never keys process labels by cwd.
test("pure process-incarnation ledger retains same-cwd processes and /new binding history", () => {
  const ledger = new ProcessIncarnationLedger();
  const makeWatcher = (pid: number): import("./helpers/session-host-native-saved-main-harness").OwnedPidExitWatcher => ({
    pid,
    observedExit: false,
    waitUntilRegistered: async () => undefined,
    waitForExit: async () => undefined,
    stop: async () => undefined,
  } as unknown as import("./helpers/session-host-native-saved-main-harness").OwnedPidExitWatcher);
  const cwd = "/owned/workspace";
  const first = ledger.addSpawn({ type: "pty_spawn", receipt: 1, pid: 101, cwd }, makeWatcher(101));
  const second = ledger.addSpawn({ type: "pty_spawn", receipt: 2, pid: 102, cwd }, makeWatcher(102));
  ledger.setRosterPosition(first, 0);
  ledger.setRosterPosition(second, 1);
  const firstOriginal = ledger.bindSessionStart(first, {
    type: "session_start", pid: 101, cwd, sessionId: "synthetic-contract-session-a",
    sessionFile: "/owned/agent/a.jsonl", displayName: "Saved A", storedName: "Saved A",
  }, 4);
  const secondSaved = ledger.bindSessionStart(second, {
    type: "session_start", pid: 102, cwd, sessionId: "synthetic-contract-session-a",
    sessionFile: "/owned/agent/a.jsonl", displayName: "Saved A", storedName: "Saved A",
  }, 8);
  const firstNew = ledger.bindSessionStart(first, {
    type: "session_start", pid: 101, cwd, sessionId: "synthetic-contract-session-new",
    sessionFile: "/owned/agent/new.jsonl", displayName: "(no messages)",
  }, 12);
  assert.equal(ledger.all().length, 2, "two exact spawn receipts sharing cwd stay separate process incarnations");
  assert.equal(first.bindings.length, 2, "same-PID /new appends a fresh conversation binding");
  assert.equal(first.bindings[0], firstOriginal, "the original saved ID/file/name history remains intact");
  assert.equal(second.bindings[0], secondSaved, "the independently opened saved conversation keeps its own binding");
  assert.equal(currentBinding(first), firstNew, "the latest binding is the actual /new conversation");
  assert.equal(first.rosterPosition, 0, "a new conversation binding does not replace the first process row");
  assert.equal(second.rosterPosition, 1, "the same-cwd reopened process keeps its distinct visible row position");
  assert.notEqual(first.key, second.key);
});

test("real public Main owns native Saved conversations, duplicate refusal, /new rebinding, same-workspace reopen, and graceful restoration", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveSavedRuntimePin(t);
  if (!runtime) return;
  requirePublicRuntimeDependencies(runtime);
  assert.equal(shortBaselineFitsTwentyFourColumns(), true,
    "the complete primary-screen witness fits in a 24-column terminal baseline");

  const scratch = createSavedMainScratchRoot();
  const workspace = canonicalWorkspace(createSavedMainWorkspace(scratch, `saved-main-workspace-${Math.random().toString(16).slice(2, 8)}`));
  const isolatedHome = join(scratch, "home");
  mkdirSync(isolatedHome, { mode: 0o700 });
  const nativeAgentRoot = createSavedMainAgentRoot(isolatedHome);
  for (const path of [join(isolatedHome, ".cache"), join(isolatedHome, ".local", "share"), join(isolatedHome, ".local", "state")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const observerFile = join(scratch, "observer", "saved-main.jsonl");
  const editorFixture = createSavedMainEditor(scratch, workspace);
  const candidate = createSavedMainCandidate(scratch);
  const editor = editorFixture.editor;
  const editorLog = editorFixture.log;
  const fixtureState = join(scratch, "fixture-state");
  mkdirSync(fixtureState, { mode: 0o700 });
  const providerJournal = join(fixtureState, "provider-journal.jsonl");
  writeFileSync(join(fixtureState, "turn-script.json"), JSON.stringify({
    steps: [{ text: "saved-main-offline-provider-complete" }],
  }) + "\n", { flag: "wx", mode: 0o600 });

  const childEnv = createSavedMainChildEnvironment(scratch, runtime, editor, observerFile, editorLog, nativeAgentRoot);
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
        process.stderr.write(`retained native saved-main PID watcher ${owned.pid}; kernel exit remains unconfirmed\n`);
      }
    }
    const childForceObserved = ptyJournalHasForceAttempt(driver.ptyRecords());
    if (!assertionsCompleted || failureCleanupRequested || childForceObserved) {
      process.stderr.write(`preserved Saved Main runtime tree ${scratch}; assertionsCompleted=${assertionsCompleted}; failureCleanupRequested=${failureCleanupRequested}; childForceAttemptObserved=${childForceObserved}\n`);
    }
    if (safeToDispose) {
      try {
        await driver.stopExitedWatchers();
      } catch {
        process.stderr.write(`preserved Saved Main runtime tree ${scratch}; an exited-PID watcher could not be stopped cleanly\n`);
      } finally {
        driver.dispose();
      }
    } else {
      process.stderr.write(`retained live owner and watchers for Saved Main tree ${scratch}; no unconfirmed child or owner was destroyed\n`);
    }
  });

  await driver.waitFrame(isCompleteWelcome,
    "fresh real public Main completely displays canonical Welcome, empty roster, New selection and Sidebar-only footer");
  assert.deepEqual(driver.records(), [], "the public native observer has no fabricated pre-session events");
  assert.equal(childEnv.PI_CODING_AGENT_DIR, nativeAgentRoot,
    "all native Pi children share the fixture's one ordinary root inside the isolated test HOME");
  assert.equal(driver.surface.frame().cols, OUTER_COLS);
  assert.equal(driver.surface.frame().rows, OUTER_ROWS);

  const created = await submitWorkspaceOnlyNew(driver, scratch, workspace);
  const processA = created.process;
  const originalBinding = created.binding;
  assert.equal(originalBinding.displayName, "(no messages)");
  assert.equal(originalBinding.storedName, undefined, "Pi's fresh no-message conversation has no invented name");
  assert.equal(processA.exitWatcher.observedExit, false, "its exact kernel watcher stays retained while the child is live");
  const initialProviderState = await waitForJsonl<ProviderRecord>(providerJournal,
    (records) => records.some((record) => record.event === "auto_model_selected"),
    EVENT_TIMEOUT_MS,
    "the public faux provider is actually selected in the owned native child before a user turn");
  assert.ok(initialProviderState.some((record) => record.event === "auto_model_selected"),
    "the deterministic offline provider uses Pi's public setModel event");

  const suffix = Math.random().toString(16).slice(2, 8);
  const savedName = `Saved-${suffix}`;
  await editFirstNativeName(driver, processA, originalBinding, savedName);
  assert.equal(existsSync(originalBinding.sessionFile), false,
    "a real native name alone does not fabricate or force an empty session file into the catalog");
  assert.equal(processIsAlive(processA.pid), true);

  const turnPrompt = `saved-main-real-turn-${suffix}`;
  const turnResponse = "saved-main-offline-provider-complete";
  const beforeProvider = readOwnedJsonl<ProviderRecord>(providerJournal).length;
  await createSavedConversation(driver, processA, originalBinding, turnPrompt, turnResponse);
  const providerLog = await waitForJsonl<ProviderRecord>(providerJournal,
    (records) => records.some((record) => record.event === "model_request" && record.lastUserPreview?.includes(turnPrompt)),
    EVENT_TIMEOUT_MS,
    "the real public faux provider receives the actual UI-delivered turn without external API calls");
  assert.ok(providerLog.length > beforeProvider, "the provider recorded a fresh actual model request");
  assert.equal(providerLog.filter((record) => record.event === "model_request").length, 1,
    "one offline scripted faux-provider request served the real initial turn");
  assert.equal(sessionFileHasStoredName(originalBinding.sessionFile, savedName), true,
    "actual public Pi persistence stores the deliberately entered name only after the real user turn");
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 1);
  assert.equal(driver.records().filter((record) => record.type === "agent_settled").length, 1);

  const firstDraft = `saved-main-active-draft-${suffix}`;
  await driver.writeAndWait(firstDraft, (text) => text.includes(firstDraft),
    "the saved live native conversation receives an unsent active draft through Pi's real editor");
  const firstActiveHeader = exactCurrentHeader(driver);
  assert.ok(firstActiveHeader.includes(savedName));
  assert.equal(currentBinding(processA), originalBinding,
    "the original saved ID/file is still the exact current live conversation at the first duplicate attempt");
  assert.ok(processIsStillOwnedAndLive(processA));
  await assertSavedListingAndDuplicateRefusal(driver, savedName, firstActiveHeader, workspace);
  const duplicateSnapshot = driver.snapshot();
  await cancelSavedPane(driver);
  await assertNoStartsAfter(driver, duplicateSnapshot, "closing the duplicate-refusal pane");
  assert.equal(exactCurrentHeader(driver), firstActiveHeader);
  assert.ok(driver.currentText().includes(firstDraft));
  assert.ok(processIsStillOwnedAndLive(processA));
  assert.equal(ptySpawnCount(driver.ptyRecords()), 1, "duplicate refusal created no extra real child PTY");
  assert.equal(driver.records().filter((record) => record.type === "session_start").length, 1,
    "duplicate refusal created no extra native session_start");

  // Reopen the real native catalog and cancel with Escape. This is a new UI
  // request, not a replayed stale listing or a synthetic SDK delay.
  await openSavedPane(driver, savedName, workspace);
  const cancelHeader = exactCurrentHeader(driver);
  const cancelDraft = firstDraft;
  const cancelDimensions = latestDimensions(driver.records(), processA.pid);
  const cancelSnapshot = driver.snapshot();
  await cancelSavedPane(driver);
  await assertNoFreshResizeOrStart(driver, cancelSnapshot, processA.pid, cancelDimensions);
  assert.equal(exactCurrentHeader(driver), cancelHeader, "canceled listing preserves the exact active header");
  assert.ok(driver.currentText().includes(cancelDraft), "canceled listing preserves the real unsent draft");
  assert.ok(processIsStillOwnedAndLive(processA), "canceling picker ownership does not cancel started child work");
  assert.equal(driver.ledger.all().length, 1, "canceling the picker adds no process incarnation");
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 1,
    "canceling the picker starts no additional native agent turn");

  // /new is an actual Pi command in the same process, not '/resume <id>' or a
  // host-created session. Clear the current draft using Pi's real Ctrl+C edit.
  await activateProcessRow(driver, processA, savedName);
  const clearSnapshot = driver.snapshot();
  driver.pty.write(KEYS.ctrlC);
  await driver.waitFrame((text) => !text.includes(firstDraft),
    "one genuine native Ctrl+C clears the first unsent draft without exiting Pi", clearSnapshot.frameRevision);
  assert.ok(processIsAlive(processA.pid));
  const newCommand = "/new";
  await driver.writeAndWait(newCommand, (text) => text.includes(newCommand),
    "the exact public native /new command is entered through the same owned Pi process");
  const beforeNew = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const newRecords = await driver.waitForRecords((fresh) => fresh.some((record) =>
    record.type === "session_start" && record.pid === processA.pid && record.cwd === workspace
      && record.sessionId !== originalBinding.sessionId),
  "actual native /new emits a fresh public session_start on the exact same PID/cwd", beforeNew.observerOffset);
  const newSessionStart = newRecords.slice(beforeNew.observerOffset).filter((record) => record.type === "session_start"
    && record.pid === processA.pid && record.cwd === workspace).at(-1);
  assert.ok(newSessionStart, "the same owned process produced the fresh native /new binding");
  const newBinding = driver.ledger.bindSessionStart(processA, newSessionStart!, newRecords.indexOf(newSessionStart!));
  assert.notEqual(newBinding.sessionId, originalBinding.sessionId);
  assert.notEqual(newBinding.sessionFile, originalBinding.sessionFile);
  assert.equal(newBinding.displayName, "(no messages)", "the new native conversation uses Pi's real no-message caption");
  assert.equal(newBinding.storedName, undefined, "the new conversation has no fabricated persisted name");
  assert.equal(newBinding.cwd, workspace);
  assert.equal(existsSync(newBinding.sessionFile), false, "Pi's planned /new file remains absent before a real turn");
  assert.equal(existsSync(originalBinding.sessionFile), true, "the original actually saved file survives /new");
  assert.equal(sessionFileHasStoredName(originalBinding.sessionFile, savedName), true,
    "the original persisted conversation name remains present after native /new");
  assert.equal(processA.bindings.length, 2, "the ledger keeps both exact conversation bindings for one process incarnation");
  assert.equal(currentBinding(processA), newBinding, "the latest conversation binding is attached to the exact spawn receipt");
  await driver.waitFrame((text) => text.split("\n")[0]?.includes("(no messages)") === true,
    "Main renders Pi's actual new no-messages conversation caption", beforeNew.frameRevision);
  const spawnCountAfterNew = ptySpawnCount(driver.ptyRecords());
  assert.equal(spawnCountAfterNew, 1, "/new did not spawn or adopt a second native process");

  const newDraft = `saved-main-new-conversation-draft-${suffix}`;
  await driver.writeAndWait(newDraft, (text) => text.includes(newDraft),
    "the new native conversation receives its own unsent proof draft on the same original PID");
  const activeNewHeader = exactCurrentHeader(driver);
  assert.ok(activeNewHeader.includes("(no messages)"));
  const rowsBeforeFirstSavedOpen = rosterEntries(driver.currentText());
  await moveRosterToAction(driver, "Saved conversations");
  const beforeSavedPane = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => isCompleteSavedSelection(text, savedName, workspace),
    "the host picker freshly paints the original persisted summary and recorded workspace details after /new released its binding", beforeSavedPane.frameRevision);
  const beforeSuccessfulOpen = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const opened = await awaitSavedOpen(driver, beforeSuccessfulOpen, workspace,
    originalBinding.sessionId, originalBinding.sessionFile);
  assert.notEqual(opened.process.pid, processA.pid,
    "opening the released original saved conversation creates a new independently owned native PID");
  assert.equal(opened.process.cwd, processA.cwd, "both independently owned processes use the exact same workspace cwd");
  assert.notEqual(opened.process.receipt.receipt, processA.receipt.receipt,
    "the same-cwd child has a fresh public IPty spawn receipt");
  assert.notEqual(opened.process.exitWatcher, processA.exitWatcher,
    "the same-cwd child retains its own independently registered exact-PID kernel watcher");
  assert.equal(opened.binding.sessionId, originalBinding.sessionId, "saved-open restores the exact original public session ID");
  assert.equal(opened.binding.sessionFile, originalBinding.sessionFile, "saved-open uses the exact original native file");
  assert.equal(opened.binding.displayName, savedName, "the public reopened row reports the persisted canonical caption");
  assert.equal(opened.binding.storedName, savedName, "the reopened SessionManager reports the exact stored name");
  assert.equal(opened.binding.cwd, originalBinding.cwd);
  await driver.waitFrame((text) => frameHeader(text) === savedName
    && isCompleteMainFocus(text)
    && selectedRosterEntry(text)?.label === savedName,
  "successful saved-open activates the fresh child row as the Main input owner", beforeSuccessfulOpen.frameRevision);
  driver.ledger.setRosterPosition(opened.process, selectedRosterEntry(driver.currentText())!.position);
  assertEarlierNativeRowsStayAtTheirObservedPositions(rowsBeforeFirstSavedOpen, rosterEntries(driver.currentText()));
  assert.equal(frameHeader(driver.currentText()), savedName,
    "saved-open transfers Main ownership to the restored conversation");
  assert.equal(processIsAlive(processA.pid), true);
  assert.equal(processIsAlive(opened.process.pid), true);
  assert.equal(opened.process.exitWatcher.observedExit, false,
    "the new same-workspace child's exact kernel watcher remains retained while live");
  assert.equal(ptySpawnCount(driver.ptyRecords()), 2,
    "one successful saved-open adds exactly one real child PTY after /new");
  assert.equal(driver.ptyRecords().slice(beforeSuccessfulOpen.ptyOffset).filter((record) => record.type === "pty_spawn").length, 1,
    "one deliberate Saved open generated exactly one public PTY spawn receipt");
  assert.equal(driver.records().slice(beforeSuccessfulOpen.observerOffset).filter((record) => record.type === "session_start").length, 1,
    "one deliberate Saved open generated exactly one public native session_start");

  // The auto-activated reopened child already owns Main: from the successful
  // submission's own frame revision, await its persisted transcript and the
  // complete Main-focused frame, then send fresh draft input directly. No
  // second host-row activation is used.
  await driver.waitFrame((text) => frameHeader(text) === savedName
    && isCompleteMainFocus(text)
    && selectedRosterEntry(text)?.label === savedName
    && hasFullWidthNativeEditorRule(text, driver.surface.frame().cols - 33)
    && text.includes(turnPrompt) && text.includes(turnResponse) && !text.includes(newDraft),
  "the auto-activated reopened child paints its own persisted surface without a second activation",
  beforeSuccessfulOpen.frameRevision);
  assert.ok(driver.currentText().includes(turnPrompt), "the restored surface renders the actual reopened saved transcript");
  assert.ok(driver.currentText().includes(turnResponse), "the restored surface renders the real provider response from disk");
  assert.ok(!driver.currentText().includes(newDraft), "the reopened saved process has an independent surface from the original /new draft");
  const reopenedDraft = `saved-main-reopened-child-draft-${suffix}`;
  await driver.writeAndWait(reopenedDraft, (text) => text.includes(reopenedDraft),
    "the freshly focused restored child receives an independent unsent draft without reselection");
  const reopenedHeader = exactCurrentHeader(driver);

  // Auto-activation changes which independent surface is visible, not either
  // child's draft. Revisit each exact creation-correlated row only AFTER the
  // fresh restored draft above proved that no second activation was needed.
  await activateProcessRow(driver, processA, newBinding.displayName);
  await driver.waitFrame((text) => frameHeader(text) === newBinding.displayName
    && isCompleteMainFocus(text)
    && hasFullWidthNativeEditorRule(text, driver.surface.frame().cols - 33)
    && text.includes(newDraft) && !text.includes(reopenedDraft),
  "the original /new sibling retains its independent draft after Saved auto-activation");
  assert.equal(exactCurrentHeader(driver), activeNewHeader,
    "returning to the exact original /new child preserves its full rendered header");
  await activateProcessRow(driver, opened.process, savedName);
  await driver.waitFrame((text) => frameHeader(text) === savedName
    && isCompleteMainFocus(text)
    && hasFullWidthNativeEditorRule(text, driver.surface.frame().cols - 33)
    && text.includes(reopenedDraft) && !text.includes(newDraft),
  "the restored child's independent draft survives deliberate sibling navigation");

  // Retain the pre-existing ignored-sidebar-input proof in its proper focus
  // domain: the restored child is now the owner, not the original /new child.
  await ensureSidebarFocus(driver);
  await driver.waitFrame((text) => isSidebarFocus(text) && isCompleteRosterFrame(text)
    && text.includes(reopenedDraft)
    && hasFullWidthNativeEditorRule(text, driver.surface.frame().cols - 33),
  "the current owner's complete editor and draft are visible before the sidebar input guard");
  const digitGuard = `271828182845${suffix.replace(/[a-f]/g, "9")}`;
  assert.match(digitGuard, /^\d+$/, "the sidebar guard contains only digits, never host commands");
  const beforeDigitGuard = driver.snapshot();
  const frameBeforeDigitGuard = driver.currentText();
  const headerBeforeDigitGuard = exactCurrentHeader(driver);
  driver.pty.write(digitGuard);
  await driver.waitForQuietFrame("the actual sidebar ignores digits without routing them to either child");
  assert.equal(driver.currentText(), frameBeforeDigitGuard,
    "ignored sidebar digits leave the complete current rendered frame unchanged");
  assert.equal(exactCurrentHeader(driver), headerBeforeDigitGuard);
  await assertNoStartsAfter(driver, beforeDigitGuard, "digits-only sidebar guard");
  assert.equal(processIsAlive(processA.pid), true);
  assert.equal(processIsAlive(opened.process.pid), true);

  const duplicateAgain = driver.snapshot();
  await assertSavedListingAndDuplicateRefusal(driver, savedName, reopenedHeader, workspace);
  assert.equal(ptySpawnCount(driver.ptyRecords()), 2,
    "same saved row is refused while the independently owned reopened child is live");
  assert.equal(driver.records().filter((record) => record.type === "session_start").length, 3,
    "the second duplicate refusal starts no additional native PID or conversation");
  await assertNoStartsAfter(driver, duplicateAgain, "second same-row duplicate refusal");

  // Close the refusal pane, explicitly activate the child row, then deliver
  // the genuine native Ctrl+C pair. Keep its exited row until after the next
  // successful saved-open so exit is not confused with duplicate ownership.
  const closeRefusal = driver.snapshot();
  driver.pty.write(KEYS.escape);
  await driver.waitFrame(isSidebarFocus, "Escape closes only the duplicate refusal picker", closeRefusal.frameRevision);
  assert.equal(exactCurrentHeader(driver), reopenedHeader,
    "refusal-pane cancellation leaves the reopened child as the unchanged active owner");
  assert.ok(driver.currentText().includes(reopenedDraft),
    "the reopened child's unique unsent draft survives both duplicate refusal and cancellation");
  await activateProcessRow(driver, opened.process, savedName);
  assert.ok(driver.currentText().includes(reopenedDraft), "the child draft survives picker cancellation and row reactivation");
  const childExitBefore = driver.snapshot();
  driver.pty.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
  const shutdownRecords = await driver.waitForRecords((fresh) => fresh.some((record) =>
    record.type === "session_shutdown" && record.pid === opened.process.pid && record.cwd === workspace
      && record.sessionId === originalBinding.sessionId && record.contextSessionId === originalBinding.sessionId
      && record.reason === "quit"),
  "the real native Ctrl+C pair causes the exact current saved conversation's public quit lifecycle", childExitBefore.observerOffset);
  const childShutdown = shutdownFor(shutdownRecords, opened.process, opened.binding);
  assert.equal(childShutdown?.reason, "quit");
  await driver.waitForKernelExit(opened.process);
  await driver.assertPtyExit(opened.process);
  const p2Position = opened.process.rosterPosition!;
  await driver.waitFrame((text) => {
    const header = frameHeader(text);
    const row = rosterEntries(text).find((entry) => entry.position === p2Position);
    return (header === savedName || header === "(session name unavailable)")
      && entryStatus(row) === "exited (code 0)";
  }, "Main renders the truthful exited card only after exact public PTY and retained kernel exit witnesses",
  childExitBefore.frameRevision);
  const afterChildExitEntries = rosterEntries(driver.currentText());
  assert.equal(entryStatus(afterChildExitEntries[p2Position]), "exited (code 0)",
    "the public exited child card remains present and truthfully reports its observed exit below its title");
  assert.ok(existsSync(originalBinding.sessionFile), "the exact saved file survives the reopened child's graceful exit");
  assert.equal(sessionFileHasStoredName(originalBinding.sessionFile, savedName), true,
    "the saved file retains its actual persisted name after child exit");

  const p1Position = processA.rosterPosition!;
  const rowsBeforeThirdOpen = rosterEntries(driver.currentText());
  const third = await openSavedSuccessfully(driver, savedName, workspace,
    originalBinding.sessionId, originalBinding.sessionFile, [processA, opened.process]);
  assert.notEqual(third.process.pid, processA.pid);
  assert.notEqual(third.process.pid, opened.process.pid,
    "reopening while the prior public row remains exited creates another new owned PID");
  assert.notEqual(third.process.receipt.receipt, opened.process.receipt.receipt);
  assert.notEqual(third.process.exitWatcher, opened.process.exitWatcher,
    "the final same-cwd re-open retains a third exact watcher rather than reusing the exited process witness");
  assert.equal(third.binding.sessionId, originalBinding.sessionId);
  assert.equal(third.binding.sessionFile, originalBinding.sessionFile);
  assert.equal(third.binding.displayName, savedName);
  assert.equal(third.binding.storedName, savedName);
  assert.equal(third.binding.cwd, workspace);
  assert.equal(opened.process.exitWatcher.observedExit, true,
    "the exited row's kernel watcher remains retained after a later saved-open");
  assert.equal(rosterEntries(driver.currentText()).length, rowsBeforeThirdOpen.length + 1,
    "the exited row was not deleted before its original conversation was opened again");
  assert.equal(entryStatus(rosterEntryAt(driver, p2Position)), "exited (code 0)",
    "the first reopened child's exited row remains independently visible after P3 creation");
  assert.equal(rosterEntryAt(driver, p1Position)?.position, p1Position,
    "the original /new process row remains at its own creation-correlated position");
  assert.equal(existsSync(originalBinding.sessionFile), true,
    "the exact original native file remains present across both successful opens");
  assert.equal(third.process.exitWatcher.observedExit, false);
  assert.equal(processIsAlive(processA.pid), true);
  assert.equal(processIsAlive(third.process.pid), true);
  assert.equal(ptySpawnCount(driver.ptyRecords()), 3,
    "three fresh public spawn receipts correspond to the initial child and two actual Saved opens");
  assert.equal(driver.ledger.all().length, 3,
    "same cwd never overwrites any process incarnation or its exact kernel watcher");

  // Only after the same saved row successfully reopened as a new process do we
  // remove the independently observed exited P2 row through the real Delete UI.
  await ensureSidebarFocus(driver);
  const beforeDeleteRows = rosterEntries(driver.currentText());
  const nativeRowsBeforeDelete = beforeDeleteRows.filter((entry) =>
    !["Saved conversations", "New session", "Quit host"].includes(entry.label));
  assert.equal(nativeRowsBeforeDelete.length, 3);
  assert.equal(entryStatus(beforeDeleteRows[p2Position]), "exited (code 0)",
    "the exact exited row is still present immediately before its explicit native removal");
  await moveRosterToPosition(driver, p2Position);
  assert.equal(selectedRosterEntry(driver.currentText())?.position, p2Position,
    "Delete is targeted by the exact creation-correlated exited-row position, not its unavailable caption");
  const beforeDelete = driver.snapshot();
  driver.pty.write(KEYS.delete);
  await driver.waitFrame((text) => {
    const rows = rosterEntries(text);
    const nativeRows = rows.filter((entry) => !["Saved conversations", "New session", "Quit host"].includes(entry.label));
    return text.includes(`Sessions (${nativeRowsBeforeDelete.length - 1})`)
      && nativeRows.length === nativeRowsBeforeDelete.length - 1
      && nativeRows.some((entry) => entry.label === "(no messages)")
      && nativeRows.some((entry) => entry.label === savedName)
      && !nativeRows.some((entry) => entryStatus(entry) === "exited (code 0)");
  }, "the real host Delete removes only the already-exited row after its saved conversation has reopened", beforeDelete.frameRevision);
  await assertNoStartsAfter(driver, beforeDelete, "removing the positively exited row");
  assert.equal(driver.ledger.all().length, 3,
    "row removal does not erase the historical process receipt, conversation binding, or exit watcher");
  assert.equal(opened.process.exitWatcher.observedExit, true,
    "the removed row's exact kernel-exit witness remains retained");
  assert.ok(processIsStillOwnedAndLive(processA), "removing an exited sibling leaves the original /new process live");
  assert.ok(processIsStillOwnedAndLive(third.process), "removing an exited sibling leaves the newly reopened process live");
  assert.equal(existsSync(originalBinding.sessionFile), true,
    "the real Delete action removes only the host row and preserves the shared saved conversation file");

  // q is valid here only because the rendered sidebar-only footer proves the
  // real focus owner and both live children were independently rechecked.
  await ensureSidebarFocus(driver);
  await moveRosterToAction(driver, "Quit host");
  assert.equal(isSidebarFocus(driver.currentText()), true,
    "the actual rendered sidebar-only e-edit/q-quit footer proves host focus before q");
  assert.equal(selectedRosterEntry(driver.currentText())?.label, "Quit host",
    "the real Quit host entry is visibly highlighted before q invokes its shortcut");
  const currentLive = [processA, third.process];
  for (const process of currentLive) {
    assert.ok(processIsStillOwnedAndLive(process), "each live child has an exact fresh spawn receipt and registered kernel watcher");
    assert.equal(process.exitWatcher.observedExit, false);
  }
  assert.equal(opened.process.exitWatcher.observedExit, true, "the only earlier child is already exactly exited");
  const finalBeforeQuit = driver.snapshot();
  driver.pty.write("q");
  await driver.waitFrame((text) => isQuitConfirmationFrame(text, 2),
  "the real q shortcut opens the actual confirmation for the two independently known live children", finalBeforeQuit.frameRevision);
  await assertNoStartsAfter(driver, finalBeforeQuit, "host Quit confirmation");
  const beforeConfirm = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const finalRecords = await driver.waitForRecords((fresh) => {
    const shutdowns = fresh.filter((record) => record.type === "session_shutdown");
    return currentLive.every(({ pid }) => shutdowns.some((record) => record.pid === pid && record.reason === "quit"));
  }, "confirmed host Quit produces public quit shutdown events for every current live binding", beforeConfirm.observerOffset);

  for (const { process, binding } of liveBindingsToCheck(currentLive)) {
    const shutdown = shutdownFor(finalRecords, process, binding);
    assert.equal(shutdown?.reason, "quit",
      `the actual public host shutdown reports quit for exact current conversation ${binding.sessionId}`);
    assert.equal(shutdown?.sessionId, binding.sessionId);
    assert.equal(shutdown?.contextSessionId, binding.sessionId);
  }
  await Promise.all(currentLive.map((entry) => driver.waitForKernelExit(entry)));
  await Promise.all(driver.ledger.all().map((entry) => driver.assertPtyExit(entry)));
  await driver.waitForNormalOuterExit();
  assert.equal(driver.exitEvent?.exitCode, 0, "the real public Main completed graceful runSessionHost return zero");
  assert.ok(!driver.exitEvent?.signal, "the actual outer PTY returned normally without a signal");

  const allProcesses = driver.ledger.all();
  assert.deepEqual(allProcesses.map((entry) => entry.receipt.receipt), [1, 2, 3],
    "all and only the three actual public spawn receipts remain in the process-incarnation ledger");
  assert.deepEqual(allProcesses.map((entry) => entry.cwd), [workspace, workspace, workspace],
    "all independent process incarnations share the same exact canonical workspace");
  assert.equal(processA.bindings.length, 2, "only the first process has original and /new native conversation bindings");
  assert.deepEqual(processA.visibleLabelHistory.map((entry) => entry.label), ["(no messages)", savedName, "(no messages)"],
    "the original and /new labels remain append-only on their exact shared-PID incarnation");
  assert.deepEqual(opened.process.visibleLabelHistory.map((entry) => entry.label), [savedName],
    "the exited saved-open process keeps its own name history despite same cwd and row removal");
  assert.deepEqual(third.process.visibleLabelHistory.map((entry) => entry.label), [savedName],
    "the final reopened process has an independent saved-name history");
  assert.equal(opened.process.bindings.length, 1);
  assert.equal(third.process.bindings.length, 1);
  assert.equal(findBinding(processA, originalBinding.sessionId, originalBinding.sessionFile), originalBinding,
    "the original binding remains available after /new changes only the latest binding");
  assert.equal(currentBinding(processA), newBinding);
  assert.equal(recordHasCurrentConversation(finalRecords.filter((record) => record.type === "session_shutdown"
    && record.pid === processA.pid).at(-1)!, processA), true,
  "the final shutdown for the original process belongs to its latest /new conversation");
  assert.equal(recordHasCurrentConversation(finalRecords.filter((record) => record.type === "session_shutdown"
    && record.pid === third.process.pid).at(-1)!, third.process), true,
  "the final shutdown for the reopened process belongs to its exact saved binding");
  assert.equal(allProcesses.every((entry) => entry.exitWatcher.observedExit), true,
    "every exact registered kernel watcher observed its owned PID exit");
  assert.equal(ptySpawnCount(driver.ptyRecords()), allProcesses.length,
    "every process incarnation has exactly one real public PTY spawn receipt");
  assert.equal(driver.records().filter((record) => record.type === "session_start").length,
    allProcesses.reduce((total, process) => total + process.bindings.length, 0),
  "every fresh public session_start is retained as one exact process-receipt conversation binding");
  const finalStarts = sessionStarts(driver.records());
  for (const record of finalStarts) {
    assert.ok(allProcesses.some((process) => process.bindings.some((binding) =>
      binding.spawnReceipt === process.receipt.receipt && binding.pid === record.pid && binding.cwd === record.cwd
        && binding.sessionId === record.sessionId && binding.sessionFile === record.sessionFile)),
    "each public lifecycle start maps to its own exact spawn receipt/PID/cwd/session ID/file");
    assert.equal(record.agentDir, nativeAgentRoot, "each public child uses the one shared native root inside isolated HOME");
    assert.equal(record.tty, true, "each owned native process is a real terminal child");
    assert.deepEqual(record.credentialLikeEnvironmentNames, [], "no child inherited credential-like environment names");
  }
  assert.equal(driver.ptyRecords().filter((record) => record.type === "pty_exit").length, allProcesses.length,
    "every process incarnation has one real public @lydell/node-pty onExit receipt");
  assert.equal(ptyJournalHasForceAttempt(driver.ptyRecords()), false,
    "the real runner observed no child force/kill attempt or failed public observer attachment");
  assert.deepEqual(driver.ptyRecords().filter((record) => !["pty_spawn", "pty_exit"].includes(record.type)), [],
    "the metadata-only runner journal contains no hidden lifecycle, content, or force records");
  assert.deepEqual(driver.outerKillAttempts, [], "successful graceful restoration required no outer cleanup signal");
  assert.equal(driver.records().filter((record) => record.type === "agent_start").length, 1,
    "only the deliberate initial user turn ran a native agent");
  assert.equal(driver.records().filter((record) => record.type === "tool_call").length, 0,
    "no native tool was called during saved-picker operations");
  assert.equal(sessionFileHasStoredName(originalBinding.sessionFile, savedName), true,
    "the retained original saved file still carries the real persisted canonical name");
  assert.equal(existsSync(newBinding.sessionFile), false,
    "the unsent /new conversation remained a genuinely empty absent native file");
  assert.equal(shortBaselineFitsTwentyFourColumns(), true);
  assert.equal(OUTER_COLS, 120);
  assert.equal(OUTER_ROWS, 50);
  assert.equal(OUTER_RESTORATION_BASELINE, "PRG-SAVED-MAIN");
  assert.equal(runtime.version, "1.1.0");
  assertionsCompleted = true;
});
