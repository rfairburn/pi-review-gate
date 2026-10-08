import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";

import { DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS } from "../../src/session-host/instances";
import { TerminalSurface, stripGeneratedSgr } from "../../src/session-host/terminal-surface";
import {
  NATIVE_PANE_START,
  SIDEBAR_COLUMNS,
  frameHeader,
  isSidebarFocusedFrame,
  parseRosterFrame,
  renderedTitleMatches,
  selectedRosterCard,
  selectedRosterEntry as parseSelectedRosterEntry,
  sidebarRosterHidden,
  type RosterActionEntry,
  type RosterCardEntry,
  type RosterEntry,
} from "./session-host-native-roster-witness";

export { frameHeader, isSidebarFocusedFrame, parseRosterFrame, renderedTitleMatches, selectedRosterCard, sidebarRosterHidden };
export type { RosterActionEntry, RosterCardEntry, RosterEntry };
import {
  ChangeSignal,
  EVENT_TIMEOUT_MS,
  OwnedPidExitWatcher,
  TEST_TIMEOUT_MS,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  makeNativeAgentRoot,
  makeRuntimeEnvironment,
  makeWorkspace,
  nativeFormFieldIsEmpty,
  processIsAlive,
  resolveRuntimePin,
  sessionFileHasStoredName,
  sha256,
  type CandidatePackage,
  type NativePtyHandle,
  type NativePtyModule,
  type PtyExit,
  type RuntimePin,
  type SessionRecord,
} from "./session-host-native-main-harness";

export { TEST_TIMEOUT_MS, EVENT_TIMEOUT_MS, OwnedPidExitWatcher };
export type { CandidatePackage, NativePtyHandle, NativePtyModule, RuntimePin, SessionRecord };

export const OUTER_COLS = 120;
export const OUTER_ROWS = 50;
export const OUTER_RESTORATION_BASELINE = "PRG-SAVED-MAIN";
export const OBSERVER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-observer.cjs");
export const PROVIDER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-provider.cjs");
export const RUNNER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-saved-main-runner.cjs");

export const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  f8: "\x1b[19~",
  delete: "\x1b[3~",
  ctrlC: "\x03",
};

const SHORT_QUIET_WINDOW_MS = 300;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const SIDEBAR_COLS = SIDEBAR_COLUMNS;
const SIDEBAR_START = NATIVE_PANE_START;
const NODE_OPTIONS_ORIGINAL = process.env.NODE_OPTIONS;
const OWNER_SHUTDOWN_MARGIN_MS = 3_000;
const OWNER_SHUTDOWN_WINDOW_MS = DEFAULT_SHUTDOWN_GRACE_MS + DEFAULT_SHUTDOWN_KILL_MS + OWNER_SHUTDOWN_MARGIN_MS;
const FAILURE_EXIT_SETTLE_MS = 1_000;
const FAILURE_FORCE_EXIT_TIMEOUT_MS = EVENT_TIMEOUT_MS;
const OUTER_EXIT_TIMEOUT_MS = 5_000;

interface RunnerResult {
  readonly forceAttempted: boolean;
  readonly journalFailed: boolean;
  readonly status: number;
  readonly threw: boolean;
  readonly before: string;
  readonly after: string;
  readonly rawBefore: unknown;
  readonly rawAfter: unknown;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

export interface SavedRuntimePin extends RuntimePin {}

/**
 * This macOS-only case has its own mandatory gate. Ordinary Linux CI's
 * generic Pi-host gate must not be mistaken for a request for macOS proof.
 * Role/catalog markers are rejected before any allowlist environment exists.
 */
export function resolveSavedRuntimePin(t: { skip(message?: string): void }): SavedRuntimePin | undefined {
  if (Object.hasOwn(process.env, "PI_REVIEW_GATE_RUNTIME_ROLE")
    || Object.hasOwn(process.env, "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG")) {
    throw new Error("real native Saved conversations verification rejects the actual delegated role/catalog markers");
  }
  const mandatory = process.env.PI_REVIEW_GATE_REQUIRE_SAVED_SESSION_HOST === "1";
  const admission = {
    skip(message?: string): void {
      if (mandatory) throw new Error(`required native Saved conversations proof unavailable: ${message ?? "missing prerequisite"}`);
      t.skip(message);
    },
  };
  if (process.platform !== "darwin") {
    admission.skip("the real native Saved conversations proof requires macOS and a POSIX PTY");
    return undefined;
  }
  return resolveRuntimePin(admission);
}

export interface SpawnReceipt {
  readonly type: "pty_spawn";
  readonly receipt: number;
  readonly pid: number;
  readonly cwd: string;
}

export interface PtyJournalRecord {
  readonly type: string;
  readonly receipt?: number;
  readonly pid?: number;
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly signal?: number | string | null;
  readonly requestId?: number;
  readonly source?: string;
  readonly attempted?: boolean;
  readonly failed?: boolean;
  readonly alreadyExited?: boolean;
  readonly attempt?: number;
  readonly listener?: string;
}

export interface ConversationBinding {
  readonly spawnReceipt: number;
  readonly processKey: string;
  readonly pid: number;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly displayName: string;
  readonly storedName?: string;
  readonly observerOffset: number;
  readonly nameHistory: Array<{ readonly storedName: string; readonly displayName: string; readonly observerOffset: number }>;
}

export interface ProcessIncarnation {
  readonly key: string;
  readonly receipt: SpawnReceipt;
  readonly pid: number;
  readonly cwd: string;
  readonly exitWatcher: OwnedPidExitWatcher;
  readonly bindings: ConversationBinding[];
  readonly visibleLabelHistory: Array<{ readonly label: string; readonly source: "session_start" | "native_session_name" }>;
  /** Entry-array position observed when this exact New/Saved row was created. */
  rosterPosition?: number;
}

/**
 * Process identity is the exact public PTY spawn receipt + PID + cwd, never a
 * workspace-keyed label. Conversation bindings are append-only per process;
 * /new advances currentBinding without erasing the previous ID/file/name.
 */
export class ProcessIncarnationLedger {
  private readonly incarnations = new Map<string, ProcessIncarnation>();
  private readonly receiptKeys = new Map<number, string>();

