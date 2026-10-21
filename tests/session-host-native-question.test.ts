/**
 * Native question UI/lifecycle proof (session-host native question phase).
 *
 * Drives ONE explicitly pinned real native Pi TUI session — the REAL review gate
 * extension, the production session-host reporter/broker/TerminalSurface,
 * in an isolated owned PTY under a synthetic HOME/profile — through the full
 * AskUserQuestion lifecycle:
 *
 *   scripted faux toolCall (public pi.registerProvider + fauxProvider, zero
 *   external AI/API calls) → real pending-question panel and list UI →
 *   exact owned multiline `.png` path through the real free-text editor
 *   (including first post-paste frame, canonical delivery, and draft restore) →
 *   normal next turn whose model context actually contains the delivered answer →
 *   orderly Ctrl+C-twice host exit with a genuine session_shutdown.
 *
 * A second scenario (#413) pins Pi's fullscreen renderer in the same owned
 * session shape and drives the existing scroll keys through the PTY: the
 * popup keeps its compact, content-sized frame over the live transcript
 * (short lists and notices use only their natural rows, long content is
 * capped one row inside the terminal, and new transcript output stays
 * visible around an open popup); a long notice and a long question open at
 * their beginning, body/context/choices/actions scroll together by exact
 * line counts under a fixed hint, both bounds are contained, Up/Down select
 * and reveal without submitting, the draft survives scrolling, resize keeps
 * and clamps the offset, keyboard scrolling never moves the transcript, and
 * after close/reopen the answer routing behaves normally.
 *
 * No bypass, no fabricated events, no skip: every prerequisite that cannot
 * be satisfied hard-fails under PI_REVIEW_GATE_REQUIRE_PI_HOST=1 (skipOrFail),
 * and every wait is event-driven (PTY output, broker status, fs.watch on the
 * owned journals) under a bounded deadline — never a polling or sleep loop.
 *
 * Test-only surface: this file plus tests/fixtures/session-host-native-provider.cjs
 * (the scripted provider extension). No production source, backend, main, CI,
 * doc, or package files are touched.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { watch as fsWatch } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareNativeLaunch, resolveNativePi } from "../src/session-host/launch";
import { createStatusBroker, type StatusBroker, type StatusRegistration } from "../src/session-host/broker";
import { HOST_BOOTSTRAP_ENV, type SessionHostStatus } from "../src/session-host/protocol";
import { ProfileRegistry, type PreparedProfile } from "../src/session-host/profiles";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";
// Dedicated durable-file signals (the owned observer/provider journals) use the
// one shared durable-readiness class; in-process status/frame/reply/exit
// readiness keeps the notification-driven local signal below.
import { ChangeSignal as DurableChangeSignal } from "./helpers/change-signal";

const TEST_TIMEOUT_MS = 240_000;
const EVENT_TIMEOUT_MS = 30_000;
const CHILD_EXIT_TIMEOUT_MS = 15_000;
const PTY_COLS = 120;
const PTY_ROWS = 50;
// Mirror questionPopupOverlayOptions(): full conversation width, one-row
// vertical margins, and a 100%-height cap resolved against this owned PTY.
const QUESTION_POPUP_VERTICAL_MARGIN = 1;
const QUESTION_POPUP_COLUMNS = PTY_COLS;
const QUESTION_POPUP_MAX_ROWS = Math.max(1, PTY_ROWS - 2 * QUESTION_POPUP_VERTICAL_MARGIN);
const QUESTION_POPUP_START_COLUMN = 0;
const QUESTION_POPUP_START_ROW = QUESTION_POPUP_VERTICAL_MARGIN
  + Math.floor((PTY_ROWS - 2 * QUESTION_POPUP_VERTICAL_MARGIN - QUESTION_POPUP_MAX_ROWS) / 2);
const MAX_STAGED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STAGED_TREE_BYTES = 128 * 1024 * 1024;
const MAX_STAGED_TREE_FILES = 20_000;
const MAX_STAGED_TREE_DEPTH = 40;

// --- Distinctive content markers for the scripted question and its answer ---
const QUESTION_TEXT = "Native question probe: which option should the fixture use?";
const CHOICE_A = "Alpha option";
const CHOICE_B = "Beta option";
const INITIAL_PROMPT = "Please ask me which option to use.";
const CHAT_DRAFT_FIRST = "unsent chat draft preserved across the question popup";
const CHAT_DRAFT_SECOND = "second exact draft line";
const CHAT_DRAFT = `${CHAT_DRAFT_FIRST}\n${CHAT_DRAFT_SECOND}`;
const ECHO_PREFIX = "Fixture echo of delivered answer: ";

// --- Key sequences (xterm) ---
const KEY_ENTER = "\r";
const KEY_DOWN = "\x1b[B";
const KEY_SHIFT_ENTER = "\x1b[13;2u";
/** CSI for Ctrl+Alt+Up; pi-tui's matchesKey maps this to `ctrl+alt+up`. */
const KEY_CTRL_ALT_UP = "\x1b[1;7A";
const KEY_CTRL_C = "\x03";

interface StaticPrerequisites {
  candidateSourceRoot: string;
  installedAgentDir: string;
  piBinTarget: string;
  expectedPiVersion: string;
  moduleSearchPath: string;
}

interface NativePtyExit {
  exitCode: number;
  signal?: number;
}

interface Disposable {
  dispose(): void;
}

interface NativePtyHandle {
  readonly pid: number | string;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: NativePtyExit) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NativePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
      encoding: "utf8";
    },
  ): NativePtyHandle;
}

interface SurfaceFrame {
  cols: number;
  rows: number;
  lines: string[];
}

interface TerminalSurfaceHandle {
  write(data: string): void;
  flush(): Promise<void>;
  resize(cols: number, rows: number): void;
  frame(): SurfaceFrame;
  dispose(): void;
}

interface TerminalSurfaceModule {
  TerminalSurface: new (
    cols: number,
    rows: number,
    options: { onReply?: (data: string) => void; onChange?: () => void },
  ) => TerminalSurfaceHandle;
  stripGeneratedSgr(line: string): string;
}

interface StagedCandidate {
  packageRoot: string;
  entry: string;
  nodePath: string;
}

interface QuestionOwner {
  id: string;
  observerFile: string;
  providerJournalFile: string;
  registration: StatusRegistration;
  statuses: StatusJournal;
  descriptor: ReturnType<typeof prepareNativeLaunch>;
  replies: string[];
  replySignal: ChangeSignal;
  pty?: NativePtyHandle;
  exit?: NativePtyExit;
  exitSignal: ChangeSignal;
  dataSubscription?: Disposable;
  exitSubscription?: Disposable;
  parseFailed: boolean;
  surface: TerminalSurfaceHandle;
  frames: FrameWatch;
}

function repositoryRoot(): string {
  return resolve(process.cwd());
}

function moduleResolvable(request: string): boolean {
  try {
    createRequire(join(repositoryRoot(), "package.json")).resolve(request);
    return true;
  } catch {
    return false;
  }
}

function nodeVersionMeetsPiFloor(): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

