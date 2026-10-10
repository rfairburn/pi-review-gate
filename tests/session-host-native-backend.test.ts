import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  watch,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  NODE_OPTIONS_RESTORE_ENV,
  composeFreshSessionSpawnArgs,
  prepareNativeLaunch,
  resolveNativePi,
} from "../src/session-host/launch";
import { SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV } from "../src/session-host/startup-request";
import { createStatusBroker, type StatusBroker, type StatusRegistration } from "../src/session-host/broker";
import { HOST_BOOTSTRAP_ENV, type SessionHostStatus } from "../src/session-host/protocol";
import { ProfileRegistry, type PreparedProfile } from "../src/session-host/profiles";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

const TEST_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 25_000;
const CHILD_EXIT_TIMEOUT_MS = 8_000;
const PRELOAD_DESCENDANT_TIMEOUT_MS = 5_000;
const PTY_COLS = 120;
const PTY_ROWS = 50;
const STICKY_STATE_KEY = Symbol.for("pi-review-gate.session-host.state.v1");
const MAX_STAGED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STAGED_TREE_BYTES = 128 * 1024 * 1024;
const MAX_STAGED_TREE_FILES = 20_000;
const MAX_STAGED_TREE_DEPTH = 40;
const closedCliChildren = new WeakSet<ChildProcess>();

interface StaticPrerequisites {
  candidateSourceRoot: string;
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

interface NativeBackendOwner {
  id: string;
  profile: PreparedProfile;
  observerFile: string;
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
  outputRevision: number;
  outputSignal: ChangeSignal;
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

function staticPrerequisites(
  t: { skip(message?: string): void },
  needsPty: boolean,
): StaticPrerequisites | undefined {
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

  if (needsPty) {
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
  }

  return { candidateSourceRoot, piBinTarget, expectedPiVersion, moduleSearchPath };
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
      root = mkdtempSync(join(parent, "sh-"));
      chmodSync(root, 0o700);
      return root;
    } catch {
      // If creation succeeded but private-mode setup failed, remove only that
      // just-created empty root before trying the next canonical temp parent.
      if (root) {
        try { rmdirSync(root); } catch { /* no owned root remains to remove */ }
      }
    }
  }
  throw new Error("a writable canonical POSIX temporary directory is unavailable for the native backend test");
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
  copyBoundedRegularFile(
    join(repositoryRoot(), "scripts", "session-host-startup-options.cjs"),
    join(packageRoot, "scripts", "session-host-startup-options.cjs"),
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

function safeNodeOptionsQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

async function waitForOwnedChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (closedCliChildren.has(child)) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => finish(new Error("owned native CLI child did not close before its deadline")), timeoutMs);
    const onClose = (): void => {
      closedCliChildren.add(child);
      finish();
    };
    const onError = (): void => finish(new Error("owned native CLI child failed before close"));
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function stopOwnedCliChild(child: ChildProcess): Promise<void> {
  if (closedCliChildren.has(child) || child.pid === undefined) return;
  try { child.kill("SIGTERM"); } catch { /* only this test-owned direct child is addressed */ }
  try {
    // Leave longer than the trusted preload's owned spawnSync deadline so it
    // can SIGKILL/reap its real Node descendant before parent escalation.
    await waitForOwnedChildClose(child, PRELOAD_DESCENDANT_TIMEOUT_MS + 2_000);
  } catch {
    try { child.kill("SIGKILL"); } catch { /* bounded escalation to the same owned handle */ }
    await waitForOwnedChildClose(child, 5_000);
  }
}

function waitForOwnerExit(owner: NativeBackendOwner, timeoutMs: number): Promise<void> {
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

async function stopOwnedPty(owner: NativeBackendOwner): Promise<void> {
  if (!owner.pty || owner.exit) return;
  try { owner.pty.kill("SIGTERM"); } catch { /* only this test-owned PTY handle is addressed */ }
  try {
    await waitForOwnerExit(owner, 5_000);
  } catch {
    try { owner.pty.kill("SIGKILL"); } catch { /* bounded escalation to the same owned PTY handle */ }
    await waitForOwnerExit(owner, 5_000);
  }
}

async function assertGracefulSigterm(owner: NativeBackendOwner): Promise<void> {
  assert.ok(owner.pty, "the native Pi PTY was spawned");
  assert.equal(owner.exit, undefined, "the owned native Pi PTY was alive before SIGTERM");
  try {
    owner.pty.kill("SIGTERM");
  } catch {
    throw new Error("the owned native Pi PTY did not accept its graceful SIGTERM");
  }
  try {
    await waitForOwnerExit(owner, CHILD_EXIT_TIMEOUT_MS);
  } catch {
    await stopOwnedPty(owner);
    throw new Error("the real native Pi PTY did not exit gracefully after SIGTERM");
  }
  const exitEvent = owner.exit as NativePtyExit | undefined;
  assert.ok(exitEvent, "the owned native Pi PTY delivered a bounded exit event");
  assert.equal(exitEvent.exitCode, 0, "native Pi gracefully handles SIGTERM and exits successfully");
  assert.ok(
    observerRecords(owner.observerFile).some((record) => record.type === "session_shutdown"),
    "SIGTERM ran the real native extension shutdown lifecycle",
  );
  assert.equal(exitEvent.signal ?? 0, 0, "native Pi exits normally without signal termination or escalation");
  assert.equal(processIsAlive(owner.pty.pid), false, "the owned native Pi child PID is no longer alive");
}

function assertOwnedStatuses(owner: NativeBackendOwner, generation: string): void {
  assert.ok(owner.statuses.entries.length > 0, "the real reporter delivered at least one authenticated status");
  for (const status of owner.statuses.entries) {
    assert.equal(status.instanceId, owner.id, "the broker delivered status only to its registered native owner");
    assert.equal(status.generation, generation, "the authentic reporter status carries this broker generation");
    assert.ok(status.pendingInput === null || typeof status.pendingInput === "boolean", "pending input is unknown or actually observed");
  }
}

function sessionFileHasStoredName(sessionFile: string, expectedName: string): boolean {
  const stats = lstatSync(sessionFile);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STAGED_FILE_BYTES) {
    throw new Error("owned native session file is not a bounded regular file");
  }
  let latestName: unknown;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (entry.type === "session_info") latestName = entry.name;
    } catch {
      // Ignore only a possibly incomplete append; complete native entries are checked.
    }
  }
  return latestName === expectedName;
}

function observerRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function observerExtensionSource(): string {
  return String.raw`'use strict';
const fs = require('node:fs');
const destination = process.env.PRG_NATIVE_BACKEND_OBSERVER_FILE;
const append = (record) => fs.appendFileSync(destination, JSON.stringify(record) + '\n', 'utf8');
module.exports = (pi) => {
  pi.on('session_start', (...args) => {
    const ctx = args.find((arg) => arg && typeof arg === 'object' && arg.ui && typeof arg.ui === 'object');
    let isIdleValue = null;
    let hasIsIdle = false;
    if (ctx && typeof ctx.isIdle === 'function') {
      hasIsIdle = true;
      try { isIdleValue = ctx.isIdle(); } catch { isIdleValue = null; }
    }
    const sessionFile = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionFile === 'function'
      ? ctx.sessionManager.getSessionFile()
      : undefined;
    append({ type: 'session_start', mode: ctx && ctx.mode, hasIsIdle, isIdleValue, sessionFile });
  });
  pi.on('agent_start', () => append({ type: 'agent_start' }));
  pi.on('session_shutdown', () => append({ type: 'session_shutdown' }));
};
module.exports.default = module.exports;
`;
}

function readProfileDigest(profile: PreparedProfile): string {
  return createHash("sha256").update(readFileSync(join(profile.agentDir, "review-gate.json"))).digest("hex");
}

async function createNativeOwner(
  ptyModule: NativePtyModule,
  surfaceModule: TerminalSurfaceModule,
  onSpawned: (owner: NativeBackendOwner) => void,
  options: {
    id: string;
    profile: PreparedProfile;
    observerFile: string;
    descriptor: ReturnType<typeof prepareNativeLaunch>;
    registration: StatusRegistration;
    statuses: StatusJournal;
    bootstrapEnv?: NodeJS.ProcessEnv;
  },
): Promise<NativeBackendOwner> {
  const statuses = options.statuses;
  const replies: string[] = [];
  const replySignal = new ChangeSignal();
  const owner = {
    id: options.id,
    profile: options.profile,
    observerFile: options.observerFile,
    registration: options.registration,
    statuses,
    descriptor: options.descriptor,
    replies,
    replySignal,
    exitSignal: new ChangeSignal(),
    outputRevision: 0,
    outputSignal: new ChangeSignal(),
    parseFailed: false,
    pty: undefined,
    exit: undefined,
    dataSubscription: undefined,
    exitSubscription: undefined,
    surface: undefined,
    frames: undefined,
  } as unknown as NativeBackendOwner;

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

  const childEnv = { ...options.descriptor.env, ...options.bootstrapEnv };
  childEnv[HOST_BOOTSTRAP_ENV] = JSON.stringify(options.registration.bootstrap);
  childEnv.PRG_NATIVE_BACKEND_OBSERVER_FILE = options.observerFile;
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
    owner.outputRevision += 1;
    owner.outputSignal.notify();
  });
  return owner;
}

function makeArgs(observerFile: string): string[] {
  return [
    "--offline",
    "--no-context-files",
    "--no-skills",
    "--no-themes",
    "--extension",
    observerFile,
  ];
}