  addSpawn(receipt: SpawnReceipt, exitWatcher: OwnedPidExitWatcher): ProcessIncarnation {
    assert.equal(receipt.type, "pty_spawn", "only a real public PTY spawn receipt creates process ownership");
    assert.ok(Number.isSafeInteger(receipt.receipt) && receipt.receipt > 0, "the runner supplies a fresh receipt ordinal");
    assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0, "the runner supplies the exact public PTY PID");
    assert.ok(isAbsolute(receipt.cwd), "the public PTY spawn receipt supplies an absolute cwd");
    assert.equal(exitWatcher.pid, receipt.pid, "the retained kernel watcher is prebound to the receipt PID");
    assert.equal(this.receiptKeys.has(receipt.receipt), false, "a spawn receipt ordinal is never reused");
    for (const existing of this.forPid(receipt.pid)) {
      assert.equal(existing.exitWatcher.observedExit, true,
        "a PID cannot be adopted as a second process incarnation while its prior exact watcher is live");
    }
    const key = `${receipt.receipt}\u0000${receipt.pid}\u0000${receipt.cwd}`;
    assert.equal(this.incarnations.has(key), false, "the exact process-incarnation tuple is unique");
    const process: ProcessIncarnation = {
      key,
      receipt: Object.freeze({ ...receipt }),
      pid: receipt.pid,
      cwd: receipt.cwd,
      exitWatcher,
      bindings: [],
      visibleLabelHistory: [],
    };
    this.incarnations.set(key, process);
    this.receiptKeys.set(receipt.receipt, key);
    return process;
  }

  byReceipt(receipt: number): ProcessIncarnation | undefined {
    const key = this.receiptKeys.get(receipt);
    return key === undefined ? undefined : this.incarnations.get(key);
  }

  forPid(pid: number): ProcessIncarnation[] {
    return [...this.incarnations.values()].filter((entry) => entry.pid === pid);
  }

  all(): ProcessIncarnation[] {
    return [...this.incarnations.values()];
  }

  bindSessionStart(process: ProcessIncarnation, record: SessionRecord, observerOffset: number): ConversationBinding {
    assert.equal(this.incarnations.get(process.key), process, "a session can bind only to its retained process incarnation");
    assert.equal(process.exitWatcher.pid, process.pid, "the process still has its exact kernel watcher");
    assert.equal(process.exitWatcher.observedExit, false, "an exited process cannot acquire a later conversation binding");
    assert.equal(record.type, "session_start", "only a fresh public observer session_start creates a conversation binding");
    assert.equal(record.pid, process.pid, "the public lifecycle PID exactly matches the spawn receipt");
    assert.equal(record.cwd, process.cwd, "the public lifecycle cwd exactly matches the spawn receipt");
    assert.ok(typeof record.sessionId === "string" && record.sessionId.length > 0,
      "the public SessionManager supplies a fresh nonempty conversation ID");
    assert.ok(typeof record.sessionFile === "string" && isAbsolute(record.sessionFile),
      "the public SessionManager supplies the exact planned/native session file");
    assert.ok(typeof record.displayName === "string", "the public observer supplies its actual display caption");
    const binding: ConversationBinding = {
      spawnReceipt: process.receipt.receipt,
      processKey: process.key,
      pid: process.pid,
      cwd: process.cwd,
      sessionId: record.sessionId!,
      sessionFile: record.sessionFile!,
      displayName: record.displayName!,
      storedName: record.storedName,
      observerOffset,
      nameHistory: [],
    };
    process.bindings.push(binding);
    process.visibleLabelHistory.push({ label: record.displayName!, source: "session_start" });
    if (record.storedName) {
      binding.nameHistory.push({ storedName: record.storedName, displayName: record.displayName!, observerOffset });
    }
    return binding;
  }

  appendNativeName(process: ProcessIncarnation, record: SessionRecord, observerOffset: number): void {
    const binding = process.bindings.find((candidate) => candidate.sessionId === record.sessionId
      && candidate.pid === record.pid && candidate.cwd === record.cwd);
    assert.ok(binding, "a native name can annotate only a previously observed exact conversation binding");
    assert.ok(typeof record.storedName === "string" && record.storedName.length > 0,
      "the name history contains only a real public SessionManager stored name");
    assert.equal(typeof record.displayName, "string", "the name history retains the public display caption");
    binding!.nameHistory.push({
      storedName: record.storedName!,
      displayName: record.displayName!,
      observerOffset,
    });
    process.visibleLabelHistory.push({ label: record.displayName!, source: "native_session_name" });
  }

  setRosterPosition(process: ProcessIncarnation, position: number): void {
    assert.equal(this.incarnations.get(process.key), process, "only an owned process row receives a roster position");
    assert.ok(Number.isSafeInteger(position) && position >= 0, "the roster position is a visible entry-array index");
    if (process.rosterPosition !== undefined) {
      assert.equal(process.rosterPosition, position,
        "one process row keeps its position; a new conversation binding does not overwrite its history");
      return;
    }
    process.rosterPosition = position;
  }
}

export interface JournalSnapshot {
  readonly frameRevision: number;
  readonly observerOffset: number;
  readonly ptyOffset: number;
}