function providerFixturePath(): string {
  const candidates = [
    resolve(__dirname, "fixtures", "session-host-native-provider.cjs"),
    resolve(process.cwd(), "tests", "fixtures", "session-host-native-provider.cjs"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`scripted provider fixture not found: ${candidates.join(" or ")}`);
  return found;
}

function staticPrerequisites(t: { skip(message?: string): void }): StaticPrerequisites | undefined {
  if (process.platform === "win32") {
    // Native session-host backend support is POSIX alpha only, even in required-host CI.
    t.skip("native session-host backend compatibility is POSIX-only in this alpha");
    return undefined;
  }

  const pinned = process.env.PI_REVIEW_GATE_INSTALLED_AGENT?.trim();
  const pinnedPiBinValue = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN?.trim();
  const expectedPiVersion = process.env.PI_REVIEW_GATE_EXPECT_PI_VERSION?.trim();
  const candidateValue = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY?.trim();
  if (!pinned) {
    skipOrFail(t, "PI_REVIEW_GATE_INSTALLED_AGENT must explicitly pin the installed Pi package");
    return undefined;
  }
  if (!pinnedPiBinValue || !isAbsolute(pinnedPiBinValue)) {
    skipOrFail(t, "PI_REVIEW_GATE_INSTALLED_PI_BIN must explicitly pin the installed Pi node_modules/.bin directory or a Node CLI entry");
    return undefined;
  }
  if (!expectedPiVersion) {
    skipOrFail(t, "PI_REVIEW_GATE_EXPECT_PI_VERSION must explicitly pin the native Pi CLI version");
    return undefined;
  }
  if (!candidateValue) {
    skipOrFail(t, "PI_REVIEW_GATE_CANDIDATE_ENTRY must name the freshly compiled candidate src/index.js");
    return undefined;
  }
  if (!nodeVersionMeetsPiFloor()) {
    skipOrFail(t, "the pinned stable Pi runtime requires Node >=22.19.0");
    return undefined;
  }

  let installedAgentDir: string;
  try {
    installedAgentDir = realpathSync(resolve(pinned));
  } catch {
    skipOrFail(t, "the explicitly pinned installed Pi package is unavailable");
    return undefined;
  }
  const explicitInstalls = findInstalledAgentDirs();
  if (explicitInstalls.length !== 1 || realpathSync(explicitInstalls[0]!) !== installedAgentDir) {
    skipOrFail(t, "the installed-agent helper did not resolve exactly the explicit Pi package pin");
    return undefined;
  }

  let packageInfo: { name?: string; version?: string; bin?: string | Record<string, string> };
  try {
    packageInfo = JSON.parse(readFileSync(join(installedAgentDir, "package.json"), "utf8")) as typeof packageInfo;
  } catch {
    skipOrFail(t, "the explicitly pinned Pi package metadata is unreadable");
    return undefined;
  }
  if (packageInfo.name !== "@earendil-works/pi-coding-agent") {
    skipOrFail(t, "the explicit Pi pin is not the supported pi-coding-agent package");
    return undefined;
  }
  if (packageInfo.version !== expectedPiVersion) {
    skipOrFail(t, "the installed Pi package does not match PI_REVIEW_GATE_EXPECT_PI_VERSION");
    return undefined;
  }
  const binTarget = typeof packageInfo.bin === "string" ? packageInfo.bin : packageInfo.bin?.pi;
  if (typeof binTarget !== "string" || binTarget.length === 0) {
    skipOrFail(t, "the pinned Pi package does not declare a readable native pi Node CLI bin target");
    return undefined;
  }
  const declaredPiBinTarget = resolve(installedAgentDir, binTarget);
  const declaredRelative = relative(installedAgentDir, declaredPiBinTarget);
  if (declaredRelative === ".." || declaredRelative.startsWith(`..${sep}`) || isAbsolute(declaredRelative)) {
    skipOrFail(t, "the pinned Pi package declares a CLI bin outside its package root");
    return undefined;
  }
  let declaredReal: string | undefined;
  try { declaredReal = realpathSync(declaredPiBinTarget); } catch { /* the supported dist/cli.js entry remains a fallback */ }
  let supportedCliReal: string | undefined;
  try { supportedCliReal = realpathSync(join(installedAgentDir, "dist", "cli.js")); } catch { /* package bin remains a supported alternative */ }
  const isContainedCli = (entry: string | undefined): entry is string => {
    if (!entry) return false;
    const entryRelative = relative(installedAgentDir, entry);
    return entry !== installedAgentDir
      && entryRelative !== ".."
      && !entryRelative.startsWith(`..${sep}`)
      && !isAbsolute(entryRelative);
  };
  const declaredCli = isContainedCli(declaredReal) ? declaredReal : undefined;
  const distCli = isContainedCli(supportedCliReal) ? supportedCliReal : undefined;
  if (!declaredCli && !distCli) {
    skipOrFail(t, "the pinned Pi package has no readable contained Node CLI entry");
    return undefined;
  }

  let requestedPin: string;
  let requestedPinStats: ReturnType<typeof statSync>;
  try {
    requestedPin = realpathSync(resolve(pinnedPiBinValue));
    requestedPinStats = statSync(requestedPin);
  } catch {
    skipOrFail(t, "the explicitly pinned installed Pi bin path is unavailable");
    return undefined;
  }
  let piBinTarget: string;
  if (requestedPinStats.isDirectory()) {
    let expectedBinDirectory: string;
    try {
      expectedBinDirectory = realpathSync(join(dirname(dirname(installedAgentDir)), ".bin"));
    } catch {
      skipOrFail(t, "the pinned Pi package's installed node_modules/.bin directory is unavailable");
      return undefined;
    }
    if (requestedPin !== expectedBinDirectory) {
      skipOrFail(t, "the directory pin is not the pinned Pi package's installed node_modules/.bin directory");
      return undefined;
    }
    piBinTarget = declaredCli ?? distCli!;
  } else if (requestedPinStats.isFile() && isContainedCli(requestedPin)
    && (requestedPin === declaredCli || requestedPin === distCli)) {
    piBinTarget = requestedPin;
  } else {
    skipOrFail(t, "the explicit Pi CLI pin does not match the package's contained native Node bin target");
    return undefined;
  }

  const candidateEntry = resolve(candidateValue);
  let candidateReal: string;
  try {
    candidateReal = realpathSync(candidateEntry);
  } catch {
    skipOrFail(t, "the freshly compiled candidate entry is unavailable");
    return undefined;
  }
  const candidateSourceRoot = dirname(dirname(dirname(candidateReal)));
  if (candidateReal !== join(candidateSourceRoot, "dist", "src", "index.js")) {
    skipOrFail(t, "the candidate is not a conventional dist/src/index.js extension entry");
    return undefined;
  }
  for (const relativeFile of [
    ["dist", "src", "index.js"],
    ["dist", "src", "session-host", "reporter.js"],
    ["dist", "src", "session-host", "bootstrap-preload.js"],
  ]) {
    if (!existsSync(join(candidateSourceRoot, ...relativeFile))) {
      skipOrFail(t, "the compiled candidate is missing a production launch/reporter/preload module");
      return undefined;
    }
  }

  const moduleSearchPath = [
    join(repositoryRoot(), "node_modules"),
    join(candidateSourceRoot, "node_modules"),
    join(installedAgentDir, "node_modules"),
    dirname(dirname(installedAgentDir)),
  ].filter((path) => {
    try {
      const stats = lstatSync(path);
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }).join(delimiter);
  if (!moduleSearchPath) {
    skipOrFail(t, "the candidate and pinned Pi dependency-resolution roots are unavailable");
    return undefined;
  }

  const missingModules = ["@xterm/headless", "@xterm/addon-unicode11", "@lydell/node-pty"]
    .filter((name) => !moduleResolvable(name));
  if (missingModules.length > 0) {
    const optionalPty = missingModules.includes("@lydell/node-pty");
    skipOrFail(
      t,
      optionalPty
        ? "the pinned optional @lydell/node-pty native binding is unavailable"
        : "the pinned production TerminalSurface modules are unavailable",
    );
    return undefined;
  }

  return { candidateSourceRoot, installedAgentDir, piBinTarget, expectedPiVersion, moduleSearchPath };
}

function makeSyntheticRoot(): string {
  // The broker canonicalizes socketRoot and appends its private transport
  // directory and socket filename; choose the shortest canonical POSIX temp
  // directory (not the often very long workspace or TMPDIR alias).
  const candidates = [...new Set([tmpdir(), "/tmp"])]
    .map((path) => {
      try {
        const canonical = realpathSync(path);
        return lstatSync(canonical).isDirectory() ? canonical : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((path): path is string => path !== undefined)
    .sort((left, right) => Buffer.byteLength(left) - Buffer.byteLength(right));
  for (const parent of candidates) {
    let root: string | undefined;
    try {
      root = mkdtempSync(join(parent, "shq-"));
      chmodSync(root, 0o700);
      return root;
    } catch {
      if (root) {
        try { rmdirSync(root); } catch { /* no owned root remains to remove */ }
      }
    }
  }
  throw new Error("a writable canonical POSIX temporary directory is unavailable for the native question test");
}

function assertBrokerSocketPathBudget(root: string): void {
  const brokerRoot = realpathSync(join(root, "broker"));
  const longestSocketPath = join(brokerRoot, "prg-st-XXXXXX", "s.sock");
  if (Buffer.byteLength(longestSocketPath, "utf8") > 103) {
    throw new Error("the canonical synthetic root cannot fit the production broker's bounded POSIX socket path");
  }
}

function makeSyntheticEnvironment(root: string, nodePath = ""): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  const pathEntries = [nodeBin, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set(pathEntries)].join(delimiter),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
  };
  if (nodePath) env.NODE_PATH = nodePath;
  return env;
}

function initializeSyntheticDirectories(root: string): void {
  for (const path of [
    join(root, "home"),
    join(root, "home", ".config"),
    join(root, "tmp"),
    join(root, "workspaces"),
    join(root, "observer"),
    join(root, "fixture-state"),
    join(root, "broker"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function copyBoundedRegularFile(source: string, destination: string, maxBytes = MAX_STAGED_FILE_BYTES): void {
  const stats = lstatSync(source);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
    throw new Error("safe candidate staging rejected a non-regular or oversized source file");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function copyBoundedCandidateTree(sourceRoot: string, destinationRoot: string): void {
  let copiedBytes = 0;
  let copiedFiles = 0;
  const visit = (source: string, destination: string, depth: number): void => {
    if (depth > MAX_STAGED_TREE_DEPTH) throw new Error("safe candidate staging exceeded its directory-depth bound");
    const rootStats = lstatSync(source);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("safe candidate staging requires a real compiled source directory");
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source)) {
      const sourceEntry = join(source, name);
      const destinationEntry = join(destination, name);
      const stats = lstatSync(sourceEntry);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        visit(sourceEntry, destinationEntry, depth + 1);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STAGED_FILE_BYTES) {
        throw new Error("safe candidate staging rejected a linked, special, or oversized compiled entry");
      }
      copiedFiles += 1;
      copiedBytes += stats.size;
      if (copiedFiles > MAX_STAGED_TREE_FILES || copiedBytes > MAX_STAGED_TREE_BYTES) {
        throw new Error("safe candidate staging exceeded its aggregate file bound");
      }
      mkdirSync(dirname(destinationEntry), { recursive: true, mode: 0o700 });
      copyFileSync(sourceEntry, destinationEntry);
    }
  };
  visit(sourceRoot, destinationRoot, 0);
}

function stageCandidate(root: string, prerequisites: StaticPrerequisites): StagedCandidate {
  const packageRoot = join(root, 'candidate "quoted" package');
  const entry = join(packageRoot, "dist", "src", "index.js");
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  copyBoundedCandidateTree(join(prerequisites.candidateSourceRoot, "dist", "src"), join(packageRoot, "dist", "src"));
  copyBoundedRegularFile(
    join(repositoryRoot(), "scripts", "pi-review-gate-launcher.cjs"),
    join(packageRoot, "scripts", "pi-review-gate-launcher.cjs"),
  );

  const shippedFiles: readonly string[][] = [
    ["skills", "pi-review-gate-orchestrator", "SKILL.md"],
    ["skills", "pi-review-gate-orchestrator", "references", "recovery.md"],
    ["skills", "pi-review-gate-execution", "SKILL.md"],
    ["skills", "pi-review-gate-research", "SKILL.md"],
    ["skills", "pi-review-gate-completion", "SKILL.md"],
  ];
  for (const parts of shippedFiles) {
    copyBoundedRegularFile(join(repositoryRoot(), ...parts), join(packageRoot, ...parts), 2 * 1024 * 1024);
  }
  for (const promptFile of [
    "execution-system-prompt.md",
    "orchestrator-system-prompt.md",
    "planning-system-prompt.md",
  ]) {
    copyBoundedRegularFile(
      join(repositoryRoot(), "scripts", promptFile),
      join(packageRoot, "scripts", promptFile),
      2 * 1024 * 1024,
    );
  }
  copyBoundedRegularFile(
    join(repositoryRoot(), "package.json"),
    join(packageRoot, "package.json"),
    2 * 1024 * 1024,
  );
  assert.ok(existsSync(entry), "safe candidate staging retained the compiled extension entry");
  return { packageRoot, entry, nodePath: prerequisites.moduleSearchPath };
}

function removeOwnedTree(root: string): boolean {
  let complete = true;
  const removeEntry = (path: string): void => {
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("could not inspect a test-owned synthetic entry during bounded cleanup");
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const name of readdirSync(path)) removeEntry(join(path, name));
      try {
        rmdirSync(path);
      } catch {
        complete = false;
      }
    } else {
      try {
        unlinkSync(path);
      } catch {
        complete = false;
      }
    }
  };
  removeEntry(root);
  return complete;
}

function resolvePiExecutable(
  prerequisites: StaticPrerequisites,
  root: string,
  t: { skip(message?: string): void },
): ReturnType<typeof resolveNativePi> | undefined {
  const env = makeSyntheticEnvironment(root, prerequisites.moduleSearchPath);
  let resolved: ReturnType<typeof resolveNativePi>;
  try {
    resolved = resolveNativePi({ executable: prerequisites.piBinTarget, env });
  } catch {
    // Do not echo the CLI path, probe output, or any environment detail.
    skipOrFail(t, "the explicitly pinned Pi bin is not a supported stable Node CLI >=1.0.4 under the production resolver");
    return undefined;
  }
  assert.equal(resolved.version, prerequisites.expectedPiVersion, "the actual CLI version matches its explicit runtime pin");
  return resolved;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(`${description}: deadline exceeded`));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(new Error(`${description}: operation failed`));
      },
    );
  });
}

class ChangeSignal {
  private readonly listeners = new Set<() => void>();

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(check);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const check = (): void => {
        if (settled) return;
        try {
          if (predicate()) finish();
        } catch {
          finish(new Error(`${description}: the bounded event predicate failed`));
        }
      };
      const timer = setTimeout(() => finish(new Error(`${description}: deadline exceeded`)), timeoutMs);
      this.listeners.add(check);
      check();
    });
  }
}

class StatusJournal {
  readonly entries: SessionHostStatus[] = [];
  readonly signal = new ChangeSignal();

  push(status: SessionHostStatus): void {
    this.entries.push(status);
    this.signal.notify();
  }

  async waitFor(
    predicate: (status: SessionHostStatus) => boolean,
    timeoutMs: number,
    description: string,
    afterIndex = -1,
  ): Promise<SessionHostStatus> {
    let found: SessionHostStatus | undefined;
    await this.signal.waitFor(() => {
      found = this.entries.find((entry, index) => index > afterIndex && predicate(entry));
      return found !== undefined;
    }, timeoutMs, description);
    return found!;
  }
}

class FrameWatch {
  readonly signal = new ChangeSignal();
  revision = 0;
  text = "";

  constructor(
    private readonly getFrame: () => SurfaceFrame,
    private readonly stripSgr: (line: string) => string,
  ) {
    this.refresh();
  }

  refresh(): void {
    const frame = this.getFrame();
    this.text = frame.lines.map((line) => this.stripSgr(line)).join("\n");
    this.revision += 1;
    this.signal.notify();
  }

