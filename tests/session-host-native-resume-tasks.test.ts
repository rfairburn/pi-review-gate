/**
 * Focused source-only regression harness for automatic native Main resume,
 * truthful 0→1→0 activity, and event-driven recovery after a retained stopped,
 * recovery-required execution record is repaired. The authorized
 * primary macOS run uses a real pinned Pi 1.4.0 Main and an actual native saved
 * conversation; this test file is intentionally not runnable from an executor
 * role or without explicit runtime pins.
 *
 * Evidence is retained under the private owned scratch root. The metadata-only
 * activity log contains counts and booleans only; the existing public observer
 * remains scoped to synthetic session identities/paths and process lifecycle.
 * #412 separation of channels: a fresh owning runtime that admits or resumes no
 * work reports known idle/zero CURRENT activity on its restored row before any
 * input even while both retained historical records are held unreadable, and
 * repair or ordinary row activation need not create work to keep that zero.
 * (Exact first-publication ordering at loaded Ready is proven by the #412
 * restore/recovery regressions, not by this native screen observation.) Those former
 * runtime counts are historical records, never current activity. The same held
 * records still keep the separate conservative cleanup-ownership channel
 * unknown, so a live row still requires the actual native stop confirmation.
 * Genuine unreadable CURRENT-source negatives keep failing closed to unknown in
 * their own regressions; this case never substitutes a false zero for them.
 * Exact numeric values are required for the actually observed held/settled
 * lifecycle. Shell values are retained only as nullable observations; this case
 * makes no direct shell-count acceptance claim.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { readGroup } from "../src/execution/background-group-store";
import { atomicWriteExclusive } from "../src/execution/durable-write";
import { operationOwnershipStatus, operationRecordPath, readOperationRecord } from "../src/execution/operation-record";
import { SessionStateStore } from "../src/session-state";
import { rosterStorePath } from "../src/session-host/roster-store";
import {
  ChangeSignal,
  EVENT_TIMEOUT_MS,
  KEYS,
  OBSERVER_FIXTURE,
  OUTER_COLS,
  OUTER_ROWS,
  TEST_TIMEOUT_MS,
} from "./helpers/session-host-native-main-harness";
import {
  PROVIDER_FIXTURE,
  SavedMainDriver,
  assertNoForbiddenSessionArgs,
  canonicalWorkspace,
  createSavedMainAgentRoot,
  createSavedMainCandidate,
  createSavedMainChildEnvironment,
  createSavedMainEditor,
  createSavedMainScratchRoot,
  createSavedMainWorkspace,
  getWorkspaceFieldValue,
  isQuitConfirmationFrame,
  isSavedConversationsPane,
  isSidebarFocusedFrame,
  nativeFormFieldIsEmpty,
  originalNodeOptions,
  parseRosterFrame,
  processIsAlive,
  ptyJournalHasForceAttempt,
  readOwnedJsonl,
  renderedTitleMatches,
  requirePublicRuntimeDependencies,
  resolveSavedRuntimePin,
  rosterEntries,
  selectedRosterEntry,
  sessionFileHasStoredName,
  sidebarRosterHidden,
  waitForJsonl,
  workspaceOnlyNewFrame,
  type ProcessIncarnation,
} from "./helpers/session-host-native-saved-main-harness";
import { SIDEBAR_COLUMNS, frameHeader, rosterCards, sidebarPaneLines } from "./helpers/session-host-native-roster-witness";

const RESUME_TASK_WORKER = join(process.cwd(), "tests", "fixtures", "session-host-native-resume-task-worker.cjs");
const SEED_PROMPT = "synthetic-saved-resume-seed-user";
const SEED_RESPONSE = "synthetic-saved-resume-seed-assistant";
const TASK_PROMPT = "synthetic-first-task-after-automatic-resume";
const TASK_RESPONSE = "synthetic-resumed-task-dispatch-returned";
const TASK_COMPLETION_WAKE_RESPONSE = "synthetic-controlled-task-completion-wake-ack";
const RECOVERY_REQUIRED_PROMPT = "synthetic-stopped-recoverable-association-seed-user";
const RECOVERY_REQUIRED_RESPONSE = "synthetic-stopped-recoverable-association-seed-returned";
const RECOVERABLE_FAILURE_WAKE_RESPONSE = "synthetic-controlled-executor-failure-wake-ack";
const RECOVERY_PROMPT = "synthetic-repaired-record-activity-recovery-user";
const RECOVERY_RESPONSE = "synthetic-repaired-record-recovery-returned";
const RECOVERY_COMPLETION_WAKE_RESPONSE = "synthetic-recovery-completion-wake-ack";
const ROW_COUNTS = /^bg tasks (unknown|\d+) \| shells (unknown|\d+)$/u;
const FIXTURE_TIMEOUT_MS = 240_000;
const EXCLUDED_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

interface ActivityCounts {
  readonly tasks: number | null;
  readonly shells: number | null;
  readonly status: string;
}

interface ProviderRecord {
  readonly event?: string;
  readonly requestIndex?: number;
  readonly stepsAvailable?: number;
  readonly historyMarkers?: { readonly user?: boolean; readonly assistant?: boolean };
  readonly lastUserPreview?: string;
  readonly lastUserMessage?: string;
}

interface StoredRosterFixture {
  readonly version?: unknown;
  readonly entries?: readonly {
    readonly slotId?: unknown;
    readonly sessionId?: unknown;
    readonly workspace?: unknown;
    readonly name?: unknown;
    readonly persistence?: unknown;
  }[];
  readonly activeSlotId?: unknown;
}

function rejectExecutorRoleBeforeWork(): void {
  const forbidden = Object.keys(process.env).find((name) =>
    /^(?:PI_REVIEW_GATE_RUNTIME_ROLE|PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG)$/iu.test(name));
  assert.equal(forbidden, undefined,
    "native automatic-resume acceptance refuses the actual executor-role/catalog markers before creating scratch");
}

function initSyntheticGitWorkspace(workspace: string): void {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: workspace,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  execFileSync("git", ["init", "-q"], { cwd: workspace, env, stdio: "pipe" });
  writeFileSync(join(workspace, "README.md"), "fixture-owned native resume workspace\n", { flag: "wx", mode: 0o600 });
  execFileSync("git", ["add", "README.md"], { cwd: workspace, env, stdio: "pipe" });
  execFileSync("git", [
    "-c", "user.name=Native Resume Fixture",
    "-c", "user.email=native-resume-fixture@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-qm", "synthetic resume baseline",
  ], { cwd: workspace, env, stdio: "pipe" });
}

function isWelcomeFrame(text: string): boolean {
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  return frameHeader(text) === "Session host" && text.includes("Welcome")
    && parsed.complete && parsed.count === 0
    && isSidebarFocusedFrame(text, SIDEBAR_COLUMNS)
    && selectedRosterEntry(text)?.label === "New session";
}

function isMainFocusFrame(text: string): boolean {
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  if (!parsed.complete) return false;
  const pane = sidebarPaneLines(text, SIDEBAR_COLUMNS);
  const offset = /^\s*Sessions \(/u.test(pane[0] ?? "") ? 0 : 1;
  const footer = pane.slice(offset + 1 + parsed.entryEnd).map((line) => line.trim()).filter(Boolean);
  return footer.length === 2 && footer[0] === "F8 toggle | enter open" && footer[1] === "esc hide | q quit";
}

function activityCounts(text: string, caption: string): ActivityCounts | undefined {
  const cards = rosterCards(text, SIDEBAR_COLUMNS).filter((card) => renderedTitleMatches(card.title, caption));
  if (cards.length !== 1) return undefined;
  if (cards[0]!.background === "background unknown") {
    return { tasks: null, shells: null, status: cards[0]!.status };
  }
  const match = ROW_COUNTS.exec(cards[0]!.background);
  if (!match) return undefined;
  return {
    tasks: match[1] === "unknown" ? null : Number(match[1]),
    shells: match[2] === "unknown" ? null : Number(match[2]),
    status: cards[0]!.status,
  };
}

function recordActivityEvidence(
  evidenceFile: string,
  stage: string,
  counts: ActivityCounts,
  extra: Readonly<Record<string, boolean | string | number>> = {},
): void {
  const record = {
    stage,
    activeTasks: counts.tasks === null ? "unknown" : counts.tasks,
    activeTaskCountSource: counts.tasks === null ? "unknown" : "native-owned-activity-sidebar-row",
    // Preserve shell observability without making it an acceptance assertion.
    activeShells: counts.shells === null ? "unknown" : counts.shells,
    sidebarAggregateStatus: counts.status,
    ...extra,
  };
  appendFileSync(evidenceFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readPersistedRoster(path: string): StoredRosterFixture {
  const stats = lstatSync(path);
  assert.ok(stats.isFile() && !stats.isSymbolicLink() && stats.size <= 64 * 1024,
    "the synthetic automatic-resume roster is a bounded regular file");
  return JSON.parse(readFileSync(path, "utf8")) as StoredRosterFixture;
}

async function waitForPersistedSavedRoster(
  path: string,
  expected: { readonly sessionId: string; readonly workspace: string; readonly name: string },
): Promise<StoredRosterFixture> {
  const signal = new ChangeSignal();
  const directory = dirname(path);
  const watcher = watch(directory, (_event, filename) => {
    if (filename === null || filename.toString() === basename(path)) signal.notify();
  });
  try {
    // The roster predicate re-reads the durable roster file, so it is also
    // re-evaluated on the shared bounded recheck. Predicate, timeout, description,
    // roster identity checks, and the original deadline are unchanged.
    await signal.waitForRecheck(() => {
      if (!existsSync(path)) return false;
      const roster = readPersistedRoster(path);
      return roster.version === 1 && roster.activeSlotId !== undefined
        && roster.entries?.some((entry) => entry.slotId === roster.activeSlotId
          && entry.sessionId === expected.sessionId && entry.workspace === expected.workspace
          && entry.name === expected.name && entry.persistence === "saved") === true;
    }, EVENT_TIMEOUT_MS, "Main durably remembers the exact saved conversation and active slot before host shutdown");
    return readPersistedRoster(path);
  } finally {
    watcher.close();
  }
}

async function waitForOwnedFile(path: string, description: string): Promise<void> {
  const signal = new ChangeSignal();
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename === null || filename.toString() === basename(path)) signal.notify();
  });
  try {
    // A landed proof file is a durable fact, so re-check it on the shared bounded
    // recheck as well as on notification, with the same predicate, timeout, and
    // original deadline.
    await signal.waitForRecheck(() => existsSync(path), EVENT_TIMEOUT_MS, description);
  } finally {
    watcher.close();
  }
}

async function waitForFixtureJson(path: string, description: string): Promise<Record<string, unknown>> {
  const signal = new ChangeSignal();
  const directory = dirname(path);
  const watcher = watch(directory, (_event, filename) => {
    if (filename === null || filename.toString() === basename(path)) signal.notify();
  });
  try {
    // The fixture marker's existence is a durable fact and is re-read on the shared
    // bounded recheck; the bounded size/type and JSON object checks below, the
    // fixture timeout, and the original deadline are unchanged.
    await signal.waitForRecheck(() => existsSync(path), FIXTURE_TIMEOUT_MS, description);
    const stats = lstatSync(path);
    assert.ok(stats.isFile() && !stats.isSymbolicLink() && stats.size <= 4096,
      `${description}: fixture marker is a bounded regular file`);
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value),
      `${description}: fixture marker is an object`);
    return value as Record<string, unknown>;
  } finally {
    watcher.close();
  }
}

async function restoreOwnedFixtureExecution(
  binding: { readonly sessionId: string; readonly sessionFile: string; readonly cwd: string },
  agentDir: string,
) {
  const store = new SessionStateStore({
    sessionId: binding.sessionId,
    sessionFile: binding.sessionFile,
    cwd: binding.cwd,
  });
  const restored = await store.restore(binding.cwd, { agentDir, sessionId: binding.sessionId });
  assert.ok(restored, "the actual saved native conversation has an authenticated review-gate sidecar");
  return restored.execution;
}

async function waitForAuthenticatedStoppedRecoverableTask(
  root: string,
  scratch: string,
): Promise<{
  readonly root: string;
  readonly manifestPath: string;
  readonly operationPath: string;
  readonly taskId: string;
  readonly generation: number;
  readonly bundle: {
    readonly operationId: string;
    readonly waveId: string;
    readonly taskId: string;
    readonly waveRoot: string;
    readonly expectedRevision: number;
  };
}> {
  const canonicalScratch = realpathSync(scratch);
  const canonicalRoot = realpathSync(root);
  const rel = relative(canonicalScratch, canonicalRoot);
  assert.ok(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    "the stopped recovery-required execution record is inside the native test's owned scratch tree");
  const manifestPath = join(canonicalRoot, "execution.json");
  const signal = new ChangeSignal();
  const watcher = watch(canonicalRoot, (_event, filename) => {
    if (filename === null || filename.toString() === basename(manifestPath)) signal.notify();
  });
  try {
    // The manifest predicate re-reads and re-parses the durable execution record on
    // every evaluation, so it also re-reads on the shared bounded recheck. The
    // bounded size/type checks, state/generation acceptance, timeout, description,
    // and the original deadline are unchanged.
    await signal.waitForRecheck(() => {
      try {
        const stats = lstatSync(manifestPath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) return false;
        const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const tasks = (value as { tasks?: unknown }).tasks;
        return Array.isArray(tasks) && tasks.some((task) => task !== null && typeof task === "object"
          && (task as { state?: unknown; generation?: unknown }).state === "paused_recoverable"
          && (task as { generation?: unknown }).generation === 1);
      } catch {
        return false;
      }
    }, EVENT_TIMEOUT_MS, "the real controller durably records its stopped recovery-required execute task");
  } finally {
    watcher.close();
  }
  const restored = await readGroup(canonicalRoot);
  const stoppedTasks = restored.group.tasks.filter((task) => task.state === "paused_recoverable" && task.generation === 1);
  assert.equal(restored.group.root, canonicalRoot, "readGroup authenticates the exact saved execution root");
  assert.equal(restored.group.kind, "execute", "the stopped recovery-required record came from the real execute route");
  assert.equal(stoppedTasks.length, 1,
    "the authentic execution record contains exactly one generation-1 paused_recoverable task");
  const stoppedTask = stoppedTasks[0]!;
  assert.equal(stoppedTask.generation, 1, "the real controller retains the exact generation-1 executor attempt");
  assert.ok(stoppedTask.error, "the registered executor failure is durably recorded on the stopped task");
  assert.ok(stoppedTask.waveRoot, "the real execute task retains its exact authenticated operation root");
  assert.ok(stoppedTask.bundle, "the stopped task retains its authenticated recovery bundle");
  assert.equal(stoppedTask.bundle.taskId, stoppedTask.taskId, "the bundle authenticates the same generation's task");
  assert.equal(stoppedTask.bundle.waveRoot, stoppedTask.waveRoot,
    "the retained checkpoint bundle authenticates the task's exact operation root");
  const operationArtifactDir = join(stoppedTask.waveRoot, "artifacts", stoppedTask.taskId);
  const canonicalArtifactDir = realpathSync(operationArtifactDir);
  const artifactRel = relative(canonicalScratch, canonicalArtifactDir);
  assert.ok(artifactRel !== ".." && !artifactRel.startsWith(`..${sep}`) && !isAbsolute(artifactRel),
    "the exact operation lease is inside the native test's owned scratch tree");
  const operationPath = operationRecordPath(operationArtifactDir);
  const operation = await readOperationRecord(operationPath);
  assert.equal(operation.taskId, stoppedTask.taskId, "the owned operation record authenticates the same stopped task");
  assert.equal(operation.operationId, stoppedTask.bundle.operationId,
    "the retained bundle and authenticated operation record identify the same operation");
  assert.equal(operation.waveId, stoppedTask.bundle.waveId,
    "the retained bundle and authenticated operation record identify the same wave");
  assert.ok(operation.revision >= stoppedTask.bundle.expectedRevision,
    "the authenticated operation record satisfies the retained bundle's expected revision");
  assert.ok(["released", "dead"].includes(operationOwnershipStatus(operation).status),
    "the exact operation record proves the executor's ownership was released or dead");
  return {
    root: canonicalRoot,
    manifestPath,
    operationPath,
    taskId: stoppedTask.taskId,
    generation: stoppedTask.generation,
    bundle: { ...stoppedTask.bundle },
  };
}

async function ensureSidebarFocus(driver: SavedMainDriver): Promise<void> {
  if (isSavedConversationsPane(driver.currentText())) {
    throw new Error("automatic-resume task acceptance does not type through the Saved picker");
  }
  await driver.waitFrame((text) => isSidebarFocusedFrame(text, SIDEBAR_COLUMNS)
    || isMainFocusFrame(text) || sidebarRosterHidden(text),
  "a complete sidebar, Main, or hidden-pane witness establishes the current focus domain");
  // A renamed roster card may paint before the focus footer in the same
  // repaint. F8 toggles differently in Main and sidebar focus, so settle the
  // prior action's frame before deciding whether one real F8 is needed.
  await driver.waitForQuietFrame("the native focus frame finishes repainting before the F8 decision");
  if (isSidebarFocusedFrame(driver.currentText(), SIDEBAR_COLUMNS)) return;
  const snapshot = driver.snapshot();
  driver.pty.write(KEYS.f8);
  await driver.waitFrame((text) => isSidebarFocusedFrame(text, SIDEBAR_COLUMNS),
    "one real F8 focuses the restored native Main roster without creating a process", snapshot.frameRevision);
}

async function moveRosterTo(
  driver: SavedMainDriver,
  target: (entry: ReturnType<typeof rosterEntries>[number]) => boolean,
  description: string,
): Promise<void> {
  let parsed = parseRosterFrame(driver.currentText(), SIDEBAR_COLUMNS);
  assert.equal(parsed.complete, true, "a complete native roster is observed before navigation");
  let targetEntry = parsed.entries.filter(target);
  assert.equal(targetEntry.length, 1, `${description} identifies exactly one real roster entry`);
  let selected = selectedRosterEntry(driver.currentText());
  if (!selected) {
    const before = driver.snapshot();
    driver.pty.write(KEYS.down);
    await driver.waitFrame((text) => parseRosterFrame(text, SIDEBAR_COLUMNS).complete
      && selectedRosterEntry(text)?.position === 0,
    "one genuine Down establishes the first roster highlight without activation", before.frameRevision);
    parsed = parseRosterFrame(driver.currentText(), SIDEBAR_COLUMNS);
    selected = selectedRosterEntry(driver.currentText());
  }
  assert.ok(selected, "a real selected roster entry is observed before navigation");
  for (let step = 0; step < parsed.entries.length && !target(selected!); step += 1) {
    const nextPosition = (selected!.position + 1) % parsed.entries.length;
    const before = driver.snapshot();
    driver.pty.write(KEYS.down);
    await driver.waitFrame((text) => {
      const next = selectedRosterEntry(text);
      return parseRosterFrame(text, SIDEBAR_COLUMNS).complete && next?.position === nextPosition;
    }, `one genuine Down paints the next roster entry toward ${description}`, before.frameRevision);
    selected = selectedRosterEntry(driver.currentText());
    parsed = parseRosterFrame(driver.currentText(), SIDEBAR_COLUMNS);
  }
  targetEntry = parsed.entries.filter(target);
  assert.equal(targetEntry.length, 1);
  assert.equal(selected?.position, targetEntry[0]!.position,
    `the exact real row for ${description} is selected without entering a child`);
}

async function moveRosterToAction(
  driver: SavedMainDriver,
  label: "New session" | "Quit host",
): Promise<void> {
  await ensureSidebarFocus(driver);
  await moveRosterTo(driver, (entry) => entry.label === label, `host action ${label}`);
}

async function submitWorkspaceOnlyNew(
  driver: SavedMainDriver,
  scratch: string,
  workspace: string,
): Promise<{ readonly process: ProcessIncarnation; readonly binding: Awaited<ReturnType<SavedMainDriver["awaitSessionStart"]>> }> {
  await moveRosterToAction(driver, "New session");
  const beforeOpen = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame(workspaceOnlyNewFrame,
    "the genuine native New form opens with only its Workspace field", beforeOpen.frameRevision);
  assert.equal(nativeFormFieldIsEmpty(driver.currentText(), "> Workspace:"), true,
    "the actual New Workspace Editor starts empty");

  const prefix = join(scratch, "resume-workspace-");
  const beforePrefix = driver.snapshot();
  await driver.writeAndWait(prefix, (text) => text.includes(prefix),
    "the synthetic workspace path is typed through Pi's real native Editor");
  const workspaceName = workspace.slice(workspace.lastIndexOf(sep) + 1);
  await driver.waitFrame((text) => workspaceOnlyNewFrame(text) && text.includes(workspaceName),
    "native filesystem completion displays the exact owned workspace", beforePrefix.frameRevision);
  assert.equal(getWorkspaceFieldValue(driver.currentText()), prefix);
  const beforeCompletion = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => workspaceOnlyNewFrame(text)
    && getWorkspaceFieldValue(text) === `${workspace}/`,
  "the first Enter accepts the exact native workspace completion", beforeCompletion.frameRevision);

  const beforeSubmit = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const process = await driver.awaitSpawn(beforeSubmit, workspace);
  const binding = await driver.awaitSessionStart(process, beforeSubmit,
    (record) => record.cwd === workspace && record.displayName === "(no messages)");
  await driver.waitFrame((text) => frameHeader(text) === "(no messages)"
    && isMainFocusFrame(text) && selectedRosterEntry(text)?.label === "(no messages)",
  "the newly created native child becomes the actual Main input owner", beforeSubmit.frameRevision);
  const selected = selectedRosterEntry(driver.currentText());
  assert.ok(selected);
  driver.ledger.setRosterPosition(process, selected!.position);
  assert.equal(process.cwd, workspace);
  assert.equal(binding.cwd, workspace);
  assert.equal(existsSync(binding.sessionFile), false,
    "the actual native planned session file is absent until a real user turn");
  assert.equal(driver.ptyRecords().filter((record) => record.type === "pty_spawn").length, 1,
    "one genuine New submission produced exactly one child PTY spawn");
  return { process, binding };
}

async function renameNativeRow(
  driver: SavedMainDriver,
  process: ProcessIncarnation,
  binding: Awaited<ReturnType<SavedMainDriver["awaitSessionStart"]>>,
  name: string,
): Promise<void> {
  await ensureSidebarFocus(driver);
  await moveRosterTo(driver,
    (entry) => entry.kind === "native" && renderedTitleMatches(entry.title, binding.displayName),
    "the exact freshly owned native session row");
  const beforeEdit = driver.snapshot();
  driver.pty.write("e");
  await driver.waitFrame((text) => text.includes("Edit native session name")
    && text.includes("> New name:") && nativeFormFieldIsEmpty(text, "> New name:"),
  "the real host Edit form renders an empty replacement field", beforeEdit.frameRevision);
  await driver.writeAndWait(name, (text) => text.includes(name),
    "the controlled saved-session name is entered through the actual native Editor");
  const beforeSave = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const nameRecords = await driver.waitForRecords((records) => records.some((record) =>
    record.type === "native_session_name" && record.pid === process.pid
      && record.sessionId === binding.sessionId && record.storedName === name),
  "the native public SessionManager reports the exact fixture-owned replacement name", beforeSave.observerOffset);
  assert.ok(nameRecords.some((record) => record.type === "native_session_name" && record.pid === process.pid
    && record.sessionId === binding.sessionId && record.storedName === name));
  await driver.waitFrame((text) => rosterCards(text, SIDEBAR_COLUMNS)
    .some((card) => renderedTitleMatches(card.title, name)),
  "the real Main roster renders the saved conversation's exact native name", beforeSave.frameRevision);
}

async function activateNativeRow(driver: SavedMainDriver, caption: string): Promise<void> {
  await ensureSidebarFocus(driver);
  await moveRosterTo(driver,
    (entry) => entry.kind === "native" && renderedTitleMatches(entry.title, caption),
    `restored native row ${caption}`);
  const before = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((text) => frameHeader(text) === caption && isMainFocusFrame(text),
    `one genuine Enter gives Main input to the already restored ${caption} row`, before.frameRevision);
}

async function submitPromptAndWait(
  driver: SavedMainDriver,
  process: ProcessIncarnation,
  binding: Awaited<ReturnType<SavedMainDriver["awaitSessionStart"]>>,
  prompt: string,
  expectedResponse: string,
): Promise<void> {
  const beforeTyping = driver.snapshot();
  await driver.writeAndWait(prompt, (text) => text.includes(prompt),
    "the synthetic test prompt is entered through the actual native Pi editor");
  const beforeSubmit = driver.snapshot();
  driver.pty.write(KEYS.enter);
  await driver.waitForRecords((records) => records.some((record) =>
    record.type === "agent_start" && record.pid === process.pid && record.cwd === process.cwd
      && record.sessionId === binding.sessionId),
  "the public native agent_start belongs to the exact process/conversation epoch", beforeSubmit.observerOffset);
  await driver.waitForRecords((records) => records.some((record) =>
    record.type === "agent_settled" && record.pid === process.pid && record.cwd === process.cwd
      && record.sessionId === binding.sessionId),
  "the exact public foreground turn settles before the held worker is released", beforeSubmit.observerOffset);
  await driver.waitFrame((text) => text.includes(expectedResponse),
    "the real offline scripted faux-provider response is rendered by Pi", beforeTyping.frameRevision);
}

async function waitForSameOwnerTurns(
  driver: SavedMainDriver,
  process: ProcessIncarnation,
  binding: Awaited<ReturnType<SavedMainDriver["awaitSessionStart"]>>,
  afterOffset: number,
  expectedTurns: number,
  description: string,
): Promise<void> {
  const records = await driver.waitForRecords((fresh) => {
    const owner = fresh.filter((record) => record.pid === process.pid && record.sessionId === binding.sessionId);
    return owner.filter((record) => record.type === "agent_start").length >= expectedTurns
      && owner.filter((record) => record.type === "agent_settled").length >= expectedTurns;
  }, description, afterOffset);
  const owner = records.slice(afterOffset).filter((record) => record.pid === process.pid && record.sessionId === binding.sessionId);
  const starts = owner.flatMap((record, index) => record.type === "agent_start" ? [index] : []);
  const settled = owner.flatMap((record, index) => record.type === "agent_settled" ? [index] : []);
  assert.equal(starts.length, expectedTurns, `${description}: exact same-owner start count`);
  assert.equal(settled.length, expectedTurns, `${description}: exact same-owner settled count`);
  assert.ok(starts.every((index, turn) => index < settled[turn]!), `${description}: every same-owner turn settles in order`);
}

async function finishHostNormally(
  driver: SavedMainDriver,
  process: ProcessIncarnation,
  binding: Awaited<ReturnType<SavedMainDriver["awaitSessionStart"]>>,
): Promise<void> {
  assert.equal(process.exitWatcher.observedExit, false, "the exact current child remains live until host Quit");
  assert.equal(processIsAlive(process.pid), true, "the exact resumed native child PID is live before graceful shutdown");
  await moveRosterToAction(driver, "Quit host");
  const beforeQuit = driver.snapshot();
  driver.pty.write("q");
  await driver.waitFrame((text) => isQuitConfirmationFrame(text, 1),
    "the actual Quit host shortcut opens its one-live-child confirmation", beforeQuit.frameRevision);
  const beforeConfirm = driver.snapshot();
  driver.pty.write(KEYS.enter);
  const shutdownRecords = await driver.waitForRecords((records) => records.some((record) =>
    record.type === "session_shutdown" && record.pid === process.pid
      && record.sessionId === binding.sessionId && record.contextSessionId === binding.sessionId
      && record.reason === "quit"),
  "graceful host Quit produces the exact native session_shutdown", beforeConfirm.observerOffset);
  assert.ok(shutdownRecords.some((record) => record.type === "session_shutdown" && record.pid === process.pid
    && record.sessionId === binding.sessionId && record.reason === "quit"));
  await driver.waitForKernelExit(process);
  await driver.assertPtyExit(process);
  await driver.waitForNormalOuterExit();
  assert.equal(driver.exitEvent?.exitCode, 0);
  assert.equal(driver.exitEvent?.signal ?? 0, 0);
  assert.equal(ptyJournalHasForceAttempt(driver.ptyRecords()), false,
    "this native Main incarnation shut down through ordinary lifecycle without exact-child force fallback");
}

test("real native Main restores a saved conversation with known-zero current activity beside held historical stopped records, then reauthenticates activity after their repair", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  rejectExecutorRoleBeforeWork();
  const runtime = resolveSavedRuntimePin(t);
  if (!runtime) return;
  requirePublicRuntimeDependencies(runtime);
  assert.equal(runtime.version, "1.4.0");
  assert.equal(Buffer.byteLength(join("/tmp", "shm-XXXXXX", "tmp", "prg-st-XXXXXX", "s.sock"), "utf8") <= 103, true,
    "the harness's short /tmp-owned broker socket path remains within the macOS limit");

  const scratch = createSavedMainScratchRoot();
  const workspace = canonicalWorkspace(createSavedMainWorkspace(scratch, `resume-workspace-${randomUUID().slice(0, 8)}`));
  initSyntheticGitWorkspace(workspace);
  const nativeAgentRoot = createSavedMainAgentRoot(scratch);
  const editorFixture = createSavedMainEditor(scratch, workspace);
  const candidate = createSavedMainCandidate(scratch);
  const fixtureState = join(scratch, "resume-task-fixture-state");
  const recoveryState = join(scratch, "resume-task-recovery-state");
  mkdirSync(fixtureState, { mode: 0o700 });
  mkdirSync(recoveryState, { mode: 0o700 });
  const providerJournal = join(fixtureState, "provider-journal.jsonl");
  const turnScript = join(fixtureState, "turn-script.json");
  const evidenceFile = join(fixtureState, "activity-evidence.jsonl");
  const workerStarted = join(fixtureState, "worker-started.json");
  const workerRelease = join(fixtureState, "worker-release.json");
  const workerCompleted = join(fixtureState, "worker-completed.json");
  const stoppedRecoverableWorkerStarted = join(fixtureState, "stopped-recoverable-started.json");
  const stoppedRecoverableWorkerRelease = join(fixtureState, "stopped-recoverable-release.json");
  const executorFailure = join(fixtureState, "executor-failure.json");
  const workerModePlan = join(fixtureState, "worker-mode.json");
  const recoveryWorkerModePlan = join(recoveryState, "worker-mode.json");
  const recoveryProviderJournal = join(recoveryState, "provider-journal.jsonl");
  const recoveryTurnScript = join(recoveryState, "turn-script.json");
  const recoveryEvidenceFile = join(recoveryState, "activity-evidence.jsonl");
  const recoveryWorkerStarted = join(recoveryState, "worker-started.json");
  const recoveryWorkerRelease = join(recoveryState, "worker-release.json");
  const recoveryWorkerCompleted = join(recoveryState, "worker-completed.json");
  writeFileSync(providerJournal, "", { flag: "wx", mode: 0o600 });
  writeFileSync(evidenceFile, "", { flag: "wx", mode: 0o600 });
  writeFileSync(turnScript, `${JSON.stringify({ steps: [{ text: SEED_RESPONSE }] })}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(recoveryProviderJournal, "", { flag: "wx", mode: 0o600 });
  writeFileSync(recoveryEvidenceFile, "", { flag: "wx", mode: 0o600 });
  writeFileSync(workerModePlan, '{"mode":"hold"}\n', { flag: "wx", mode: 0o600 });
  writeFileSync(recoveryWorkerModePlan, '{"mode":"hold"}\n', { flag: "wx", mode: 0o600 });

  const makeReviewConfig = (stateDir: string, outputName = "resume-task-proof.txt") => ({
    enabled: true,
    review: {
      activeReviewers: [],
      primaryReviewers: [],
      subtaskReviewers: [],
      primaryEnabled: false,
      subtaskEnabled: false,
    },
    externalAgents: {
      "resume-task-worker": {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [RESUME_TASK_WORKER],
          timeoutMs: FIXTURE_TIMEOUT_MS,
          env: {
            PRG_FIXTURE_STATE_DIR: stateDir,
            PRG_FIXTURE_OWNED_ROOT: scratch,
            PRG_FIXTURE_OUTPUT_NAME: outputName,
            PRG_FIXTURE_WORKER_MODE: "fixture-plan",
          },
        },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: {
        "resume-task-resource": {
          selection: { source: "external", id: "resume-task-worker" },
          maxConcurrent: 1,
        },
      },
      routes: { execute: [{ resourceId: "resume-task-resource" }], research: [] },
    },
  });
  const reviewConfigFile = join(nativeAgentRoot, "review-gate.json");
  const writeReviewConfig = (stateDir: string, outputName?: string): void => {
    writeFileSync(reviewConfigFile, `${JSON.stringify(makeReviewConfig(stateDir, outputName), undefined, 2)}\n`, { mode: 0o600 });
  };
  writeReviewConfig(fixtureState);

  const args = [
    "--offline",
    "--no-context-files",
    "--no-themes",
    "--exclude-tools", EXCLUDED_BUILTIN_TOOLS.join(","),
    "--extension", OBSERVER_FIXTURE,
    "--extension", PROVIDER_FIXTURE,
  ];
  assertNoForbiddenSessionArgs(args);
  const makeChildEnvironment = (observerFile: string, stateDir = fixtureState): NodeJS.ProcessEnv => {
    const env = createSavedMainChildEnvironment(
      scratch, runtime, editorFixture.editor, observerFile, editorFixture.log, nativeAgentRoot,
    );
    for (const path of [
      join(scratch, "home", ".cache"),
      join(scratch, "home", ".local", "share"),
      join(scratch, "home", ".local", "state"),
    ]) mkdirSync(path, { recursive: true, mode: 0o700 });
    env.XDG_CACHE_HOME = join(scratch, "home", ".cache");
    env.XDG_DATA_HOME = join(scratch, "home", ".local", "share");
    env.XDG_STATE_HOME = join(scratch, "home", ".local", "state");
    env.PRG_FIXTURE_AGENT_DIR = runtime.agentDir;
    env.PRG_FIXTURE_STATE_DIR = stateDir;
    env.PRG_FIXTURE_METADATA_ONLY = "1";
    assert.equal(env.PI_CODING_AGENT_DIR, nativeAgentRoot);
    assert.equal(env.NODE_OPTIONS, originalNodeOptions());
    return env;
  };

  const drivers = new Set<SavedMainDriver>();
  let assertionsCompleted = false;
  // Every test-owned release record is published complete-before-visible with the
  // same durable exclusive writer production records use: the full bytes are staged
  // and fsynced in an owned private temp file in the fixture state directory, then
  // hard-linked onto the final name. A reader can therefore never observe an empty
  // or half-written release file, and an existing release stays somebody else's
  // claim. The staged name carries the final name plus a `.tmp.<id>` suffix, which
  // the worker's basename-filtered release watcher never treats as a release.
  const releaseFixtureWorker = async (started: string, release: string): Promise<void> => {
    if (!existsSync(started) || existsSync(release)) return;
    try { await atomicWriteExclusive(release, '{"release":true}\n'); } catch { /* preserve uncertain fixture state */ }
  };
  const releaseWorkerForFailureCleanup = async (): Promise<void> => {
    await releaseFixtureWorker(workerStarted, workerRelease);
    await releaseFixtureWorker(stoppedRecoverableWorkerStarted, stoppedRecoverableWorkerRelease);
    await releaseFixtureWorker(recoveryWorkerStarted, recoveryWorkerRelease);
  };
  t.after(async () => {
    await releaseWorkerForFailureCleanup();
    for (const driver of drivers) {
      let safeToDispose = driver.exitEvent !== undefined
        && driver.ledger.all().every((entry) => entry.exitWatcher.observedExit);
      if (!safeToDispose && !driver.exitEvent) {
        try {
          await driver.terminateExactOuterForFailure();
        } catch (error) {
          process.stderr.write(`native resume failure cleanup remains blocked: ${error instanceof Error ? error.message : "bounded owner cleanup failed"}\n`);
        }
        safeToDispose = driver.exitEvent !== undefined
          && driver.ledger.all().every((entry) => entry.exitWatcher.observedExit);
      }
      if (!safeToDispose) {
        process.stderr.write(`retained native resume host and exact process watchers; scratch=${scratch}\n`);
        continue;
      }
      try {
        await driver.stopExitedWatchers();
        driver.dispose();
      } catch {
        process.stderr.write(`retained native resume scratch because an exited-PID watcher did not close cleanly: ${scratch}\n`);
      }
    }
    if (!assertionsCompleted) {
      process.stderr.write(`preserved native automatic-resume runtime tree ${scratch}; assertionsCompleted=false\n`);
    }
  });

  const observerBefore = join(scratch, "observer", "resume-before.jsonl");
  const beforeDriver = await SavedMainDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    runLabel: "resume-before",
    candidate,
    runtime,
    observerFile: observerBefore,
    args,
    env: makeChildEnvironment(observerBefore),
  });
  drivers.add(beforeDriver);
  assert.equal(beforeDriver.surface.frame().cols, OUTER_COLS);
  assert.equal(beforeDriver.surface.frame().rows, OUTER_ROWS);
  await beforeDriver.waitFrame(isWelcomeFrame,
    "the first real native Main starts with an empty global roster and complete Welcome witness");
  const seedChild = await submitWorkspaceOnlyNew(beforeDriver, scratch, workspace);
  const sessionName = `Resume-${randomUUID().slice(0, 8)}`;
  await renameNativeRow(beforeDriver, seedChild.process, seedChild.binding, sessionName);
  await activateNativeRow(beforeDriver, sessionName);
  const firstProvider = await waitForJsonl<ProviderRecord>(providerJournal,
    (records) => records.some((record) => record.event === "auto_model_selected"),
    EVENT_TIMEOUT_MS,
    "the real native child selects the offline faux provider through Pi's public model API");
  assert.ok(firstProvider.some((record) => record.event === "auto_model_selected"));

  await submitPromptAndWait(beforeDriver, seedChild.process, seedChild.binding, SEED_PROMPT, SEED_RESPONSE);
  assert.ok(existsSync(seedChild.binding.sessionFile), "the actual native user turn persisted the saved conversation");
  assert.equal(sessionFileHasStoredName(seedChild.binding.sessionFile, sessionName), true,
    "the actual native saved file retains the controlled fixture name");
  const rosterPath = rosterStorePath(nativeAgentRoot);
  const savedRoster = await waitForPersistedSavedRoster(rosterPath, {
    sessionId: seedChild.binding.sessionId,
    workspace,
    name: sessionName,
  });
  assert.ok(savedRoster.entries?.some((entry) => entry.sessionId === seedChild.binding.sessionId
    && entry.workspace === workspace && entry.name === sessionName && entry.persistence === "saved"));
  await finishHostNormally(beforeDriver, seedChild.process, seedChild.binding);
  assert.equal(seedChild.process.exitWatcher.observedExit, true,
    "the prior exact child incarnation is kernel-confirmed exited before the second host run");
  assert.equal(beforeDriver.ledger.byReceipt(seedChild.process.receipt.receipt), seedChild.process,
    "the prior run's local spawn receipt remains bound to its exact exited process incarnation");
  await beforeDriver.stopExitedWatchers();
  beforeDriver.dispose();
  drivers.delete(beforeDriver);
  const resumedProviderOffset = readOwnedJsonl<ProviderRecord>(providerJournal).length;

  // Change only the controlled faux-provider script after the first Main and
  // its child have exited. The next fresh Main has no key or saved-pane input;
  // its one exact child is created by its own automatic roster-restore path.
  const taskDefinition = {
    title: "controlled native resume worker",
    instructions: "Run the configured deterministic worker and complete its fixture-owned proof after the test releases it.",
    acceptanceCriteria: ["The owned worker completes through the real SubtasksStart controller lifecycle."],
  };
  const stoppedRecoverableTaskDefinition = {
    title: "controlled native stopped-recoverable executor failure",
    instructions: "Run the fixture-controlled execute worker; its held executor failure must be recorded by the real controller as a stopped paused_recoverable task.",
    acceptanceCriteria: ["The real controller retains this exact task, recovery bundle, and released operation ownership."],
  };
  // Request indexes include authenticated completion-wake turns, not only user
  // prompts: 0-1 dispatch/respond, 2 acknowledges the released worker, 3-4
  // dispatch/respond the stopped-recoverable seed, and 5 acknowledges its executor failure.
  writeFileSync(turnScript, `${JSON.stringify({ steps: [
    {
      toolCalls: [{ toolName: "SubtasksStart", arguments: { kind: "execute", tasks: [taskDefinition] } }],
      captureHistoryMarkers: { user: SEED_PROMPT, assistant: SEED_RESPONSE },
    },
    { text: TASK_RESPONSE },
    { text: TASK_COMPLETION_WAKE_RESPONSE },
    { toolCalls: [{ toolName: "SubtasksStart", arguments: { kind: "execute", tasks: [stoppedRecoverableTaskDefinition] } }] },
    { text: RECOVERY_REQUIRED_RESPONSE },
    { text: RECOVERABLE_FAILURE_WAKE_RESPONSE },
  ] })}\n`, { mode: 0o600 });

  const observerAfter = join(scratch, "observer", "resume-after.jsonl");
  const afterDriver = await SavedMainDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    runLabel: "resume-after",
    candidate,
    runtime,
    observerFile: observerAfter,
    args,
    env: makeChildEnvironment(observerAfter),
  });
  drivers.add(afterDriver);
  // A genuine automatic child may append its public startup record before
  // start() returns; retain offset zero so that fast startup is still observed.
  const automaticSnapshot = { ...afterDriver.snapshot(), observerOffset: 0, ptyOffset: 0 };
  const resumedProcess = await afterDriver.awaitSpawn(automaticSnapshot, workspace);
  const resumedBinding = await afterDriver.awaitSessionStart(resumedProcess, automaticSnapshot,
    (record) => record.sessionId === seedChild.binding.sessionId
      && record.sessionFile === seedChild.binding.sessionFile && record.cwd === workspace);
  // Spawn receipt ordinals are local to each runner, so identify the resumed
  // incarnation by its distinct driver namespace and that driver's exact ledger
  // binding, not by comparing numeric receipts across host runs.
  assert.notEqual(afterDriver.stateRoot, beforeDriver.stateRoot,
    "the automatic restore belongs to a distinct Main runner artifact namespace");
  assert.notEqual(afterDriver.ptyJournalFile, beforeDriver.ptyJournalFile,
    "the resumed spawn receipt is scoped to the second host's independent public PTY journal");
  assert.equal(afterDriver.ledger.byReceipt(resumedProcess.receipt.receipt), resumedProcess,
    "the second host's local spawn receipt is bound to the exact resumed process incarnation");
  assert.equal(resumedProcess.exitWatcher.pid, resumedProcess.pid,
    "the resumed incarnation retains its exact PID-bound ownership watcher");
  assert.equal(resumedProcess.exitWatcher.observedExit, false,
    "the resumed exact child remains live after automatic startup restoration");
  assert.equal(processIsAlive(resumedProcess.pid), true,
    "the operating system confirms the exact resumed child PID is live");
  assert.equal(resumedBinding.sessionId, seedChild.binding.sessionId);
  assert.equal(resumedBinding.sessionFile, seedChild.binding.sessionFile);
  assert.equal(resumedBinding.cwd, seedChild.binding.cwd);
  assert.equal(resumedBinding.displayName, sessionName);
  assert.equal(afterDriver.ledger.all().length, 1,
    "startup restore spawned exactly one independently owned child for the one remembered slot");
  const resumedCaption = resumedBinding.displayName;
  await afterDriver.waitFrame((text) => {
    const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
    const counts = activityCounts(text, resumedCaption);
    return parsed.complete && parsed.count === 1 && counts !== undefined
      && /^agent (?:idle|unknown) \|/u.test(counts.status)
      && frameHeader(text) === resumedCaption;
  }, "automatic Main startup restores the exact saved row and exposes its idle or unknown aggregate activity observation before the first task");
  const beforeCounts = activityCounts(afterDriver.currentText(), resumedCaption);
  assert.ok(beforeCounts,
    "the restored native row exposes an explicit numeric or unknown activity observation");
  recordActivityEvidence(evidenceFile, "before-first-task", beforeCounts!, {
    restoredConversationIdentityMatched: true,
    foregroundIdle: true,
  });
  assert.equal(beforeCounts!.tasks, 0,
    "the restored activity source is a known zero before the resumed conversation's first background task");
  assert.equal(afterDriver.ptyRecords().filter((record) => record.type === "pty_spawn").length, 1,
    "no manual saved-session action or second child spawn preceded the first task");
  const resumedStart = afterDriver.records().find((record) => record.type === "session_start"
    && record.pid === resumedProcess.pid && record.sessionId === resumedBinding.sessionId);
  assert.ok(resumedStart?.activeTools?.includes("SubtasksStart"),
    "the resumed native child reports the actual registered SubtasksStart tool in its public active-tool inventory");
  appendFileSync(evidenceFile, `${JSON.stringify({
    stage: "automatic-resume-binding",
    automaticStartupSpawn: true,
    startupInputSent: false,
    savedPickerOpened: false,
    exactPersistedIdentityAvailable: Boolean(seedChild.binding.sessionId && seedChild.binding.sessionFile && seedChild.binding.cwd),
    sameSessionId: seedChild.binding.sessionId === resumedBinding.sessionId,
    sameSessionFile: seedChild.binding.sessionFile === resumedBinding.sessionFile,
    sameWorkspace: seedChild.binding.cwd === resumedBinding.cwd,
    priorProcessConfirmedExited: seedChild.process.exitWatcher.observedExit,
    distinctRunnerNamespace: beforeDriver.stateRoot !== afterDriver.stateRoot,
    resumedLocalReceipt: resumedProcess.receipt.receipt,
    resumedReceiptBoundToExactChild: afterDriver.ledger.byReceipt(resumedProcess.receipt.receipt) === resumedProcess,
    resumedWatcherBoundToPid: resumedProcess.exitWatcher.pid === resumedProcess.pid,
    resumedWatcherStillLive: !resumedProcess.exitWatcher.observedExit,
    newProcessIncarnation: seedChild.process.exitWatcher.observedExit
      && beforeDriver.stateRoot !== afterDriver.stateRoot
      && afterDriver.ledger.byReceipt(resumedProcess.receipt.receipt) === resumedProcess
      && resumedProcess.exitWatcher.pid === resumedProcess.pid
      && !resumedProcess.exitWatcher.observedExit,
    restoredActivityKnownZero: beforeCounts!.tasks === 0,
    subtasksStartRegistered: true,
  })}\n`, { encoding: "utf8", mode: 0o600 });

  // No post-resume model turn has run yet. Focus the automatically restored
  // row through ordinary host input, then dispatch the first turn and observe
  // the real registered tool_call before the deterministic worker can release.
  await activateNativeRow(afterDriver, resumedCaption);
  assert.equal(activityCounts(afterDriver.currentText(), resumedCaption)?.tasks, 0,
    "ordinary row activation does not alter the known background-task count");
  await submitPromptAndWait(afterDriver, resumedProcess, resumedBinding, TASK_PROMPT, TASK_RESPONSE);
  const ownerRecords = afterDriver.records().filter((record) => record.pid === resumedProcess.pid
    && record.sessionId === resumedBinding.sessionId);
  const startIndex = ownerRecords.findIndex((record) => record.type === "agent_start");
  const toolCalls = ownerRecords.filter((record) => record.type === "tool_call");
  const toolIndex = ownerRecords.findIndex((record) => record.type === "tool_call");
  const settledIndex = ownerRecords.findIndex((record) => record.type === "agent_settled");
  assert.deepEqual(toolCalls.map((record) => record.toolName), ["SubtasksStart"],
    "the first post-resume model turn called exactly the actual registered SubtasksStart tool in this owner epoch");
  assert.ok(startIndex >= 0 && startIndex < toolIndex && toolIndex < settledIndex,
    "same-owner public lifecycle order is agent_start → SubtasksStart tool_call → agent_settled");
  const taskProviderRecords = await waitForJsonl<ProviderRecord>(providerJournal,
    (records) => records.some((record) => record.event === "model_request"
      && record.requestIndex === 0 && record.historyMarkers !== undefined),
    EVENT_TIMEOUT_MS,
    "the resumed provider request captures only boolean witnesses for the restored saved-conversation history");
  const resumedRequest = taskProviderRecords.filter((record) => record.event === "model_request"
    && record.requestIndex === 0 && record.historyMarkers !== undefined).at(-1);
  assert.equal(resumedRequest?.historyMarkers?.user, true,
    "the first post-resume model context contains the actual saved user turn");
  assert.equal(resumedRequest?.historyMarkers?.assistant, true,
    "the first post-resume model context contains the actual saved assistant response");
  assert.equal(Object.hasOwn(resumedRequest ?? {}, "lastUserPreview"), false,
    "the expected provider evidence artifact contains no prompt preview");
  assert.equal(Object.hasOwn(resumedRequest ?? {}, "lastUserMessage"), false,
    "the expected provider evidence artifact contains no full prompt");
  assert.equal(ownerRecords.filter((record) => record.type === "agent_start").length, 1,
    "the sole resumed agent turn is the one that dispatched the first task");
  assert.equal(ownerRecords.filter((record) => record.type === "agent_settled").length, 1,
    "the resumed foreground agent settles while the independently owned worker remains held");

  const startedRecord = await waitForFixtureJson(workerStarted,
    "the held owned worker remains live through its test-controlled readiness record");
  assert.equal(startedRecord.ready, true);
  await afterDriver.waitFrame((text) => {
    const counts = activityCounts(text, resumedCaption);
    return counts !== undefined && (counts.tasks === 1 || counts.tasks === null)
      && /^agent (?:running|unknown) \|/u.test(counts.status);
  }, "the actual resumed owner exposes a live-task or explicit unknown observation after foreground settlement");
  const liveCounts = activityCounts(afterDriver.currentText(), resumedCaption);
  assert.ok(liveCounts,
    "the held owned worker's native sidebar observation is explicitly numeric or unknown");
  recordActivityEvidence(evidenceFile, "owned-worker-live-foreground-idle", liveCounts!, {
    workerReady: true,
    subtasksStartObservedInSameOwnerEpoch: toolCalls.length === 1,
    sameOwnerLifecycleOrderVerified: startIndex < toolIndex && toolIndex < settledIndex,
    restoredTranscriptObserved: true,
    foregroundIdle: true,
  });
  assert.equal(liveCounts!.tasks, 1,
    "the actual held worker is one live intent while the resumed foreground agent is idle");

  const completionWakeSnapshot = afterDriver.snapshot();
  await atomicWriteExclusive(workerRelease, '{"release":true}\n');
  const completedRecord = await waitForFixtureJson(workerCompleted,
    "the same deterministic worker receives ordinary release and completes its run-as-binary response");
  assert.equal(completedRecord.completed, true);
  await waitForSameOwnerTurns(afterDriver, resumedProcess, resumedBinding, completionWakeSnapshot.observerOffset, 1,
    "the released task produces one authenticated same-owner completion-wake turn before another prompt is typed");
  const completionWakeProvider = await waitForJsonl<ProviderRecord>(providerJournal,
    (records) => records.some((record) => record.event === "model_request" && record.requestIndex === 2),
    EVENT_TIMEOUT_MS,
    "the completion wake consumes its explicit provider request-index 2 acknowledgement");
  assert.equal(completionWakeProvider.find((record) => record.event === "model_request" && record.requestIndex === 2)?.stepsAvailable, 6,
    "the completion wake sees the complete six-step script rather than stealing the stopped-recoverable prompt's response");
  const completionWakeEvents = afterDriver.records().slice(completionWakeSnapshot.observerOffset)
    .filter((record) => record.pid === resumedProcess.pid && record.sessionId === resumedBinding.sessionId);
  assert.equal(completionWakeEvents.filter((record) => record.type === "tool_call").length, 0,
    "the scripted completion wake acknowledgement performs no extra task dispatch");
  assert.equal(afterDriver.records().filter((record) => record.pid === resumedProcess.pid
    && record.sessionId === resumedBinding.sessionId && record.type === "agent_start").length, 2,
  "the first foreground task turn and its separate completion wake are both observed before the stopped-recoverable prompt");
  const landedProof = join(workspace, "resume-task-proof.txt");
  await waitForOwnedFile(landedProof,
    "the actual SubtasksStart controller lifecycle lands the released worker's proof into the authorized synthetic workspace");
  const proofStats = lstatSync(landedProof);
  assert.ok(proofStats.isFile() && !proofStats.isSymbolicLink() && proofStats.size <= 256,
    "the landed fixture proof is a bounded regular file in the synthetic workspace");
  assert.equal(readFileSync(landedProof, "utf8"), "controlled native resume task completed\n");
  await afterDriver.waitFrame((text) => {
    const counts = activityCounts(text, resumedCaption);
    return counts !== undefined && (counts.tasks === 0 || counts.tasks === null)
      && /^agent (?:idle|unknown) \|/u.test(counts.status);
  }, "the controller settles the released worker and the exact resumed row exposes its settled or unknown activity observation");
  const afterCounts = activityCounts(afterDriver.currentText(), resumedCaption);
  assert.ok(afterCounts,
    "after worker completion, the native row exposes an explicit numeric or unknown activity observation");
  recordActivityEvidence(evidenceFile, "owned-worker-settled", afterCounts!, {
    workerCompleted: true,
    landedFixtureChange: true,
    foregroundIdle: true,
    cleanupOwnershipNotUsedAsActivityEvidence: true,
  });
  assert.equal(afterCounts!.tasks, 0,
    "after normal worker completion, the actual activeTasks source is known zero rather than inferred from ownership cleanup");
  assert.equal(existsSync(landedProof), true,
    "the ordinary execute lifecycle landed the deterministic worker's fixture-only change into the synthetic target");

  // Seed one authentic stopped recovery-required execute record with a released
  // operation lease. The controlled worker exits nonzero through the real
  // execute adapter; the controller, not the fixture, persists paused_recoverable.
  // Hold its failure until the foreground prompt settles so the completion wake
  // cannot race the stopped-recoverable prompt's provider requests.
  writeFileSync(workerModePlan, '{"mode":"executor-failure-held"}\n', { mode: 0o600 });
  const stoppedRecoverablePromptSnapshot = afterDriver.snapshot();
  await submitPromptAndWait(afterDriver, resumedProcess, resumedBinding, RECOVERY_REQUIRED_PROMPT, RECOVERY_REQUIRED_RESPONSE);
  assert.equal((await waitForFixtureJson(stoppedRecoverableWorkerStarted,
    "the fixture-plan-controlled executor starts and waits for its test-owned release")).started, true);
  assert.equal(existsSync(executorFailure), false,
    "the held executor failure cannot wake the owner before its foreground prompt settles");
  await atomicWriteExclusive(stoppedRecoverableWorkerRelease, '{"release":true}\n');
  assert.equal((await waitForFixtureJson(executorFailure,
    "the released fixture executor exits nonzero through the real execute adapter")).executorFailure, true);
  await waitForSameOwnerTurns(afterDriver, resumedProcess, resumedBinding, stoppedRecoverablePromptSnapshot.observerOffset, 2,
    "the stopped-recoverable prompt and its separately authenticated failure-wake turn settle before restore checks");
  const recoverableFailureWakeProvider = await waitForJsonl<ProviderRecord>(providerJournal,
    (records) => records.some((record) => record.event === "model_request" && record.requestIndex === 5),
    EVENT_TIMEOUT_MS,
    "the executor-failure wake consumes its explicit provider request-index 5 acknowledgement");
  assert.equal(recoverableFailureWakeProvider.find((record) => record.event === "model_request" && record.requestIndex === 5)?.stepsAvailable, 6,
    "the failure wake is scripted separately from both foreground prompt turns");
  const stoppedRecoverableOwnerRecords = afterDriver.records().filter((record) => record.pid === resumedProcess.pid
    && record.sessionId === resumedBinding.sessionId);
  assert.equal(stoppedRecoverableOwnerRecords.filter((record) => record.type === "agent_start").length, 4,
    "the native conversation observes two intentional prompt turns and two separate completion-wake turns");
  assert.equal(stoppedRecoverableOwnerRecords.filter((record) => record.type === "agent_settled").length, 4,
    "all four same-owner foreground/wake turns settle before association inspection");
  assert.deepEqual(stoppedRecoverableOwnerRecords.filter((record) => record.type === "tool_call").map((record) => record.toolName),
    ["SubtasksStart", "SubtasksStart"], "only the two intentional prompt turns call the actual registered SubtasksStart tool");
  assert.deepEqual(stoppedRecoverableOwnerRecords.filter((record) => ["agent_start", "tool_call", "agent_settled"].includes(record.type))
    .map((record) => record.type), [
    "agent_start", "tool_call", "agent_settled",
    "agent_start", "agent_settled",
    "agent_start", "tool_call", "agent_settled",
    "agent_start", "agent_settled",
  ], "completion wakes are separately ordered after their controlled worker outcomes");
  const scriptedRequests = await waitForJsonl<ProviderRecord>(providerJournal,
    (records) => [0, 1, 2, 3, 4, 5].every((index) => records.slice(resumedProviderOffset)
      .some((record) => record.event === "model_request" && record.requestIndex === index)),
    EVENT_TIMEOUT_MS,
    "both foreground turns and both completion wakes consume their exact scripted provider steps");
  assert.deepEqual(scriptedRequests.slice(resumedProviderOffset).filter((record) => record.event === "model_request")
    .map((record) => record.requestIndex), [0, 1, 2, 3, 4, 5],
  "provider request indexes distinguish prompt turns from the two authenticated wake acknowledgements");

  const savedExecution = await restoreOwnedFixtureExecution(resumedBinding, nativeAgentRoot);
  const associatedRoots = savedExecution.groupRoots ?? [];
  assert.ok(Array.isArray(associatedRoots) && associatedRoots.length > 0,
    "the actual saved conversation sidecar authenticates at least one retained execution association");
  const nonArchivableRoots: string[] = [];
  for (const root of associatedRoots) {
    try {
      const { group } = await readGroup(root);
      if (group.tasks.some((task) => task.state !== "landed" && task.state !== "reported")) nonArchivableRoots.push(root);
    } catch {
      // A settled earlier group may already have been retired by the real controller.
    }
  }
  assert.equal(nonArchivableRoots.length, 1,
    "the saved sidecar resolves one exact retained non-archivable execute group");
  const stoppedRecoverableAssociation = await waitForAuthenticatedStoppedRecoverableTask(nonArchivableRoots[0]!, scratch);
  assert.equal(savedExecution.groupRoots?.filter((root) => root === stoppedRecoverableAssociation.root).length, 1,
    "the authenticated saved sidecar retains the exact stopped execute group root once");
  const savedRecoverableBundles = savedExecution.bundles.filter((bundle) => bundle.taskId === stoppedRecoverableAssociation.taskId);
  assert.equal(savedRecoverableBundles.length, 1, "the authenticated saved sidecar retains one bundle for the exact task");
  assert.deepEqual(savedRecoverableBundles[0], stoppedRecoverableAssociation.bundle,
    "the authenticated sidecar retains the exact task bundle and expected revision");
  await afterDriver.waitFrame((text) => activityCounts(text, resumedCaption)?.tasks === 0,
    "the complete current-source census counts the stopped paused_recoverable task as inactive");
  const stoppedRecoverableCounts = activityCounts(afterDriver.currentText(), resumedCaption);
  assert.ok(stoppedRecoverableCounts);
  assert.equal(stoppedRecoverableCounts!.tasks, 0,
    "the retained recovery-required task is accounted as inactive rather than making activity uncertain");
  recordActivityEvidence(evidenceFile, "stopped-recoverable-execution-association-saved", stoppedRecoverableCounts!, {
    stoppedRecoverableExecutorFailureRecorded: true,
    exactTaskGeneration: stoppedRecoverableAssociation.generation,
    exactRecoveryBundleRetained: true,
    recoveryBundleExpectedRevision: stoppedRecoverableAssociation.bundle.expectedRevision,
    operationOwnershipReleasedOrDead: true,
    activityInventoryAccountsForInactiveRoot: true,
    cleanupOwnershipNotUsedAsActivityEvidence: true,
  });

  await finishHostNormally(afterDriver, resumedProcess, resumedBinding);
  await afterDriver.stopExitedWatchers();
  afterDriver.dispose();
  drivers.delete(afterDriver);
  assert.equal(resumedProcess.exitWatcher.observedExit, true,
    "the exact prior native child is kernel-confirmed exited before test-owned record fault injection");
  const executionAfterShutdown = await restoreOwnedFixtureExecution(resumedBinding, nativeAgentRoot);
  assert.equal(executionAfterShutdown.groupRoots?.filter((root) => root === stoppedRecoverableAssociation.root).length, 1,
    "the authenticated stopped execute-group root survives the real child session shutdown boundary");
  const shutdownRecoverableBundles = executionAfterShutdown.bundles.filter((bundle) => bundle.taskId === stoppedRecoverableAssociation.taskId);
  assert.equal(shutdownRecoverableBundles.length, 1,
    "the exact task retains one recovery bundle after the real child session shutdown boundary");
  assert.deepEqual(shutdownRecoverableBundles[0], stoppedRecoverableAssociation.bundle,
    "the exact recovery bundle and expected revision survive the real child session shutdown boundary");
  const closedStoppedAssociation = await waitForAuthenticatedStoppedRecoverableTask(stoppedRecoverableAssociation.root, scratch);
  assert.equal(closedStoppedAssociation.taskId, stoppedRecoverableAssociation.taskId,
    "the exact paused_recoverable task remains authenticated after shutdown");
  assert.equal(closedStoppedAssociation.generation, stoppedRecoverableAssociation.generation,
    "the same task generation remains authenticated after shutdown");
  assert.deepEqual(closedStoppedAssociation.bundle, stoppedRecoverableAssociation.bundle,
    "the same checkpoint bundle remains authenticated after shutdown");
  const stoppedManifestStats = lstatSync(closedStoppedAssociation.manifestPath);
  const originalStoppedManifest = readFileSync(closedStoppedAssociation.manifestPath);
  assert.ok(stoppedManifestStats.isFile() && !stoppedManifestStats.isSymbolicLink()
    && stoppedManifestStats.size <= 1024 * 1024);
  const stoppedOperationStats = lstatSync(closedStoppedAssociation.operationPath);
  const originalStoppedOperation = readFileSync(closedStoppedAssociation.operationPath);
  assert.ok(stoppedOperationStats.isFile() && !stoppedOperationStats.isSymbolicLink()
    && stoppedOperationStats.size <= 1024 * 1024);
  const heldOperationPath = join(dirname(closedStoppedAssociation.operationPath), `operation.json.fixture-held-${randomUUID()}`);
  renameSync(closedStoppedAssociation.operationPath, heldOperationPath);
  assert.equal(existsSync(closedStoppedAssociation.operationPath), false,
    "the exact authenticated operation record is unreadable, preventing legacy bundle adoption");
  assert.equal(readFileSync(heldOperationPath).equals(originalStoppedOperation), true,
    "fault injection preserves the original operation record byte-for-byte");
  assert.equal(lstatSync(heldOperationPath).ino, stoppedOperationStats.ino,
    "fault injection preserves the exact operation record inode");
  const heldManifestPath = join(stoppedRecoverableAssociation.root, `execution.json.fixture-held-${randomUUID()}`);
  renameSync(closedStoppedAssociation.manifestPath, heldManifestPath);
  assert.equal(existsSync(closedStoppedAssociation.manifestPath), false,
    "the exact test-owned stopped recovery record is unreadable at the next native restore");
  assert.equal(readFileSync(heldManifestPath).equals(originalStoppedManifest), true,
    "fault injection moves the original authenticated record byte-for-byte without rewriting it");
  assert.equal(lstatSync(heldManifestPath).ino, stoppedManifestStats.ino,
    "fault injection preserves the exact owned record inode");

  // A fresh pinned native Main resumes the same saved conversation. Both the
  // stopped group manifest and its exact operation.json are held, preventing the
  // retained sidecar bundle from being legacy-adopted while its root is unreadable.
  // #412 separates the channels: this new runtime admits or resumes no work, so
  // its restored row reports known idle/zero current activity before any input
  // even while both historical records are held. Loaded-Ready publication
  // ordering itself is covered by the #412 restore/recovery regressions.
  // Those former-runtime records are never
  // replayed as current activity, and the held files keep the separate
  // conservative cleanup-ownership channel unknown, so the native stop
  // confirmation still gates a live row.
  writeReviewConfig(recoveryState, "recovery-task-proof.txt");
  writeFileSync(recoveryTurnScript, `${JSON.stringify({ steps: [
    {
      toolCalls: [{ toolName: "SubtasksStart", arguments: { kind: "execute", tasks: [{
        title: "recovered native activity census",
        instructions: "Run the configured held fixture worker and complete its owned proof after release.",
        acceptanceCriteria: ["The real SubtasksStart lifecycle reports one live task and then a settled zero."],
      }] } }],
    },
    { text: RECOVERY_RESPONSE },
    // The recovered task is actual current work, so its completion produces a
    // real authenticated wake turn; give that turn its own explicit step rather
    // than letting the script end with an exhausted-step marker.
    { text: RECOVERY_COMPLETION_WAKE_RESPONSE },
  ] })}\n`, { flag: "wx", mode: 0o600 });
  const observerRecovery = join(scratch, "observer", "resume-recovery.jsonl");
  const recoveryDriver = await SavedMainDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    runLabel: "resume-recovery",
    candidate,
    runtime,
    observerFile: observerRecovery,
    args,
    env: makeChildEnvironment(observerRecovery, recoveryState),
  });
  drivers.add(recoveryDriver);
  const recoveryAutomaticSnapshot = { ...recoveryDriver.snapshot(), observerOffset: 0, ptyOffset: 0 };
  const recoveryProcess = await recoveryDriver.awaitSpawn(recoveryAutomaticSnapshot, workspace);
  const recoveryBinding = await recoveryDriver.awaitSessionStart(recoveryProcess, recoveryAutomaticSnapshot,
    (record) => record.sessionId === seedChild.binding.sessionId
      && record.sessionFile === seedChild.binding.sessionFile && record.cwd === workspace);
  assert.equal(recoveryBinding.displayName, sessionName);
  assert.equal(recoveryDriver.ledger.all().length, 1,
    "the recovery Main owns exactly one automatically resumed native child");
  await recoveryDriver.waitFrame((text) => {
    const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
    const counts = activityCounts(text, sessionName);
    return parsed.complete && parsed.count === 1 && counts?.tasks === 0
      && /^agent idle \|/u.test(counts.status)
      && frameHeader(text) === sessionName;
  }, "the fresh owning runtime's restored row reports known idle/zero current activity before any input while the stopped group and operation records are held unreadable");
  const preInputCounts = activityCounts(recoveryDriver.currentText(), sessionName);
  assert.ok(preInputCounts);
  assert.equal(preInputCounts!.tasks, 0,
    "the held pure-historical records are not current activity: the fresh runtime reports its own known zero before any input instead of an inherited unknown");
  assert.match(preInputCounts!.status, /^agent idle \|/u,
    "the fresh runtime observes actual idle readiness rather than replaying its former runtime's busy or unknown state");
  // Both fault-held historical files are still exactly where the owned fixture
  // moved them, byte- and inode-identical, when the current zero is observed.
  assert.equal(existsSync(closedStoppedAssociation.operationPath), false,
    "the current zero is observed while the exact operation record is still unreadable at its current-source path");
  assert.equal(existsSync(heldOperationPath), true,
    "the held historical operation record remains in the owned fixture location at the pre-input zero");
  assert.equal(readFileSync(heldOperationPath).equals(originalStoppedOperation), true,
    "the held operation record remains byte-exact through the fresh runtime's pre-input zero");
  assert.equal(lstatSync(heldOperationPath).ino, stoppedOperationStats.ino,
    "the held operation record keeps its exact inode through the fresh runtime's pre-input zero");
  assert.equal(existsSync(closedStoppedAssociation.manifestPath), false,
    "the current zero is observed while the exact stopped recovery manifest is still unreadable at its current-source path");
  assert.equal(existsSync(heldManifestPath), true,
    "the held historical stopped manifest remains in the owned fixture location at the pre-input zero");
  assert.equal(readFileSync(heldManifestPath).equals(originalStoppedManifest), true,
    "the held stopped manifest remains byte-exact through the fresh runtime's pre-input zero");
  assert.equal(lstatSync(heldManifestPath).ino, stoppedManifestStats.ino,
    "the held stopped manifest keeps its exact inode through the fresh runtime's pre-input zero");
  const preInputOwnerRecords = recoveryDriver.records().filter((record) => record.pid === recoveryProcess.pid
    && record.sessionId === recoveryBinding.sessionId);
  assert.equal(preInputOwnerRecords.filter((record) => record.type === "agent_start").length, 0,
    "the pre-input zero belongs to a runtime that admitted or resumed no work, not to a completed turn");
  assert.equal(preInputOwnerRecords.filter((record) => record.type === "tool_call").length, 0,
    "no task was dispatched before the current known zero was observed");
  assert.equal(recoveryDriver.ptyRecords().filter((record) => record.type === "pty_spawn").length, 1,
    "no manual saved-session action or second child spawn preceded the current known zero");
  recordActivityEvidence(recoveryEvidenceFile, "held-historical-records-current-zero", preInputCounts!, {
    exactSavedConversationRestored: true,
    exactStoppedRecoverableManifestHeldByOwnedFixture: true,
    exactStoppedOperationHeldByOwnedFixture: true,
    heldFaultRecordsByteAndInodeExactAtPreInputZero: true,
    legacyBundleAdoptionPreventedByOwnedFault: true,
    currentActivityKnownZeroWhileHistoricalRecordsUnreadable: true,
    historicalRecordsAreNotCurrentActivity: true,
    noAdmittedOrResumedWorkBeforeInput: true,
    noNewPromptTaskOrRestartRequired: true,
  });

  // Current activity is a known zero, but the held historical records keep the
  // separate conservative cleanup-ownership channel unknown. A live row must
  // still require the real native stop confirmation, and cancelling it must stop
  // nothing and leave both held records untouched.
  await ensureSidebarFocus(recoveryDriver);
  await moveRosterTo(recoveryDriver,
    (entry) => entry.kind === "native" && renderedTitleMatches(entry.title, sessionName),
    "the exact unreadable-history current-zero session row");
  const beforeHeldStop = recoveryDriver.snapshot();
  recoveryDriver.pty.write("d");
  await recoveryDriver.waitFrame((text) => text.includes("Stop session?") && text.includes("enter/y = stop"),
    "unknown cleanup ownership retains the actual native stop confirmation before repair even though current activity is a known zero",
    beforeHeldStop.frameRevision);
  assert.equal(recoveryProcess.exitWatcher.observedExit, false,
    "the pre-repair conservative stop warning does not stop or replace the exact resumed child");
  assert.equal(processIsAlive(recoveryProcess.pid), true,
    "the exact current child PID stays live through the pre-repair stop warning");
  recoveryDriver.pty.write(KEYS.escape);
  await recoveryDriver.waitFrame((text) => parseRosterFrame(text, SIDEBAR_COLUMNS).complete
    && rosterCards(text, SIDEBAR_COLUMNS).some((card) => renderedTitleMatches(card.title, sessionName)),
  "Escape cancels the pre-repair stop warning without sending input to the child or removing its row");
  assert.equal(ptyJournalHasForceAttempt(recoveryDriver.ptyRecords()), false,
    "the cancelled pre-repair stop warning produced no exact-child force attempt");
  assert.equal(activityCounts(recoveryDriver.currentText(), sessionName)?.tasks, 0,
    "cancelling the conservative stop warning leaves the current known zero unchanged");
  assert.equal(existsSync(heldOperationPath), true,
    "the cancelled stop warning leaves the held historical operation record in place");
  assert.equal(readFileSync(heldOperationPath).equals(originalStoppedOperation), true,
    "the cancelled stop warning leaves the held operation record byte-exact");
  assert.equal(lstatSync(heldOperationPath).ino, stoppedOperationStats.ino,
    "the cancelled stop warning leaves the held operation record inode intact");
  assert.equal(existsSync(closedStoppedAssociation.operationPath), false,
    "the cancelled stop warning does not restore or rewrite the unreadable operation record path");
  assert.equal(existsSync(heldManifestPath), true,
    "the cancelled stop warning leaves the held historical stopped manifest in place");
  assert.equal(readFileSync(heldManifestPath).equals(originalStoppedManifest), true,
    "the cancelled stop warning leaves the held stopped manifest byte-exact");
  assert.equal(lstatSync(heldManifestPath).ino, stoppedManifestStats.ino,
    "the cancelled stop warning leaves the held stopped manifest inode intact");
  assert.equal(existsSync(closedStoppedAssociation.manifestPath), false,
    "the cancelled stop warning does not restore or rewrite the unreadable manifest path");
  assert.equal(processIsAlive(recoveryProcess.pid), true,
    "the exact current child remains live after cancelling the conservative stop warning");
  appendFileSync(recoveryEvidenceFile, `${JSON.stringify({
    stage: "held-historical-records-stop-confirmation",
    stopConfirmationShownBeforeRepair: true,
    currentActivityStillKnownZero: true,
    exactCurrentChildStillLive: true,
    forcedStopAttemptAbsent: true,
    historicalOperationStillHeldByteAndInodeExact: true,
    historicalManifestStillHeldByteAndInodeExact: true,
    rowPreservedAfterCancel: true,
  })}\n`, { encoding: "utf8", mode: 0o600 });

  renameSync(heldOperationPath, closedStoppedAssociation.operationPath);
  assert.equal(lstatSync(closedStoppedAssociation.operationPath).ino, stoppedOperationStats.ino,
    "repair restores the exact original operation record inode");
  assert.equal(readFileSync(closedStoppedAssociation.operationPath).equals(originalStoppedOperation), true,
    "repair restores the exact original operation record bytes");
  renameSync(heldManifestPath, closedStoppedAssociation.manifestPath);
  assert.equal(lstatSync(closedStoppedAssociation.manifestPath).ino, stoppedManifestStats.ino,
    "repair restores the exact original stopped recovery manifest inode");
  assert.equal(readFileSync(closedStoppedAssociation.manifestPath).equals(originalStoppedManifest), true,
    "repair restores the exact original stopped recovery manifest bytes");
  const repairedAssociation = await waitForAuthenticatedStoppedRecoverableTask(stoppedRecoverableAssociation.root, scratch);
  assert.equal(repairedAssociation.taskId, stoppedRecoverableAssociation.taskId,
    "repair authenticates the same paused_recoverable task rather than substituting another record");
  assert.equal(repairedAssociation.generation, stoppedRecoverableAssociation.generation,
    "repair authenticates the same task generation");
  assert.deepEqual(repairedAssociation.bundle, stoppedRecoverableAssociation.bundle,
    "repair authenticates the same checkpoint bundle and expected revision");
  assert.equal(activityCounts(recoveryDriver.currentText(), sessionName)?.tasks, 0,
    "repairing the pure-historical records leaves the current runtime's established zero unchanged");
  await activateNativeRow(recoveryDriver, sessionName);
  assert.equal(activityCounts(recoveryDriver.currentText(), sessionName)?.tasks, 0,
    "ordinary row activation is not treated as a background lifecycle update and does not resurrect historical activity");
  const recoveryStartRecord = recoveryDriver.records().find((record) => record.type === "session_start"
    && record.pid === recoveryProcess.pid && record.sessionId === recoveryBinding.sessionId);
  assert.ok(recoveryStartRecord?.activeTools?.includes("SubtasksStart"),
    "the recovered native child exposes the genuine registered SubtasksStart tool");

  await submitPromptAndWait(recoveryDriver, recoveryProcess, recoveryBinding, RECOVERY_PROMPT, RECOVERY_RESPONSE);
  const recoveryOwnerRecords = recoveryDriver.records().filter((record) => record.pid === recoveryProcess.pid
    && record.sessionId === recoveryBinding.sessionId);
  const recoveryStartIndex = recoveryOwnerRecords.findIndex((record) => record.type === "agent_start");
  const recoveryToolIndex = recoveryOwnerRecords.findIndex((record) => record.type === "tool_call");
  const recoverySettledIndex = recoveryOwnerRecords.findIndex((record) => record.type === "agent_settled");
  const recoveryToolCalls = recoveryOwnerRecords.filter((record) => record.type === "tool_call");
  assert.deepEqual(recoveryToolCalls.map((record) => record.toolName), ["SubtasksStart"],
    "the post-repair native lifecycle update is the real registered SubtasksStart call");
  assert.ok(recoveryStartIndex >= 0 && recoveryStartIndex < recoveryToolIndex
    && recoveryToolIndex < recoverySettledIndex,
  "same-owner recovery lifecycle order is agent_start → SubtasksStart tool_call → agent_settled");
  assert.equal((await waitForFixtureJson(recoveryWorkerStarted,
    "the recovery worker remains held after its real SubtasksStart dispatch")).ready, true);
  await recoveryDriver.waitFrame((text) => {
    const counts = activityCounts(text, sessionName);
    return counts?.tasks === 1 && /^agent (?:running|unknown) \|/u.test(counts.status);
  }, "the authenticated current-source census reports one truthful live task while its native worker is held");
  const recoveryLiveCounts = activityCounts(recoveryDriver.currentText(), sessionName);
  assert.ok(recoveryLiveCounts);
  assert.equal(recoveryLiveCounts!.tasks, 1,
    "the native sidebar counts one admitted task while retaining the authenticated inactive recoverable root");
  recordActivityEvidence(recoveryEvidenceFile, "repaired-record-worker-held", recoveryLiveCounts!, {
    repairedExactStoppedRecoverableAssociation: true,
    inactiveRecoverableRootStillAuthenticated: true,
    realSubtasksStartLifecycleObserved: true,
    workerReadyAndHeld: true,
    cleanupOwnershipNotUsedAsActivityEvidence: true,
  });

  const recoveryReleaseSnapshot = recoveryDriver.snapshot();
  await atomicWriteExclusive(recoveryWorkerRelease, '{"release":true}\n');
  assert.equal((await waitForFixtureJson(recoveryWorkerCompleted,
    "the recovery worker completes through its ordinary release and executor lifecycle")).completed, true);
  // The recovered task is real current work, so its completion delivers one
  // authenticated same-owner wake turn before the landed proof is inspected.
  await waitForSameOwnerTurns(recoveryDriver, recoveryProcess, recoveryBinding, recoveryReleaseSnapshot.observerOffset, 1,
    "the recovered task's actual completion produces one authenticated same-owner wake turn");
  const recoveryWakeProvider = await waitForJsonl<ProviderRecord>(recoveryProviderJournal,
    (records) => records.some((record) => record.event === "model_request" && record.requestIndex === 2),
    EVENT_TIMEOUT_MS,
    "the recovery completion wake consumes its explicit provider request-index 2 acknowledgement");
  assert.equal(recoveryWakeProvider.find((record) => record.event === "model_request" && record.requestIndex === 2)?.stepsAvailable, 3,
    "the recovery completion wake sees its own three-step script instead of an exhausted-step marker");
  const recoveryWakeEvents = recoveryDriver.records().slice(recoveryReleaseSnapshot.observerOffset)
    .filter((record) => record.pid === recoveryProcess.pid && record.sessionId === recoveryBinding.sessionId);
  assert.equal(recoveryWakeEvents.filter((record) => record.type === "tool_call").length, 0,
    "the scripted recovery completion-wake acknowledgement performs no extra task dispatch");
  const recoveryProof = join(workspace, "recovery-task-proof.txt");
  await waitForOwnedFile(recoveryProof,
    "the recovered registered task lands its separate fixture-only proof in the authorized synthetic workspace");
  assert.equal(readFileSync(recoveryProof, "utf8"), "controlled native resume task completed\n");
  await recoveryDriver.waitFrame((text) => {
    const counts = activityCounts(text, sessionName);
    return counts?.tasks === 0 && /^agent idle \|/u.test(counts.status);
  }, "settlement returns activity to zero while the authenticated inactive recoverable root remains in the census");
  const recoverySettledCounts = activityCounts(recoveryDriver.currentText(), sessionName);
  assert.ok(recoverySettledCounts);
  assert.equal(recoverySettledCounts!.tasks, 0,
    "the actual native sidebar returns to known zero after the worker settles");
  recordActivityEvidence(recoveryEvidenceFile, "repaired-record-worker-settled", recoverySettledCounts!, {
    workerCompleted: true,
    landedFixtureChange: true,
    inactiveRecoverableRootStillAuthenticated: true,
    cleanupOwnershipRemainsConservative: true,
    activityIntentKnownZero: true,
  });

  // The public idle activity number must not erase the separate cleanup-owner
  // channel: a live row with unresolved ownership still requires confirmation.
  await ensureSidebarFocus(recoveryDriver);
  await moveRosterTo(recoveryDriver,
    (entry) => entry.kind === "native" && renderedTitleMatches(entry.title, sessionName),
    "the exact settled recovery session row");
  const beforeConservativeStop = recoveryDriver.snapshot();
  recoveryDriver.pty.write("d");
  await recoveryDriver.waitFrame((text) => text.includes("Stop session?") && text.includes("enter/y = stop"),
    "unknown cleanup ownership retains the actual native stop confirmation after activity reaches zero",
    beforeConservativeStop.frameRevision);
  assert.equal(recoveryProcess.exitWatcher.observedExit, false,
    "the conservative stop warning does not stop or replace the exact resumed child");
  recoveryDriver.pty.write(KEYS.escape);
  await recoveryDriver.waitFrame((text) => parseRosterFrame(text, SIDEBAR_COLUMNS).complete
    && rosterCards(text, SIDEBAR_COLUMNS).some((card) => renderedTitleMatches(card.title, sessionName)),
  "Escape cancels the stop warning without sending input to the child or removing its row");

  const recoveryProviderRecords = await waitForJsonl<ProviderRecord>(recoveryProviderJournal,
    (records) => records.some((record) => record.event === "auto_model_selected"),
    EVENT_TIMEOUT_MS,
    "the recovery Main uses the same pinned native offline faux provider");
  assert.ok(recoveryProviderRecords.some((record) => record.event === "auto_model_selected"));
  await finishHostNormally(recoveryDriver, recoveryProcess, recoveryBinding);
  await recoveryDriver.stopExitedWatchers();
  recoveryDriver.dispose();
  drivers.delete(recoveryDriver);

  const allProviderRecords = readOwnedJsonl<ProviderRecord>(providerJournal);
  const historyRequestRecords = allProviderRecords.filter((record) => record.event === "model_request"
    && record.historyMarkers !== undefined);
  assert.equal(historyRequestRecords.length, 1,
    "exactly one resumed task-dispatch request produced saved-history booleans");
  assert.ok(allProviderRecords.filter((record) => record.event === "model_request").every((record) =>
    !Object.hasOwn(record, "lastUserPreview") && !Object.hasOwn(record, "lastUserMessage")),
  "all private provider evidence stays metadata-only for this acceptance run");
  assertionsCompleted = true;
  process.stderr.write(`native automatic-resume and recovery evidence retained: ${scratch}\n`);
});