export interface SavedMainStartOptions {
  readonly ptyModule: NativePtyModule;
  readonly scratchRoot: string;
  readonly candidate: CandidatePackage;
  readonly runtime: RuntimePin;
  readonly observerFile: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function frameText(surface: TerminalSurface): string {
  return surface.frame().lines.map(stripGeneratedSgr).join("\n");
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JOURNAL_BYTES) {
    throw new Error("owned Saved Main journal is not a bounded regular file");
  }
  const output: T[] = [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  // Only an unterminated trailing append may be incomplete. A malformed
  // complete record must fail closed, especially when it could hide force.
  if (!raw.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    output.push(JSON.parse(line) as T);
  }
  return output;
}

function workspaceFieldValue(text: string): string | undefined {
  const marker = "> Workspace:";
  const rows = text.split("\n");
  const index = rows.findIndex((line) => line.includes(marker));
  if (index < 0) return undefined;
  const start = rows[index]!.indexOf(marker) + marker.length + 1;
  return rows[index + 1]?.slice(start).trim();
}

/**
 * Actual native/action entries from the rendered sidebar roster only. Each
 * native entry correlates its complete title-only card (3 collapsed or 5
 * expanded rows: title, marker/status, background, optional activity) with the
 * ordered three-action tail; captions elsewhere are never entries.
 */
export function rosterEntries(text: string): RosterEntry[] {
  return [...parseRosterFrame(text, SIDEBAR_COLS).entries];
}

export function selectedRosterEntry(text: string): RosterEntry | undefined {
  return parseSelectedRosterEntry(text, SIDEBAR_COLS);
}

function rightPaneText(text: string): string {
  return text.split("\n").slice(1).map((line) => line.slice(SIDEBAR_START)).join("\n");
}

/** Require evidence from the actual right pane, not the shared left-roster action/footer. */
export function isSavedConversationsPane(text: string): boolean {
  const rows = rightPaneText(text).split("\n").map((line) => line.trim());
  return rows.includes("Saved conversations")
    && rows.some((line) => line.split(" | ").includes("up/down select"));
}

/** Public 32-column Quit renderer assertion shared by native and synthetic coverage. */
export function hasQuitConfirmationContents(lines: readonly string[], liveCount: number): boolean {
  const paneLines = lines.map((line) => stripGeneratedSgr(line).slice(0, SIDEBAR_COLS).trim()).filter(Boolean);
  const normalized = paneLines.join(" ").replace(/\s+/g, " ");
  return paneLines.includes("Quit host?")
    && normalized.includes(`${liveCount} session(s) starting, alive, or host-owned`)
    && paneLines.includes("enter/y = quit host")
    && paneLines.includes("esc/n = cancel");
}

export function isQuitConfirmationFrame(text: string, liveCount: number): boolean {
  return hasQuitConfirmationContents(text.split("\n").map((line) => line.slice(0, SIDEBAR_COLS)), liveCount);
}

export function savedRowsVisible(text: string): string[] {
  return rightPaneText(text).split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^(?:> |  )\S/.test(line))
    .map((line) => line.slice(2).trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("Loading saved conversations")
      && !line.startsWith("No saved conversations") && !line.startsWith("No conversations could be listed"));
}

function canonicalRealpath(path: string): string {
  return realpathSync(path);
}

export class SavedMainDriver {
  readonly pty: NativePtyHandle;
  readonly surface: TerminalSurface;
  readonly frameSignal = new ChangeSignal();
  readonly outputSignal = new ChangeSignal();
  readonly journalSignal = new ChangeSignal();
  readonly ptySignal = new ChangeSignal();
  readonly exitSignal = new ChangeSignal();
  readonly replyLog: string[] = [];
  readonly kittyFlagSnapshots: number[] = [];
  readonly ledger = new ProcessIncarnationLedger();
  readonly stateRoot: string;
  readonly resultFile: string;
  readonly ptyJournalFile: string;
  readonly controlFile: string;
  readonly observerFile: string;
  readonly baseline = OUTER_RESTORATION_BASELINE;
  readonly observerWatcher: FSWatcher;
  readonly ptyWatcher: FSWatcher;
  readonly outerKillAttempts: Array<{ readonly signal: string }> = [];
  exitEvent?: PtyExit;
  parserError?: Error;
  frameRevision = 0;
  outputRevision = 0;
  private currentFrame = "";
  private outputTail = "";
  private sawAltEnter = false;
  private sawAltLeave = false;
  private sawCursorShow = false;
  private sawReset = false;
  private readonly dataSubscription: { dispose(): void };
  private readonly exitSubscription: { dispose(): void };
  private controlRequestId = 0;
  private runnerReleased = false;

  private constructor(options: {
    readonly pty: NativePtyHandle;
    readonly scratchRoot: string;
    readonly observerFile: string;
    readonly resultFile: string;
    readonly ptyJournalFile: string;
    readonly controlFile: string;
    readonly observerWatcher: FSWatcher;
    readonly ptyWatcher: FSWatcher;
  }) {
    this.pty = options.pty;
    this.observerFile = options.observerFile;
    this.resultFile = options.resultFile;
    this.ptyJournalFile = options.ptyJournalFile;
    this.controlFile = options.controlFile;
    this.stateRoot = join(options.scratchRoot, "saved-main-state");
    this.observerWatcher = options.observerWatcher;
    this.ptyWatcher = options.ptyWatcher;
    this.surface = new TerminalSurface(OUTER_COLS, OUTER_ROWS, {
      onReply: (reply) => {
        this.replyLog.push(reply);
        try { this.pty.write(reply); } catch { /* the exact owned outer PTY may already have exited */ }
      },
      onChange: () => this.refreshFrame(),
    });
    this.refreshFrame();
    this.dataSubscription = this.pty.onData((data) => this.onData(data));
    this.exitSubscription = this.pty.onExit((event) => {
      this.exitEvent = event;
      this.exitSignal.notify();
      this.frameSignal.notify();
    });
    this.observerWatcher.on("change", (_event, filename) => {
      if (filename === null || filename.toString() === basename(this.observerFile)) this.journalSignal.notify();
    });
    this.ptyWatcher.on("change", (_event, filename) => {
      const changed = filename?.toString();
      if (changed === undefined || changed === basename(this.ptyJournalFile) || changed === basename(this.resultFile)) {
        this.ptySignal.notify();
      }
    });
  }