  /** Resolves with the exact fresh frame text that satisfied the predicate. */
  async waitFor(
    predicate: (text: string) => boolean,
    timeoutMs: number,
    description: string,
    afterRevision = this.revision,
  ): Promise<string> {
    let matched = "";
    await this.signal.waitFor(() => {
      if (this.revision <= afterRevision || !predicate(this.text)) return false;
      matched = this.text;
      return true;
    }, timeoutMs, description);
    return matched;
  }
}

function waitForOwnerExit(owner: QuestionOwner, timeoutMs: number): Promise<void> {
  if (owner.exit) return Promise.resolve();
  return owner.exitSignal.waitFor(() => owner.exit !== undefined, timeoutMs, "owned native Pi PTY exit");
}

function processIsAlive(pidText: number | string): boolean {
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

async function stopOwnedPty(owner: QuestionOwner): Promise<void> {
  if (!owner.pty || owner.exit) return;
  try { owner.pty.kill("SIGTERM"); } catch { /* only this test-owned PTY handle is addressed */ }
  try {
    await waitForOwnerExit(owner, 5_000);
  } catch {
    try { owner.pty.kill("SIGKILL"); } catch { /* bounded escalation to the same owned PTY handle */ }
    await waitForOwnerExit(owner, 5_000);
  }
}

function journalRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function countRecords(path: string, type: string): number {
  return journalRecords(path).filter((record) => record.type === type).length;
}

/**
 * Wrap-tolerant frame matching: the native TUI word-wraps long lines, so a
 * transcript phrase may span multiple rendered lines. Collapsing all
 * whitespace on both sides makes the match width-independent.
 */
function frameContains(frame: string, needle: string): boolean {
  const collapse = (text: string): string => text.replace(/\s+/g, "");
  return collapse(frame).includes(collapse(needle));
}

const QUESTION_POPUP_RULE = "─".repeat(QUESTION_POPUP_COLUMNS);
const QUESTION_POPUP_BLANK_ROW = " ".repeat(QUESTION_POPUP_COLUMNS);

/**
 * Return only the padded interior between the popup's actual full-width top
 * and bottom rules, with exactly one side-padding cell removed per side. The
 * frame is located by geometry: a full-width rule, a blank vertical-padding
 * row, content rows that each keep a padding cell on both sides, a blank
 * vertical-padding row, and a matching rule. A padded content row can never
 * equal the full-width rule, so body rules and box glyphs stay content.
 * Missing or malformed frames fail closed; maximum-height geometry is never
 * used as a substitute for the visible popup bounds.
 */
function nativeQuestionPopupLines(frame: string): string[] {
  return locateNativeQuestionPopup(frame)?.lines ?? [];
}

/**
 * The located popup frame: terminal rows of its top and bottom rules plus the
 * padded interior (one side-padding cell removed per side). The vertical
 * inset is checked against the frame's actual terminal row count, so a
 * resized owned PTY is matched by its live geometry.
 */
function locateNativeQuestionPopup(frame: string): { top: number; bottom: number; lines: string[] } | undefined {
  const terminalLines = frame.split("\n").map((line) =>
    line.slice(QUESTION_POPUP_START_COLUMN, QUESTION_POPUP_START_COLUMN + QUESTION_POPUP_COLUMNS));
  const terminalRows = terminalLines.length;
  const maxRows = Math.max(1, terminalRows - 2 * QUESTION_POPUP_VERTICAL_MARGIN);
  for (let top = QUESTION_POPUP_VERTICAL_MARGIN; top < terminalLines.length; top += 1) {
    if (terminalLines[top] !== QUESTION_POPUP_RULE || terminalLines[top + 1] !== QUESTION_POPUP_BLANK_ROW) continue;
    const bottom = terminalLines.findIndex((line, index) => index > top && line === QUESTION_POPUP_RULE);
    if (bottom <= top || bottom - top + 1 > maxRows
      || bottom >= terminalRows - QUESTION_POPUP_VERTICAL_MARGIN) continue;
    const contentRows = terminalLines.slice(top + 1, bottom);
    if (contentRows.length < 3 || contentRows.at(-1) !== QUESTION_POPUP_BLANK_ROW
      || !contentRows.every((line) => line.startsWith(" ") && line.endsWith(" "))) continue;
    return { top, bottom, lines: contentRows.map((line) => line.slice(1, -1)) };
  }
  return undefined;
}

function popupContains(frame: string, needle: string): boolean {
  return frameContains(nativeQuestionPopupLines(frame).join("\n"), needle);
}

/** Require the complete Markdown body between the popup's standalone ID and first answer choice. */
function questionBodyBetweenHeaderAndFirstChoice(frame: string): boolean {
  const popupLines = nativeQuestionPopupLines(frame);
  const questionHeader = popupLines.findIndex((line) => line.trim() === "q1:");
  if (questionHeader < 0) return false;
  const firstChoice = popupLines.findIndex((line, index) =>
    index > questionHeader && line.includes(`1. ${CHOICE_A}`));
  if (firstChoice <= questionHeader) return false;
  const body = popupLines.slice(questionHeader + 1, firstChoice).join("\n");
  return frameContains(body, QUESTION_TEXT);
}

test("question popup matcher excludes transcript text outside the modal geometry", () => {
  const lines = Array.from({ length: PTY_ROWS }, () => " ".repeat(PTY_COLS));
  lines[0] = `Question registered as q1: \"${QUESTION_TEXT}\"`.padEnd(PTY_COLS);
  const popupRow = (text: string): string => ` ${text}`.padEnd(PTY_COLS, " ");
  const rule = "─".repeat(PTY_COLS);
  lines[QUESTION_POPUP_START_ROW] = rule;
  lines[QUESTION_POPUP_START_ROW + 1] = popupRow("");
  lines[QUESTION_POPUP_START_ROW + 2] = popupRow("q1:");
  lines[QUESTION_POPUP_START_ROW + 3] = popupRow(`> 1. ${CHOICE_A}`);
  lines[QUESTION_POPUP_START_ROW + 4] = popupRow("");
  lines[QUESTION_POPUP_START_ROW + 5] = rule;
  const frame = lines.join("\n");
  const popupLines = nativeQuestionPopupLines(frame);

  assert.ok(frameContains(frame, QUESTION_TEXT), "the synthetic underlying tool result contains the complete question text");
  assert.equal(popupLines.length, 4, "the projection is exactly the padded interior between the two full-width rules");
  assert.ok(popupLines.every((line) => line.length === PTY_COLS - 2),
    "each projected question-popup row spans the conversation viewport minus one padding cell per side");
  assert.ok(popupLines.some((line) => line.trim() === "q1:"), "the bodyless popup has its standalone question ID");
  assert.ok(popupLines.some((line) => line.includes(`1. ${CHOICE_A}`)), "the bodyless popup has its first choice");
  assert.equal(
    questionBodyBetweenHeaderAndFirstChoice(frame),
    false,
    "transcript-only question text cannot fill the body between popup anchors",
  );
});

test("short question popup matcher rejects answer/body sentinels above and below its actual rules", () => {
  const lines = Array.from({ length: PTY_ROWS }, () => " ".repeat(PTY_COLS));
  const top = 20;
  const insideAnswer = "ANSWER_SENTINEL_INSIDE_POPUP";
  const aboveAnswer = "UNDERLAY_ANSWER_SENTINEL_ABOVE_RULE";
  const belowBody = "UNDERLAY_BODY_SENTINEL_BELOW_RULE";
  const rule = "─".repeat(PTY_COLS);
  const content = (text: string): string => ` ${text}`.padEnd(PTY_COLS, " ");

  lines[4] = `Transcript row contains ${aboveAnswer}`.padEnd(PTY_COLS);
  lines[6] = rule; // A transcript-wide rule without popup padding is not the frame.
  lines[7] = `Transcript after rule ${aboveAnswer}`.padEnd(PTY_COLS);
  lines[top] = rule;
  lines[top + 1] = content("");
  lines[top + 2] = content(`q1: ${QUESTION_TEXT}`);
  lines[top + 3] = content("─".repeat(PTY_COLS - 2)); // body rule inside the padding
  lines[top + 4] = content(`│ ${insideAnswer} │`); // body table/code glyphs stay content
  lines[top + 5] = content("");
  lines[top + 6] = rule;
  lines[44] = `Underlying chat contains ${belowBody}`.padEnd(PTY_COLS);
  const frame = lines.join("\n");
  const popupLines = nativeQuestionPopupLines(frame);

  assert.ok(QUESTION_POPUP_START_ROW < 4 && 44 < QUESTION_POPUP_START_ROW + QUESTION_POPUP_MAX_ROWS,
    "both underlay sentinels lie inside the old maximum-height crop");
  assert.ok(frameContains(frame, aboveAnswer) && frameContains(frame, belowBody),
    "the sentinels are genuinely present in underlying terminal rows");
  assert.ok(popupLines.some((line) => line.includes(`│ ${insideAnswer} │`)),
    "complete content, including body box glyphs, inside the actual ruled popup remains matchable");
  assert.ok(popupLines.some((line) => line === "─".repeat(PTY_COLS - 2)),
    "a body horizontal rule inside the padding is content, not the popup frame");
  assert.equal(popupContains(frame, aboveAnswer), false,
    "answer-like text above the actual popup rule cannot satisfy a popup assertion");
  assert.equal(popupContains(frame, belowBody), false,
    "body-like text below the actual popup rule cannot satisfy a popup assertion");
});

/** Event-driven directory watch that notifies when the named file changes. */
function watchOwnedFile(directory: string, fileName: string, signal: DurableChangeSignal): () => void {
  const watcher = fsWatch(directory, (_event, filename) => {
    if (filename === null || filename.toString() === fileName) signal.notify();
  });
  return () => watcher.close();
}

function observerExtensionSource(): string {
  return String.raw`'use strict';
const fs = require('node:fs');
const destination = process.env.PRG_NATIVE_QUESTION_OBSERVER_FILE;
const append = (record) => fs.appendFileSync(destination, JSON.stringify(record) + '\n', 'utf8');
module.exports = (pi) => {
  pi.on('session_start', (_event, ctx) => {
    let activeTools = [];
    try { activeTools = pi.getActiveTools(); } catch { activeTools = undefined; }
    let allToolNames = [];
    try { allToolNames = pi.getAllTools().map((tool) => tool.name); } catch { allToolNames = undefined; }
    append({ type: 'session_start', mode: ctx && ctx.mode, activeTools, allToolNames });
  });
  pi.on('agent_start', () => append({ type: 'agent_start' }));
  pi.on('agent_settled', () => append({ type: 'agent_settled' }));
  pi.on('tool_execution_start', (event) => append({
    type: 'tool_execution_start',
    toolName: event && event.toolName,
    toolCallId: event && event.toolCallId,
  }));
  pi.on('tool_execution_end', (event) => append({
    type: 'tool_execution_end',
    toolName: event && event.toolName,
    toolCallId: event && event.toolCallId,
    isError: Boolean(event && event.isError),
  }));
  pi.on('session_shutdown', () => append({ type: 'session_shutdown' }));
};
module.exports.default = module.exports;
`;
}

async function createQuestionOwner(
  ptyModule: NativePtyModule,
  surfaceModule: TerminalSurfaceModule,
  onSpawned: (owner: QuestionOwner) => void,
  options: {
    id: string;
    observerFile: string;
    providerJournalFile: string;
    descriptor: ReturnType<typeof prepareNativeLaunch>;
    registration: StatusRegistration;
    statuses: StatusJournal;
  },
): Promise<QuestionOwner> {
  const replies: string[] = [];
  const replySignal = new ChangeSignal();
  const owner = {
    id: options.id,
    observerFile: options.observerFile,
    providerJournalFile: options.providerJournalFile,
    registration: options.registration,
    statuses: options.statuses,
    descriptor: options.descriptor,
    replies,
    replySignal,
    exitSignal: new ChangeSignal(),
    parseFailed: false,
    pty: undefined,
    exit: undefined,
    dataSubscription: undefined,
    exitSubscription: undefined,
    surface: undefined,
    frames: undefined,
  } as unknown as QuestionOwner;

  let pty: NativePtyHandle | undefined;
  const surface = new surfaceModule.TerminalSurface(PTY_COLS, PTY_ROWS, {
    onReply: (data) => {
      replies.push(data);
      replySignal.notify();
      try { pty?.write(data); } catch { /* the owning PTY may already have exited */ }
    },
    onChange: () => owner.frames?.refresh(),
  });
  owner.surface = surface;
  owner.frames = new FrameWatch(() => surface.frame(), surfaceModule.stripGeneratedSgr);

  const childEnv = { ...options.descriptor.env };
  childEnv[HOST_BOOTSTRAP_ENV] = JSON.stringify(options.registration.bootstrap);
  try {
    pty = ptyModule.spawn(options.descriptor.file, [...options.descriptor.args], {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: options.descriptor.cwd,
      env: childEnv,
      encoding: "utf8",
    });
  } catch {
    surface.dispose();
    throw new Error("the actual pinned native Pi CLI did not spawn in its owned PTY");
  }
  owner.pty = pty;
  owner.exitSubscription = pty.onExit((event) => {
    owner.exit = event;
    owner.exitSignal.notify();
  });
  onSpawned(owner);
  owner.dataSubscription = pty.onData((data) => {
    try {
      surface.write(data);
    } catch {
      owner.parseFailed = true;
    }
  });
  return owner;
}

function makeArgs(observerFile: string, providerFixture: string): string[] {
  return [
    "--offline",
    "--no-context-files",
    "--no-skills",
    "--no-themes",
    "--extension",
    observerFile,
    "--extension",
    providerFixture,
  ];
}

async function disposeQuestionResources(options: {
  root: string;
  owner?: QuestionOwner;
  registration?: StatusRegistration;
  profile?: PreparedProfile;
  broker?: StatusBroker;
}): Promise<void> {
  let cleanupError: undefined | Error = undefined;
  let allProcessesExited = true;
  if (options.owner) {
    try { await stopOwnedPty(options.owner); } catch {
      cleanupError ??= new Error("the owned native Pi PTY could not be confirmed exited");
      allProcessesExited = false;
    }
    if (options.owner.pty && (!options.owner.exit || processIsAlive(options.owner.pty.pid))) allProcessesExited = false;
    try { options.owner.dataSubscription?.dispose(); } catch { cleanupError ??= new Error("an owned PTY output subscription could not be disposed"); }
    try { options.owner.exitSubscription?.dispose(); } catch { cleanupError ??= new Error("an owned PTY exit subscription could not be disposed"); }
    try { options.owner.surface.dispose(); } catch { cleanupError ??= new Error("an owned TerminalSurface could not be disposed"); }
  }
  if (options.registration) {
    try { options.registration.release(); } catch { cleanupError ??= new Error("an owned broker registration could not be released"); }
  }
  let brokerClosed = !options.broker;
  if (options.broker) {
    const socketPath = options.broker.socketPath;
    const transportDir = dirname(socketPath);
    try {
      await withDeadline(options.broker.dispose(), 5_000, "production status broker disposal");
      brokerClosed = !existsSync(socketPath) && !existsSync(transportDir);
      if (!brokerClosed) cleanupError ??= new Error("the production status broker did not close its owned socket resources");
    } catch {
      cleanupError ??= new Error("the production status broker did not finish bounded disposal");
    }
  }
  if (options.profile) {
    try { options.profile.release(); } catch { cleanupError ??= new Error("a synthetic profile admission could not be released"); }
  }
  if (allProcessesExited && brokerClosed) {
    const removed = removeOwnedTree(options.root);
    if (!removed) cleanupError ??= new Error("the synthetic root could not be fully removed by bounded cleanup");
  } else {
    cleanupError ??= new Error("the synthetic root was preserved because an owned process or broker resource remains live");
  }
  if (cleanupError) throw cleanupError;
}

test("native Pi TUI accepts an exact bracketed image-path answer in its first frame and restores the chat draft", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const prerequisites = staticPrerequisites(t);
  if (!prerequisites) return;

  // Native binding and headless parser are loaded only after platform, pinned Pi,
  // compiled candidate, Node-floor, and optional-module prerequisites are established.
  let ptyModule: NativePtyModule;
  let surfaceModule: TerminalSurfaceModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    ptyModule = require("@lydell/node-pty") as NativePtyModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    surfaceModule = require("../src/session-host/terminal-surface") as TerminalSurfaceModule;
  } catch {
    skipOrFail(t, "the pinned real native PTY binding or production TerminalSurface could not be loaded");
    return;
  }

  const root = makeSyntheticRoot();
  let owner: QuestionOwner | undefined;
  let profile: PreparedProfile | undefined;
  let registration: StatusRegistration | undefined;
  let broker: StatusBroker | undefined;
  t.after(async () => disposeQuestionResources({ root, owner, profile, registration, broker }));

  initializeSyntheticDirectories(root);
  const imageDirectory = join(root, "clipboard images");
  mkdirSync(imageDirectory, { recursive: true, mode: 0o700 });
  const imagePath = join(imageDirectory, `clipboard-${"image-".repeat(4)}owned.png`);
  writeFileSync(imagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ), { mode: 0o600 });
  assert.ok(existsSync(imagePath), "the exact bracketed-paste path is an owned image file in the synthetic root");
  const pastedAnswer = [
    imagePath,
    "OCR: preserve the complete clipboard path on the first frame.",
    "Long detail: This multiline answer retains the complete tail in the popup.",
    "tail: no follow-up key",
  ].join("\n");
  const expectedDeliveredAnswer = `Answer to pending question "${QUESTION_TEXT}": ${pastedAnswer}`;
  assert.ok(expectedDeliveredAnswer.length < 400, "the complete answer fits the faux provider's exact request preview");
  assertBrokerSocketPathBudget(root);
  const pi = resolvePiExecutable(prerequisites, root, t);
  if (!pi) return;
  const candidate = stageCandidate(root, prerequisites);
  const registry = new ProfileRegistry({ stateRoot: join(root, "profile-state") });
  profile = registry.prepare({ workspace: createWorkspace(root, "question-workspace") });

  // Zero-model gate config with deferred tools DISABLED (the real-host
  // fixture convention): AskUserQuestion is then launch-active exactly like
  // the production sessions in which the question UI is used, instead of a
  // tool_search discovery target. The question UI/lifecycle under test does
  // not depend on deferred-tool management.
  writeFileSync(
    join(profile.agentDir, "review-gate.json"),
    JSON.stringify({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {},
      execution: { deferredPiTools: false, workerResources: {}, routes: { execute: [], research: [] } },
    }, undefined, 2),
    { mode: 0o600 },
  );

  const observerDir = join(root, "observer");
  const observerFile = join(observerDir, "question.jsonl");
  const observerExtension = join(observerDir, "question-observer.cjs");
  writeFileSync(observerExtension, observerExtensionSource(), { mode: 0o600 });

  // --- Scripted turn sequence for the faux provider (test-only fixture) ---
  const stateDir = join(root, "fixture-state");
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

  const descriptor = prepareNativeLaunch({
    packageRoot: candidate.packageRoot,
    agentDir: profile.agentDir,
    workspace: profile.workspace,
    piExecutable: pi.file,
    args: makeArgs(observerExtension, providerFixturePath()),
    env: {
      ...makeSyntheticEnvironment(root, candidate.nodePath),
      PRG_FIXTURE_AGENT_DIR: prerequisites.installedAgentDir,
      PRG_FIXTURE_STATE_DIR: stateDir,
      PRG_NATIVE_QUESTION_OBSERVER_FILE: observerFile,
    },
  });
  assert.equal(descriptor.env.PI_CODING_AGENT_DIR, profile.agentDir, "the fresh native chat is stored under its private synthetic profile");
  const forbiddenStartupFlags = new Set([
    "--session",
    "--session-id",
    "--sessionID",
    "--session-dir",
    "--no-session",
    "--continue",
    "--resume",
    "--fork",
  ]);
  assert.ok(!descriptor.args.some((arg) => forbiddenStartupFlags.has(arg)), "native Pi starts a fresh profile-owned session without startup override arguments");

  broker = await createStatusBroker({ socketRoot: join(root, "broker") });
  const id = randomUUID();
  const statuses = new StatusJournal();
  registration = broker.register(id, {
    onStatus: (status) => statuses.push(status),
    onDisconnect: () => undefined,
  });

  const liveOwner = await createQuestionOwner(ptyModule, surfaceModule, (spawned) => { owner = spawned; }, {
    id,
    observerFile,
    providerJournalFile,
    descriptor,
    registration,
    statuses,
  });
  owner = liveOwner;

  // --- Event-driven journal watches (fs.watch on the owned directories) ---
  // Each journal is a durable file re-read by the predicates below and the
  // watcher notification is its only live trigger, so these two dedicated
  // signals use the shared durable recheck.
  const observerSignal = new DurableChangeSignal();
  const providerSignal = new DurableChangeSignal();
  const closeObserverWatch = watchOwnedFile(observerDir, "question.jsonl", observerSignal);
  const closeProviderWatch = watchOwnedFile(stateDir, "provider-journal.jsonl", providerSignal);

  try {
    // --- Session start: real TUI, real gate, AskUserQuestion launch-active ---
    const initial = await statuses.waitFor((status) => status.type === "status", EVENT_TIMEOUT_MS, "authenticated native status");
    assert.equal(initial.busy, false, "session-start readiness is established by the real native ctx.isIdle probe");
    assert.deepEqual(initial.activity, ["Ready"], "the reporter's actual idle probe yields Ready");
    assert.equal(initial.instanceId, id, "the authentic status belongs to this registration");
    assert.equal(initial.generation, broker.generation);

    await liveOwner.replySignal.waitFor(() => liveOwner.replies.length > 0, EVENT_TIMEOUT_MS, "native Pi terminal query reply to its owning PTY");
    await liveOwner.frames.signal.waitFor(() => liveOwner.frames.revision > 1, EVENT_TIMEOUT_MS, "native Pi output parsed into its owning TerminalSurface");
    assert.equal(liveOwner.parseFailed, false, "the production TerminalSurface accepted native Pi output");

    await observerSignal.waitForRecheck(
      () => countRecords(observerFile, "session_start") > 0,
      EVENT_TIMEOUT_MS,
      "native session_start observation",
    );
    const sessionStart = journalRecords(observerFile).find((record) => record.type === "session_start");
    assert.ok(sessionStart, "the real native hook context was observed");
    assert.equal(sessionStart.mode, "tui", "the reporter and probe observe an actual native TUI session");
    const activeTools = sessionStart.activeTools as string[] | undefined;
    assert.ok(Array.isArray(activeTools), "the native session exposes its active tool inventory");
    assert.ok(activeTools!.includes("AskUserQuestion"), "AskUserQuestion is launch-active in the real gate session");

    // The scripted model must be selected before any prompt is submitted.
    await providerSignal.waitForRecheck(
      () => journalRecords(providerJournalFile).some((record) => record.event === "auto_model_selected"),
      EVENT_TIMEOUT_MS,
      "scripted faux model auto-selection",
    );

    // --- Initial prompt: scripted AskUserQuestion tool call ---
    const beforePrompt = liveOwner.frames.revision;
    liveOwner.pty!.write(INITIAL_PROMPT);
    await liveOwner.frames.waitFor((frame) => frameContains(frame, INITIAL_PROMPT), EVENT_TIMEOUT_MS, "initial prompt visible as an editor draft", beforePrompt);
    liveOwner.pty!.write(KEY_ENTER);

    // The first run: agent_start → AskUserQuestion executes → pending result → settled.
    await observerSignal.waitForRecheck(
      () => countRecords(observerFile, "agent_start") >= 1,
      EVENT_TIMEOUT_MS,
      "first native agent run start",
    );
    await observerSignal.waitForRecheck(
      () => journalRecords(observerFile).some((record) => record.type === "tool_execution_start" && record.toolName === "AskUserQuestion"),
      EVENT_TIMEOUT_MS,
      "real AskUserQuestion tool execution start",
    );
    await observerSignal.waitForRecheck(
      () => journalRecords(observerFile).some((record) => record.type === "tool_execution_end" && record.toolName === "AskUserQuestion" && record.isError === false),
      EVENT_TIMEOUT_MS,
      "real AskUserQuestion tool execution end without error",
    );
    await observerSignal.waitForRecheck(
      () => countRecords(observerFile, "agent_settled") >= 1,
      EVENT_TIMEOUT_MS,
      "first native agent run settled",
    );

    // The reporter observed the busy window and the pending-question panel.
    const busyStatus = await statuses.waitFor((status) => status.busy === true, EVENT_TIMEOUT_MS, "reporter observed the first run as busy");
    assert.equal(busyStatus.instanceId, id, "the busy status belongs to this registration");
    await statuses.waitFor(
      (status) => status.pendingInput === true && status.busy === false,
      EVENT_TIMEOUT_MS,
      "reporter observed the real pending-question panel widget after the first run settled",
    );

    // The collapsed panel line is visible in the real native frame.
    // The panel renders during the first run, so scope this wait from before
    // the prompt was submitted: an idle TUI emits no new frames after it.
    const panelLine = process.platform === "darwin" ? "Pending input · Press Ctrl+Option+Up" : "Pending input · Press Ctrl+Alt+Up";
    await liveOwner.frames.waitFor((frame) => frameContains(frame, panelLine), EVENT_TIMEOUT_MS, "real pending-question panel line in the native frame", beforePrompt);

    // Preserve a multiline unsent chat draft through the pending-input overlay.
    const beforeDraft = liveOwner.frames.revision;
    liveOwner.pty!.write(`${CHAT_DRAFT_FIRST}${KEY_SHIFT_ENTER}${CHAT_DRAFT_SECOND}`);
    await liveOwner.frames.waitFor(
      (frame) => frameContains(frame, CHAT_DRAFT),
      EVENT_TIMEOUT_MS,
      "the exact multiline unsent chat draft is visible before opening the popup",
      beforeDraft,
    );

    // --- Open the real pending-question list (Ctrl+Alt+Up) ---
    const beforeList = liveOwner.frames.revision;
    liveOwner.pty!.write(KEY_CTRL_ALT_UP);
    await liveOwner.frames.waitFor(
      (frame) => popupContains(frame, "Pending input (1)")
        && popupContains(frame, `q1: ${QUESTION_TEXT}`)
        && popupContains(frame, "arrows select · Enter answer · Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll · Esc defer and close"),
      EVENT_TIMEOUT_MS,
      "real pending-question list opens with the scripted question",
      beforeList,
    );
    assert.equal(popupContains(liveOwner.frames.text, INITIAL_PROMPT), false,
      "the full-width popup rows replace conversation text that would otherwise remain in side margins");

    // --- Enter answer mode (Enter on the selected question) ---
    const beforeAnswer = liveOwner.frames.revision;
    liveOwner.pty!.write(KEY_ENTER);
    await liveOwner.frames.waitFor(
      (frame) => questionBodyBetweenHeaderAndFirstChoice(frame)
        && frameContains(frame, "q1:")
        && frameContains(frame, QUESTION_TEXT)
        && frameContains(frame, `1. ${CHOICE_A}`)
        && frameContains(frame, `2. ${CHOICE_B}`)
        && frameContains(frame, "Type something…")
        && popupContains(frame, "Decline (no answer will be sent)")
        && popupContains(frame, "arrows select · Enter confirm · Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll · Esc back"),
      EVENT_TIMEOUT_MS,
      "real answer mode shows the scripted choices plus free text and decline",
      beforeAnswer,
    );

    // --- Enter free text, then verify one exact bracketed paste in the first changed frame ---
    const beforeEdit = liveOwner.frames.revision;
    liveOwner.pty!.write(KEY_DOWN + KEY_DOWN + KEY_ENTER);
    await liveOwner.frames.waitFor(
      (frame) => popupContains(frame, "Enter submit · Esc back to options"),
      EVENT_TIMEOUT_MS,
      "the real native editor owns the free-text answer row before paste",
      beforeEdit,
    );
    const beforePasteRevision = liveOwner.frames.revision;
    const beforePasteText = liveOwner.frames.text;
    liveOwner.pty!.write(`\x1b[200~${pastedAnswer}\x1b[201~`);
    await liveOwner.frames.signal.waitFor(
      () => liveOwner.frames.revision > beforePasteRevision && liveOwner.frames.text !== beforePasteText,
      EVENT_TIMEOUT_MS,
      "the first changed native terminal frame after bracketed image-path paste",
    );
    const firstPasteFrame = liveOwner.frames.text;
    assert.ok(popupContains(firstPasteFrame, pastedAnswer),
      `the complete multiline paste, including the .png suffix, appears in the first changed frame without another keypress: ${nativeQuestionPopupLines(firstPasteFrame).join("\n")}`);
    assert.ok(popupContains(firstPasteFrame, imagePath) && popupContains(firstPasteFrame, ".png"),
      "the exact owned image path and final .png are visible before submission");

    const beforeSubmit = liveOwner.frames.revision;
    // The reporter also observes the session_start panel clear, so the
    // post-answer clearance must be proven strictly after this history point.
    const statusIndexBeforeAnswer = statuses.entries.length - 1;
    // The shared native modal may occlude the underlying panel. Check the
    // latest authenticated reporter snapshot instead of requiring old inline
    // widget placement to remain visible over it; unchanged snapshots are
    // intentionally deduplicated, so no fresh event is required.
    const modalStatus = statuses.entries.at(-1);
    assert.ok(modalStatus, "the owning reporter has an authenticated status at the modal-open checkpoint");
    assert.equal(modalStatus.type, "status");
    assert.equal(modalStatus.pendingInput, true, "the latest status retains pending input while the answer modal is open");
    assert.equal(modalStatus.busy, false, "the latest status retains the actually idle owner while the answer modal is open");
    assert.equal(modalStatus.instanceId, id, "the latest pending status belongs to this native session");
    assert.equal(modalStatus.generation, broker.generation, "the latest pending status carries the live broker generation");
    liveOwner.pty!.write(KEY_ENTER);

    // The delivered answer arrives as an ordinary user message and starts a
    // normal next turn whose model context contains the answer.
    await observerSignal.waitForRecheck(
      () => countRecords(observerFile, "agent_start") >= 2,
      EVENT_TIMEOUT_MS,
      "second native agent run start from the UI-delivered answer",
    );
    await observerSignal.waitForRecheck(
      () => countRecords(observerFile, "agent_settled") >= 2,
      EVENT_TIMEOUT_MS,
      "second native agent run settled",
    );

    // The reporter observed the answer turn as busy (its agent_start emit),
    // then settled back to idle — both strictly after the pre-answer history,
    // never the startup statuses.
    const answerBusyStatus = await statuses.waitFor(
      (status) => status.busy === true,
      EVENT_TIMEOUT_MS,
      "reporter observed the answer turn as busy",
      statusIndexBeforeAnswer,
    );
    assert.equal(answerBusyStatus.instanceId, id, "the answer-turn busy status belongs to this registration");
    await statuses.waitFor(
      (status) => status.busy === false,
      EVENT_TIMEOUT_MS,
      "reporter observed the answer turn settle to idle",
      statuses.entries.indexOf(answerBusyStatus),
    );

    // Native UI clearance is independent evidence from sidebar status.
    // Require a fresh frame, then separately require a fresh authenticated
    // pending-input clear. A removed native panel must not leave a stale
    // pending badge merely because a shortcut supplied another UI context.
    await liveOwner.frames.waitFor(
      (frame) => !frameContains(frame, panelLine),
      EVENT_TIMEOUT_MS,
      "pending-question panel cleared from the real native frame after the answer",
      beforeSubmit,
    );

    // The transcript shows the delivered answer and the faux echo of it.
    await liveOwner.frames.waitFor(
      (frame) => frameContains(frame, expectedDeliveredAnswer)
        && frameContains(frame, `${ECHO_PREFIX}${expectedDeliveredAnswer}`),
      EVENT_TIMEOUT_MS,
      "delivered answer and its echo are visible in the real native transcript",
      beforeSubmit,
    );
    assert.ok(frameContains(liveOwner.frames.text, CHAT_DRAFT),
      "the exact suspended multiline chat draft is restored after the popup submits");

    // Require the answer turn's settled status to carry observed clearance,
    // strictly after its busy status. Neither startup history, UI text, nor
    // an idle probe alone is evidence that pending input was cleared.
    await statuses.waitFor(
      (status) => status.pendingInput === false && status.busy === false,
      EVENT_TIMEOUT_MS,
      "reporter observed fresh pending-input clearance after the answer turn",
      statuses.entries.indexOf(answerBusyStatus),
    );

    // --- Orderly host exit: documented Ctrl+C-twice path ---
    liveOwner.pty!.write(KEY_CTRL_C + KEY_CTRL_C);
    await waitForOwnerExit(liveOwner, CHILD_EXIT_TIMEOUT_MS);
    const exitEvent = liveOwner.exit as NativePtyExit | undefined;
    assert.ok(exitEvent, "the owned native Pi PTY delivered a bounded exit event");
    assert.equal(exitEvent.exitCode, 0, "native Pi exits successfully through the documented Ctrl+C-twice host exit");
    assert.equal(exitEvent.signal ?? 0, 0, "native Pi exits normally without signal termination or escalation");
    assert.equal(processIsAlive(liveOwner.pty!.pid), false, "the owned native Pi child PID is no longer alive");

    // The genuine shutdown lifecycle ran in the real extension runtime.
    await observerSignal.waitForRecheck(
      () => countRecords(observerFile, "session_shutdown") > 0,
      EVENT_TIMEOUT_MS,
      "genuine native session_shutdown observation",
    );

    // --- Faux provider journal: three scripted requests, answer reached the model ---
    const providerJournal = journalRecords(providerJournalFile);
    const requests = providerJournal.filter((record) => record.event === "model_request");
    assert.equal(requests.length, 3, "exactly three scripted faux model requests (no external AI/API calls)");
    const answerRequest = requests[2] as Record<string, unknown> | undefined;
    assert.ok(answerRequest, "the third request exists for the delivered answer");
    assert.equal(answerRequest.lastUserPreview, expectedDeliveredAnswer,
      "the exact canonical multiline answer reached the model context as an ordinary user message");

    // Every status carried this owner's identity and generation.
    assert.ok(statuses.entries.length > 0, "the real reporter delivered at least one authenticated status");
    for (const status of statuses.entries) {
      assert.equal(status.instanceId, id, "the broker delivered status only to its registered native owner");
      assert.equal(status.generation, broker.generation, "the authentic reporter status carries this broker generation");
    }
  } finally {
    closeObserverWatch();
    closeProviderWatch();
  }
});

