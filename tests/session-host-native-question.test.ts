/**
 * Native question UI/lifecycle proof (session-host native question phase).
 *
 * Drives ONE real native Pi 1.0.4 TUI session — the REAL review gate
 * extension, the production session-host reporter/broker/TerminalSurface,
 * in an isolated owned PTY under a synthetic HOME/profile — through the full
 * AskUserQuestion lifecycle:
 *
 *   scripted faux toolCall (public pi.registerProvider + fauxProvider, zero
 *   external AI/API calls) → real pending-question panel and list UI →
 *   answer through the real UI (Ctrl+Alt+Up, Enter, Enter) → normal next
 *   turn whose model context actually contains the delivered answer →
 *   orderly Ctrl+C-twice host exit with a genuine session_shutdown.
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

const TEST_TIMEOUT_MS = 240_000;
const EVENT_TIMEOUT_MS = 30_000;
const CHILD_EXIT_TIMEOUT_MS = 15_000;
const PTY_COLS = 120;
const PTY_ROWS = 50;
const MAX_STAGED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STAGED_TREE_BYTES = 128 * 1024 * 1024;
const MAX_STAGED_TREE_FILES = 20_000;
const MAX_STAGED_TREE_DEPTH = 40;

// --- Distinctive content markers for the scripted question and its answer ---
const QUESTION_TEXT = "Native question probe: which option should the fixture use?";
const CHOICE_A = "Alpha option";
const CHOICE_B = "Beta option";
const INITIAL_PROMPT = "Please ask me which option to use.";
const ECHO_PREFIX = "Fixture echo of delivered answer: ";

// --- Key sequences (xterm) ---
const KEY_ENTER = "\r";
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
      // Exclude initialized Terraform trees before any descent.
      if (name === ".terraform") continue;
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

function removeOwnedTreePruningTerraform(root: string): boolean {
  let complete = true;
  const removeEntry = (path: string, entryName: string): void => {
    // Never descend into initialized Terraform data, even under a test-owned root.
    if (entryName === ".terraform") {
      complete = false;
      return;
    }
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("could not inspect a test-owned synthetic entry during bounded cleanup");
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const name of readdirSync(path)) removeEntry(join(path, name), name);
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
  removeEntry(root, "");
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

  async waitFor(
    predicate: (text: string) => boolean,
    timeoutMs: number,
    description: string,
    afterRevision = this.revision,
  ): Promise<void> {
    await this.signal.waitFor(() => this.revision > afterRevision && predicate(this.text), timeoutMs, description);
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

/** Event-driven directory watch that notifies when the named file changes. */
function watchOwnedFile(directory: string, fileName: string, signal: ChangeSignal): () => void {
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
    const removed = removeOwnedTreePruningTerraform(options.root);
    if (!removed) cleanupError ??= new Error("the synthetic root contains an entry intentionally preserved by bounded cleanup");
  } else {
    cleanupError ??= new Error("the synthetic root was preserved because an owned process or broker resource remains live");
  }
  if (cleanupError) throw cleanupError;
}