  static async start(options: SavedMainStartOptions): Promise<SavedMainDriver> {
    if (Object.hasOwn(process.env, "PI_REVIEW_GATE_RUNTIME_ROLE")
      || Object.hasOwn(process.env, "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG")) {
      throw new Error("actual role/catalog markers must be rejected before constructing the Main allowlist environment");
    }
    assert.equal(options.env.NODE_OPTIONS, NODE_OPTIONS_ORIGINAL,
      "the actual child environment preserves the original trusted NODE_OPTIONS byte-for-byte");
    assert.equal(options.env.PI_CODING_AGENT_DIR?.startsWith(`${options.scratchRoot}${sep}`), true,
      "the ordinary shared native agent root is inside the fresh isolated test root");
    const home = join(options.scratchRoot, "home");
    const temporary = join(options.scratchRoot, "tmp");
    const config = join(home, ".config");
    const cache = join(home, ".cache");
    const data = join(home, ".local", "share");
    const state = join(home, ".local", "state");
    for (const path of [home, config, cache, data, state, temporary]) mkdirSync(path, { recursive: true, mode: 0o700 });

    const stateRoot = join(options.scratchRoot, "saved-main-state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const resultFile = join(options.scratchRoot, "saved-main-result.json");
    const ptyJournalFile = join(options.scratchRoot, "saved-main-pty-journal.jsonl");
    const controlFile = join(options.scratchRoot, "saved-main-control.json");
    const optionsFile = join(options.scratchRoot, "saved-main-options.json");
    for (const [path, contents] of [
      [resultFile, ""], [ptyJournalFile, ""], [controlFile, ""], [optionsFile, ""],
    ] as const) writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
    const observerDirectory = dirname(options.observerFile);
    mkdirSync(observerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(options.observerFile, "", { flag: "wx", mode: 0o600 });
    const savedOptions = {
      packageRoot: options.candidate.root,
      piExecutable: options.runtime.piExecutable,
      stateRoot,
      toggleKey: "f8",
      args: [...options.args],
      env: options.env,
    };
    writeFileSync(optionsFile, `${JSON.stringify(savedOptions)}\n`, { mode: 0o600 });

    const safePath = [...new Set([dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter);
    const hostEnv: NodeJS.ProcessEnv = {
      PATH: safePath,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "xterm-256color",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      NODE_PATH: options.runtime.nodePath,
      NODE_OPTIONS: NODE_OPTIONS_ORIGINAL,
      PI_REVIEW_GATE_INSTALLED_AGENT: process.env.PI_REVIEW_GATE_INSTALLED_AGENT,
      PI_REVIEW_GATE_INSTALLED_PI_BIN: process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN,
      PI_REVIEW_GATE_EXPECT_PI_VERSION: options.runtime.version,
      PI_REVIEW_GATE_REQUIRE_PI_HOST: "1",
      PRG_SESSION_HOST_SAVED_MAIN_ENTRY: join(options.candidate.root, "dist", "src", "session-host", "main.js"),
      PRG_SESSION_HOST_SAVED_MAIN_OPTIONS: optionsFile,
      PRG_SESSION_HOST_SAVED_MAIN_RESULT: resultFile,
      PRG_SESSION_HOST_SAVED_MAIN_CONTROL: controlFile,
      PRG_SESSION_HOST_SAVED_MAIN_BASELINE: OUTER_RESTORATION_BASELINE,
      PRG_SESSION_HOST_SAVED_MAIN_PTY_JOURNAL: ptyJournalFile,
    };
    assert.ok(!Object.hasOwn(hostEnv, "PI_REVIEW_GATE_RUNTIME_ROLE"));
    assert.ok(!Object.hasOwn(hostEnv, "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"));
    const observerWatcher = watch(observerDirectory);
    const ptyWatcher = watch(dirname(ptyJournalFile));
    let pty: NativePtyHandle;
    try {
      pty = options.ptyModule.spawn(process.execPath, [RUNNER_FIXTURE], {
        name: "xterm-256color",
        cols: OUTER_COLS,
        rows: OUTER_ROWS,
        cwd: process.cwd(),
        env: hostEnv,
        encoding: "utf8",
      });
    } catch {
      observerWatcher.close();
      ptyWatcher.close();
      throw new Error("the real public Saved Main runner could not start in its owned outer PTY");
    }
    return new SavedMainDriver({
      pty,
      scratchRoot: options.scratchRoot,
      observerFile: options.observerFile,
      resultFile,
      ptyJournalFile,
      controlFile,
      observerWatcher,
      ptyWatcher,
    });
  }

  records(): SessionRecord[] {
    return readJsonl<SessionRecord>(this.observerFile);
  }

  ptyRecords(): PtyJournalRecord[] {
    return readJsonl<PtyJournalRecord>(this.ptyJournalFile);
  }

  snapshot(): JournalSnapshot {
    return {
      frameRevision: this.frameRevision,
      observerOffset: this.records().length,
      ptyOffset: this.ptyRecords().length,
    };
  }

  onData(data: string): void {
    this.outputRevision += 1;
    this.outputSignal.notify();
    this.outputTail = (this.outputTail + data).slice(-256 * 1024);
    this.sawAltEnter ||= this.outputTail.includes("\x1b[?1049h");
    this.sawAltLeave ||= this.outputTail.includes("\x1b[?1049l");
    this.sawCursorShow ||= this.outputTail.includes("\x1b[?25h");
    this.sawReset ||= this.outputTail.includes("\x1b[0m");
    try { this.surface.write(data); } catch {
      this.parserError = new Error("the actual public Main output was rejected by the owned outer TerminalSurface");
    }
  }

  private refreshFrame(): void {
    try {
      this.currentFrame = frameText(this.surface);
      if (this.kittyFlagSnapshots.length < 512) this.kittyFlagSnapshots.push(this.surface.inputModes().kittyFlags);
      this.frameRevision += 1;
      this.frameSignal.notify();
    } catch {
      this.parserError = new Error("the owned outer VT snapshot could not be read");
    }
  }

  currentText(): string {
    if (this.parserError) throw this.parserError;
    return this.currentFrame;
  }

  async waitFrame(
    predicate: (text: string) => boolean,
    description: string,
    afterRevision = -1,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await this.frameSignal.waitFor(() => {
        if (this.exitEvent && !(this.frameRevision > afterRevision && predicate(this.currentText()))) {
          throw new Error("the exact owned outer Main PTY exited before its expected frame");
        }
        return this.frameRevision > afterRevision && predicate(this.currentText());
      }, timeoutMs, description);
    } catch (error) {
      throw new Error(`${description}: ${error instanceof Error ? error.message : "bounded frame wait failed"}\nActual owned Saved Main frame:\n${this.currentText()}`);
    }
  }

  async writeAndWait(data: string, predicate: (text: string) => boolean, description: string): Promise<void> {
    const snapshot = this.snapshot();
    this.pty.write(data);
    await this.waitFrame(predicate, description, snapshot.frameRevision);
    await this.ptySignal.waitForQuiet(() => this.ptyRecords().slice(snapshot.ptyOffset)
      .some((record) => record.type === "pty_spawn" || record.type === "force_attempt"),
    SHORT_QUIET_WINDOW_MS, `${description}: text entry creates no child or force attempt`);
    await this.journalSignal.waitForQuiet(() => this.records().slice(snapshot.observerOffset)
      .some((record) => ["session_start", "session_shutdown", "agent_start", "agent_settled"].includes(record.type)),
    SHORT_QUIET_WINDOW_MS, `${description}: text entry creates no native lifecycle or agent turn`);
  }

  async writeKeyAndWait(data: string, predicate: (text: string) => boolean, description: string): Promise<void> {
    const after = this.frameRevision;
    this.pty.write(data);
    await this.waitFrame(predicate, description, after);
  }

  async waitForOutput(afterRevision: number, description: string): Promise<void> {
    await this.outputSignal.waitFor(() => this.outputRevision > afterRevision, EVENT_TIMEOUT_MS, description);
  }

  async waitForQuietFrame(description: string, timeoutMs = 5_000): Promise<void> {
    await this.frameSignal.waitForQuietPeriod(SHORT_QUIET_WINDOW_MS, timeoutMs, description);
  }

  async waitForRecords(
    predicate: (records: SessionRecord[]) => boolean,
    description: string,
    afterOffset = 0,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<SessionRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.records().slice(afterOffset)), timeoutMs, description);
    return this.records();
  }

  async waitForPtyRecords(
    predicate: (records: PtyJournalRecord[]) => boolean,
    description: string,
    afterOffset = 0,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<PtyJournalRecord[]> {
    await this.ptySignal.waitFor(() => predicate(this.ptyRecords().slice(afterOffset)), timeoutMs, description);
    return this.ptyRecords();
  }

  async assertNoNewObserverRecords(snapshot: JournalSnapshot, description: string): Promise<void> {
    await this.journalSignal.waitForQuiet(() => this.records().length > snapshot.observerOffset, SHORT_QUIET_WINDOW_MS, description);
  }

  async assertNoNewPtyRecords(snapshot: JournalSnapshot, description: string): Promise<void> {
    await this.ptySignal.waitForQuiet(() => this.ptyRecords().length > snapshot.ptyOffset, SHORT_QUIET_WINDOW_MS, description);
  }

  async awaitSpawn(snapshot: JournalSnapshot, cwd: string): Promise<ProcessIncarnation> {
    const ptyRecords = await this.waitForPtyRecords((records) => records.some((record) => record.type === "pty_spawn"),
      "fresh public @lydell/node-pty spawn receipt", snapshot.ptyOffset);
    const receipts = ptyRecords.slice(snapshot.ptyOffset).filter((record) => record.type === "pty_spawn");
    assert.equal(receipts.length, 1, "one deliberate New/Saved action creates exactly one new public PTY");
    const raw = receipts[0]!;
    assert.ok(Number.isSafeInteger(raw.receipt) && typeof raw.pid === "number" && typeof raw.cwd === "string",
      "the runner's spawn journal contains exact metadata only");
    assert.equal(raw.cwd, cwd, "the public PTY spawn receipt uses the exact submitted workspace");
    const receipt: SpawnReceipt = { type: "pty_spawn", receipt: raw.receipt!, pid: raw.pid!, cwd: raw.cwd! };
    const watcher = new OwnedPidExitWatcher(receipt.pid);
    const incarnation = this.ledger.addSpawn(receipt, watcher);
    // Registration precedes waiting for session_start or doing any later UI action.
    await watcher.waitUntilRegistered(EVENT_TIMEOUT_MS);
    return incarnation;
  }

  async awaitSessionStart(
    process: ProcessIncarnation,
    snapshot: JournalSnapshot,
    predicate: (record: SessionRecord) => boolean = () => true,
  ): Promise<ConversationBinding> {
    const records = await this.waitForRecords((fresh) => fresh.some((record) => record.type === "session_start"
      && record.pid === process.pid && record.cwd === process.cwd && predicate(record)),
    "fresh exact-PID/cwd public session_start", snapshot.observerOffset);
    const record = records.slice(snapshot.observerOffset).filter((entry) => entry.type === "session_start"
      && entry.pid === process.pid && entry.cwd === process.cwd && predicate(entry)).at(-1);
    assert.ok(record, "the exact session_start was observed after the action snapshot");
    const offset = records.indexOf(record!);
    return this.ledger.bindSessionStart(process, record!, offset);
  }

  async waitForKernelExit(process: ProcessIncarnation): Promise<void> {
    await process.exitWatcher.waitForExit(EVENT_TIMEOUT_MS);
    assert.equal(process.exitWatcher.observedExit, true,
      `the retained kernel watcher observed actual exit of exact owned PID ${process.pid}`);
  }

  async assertPtyExit(process: ProcessIncarnation): Promise<void> {
    const records = await this.waitForPtyRecords((fresh) => fresh.some((record) => record.type === "pty_exit"
      && record.receipt === process.receipt.receipt && record.pid === process.pid && record.cwd === process.cwd),
    `the manager-owned public IPty onExit for receipt ${process.receipt.receipt}`);
    const exit = records.find((record) => record.type === "pty_exit" && record.receipt === process.receipt.receipt
      && record.pid === process.pid && record.cwd === process.cwd);
    assert.ok(exit, "the exact public IPty onExit record exists");
    assert.equal(exit!.exitCode, 0, "the actual public PTY exit code is zero");
    assert.ok(!exit!.signal, "the actual public PTY exit was not signal termination");
  }

  async waitForOuterExit(timeoutMs = EVENT_TIMEOUT_MS): Promise<PtyExit> {
    if (!this.exitEvent) await this.exitSignal.waitFor(() => this.exitEvent !== undefined, timeoutMs, "owned outer Main PTY exit");
    return this.exitEvent!;
  }

  async waitForRunnerResult(timeoutMs = EVENT_TIMEOUT_MS): Promise<RunnerResult> {
    await this.ptySignal.waitFor(() => readJsonl<RunnerResult>(this.resultFile).length === 1,
      timeoutMs, "the public runSessionHost return and terminal restoration record");
    const results = readJsonl<RunnerResult>(this.resultFile);
    assert.equal(results.length, 1, "the runner result is one bounded metadata record");
    return results[0]!;
  }

  private runnerResultIfAvailable(): RunnerResult | undefined {
    const results = readJsonl<RunnerResult>(this.resultFile);
    return results.length === 1 ? results[0] : undefined;
  }

  private assertRunSessionHostRestoration(result: RunnerResult): void {
    assert.equal(result.forceAttempted, false, "sticky runner history records no child force attempt, including throws");
    assert.equal(result.journalFailed, false, "no failed observation write can hide child force history");
    assert.equal(result.threw, false, "runSessionHost returned without an unhandled error");
    assert.equal(result.status, 0, "the public Main API returned zero");
    assert.equal(result.stdinIsTTY, true);
    assert.equal(result.stdoutIsTTY, true);
    assert.equal(result.after, result.before, "the real owned controlling TTY termios is restored exactly");
    assert.equal(result.rawAfter, result.rawBefore, "the actual Node raw-mode state is restored");
    assert.ok(this.sawAltEnter, "the actual public Main entered the alternate VT screen");
    assert.ok(this.sawAltLeave, "the actual public Main returned from the alternate VT screen");
    assert.ok(this.sawCursorShow, "the public Main restored VT cursor visibility");
    assert.ok(this.sawReset, "the public Main restored the terminal style state");
    const restoredFrame = frameText(this.surface);
    assert.ok(restoredFrame.split("\n")[0]?.trimEnd().includes(this.baseline),
      "the complete short primary-VT baseline is present on the restored primary buffer");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?[\d;]*c$/.test(reply)),
      "the outer TerminalSurface answered the actual public device-attributes query");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?\d+u$/.test(reply)),
      "the outer TerminalSurface answered the actual public Kitty keyboard-state query");
    assert.ok(this.kittyFlagSnapshots.length > 0 && this.kittyFlagSnapshots.every((flags) =>
      Number.isInteger(flags) && flags >= 0 && flags <= 7),
    "all observed Kitty mode snapshots remain in the supported public flag range");
    const restoredModes = this.surface.inputModes();
    assert.equal(restoredModes.kittyFlags, 0, "the public Main popped negotiated Kitty keyboard state");
    assert.equal(restoredModes.applicationCursorKeys, false, "application cursor-key mode is restored");
    assert.equal(restoredModes.applicationKeypad, false, "application keypad mode is restored");
    assert.equal(restoredModes.bracketedPaste, false, "bracketed-paste mode is restored");
    assert.equal(restoredModes.mouseTracking, "none", "mouse tracking is restored");
    assert.equal(restoredModes.modifyOtherKeys, 0, "modifyOtherKeys is restored");
    assert.equal(restoredModes.mouseEncoding, "default", "mouse encoding is restored");
    assert.ok(this.outputTail.lastIndexOf("\x1b[?1049l") > this.outputTail.lastIndexOf("\x1b[?1049h"),
      "the last alternate-screen transition restores the primary VT");
  }

  private assertOuterRestoration(exit: PtyExit, result: RunnerResult): void {
    assert.equal(exit.exitCode, 0, "the actual public runSessionHost API returned through the owned outer PTY with status zero");
    assert.ok(!exit.signal, "the outer public Main runner did not exit by signal");
    this.assertRunSessionHostRestoration(result);
  }

  private sendRunnerControl(action: "release" | "force", receipts: readonly number[] = []): number {
    if (action === "force") {
      assert.ok(receipts.length > 0 && receipts.every((receipt) => Number.isSafeInteger(receipt) && receipt > 0),
        "failure fallback names only exact positive public PTY spawn receipts");
    }
    const requestId = ++this.controlRequestId;
    const tempPath = join(dirname(this.controlFile), `saved-main-control-${requestId}.tmp`);
    const request = action === "release"
      ? { requestId, action }
      : { requestId, action, receipts: [...new Set(receipts)] };
    writeFileSync(tempPath, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(tempPath, this.controlFile);
    return requestId;
  }

  private releaseRunner(): void {
    if (this.runnerReleased) return;
    this.sendRunnerControl("release");
    this.runnerReleased = true;
  }

  private async forceExactUnresolvedChildren(processes: readonly ProcessIncarnation[]): Promise<void> {
    const receipts = processes.map((process) => process.receipt.receipt);
    const afterOffset = this.ptyRecords().length;
    const requestId = this.sendRunnerControl("force", receipts);
    const records = await this.waitForPtyRecords((fresh) => receipts.every((receipt) => fresh.some((record) =>
      record.type === "force_fallback_result" && record.requestId === requestId && record.receipt === receipt)),
    "failure-only exact-handle child force fallback acknowledgements", afterOffset, EVENT_TIMEOUT_MS);
    for (const process of processes) {
      const result = records.slice(afterOffset).find((record) => record.type === "force_fallback_result"
        && record.requestId === requestId && record.receipt === process.receipt.receipt);
      assert.ok(result, `the runner acknowledged exact PTY receipt ${process.receipt.receipt}`);
      assert.equal(result!.pid, process.pid, "failure fallback addressed the exact retained PID metadata");
      assert.equal(result!.cwd, process.cwd, "failure fallback addressed the exact retained cwd metadata");
      if (result!.alreadyExited) {
        assert.equal(result!.attempted, false, "an exact public onExit witness suppresses a stale force call");
        assert.equal(result!.failed, false);
      } else {
        assert.equal(result!.attempted, true, "the runner invoked and journaled the exact retained public IPty kill method");
        // A thrown kill can race a real exit; retain the kernel watcher and let
        // its exact PID observation decide whether ownership is actually gone.
      }
    }
  }

  async waitForNormalOuterExit(): Promise<PtyExit> {
    const result = await this.waitForRunnerResult();
    assert.ok(this.ledger.all().every((process) => process.exitWatcher.observedExit),
      "the runner owner is not released until every retained native child kernel watcher observed exit");
    await this.surface.flush();
    this.assertRunSessionHostRestoration(result);
    this.releaseRunner();
    const exit = await this.waitForOuterExit();
    await this.surface.flush();
    this.assertOuterRestoration(exit, result);
    return exit;
  }

  async terminateExactOuterForFailure(): Promise<void> {
    if (!this.exitEvent && !this.runnerResultIfAvailable()) {
      // SIGTERM is the owner's graceful-shutdown request. Keep that owner alive
      // for Main's complete production grace+kill window before any fallback.
      this.outerKillAttempts.push({ signal: "SIGTERM" });
      try { this.pty.kill("SIGTERM"); } catch { /* this exact test-owned outer IPty handle only */ }
      await this.waitForRunnerResult(OWNER_SHUTDOWN_WINDOW_MS).catch(() => undefined);
    }

    let unresolved = this.ledger.all().filter((process) => !process.exitWatcher.observedExit);
    await Promise.all(unresolved.map((process) => process.exitWatcher.waitForExit(FAILURE_EXIT_SETTLE_MS).catch(() => undefined)));
    unresolved = this.ledger.all().filter((process) => !process.exitWatcher.observedExit);
    const hasExactPtyExit = (process: ProcessIncarnation): boolean => this.ptyRecords().some((record) =>
      record.type === "pty_exit" && record.receipt === process.receipt.receipt
        && record.pid === process.pid && record.cwd === process.cwd);
    const ptyExitedButKernelPending = unresolved.filter(hasExactPtyExit);
    await Promise.all(ptyExitedButKernelPending.map((process) =>
      process.exitWatcher.waitForExit(FAILURE_FORCE_EXIT_TIMEOUT_MS).catch(() => undefined)));
    unresolved = this.ledger.all().filter((process) => !process.exitWatcher.observedExit);
    const forceTargets = unresolved.filter((process) => !hasExactPtyExit(process));
    if (forceTargets.length > 0) {
      if (this.exitEvent) {
        throw new Error("the Main runner exited before failure-only exact-handle fallback could address unresolved child receipts");
      }
      // This request is sent only after the owner had its full bounded window;
      // the runner resolves receipts through its in-memory public IPty map.
      await this.forceExactUnresolvedChildren(forceTargets);
      await Promise.all(forceTargets.map((process) => process.exitWatcher.waitForExit(FAILURE_FORCE_EXIT_TIMEOUT_MS)));
    }

    unresolved = this.ledger.all().filter((process) => !process.exitWatcher.observedExit);
    if (unresolved.length > 0) {
      throw new Error(`retained kernel watchers still have unresolved child receipts: ${unresolved.map((process) => process.receipt.receipt).join(",")}`);
    }

    const spawns = this.ptyRecords().filter((record) => record.type === "pty_spawn");
    if (spawns.length !== this.ledger.all().length || spawns.some((record) => {
      const owned = record.receipt === undefined ? undefined : this.ledger.byReceipt(record.receipt);
      return !owned || owned.pid !== record.pid || owned.cwd !== record.cwd || !owned.exitWatcher.observedExit;
    })) {
      throw new Error("retain the Main owner: not every actual child spawn has a registered, confirmed kernel-exit witness");
    }

    // Child ownership is now kernel-confirmed. If runSessionHost is still
    // completing its bounded teardown, let it finish; release remains safe
    // because every exact child watcher has observed exit.
    if (!this.exitEvent) {
      await this.waitForRunnerResult(OWNER_SHUTDOWN_WINDOW_MS).catch(() => undefined);
      this.releaseRunner();
      try {
        await this.waitForOuterExit(OUTER_EXIT_TIMEOUT_MS);
      } catch {
        this.outerKillAttempts.push({ signal: "SIGTERM" });
        try { this.pty.kill("SIGTERM"); } catch { /* no native child remains; exact outer handle only */ }
        try {
          await this.waitForOuterExit(OUTER_EXIT_TIMEOUT_MS);
        } catch {
          this.outerKillAttempts.push({ signal: "SIGKILL" });
          try { this.pty.kill("SIGKILL"); } catch { /* child kernel exits were already confirmed */ }
          await this.waitForOuterExit(OUTER_EXIT_TIMEOUT_MS).catch(() => undefined);
        }
      }
    }
  }

  async stopExitedWatchers(): Promise<void> {
    await Promise.all(this.ledger.all().filter((entry) => entry.exitWatcher.observedExit)
      .map((entry) => entry.exitWatcher.stop()));
  }

  dispose(): void {
    try { this.dataSubscription.dispose(); } catch { /* exact owned outer data subscription */ }
    try { this.exitSubscription.dispose(); } catch { /* exact owned outer exit subscription */ }
    try { this.surface.dispose(); } catch { /* this owned headless VT only */ }
    try { this.observerWatcher.close(); } catch { /* this owned lifecycle-journal directory watcher */ }
    try { this.ptyWatcher.close(); } catch { /* this owned public-PTY-journal directory watcher */ }
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf(sep);
  return path.slice(index + 1);
}

export function createSavedMainScratchRoot(): string {
  return createOwnedScratchRoot();
}

export function createSavedMainWorkspace(root: string, name: string): string {
  return makeWorkspace(root, name);
}

export function createSavedMainAgentRoot(root: string): string {
  return makeNativeAgentRoot(root);
}

export function createSavedMainCandidate(root: string): CandidatePackage {
  return compileAndStageCandidate(root);
}

export function createSavedMainEditor(root: string, workspace: string): { readonly editor: string; readonly log: string } {
  const target = join(workspace, "editor-target");
  mkdirSync(target, { mode: 0o700 });
  const log = createEditorLog(root);
  return { editor: createEditorExecutable(root, target, log), log };
}

export function createSavedMainChildEnvironment(
  root: string,
  runtime: RuntimePin,
  editor: string,
  observerFile: string,
  editorLog: string,
  agentRoot: string,
): NodeJS.ProcessEnv {
  if (Object.hasOwn(process.env, "PI_REVIEW_GATE_RUNTIME_ROLE")
    || Object.hasOwn(process.env, "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG")) {
    throw new Error("actual role/catalog markers must be rejected before constructing the child allowlist");
  }
  const env = makeRuntimeEnvironment(root, runtime, editor, observerFile, editorLog, "", agentRoot);
  assert.equal(env.NODE_OPTIONS, NODE_OPTIONS_ORIGINAL, "the original trusted NODE_OPTIONS value is preserved exactly");
  return env;
}

export async function waitForJsonl<T>(
  path: string,
  predicate: (records: T[]) => boolean,
  timeoutMs: number,
  description: string,
): Promise<T[]> {
  const signal = new ChangeSignal();
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename === null || filename.toString() === basename(path)) signal.notify();
  });
  try {
    await signal.waitFor(() => predicate(readJsonl<T>(path)), timeoutMs, description);
    return readJsonl<T>(path);
  } finally {
    watcher.close();
  }
}