function createWorkspace(root: string, name: string): string {
  const path = join(root, "workspaces", name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

// --- Fullscreen compact shared-popup keyboard scenario (#413) ---
//
// The same owned native Pi session shape as above, with Pi's alternate-screen
// fullscreen renderer pinned through the synthetic profile's own Pi
// settings.json (`tuiMode`). Every key below is written to the real PTY, so
// Pi's own stdin parser, overlay compositing, and focus dispatch decide where
// it goes — no synthetic ctx.ui or component callback is involved. Popup
// scrolling is keyboard-only (the popup never handles wheel input; its
// fullscreen item clicks are covered by user-question-mouse-host), so this
// scenario sends no mouse reports.

const KEY_UP = "\x1b[A";
const KEY_ESCAPE = "\x1b";
const KEY_SHIFT_ALT_UP = "\x1b[1;4A";
const KEY_SHIFT_ALT_DOWN = "\x1b[1;4B";
const POPUP_RESIZED_ROWS = 30;
const POPUP_SCROLL_HINT = "Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll";
const POPUP_LIST_HINT = `arrows select · Enter open question/notice · ${POPUP_SCROLL_HINT} · Esc defer and close`;
const POPUP_NOTICE_LIST_HINT = `arrows select · Enter open notice · ${POPUP_SCROLL_HINT} · Esc defer and close`;
const POPUP_NOTICE_HINT = `arrows select · Enter choose · ${POPUP_SCROLL_HINT} · Esc back`;
const POPUP_ANSWER_HINT = `arrows select · Enter confirm · ${POPUP_SCROLL_HINT} · Esc back`;
const POPUP_EDITING_HINT = "Enter submit · Esc back to options to scroll";
const POPUP_PROMPT = "Please register the fullscreen popup notices and question.";
const POPUP_NOTICE_TITLE = "Fullscreen popup notice";
const POPUP_NOTICE_HEADING = "Popup notice heading";
const POPUP_NOTICE_BULLET = "The heading and this bullet render through native Markdown.";
const POPUP_NOTICE_END = "POPUP_NOTICE_BODY_END_413";
const POPUP_NOTICE_CONTEXT = "POPUP_NOTICE_CONTEXT_413: the context scrolls together with the body.";
const POPUP_NOTICE_BODY = [
  `# ${POPUP_NOTICE_HEADING}`,
  "",
  `- ${POPUP_NOTICE_BULLET}`,
  "",
  ...Array.from({ length: 56 }, (_, index) =>
    `- Popup checkpoint ${String(index + 1).padStart(2, "0")}: the complete notice stays reachable.`),
  "",
  POPUP_NOTICE_END,
].join("\n");
const POPUP_SHORT_NOTICE_TITLE = "Short popup notice";
const POPUP_SHORT_NOTICE_BODY = "One short popup notice row.";
const POPUP_QUESTION_HEADING = "Popup question heading";
const POPUP_QUESTION_LAST_STEP = "Step 30.";
const POPUP_QUESTION_TEXT = [
  `# ${POPUP_QUESTION_HEADING}`,
  "",
  Array.from({ length: 30 }, (_, index) => `Step ${String(index + 1).padStart(2, "0")}.`).join("\n\n"),
].join("\n");
const POPUP_CHOICE_A = "Alpha lane";
const POPUP_CHOICE_B = "Beta lane";
const POPUP_DECLINE = "Decline (no answer will be sent)";
const POPUP_TRANSCRIPT_ROWS = 90;
const POPUP_TRANSCRIPT = Array.from({ length: POPUP_TRANSCRIPT_ROWS }, (_, index) =>
  `- Transcript filler row ${String(index + 1).padStart(2, "0")}`).join("\n");
/**
 * The real gate's own agent_end notice for this profile (enabled, no active
 * reviewer). It is the last transcript entry of the first run: Pi emits
 * agent_settled only after that handler sent it, but renders it in a later
 * frame, appending rows below the filler while the view follows the end.
 */
const POPUP_SETTLED_GATE_NOTICE = "review gate: automatic review deferred because no configured reviewer";
/** Pi's fullscreen indicator, drawn only while the primary view is scrolled away from its end. */
const POPUP_JUMP_TO_LATEST = "Jump to latest message";

interface FixedHintPopupView {
  /** Terminal rows of the located top and bottom rules. */
  top: number;
  bottom: number;
  /** Scrolled body rows between the top padding row and the hint separator. */
  body: string[];
  /** Terminal row of the fixed keyboard hint's first line. */
  hintRow: number;
}

/**
 * The located popup split into its scrolled body and its fixed hint area:
 * [top padding, ...body, blank separator, hint, bottom padding]. Undefined
 * unless that exact hint sits in the fixed area below the body.
 */
function fixedHintPopupView(frame: string, hint: string): FixedHintPopupView | undefined {
  const popup = locateNativeQuestionPopup(frame);
  if (!popup) return undefined;
  const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();
  // The hint may wrap over a few fixed rows; it ends above the bottom padding.
  for (let hintRows = 1; hintRows <= 3; hintRows += 1) {
    const hintIndex = popup.lines.length - 1 - hintRows;
    if (hintIndex < 2) break;
    if (collapse(popup.lines.slice(hintIndex, hintIndex + hintRows).join(" ")) !== hint) continue;
    if (popup.lines[hintIndex - 1]!.trim() !== "") continue;
    return { top: popup.top, bottom: popup.bottom, body: popup.lines.slice(1, hintIndex - 1), hintRow: popup.top + 1 + hintIndex };
  }
  return undefined;
}

/** Exact viewport movement: positive lines scrolled toward the end. */
function bodyShiftedBy(before: readonly string[], after: readonly string[], lines: number): boolean {
  const count = Math.abs(lines);
  if (count === 0 || before.length !== after.length || count >= before.length) return false;
  const kept = lines > 0 ? before.slice(count) : before.slice(0, before.length - count);
  const moved = lines > 0 ? after.slice(0, after.length - count) : after.slice(count);
  return kept.every((line, index) => line === moved[index]) && after.join("\n") !== before.join("\n");
}

/**
 * The compact popup leaves Pi's own native rows visible around it: some
 * non-blank row above its top rule and some below its bottom rule (the
 * pre-#413 appearance), never an opaque blank surface filling the viewport.
 */
function nativeRowsAroundFrame(frame: string, view: { top: number; bottom: number }): boolean {
  const rows = frame.split("\n");
  return rows.slice(0, view.top).some((row) => row.trim() !== "")
    && rows.slice(view.bottom + 1).some((row) => row.trim() !== "");
}

/** Natural compact height: rules, padding rows, body, separator, and a one-row hint. */
function naturalPopupHeight(view: FixedHintPopupView, bodyRows: number): boolean {
  return view.body.length === bodyRows && view.bottom - view.top + 1 === 2 + 2 + bodyRows + 1 + 1;
}

function transcriptFillerRows(frame: string): number[] {
  return [...frame.matchAll(/Transcript filler row (\d\d)/gu)].map((match) => Number(match[1]));
}

/**
 * Transcript scroll position: terminal row of a visible filler line minus its
 * number. Every visible filler line must agree. Undefined when no filler row
 * is visible.
 */
function transcriptOffset(frame: string): number | undefined {
  const offsets = new Set<number>();
  frame.split("\n").forEach((row, index) => {
    const match = /Transcript filler row (\d\d)/u.exec(row);
    if (match) offsets.add(index - Number(match[1]));
  });
  return offsets.size === 1 ? [...offsets][0] : undefined;
}

/**
 * The first run's transcript is completely rendered and Pi still follows its
 * end: the last filler row is visible, the gate's settled notice sits below
 * it, and no jump-to-latest indicator is drawn.
 */
function transcriptSettledAtEnd(frame: string): boolean {
  const rows = frame.split("\n");
  const lastFiller = rows.findIndex((row) => row.includes(`Transcript filler row ${POPUP_TRANSCRIPT_ROWS}`));
  return lastFiller >= 0 && transcriptOffset(frame) !== undefined
    && rows.some((row, index) => index > lastFiller && row.includes(POPUP_SETTLED_GATE_NOTICE))
    && !frameContains(frame, POPUP_JUMP_TO_LATEST);
}

function bodyContains(view: FixedHintPopupView | undefined, needle: string): boolean {
  return view !== undefined && frameContains(view.body.join("\n"), needle);
}

function selectedBodyRow(view: FixedHintPopupView | undefined, needle: string): boolean {
  return view !== undefined && view.body.some((line) => line.trimStart().startsWith("> ") && line.includes(needle));
}

test("native Pi fullscreen: the compact shared popup scrolls by keyboard over the live transcript through the real PTY, across resize, close, and reopen", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const prerequisites = staticPrerequisites(t);
  if (!prerequisites) return;
  let ptyModule: NativePtyModule;
  let surfaceModule: TerminalSurfaceModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    ptyModule = require("@lydell/node-pty") as NativePtyModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    surfaceModule = require("../src/session-host/terminal-surface") as TerminalSurfaceModule;
  } catch {
    skipOrFail(t, "the pinned real native PTY binding or production TerminalSurface could not be loaded");
    return;
  }

  const root = makeSyntheticRoot();
  let owner: QuestionOwner | undefined;
  let profile: PreparedProfile | undefined;
  let registration: StatusRegistration | undefined;
  let broker: StatusBroker | undefined;
  t.after(async () => disposeQuestionResources({ root, owner, profile, registration, broker }));

  initializeSyntheticDirectories(root);
  assertBrokerSocketPathBudget(root);
  // Delivered answers quote the question bounded to 200 characters (the
  // controller's existing DELIVERY_QUESTION_BOUND); the long question is cut.
  assert.ok(POPUP_QUESTION_TEXT.length > 200, "the long question exceeds the delivered-answer quote bound");
  const expectedAnswer = `Answer to pending question "${POPUP_QUESTION_TEXT.slice(0, 199)}…": ${POPUP_CHOICE_B}`;
  assert.ok(expectedAnswer.length < 400, "the complete delivered answer fits the faux provider's exact request preview");
  const pi = resolvePiExecutable(prerequisites, root, t);
  if (!pi) return;
  const candidate = stageCandidate(root, prerequisites);
  const registry = new ProfileRegistry({ stateRoot: join(root, "profile-state") });
  profile = registry.prepare({ workspace: createWorkspace(root, "popup-workspace") });
  writeFileSync(join(profile.agentDir, "review-gate.json"), JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {},
    execution: { deferredPiTools: false, workerResources: {}, routes: { execute: [], research: [] } },
  }, undefined, 2), { mode: 0o600 });
  // Pin Pi's own fullscreen renderer for this owned profile.
  writeFileSync(join(profile.agentDir, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }, undefined, 2), { mode: 0o600 });

  const observerDir = join(root, "observer");
  const observerFile = join(observerDir, "popup.jsonl");
  const observerExtension = join(observerDir, "popup-observer.cjs");
  writeFileSync(observerExtension, observerExtensionSource(), { mode: 0o600 });
  const stateDir = join(root, "fixture-state");
  const providerJournalFile = join(stateDir, "provider-journal.jsonl");
  writeFileSync(join(stateDir, "turn-script.json"), JSON.stringify({
    steps: [
      { toolCalls: [{
        toolName: "YouShouldKnow",
        arguments: { title: POPUP_NOTICE_TITLE, body: POPUP_NOTICE_BODY, context: POPUP_NOTICE_CONTEXT },
      }] },
      { toolCalls: [{
        toolName: "AskUserQuestion",
        arguments: { question: POPUP_QUESTION_TEXT, choices: [POPUP_CHOICE_A, POPUP_CHOICE_B], mode: "async" },
      }] },
      { toolCalls: [{
        toolName: "YouShouldKnow",
        arguments: { title: POPUP_SHORT_NOTICE_TITLE, body: POPUP_SHORT_NOTICE_BODY },
      }] },
      // A long reply fills the transcript underneath the popup.
      { text: POPUP_TRANSCRIPT },
      { echoLastUser: ECHO_PREFIX },
    ],
  }), { mode: 0o600 });

  const descriptor = prepareNativeLaunch({
    packageRoot: candidate.packageRoot,
    agentDir: profile.agentDir,
    workspace: profile.workspace,
    piExecutable: pi.file,
    args: makeArgs(observerExtension, providerFixturePath()),
    env: {
      ...makeSyntheticEnvironment(root, candidate.nodePath),
      PRG_FIXTURE_AGENT_DIR: prerequisites.installedAgentDir,
      PRG_FIXTURE_STATE_DIR: stateDir,
      PRG_NATIVE_QUESTION_OBSERVER_FILE: observerFile,
    },
  });
  assert.deepEqual(Object.keys(descriptor.env).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/iu.test(name)), [],
    "the synthetic native environment carries no external credentials");
  broker = await createStatusBroker({ socketRoot: join(root, "broker") });
  const id = randomUUID();
  const statuses = new StatusJournal();
  registration = broker.register(id, { onStatus: (status) => statuses.push(status), onDisconnect: () => undefined });
  const live = await createQuestionOwner(ptyModule, surfaceModule, (spawned) => { owner = spawned; }, {
    id,
    observerFile,
    providerJournalFile,
    descriptor,
    registration,
    statuses,
  });
  owner = live;

  const observerSignal = new DurableChangeSignal();
  const providerSignal = new DurableChangeSignal();
  const closeObserverWatch = watchOwnedFile(observerDir, "popup.jsonl", observerSignal);
  const closeProviderWatch = watchOwnedFile(stateDir, "provider-journal.jsonl", providerSignal);
  const modelRequests = (): number => journalRecords(providerJournalFile).filter((record) => record.event === "model_request").length;
  const agentStarts = (): number => countRecords(observerFile, "agent_start");

  /** Bounded diagnostics from the owned synthetic frame: fixture text only. */
  const frameDiagnostics = (description: string, error: unknown): Error => {
    const rows = live.frames.text.split("\n").map((line, index) => `${String(index).padStart(2, "0")}|${line.trimEnd()}`);
    return new Error(`${description}: no matching native frame (transcript rows ${transcriptFillerRows(live.frames.text).join(",")}).\n`
      + `Last native frame:\n${rows.join("\n")}`, { cause: error });
  };
  /** Write real PTY input (or resize) and wait for the first fresh frame satisfying the predicate. */
  const act = async (
    input: string | readonly string[] | (() => void),
    predicate: (frame: string) => boolean,
    description: string,
  ): Promise<string> => {
    const before = live.frames.revision;
    if (typeof input === "function") input();
    else for (const chunk of typeof input === "string" ? [input] : input) live.pty!.write(chunk);
    try {
      return await live.frames.waitFor(predicate, EVENT_TIMEOUT_MS, description, before);
    } catch (error) {
      throw frameDiagnostics(description, error);
    }
  };
  const repeat = (key: string, count: number): string[] => Array.from({ length: count }, () => key);

  try {
    await statuses.waitFor((status) => status.type === "status", EVENT_TIMEOUT_MS, "authenticated native status");
    await observerSignal.waitForRecheck(() => countRecords(observerFile, "session_start") > 0, EVENT_TIMEOUT_MS, "native session_start");
    const sessionStart = journalRecords(observerFile).find((record) => record.type === "session_start");
    assert.equal(sessionStart?.mode, "tui", "the scenario drives an actual interactive native TUI session");
    const activeTools = sessionStart?.activeTools as string[] | undefined;
    assert.ok(activeTools?.includes("AskUserQuestion") && activeTools.includes("YouShouldKnow"),
      "the real gate admits both shared-popup tools");
    await providerSignal.waitForRecheck(
      () => journalRecords(providerJournalFile).some((record) => record.event === "auto_model_selected"),
      EVENT_TIMEOUT_MS,
      "scripted faux model auto-selection",
    );

    const beforePrompt = live.frames.revision;
    live.pty!.write(POPUP_PROMPT);
    await live.frames.waitFor((frame) => frameContains(frame, POPUP_PROMPT), EVENT_TIMEOUT_MS, "prompt visible as an editor draft", beforePrompt);
    live.pty!.write(KEY_ENTER);
    await observerSignal.waitForRecheck(() => countRecords(observerFile, "agent_settled") >= 1, EVENT_TIMEOUT_MS, "first native agent run settled");
    for (const toolName of ["YouShouldKnow", "AskUserQuestion"]) {
      assert.ok(journalRecords(observerFile).some((record) => record.type === "tool_execution_end"
        && record.toolName === toolName && record.isError === false), `${toolName} executed without error`);
    }
    const panelLine = process.platform === "darwin" ? "Pending input · Press Ctrl+Option+Up" : "Pending input · Press Ctrl+Alt+Up";
    const shortcutLabel = process.platform === "darwin" ? "Ctrl+Option+Up" : "Ctrl+Alt+Up";
    // A frame showing the panel and filler row 90 can still predate the
    // settled run: the gate's agent_end notice renders afterwards and, while
    // Pi follows the end, moves the transcript up by the notice's rows. Take
    // the baseline only from the frame proving that final entry is drawn.
    let settledFrame: string;
    try {
      settledFrame = await live.frames.waitFor((frame) => frameContains(frame, panelLine) && transcriptSettledAtEnd(frame),
        EVENT_TIMEOUT_MS, "pending panel and the settled end of the long transcript are visible", beforePrompt);
    } catch (error) {
      throw frameDiagnostics("pending panel and the settled end of the long transcript are visible", error);
    }
    const requestsBeforePopup = modelRequests();
    assert.equal(requestsBeforePopup, 4, "two notices, the question, and the transcript reply are the only scripted requests so far");
    const transcriptBeforePopup = transcriptOffset(settledFrame);
    assert.notEqual(transcriptBeforePopup, undefined, "the long transcript is visible before the popup opens");

    // --- Shared list over the visible native transcript ---
    let frame = await act(KEY_CTRL_ALT_UP, (next) => {
      const view = fixedHintPopupView(next, POPUP_LIST_HINT);
      return view !== undefined && bodyContains(view, "Pending input (3)") && selectedBodyRow(view, `n1: ${POPUP_NOTICE_TITLE}`)
        && bodyContains(view, "q1:") && nativeRowsAroundFrame(next, view);
    }, "the shared list opens with native rows visible around it");
    let view = fixedHintPopupView(frame, POPUP_LIST_HINT)!;
    assert.ok(view.top >= QUESTION_POPUP_VERTICAL_MARGIN && view.bottom <= PTY_ROWS - 1 - QUESTION_POPUP_VERTICAL_MARGIN,
      "the list stays within its one-row vertical margins");

    // --- Notice: capped one row inside the terminal; opens at its beginning ---
    frame = await act(KEY_ENTER, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && nextView.top === QUESTION_POPUP_VERTICAL_MARGIN
        && nextView.bottom === PTY_ROWS - 1 - QUESTION_POPUP_VERTICAL_MARGIN
        && nextView.body[0]!.trim() === `n1: ${POPUP_NOTICE_TITLE}` && bodyContains(nextView, POPUP_NOTICE_BULLET)
        && nativeRowsAroundFrame(next, nextView);
    }, "the long notice opens at its beginning, capped inside the one-row margins with native rows around it");
    view = fixedHintPopupView(frame, POPUP_NOTICE_HINT)!;
    const noticeHintRow = view.hintRow;
    assert.ok(view.body.some((line) => line.includes(POPUP_NOTICE_HEADING) && !line.trimStart().startsWith("#")),
      "the notice heading renders through native Markdown, not as raw source");
    assert.equal(bodyContains(view, "Native Markdown unavailable"), false, "the installed host renders native Markdown");
    assert.equal(bodyContains(view, "More details") || bodyContains(view, POPUP_NOTICE_CONTEXT), false,
      "context and actions are below the first page: they scroll with the body instead of being fixed");

    let previous = view.body;
    frame = await act(repeat(KEY_SHIFT_ALT_DOWN, 3), (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && nextView.hintRow === noticeHintRow && bodyShiftedBy(previous, nextView.body, 3);
    }, "three Shift+Alt+Down presses move the notice exactly three lines with the hint fixed");
    previous = fixedHintPopupView(frame, POPUP_NOTICE_HINT)!.body;
    frame = await act(KEY_SHIFT_ALT_DOWN, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && nextView.hintRow === noticeHintRow && bodyShiftedBy(previous, nextView.body, 1);
    }, "Shift+Alt+Down moves the same viewport exactly one line (middle of the body)");

    // Keyboard scrolling reaches the end: complete context and both actions.
    frame = await act(repeat(KEY_SHIFT_ALT_DOWN, 200), (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && nextView.body.at(-1)!.includes("Close") && bodyContains(nextView, "More details")
        && bodyContains(nextView, POPUP_NOTICE_CONTEXT) && bodyContains(nextView, POPUP_NOTICE_END);
    }, "keyboard scrolling reaches the end of the notice: body end, context, and both actions");
    view = fixedHintPopupView(frame, POPUP_NOTICE_HINT)!;
    assert.ok(selectedBodyRow(view, "More details"), "scrolling leaves the default More details action selected");
    assert.equal(view.hintRow, noticeHintRow, "the hint stays in its fixed row at the end");
    const noticeEnd = view.body;
    // Containment at the end: extra input must not overshoot.
    frame = await act([KEY_SHIFT_ALT_DOWN, KEY_SHIFT_ALT_DOWN, KEY_SHIFT_ALT_UP], (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && bodyShiftedBy(noticeEnd, nextView.body, -1);
    }, "input past the end bound is contained: one Shift+Alt+Up lands exactly one line above the end");

    // Back to the beginning; the start bound is contained the same way.
    frame = await act(repeat(KEY_SHIFT_ALT_UP, 200), (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && nextView.body[0]!.trim() === `n1: ${POPUP_NOTICE_TITLE}`;
    }, "Shift+Alt+Up returns to the notice beginning");
    const noticeStart = fixedHintPopupView(frame, POPUP_NOTICE_HINT)!.body;
    frame = await act([KEY_SHIFT_ALT_UP, KEY_SHIFT_ALT_UP, KEY_SHIFT_ALT_DOWN], (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && bodyShiftedBy(noticeStart, nextView.body, 1);
    }, "input past the start bound is contained: one Shift+Alt+Down lands exactly one line below the start");
    // Up at the first action still reveals the selected action; Down moves and reveals.
    frame = await act(KEY_UP, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_NOTICE_HINT), "More details"),
      "Up at the first action brings the selected More details action into view");
    frame = await act(KEY_DOWN, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_NOTICE_HINT), "Close"),
      "Down selects and reveals Close");
    assert.equal(modelRequests(), requestsBeforePopup, "notice scrolling and selection sent nothing to the model");

    // --- Question: opens at its beginning; choices scroll with the question ---
    frame = await act(KEY_ESCAPE, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_LIST_HINT), `n1: ${POPUP_NOTICE_TITLE}`),
      "Escape returns to the list without dismissing the notice");
    frame = await act(KEY_DOWN, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_LIST_HINT), "q1:"), "the list selects the question");
    frame = await act(KEY_ENTER, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      return nextView !== undefined && nextView.body[0]!.trim() === "q1:" && bodyContains(nextView, POPUP_QUESTION_HEADING)
        && nativeRowsAroundFrame(next, nextView);
    }, "the long question opens at its beginning");
    view = fixedHintPopupView(frame, POPUP_ANSWER_HINT)!;
    const answerHintRow = view.hintRow;
    assert.equal(answerHintRow, noticeHintRow, "question and notice share the same fixed hint row");
    assert.ok(view.body.some((line) => line.includes(POPUP_QUESTION_HEADING) && !line.trimStart().startsWith("#")),
      "the question heading renders through native Markdown");
    assert.equal(bodyContains(view, `1. ${POPUP_CHOICE_A}`) || bodyContains(view, POPUP_DECLINE), false,
      "opening does not jump past the long question to the first choice");

    previous = view.body;
    frame = await act(repeat(KEY_SHIFT_ALT_DOWN, 2), (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      return nextView !== undefined && nextView.hintRow === answerHintRow && bodyShiftedBy(previous, nextView.body, 2);
    }, "two Shift+Alt+Down presses scroll the question exactly two lines with the hint fixed");
    frame = await act(repeat(KEY_SHIFT_ALT_DOWN, 200), (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      return nextView !== undefined && nextView.body.at(-1)!.includes(POPUP_DECLINE)
        && bodyContains(nextView, POPUP_QUESTION_LAST_STEP) && selectedBodyRow(nextView, `1. ${POPUP_CHOICE_A}`)
        && bodyContains(nextView, "Type something…");
    }, "keyboard scrolling reaches the choices, Type something…, and Decline; the first choice stays selected");
    const answerEnd = fixedHintPopupView(frame, POPUP_ANSWER_HINT)!.body;
    frame = await act([KEY_SHIFT_ALT_DOWN, KEY_SHIFT_ALT_UP], (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      return nextView !== undefined && bodyShiftedBy(answerEnd, nextView.body, -1);
    }, "the question's end bound is contained");
    frame = await act(repeat(KEY_SHIFT_ALT_UP, 200), (next) =>
      fixedHintPopupView(next, POPUP_ANSWER_HINT)?.body[0]!.trim() === "q1:", "Shift+Alt+Up returns to the question beginning");
    frame = await act(KEY_DOWN, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      return selectedBodyRow(nextView, `2. ${POPUP_CHOICE_B}`) && nextView!.hintRow === answerHintRow;
    }, "Down from the beginning selects and reveals the second choice");
    frame = await act(KEY_DOWN, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_ANSWER_HINT), "Type something…"),
      "Down selects Type something…");

    // --- Editing: the draft survives keyboard scrolling outside the field ---
    frame = await act(KEY_ENTER, (next) => fixedHintPopupView(next, POPUP_EDITING_HINT) !== undefined,
      "the native field edits with the hint naming the Esc exception for the scroll keys");
    frame = await act("kbd draft", (next) => bodyContains(fixedHintPopupView(next, POPUP_EDITING_HINT), "kbd draft"),
      "typed text reaches the real native field");
    frame = await act(KEY_ESCAPE, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_ANSWER_HINT), "Type something…"),
      "Escape leaves editing and restores the option hint");
    frame = await act(repeat(KEY_SHIFT_ALT_UP, 200), (next) =>
      fixedHintPopupView(next, POPUP_ANSWER_HINT)?.body[0]!.trim() === "q1:", "after Esc the scroll keys page back to the question");
    frame = await act(KEY_ENTER, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_EDITING_HINT);
      return nextView !== undefined && bodyContains(nextView, "kbd draft") && nextView.body[0]!.trim() !== "q1:";
    }, "editing again brings the unchanged draft and cursor back into view");
    frame = await act(KEY_ESCAPE, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_ANSWER_HINT), "Type something…"),
      "Escape leaves editing again");
    assert.equal(modelRequests(), requestsBeforePopup, "scrolling and editing submitted nothing");
    assert.equal(agentStarts(), 1, "no scroll, selection, or editing input started an agent run");

    // --- Resize: bounds follow the live terminal; content stays reachable ---
    previous = fixedHintPopupView(frame, POPUP_ANSWER_HINT)!.body;
    const firstBeforeResize = previous[0];
    frame = await act(() => {
      live.surface.resize(PTY_COLS, POPUP_RESIZED_ROWS);
      live.pty!.resize(PTY_COLS, POPUP_RESIZED_ROWS);
    }, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      return next.split("\n").length === POPUP_RESIZED_ROWS && nextView !== undefined
        && nextView.top === QUESTION_POPUP_VERTICAL_MARGIN && nextView.bottom === POPUP_RESIZED_ROWS - 1 - QUESTION_POPUP_VERTICAL_MARGIN
        && nextView.body[0] === firstBeforeResize && nativeRowsAroundFrame(next, nextView);
    }, "native Pi re-lays out the popup for the shorter PTY inside its margins, keeping its scroll position");
    frame = await act(repeat(KEY_SHIFT_ALT_DOWN, 200), (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      return nextView !== undefined && nextView.body.at(-1)!.includes(POPUP_DECLINE) && selectedBodyRow(nextView, "Type something…");
    }, "the re-wrapped content stays reachable to its end in the shorter PTY");
    frame = await act(() => {
      live.surface.resize(PTY_COLS, PTY_ROWS);
      live.pty!.resize(PTY_COLS, PTY_ROWS);
    }, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_ANSWER_HINT);
      // The offset was at the shorter terminal's larger end bound; growing
      // clamps it to the new end, the same first row as the earlier end view.
      return next.split("\n").length === PTY_ROWS && nextView !== undefined && nextView.bottom === PTY_ROWS - 2
        && nextView.hintRow === answerHintRow && nextView.body.length === answerEnd.length
        && nextView.body[0] === answerEnd[0] && nextView.body.at(-1)!.includes(POPUP_DECLINE)
        && nativeRowsAroundFrame(next, nextView);
    }, "growing back clamps the offset to the new end bound with no blank overscroll");

    // --- Close: the transcript underneath never moved ---
    frame = await act(KEY_CTRL_ALT_UP, (next) => locateNativeQuestionPopup(next) === undefined
      && frameContains(next, panelLine) && transcriptFillerRows(next).length > 0,
    "the shortcut defers and closes the popup, revealing the transcript");
    assert.equal(transcriptOffset(frame), transcriptBeforePopup,
      "no popup scroll or selection input moved the transcript underneath");

    // --- Reopen: normal answer routing; the live transcript stays visible around the compact list ---
    frame = await act(KEY_CTRL_ALT_UP, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_LIST_HINT), `n1: ${POPUP_NOTICE_TITLE}`),
      "reopening shows all three pending inputs; scrolling consumed none");
    frame = await act(KEY_ENTER, (next) => fixedHintPopupView(next, POPUP_NOTICE_HINT)?.body[0]!.trim() === `n1: ${POPUP_NOTICE_TITLE}`,
      "the reopened notice starts at its beginning");
    frame = await act(KEY_ESCAPE, (next) => fixedHintPopupView(next, POPUP_LIST_HINT) !== undefined, "back to the reopened list");
    frame = await act(KEY_DOWN, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_LIST_HINT), "q1:"), "select the question again");
    frame = await act(KEY_ENTER, (next) => fixedHintPopupView(next, POPUP_ANSWER_HINT)?.body[0]!.trim() === "q1:",
      "the reopened question starts at its beginning");
    frame = await act(KEY_DOWN, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_ANSWER_HINT), `2. ${POPUP_CHOICE_B}`),
      "Down selects and reveals the second choice");
    assert.equal(modelRequests(), requestsBeforePopup, "close, reopen, and scrolling sent nothing to the model");
    const listHeader = `Pending input (2) · ${shortcutLabel} to close`;
    const beforeAnswer = live.frames.revision;
    frame = await act(KEY_ENTER, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_LIST_HINT);
      return nextView !== undefined && naturalPopupHeight(nextView, 4) && nextView.body[0]!.trim() === listHeader
        && selectedBodyRow(nextView, `n1: ${POPUP_NOTICE_TITLE}`) && bodyContains(nextView, `n2: ${POPUP_SHORT_NOTICE_TITLE}`)
        && !bodyContains(nextView, "q1:") && nativeRowsAroundFrame(next, nextView);
    }, "confirming the choice answers only the question; the two-notice list is sized to its two entries");
    await observerSignal.waitForRecheck(() => countRecords(observerFile, "agent_settled") >= 2, EVENT_TIMEOUT_MS,
      "the confirmed choice starts and settles one ordinary answer turn");
    // The answer turn's echo renders in the LIVE native transcript outside the
    // still-open compact list (Pi follows the transcript end).
    try {
      frame = await live.frames.waitFor((next) => {
        const nextView = fixedHintPopupView(next, POPUP_NOTICE_LIST_HINT);
        if (!nextView || !naturalPopupHeight(nextView, 4)) return false;
        return next.split("\n").some((row, index) => (index < nextView.top || index > nextView.bottom)
          && row.includes(`${ECHO_PREFIX}Answer to pending question`));
      }, EVENT_TIMEOUT_MS, "the answer echo renders in the live transcript around the open list", beforeAnswer);
    } catch (error) {
      throw frameDiagnostics("the answer echo renders in the live transcript around the open list", error);
    }

    // --- Short notice: only its natural rows ---
    frame = await act(KEY_DOWN, (next) => selectedBodyRow(fixedHintPopupView(next, POPUP_NOTICE_LIST_HINT), `n2: ${POPUP_SHORT_NOTICE_TITLE}`),
      "the list selects the short notice");
    frame = await act(KEY_ENTER, (next) => {
      const nextView = fixedHintPopupView(next, POPUP_NOTICE_HINT);
      return nextView !== undefined && naturalPopupHeight(nextView, 6)
        && nextView.body[0]!.trim() === `n2: ${POPUP_SHORT_NOTICE_TITLE}` && nextView.body[2]!.trim() === POPUP_SHORT_NOTICE_BODY
        && selectedBodyRow(nextView, "More details") && nextView.body[5]!.trim() === "Close"
        && nativeRowsAroundFrame(next, nextView);
    }, "the short notice uses only its natural rows with native rows visible around it");
    frame = await act(KEY_CTRL_ALT_UP, (next) => locateNativeQuestionPopup(next) === undefined && frameContains(next, panelLine),
      "the shortcut closes the popup, leaving both notices pending");
    assert.ok(frameContains(frame, `${ECHO_PREFIX}Answer to pending question`) && frameContains(frame, `": ${POPUP_CHOICE_B}`),
      "the delivered answer echo is visible at the transcript end");
    await providerSignal.waitForRecheck(() => modelRequests() >= 5, EVENT_TIMEOUT_MS, "the answer reaches the scripted model");
    const requests = journalRecords(providerJournalFile).filter((record) => record.event === "model_request");
    assert.equal(requests.length, 5, "exactly one model request followed the popup interaction");
    assert.equal(requests[4]?.lastUserPreview, expectedAnswer, "the exact selected choice reached the model as an ordinary user message");
    assert.equal(agentStarts(), 2, "only the confirmed answer started a second agent run");

    live.pty!.write(KEY_CTRL_C + KEY_CTRL_C);
    await waitForOwnerExit(live, CHILD_EXIT_TIMEOUT_MS);
    assert.equal(live.exit?.exitCode, 0, "native Pi exits through the documented Ctrl+C-twice path");
    assert.equal(processIsAlive(live.pty!.pid), false, "the owned native Pi child is no longer alive");
    await observerSignal.waitForRecheck(() => countRecords(observerFile, "session_shutdown") > 0, EVENT_TIMEOUT_MS, "genuine session_shutdown");
    assert.equal(live.parseFailed, false, "the production TerminalSurface accepted every native fullscreen frame");
  } finally {
    closeObserverWatch();
    closeProviderWatch();
  }
});