async function disposeBackendResources(options: {
  root: string;
  owners: NativeBackendOwner[];
  child?: ChildProcess;
  registrations: StatusRegistration[];
  profiles: PreparedProfile[];
  broker?: StatusBroker;
}): Promise<void> {
  let cleanupError: Error | undefined;
  let allProcessesExited = true;
  if (options.child) {
    try { await stopOwnedCliChild(options.child); } catch {
      cleanupError = new Error("the owned native CLI child could not be confirmed closed");
      allProcessesExited = false;
    }
  }
  for (const owner of options.owners) {
    try { await stopOwnedPty(owner); } catch {
      cleanupError ??= new Error("an owned native Pi PTY could not be confirmed exited");
      allProcessesExited = false;
    }
    if (owner.pty && (!owner.exit || processIsAlive(owner.pty.pid))) allProcessesExited = false;
  }
  for (const owner of options.owners) {
    try { owner.dataSubscription?.dispose(); } catch { cleanupError ??= new Error("an owned PTY output subscription could not be disposed"); }
    try { owner.exitSubscription?.dispose(); } catch { cleanupError ??= new Error("an owned PTY exit subscription could not be disposed"); }
    try { owner.surface.dispose(); } catch { cleanupError ??= new Error("an owned TerminalSurface could not be disposed"); }
  }
  for (const registration of options.registrations) {
    try { registration.release(); } catch { cleanupError ??= new Error("an owned broker registration could not be released"); }
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
  for (const profile of options.profiles) {
    try { profile.release(); } catch { cleanupError ??= new Error("a synthetic profile admission could not be released"); }
  }
  if (allProcessesExited && brokerClosed) {
    const removed = removeOwnedTreePruningTerraform(options.root);
    if (!removed) cleanupError ??= new Error("the synthetic root contains an entry intentionally preserved by bounded cleanup");
  } else {
    cleanupError ??= new Error("the synthetic root was preserved because an owned process or broker resource remains live");
  }
  if (cleanupError) throw cleanupError;
}

function launchDescriptor(
  candidate: StagedCandidate,
  profile: PreparedProfile,
  executable: string,
  root: string,
  observerFile: string,
  nodePath: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof prepareNativeLaunch> {
  return prepareNativeLaunch({
    packageRoot: candidate.packageRoot,
    agentDir: profile.agentDir,
    workspace: profile.workspace,
    piExecutable: executable,
    args: makeArgs(observerFile),
    env: { ...makeSyntheticEnvironment(root, nodePath), ...extraEnv },
  });
}

function createWorkspace(root: string, name: string): string {
  const path = join(root, "workspaces", name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function createSessionObserverFiles(root: string, owner: string): { log: string; extension: string } {
  const log = join(root, "observer", `${owner}.jsonl`);
  const extension = join(root, "observer", `${owner}-extension.cjs`);
  writeFileSync(extension, observerExtensionSource(), { mode: 0o600 });
  return { log, extension };
}

test("production early preload consumes native authorization before trusted require and its real Node descendant", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const prerequisites = staticPrerequisites(t, false);
  if (!prerequisites) return;

  const root = makeSyntheticRoot();
  const owners: NativeBackendOwner[] = [];
  const profiles: PreparedProfile[] = [];
  const registrations: StatusRegistration[] = [];
  let broker: StatusBroker | undefined;
  let child: ChildProcess | undefined;
  t.after(async () => disposeBackendResources({ root, owners, profiles, registrations, broker, child }));

  initializeSyntheticDirectories(root);
  assertBrokerSocketPathBudget(root);
  const pi = resolvePiExecutable(prerequisites, root, t);
  if (!pi) return;
  const candidate = stageCandidate(root, prerequisites);
  const registry = new ProfileRegistry({ stateRoot: join(root, "profile-state") });
  const profile = registry.prepare({ workspace: createWorkspace(root, "version-workspace") });
  profiles.push(profile);

  const userRequirePath = join(root, 'trusted preloader "with spaces".cjs');
  const directObservationPath = join(root, "observer", "direct.json");
  const descendantObservationPath = join(root, "observer", "descendant.json");
  const instanceId = randomUUID();
  const originalNodeOptions = `   --require=${safeNodeOptionsQuote(userRequirePath)}   --trace-warnings  `;
  const userRequireSource = `
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const expectedOptions = ${JSON.stringify(originalNodeOptions)};
const role = process.env.PRG_NATIVE_PRELOAD_ROLE;
const sticky = globalThis[Symbol.for(${JSON.stringify("pi-review-gate.session-host.state.v1")})];
const bootstrap = sticky && sticky.bootstrap;
const record = {
  role,
  bootstrapEnvPresent: Object.prototype.hasOwnProperty.call(process.env, ${JSON.stringify(HOST_BOOTSTRAP_ENV)}),
  restoreEnvPresent: Object.prototype.hasOwnProperty.call(process.env, ${JSON.stringify(NODE_OPTIONS_RESTORE_ENV)}),
  originalOptionsExact: process.env.NODE_OPTIONS === expectedOptions,
  stickyPresent: Boolean(bootstrap),
  stickyMatchesExpected: Boolean(bootstrap)
    && bootstrap.instanceId === process.env.PRG_NATIVE_EXPECTED_INSTANCE
    && bootstrap.generation === process.env.PRG_NATIVE_EXPECTED_GENERATION,
};
if (role === 'direct') {
  const childEnv = { ...process.env, PRG_NATIVE_PRELOAD_ROLE: 'descendant' };
  const child = spawnSync(process.execPath, ['-e', ''], {
    env: childEnv,
    timeout: ${PRELOAD_DESCENDANT_TIMEOUT_MS},
    killSignal: 'SIGKILL',
    maxBuffer: 65536,
    stdio: 'ignore',
  });
  record.descendantExited = !child.error && child.status === 0 && child.signal === null;
  fs.writeFileSync(process.env.PRG_NATIVE_DIRECT_OBSERVATION, JSON.stringify(record), { mode: 0o600 });
} else if (role === 'descendant') {
  fs.writeFileSync(process.env.PRG_NATIVE_DESCENDANT_OBSERVATION, JSON.stringify(record), { mode: 0o600 });
}
`;
  writeFileSync(userRequirePath, userRequireSource, { mode: 0o600 });

  const descriptor = prepareNativeLaunch({
    packageRoot: candidate.packageRoot,
    agentDir: profile.agentDir,
    workspace: profile.workspace,
    piExecutable: pi.file,
    args: ["--version"],
    env: {
      ...makeSyntheticEnvironment(root, candidate.nodePath),
      NODE_OPTIONS: originalNodeOptions,
      PRG_NATIVE_PRELOAD_ROLE: "direct",
      PRG_NATIVE_EXPECTED_INSTANCE: instanceId,
      PRG_NATIVE_DIRECT_OBSERVATION: directObservationPath,
      PRG_NATIVE_DESCENDANT_OBSERVATION: descendantObservationPath,
    },
  });
  assert.equal(descriptor.env[HOST_BOOTSTRAP_ENV], undefined, "preparation does not create a reporter authorization capability");
  const restore = JSON.parse(descriptor.env[NODE_OPTIONS_RESTORE_ENV] ?? "null") as { original?: unknown };
  assert.ok(restore.original === originalNodeOptions, "preparation records the exact original quoted/spaced NODE_OPTIONS");
  assert.ok(descriptor.env.NODE_OPTIONS?.includes("bootstrap-preload.js"), "production preparation prepends its own early Node preload");
  assert.ok(
    descriptor.args[0] === "--extension"
      && descriptor.args[1] === join(candidate.packageRoot, "dist", "src", "session-host", "reporter.js")
      && descriptor.args[2] === "--extension"
      && descriptor.args[3] === candidate.entry,
    "production launch keeps the real reporter before the real gate extension",
  );

  // Preparation completes before registration; the token enters the environment only at spawn.
  broker = await createStatusBroker({ socketRoot: join(root, "broker") });
  const registration = broker.register(instanceId, { onStatus: () => undefined, onDisconnect: () => undefined });
  registrations.push(registration);
  const launchEnv = {
    ...descriptor.env,
    [HOST_BOOTSTRAP_ENV]: JSON.stringify(registration.bootstrap),
    PRG_NATIVE_EXPECTED_GENERATION: registration.bootstrap.generation,
  };
  let stdout = "";
  let stdoutBytes = 0;
  let outputExceeded = false;
  try {
    child = spawn(descriptor.file, [...descriptor.args], {
      cwd: descriptor.cwd,
      env: launchEnv,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("the actual pinned Pi Node CLI --version process did not spawn");
  }
  child.once("close", () => closedCliChildren.add(child!));
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 8192) stdout += chunk.toString("utf8");
    else outputExceeded = true;
  });
  await waitForOwnedChildClose(child, 20_000);
  assert.equal(child.exitCode, 0, "the actual native Node Pi CLI --version exits successfully");
  const reportedVersion = stdout.trim().match(/^(?:pi\s+)?v?(\d+\.\d+\.\d+)$/)?.[1];
  assert.ok(!outputExceeded && reportedVersion === pi.version, "the actual CLI reports the stable version accepted by resolveNativePi");

  assert.ok(existsSync(directObservationPath), "the trusted --require ran in the direct native CLI child");
  assert.ok(existsSync(descendantObservationPath), "the trusted --require ran in its independently spawned real Node descendant");
  const direct = JSON.parse(readFileSync(directObservationPath, "utf8")) as Record<string, unknown>;
  const descendant = JSON.parse(readFileSync(descendantObservationPath, "utf8")) as Record<string, unknown>;
  assert.equal(direct.role, "direct");
  assert.equal(direct.bootstrapEnvPresent, false, "the early preload consumes capability before trusted user require");
  assert.equal(direct.restoreEnvPresent, false, "the one-shot NODE_OPTIONS restore frame is consumed before trusted user require");
  assert.equal(direct.originalOptionsExact, true, "the trusted user require sees the exact original NODE_OPTIONS string");
  assert.equal(direct.stickyPresent, true, "the direct native child alone receives primed sticky authorization");
  assert.equal(direct.stickyMatchesExpected, true, "the direct child's sticky identity and generation match its own broker registration");
  assert.equal(direct.descendantExited, true, "the independently owned Node descendant exited within its SIGKILL-bounded spawnSync deadline");
  assert.equal(descendant.role, "descendant");
  assert.equal(descendant.bootstrapEnvPresent, false, "the descendant has no reporter bootstrap capability");
  assert.equal(descendant.restoreEnvPresent, false, "the descendant has no one-shot restore capability");
  assert.equal(descendant.originalOptionsExact, true, "the descendant inherits the exact original NODE_OPTIONS");
  assert.equal(descendant.stickyPresent, false, "the descendant has no process-local sticky reporter authorization");
  assert.equal(descendant.stickyMatchesExpected, false, "the descendant is not primed for the direct child's identity or generation");
  assert.equal(STICKY_STATE_KEY, Symbol.for("pi-review-gate.session-host.state.v1"), "the production sticky identity key remains stable");
});

test("two real native Pi PTYs retain per-owner status, draft, gate-menu, query-reply, and shutdown state", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const prerequisites = staticPrerequisites(t, true);
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
  const owners: NativeBackendOwner[] = [];
  const profiles: PreparedProfile[] = [];
  const registrations: StatusRegistration[] = [];
  let broker: StatusBroker | undefined;
  t.after(async () => disposeBackendResources({ root, owners, profiles, registrations, broker }));

  initializeSyntheticDirectories(root);
  assertBrokerSocketPathBudget(root);
  const pi = resolvePiExecutable(prerequisites, root, t);
  if (!pi) return;
  const candidate = stageCandidate(root, prerequisites);
  const registry = new ProfileRegistry({ stateRoot: join(root, "profile-state") });
  const profileA = registry.prepare({ workspace: createWorkspace(root, "workspace-a") });
  profiles.push(profileA);
  const profileB = registry.prepare({ workspace: createWorkspace(root, "workspace-b") });
  profiles.push(profileB);
  assert.ok(profileA.agentDir !== profileB.agentDir, "the native Pi processes use distinct synthetic private profiles");
  const profileBDigest = readProfileDigest(profileB);
  const observerA = createSessionObserverFiles(root, "owner-a");
  const observerB = createSessionObserverFiles(root, "owner-b");

  const descriptorA = launchDescriptor(candidate, profileA, pi.file, root, observerA.extension, candidate.nodePath, {
    PRG_NATIVE_BACKEND_OBSERVER_FILE: observerA.log,
  });
  const descriptorB = launchDescriptor(candidate, profileB, pi.file, root, observerB.extension, candidate.nodePath, {
    PRG_NATIVE_BACKEND_OBSERVER_FILE: observerB.log,
  });
  assert.equal(descriptorA.env[HOST_BOOTSTRAP_ENV], undefined, "A's launch preparation precedes status registration");
  assert.equal(descriptorB.env[HOST_BOOTSTRAP_ENV], undefined, "B's launch preparation precedes status registration");
  assert.equal(descriptorA.env.PI_CODING_AGENT_DIR, profileA.agentDir, "A's fresh native chat is stored under its private synthetic profile");
  assert.equal(descriptorB.env.PI_CODING_AGENT_DIR, profileB.agentDir, "B's fresh native chat is stored under its private synthetic profile");
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
  for (const descriptor of [descriptorA, descriptorB]) {
    assert.ok(!descriptor.args.some((arg) => forbiddenStartupFlags.has(arg)), "native Pi starts a fresh profile-owned session without startup override arguments");
    assert.equal(descriptor.env.PI_CODING_AGENT_SESSION_DIR, undefined, "native Pi session storage follows its isolated profile");
  }

  broker = await createStatusBroker({ socketRoot: join(root, "broker") });
  const idA = randomUUID();
  const idB = randomUUID();
  const statusesA = new StatusJournal();
  const statusesB = new StatusJournal();
  const registrationA = broker.register(idA, {
    onStatus: (status) => statusesA.push(status),
    onDisconnect: () => undefined,
  });
  registrations.push(registrationA);
  const registrationB = broker.register(idB, {
    onStatus: (status) => statusesB.push(status),
    onDisconnect: () => undefined,
  });
  registrations.push(registrationB);

  const ownerA = await createNativeOwner(ptyModule, surfaceModule, (owner) => owners.push(owner), {
    id: idA,
    profile: profileA,
    observerFile: observerA.log,
    descriptor: descriptorA,
    registration: registrationA,
    statuses: statusesA,
  });
  const ownerB = await createNativeOwner(ptyModule, surfaceModule, (owner) => owners.push(owner), {
    id: idB,
    profile: profileB,
    observerFile: observerB.log,
    descriptor: descriptorB,
    registration: registrationB,
    statuses: statusesB,
  });

  const initialA = await statusesA.waitFor((status) => status.type === "status", EVENT_TIMEOUT_MS, "owner A authenticated native status");
  const initialB = await statusesB.waitFor((status) => status.type === "status", EVENT_TIMEOUT_MS, "owner B authenticated native status");
  for (const initial of [initialA, initialB]) {
    assert.equal(initial.busy, false, "session-start readiness is established by the real native ctx.isIdle probe");
    assert.deepEqual(initial.activity, ["Ready"], "the reporter's actual idle probe yields Ready");
    assert.ok(
      initial.pendingInput === null || typeof initial.pendingInput === "boolean",
      "pending input is unknown or an actually observed native-widget value",
    );
  }
  assert.equal(initialA.instanceId, idA, "A's authentic status belongs to A's registration");
  assert.equal(initialB.instanceId, idB, "B's authentic status belongs to B's registration");
  assert.equal(initialA.generation, broker.generation);
  assert.equal(initialB.generation, broker.generation);

  for (const owner of owners) {
    await owner.replySignal.waitFor(() => owner.replies.length > 0, EVENT_TIMEOUT_MS, "native Pi terminal query reply to its owning PTY");
    await owner.frames.signal.waitFor(() => owner.frames.revision > 1, EVENT_TIMEOUT_MS, "native Pi output parsed into its owning TerminalSurface");
    assert.equal(owner.parseFailed, false, "the production TerminalSurface accepted native Pi output");
  }

  const observationDeadline = EVENT_TIMEOUT_MS;
  const observationSignalA = new ChangeSignal();
  const observationSignalB = new ChangeSignal();
  const watchObserver = (path: string, signal: ChangeSignal): (() => void) => {
    const fsWatch = require("node:fs").watch(dirname(path), (_event: string, filename: string | Buffer | null) => {
      if (filename === null || filename.toString() === path.slice(dirname(path).length + 1)) signal.notify();
    }) as { close(): void };
    return () => fsWatch.close();
  };
  const closeWatchA = watchObserver(join(root, "observer", "owner-a.jsonl"), observationSignalA);
  const closeWatchB = watchObserver(join(root, "observer", "owner-b.jsonl"), observationSignalB);
  try {
    await Promise.all([
      observationSignalA.waitFor(() => observerRecords(join(root, "observer", "owner-a.jsonl")).some((record) => record.type === "session_start"), observationDeadline, "owner A native ctx.isIdle observation"),
      observationSignalB.waitFor(() => observerRecords(join(root, "observer", "owner-b.jsonl")).some((record) => record.type === "session_start"), observationDeadline, "owner B native ctx.isIdle observation"),
    ]);
  } finally {
    closeWatchA();
    closeWatchB();
  }
  for (const path of [join(root, "observer", "owner-a.jsonl"), join(root, "observer", "owner-b.jsonl")]) {
    const sessionStart = observerRecords(path).find((record) => record.type === "session_start");
    assert.ok(sessionStart, "the real native hook context was observed without logging its contents");
    assert.equal(sessionStart.hasIsIdle, true, "the actual Pi TUI context exposes isIdle");
    assert.equal(sessionStart.isIdleValue, true, "the native Pi context reports idle at session start");
    assert.equal(sessionStart.mode, "tui", "the reporter and probe observe an actual native TUI session");
  }

  const draftA = "/review-settings";
  const draftB = `NATIVE_BACKEND_SIBLING_${randomUUID().slice(0, 8)}`;
  const writeToOwner = (id: string, data: string): NativeBackendOwner => {
    const owner = owners.find((candidateOwner) => candidateOwner.id === id);
    if (!owner?.pty) throw new Error("input requires an explicitly addressed live native PTY owner");
    owner.pty.write(data);
    return owner;
  };

  const afterA = ownerA.frames.revision;
  writeToOwner(idA, draftA);
  await ownerA.frames.waitFor((frame) => frame.includes(draftA), EVENT_TIMEOUT_MS, "native command remains an editor draft before Enter", afterA);
  const beforeDraftB = ownerB.frames.revision;
  writeToOwner(idB, draftB);
  await ownerB.frames.waitFor((frame) => frame.includes(draftB), EVENT_TIMEOUT_MS, "owner B native editor draft", beforeDraftB);
  assert.ok(ownerA.frames.text.includes("/review-settings"), "A's unsubmitted native command is visible only on A's frame");
  assert.ok(!ownerA.frames.text.includes(draftB), "B's draft never appears in A's TerminalSurface frame");
  assert.ok(ownerB.frames.text.includes(draftB), "B's native draft is present in B's own frame");
  assert.ok(!ownerB.frames.text.includes("/review-settings"), "A's native command never appears in B's TerminalSurface frame");
  assert.equal(observerRecords(ownerA.observerFile).filter((record) => record.type === "agent_start").length, 0, "typing the native draft did not submit a model prompt");
  assert.equal(observerRecords(ownerB.observerFile).filter((record) => record.type === "agent_start").length, 0, "typing the sibling draft did not submit a model prompt");
  assert.equal(ownerA.statuses.entries.some((status) => status.busy === true), false, "typing leaves A's actual Pi session idle");
  assert.equal(ownerB.statuses.entries.some((status) => status.busy === true), false, "typing leaves B's actual Pi session idle");

  const ownerBStatusCountBeforeMenu = ownerB.statuses.entries.length;
  const ownerAFrameBeforeEnter = ownerA.frames.revision;
  writeToOwner(idA, "\r");
  await ownerA.frames.waitFor(
    (frame) => frame.includes("Review settings")
      && frame.includes("Operating mode")
      && frame.includes("Mode cycle hotkey")
      && frame.includes("Worker resources"),
    EVENT_TIMEOUT_MS,
    "the genuine production /review-settings menu opens in A's current native frame",
    ownerAFrameBeforeEnter,
  );
  const menuTopRevision = ownerA.frames.revision;
  writeToOwner(idA, "\x1b[A");
  await ownerA.frames.waitFor(
    (frame) => frame.includes("Review settings")
      && frame.includes("Save changes")
      && frame.includes("Cancel")
      && !frame.includes("Operating mode"),
    EVENT_TIMEOUT_MS,
    "native menu navigation renders the final settings rows in A's current frame",
    menuTopRevision,
  );
  assert.ok(!ownerA.frames.text.includes(draftB), "the settings menu frame is owned by A, not B's draft");
  assert.ok(ownerB.frames.text.includes(draftB), "the unaddressed sibling retains its independent native draft while A's menu is open");
  assert.ok(!ownerB.frames.text.includes("Review settings"), "A's native gate menu is absent from B's current frame");
  assert.equal(ownerB.statuses.entries.length, ownerBStatusCountBeforeMenu, "A's gate interaction did not change B's status ownership");

  const ownerBOutputBeforeResize = ownerB.outputRevision;
  ownerB.surface.resize(PTY_COLS - 1, PTY_ROWS);
  ownerB.pty!.resize(PTY_COLS - 1, PTY_ROWS);
  await ownerB.outputSignal.waitFor(
    () => ownerB.outputRevision > ownerBOutputBeforeResize,
    EVENT_TIMEOUT_MS,
    "the unaddressed native child continues producing PTY output",
  );
  await withDeadline(ownerB.surface.flush(), EVENT_TIMEOUT_MS, "owned TerminalSurface output flush");
  assert.equal(ownerB.parseFailed, false, "the unaddressed child's new output still parses through its own surface");
  assert.equal(ownerB.surface.frame().cols, PTY_COLS - 1, "B's current TerminalSurface frame owns its resized geometry");
  assert.ok(!ownerB.frames.text.includes("Review settings"), "A's native gate menu never enters B's resized frame");
  assert.ok(ownerA.frames.text.includes("Review settings"), "B's unaddressed output does not replace A's live gate menu frame");

  const menuRevision = ownerA.frames.revision;
  writeToOwner(idA, "\x1b");
  await ownerA.frames.waitFor(
    (frame) => !frame.includes("Review settings") && !frame.includes("Save changes"),
    EVENT_TIMEOUT_MS,
    "native Escape closes the genuine settings menu on its owning PTY",
    menuRevision,
  );
  assert.ok(!ownerB.frames.text.includes("Review settings"), "the closed A menu never enters B's frame");
  assert.equal(readProfileDigest(profileB), profileBDigest, "opening and canceling A's settings menu leaves B's private profile unchanged");
  assert.equal(observerRecords(ownerA.observerFile).filter((record) => record.type === "agent_start").length, 0, "the native settings command and Escape did not submit a model prompt");
  assert.equal(observerRecords(ownerB.observerFile).filter((record) => record.type === "agent_start").length, 0, "B's retained draft was never submitted");

  assertOwnedStatuses(ownerA, broker.generation);
  assertOwnedStatuses(ownerB, broker.generation);
  assert.equal(ownerA.statuses.entries.some((status) => status.instanceId === idB), false, "A's status journal contains no B identity");
  assert.equal(ownerB.statuses.entries.some((status) => status.instanceId === idA), false, "B's status journal contains no A identity");

  await assertGracefulSigterm(ownerA);
  await assertGracefulSigterm(ownerB);
});

test("real Pi receives literal SessionSpawn prompts and preserves long native titles under native whitespace rules", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const prerequisites = staticPrerequisites(t, true);
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
  const owners: NativeBackendOwner[] = [];
  const profiles: PreparedProfile[] = [];
  const registrations: StatusRegistration[] = [];
  const watchers: Array<{ close(): void }> = [];
  let broker: StatusBroker | undefined;
  t.after(async () => {
    for (const watcher of watchers) watcher.close();
    await disposeBackendResources({ root, owners, profiles, registrations, broker });
  });

  initializeSyntheticDirectories(root);
  assertBrokerSocketPathBudget(root);
  const pi = resolvePiExecutable(prerequisites, root, t);
  if (!pi) return;
  const candidate = stageCandidate(root, prerequisites);
  const registry = new ProfileRegistry({ stateRoot: join(root, "profile-state") });
  const providerExtension = join(repositoryRoot(), "tests", "fixtures", "session-host-native-provider.cjs");
  const fixtureAgentDir = realpathSync(resolve(process.env.PI_REVIEW_GATE_INSTALLED_AGENT!));
  broker = await createStatusBroker({ socketRoot: join(root, "broker") });

  const cases = [
    {
      key: "at-leading",
      id: randomUUID(),
      title: `  ${"Native title beyond the advisory sidebar width ".repeat(3)}  `,
      prompt: "@literal-at-file.txt\nThis text must not be expanded from a file.",
    },
    {
      key: "flag-leading",
      id: randomUUID(),
      title: `Flag-leading title beyond the advisory sidebar width ${"x".repeat(32)}`,
      prompt: "--session /tmp/not-a-session-selection.jsonl\nThis entire string is user text.",
    },
  ] as const;

  const prepared: Array<{
    id: string;
    profile: PreparedProfile;
    observer: { log: string; extension: string };
    descriptor: ReturnType<typeof prepareNativeLaunch>;
    statuses: StatusJournal;
    providerState: string;
    journal: string;
    prompt: string;
    title: string;
    signal: ChangeSignal;
  }> = [];
  for (const request of cases) {
    const profile = registry.prepare({ workspace: createWorkspace(root, `workspace-${request.key}`) });
    profiles.push(profile);
    const observer = createSessionObserverFiles(root, request.key);
    const literalAtFile = join(profile.workspace, "literal-at-file.txt");
    writeFileSync(literalAtFile, "FILE CONTENT MUST NOT REPLACE THE @-LEADING PROMPT\n", { mode: 0o600 });
    const providerState = join(root, "provider-state", request.key);
    mkdirSync(providerState, { recursive: true, mode: 0o700 });
    writeFileSync(join(providerState, "turn-script.json"), JSON.stringify({ steps: [{ text: "fixture-turn-complete" }] }), { mode: 0o600 });

    const inheritedArgs = [
      ...makeArgs(observer.extension),
      "--extension", candidate.entry,
      "--extension", providerExtension,
      "--provider", "prg-native-question",
      "--model", "driven",
      "--name", "parent session title",
      "parent startup message that must not be inherited",
      "@parent-startup-file.txt",
    ];
    const args = composeFreshSessionSpawnArgs(inheritedArgs, request.title);
    assert.equal(args.includes("parent session title"), false);
    assert.equal(args.includes("parent startup message that must not be inherited"), false);
    assert.equal(args.includes("@parent-startup-file.txt"), false);
    assert.deepEqual(args.slice(-2), ["--name", request.title]);

    // The same composed arguments used by a fresh manager admission are
    // supplied to the real Pi CLI; normal native setup otherwise remains
    // untouched.
    const nativeDescriptor = prepareNativeLaunch({
      nativeSetup: false,
      packageRoot: candidate.packageRoot,
      agentDir: profile.agentDir,
      workspace: profile.workspace,
      piExecutable: pi.file,
      args,
      env: { ...makeSyntheticEnvironment(root, candidate.nodePath), PRG_NATIVE_BACKEND_OBSERVER_FILE: observer.log },
    });
    assert.equal(nativeDescriptor.cwd, profile.workspace, "the native child runs in the explicitly selected workspace");
    assert.equal(nativeDescriptor.args.includes(request.prompt), false, "the prompt never reaches Pi's CLI parser");
    const providerJournal = join(providerState, "provider-journal.jsonl");
    const signal = new ChangeSignal();
    watchers.push(watch(providerState, () => signal.notify()));
    prepared.push({
      id: request.id,
      profile,
      observer,
      descriptor: nativeDescriptor,
      statuses: new StatusJournal(),
      providerState,
      journal: providerJournal,
      prompt: request.prompt,
      title: request.title,
      signal,
    });
  }

  for (const entry of prepared) {
    const registration = broker.register(entry.id, {
      onStatus: (status) => entry.statuses.push(status),
      onDisconnect: () => undefined,
    });
    registrations.push(registration);
    const owner = await createNativeOwner(ptyModule, surfaceModule, (created) => owners.push(created), {
      id: entry.id,
      profile: entry.profile,
      observerFile: entry.observer.log,
      descriptor: entry.descriptor,
      registration,
      statuses: entry.statuses,
      bootstrapEnv: {
        [SESSION_HOST_STARTUP_REQUEST_ENV]: JSON.stringify({ title: entry.title, prompt: entry.prompt }),
        [SESSION_HOST_TITLE_COLUMNS_ENV]: "47",
        PRG_FIXTURE_AGENT_DIR: fixtureAgentDir,
        PRG_FIXTURE_STATE_DIR: entry.providerState,
      },
    });
    assert.equal(owner.descriptor.cwd, entry.profile.workspace);
  }

  for (const entry of prepared) {
    const readProviderRecords = (): Array<Record<string, unknown>> => existsSync(entry.journal)
      ? readFileSync(entry.journal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    await entry.signal.waitFor(
      () => readProviderRecords().some((record) => record.event === "model_request"),
      EVENT_TIMEOUT_MS,
      `${entry.id} real Pi faux-provider receives its first native user turn`,
    );
    const firstTurn = readProviderRecords().find((record) => record.event === "model_request");
    assert.equal(firstTurn?.lastUserPreview, entry.prompt,
      `${entry.id} prompt reaches the actual Pi model context byte-for-byte, without @file or option parsing`);
    const expectedNativeTitle = entry.title.trim();
    await entry.statuses.signal.waitFor(
      () => entry.statuses.entries.some((status) => status.nativeSession?.name === expectedNativeTitle),
      EVENT_TIMEOUT_MS,
      `${entry.id} reporter observes Pi's native title after its surrounding-whitespace normalization`,
    );
    const storedTitle = entry.statuses.entries.find((status) => status.nativeSession?.name === expectedNativeTitle)?.nativeSession?.name;
    assert.equal(storedTitle, expectedNativeTitle, "Pi trims surrounding whitespace according to its native session-name semantics");
    assert.ok((storedTitle?.length ?? 0) > 47,
      "the full post-normalization native title remains stored even though it exceeds the advisory sidebar width");
    const sessionFile = observerRecords(entry.observer.log).find((record) => record.type === "session_start")?.sessionFile;
    assert.equal(typeof sessionFile, "string", "the native observer identifies Pi's actual conversation file");
    assert.equal(sessionFileHasStoredName(sessionFile as string, expectedNativeTitle), true,
      "the Pi 1.1.0 native session_info entry persists its whitespace-normalized full title");
  }

  for (const owner of owners) await assertGracefulSigterm(owner);
});