export function readOwnedJsonl<T>(path: string): T[] {
  return readJsonl<T>(path);
}

export function latestDimensions(records: readonly SessionRecord[], pid: number): { readonly columns?: number; readonly rows?: number } {
  const scoped = records.filter((record) => record.pid === pid && (record.type === "session_start" || record.type === "resize"));
  const latest = scoped.at(-1);
  return { columns: latest?.columns, rows: latest?.rows };
}

export function ptySpawnCount(records: readonly PtyJournalRecord[]): number {
  return records.filter((record) => record.type === "pty_spawn").length;
}

export function assertNoForbiddenSessionArgs(args: readonly string[]): void {
  const forbidden = new Set(["--session", "--session-id", "--sessionID", "--session-dir", "--no-session", "--continue", "--resume", "--fork"]);
  assert.equal(args.some((arg) => forbidden.has(arg)), false,
    "the real native Pi process receives no forced/resumed/no-session override");
}

export function workspaceOnlyNewFrame(text: string): boolean {
  return text.includes("New session") && text.includes("> Workspace:")
    && !text.includes("Label:") && !text.includes("Profile:");
}

export function isEmptyWorkspaceField(text: string): boolean {
  return nativeFormFieldIsEmpty(text, "> Workspace:");
}

export function getWorkspaceFieldValue(text: string): string | undefined {
  return workspaceFieldValue(text);
}