test("native Pi TUI answers a scripted AskUserQuestion through the real question UI", { timeout: TEST_TIMEOUT_MS }, async (t) => {
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
  const observerSignal = new ChangeSignal();
  const providerSignal = new ChangeSignal();
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

    await observerSignal.waitFor(
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
    await providerSignal.waitFor(
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
    await observerSignal.waitFor(
      () => countRecords(observerFile, "agent_start") >= 1,
      EVENT_TIMEOUT_MS,
      "first native agent run start",
    );
    await observerSignal.waitFor(
      () => journalRecords(observerFile).some((record) => record.type === "tool_execution_start" && record.toolName === "AskUserQuestion"),
      EVENT_TIMEOUT_MS,
      "real AskUserQuestion tool execution start",
    );
    await observerSignal.waitFor(
      () => journalRecords(observerFile).some((record) => record.type === "tool_execution_end" && record.toolName === "AskUserQuestion" && record.isError === false),
      EVENT_TIMEOUT_MS,
      "real AskUserQuestion tool execution end without error",
    );
    await observerSignal.waitFor(
      () => countRecords(observerFile, "agent_settled") >= 1,
      EVENT_TIMEOUT_MS,
      "first native agent run settled",
    );

    // The reporter observed the busy window and the pending-question panel.
    const busyStatus = await statuses.waitFor((status) => status.busy === true, EVENT_TIMEOUT_MS, "reporter observed the first run as busy");
    assert.equal(busyStatus.instanceId, id, "the busy status belongs to this registration");
    const pendingStatus = await statuses.waitFor(
      (status) => status.pendingInput === true && status.busy === false,
      EVENT_TIMEOUT_MS,
      "reporter observed the real pending-question panel widget after the first run settled",
    );

    // The collapsed panel line is visible in the real native frame.
    // The panel renders during the first run, so scope this wait from before
    // the prompt was submitted: an idle TUI emits no new frames after it.
    const panelLine = process.platform === "darwin" ? "Pending questions · Press Ctrl+Option+Up" : "Pending questions · Press Ctrl+Alt+Up";
    await liveOwner.frames.waitFor((frame) => frameContains(frame, panelLine), EVENT_TIMEOUT_MS, "real pending-question panel line in the native frame", beforePrompt);

    // --- Open the real pending-question list (Ctrl+Alt+Up) ---
    const beforeList = liveOwner.frames.revision;
    liveOwner.pty!.write(KEY_CTRL_ALT_UP);
    await liveOwner.frames.waitFor(
      (frame) => frameContains(frame, "Pending questions (1)")
        && frameContains(frame, `q1: ${QUESTION_TEXT}`)
        && frameContains(frame, "arrows select · Enter answer · Esc defer and close"),
      EVENT_TIMEOUT_MS,
      "real pending-question list opens with the scripted question",
      beforeList,
    );

    // --- Enter answer mode (Enter on the selected question) ---
    const beforeAnswer = liveOwner.frames.revision;
    liveOwner.pty!.write(KEY_ENTER);
    await liveOwner.frames.waitFor(
      (frame) => frameContains(frame, `q1: ${QUESTION_TEXT}`)
        && frameContains(frame, `1. ${CHOICE_A}`)
        && frameContains(frame, `2. ${CHOICE_B}`)
        && frameContains(frame, "Type something…")
        && frameContains(frame, "Decline (no answer will be sent)")
        && frameContains(frame, "arrows select · Enter confirm · Esc back"),
      EVENT_TIMEOUT_MS,
      "real answer mode shows the scripted choices plus free text and decline",
      beforeAnswer,
    );

    // --- Submit the first choice (Enter) ---
    const beforeSubmit = liveOwner.frames.revision;
    // The reporter also observes the session_start panel clear, so the
    // post-answer clearance must be proven strictly after this history point.
    const statusIndexBeforeAnswer = statuses.entries.length - 1;
    // The panel is visible while the answer UI is open (widget above the editor).
    assert.ok(
      frameContains(liveOwner.frames.text, panelLine),
      "the pending-question panel is visible in the real frame while the answer UI is open",
    );
    liveOwner.pty!.write(KEY_ENTER);

    // The delivered answer arrives as an ordinary user message and starts a
    // normal next turn whose model context contains the answer.
    await observerSignal.waitFor(
      () => countRecords(observerFile, "agent_start") >= 2,
      EVENT_TIMEOUT_MS,
      "second native agent run start from the UI-delivered answer",
    );
    await observerSignal.waitFor(
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
      (frame) => frameContains(frame, `Answer to pending question "${QUESTION_TEXT}": ${CHOICE_A}`)
        && frameContains(frame, `${ECHO_PREFIX}Answer to pending question "${QUESTION_TEXT}": ${CHOICE_A}`),
      EVENT_TIMEOUT_MS,
      "delivered answer and its echo are visible in the real native transcript",
      beforeSubmit,
    );

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
    await observerSignal.waitFor(
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
    assert.ok(
      String(answerRequest.lastUserPreview).includes(`Answer to pending question "${QUESTION_TEXT}": ${CHOICE_A}`),
      "the UI-delivered answer reached the model context as an ordinary user message",
    );

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