export function ptyJournalHasForceAttempt(records: readonly PtyJournalRecord[]): boolean {
  return records.some((record) => [
    "force_attempt", "force_attempt_failed", "pty_observation_failed", "pty_spawn_metadata_invalid", "pty_on_exit_failed",
  ].includes(record.type));
}

export function validateSharedRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  runtime: RuntimePin,
  agentRoot: string,
  root: string,
): void {
  assert.equal(env.PI_CODING_AGENT_DIR, agentRoot, "all children share one ordinary native agent root");
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(env.PI_TELEMETRY, "0");
  assert.equal(env.NODE_OPTIONS, NODE_OPTIONS_ORIGINAL, "trusted startup options are not stripped or rewritten");
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP"]) {
    const value = env[key];
    assert.ok(value && (value === root || value.startsWith(`${root}${sep}`)), `${key} is isolated below the owned test root`);
  }
  assert.equal(env.NODE_PATH, runtime.nodePath);
  assert.deepEqual(Object.keys(env).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the allowlisted native environment contains no credential-like variables");
}

export function processIsStillOwnedAndLive(process: ProcessIncarnation): boolean {
  return process.exitWatcher.observedExit === false && processIsAlive(process.pid);
}

export function currentBinding(process: ProcessIncarnation): ConversationBinding {
  const binding = process.bindings.at(-1);
  assert.ok(binding, "the process has at least one public session_start binding");
  return binding!;
}

export function findBinding(process: ProcessIncarnation, sessionId: string, sessionFile: string): ConversationBinding | undefined {
  return process.bindings.find((binding) => binding.sessionId === sessionId && binding.sessionFile === sessionFile);
}

export function recordHasCurrentConversation(record: SessionRecord, process: ProcessIncarnation): boolean {
  const binding = currentBinding(process);
  return record.pid === process.pid && record.cwd === process.cwd && record.sessionId === binding.sessionId
    && record.contextSessionId === binding.sessionId;
}

export function canonicalWorkspace(path: string): string {
  return canonicalRealpath(path);
}

export function originalNodeOptions(): string | undefined {
  return NODE_OPTIONS_ORIGINAL;
}

export function shortBaselineFitsTwentyFourColumns(): boolean {
  return Array.from(OUTER_RESTORATION_BASELINE).length <= 24;
}

export function requirePublicRuntimeDependencies(runtime: RuntimePin): void {
  const projectRequire = createRequire(join(process.cwd(), "package.json"));
  for (const name of ["@xterm/headless", "@xterm/addon-unicode11", "@lydell/node-pty"]) {
    assert.ok(projectRequire.resolve(name), `the public runtime dependency ${name} resolves from the workspace`);
  }
  assert.ok(runtime.piExecutable.endsWith(".js"), "the runtime uses the pinned public Node CLI entry, not a shell shim");
  assert.ok(existsSync(RUNNER_FIXTURE), "the dedicated public runner fixture is present");
  assert.ok(existsSync(OBSERVER_FIXTURE) && existsSync(PROVIDER_FIXTURE), "only the public observer/provider fixtures are used");
}

export {
  createOwnedScratchRoot,
  makeNativeAgentRoot,
  makeRuntimeEnvironment,
  makeWorkspace,
  nativeFormFieldIsEmpty,
  processIsAlive,
  sessionFileHasStoredName,
  sha256,
};
