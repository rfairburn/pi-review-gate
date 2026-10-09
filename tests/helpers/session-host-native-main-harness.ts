/**
 * Test-only shared harness for the real public Main native integration tests
 * (tests/session-host-native-main.test.ts and
 * tests/session-host-native-main-lifecycle.test.ts).
 *
 * This module owns the owned-PTY driver around the real public Main API
 * (`runSessionHost` in a privately staged candidate package), the pinned real
 * Pi 1.1.0 fixture resolution, bounded scratch staging, and the exact-PID
 * kernel exit watchers. It is test infrastructure only: no production source,
 * CI, package, docs, or SDK surface changes; no `__test` dependency-injection
 * seam is added to production. The driver's optional `args`/`env` overrides
 * and synthetic native-agent fixture setup let lifecycle regressions drive
 * different real Main configurations while native children share Pi state.
 *
 * Graceful native-child exit evidence: the test-only Main runner observes the
 * real pinned `@lydell/node-pty` public `spawn`/`onExit` API on the exact
 * module instance production lazily loads (strict forwarding wrapper; see
 * tests/fixtures/session-host-main-runner.cjs) and journals each owned PTY's
 * actual `exitCode`/`signal`. The kernel EVFILT_PROC/NOTE_EXIT watcher proves
 * only that the exact owned process is gone: NOTE_EXITSTATUS is valid only on
 * child processes, and these native children are grandchildren of the test, so
 * the exit status itself comes from the manager-owned PTY's public onExit
 * event, never from the kernel.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { TerminalSurface, stripGeneratedSgr } from "../../src/session-host/terminal-surface";
import {
  NATIVE_PANE_START,
  SIDEBAR_COLUMNS,
  SIDEBAR_OVERLAY_MIN_OUTER_COLUMNS,
  frameHeader,
  frameHeaderMatches,
  isSidebarFocusedFrame,
  parseRosterFrame,
  renderedTitleMatches,
  selectedRosterEntry,
  sidebarPaneLines,
  sidebarRosterHidden,
} from "./session-host-native-roster-witness";

export const TEST_TIMEOUT_MS = 8 * 60_000;
export const EVENT_TIMEOUT_MS = 30_000;
const SHORT_QUIET_WINDOW_MS = 300;
const CLEANUP_UI_TIMEOUT_MS = 1_000;
const CLEANUP_LIFECYCLE_TIMEOUT_MS = 2_000;
const CLEANUP_PROCESS_EXIT_TIMEOUT_MS = 2_000;
const CLEANUP_HOST_EXIT_TIMEOUT_MS = 2_000;
const CLEANUP_SIGNAL_TIMEOUT_MS = 3_000;
export const OUTER_COLS = 120;
export const OUTER_ROWS = 50;
// The primary buffer is legitimately clipped while the alternate buffer is
// resized; keep the complete restoration witness inside the narrowest 24 cols.
export const OUTER_RESTORATION_BASELINE = "PRG-TTY-BASELINE";
const BASELINE = OUTER_RESTORATION_BASELINE;
export const OBSERVER_ENV = "PRG_SESSION_HOST_NATIVE_MAIN_OBSERVER_FILE";
export const OBSERVER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-observer.cjs");
export const RUNNER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-runner.cjs");
const EXIT_WATCHER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-exit-watcher.py");

export const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  altRight: "\x1b[1;3C",
  f8: "\x1b[19~",
  ctrlC: "\x03",
  ctrlG: "\x07",
  delete: "\x1b[3~",
};

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface CleanupOutcome {
  readonly childrenExited: boolean;
  readonly shutdownEventsObserved: boolean;
  readonly hostExited: boolean;
  readonly gracefulHostExit: boolean;
  readonly forced: boolean;
}

interface Disposable {
  dispose(): void;
}

export interface NativePtyHandle {
  readonly pid: number | string;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExit) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NativePtyModule {
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

export interface SessionRecord {
  type: string;
  reason?: string;
  pid?: number;
  cwd?: string;
  contextCwd?: string;
  agentDir?: string;
  sessionId?: string;
  displayName?: string;
  storedName?: string;
  contextSessionId?: string;
  sessionFile?: string;
  columns?: number;
  rows?: number;
  mode?: string;
  tty?: boolean;
  toolName?: string;
  activeTools?: string[];
  credentialLikeEnvironmentNames?: string[];
}

export interface OwnedSession {
  /** Stable fixture-side row probe; visible matching uses the canonical caption and current pane geometry. */
  rowProbe: string;
  readonly workspace: string;
  /** Exact native stored name, including names longer than the visible row. */
  currentName: string;
  /** Canonical native display caption, already bounded by the native reporter. */
  displayName: string;
  readonly record: SessionRecord;
  readonly exitWatcher: OwnedPidExitWatcher;
}

export interface RuntimePin {
  readonly agentDir: string;
  readonly piExecutable: string;
  readonly version: string;
  readonly nodePath: string;
  readonly pty: NativePtyModule;
}

export interface CandidatePackage {
  readonly root: string;
  readonly entry: string;
}

/** One real @lydell/node-pty onExit observation journaled by the Main runner. */
export interface PtyExitRecord {
  type: string;
  pid?: number;
  cwd?: string;
  exitCode?: number;
  signal?: number | string | null;
}

export class ChangeSignal {
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
          finish(new Error(`${description}: bounded event predicate failed`));
        }
      };
      const timer = setTimeout(() => finish(new Error(`${description}: deadline exceeded`)), timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  waitForQuiet(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
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
          if (predicate()) finish(new Error(`${description}: unexpected owned event`));
        } catch {
          finish(new Error(`${description}: bounded event predicate failed`));
        }
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  waitForQuietPeriod(quietMs: number, timeoutMs: number, description: string): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        this.listeners.delete(restart);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const restart = (): void => {
        if (settled) return;
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), quietMs);
      };
      const deadlineTimer = setTimeout(() => finish(new Error(`${description}: deadline exceeded before quiet`)), timeoutMs);
      this.listeners.add(restart);
      restart();
    });
  }
}

export class OwnedPidExitWatcher {
  readonly pid: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly signal = new ChangeSignal();
  private stdoutBuffer = "";
  private stderrTail = "";
  private registered = false;
  private watcherClosed = false;
  private failure?: Error;
  observedExit = false;

  constructor(pid: number) {
    this.pid = pid;
    this.child = spawn("python3", [EXIT_WATCHER_FIXTURE, String(pid)], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.end();
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-1_000);
    });
    this.child.on("error", (error) => {
      this.failure = new Error(`owned-PID exit observer could not start: ${error.message}`);
      this.signal.notify();
    });
    this.child.on("close", (code, signal) => {
      this.watcherClosed = true;
      if (!this.observedExit && !this.failure) {
        this.failure = new Error(`owned-PID exit observer closed (${code ?? "null"}/${signal ?? "none"}) without a kernel exit event${this.stderrTail ? `: ${this.stderrTail}` : ""}`);
      }
      this.signal.notify();
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line === "READY") this.registered = true;
      else if (line === "EXIT") this.observedExit = true;
      else if (line.startsWith("ERROR ")) this.failure = new Error(`owned-PID exit observer rejected registration: ${line.slice(6)}`);
      else if (line) this.failure = new Error("owned-PID exit observer emitted an unexpected record");
      this.signal.notify();
    }
  }

  async waitUntilRegistered(timeoutMs: number): Promise<void> {
    await this.signal.waitFor(() => this.registered || this.failure !== undefined || this.watcherClosed,
      timeoutMs, `kernel exit observer registration for owned PID ${this.pid}`);
    if (!this.registered) throw this.failure ?? new Error(`kernel exit observer closed before registering PID ${this.pid}`);
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    await this.signal.waitFor(() => this.observedExit || this.failure !== undefined || this.watcherClosed,
      timeoutMs, `kernel-observed exit for owned PID ${this.pid}`);
    if (!this.observedExit) throw this.failure ?? new Error(`kernel exit observer closed before PID ${this.pid} exited`);
  }

  async stop(): Promise<void> {
    if (this.watcherClosed) return;
    try { this.child.kill("SIGTERM"); } catch { /* this exact test-owned observer process only */ }
    try {
      await this.signal.waitFor(() => this.watcherClosed, CLEANUP_SIGNAL_TIMEOUT_MS,
        `owned-PID exit observer ${this.pid} termination`);
    } catch {
      try { this.child.kill("SIGKILL"); } catch { /* bounded escalation to the same observer handle */ }
      await this.signal.waitFor(() => this.watcherClosed, CLEANUP_SIGNAL_TIMEOUT_MS,
        `owned-PID exit observer ${this.pid} forced termination`).catch(() => undefined);
    }
  }
}

export function requiredOrSkip(t: { skip(message?: string): void }, message: string): undefined {
  if (process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1") {
    throw new Error(`required real native Main host unavailable: ${message}`);
  }
  t.skip(message);
  return undefined;
}

function nodeVersionMeetsFloor(): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

export function resolveRuntimePin(t: { skip(message?: string): void }): RuntimePin | undefined {
  if (process.env.PI_REVIEW_GATE_RUNTIME_ROLE || process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG) {
    throw new Error("real native Main verification is unavailable in a delegated runtime role");
  }
  if (process.platform !== "darwin") {
    t.skip("the real native Main proof is intentionally scoped to macOS; Linux and physical-keyboard claims are out of scope");
    return undefined;
  }
  if (!nodeVersionMeetsFloor()) {
    requiredOrSkip(t, "the real native Pi runtime requires stable Node >=22.19.0");
    return undefined;
  }

  const agentPin = process.env.PI_REVIEW_GATE_INSTALLED_AGENT?.trim();
  const piBinPin = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN?.trim();
  const expectedVersion = process.env.PI_REVIEW_GATE_EXPECT_PI_VERSION?.trim();
  if (!agentPin || !piBinPin || !expectedVersion) {
    requiredOrSkip(t, "explicit installed Pi package, Node CLI, and version pins are required");
    return undefined;
  }
  if (expectedVersion !== "1.1.0") {
    requiredOrSkip(t, "this native Main integration phase pins Pi 1.1.0");
    return undefined;
  }

  let agentDir: string;
  let packageInfo: { name?: string; version?: string; bin?: string | Record<string, string> };
  try {
    agentDir = realpathSync(resolve(agentPin));
    packageInfo = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")) as typeof packageInfo;
  } catch {
    requiredOrSkip(t, "the explicitly pinned installed Pi package is unavailable or unreadable");
    return undefined;
  }
  if (packageInfo.name !== "@earendil-works/pi-coding-agent" || packageInfo.version !== expectedVersion) {
    requiredOrSkip(t, "the explicit runtime pin is not the expected @earendil-works/pi-coding-agent 1.1.0 package");
    return undefined;
  }

  const declaredBin = typeof packageInfo.bin === "string" ? packageInfo.bin : packageInfo.bin?.pi;
  const declaredEntry = typeof declaredBin === "string" ? join(agentDir, declaredBin) : undefined;
  const supportedEntries = new Set<string>();
  for (const candidate of [declaredEntry, join(agentDir, "dist", "cli.js")]) {
    if (!candidate) continue;
    try {
      const real = realpathSync(candidate);
      const rel = relative(agentDir, real);
      if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) supportedEntries.add(real);
    } catch {
      // The other public package-declared/supported Node CLI path may exist.
    }
  }
  if (supportedEntries.size === 0) {
    requiredOrSkip(t, "the pinned Pi package has no contained supported Node CLI entry");
    return undefined;
  }

  let piExecutable: string;
  try {
    const pinnedPath = realpathSync(resolve(piBinPin));
    const pinnedStats = statSync(pinnedPath);
    if (pinnedStats.isDirectory()) {
      const expectedBinDirectory = realpathSync(join(dirname(dirname(agentDir)), ".bin"));
      if (pinnedPath !== expectedBinDirectory) {
        requiredOrSkip(t, "the installed Pi bin-directory pin does not belong to the explicit Pi package");
        return undefined;
      }
      piExecutable = [...supportedEntries][0]!;
    } else if (pinnedStats.isFile() && supportedEntries.has(pinnedPath)) {
      piExecutable = pinnedPath;
    } else {
      requiredOrSkip(t, "the installed Pi CLI pin must identify its supported Node entry, not a shell shim");
      return undefined;
    }
  } catch {
    requiredOrSkip(t, "the explicitly pinned native Pi Node CLI is unavailable");
    return undefined;
  }

  const projectRoot = resolve(process.cwd());
  const requireFromProject = createRequire(join(projectRoot, "package.json"));
  let pty: NativePtyModule;
  try {
    for (const name of ["@xterm/headless", "@xterm/addon-unicode11", "@lydell/node-pty"]) {
      requireFromProject.resolve(name);
    }
    pty = requireFromProject("@lydell/node-pty") as NativePtyModule;
  } catch {
    requiredOrSkip(t, "the real native PTY and production terminal-surface dependencies are unavailable");
    return undefined;
  }

  const nodeModulesRoot = dirname(dirname(agentDir));
  const nodePath = [
    join(projectRoot, "node_modules"),
    join(agentDir, "node_modules"),
    nodeModulesRoot,
  ].filter((path) => {
    try {
      const stats = lstatSync(path);
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }).join(delimiter);
  if (!nodePath) {
    requiredOrSkip(t, "the project and pinned runtime dependency-resolution roots are unavailable");
    return undefined;
  }

  return { agentDir, piExecutable, version: expectedVersion, nodePath, pty };
}

export function createOwnedScratchRoot(): string {
  // Source stays in the checkout; private runtime artifacts need a short
  // macOS Unix-socket path, independently of checkout-path length.
  const parent = realpathSync("/tmp");
  const parentStats = lstatSync(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("the canonical temporary parent is not a real directory");
  }
  const socketTemplate = join(parent, "shm-XXXXXX", "tmp", "prg-st-XXXXXX", "s.sock");
  if (Buffer.byteLength(socketTemplate, "utf8") > 103) {
    throw new Error("the owned Main scratch would exceed the broker socket-path limit");
  }
  const root = mkdtempSync(join(parent, "shm-"));
  chmodSync(root, 0o700);
  const canonical = realpathSync(root);
  const stats = lstatSync(canonical);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !canonical.startsWith(`${parent}${sep}`)) {
    throw new Error("the owned Main scratch root is not a real directory under its temporary parent");
  }
  assert.ok(Buffer.byteLength(join(canonical, "tmp", "prg-st-XXXXXX", "s.sock"), "utf8") <= 103,
    "the owned Main broker socket path fits the macOS limit before spawning Main");
  return canonical;
}

interface CopyBudget {
  files: number;
  bytes: number;
}

/**
 * Bounded candidate-staging ceilings. The shipped staging contract is 8 MiB
 * per leaf, 128 MiB aggregate, 20 000 files, depth 40, and 2 048 directories.
 * The explicit copy seam may LOWER these for a synthetic proof (a strictly
 * stronger check) but never raises them.
 */
export interface CandidateCopyBounds {
  readonly maxLeafBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxDirectories: number;
}

const CANDIDATE_COPY_BOUNDS: CandidateCopyBounds = {
  maxLeafBytes: 8 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFiles: 20_000,
  maxDepth: 40,
  maxDirectories: 2_048,
};

const CANDIDATE_COPY_CHUNK_BYTES = 1024 * 1024;

/**
 * Test-only injectable bounded file-I/O seam for the candidate copier.
 *
 * The default implementation is the real descriptor operations, and production
 * staging never substitutes this seam; only the explicit synthetic copy entry
 * point may. A test wraps one operation to induce a bounded short write or a
 * mid-copy source swap. Identity checks, budgets, exclusive creation, and byte
 * accounting stay real: the seam can make an operation observably worse, never
 * weaken a check.
 */
export interface CandidateCopyFileIo {
  openSource(path: string): number;
  openDestination(path: string, mode: number): number;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  write(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  fstat(fd: number): BigIntStats;
  fchmod(fd: number, mode: number): void;
  close(fd: number): void;
}

const READONLY_NOFOLLOW_NONBLOCK =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const EXCLUSIVE_NOFOLLOW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

const REAL_CANDIDATE_COPY_FILE_IO: CandidateCopyFileIo = {
  openSource: (path) => openSync(path, READONLY_NOFOLLOW_NONBLOCK),
  openDestination: (path, mode) => openSync(path, EXCLUSIVE_NOFOLLOW, mode),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  write: (fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, length, position),
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  fchmod: (fd, mode) => fchmodSync(fd, mode),
  close: (fd) => closeSync(fd),
};

/** A real-directory identity receipt captured with BigInt dev/ino. */
interface OwnedDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface SourceLeafReceipt extends OwnedDirectory {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface StageContext {
  readonly budget: CopyBudget;
  readonly bounds: CandidateCopyBounds;
  readonly io: CandidateCopyFileIo;
  /** Trusted destination ancestors above the staging base (the scratch root). */
  readonly ancestors: readonly OwnedDirectory[];
  /** The directory that directly contains every staged tree root. */
  readonly stagingBase: OwnedDirectory;
  /** Every established destination receipt, keyed by path, retained across entries. */
  readonly owned: Map<string, OwnedDirectory>;
  directories: number;
}

function realDirectoryReceipt(path: string): OwnedDirectory {
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("owned candidate staging refused a linked or non-directory destination ancestor");
  }
  return { path, dev: stats.dev, ino: stats.ino };
}

/**
 * Re-verify every established destination-ancestor receipt: a real directory
 * carrying the exact captured BigInt dev/ino. This is a PATH re-inspection. It
 * detects a replaced or swapped ancestor between our own operations, but it is
 * NOT an atomic `openat` containment guarantee: a same-identity swap that lstat
 * cannot observe stays residual uncertainty, never a claim. Any doubt fails
 * closed and leaves already-written bytes in place.
 */
function verifyOwnedDirectories(chain: readonly OwnedDirectory[]): void {
  for (const receipt of chain) {
    const stats = lstatSync(receipt.path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()
        || stats.dev !== receipt.dev || stats.ino !== receipt.ino) {
      throw new Error("owned candidate staging detected a replaced or linked destination ancestor");
    }
  }
}

/**
 * Establish `destination` below an already-verified real directory chain.
 *
 * The directory and depth budgets are checked BEFORE any allocation or descent,
 * and every destination directory component (including intermediate components
 * created for nested manifest leaves) is counted exactly once. A missing
 * component is created non-recursively under the verified parent and its BigInt
 * receipt is retained in `ctx.owned` for the whole staging operation. A
 * component that is already established is reused only when its live identity
 * still matches the retained receipt; a pre-existing real directory that this
 * operation did not establish, and any linked or special component, fails
 * closed.
 */
function ensureOwnedPath(
  destination: string,
  parents: readonly OwnedDirectory[],
  ctx: StageContext,
): OwnedDirectory[] {
  const current = parents[parents.length - 1]!;
  verifyOwnedDirectories(parents);
  if (destination === current.path) return [...parents];
  const rel = relative(current.path, destination);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("owned candidate staging refused a destination outside its owned directory base");
  }
  const chainBaseLength = ctx.ancestors.length + 1;
  const result = [...parents];
  let cursor = current.path;
  for (const component of rel.split(sep)) {
    if (!component || component === "." || component === "..") {
      throw new Error("owned candidate staging refused an empty or relative destination component");
    }
    const depth = result.length - chainBaseLength + 1;
    if (depth > ctx.bounds.maxDepth) {
      throw new Error("owned candidate staging exceeded its destination-depth bound");
    }
    verifyOwnedDirectories(result);
    const next = join(cursor, component);
    const established = ctx.owned.get(next);
    if (established) {
      verifyOwnedDirectories([established]);
      result.push(established);
    } else {
      let stats: BigIntStats | undefined;
      try {
        stats = lstatSync(next, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (stats) {
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error("owned candidate staging refused a linked or non-directory destination ancestor");
        }
        throw new Error("owned candidate staging refused a pre-existing destination directory it did not establish");
      }
      // The directory budget is checked before the allocation; reused
      // components never consume it twice.
      if (ctx.directories >= ctx.bounds.maxDirectories) {
        throw new Error("owned candidate staging exceeded its directory bound");
      }
      ctx.directories += 1;
      mkdirSync(next, { mode: 0o700 });
      const created = lstatSync(next, { bigint: true });
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("owned candidate staging could not establish a real destination directory");
      }
      const receipt: OwnedDirectory = { path: next, dev: created.dev, ino: created.ino };
      ctx.owned.set(next, receipt);
      result.push(receipt);
    }
    verifyOwnedDirectories(result);
    cursor = next;
  }
  return result;
}

function realSourceDirectoryReceipt(path: string): OwnedDirectory {
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("owned candidate staging requires a real, non-linked source directory");
  }
  return { path, dev: stats.dev, ino: stats.ino };
}

/**
 * Re-verify a complete source-directory receipt chain (trusted base through the
 * current component): each must still be a real, non-linked directory with the
 * exact captured BigInt dev/ino. Source intermediates are never realpath-
 * followed and never recaptured, so a linked or replaced ancestor fails closed.
 */
function verifySourceDirectories(chain: readonly OwnedDirectory[]): void {
  for (const receipt of chain) {
    const stats = lstatSync(receipt.path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()
        || stats.dev !== receipt.dev || stats.ino !== receipt.ino) {
      throw new Error("owned candidate staging detected a replaced or linked source ancestor");
    }
  }
}

/**
 * Build and retain the source-directory receipt chain from a trusted real base
 * through every selected intermediate component down to `target`. A linked or
 * special intermediate (or final) directory component fails closed, so a
 * `trustedBase/linked-parent/real-child` selection can never read outside the
 * trusted base.
 */
function sourceDirectoryChain(target: string, trustedBase: OwnedDirectory): OwnedDirectory[] {
  const rel = relative(trustedBase.path, target);
  if (rel === "") {
    verifySourceDirectories([trustedBase]);
    return [trustedBase];
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("owned candidate staging refused a source outside its trusted base");
  }
  const chain = [trustedBase];
  let cursor = trustedBase.path;
  for (const component of rel.split(sep)) {
    if (!component || component === "." || component === "..") {
      throw new Error("owned candidate staging refused an empty or relative source component");
    }
    const next = join(cursor, component);
    const stats = lstatSync(next, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("owned candidate staging refused a linked or non-directory source ancestor");
    }
    chain.push({ path: next, dev: stats.dev, ino: stats.ino });
    cursor = next;
  }
  verifySourceDirectories(chain);
  return chain;
}

/**
 * Copy one regular source leaf to an exclusively created destination leaf.
 *
 * `leaf` is the receipt inspected before this call; it must still match on disk
 * (identity, size, mtime, ctime), so a swap between inspection and the copy
 * fails closed. The source is then opened read-only with O_NOFOLLOW/O_NONBLOCK
 * and re-checked through its own descriptor (fstat) for the exact regular-file
 * identity, size, and bounds. Bytes are copied in bounded chunks; the open
 * descriptor, the source path, and the whole source-directory chain are
 * re-verified afterwards so a source swap, ancestor replacement, or in-place
 * mutation fails closed. The destination is created with O_EXCL/O_NOFOLLOW,
 * which rejects any pre-existing regular, linked, or special leaf without
 * overwriting or unlinking it. Permissions are applied through the verified
 * destination descriptor. Every real owned ancestor is re-verified before each
 * write and after publication, and a write that makes no positive bounded
 * progress fails while retaining the partial bytes.
 */
function copyBoundedRegularFile(
  leaf: SourceLeafReceipt,
  destination: string,
  ctx: StageContext,
  sourceChain: readonly OwnedDirectory[],
  destinationParents: readonly OwnedDirectory[],
): void {
  verifySourceDirectories(sourceChain);
  const before = lstatSync(leaf.path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()
      || before.dev !== leaf.dev || before.ino !== leaf.ino) {
    throw new Error("owned candidate staging detected a replaced source file before the copy");
  }
  if (before.size !== leaf.size || before.mtimeNs !== leaf.mtimeNs || before.ctimeNs !== leaf.ctimeNs) {
    throw new Error("owned candidate staging detected a changed source file before the copy");
  }
  if (before.size > BigInt(ctx.bounds.maxLeafBytes)) {
    throw new Error("owned candidate staging rejected an oversized source file");
  }
  const chain = ensureOwnedPath(dirname(destination), destinationParents, ctx);
  verifyOwnedDirectories(chain);

  const sourceFd = ctx.io.openSource(leaf.path);
  let destinationFd: number | undefined;
  try {
    const opened = ctx.io.fstat(sourceFd);
    if (!opened.isFile()
        || opened.dev !== leaf.dev || opened.ino !== leaf.ino || opened.size !== leaf.size) {
      throw new Error("owned candidate staging detected a replaced source file between inspect and open");
    }
    // A same-inode, same-size rewrite during the inspect/open gap would
    // otherwise become the new baseline for the post-copy checks; require the
    // descriptor's retained timestamps to match the inspected leaf receipt.
    if (opened.mtimeNs !== leaf.mtimeNs || opened.ctimeNs !== leaf.ctimeNs) {
      throw new Error("owned candidate staging detected a changed source file between inspect and open");
    }
    if (opened.size > BigInt(ctx.bounds.maxLeafBytes)) {
      throw new Error("owned candidate staging rejected an oversized source file");
    }
    ctx.budget.files += 1;
    ctx.budget.bytes += Number(opened.size);
    if (ctx.budget.files > ctx.bounds.maxFiles || ctx.budget.bytes > ctx.bounds.maxTotalBytes) {
      throw new Error("owned candidate staging exceeded its aggregate file bound");
    }

    destinationFd = ctx.io.openDestination(destination, Number(opened.mode & 0o777n));
    verifyOwnedDirectories(chain);
    const createdPath = lstatSync(destination, { bigint: true });
    const createdFd = ctx.io.fstat(destinationFd);
    if (createdPath.isSymbolicLink() || !createdPath.isFile()
        || createdPath.dev !== createdFd.dev || createdPath.ino !== createdFd.ino) {
      throw new Error("owned candidate staging detected a replaced or linked destination file");
    }

    const size = Number(opened.size);
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CANDIDATE_COPY_CHUNK_BYTES, size)));
    let position = 0;
    while (position < size) {
      const wanted = Math.min(buffer.length, size - position);
      const read = ctx.io.read(sourceFd, buffer, 0, wanted, position);
      if (read <= 0) throw new Error("owned candidate staging source read made no bounded progress");
      if (read > wanted) throw new Error("owned candidate staging source read exceeded its bounded request");
      let written = 0;
      while (written < read) {
        verifyOwnedDirectories(chain);
        const delta = ctx.io.write(destinationFd, buffer, written, read - written, position + written);
        if (delta <= 0) throw new Error("owned candidate staging destination write made no bounded progress");
        written += delta;
      }
      position += read;
    }

    const afterFd = ctx.io.fstat(sourceFd);
    if (afterFd.dev !== opened.dev || afterFd.ino !== opened.ino
        || afterFd.size !== opened.size
        || afterFd.mtimeNs !== opened.mtimeNs || afterFd.ctimeNs !== opened.ctimeNs) {
      throw new Error("owned candidate staging detected a source mutation during the copy");
    }
    const afterPath = lstatSync(leaf.path, { bigint: true });
    if (afterPath.isSymbolicLink() || !afterPath.isFile()
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
        || afterPath.size !== opened.size
        || afterPath.mtimeNs !== opened.mtimeNs || afterPath.ctimeNs !== opened.ctimeNs) {
      throw new Error("owned candidate staging detected a source path swap during the copy");
    }
    verifySourceDirectories(sourceChain);

    ctx.io.fchmod(destinationFd, Number(opened.mode & 0o777n));
    verifyOwnedDirectories(chain);
    const published = lstatSync(destination, { bigint: true });
    const publishedFd = ctx.io.fstat(destinationFd);
    if (published.isSymbolicLink() || !published.isFile()
        || published.dev !== publishedFd.dev || published.ino !== publishedFd.ino
        || published.size !== opened.size) {
      throw new Error("owned candidate staging detected a replaced destination file after publication");
    }
  } finally {
    if (destinationFd !== undefined) ctx.io.close(destinationFd);
    ctx.io.close(sourceFd);
  }
}

/**
 * Copy one selected source tree into an owned destination tree.
 *
 * `.terraform` is pruned by name BEFORE lstat/readdir/descent at every depth,
 * including synthetic source roots. The source root and every intermediate are
 * real, non-linked directories whose retained receipt chain is re-verified
 * around every iteration; the identity inspected in the parent loop is passed
 * into the recursion and required, never recaptured. Directory iteration is
 * bounded (`opendirSync`/`readSync`) so an oversized directory never has its
 * full name array materialized. Linked or special source entries and linked
 * destination ancestors fail closed. The copier never realpaths a source root,
 * so it makes no link-following containment claim for it.
 */
function copyBoundedTree(
  sourceChain: readonly OwnedDirectory[],
  destinationRoot: string,
  ctx: StageContext,
): void {
  const visit = (
    chain: readonly OwnedDirectory[],
    destination: string,
    destinationParents: readonly OwnedDirectory[],
  ): void => {
    const source = chain[chain.length - 1]!.path;
    verifySourceDirectories(chain);
    const destinationChain = ensureOwnedPath(destination, destinationParents, ctx);
    verifyOwnedDirectories(destinationChain);

    const directory = opendirSync(source);
    try {
      for (;;) {
        verifySourceDirectories(chain);
        verifyOwnedDirectories(destinationChain);
        const entry = directory.readSync();
        if (entry === null) break;
        const name = entry.name;
        // Exclude initialized Terraform data before lstat, readdir, or descent
        // at every depth, including inside the synthetic source roots.
        if (name === ".terraform") continue;
        const sourceEntry = join(source, name);
        const destinationEntry = join(destination, name);
        const entryStats = lstatSync(sourceEntry, { bigint: true });
        if (entryStats.isSymbolicLink()) {
          throw new Error("owned candidate staging rejected a linked source entry");
        }
        if (entryStats.isDirectory()) {
          const sourceReceipt: OwnedDirectory = {
            path: sourceEntry, dev: entryStats.dev, ino: entryStats.ino,
          };
          visit([...chain, sourceReceipt], destinationEntry, destinationChain);
        } else if (entryStats.isFile()) {
          const leaf: SourceLeafReceipt = {
            path: sourceEntry,
            dev: entryStats.dev,
            ino: entryStats.ino,
            size: entryStats.size,
            mtimeNs: entryStats.mtimeNs,
            ctimeNs: entryStats.ctimeNs,
          };
          copyBoundedRegularFile(leaf, destinationEntry, ctx, chain, destinationChain);
        } else {
          throw new Error("owned candidate staging rejected a special source entry");
        }
      }
    } finally {
      directory.closeSync();
    }
    verifySourceDirectories(chain);
    verifyOwnedDirectories(destinationChain);
  };
  visit(sourceChain, destinationRoot, [...ctx.ancestors, ctx.stagingBase]);
}

/**
 * Read a bounded regular manifest through a validated descriptor: lstat first,
 * then a real read-only no-follow descriptor whose fstat identity/size must
 * match, then bounded reads. The descriptor and path are revalidated after the
 * read (identity, size, mtime, ctime), so a torn or replaced manifest fails
 * closed. The returned leaf receipt must match again when the manifest is
 * staged, so the selected file list always corresponds to the staged
 * package.json.
 */
function readBoundedManifest(
  path: string,
  io: CandidateCopyFileIo = REAL_CANDIDATE_COPY_FILE_IO,
): { manifest: Buffer; leaf: SourceLeafReceipt } {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()
      || before.size > BigInt(CANDIDATE_COPY_BOUNDS.maxLeafBytes)) {
    throw new Error("candidate staging requires a real, bounded package manifest");
  }
  const fd = io.openSource(path);
  try {
    const opened = io.fstat(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size) {
      throw new Error("candidate staging detected a replaced package manifest");
    }
    if (opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      throw new Error("candidate staging detected a changed package manifest between inspect and open");
    }
    const size = Number(opened.size);
    const buffer = Buffer.allocUnsafe(Math.max(1, size));
    let position = 0;
    while (position < size) {
      const read = io.read(fd, buffer, position, size - position, position);
      if (read <= 0) throw new Error("candidate staging package manifest read made no bounded progress");
      position += read;
    }
    const afterFd = io.fstat(fd);
    if (afterFd.dev !== opened.dev || afterFd.ino !== opened.ino
        || afterFd.size !== opened.size
        || afterFd.mtimeNs !== opened.mtimeNs || afterFd.ctimeNs !== opened.ctimeNs) {
      throw new Error("candidate staging detected a package manifest mutation during the read");
    }
    const afterPath = lstatSync(path, { bigint: true });
    if (afterPath.isSymbolicLink() || !afterPath.isFile()
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
        || afterPath.size !== opened.size
        || afterPath.mtimeNs !== opened.mtimeNs || afterPath.ctimeNs !== opened.ctimeNs) {
      throw new Error("candidate staging detected a package manifest path swap during the read");
    }
    return {
      manifest: buffer.subarray(0, size),
      leaf: {
        path,
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeNs: opened.mtimeNs,
        ctimeNs: opened.ctimeNs,
      },
    };
  } finally {
    io.close(fd);
  }
}

/**
 * Reject unsafe shipped manifest entries BEFORE any access. Public package files
 * are accepted as relative strings only: empty, home-relative, absolute,
 * drive-qualified, traversal, `.terraform`, `.git`, and `node_modules`
 * components all fail closed.
 */
function validateShippedEntry(shippedEntry: string): string {
  if (!shippedEntry || shippedEntry.startsWith("~")) {
    throw new Error("candidate staging rejected an empty or home-relative package file entry");
  }
  if (isAbsolute(shippedEntry) || /^[A-Za-z]:/.test(shippedEntry)) {
    throw new Error("candidate staging rejected an absolute package file entry");
  }
  const components = shippedEntry.split(/[\\/]+/);
  for (const component of components) {
    if (!component || component === "." || component === ".."
        || component === ".terraform" || component === ".git" || component === "node_modules") {
      throw new Error("candidate staging rejected an unsafe package file entry");
    }
  }
  return join(...components);
}

/**
 * Resolve test bounds overrides. A test may only LOWER a ceiling: every value
 * must be a finite non-negative integer no greater than its shipped default, so
 * `Infinity`, `NaN`, fractional, negative, and raised ceilings are rejected
 * before any filesystem work.
 */
function resolveCandidateCopyBounds(overrides?: Partial<CandidateCopyBounds>): CandidateCopyBounds {
  if (!overrides) return { ...CANDIDATE_COPY_BOUNDS };
  const bounds: Record<string, number> = { ...CANDIDATE_COPY_BOUNDS };
  for (const key of Object.keys(CANDIDATE_COPY_BOUNDS) as (keyof CandidateCopyBounds)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)
        || value < 0 || value > CANDIDATE_COPY_BOUNDS[key]) {
      throw new Error("candidate copy test bounds may only lower a finite non-negative integer ceiling");
    }
    bounds[key] = value;
  }
  return bounds as unknown as CandidateCopyBounds;
}

/**
 * Explicit synthetic-copy seam.
 *
 * Only a test may call this. It drives the SAME bounded copier that stages the
 * native candidate against caller-created real destination directories, with
 * optional bounded overrides (which may only make the checks stricter) and an
 * optional trusted source base that exercises the intermediate-source-ancestor
 * checks. A synthetic copy is evidence about the copier's
 * file/identity/exclusivity behavior only: it never proves the native runtime,
 * tsc, or a real candidate.
 */
export interface CandidateCopyTestOptions {
  readonly fileIo?: Partial<CandidateCopyFileIo>;
  readonly bounds?: Partial<CandidateCopyBounds>;
  readonly sourceTrustedBase?: string;
}

export function stageCandidateTreeForTest(
  sourceRoot: string,
  destinationRoot: string,
  options?: CandidateCopyTestOptions,
): void {
  const bounds = resolveCandidateCopyBounds(options?.bounds);
  const base = realDirectoryReceipt(destinationRoot);
  const io: CandidateCopyFileIo = { ...REAL_CANDIDATE_COPY_FILE_IO, ...(options?.fileIo ?? {}) };
  const sourceRootStats = lstatSync(sourceRoot, { bigint: true });
  if (sourceRootStats.isSymbolicLink() || !sourceRootStats.isDirectory()) {
    throw new Error("owned candidate staging requires a real, non-linked source directory");
  }
  const sourceChain = options?.sourceTrustedBase
    ? sourceDirectoryChain(sourceRoot, realDirectoryReceipt(options.sourceTrustedBase))
    : [realSourceDirectoryReceipt(sourceRoot)];
  const ctx: StageContext = {
    budget: { files: 0, bytes: 0 },
    bounds,
    io,
    ancestors: [],
    stagingBase: base,
    owned: new Map([[base.path, base]]),
    directories: 0,
  };
  copyBoundedTree(sourceChain, destinationRoot, ctx);
}

/**
 * Explicit synthetic-manifest seam: run the same bounded manifest read against
 * a caller-supplied file with an optional injectable I/O override. Test-only;
 * production reads the real package manifest.
 */
export interface CandidateManifestTestOptions {
  readonly fileIo?: Partial<CandidateCopyFileIo>;
}

export function readCandidateManifestForTest(path: string, options?: CandidateManifestTestOptions): number {
  const io: CandidateCopyFileIo = { ...REAL_CANDIDATE_COPY_FILE_IO, ...(options?.fileIo ?? {}) };
  return readBoundedManifest(path, io).manifest.byteLength;
}

export function compileAndStageCandidate(root: string): CandidatePackage {
  const projectRoot = resolve(process.cwd());
  const requireFromProject = createRequire(join(projectRoot, "package.json"));
  const compiler = requireFromProject.resolve("typescript/bin/tsc");
  // The caller passes a canonical scratch root (createOwnedScratchRoot realpaths
  // it); this staging path verifies it is real but never re-resolves or follows
  // it, so it makes no link-following containment claim for the root.
  const rootStats = lstatSync(root, { bigint: true });
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("owned candidate staging requires a real, non-linked scratch root");
  }
  const scratchReceipt: OwnedDirectory = { path: root, dev: rootStats.dev, ino: rootStats.ino };
  const projectRootStats = lstatSync(projectRoot, { bigint: true });
  if (projectRootStats.isSymbolicLink() || !projectRootStats.isDirectory()) {
    throw new Error("owned candidate staging requires a real, non-linked project root");
  }
  const projectReceipt: OwnedDirectory = {
    path: projectRoot, dev: projectRootStats.dev, ino: projectRootStats.ino,
  };
  const compiledRoot = join(root, "compiled");
  const build = spawnSync(process.execPath, [
    compiler,
    "-p",
    join(projectRoot, "tsconfig.json"),
    "--outDir",
    compiledRoot,
    "--pretty",
    "false",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (build.error || build.status !== 0) {
    throw new Error(
      `scratch TypeScript production build failed (status ${String(build.status)}):\n`
      + `${build.stdout ?? ""}\n${build.stderr ?? ""}\n${String(build.error ?? "")}`,
    );
  }
  // The scratch root must still be the same real directory after the compiler
  // ran; a swap during compilation fails closed before any staging write.
  verifySourceDirectories([scratchReceipt]);

  const candidateRoot = join(root, "candidate-package");
  // The destination package root is created exclusively: a pre-existing entry
  // (regular, linked, or special) fails closed rather than being reused.
  let existingCandidate: BigIntStats | undefined = undefined;
  try {
    existingCandidate = lstatSync(candidateRoot, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existingCandidate) {
    throw new Error("owned candidate staging refused a pre-existing candidate package root");
  }
  verifySourceDirectories([scratchReceipt]);
  mkdirSync(candidateRoot, { mode: 0o700 });
  const candidateReceipt = realDirectoryReceipt(candidateRoot);
  verifyOwnedDirectories([scratchReceipt, candidateReceipt]);

  const ctx: StageContext = {
    budget: { files: 0, bytes: 0 },
    bounds: CANDIDATE_COPY_BOUNDS,
    io: REAL_CANDIDATE_COPY_FILE_IO,
    ancestors: [scratchReceipt],
    stagingBase: candidateReceipt,
    owned: new Map([
      [scratchReceipt.path, scratchReceipt],
      [candidateReceipt.path, candidateReceipt],
    ]),
    directories: 0,
  };
  const compiledSrcChain = sourceDirectoryChain(join(compiledRoot, "src"), scratchReceipt);
  copyBoundedTree(compiledSrcChain, join(candidateRoot, "dist", "src"), ctx);

  // The shipped-file list and the package.json later staged come from the same
  // verified manifest snapshot; the manifest leaf receipt is enforced at copy.
  const manifestRead = readBoundedManifest(join(projectRoot, "package.json"));
  const manifest = JSON.parse(manifestRead.manifest.toString("utf8")) as { files?: unknown };
  if (!Array.isArray(manifest.files)) throw new Error("the real package manifest has no shipped-file list");
  for (const shippedEntry of manifest.files) {
    if (typeof shippedEntry !== "string") throw new Error("candidate staging rejected a non-string package file entry");
    if (shippedEntry === "dist/src") continue;
    const entryRelative = validateShippedEntry(shippedEntry);
    const source = join(projectRoot, entryRelative);
    const sourceRelative = relative(projectRoot, source);
    if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
      throw new Error("candidate staging rejected a package file entry outside the source root");
    }
    const destination = join(candidateRoot, sourceRelative);
    const stats = lstatSync(source, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new Error("candidate staging rejected a linked package file entry");
    }
    if (stats.isDirectory()) {
      copyBoundedTree(sourceDirectoryChain(source, projectReceipt), destination, ctx);
    } else if (stats.isFile()) {
      const leaf: SourceLeafReceipt = {
        path: source, dev: stats.dev, ino: stats.ino,
        size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs,
      };
      copyBoundedRegularFile(leaf, destination, ctx, sourceDirectoryChain(dirname(source), projectReceipt),
        [...ctx.ancestors, ctx.stagingBase]);
    } else {
      throw new Error("candidate staging rejected a special package file entry");
    }
  }
  copyBoundedRegularFile(manifestRead.leaf, join(candidateRoot, "package.json"), ctx,
    sourceDirectoryChain(projectRoot, projectReceipt), [...ctx.ancestors, ctx.stagingBase]);
  const entry = join(candidateRoot, "dist", "src", "index.js");
  assert.ok(existsSync(entry), "the scratch candidate contains the real compiled extension entry");
  assert.ok(existsSync(join(candidateRoot, "dist", "src", "session-host", "reporter.js")));
  assert.ok(existsSync(join(candidateRoot, "dist", "src", "session-host", "bootstrap-preload.js")));
  return { root: candidateRoot, entry };
}

function makeSafePath(): string {
  return [...new Set([
    dirname(process.execPath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(delimiter);
}

export function createEditorExecutable(root: string, targetPath: string, logPath: string): string {
  const editor = join(root, "owned-editor");
  const source = `#!/usr/bin/env node\n'use strict';\n`
    + `const fs = require('node:fs');\n`
    + `const target = process.argv[2];\n`
    + `const original = fs.readFileSync(target, 'utf8');\n`
    + `const value = process.env.PRG_SESSION_HOST_NATIVE_MAIN_EDITOR_VALUE;\n`
    + `fs.writeFileSync(target, value, 'utf8');\n`
    + `fs.appendFileSync(process.env.PRG_SESSION_HOST_NATIVE_MAIN_EDITOR_LOG, `
    + `JSON.stringify({ type: 'external-editor', target, original, value }) + '\\n', 'utf8');\n`;
  writeFileSync(editor, source, { mode: 0o700 });
  chmodSync(editor, 0o700);
  assert.ok(isAbsolute(targetPath) && isAbsolute(logPath));
  return editor;
}

export function makeRuntimeEnvironment(
  root: string,
  runtime: RuntimePin,
  editor: string,
  observerFile: string,
  editorLog: string,
  editorValue: string,
  nativeAgentDir = makeNativeAgentRoot(root),
): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  for (const path of [home, join(home, ".config"), temporary]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return {
    PATH: makeSafePath(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: nativeAgentDir,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    NODE_PATH: runtime.nodePath,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    EDITOR: editor,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    [OBSERVER_ENV]: observerFile,
    PRG_SESSION_HOST_NATIVE_MAIN_EDITOR_LOG: editorLog,
    PRG_SESSION_HOST_NATIVE_MAIN_EDITOR_VALUE: editorValue,
  };
}

/** Create one ordinary, fixture-owned Pi agent root shared by every child. */
export function makeNativeAgentRoot(
  scratchRoot: string,
  options: { readonly deferredPiTools?: boolean } = {},
): string {
  const scratch = realpathSync(scratchRoot);
  const agentDir = join(scratch, "native-agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const agentStats = lstatSync(agentDir);
  if (!agentStats.isDirectory() || agentStats.isSymbolicLink()) {
    throw new Error("synthetic native agent root is not a real directory");
  }
  chmodSync(agentDir, 0o700);
  const canonicalAgentDir = realpathSync(agentDir);
  const relativeAgentDir = relative(scratch, canonicalAgentDir);
  if (relativeAgentDir === ".." || relativeAgentDir.startsWith(`..${sep}`) || isAbsolute(relativeAgentDir)) {
    throw new Error("synthetic native agent root escaped its owned scratch fixture");
  }
  const execution: Record<string, unknown> = {
    workerResources: {},
    routes: { execute: [], research: [] },
  };
  if (options.deferredPiTools !== undefined) execution.deferredPiTools = options.deferredPiTools;
  writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {},
    execution,
  }, undefined, 2), { mode: 0o600, flag: "wx" });
  return canonicalAgentDir;
}

/** Observe the real native session_info name entry in an owned session file. */
export function sessionFileHasStoredName(sessionFile: string, expectedName: string): boolean {
  const stats = lstatSync(sessionFile);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 8 * 1024 * 1024) {
    throw new Error("owned native session file is not a bounded regular file");
  }
  let latestName: unknown;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (entry.type === "session_info") latestName = entry.name;
    } catch {
      // Ignore only an incomplete append; complete native entries are checked.
    }
  }
  return latestName === expectedName;
}

function readRecords(path: string): SessionRecord[] {
  if (!existsSync(path)) return [];
  const records: SessionRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {
      // An append may be observed between its write and trailing newline.
    }
  }
  return records;
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function processIsAlive(pidValue: number | undefined): boolean {
  if (!Number.isSafeInteger(pidValue) || (pidValue ?? 0) <= 0) return false;
  try {
    process.kill(pidValue!, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Compatibility entry point: retain native runtime witnesses, including success.
 * Root creation alone does not prove ownership of every descendant subsequently
 * written there. Until each removable entry has a positive creation/identity
 * receipt, do not enumerate, descend, unlink, or remove any of them. This also
 * preserves unknown/replaced entries and initialized Terraform contents.
 */
export function removeOwnedScratchTreePruningTerraform(root: string): boolean {
  void root;
  return false;
}

function frameText(surface: TerminalSurface): string {
  return surface.frame().lines.map(stripGeneratedSgr).join("\n");
}

function countExitedCards(text: string, sidebarCols: number): number {
  return parseRosterFrame(text, sidebarCols).cards
    .filter((card) => card.status === "exited (code 0)").length;
}

/** Observe the native Editor's bordered content row, not its label/top border. */
export function nativeFormFieldIsEmpty(text: string, marker: "> Workspace:" | "> New name:"): boolean {
  const rows = text.split("\n");
  const index = rows.findIndex((line) => line.includes(marker));
  if (index < 0) return false;
  const start = rows[index]!.indexOf(marker) + marker.length + 1;
  const top = rows[index]!.slice(start).trim();
  const body = rows[index + 1]?.slice(start);
  const bottom = rows[index + 2]?.slice(start).trim();
  // Require the real empty single-line Editor structure. A missing content
  // row, text draft, menu, or mere blank label is never evidence of clearance.
  return /^─+$/.test(top) && body !== undefined && body.trim() === ""
    && bottom !== undefined && /^─+$/.test(bottom);
}

function workspaceFieldIsEmpty(text: string): boolean {
  return nativeFormFieldIsEmpty(text, "> Workspace:");
}

/** Main-focused roster footer hints; sidebar-only actions are stale here. */
const MAIN_FOCUS_FOOTER_HINTS = ["F8 toggle", "enter open", "esc hide", "q quit"] as const;
/** Hints drawn only while a sidebar-owned surface owns input. */
const SIDEBAR_ONLY_FOOTER_HINTS = ["e edit name", "d stop/remove", "space expand", "alt+right main"] as const;
/** Bounded native editor prompt punctuation; never part of the compared draft. */
const NATIVE_EDITOR_PREFIX = /^[\s>│┃▏❯]+/u;

/** Roster footer text after the complete entry extent, or undefined when incomplete. */
function rosterFooterText(text: string, sidebarColumns: number): string | undefined {
  const parsed = parseRosterFrame(text, sidebarColumns);
  if (!parsed.complete) return undefined;
  const pane = sidebarPaneLines(text, sidebarColumns);
  const offset = /^\s*Sessions \(\d+\)\s*$/u.test(pane[0] ?? "") ? 0 : 1;
  return pane.slice(offset + 1 + parsed.entryEnd)
    .filter((line) => line.trim().length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Exact native editor content: the whole row after its bounded prompt prefix
 * equals the draft, so appended or altered text is never accepted.
 */
export function nativeEditorContentMatches(line: string, draft: string): boolean {
  return line.trimEnd().replace(NATIVE_EDITOR_PREFIX, "") === draft;
}

/**
 * Complete restored wide native-editor witness. Requires the exact owner
 * header; the complete roster with its Main-focused footer and no stale
 * sidebar-only hints; and a width-correct bordered editor block in the right
 * pane whose content row is exactly the draft. A stale narrow frame (wrong
 * rule width), a partial repaint (incomplete roster or an unbordered content
 * row), or an altered/appended draft is rejected. Pure: no timers, no output
 * or geometry shortcuts.
 */
export function restoredNativeEditorFrame(
  text: string,
  options: {
    readonly ownerLabel: string;
    readonly draft: string;
    readonly sidebarColumns: number;
    readonly nativeWidth: number;
  },
): boolean {
  const { ownerLabel, draft, sidebarColumns, nativeWidth } = options;
  if (typeof ownerLabel !== "string" || ownerLabel.length === 0) return false;
  if (typeof draft !== "string" || draft.length === 0) return false;
  if (!Number.isSafeInteger(sidebarColumns) || sidebarColumns < 12 || sidebarColumns > 1000) return false;
  if (!Number.isSafeInteger(nativeWidth) || nativeWidth < 20 || nativeWidth > 1000) return false;
  if (!frameHeaderMatches(text, ownerLabel)) return false;
  const footer = rosterFooterText(text, sidebarColumns);
  if (footer === undefined) return false;
  for (const hint of MAIN_FOCUS_FOOTER_HINTS) if (!footer.includes(hint)) return false;
  for (const stale of SIDEBAR_ONLY_FOOTER_HINTS) if (footer.includes(stale)) return false;
  const rule = "─".repeat(nativeWidth);
  const pane = text.split("\n").slice(1).map((line) => stripGeneratedSgr(line).slice(sidebarColumns + 1));
  const trimmed = pane.map((line) => line.trimEnd());
  for (let index = 0; index + 2 < pane.length; index += 1) {
    if (trimmed[index] !== rule) continue;
    if (!nativeEditorContentMatches(pane[index + 1] ?? "", draft)) continue;
    if (trimmed[index + 2] === rule) return true;
  }
  return false;
}

export class MainPtyDriver {
  readonly pty: NativePtyHandle;
  readonly surface: TerminalSurface;
  readonly frameSignal = new ChangeSignal();
  readonly outputSignal = new ChangeSignal();
  readonly journalSignal = new ChangeSignal();
  readonly exitSignal = new ChangeSignal();
  readonly replyLog: string[] = [];
  readonly kittyFlagSnapshots: number[] = [];
  readonly ownedLabels = new Map<string, { rowProbe: string; currentName: string; displayName: string; workspace: string }>();
  readonly nativeExitWatchers = new Map<number, OwnedPidExitWatcher>();
  readonly submittedWorkspaces = new Set<string>();
  readonly removedWorkspaces = new Set<string>();
  readonly stateRoot: string;
  readonly observerFile: string;
  readonly resultFile: string;
  readonly editorLog: string;
  readonly ptyExitLog: string;
  readonly baseline: string;
  readonly watcher: FSWatcher;
  exitEvent?: PtyExit;
  parserError?: Error;
  private forcedCleanup = false;
  private selectedNativeTarget?: { readonly workspace: string; readonly pid: number; readonly sessionId: string };
  private rosterSelectionClearedByRemoval = false;
  frameRevision = 0;
  outputRevision = 0;
  sidebarVisible = true;
  focus: "sidebar" | "form" | "main" = "sidebar";
  pendingWorkspace?: string;
  private currentFrame = "";
  private outputTail = "";
  private sawAltEnter = false;
  private sawAltLeave = false;
  private sawCursorShow = false;
  private sawReset = false;
  private readonly dataSubscription: Disposable;
  private readonly exitSubscription: Disposable;

  private constructor(options: {
    pty: NativePtyHandle;
    observerFile: string;
    resultFile: string;
    stateRoot: string;
    editorLog: string;
    ptyExitLog: string;
    baseline: string;
    watcher: FSWatcher;
  }) {
    this.pty = options.pty;
    this.observerFile = options.observerFile;
    this.resultFile = options.resultFile;
    this.stateRoot = options.stateRoot;
    this.editorLog = options.editorLog;
    this.ptyExitLog = options.ptyExitLog;
    this.baseline = options.baseline;
    this.watcher = options.watcher;
    this.surface = new TerminalSurface(OUTER_COLS, OUTER_ROWS, {
      onReply: (reply) => {
        this.replyLog.push(reply);
        try { this.pty.write(reply); } catch { /* this owned outer PTY may have exited */ }
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
    this.watcher.on("change", (_event, filename) => {
      if (filename === null || filename.toString() === basenameOf(this.observerFile)) {
        this.journalSignal.notify();
      }
    });
  }

  static async start(options: {
    ptyModule: NativePtyModule;
    scratchRoot: string;
    candidate: CandidatePackage;
    runtime: RuntimePin;
    observerFile: string;
    editor: string;
    editorLog: string;
    editorValue: string;
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
  }): Promise<MainPtyDriver> {
    const stateRoot = join(options.scratchRoot, "native-state");
    // The transport option names an existing directory, not a profile root
    // that production creates. This fixture owns its exclusive creation.
    mkdirSync(stateRoot, { mode: 0o700 });
    const resultFile = join(options.scratchRoot, "main-result.json");
    const optionsFile = join(options.scratchRoot, "main-options.json");
    const ptyExitLog = join(options.scratchRoot, "pty-exits.jsonl");
    const observerDirectory = dirname(options.observerFile);
    mkdirSync(observerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(options.observerFile, "", { mode: 0o600 });
    writeFileSync(ptyExitLog, "", { mode: 0o600 });
    writeFileSync(join(options.scratchRoot, "pty-controls.jsonl"), "", { flag: "wx", mode: 0o600 });
    const args = options.args ?? [
      "--offline",
      "--no-context-files",
      "--no-themes",
      "--no-tools",
      "--extension",
      OBSERVER_FIXTURE,
    ];
    const env = options.env ?? makeRuntimeEnvironment(
      options.scratchRoot,
      options.runtime,
      options.editor,
      options.observerFile,
      options.editorLog,
      options.editorValue,
    );
    writeFileSync(optionsFile, JSON.stringify({
      packageRoot: options.candidate.root,
      piExecutable: options.runtime.piExecutable,
      stateRoot,
      toggleKey: "f8",
      args,
      env,
    }), { mode: 0o600 });

    const hostEnv: NodeJS.ProcessEnv = {
      PATH: makeSafePath(),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "xterm-256color",
      HOME: join(options.scratchRoot, "home"),
      TMPDIR: join(options.scratchRoot, "tmp"),
      NODE_PATH: options.runtime.nodePath,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      PRG_SESSION_HOST_NATIVE_MAIN_ENTRY: join(options.candidate.root, "dist", "src", "session-host", "main.js"),
      PRG_SESSION_HOST_NATIVE_MAIN_OPTIONS: optionsFile,
      PRG_SESSION_HOST_NATIVE_MAIN_RESULT: resultFile,
      PRG_SESSION_HOST_NATIVE_MAIN_BASELINE: BASELINE,
      PRG_SESSION_HOST_NATIVE_MAIN_PTY_EXIT_LOG: ptyExitLog,
      PRG_SESSION_HOST_NATIVE_MAIN_PTY_CONTROL_LOG: join(options.scratchRoot, "pty-controls.jsonl"),
      PI_REVIEW_GATE_CANDIDATE_ENTRY: options.candidate.entry,
      PI_REVIEW_GATE_INSTALLED_AGENT: process.env.PI_REVIEW_GATE_INSTALLED_AGENT,
      PI_REVIEW_GATE_INSTALLED_PI_BIN: process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN,
      PI_REVIEW_GATE_EXPECT_PI_VERSION: options.runtime.version,
      PI_REVIEW_GATE_REQUIRE_PI_HOST: "1",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    };
    const watcher = watch(observerDirectory);
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
      watcher.close();
      throw new Error("the test-owned outer PTY could not start the real public Main runner");
    }
    let startExitEvent: PtyExit | undefined;
    const startExitSignal = new ChangeSignal();
    const startExitSubscription = pty.onExit((event) => {
      startExitEvent = event;
      startExitSignal.notify();
    });
    try {
      const driver = new MainPtyDriver({
        pty,
        observerFile: options.observerFile,
        resultFile,
        stateRoot,
        editorLog: options.editorLog,
        ptyExitLog,
        baseline: BASELINE,
        watcher,
      });
      if (startExitEvent) {
        driver.exitEvent = startExitEvent;
        driver.exitSignal.notify();
        driver.frameSignal.notify();
      }
      startExitSubscription.dispose();
      return driver;
    } catch (error) {
      try { pty.kill("SIGTERM"); } catch { /* exact newly owned outer PTY only */ }
      try {
        await startExitSignal.waitFor(() => startExitEvent !== undefined, CLEANUP_SIGNAL_TIMEOUT_MS,
          "outer PTY exit after driver-construction failure");
      } catch {
        try { pty.kill("SIGKILL"); } catch { /* bounded escalation to the same outer PTY handle */ }
        await startExitSignal.waitFor(() => startExitEvent !== undefined, CLEANUP_SIGNAL_TIMEOUT_MS,
          "outer PTY forced exit after driver-construction failure").catch(() => undefined);
      }
      try { startExitSubscription.dispose(); } catch { /* owned outer exit subscription */ }
      try { watcher.close(); } catch { /* owned observer-directory watcher */ }
      const exitStatus = startExitEvent
        ? `outerExit=${startExitEvent.exitCode}/${startExitEvent.signal ?? 0}`
        : "outerExit=unconfirmed";
      throw new Error(`the owned Main PTY driver could not be constructed; ${exitStatus}; bounded outer TERM/KILL cleanup was attempted; native child exits remain unconfirmed: ${error instanceof Error ? error.message : "unknown constructor failure"}`);
    }
  }

  records(): SessionRecord[] {
    return readRecords(this.observerFile);
  }

  /** All positively owned native processes, including rows already removed from Main. */
  ownedSessions(): OwnedSession[] {
    const starts = this.records().filter((record) => record.type === "session_start");
    const seen = new Set<number>();
    const output: OwnedSession[] = [];
    for (const record of starts) {
      if (typeof record.pid !== "number" || seen.has(record.pid)) continue;
      seen.add(record.pid);
      const owned = record.cwd
        ? this.ownedLabels.get(realpathOrResolve(record.cwd)) ?? this.ownedLabels.get(record.cwd)
        : undefined;
      const exitWatcher = this.nativeExitWatchers.get(record.pid);
      if (owned && exitWatcher) output.push({ ...owned, record, exitWatcher });
    }
    return output;
  }

  /** Current Main roster only; historical process ownership stays in ownedSessions(). */
  sessions(): OwnedSession[] {
    return this.ownedSessions().filter((session) => !this.removedWorkspaces.has(session.workspace));
  }

  /**
   * Structural native Escape writes journaled for one exact owned child
   * (PID + workspace). Cancel/provenance witnesses compare this before and
   * after a host-owned action to prove no Escape reached the child.
   */
  nativeEscapeControlCount(pid: number | undefined, workspace: string): number {
    const file = join(dirname(this.ptyExitLog), "pty-controls.jsonl");
    if (!existsSync(file)) return 0;
    const stats = lstatSync(file);
    assert.ok(stats.isFile() && !stats.isSymbolicLink() && stats.size <= 64 * 1024,
      "the owned structural-control journal stays a bounded regular file");
    let found = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { type?: string; key?: string; pid?: number; cwd?: string };
        if (record.type === "pty_control" && record.key === "escape"
          && record.pid === pid && record.cwd === workspace) found += 1;
      } catch { /* a bounded watcher may see an incomplete append */ }
    }
    return found;
  }

  /** Observe idle Escape delivery without demanding a native no-op repaint. */
  async sendNativeEscapeAndObserve(session: OwnedSession): Promise<void> {
    assert.equal(this.focus, "main", "structural Escape targets an active native input owner");
    const file = join(dirname(this.ptyExitLog), "pty-controls.jsonl");
    const count = (): number => this.nativeEscapeControlCount(session.record.pid, session.workspace);
    const before = count();
    const change = new ChangeSignal();
    const watcher = watch(file, () => change.notify());
    try {
      this.pty.write(KEYS.escape);
      await change.waitFor(() => count() > before, EVENT_TIMEOUT_MS,
        "unmodified native Escape freshly reaches the exact owned child's real public PTY write");
      await this.waitForFrameQuiet("idle native Escape preserves a bounded stable owner frame");
    } finally { watcher.close(); }
  }

  /** Real @lydell/node-pty onExit observations journaled by the Main runner. */
  ptyExits(): PtyExitRecord[] {
    if (!existsSync(this.ptyExitLog)) return [];
    const records: PtyExitRecord[] = [];
    for (const line of readFileSync(this.ptyExitLog, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as PtyExitRecord);
      } catch {
        // An append may be observed between its write and trailing newline.
      }
    }
    return records;
  }

  /**
   * Require the manager-owned PTY's real public onExit semantics for each
   * session: exitCode 0 with no signal, observed on the exact owned PID. This
   * is the graceful-exit evidence; bounded-failure TERM/KILL cleanup and
   * process-gone alone never count. Callers order this after Main's actual
   * exited frame or normal outer exit: the runner installs its synchronous
   * journal listener before returning each real PTY to the manager, so the
   * record is already appended by then.
   */
  async assertGracefulPtyExits(sessions: readonly OwnedSession[]): Promise<void> {
    const exits = this.ptyExits();
    for (const session of sessions) {
      const record = exits.find((entry) => entry.type === "pty_exit" && entry.pid === session.record.pid);
      assert.ok(record,
        `the manager-owned ${session.rowProbe} native PTY exit was observed through the real @lydell/node-pty onExit API`);
      assert.equal(record!.exitCode, 0,
        `the manager-owned ${session.rowProbe} native PTY exited with code 0 through its real public onExit event`);
      assert.ok(!record!.signal,
        `the manager-owned ${session.rowProbe} native PTY exit was not signal termination or escalation`);
    }
  }

  private onData(data: string): void {
    this.outputRevision += 1;
    this.outputSignal.notify();
    this.outputTail = (this.outputTail + data).slice(-256 * 1024);
    this.sawAltEnter ||= this.outputTail.includes("\x1b[?1049h");
    this.sawAltLeave ||= this.outputTail.includes("\x1b[?1049l");
    this.sawCursorShow ||= this.outputTail.includes("\x1b[?25h");
    this.sawReset ||= this.outputTail.includes("\x1b[0m");
    try {
      this.surface.write(data);
    } catch {
      this.parserError = new Error("the owned outer terminal emulator rejected actual Main output");
    }
  }

  private refreshFrame(): void {
    try {
      this.currentFrame = frameText(this.surface);
      if (this.kittyFlagSnapshots.length < 512) {
        this.kittyFlagSnapshots.push(this.surface.inputModes().kittyFlags);
      }
      this.frameRevision += 1;
      this.frameSignal.notify();
    } catch {
      this.parserError = new Error("the owned outer terminal frame could not be read");
    }
  }

  currentText(): string {
    if (this.parserError) throw this.parserError;
    return this.currentFrame;
  }

  waitFrame(
    predicate: (text: string) => boolean,
    description: string,
    afterRevision = -1,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<void> {
    return this.frameSignal.waitFor(
      () => {
        if (this.exitEvent && !(this.frameRevision > afterRevision && predicate(this.currentText()))) {
          throw new Error("owned outer Main PTY exited before the expected frame was observed");
        }
        return this.frameRevision > afterRevision && predicate(this.currentText());
      },
      timeoutMs,
      description,
    ).catch((error: unknown) => {
      const frame = this.currentText(); // complete controlled fixture frame, including wrapped native fields
      const exit = this.exitEvent ? `exit=${this.exitEvent.exitCode}/${this.exitEvent.signal ?? 0}` : "still-running";
      throw new Error(`${description}: ${error instanceof Error ? error.message : "bounded frame wait failed"}; ${exit}; frames=${this.frameRevision}\nActual owned Main frame:\n${frame}`);
    });
  }

  async writeAndWait(data: string, predicate: (text: string) => boolean, description: string): Promise<void> {
    this.selectedNativeTarget = undefined;
    const after = this.frameRevision;
    this.pty.write(data);
    await this.waitFrame(predicate, description, after);
  }

  async writeKeys(keys: string, description: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    this.selectedNativeTarget = undefined;
    const after = this.frameRevision;
    this.pty.write(keys);
    await this.waitFrame(() => true, description, after, timeoutMs);
  }

  async clearWorkspaceField(description: string): Promise<void> {
    this.selectedNativeTarget = undefined;
    if (workspaceFieldIsEmpty(this.currentText())) return;
    const before = this.frameRevision;
    this.pty.write(KEYS.ctrlC); // the real Workspace field's displayed `ctrl+c clear` binding
    await this.waitFrame(workspaceFieldIsEmpty, description, before);
  }

  async waitForRecords(
    predicate: (records: SessionRecord[]) => boolean,
    description: string,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<SessionRecord[]> {
    try {
      await this.journalSignal.waitFor(() => predicate(this.records()), timeoutMs, description);
    } catch (error) {
      // Controlled fixture content only. Preserve the actual frame in the
      // failure diagnostic so a UI/backend error is not hidden by an empty
      // lifecycle journal; never synthesize a session or weaken the predicate.
      throw new Error(`${description}: ${error instanceof Error ? error.message : "observation failed"}\nActual owned Main frame:\n${this.currentText()}`);
    }
    return this.records();
  }

  async assertNoJournalEvent(predicate: (records: SessionRecord[]) => boolean, description: string): Promise<void> {
    await this.journalSignal.waitForQuiet(() => predicate(this.records()), SHORT_QUIET_WINDOW_MS, description);
  }

  async waitForFrameQuiet(description: string): Promise<void> {
    await this.frameSignal.waitForQuietPeriod(SHORT_QUIET_WINDOW_MS, 5_000, description);
  }

  async waitForOuterOutput(afterRevision: number, description: string): Promise<void> {
    await this.outputSignal.waitFor(() => this.outputRevision > afterRevision, EVENT_TIMEOUT_MS, description);
  }

  async waitForExit(timeoutMs = EVENT_TIMEOUT_MS): Promise<PtyExit> {
    if (!this.exitEvent) {
      await this.exitSignal.waitFor(() => this.exitEvent !== undefined, timeoutMs, "owned outer Main PTY exit");
    }
    return this.exitEvent!;
  }

  selected(label: string): boolean {
    const selected = selectedRosterEntry(this.currentText(), this.sidebarColumnCount());
    if (selected === undefined) return false;
    const matches = this.sessions().filter((session) => session.rowProbe === label);
    return matches.length === 1 && selected.kind === "native"
      ? renderedTitleMatches(selected.title, matches[0]!.displayName)
      : selected.label === label;
  }

  /** Actual sidebar pane width: 32 wide, or the full narrow-overlay width. */
  private sidebarColumnCount(): number {
    const cols = this.surface.frame().cols;
    return this.sidebarVisible && cols >= SIDEBAR_OVERLAY_MIN_OUTER_COLUMNS ? SIDEBAR_COLUMNS : cols;
  }

  /** Title line of the selected native card, or undefined for no/action highlight. */
  private selectedCardTitle(text: string): string | undefined {
    const selected = selectedRosterEntry(text, this.sidebarColumnCount());
    return selected !== undefined && selected.kind === "native" ? selected.title : undefined;
  }

  private selectedCaptionMatches(text: string, displayName: string): boolean {
    return renderedTitleMatches(this.selectedCardTitle(text), displayName);
  }

  private rosterHasCaption(text: string, displayName: string): boolean {
    return parseRosterFrame(text, this.sidebarColumnCount()).cards
      .some((card) => renderedTitleMatches(card.title, displayName));
  }

  /** True only for a fully drawn roster; a partial repaint is never usable. */
  private rosterIsComplete(text: string): boolean {
    return parseRosterFrame(text, this.sidebarColumnCount()).complete;
  }

  /**
   * Complete Main-focused roster evidence: the drawn entry extent plus the
   * full Main footer and no stale sidebar-only hint. Used to prove that a
   * completed New/Saved explicit submission really transferred input
   * ownership to the new child rather than merely moving the highlight.
   */
  private mainFocusedRoster(text: string): boolean {
    const footer = rosterFooterText(text, this.sidebarColumnCount());
    if (footer === undefined) return false;
    for (const hint of MAIN_FOCUS_FOOTER_HINTS) if (!footer.includes(hint)) return false;
    for (const stale of SIDEBAR_ONLY_FOOTER_HINTS) if (footer.includes(stale)) return false;
    return true;
  }

  private rememberSelectedTarget(label: string): void {
    const matches = this.sessions().filter((session) => session.rowProbe === label);
    const session = matches.length === 1 ? matches[0] : undefined;
    this.selectedNativeTarget = session === undefined ? undefined : {
      workspace: session.workspace,
      pid: session.record.pid!,
      sessionId: session.record.sessionId!,
    };
  }

  private rosterTargetSelected(text: string, label: string): boolean {
    const selected = selectedRosterEntry(text, this.sidebarColumnCount());
    if (selected === undefined) return false;
    const matches = this.sessions().filter((session) => session.rowProbe === label);
    if (matches.length === 1 && selected.kind === "native") {
      return renderedTitleMatches(selected.title, matches[0]!.displayName);
    }
    return selected.label === label;
  }

  async moveRosterTo(label: string, maximumDowns = 5, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    if (this.rosterTargetSelected(this.currentText(), label)) {
      this.rememberSelectedTarget(label);
      return;
    }
    this.selectedNativeTarget = undefined;
    const labels = this.sessions().map((session) => session.rowProbe)
      .concat(["Saved conversations", "New session", "Quit host"]);
    if (this.rosterSelectionClearedByRemoval) {
      assert.equal(this.rosterIsComplete(this.currentText()), true,
        "a fully drawn roster is observed before the cleared highlight is trusted");
      assert.equal(this.selectedCardTitle(this.currentText()), undefined,
        "confirmed selected-row removal leaves the host highlight empty instead of selecting a sibling");
      const activeHeader = this.currentText().split("\n")[0];
      const beforeHighlight = this.frameRevision;
      this.pty.write(KEYS.down); // Explicit UI navigation only, never activation.
      await this.waitFrame((text) => this.rosterTargetSelected(text, labels[0]!)
        && text.split("\n")[0] === activeHeader,
      "explicit Down establishes the first actual roster highlight without transferring Main ownership", beforeHighlight, timeoutMs);
      this.rosterSelectionClearedByRemoval = false;
      if (this.rosterTargetSelected(this.currentText(), label)) {
        this.rememberSelectedTarget(label);
        return;
      }
    }
    for (let count = 0; count < maximumDowns; count += 1) {
      // Observe an actual known row before authorizing any navigation key.
      await this.waitFrame((text) => labels.some((candidate) => this.rosterTargetSelected(text, candidate)),
        "the current owned roster finishes painting its actual highlighted row before navigation", -1, timeoutMs);
      const selectedIndex = labels.findIndex((candidate) => this.rosterTargetSelected(this.currentText(), candidate));
      assert.ok(selectedIndex >= 0,
        `the owned roster has an observed highlighted row before navigation\nActual owned Main frame:\n${this.currentText()}`);
      const nextLabel = labels[(selectedIndex + 1) % labels.length]!;
      const after = this.frameRevision;
      this.pty.write(KEYS.down);
      // Native output and status can repaint before this key changes the roster.
      // Wait for the actual next highlight, not merely any parsed frame.
      await this.waitFrame((text) => this.rosterTargetSelected(text, nextLabel),
        `sidebar advances to ${nextLabel} toward ${label}`, after, timeoutMs);
      if (this.rosterTargetSelected(this.currentText(), label)) {
        this.rememberSelectedTarget(label);
        return;
      }
    }
    throw new Error(`the real Main sidebar did not select the expected ${label} row; ${this.currentText().slice(0, 2_000)}`);
  }

  private nativeSelectedMenuRow(text: string): string | undefined {
    // This flow is exercised after restoring the verified wide layout. Ignore
    // the independent roster's highlight when that pane is visible.
    assert.equal(this.surface.frame().cols, OUTER_COLS);
    const nativeLeft = this.sidebarVisible && this.surface.frame().cols >= SIDEBAR_OVERLAY_MIN_OUTER_COLUMNS
      ? NATIVE_PANE_START
      : 0;
    return text.split("\n").slice(1).map((line) => line.slice(nativeLeft))
      .find((line) => /^\s*[→>] /.test(line));
  }

  nativeMenuSelected(text: string, label: string): boolean {
    return this.nativeSelectedMenuRow(text)?.includes(label) === true;
  }

  async moveNativeMenuTo(label: string, maximumDowns: number): Promise<void> {
    if (this.nativeMenuSelected(this.currentText(), label)) return;
    for (let count = 0; count < maximumDowns; count += 1) {
      const beforeRow = this.nativeSelectedMenuRow(this.currentText());
      assert.ok(beforeRow, "the native menu has an observed selected row before navigation");
      const after = this.frameRevision;
      this.pty.write(KEYS.down);
      await this.waitFrame((text) => {
        const row = this.nativeSelectedMenuRow(text);
        return row !== undefined && row !== beforeRow;
      }, `native menu selection changes toward ${label}`, after);
      if (this.nativeMenuSelected(this.currentText(), label)) return;
    }
    throw new Error(`the actual native Pi menu did not select ${label}; ${this.currentText().slice(-2_000)}`);
  }

  /**
   * One genuine reserved-chord (fixture F8) press, witnessing exactly the
   * production two-step transition for the CURRENT state:
   * - hidden: show + focus the sidebar (visibility action; native children reflow);
   * - visible with Main focus: focus the sidebar WITHOUT hiding or resizing it;
   * - visible with sidebar-owned focus (roster/form/picker/confirm): hide to Main.
   * Callers that want the hide transition must request it explicitly, pressing
   * again from the sidebar-focused state; this helper never bundles two presses
   * that could silently hide a visible Main frame.
   */
  async toggleSidebar(timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    const wasVisible = this.sidebarVisible;
    const wasMainFocus = this.focus === "main";
    // Capture the inspected sidebar width before the press changes visibility:
    // a hide must be witnessed against the pre-transition pane, not a width
    // recomputed after the sidebar is already gone.
    const sidebarColumnsBefore = this.sidebarColumnCount();
    const resizeCountBefore = this.records().filter((record) => record.type === "resize").length;
    const after = this.frameRevision;
    this.pty.write(KEYS.f8);
    if (!wasVisible) {
      this.sidebarVisible = true;
      this.focus = "sidebar";
    } else if (wasMainFocus) {
      this.focus = "sidebar"; // focus only; visibility and native geometry are untouched
    } else {
      this.sidebarVisible = false;
      this.focus = "main";
    }
    const expectHidden = wasVisible && !wasMainFocus;
    await this.waitFrame((text) => expectHidden
      ? sidebarRosterHidden(text, sidebarColumnsBefore)
      : isSidebarFocusedFrame(text, this.sidebarColumnCount()),
    expectHidden
      ? "one F8 press hides the sidebar-focused pane and returns Main"
      : wasVisible
        ? "one F8 press focuses the visible sidebar without hiding or resizing it"
        : "one F8 press shows and focuses the hidden sidebar",
    after, timeoutMs);
    if (wasVisible && wasMainFocus) {
      assert.equal(this.sidebarVisible, true, "the focus-first press keeps the sidebar visible");
      assert.equal(
        this.records().filter((record) => record.type === "resize").length, resizeCountBefore,
        "the focus-first press does not resize any native child",
      );
    }
  }

  /**
   * Establishes sidebar focus with explicit, individually witnessed presses.
   * From a visible Main-focused frame this is exactly one focus-first press
   * (no hide, no resize); a form/picker-owned focus runs its own cancellation
   * fence on the first press, so a separate second press shows the pane again.
   * The complete sidebar-only footer proves the result.
   */
  async ensureSidebarFocus(timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    if (this.focus === "sidebar" && this.sidebarVisible) return;
    const headerBefore = frameHeader(this.currentText());
    if (this.focus === "form") {
      await this.toggleSidebar(timeoutMs); // abandons only the form/picker UI ownership
    }
    if (!this.sidebarVisible || this.focus !== "sidebar") {
      const wasVisible = this.sidebarVisible;
      await this.toggleSidebar(timeoutMs);
      if (wasVisible) {
        assert.equal(this.sidebarVisible, true, "the focus-first press keeps the visible sidebar shown");
        assert.equal(frameHeader(this.currentText()), headerBefore,
          "the focus-first press does not transfer the active Main owner");
      }
    }
    assert.equal(this.focus, "sidebar");
    assert.equal(this.sidebarVisible, true, "establishing sidebar focus leaves the pane visible");
    assert.ok(isSidebarFocusedFrame(this.currentText(), this.sidebarColumnCount()),
      "the complete sidebar-only footer proves real sidebar focus");
  }

  async activateRoster(label: string, expectedDraft?: string): Promise<void> {
    await this.ensureSidebarFocus();
    await this.moveRosterTo(label);
    const after = this.frameRevision;
    this.pty.write(KEYS.enter);
    this.focus = "main";
    await this.waitFrame((text) => frameHeaderMatches(text, label)
      && (expectedDraft === undefined || text.includes(expectedDraft)),
    `Enter activates the highlighted native session ${label} with its own observed header and surface`, after);
  }

  /** Create one real native session through the Workspace-only public form. */
  async createNativeSession(workspace: string): Promise<OwnedSession> {
    const canonicalWorkspace = realpathSync(workspace);
    await this.ensureSidebarFocus();
    await this.moveRosterTo("New session");
    const afterOpen = this.frameRevision;
    this.pty.write(KEYS.enter);
    this.focus = "form";
    await this.waitFrame((text) => text.includes("New session") && text.includes("Workspace:")
      && !text.includes("Label:") && !text.includes("Profile:") && text.includes("tab complete"),
    "the canonical Workspace-only New session form opens", afterOpen);

    await this.clearWorkspaceField("the native `ctrl+c clear` action removes any retained Workspace draft");
    await this.writeAndWait(canonicalWorkspace, (text) => text.includes(canonicalWorkspace.slice(-18)),
      "the explicit workspace is entered in the real native field");
    const visibleWorkspace = (text: string): string | undefined => {
      const fieldRows = text.split("\n");
      const fieldIndex = fieldRows.findIndex((line) => line.includes("> Workspace:"));
      if (fieldIndex < 0) return undefined;
      const fieldColumn = fieldRows[fieldIndex]!.indexOf("> Workspace:") + "> Workspace: ".length;
      return fieldRows[fieldIndex + 1]?.slice(fieldColumn).trim();
    };
    const beforeFirstEnter = this.frameRevision;
    this.pty.write(KEYS.enter);
    await this.waitFrame((text) => !text.includes("> Workspace:") || text.includes("Starting (request")
      || visibleWorkspace(text) === `${canonicalWorkspace}/`,
    "native Enter accepts the exact folder completion or actually submits New", beforeFirstEnter);
    const afterFirstEnter = this.currentText();
    if (afterFirstEnter.includes("> Workspace:") && !afterFirstEnter.includes("Starting (request")) {
      assert.equal(visibleWorkspace(afterFirstEnter), `${canonicalWorkspace}/`,
        "first native Enter accepted the exact owned folder completion, not another path or an error");
      await this.writeKeys(KEYS.enter, "a separate native Enter submits the accepted Workspace path");
    }
    this.pendingWorkspace = canonicalWorkspace;
    this.submittedWorkspaces.add(canonicalWorkspace);

    const records = await this.waitForRecords(
      (entries) => entries.some((record) => record.type === "session_start"
        && record.cwd === canonicalWorkspace
        && typeof record.sessionId === "string" && record.sessionId.length > 0
        && typeof record.displayName === "string"),
      "real native Pi session_start with observed metadata and selected workspace",
    );
    this.pendingWorkspace = undefined;
    const record = records.filter((entry) => entry.type === "session_start" && entry.cwd === canonicalWorkspace
      && typeof entry.sessionId === "string" && typeof entry.displayName === "string").at(-1);
    assert.ok(record, "native observer recorded the new native session");
    assert.ok(Number.isSafeInteger(record.pid), "native observer recorded the owned native PID");
    assert.ok(record.sessionId && record.sessionId.length > 0, "native SessionManager reported its conversation id");
    assert.ok(record.sessionFile && isAbsolute(record.sessionFile), "native SessionManager reported its session file");
    const exitWatcher = new OwnedPidExitWatcher(record.pid!);
    this.nativeExitWatchers.set(record.pid!, exitWatcher);
    await exitWatcher.waitUntilRegistered(EVENT_TIMEOUT_MS);
    const rowProbe = record.displayName!;
    const currentName = record.storedName ?? "";
    const displayName = record.displayName!;
    this.ownedLabels.set(canonicalWorkspace, { rowProbe, currentName, displayName, workspace: canonicalWorkspace });
    // A successful New submission activates the created child as the Main
    // input owner without a second host-row Enter: its canonical header owns
    // the outer frame, the row is the single highlight, and the complete
    // Main-focused roster footer proves the sidebar is still visible.
    await this.waitFrame((text) => frameHeaderMatches(text, displayName)
      && this.selectedCaptionMatches(text, displayName)
      && this.mainFocusedRoster(text),
    `new canonical row ${displayName} is the active Main input owner with a complete Main-focused frame`);
    this.focus = "main"; // the completed New child owns Main input
    this.selectedNativeTarget = { workspace: canonicalWorkspace, pid: record.pid!, sessionId: record.sessionId! };
    return { rowProbe, currentName, displayName, workspace: canonicalWorkspace, record, exitWatcher };
  }

  /** Rename the selected native row through the real host Edit form, never a child command. */
  async renameNativeSession(session: OwnedSession, name: string): Promise<void> {
    assert.ok(Number.isSafeInteger(session.record.pid) && session.record.sessionId,
      "the rename target is an observer-confirmed native session");
    assert.equal(processIsAlive(session.record.pid), true, "the rename target is a live owned native child");
    await this.ensureSidebarFocus();
    const exactOwner = this.sessions().find((candidate) => candidate.workspace === session.workspace
      && candidate.record.pid === session.record.pid && candidate.record.sessionId === session.record.sessionId);
    assert.ok(exactOwner, "the native row is owned by its observed workspace, PID, and conversation id");
    const selectedTarget = this.selectedNativeTarget;
    const targetAlreadySelected = selectedTarget?.workspace === session.workspace
      && selectedTarget.pid === session.record.pid
      && selectedTarget.sessionId === session.record.sessionId
      && this.selectedCaptionMatches(this.currentText(), session.displayName);
    if (!targetAlreadySelected) {
      const sameCaptionOwners = this.sessions().filter((candidate) => candidate.rowProbe === session.rowProbe);
      assert.equal(sameCaptionOwners.length, 1,
        "a non-current rename target has a unique observed caption before keyboard row targeting");
      assert.equal(sameCaptionOwners[0]?.workspace, session.workspace,
        "the selected caption resolves to the observed target workspace");
      assert.equal(sameCaptionOwners[0]?.record.pid, session.record.pid,
        "the selected caption resolves to the observed target PID");
      assert.equal(sameCaptionOwners[0]?.record.sessionId, session.record.sessionId,
        "the selected caption resolves to the observed native conversation id");
      await this.moveRosterTo(session.rowProbe);
      assert.equal(this.selectedCaptionMatches(this.currentText(), session.displayName), true,
        "the selected row's actual geometry-clipped caption belongs to the observed target");
    }
    assert.ok(this.selectedNativeTarget?.workspace === session.workspace
      && this.selectedNativeTarget.pid === session.record.pid
      && this.selectedNativeTarget.sessionId === session.record.sessionId,
    "the real host Edit key targets the row established by the exact workspace/PID/native-id tuple");
    const activeHeader = this.currentText().split("\n")[0];
    // Is the Edit target itself the active Main owner? An active-owner rename
    // must follow the new caption; an inactive-row rename must leave the
    // existing owner's header byte-for-byte unchanged. Never accept either.
    const targetWasActiveOwner = renderedTitleMatches(activeHeader.trimEnd(), session.displayName);
    const resizeCount = this.records().filter((record) => record.type === "resize").length;
    const beforeEdit = this.frameRevision;
    this.pty.write("e");
    this.focus = "form";
    await this.waitFrame((text) => text.includes("Edit native session name")
      && text.includes("Current name (display only; type a complete replacement):")
      && text.includes("> New name:") && nativeFormFieldIsEmpty(text, "> New name:"),
    "the actual host Edit form renders its empty native replacement field for the selected row", beforeEdit);
    const editFrame = this.currentText();
    assert.ok(editFrame.includes(session.displayName.slice(0, Math.min(session.displayName.length, 80))),
      "the canonical display caption is shown separately from the exact stored-name replacement field");
    const replacementLine = editFrame.split("\n").find((line) => line.includes("> New name:"));
    assert.ok(replacementLine, "the empty replacement field is rendered");
    assert.equal(nativeFormFieldIsEmpty(editFrame, "> New name:"), true,
      `Edit never prefills the replacement with the current or clipped caption\nActual owned Edit frame:\n${editFrame}`);

    await this.writeAndWait(name, (text) => text.includes(name.slice(-Math.min(name.length, 12))),
      "the replacement native name is typed into the actual host form");
    const nameRecordStart = this.records().length;
    await this.writeKeys(KEYS.enter, "the replacement is submitted through the actual host Edit form");
    const nameRecords = await this.waitForRecords((records) => records.slice(nameRecordStart).some((record) => record.type === "native_session_name"
      && record.pid === session.record.pid
      && record.sessionId === session.record.sessionId
      && record.storedName === name && typeof record.displayName === "string"),
    "the native public SessionManager freshly observes the exact replacement name");
    const nameRecord = nameRecords.filter((record) => record.type === "native_session_name"
      && record.pid === session.record.pid && record.sessionId === session.record.sessionId
      && record.storedName === name && typeof record.displayName === "string").at(-1);
    assert.ok(nameRecord, "the actual stored-name event includes its canonical bounded display caption");
    const displayName = nameRecord.displayName!;
    const headerTruthful = (text: string): boolean => targetWasActiveOwner
      ? frameHeaderMatches(text, displayName)
      : frameHeader(text) === activeHeader.trimEnd();
    await this.waitFrame((text) => this.selectedCaptionMatches(text, displayName)
      && headerTruthful(text),
      targetWasActiveOwner
        ? "the renamed active owner reports its new caption as the unchanged owner header"
        : "the selected native row renders the actual canonical caption while the active owner header is unchanged");
    assert.ok(headerTruthful(this.currentText()),
      targetWasActiveOwner
        ? "renaming the active owner keeps that same owner under its new caption"
        : "editing an inactive native caption does not transfer active Main ownership");
    assert.equal(processIsAlive(session.record.pid), true, "the edited native child remains live");
    assert.equal(this.records().filter((record) => record.type === "resize").length, resizeCount,
      "opening and saving the right-pane Edit form does not change child geometry");
    session.currentName = name;
    session.displayName = displayName;
    const rendered = this.selectedCardTitle(this.currentText());
    if (rendered === displayName) session.rowProbe = displayName;
    this.ownedLabels.set(session.workspace, {
      rowProbe: session.rowProbe, currentName: name, displayName, workspace: session.workspace,
    });
    this.selectedNativeTarget = {
      workspace: session.workspace, pid: session.record.pid!, sessionId: session.record.sessionId!,
    };
    this.focus = "sidebar";

    if (name.length > 256) {
      const beforeReopen = this.frameRevision;
      this.pty.write("e");
      this.focus = "form";
      await this.waitFrame((text) => text.includes("Edit native session name") && text.includes("> New name:")
        && nativeFormFieldIsEmpty(text, "> New name:"),
        "Edit reopens with a long current caption and a fully rendered empty replacement", beforeReopen);
      const clippedFrame = this.currentText();
      assert.ok(clippedFrame.includes(displayName.slice(0, 80)), "the canonical caption is displayed in bounded clipped form");
      const emptyReplacement = clippedFrame.split("\n").find((line) => line.includes("> New name:"));
      assert.ok(emptyReplacement, "the replacement field is present beside the clipped current caption");
      assert.equal(nativeFormFieldIsEmpty(clippedFrame, "> New name:"), true,
        "a clipped current caption is never copied into the replacement field");
      const beforeCancel = this.frameRevision;
      this.pty.write(KEYS.escape);
      // Escape cancels ONLY the Edit form: it returns to the VISIBLE roster
      // (sidebar focus), keeps the complete target card and the unchanged
      // native owner, and never hides the sidebar or changes the name.
      this.focus = "sidebar";
      this.sidebarVisible = true;
      await this.waitFrame((text) => !text.includes("Edit native session name")
        && !text.includes("> New name:")
        && this.selectedCaptionMatches(text, displayName)
        && headerTruthful(text),
        "Escape cancels only the Edit form: the visible roster keeps the complete target card and the unchanged native owner", beforeCancel);
    }
  }

  async setOuterSize(
    cols: number,
    rows: number,
    sessions: readonly OwnedSession[],
    expectedNativeCols: number,
    expectedNativeRows: number,
  ): Promise<void> {
    const outputBefore = this.outputRevision;
    const recordCountBeforeResize = this.records().length;
    this.pty.resize(cols, rows);
    this.surface.resize(cols, rows);
    await this.waitForOuterOutput(outputBefore, `real ProcessTerminal redraw after outer resize to ${cols}x${rows}`);
    for (const session of sessions) {
      await this.waitForRecords(
        (records) => records.slice(recordCountBeforeResize).some((record) => record.type === "resize"
          && record.pid === session.record.pid
          && record.columns === expectedNativeCols && record.rows === expectedNativeRows),
        `owned native ${session.rowProbe} receives a fresh ${expectedNativeCols}x${expectedNativeRows} pane after outer resize to ${cols}x${rows}`,
      );
    }
  }

  async closeNativeNormally(session: OwnedSession): Promise<void> {
    assert.equal(this.focus, "main", `native input is focused on ${session.rowProbe}`);
    assert.equal(processIsAlive(session.record.pid), true, `${session.rowProbe} is alive before its native Ctrl+C exit`);
    assert.ok(renderedTitleMatches(frameHeader(this.currentText()), session.displayName),
      "the explicit native exit begins with the exact uniquely observed title as active owner");
    const alreadyExitedCards = countExitedCards(this.currentText(), this.sidebarColumnCount());
    const otherLiveOwners = this.ownedSessions().filter((candidate) => candidate.record.pid !== session.record.pid
      && !candidate.exitWatcher.observedExit);
    for (const owner of otherLiveOwners) assert.equal(processIsAlive(owner.record.pid), true,
      "another owned child is still live before this exact native exit");
    const before = this.frameRevision;
    const shutdownCount = this.records().filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).length;
    this.pty.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
    const shutdownRecords = await this.waitForRecords((records) => records.filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).length > shutdownCount,
    `real ${session.rowProbe} session_shutdown lifecycle event after the explicit native exit`);
    const nativeShutdown = shutdownRecords.filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).at(-1);
    assert.equal(nativeShutdown?.reason, "quit",
      "the public native lifecycle reports its actual quit reason after the real Ctrl+C exit");
    assert.equal(nativeShutdown?.sessionId, session.record.sessionId,
      "the fresh shutdown witness belongs to the exact observed conversation, not another session on that PID");
    assert.equal(nativeShutdown?.contextSessionId, session.record.sessionId,
      "the public native shutdown context independently confirms the same conversation id");
    // Reporter disconnect invalidates native metadata: an unavailable caption
    // is truthful, not a new identity. Correlate the uniquely active owner and
    // one NEW zero-status card with the exact PID's public lifecycle/kernel/PTY
    // evidence below; old rows or another child's exit cannot stand in for it.
    // The exit status is read from the card's SECOND row, below the title row.
    let exitCaption: string | undefined;
    await this.waitFrame((text) => {
      const header = frameHeader(text);
      if (header !== "(session name unavailable)" && !renderedTitleMatches(header, session.displayName)) return false;
      const sidebarCols = this.sidebarColumnCount();
      const parsed = parseRosterFrame(text, sidebarCols);
      if (!parsed.complete) return false;
      if (countExitedCards(text, sidebarCols) !== alreadyExitedCards + 1) return false;
      const selected = parsed.entries.find((entry) => entry.selected);
      if (selected === undefined || selected.kind !== "native" || selected.status !== "exited (code 0)") return false;
      if (header !== "(session name unavailable)" && !renderedTitleMatches(selected.title, session.displayName)) return false;
      exitCaption = header;
      return true;
    }, `Main observes one new exited card for the exact active owned ${session.rowProbe} process`, before);
    await session.exitWatcher.waitForExit(EVENT_TIMEOUT_MS);
    assert.equal(session.exitWatcher.observedExit, true,
      `${session.rowProbe} received the kernel EVFILT_PROC/NOTE_EXIT event for its exact owned PID`);
    await this.assertGracefulPtyExits([session]);
    for (const owner of otherLiveOwners) assert.equal(processIsAlive(owner.record.pid), true,
      "this exact native exit does not stop or substitute another owned process");
    assert.ok(exitCaption);
    // Keep stored native names intact; only the observed UI navigation caption
    // changes after its reporter goes away. This is not persisted metadata.
    session.rowProbe = exitCaption;
    session.displayName = exitCaption;
    this.ownedLabels.set(session.workspace, {
      rowProbe: exitCaption, currentName: session.currentName,
      displayName: exitCaption, workspace: session.workspace,
    });
  }

  /** Remove one positively exited row via the real sidebar Delete action only. */
  async removeExitedNativeSession(session: OwnedSession): Promise<void> {
    assert.equal(session.exitWatcher.observedExit, true,
      `${session.rowProbe} has the exact kernel exit confirmation before row removal`);
    const ptyExit = this.ptyExits().find((record) => record.type === "pty_exit" && record.pid === session.record.pid);
    assert.ok(ptyExit, `${session.rowProbe} has the public owned-PTY onExit record before row removal`);
    assert.equal(ptyExit.exitCode, 0, `${session.rowProbe} exited gracefully before row removal`);
    assert.equal(ptyExit.signal ?? 0, 0, `${session.rowProbe} has no forced signal exit before row removal`);
    const shutdown = this.records().filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).at(-1);
    assert.equal(shutdown?.reason, "quit", `${session.rowProbe} has the native quit reason before row removal`);
    assert.ok(session.record.sessionFile && existsSync(session.record.sessionFile),
      `${session.rowProbe}'s persistent native conversation file exists before row removal`);

    const beforeRows = this.sessions().length;
    assert.ok(beforeRows > 0 && this.sessions().some((candidate) => candidate.workspace === session.workspace
      && candidate.record.pid === session.record.pid && candidate.record.sessionId === session.record.sessionId),
      `${session.rowProbe} is still an owned Main row after its confirmed process exit`);
    await this.ensureSidebarFocus();
    await this.moveRosterTo(session.rowProbe);
    assert.equal(this.selectedCaptionMatches(this.currentText(), session.displayName), true,
      "the Delete key is directed at the selected row's actual exited caption");
    const remainingRows = this.sessions().filter((candidate) => candidate.workspace !== session.workspace);
    const beforeDelete = this.frameRevision;
    this.pty.write(KEYS.delete);
    await this.waitFrame((text) => this.rosterIsComplete(text)
      && text.includes(`Sessions (${beforeRows - 1})`)
      && !this.rosterHasCaption(text, session.displayName)
      && remainingRows.every((candidate) => this.rosterHasCaption(text, candidate.displayName))
      && ["Saved conversations", "New session", "Quit host"].every((entry) => text.includes(entry))
      && this.selectedCardTitle(text) === undefined,
    `the public Delete action removes only ${session.rowProbe}'s confirmed exited row from a complete roster and clears its highlight`, beforeDelete);
    this.removedWorkspaces.add(session.workspace);
    this.selectedNativeTarget = undefined;
    this.rosterSelectionClearedByRemoval = true;
    assert.equal(this.sessions().length, beforeRows - 1,
      "current roster removal does not discard historical native process ownership");
    assert.ok(existsSync(session.record.sessionFile),
      `${session.rowProbe}'s persistent native conversation file survives row removal`);
  }

  private assertOuterRestoration(exit: PtyExit): void {
    assert.equal(exit.exitCode, 0, "the actual public Main runSessionHost returned success");
    assert.equal(exit.signal ?? 0, 0, "the outer Main PTY exited normally, not by signal cleanup");
    assert.ok(existsSync(this.resultFile), "the public Main wrapper recorded its return and terminal state");
    const result = JSON.parse(readFileSync(this.resultFile, "utf8")) as {
      status: number; threw: boolean; before: string; after: string; rawBefore: unknown; rawAfter: unknown;
      stdinIsTTY: boolean; stdoutIsTTY: boolean;
    };
    assert.equal(result.threw, false);
    assert.equal(result.status, 0, "runSessionHost's public Main API returned zero");
    assert.equal(result.stdinIsTTY, true);
    assert.equal(result.stdoutIsTTY, true);
    assert.equal(result.after, result.before, "the real controlling TTY termios state is restored exactly");
    assert.equal(result.rawAfter, result.rawBefore, "the public Node stdin raw-mode state is restored");
    assert.ok(this.sawAltEnter, "the real Main frame writer entered the alternate screen on the owned outer PTY");
    assert.ok(this.sawAltLeave, "the real Main frame writer restored the primary screen on the owned outer PTY");
    assert.ok(this.sawCursorShow, "the real Main cleanup restored cursor visibility");
    assert.ok(this.sawReset, "the real Main cleanup emitted terminal style reset");
    assert.ok(frameText(this.surface).includes(this.baseline),
      `the outer terminal emulator observes its complete pre-Main primary-screen baseline after restoration\nActual restored primary frame:\n${frameText(this.surface)}`);
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?[\d;]*c$/.test(reply)),
      "the owned outer PTY answered the real public primary device-attribute query");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?\d+u$/.test(reply)),
      "the owned outer PTY answered the real public Kitty keyboard-state query");
    const flags = this.surface.inputModes().kittyFlags;
    assert.ok(this.kittyFlagSnapshots.length > 0 && this.kittyFlagSnapshots.every((observed) =>
      Number.isInteger(observed) && observed >= 0 && observed <= 7),
    "every actual outer-terminal Kitty mode observed during Main stays within supported flags 1+2+4");
    assert.equal(flags, 0, "the actual outer terminal's Kitty keyboard flags are popped during Main cleanup");
    assert.ok(this.outputTail.lastIndexOf("\x1b[?1049l") > this.outputTail.lastIndexOf("\x1b[?1049h"),
      "the last observed alternate-screen transition restores the primary screen");
  }

  /** Wait for the owned outer PTY exit and assert the full outer restoration. */
  async waitForNormalOuterExit(): Promise<PtyExit> {
    const exit = await this.waitForExit();
    await this.surface.flush();
    this.assertOuterRestoration(exit);
    return exit;
  }

  async finishHostNormally(): Promise<PtyExit> {
    const starts = [...new Map(this.records().filter((record) => record.type === "session_start"
      && typeof record.pid === "number").map((record) => [record.pid!, record])).values()];
    assert.equal(starts.length, this.submittedWorkspaces.size,
      "every submitted native session, and no unowned session, has a public session_start record");
    assert.equal(this.ownedSessions().length, this.submittedWorkspaces.size,
      "every submitted native process retains its test-owned OS-exit watcher through row removal and host shutdown");
    assert.ok(starts.every((record) => this.nativeExitWatchers.get(record.pid!)?.observedExit === true),
      "the host is quit only after every owned native child OS exit is confirmed");
    await this.ensureSidebarFocus();
    assert.equal(this.focus, "sidebar", "the explicit host quit action belongs to the visible sidebar, not a native editor");
    await this.waitFrame((text) => isSidebarFocusedFrame(text, this.sidebarColumnCount()),
      "the complete sidebar-only footer exposes the host-only quit action");
    // Disconnected exited rows truthfully share an unavailable caption. Quit
    // needs no invented name or ambiguous row navigation after exact OS exits.
    this.pty.write("q");
    this.focus = "main";
    const exit = await this.waitForExit();
    await this.surface.flush();
    this.assertOuterRestoration(exit);
    return exit;
  }

  async boundedCleanup(): Promise<CleanupOutcome> {
    try {
      if (!this.exitEvent) {
        const initial = this.records();
        const starts = [...new Map(initial
          .filter((record) => record.type === "session_start" && typeof record.pid === "number")
          .map((record) => [record.pid!, record])).values()];
        const submissionsKnown = this.pendingWorkspace === undefined
          && starts.length === this.submittedWorkspaces.size
          && this.ownedSessions().length === this.submittedWorkspaces.size;
        const allChildrenOwnedAndWatched = starts.every((record) => {
          const exitWatcher = this.nativeExitWatchers.get(record.pid!);
          const owned = record.cwd
            ? this.ownedLabels.get(realpathOrResolve(record.cwd)) ?? this.ownedLabels.get(record.cwd)
            : undefined;
          return exitWatcher !== undefined && owned !== undefined;
        });

        // First attempt normal idle Ctrl+C exits only for observer-confirmed,
        // test-owned children. Native exits are awaited through exact-PID
        // EVFILT_PROC/NOTE_EXIT watchers, never inferred from session_shutdown.
        if (submissionsKnown && allChildrenOwnedAndWatched) {
          const shutdownPids = new Set(initial.filter((record) => record.type === "session_shutdown"
            && typeof record.pid === "number").map((record) => record.pid!));
          for (const record of starts) {
            const exitWatcher = this.nativeExitWatchers.get(record.pid!);
            if (!exitWatcher || exitWatcher.observedExit) continue;
            if (!shutdownPids.has(record.pid!)) {
              const owned = record.cwd
                ? this.ownedLabels.get(realpathOrResolve(record.cwd)) ?? this.ownedLabels.get(record.cwd)
                : undefined;
              if (!owned) break;
              try {
                await this.ensureSidebarFocus(CLEANUP_UI_TIMEOUT_MS);
                await this.moveRosterTo(owned.rowProbe, 5, CLEANUP_UI_TIMEOUT_MS);
                this.pty.write(KEYS.enter);
                this.focus = "main";
                this.pty.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
                await this.waitForRecords((records) => records.some((entry) => entry.type === "session_shutdown"
                  && entry.pid === record.pid), `bounded normal cleanup lifecycle for ${owned.rowProbe}`, CLEANUP_LIFECYCLE_TIMEOUT_MS);
              } catch {
                // The retained outer PTY below is still terminated on schedule.
              }
            }
            await exitWatcher.waitForExit(CLEANUP_PROCESS_EXIT_TIMEOUT_MS).catch(() => undefined);
          }

          const afterChildren = this.records();
          const currentStarts = [...new Map(afterChildren
            .filter((record) => record.type === "session_start" && typeof record.pid === "number")
            .map((record) => [record.pid!, record])).values()];
          const allObservedChildrenExited = currentStarts.every((record) =>
            this.nativeExitWatchers.get(record.pid!)?.observedExit === true);
          const currentSubmissionsKnown = this.pendingWorkspace === undefined
            && currentStarts.length === this.submittedWorkspaces.size
            && this.ownedSessions().length === this.submittedWorkspaces.size;
          if (!this.exitEvent && allObservedChildrenExited && currentSubmissionsKnown) {
            try {
              await this.ensureSidebarFocus(CLEANUP_UI_TIMEOUT_MS);
              await this.moveRosterTo("Quit host", 5, CLEANUP_UI_TIMEOUT_MS);
              this.pty.write(KEYS.enter);
              this.focus = "main";
              await this.waitForExit(CLEANUP_HOST_EXIT_TIMEOUT_MS);
            } catch {
              // Fall through to bounded escalation of this owned outer PTY.
            }
          }
        }
      }
    } catch {
      // Malformed or incomplete observation is not permission to adopt a child.
      // The owned outer PTY still receives bounded TERM/KILL fallback below.
    }

    if (!this.exitEvent) await this.stopOwnedOuterPty();
    await this.waitForNativeExitEvents();
    const outcome = this.cleanupStatus();
    await this.stopNativeExitWatchers();
    return outcome;
  }

  async forceCleanupAndObserve(): Promise<CleanupOutcome> {
    if (!this.exitEvent) await this.stopOwnedOuterPty();
    await this.waitForNativeExitEvents();
    const outcome = this.cleanupStatus(true);
    await this.stopNativeExitWatchers();
    return outcome;
  }

  private async waitForNativeExitEvents(): Promise<void> {
    try {
      const starts = [...new Map(this.records()
        .filter((record) => record.type === "session_start" && typeof record.pid === "number")
        .map((record) => [record.pid!, record])).values()];
      for (const record of starts) {
        await this.nativeExitWatchers.get(record.pid!)?.waitForExit(CLEANUP_PROCESS_EXIT_TIMEOUT_MS).catch(() => undefined);
      }
    } catch {
      // Preserve scratch if the observer journal cannot confirm child exits.
    }
  }

  async stopNativeExitWatchers(): Promise<void> {
    await Promise.all([...this.nativeExitWatchers.values()].map(async (exitWatcher) => {
      try { await exitWatcher.stop(); } catch { /* exact test-owned observer process only */ }
    }));
  }

  async stopOwnedOuterPty(): Promise<boolean> {
    if (this.exitEvent) return true;
    this.forcedCleanup = true;
    try { this.pty.kill("SIGTERM"); } catch { /* exact retained outer PTY only */ }
    try {
      await this.waitForExit(CLEANUP_SIGNAL_TIMEOUT_MS);
      return true;
    } catch {
      try { this.pty.kill("SIGKILL"); } catch { /* bounded escalation to the same outer PTY handle */ }
      try {
        await this.waitForExit(CLEANUP_SIGNAL_TIMEOUT_MS);
        return true;
      } catch {
        return false;
      }
    }
  }

  cleanupStatus(forced = this.forcedCleanup): CleanupOutcome {
    let records: SessionRecord[] = [];
    let readable = true;
    try { records = this.records(); } catch { readable = false; }
    const starts = [...new Map(records
      .filter((record) => record.type === "session_start" && typeof record.pid === "number")
      .map((record) => [record.pid!, record])).values()];
    const shutdownPids = new Set(records.filter((record) => record.type === "session_shutdown"
      && typeof record.pid === "number").map((record) => record.pid!));
    let submittedSessionsObserved = false;
    try {
      submittedSessionsObserved = this.pendingWorkspace === undefined
        && starts.length === this.submittedWorkspaces.size
        && this.ownedSessions().length === this.submittedWorkspaces.size;
    } catch {
      submittedSessionsObserved = false;
    }
    const childrenExited = readable && submittedSessionsObserved
      && starts.every((record) => this.nativeExitWatchers.get(record.pid!)?.observedExit === true);
    const shutdownEventsObserved = readable && starts.every((record) => shutdownPids.has(record.pid!));
    const hostExited = this.exitEvent !== undefined;
    let resultStatus: number | undefined;
    try {
      if (existsSync(this.resultFile)) {
        resultStatus = (JSON.parse(readFileSync(this.resultFile, "utf8")) as { status?: number }).status;
      }
    } catch {
      resultStatus = undefined;
    }
    const gracefulHostExit = hostExited && !forced && this.exitEvent!.exitCode === 0
      && (this.exitEvent!.signal ?? 0) === 0 && resultStatus === 0;
    return { childrenExited, shutdownEventsObserved, hostExited, gracefulHostExit, forced };
  }

  dispose(): void {
    try { this.dataSubscription.dispose(); } catch { /* best-effort owned subscription cleanup */ }
    try { this.exitSubscription.dispose(); } catch { /* best-effort owned subscription cleanup */ }
    try { this.surface.dispose(); } catch { /* owned headless terminal only */ }
    try { this.watcher.close(); } catch { /* owned observer-directory watcher only */ }
  }

  get outputTailText(): string {
    return this.outputTail;
  }
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf(sep) + 1);
}

function realpathOrResolve(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function makeWorkspace(root: string, name: string): string {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  return realpathSync(workspace);
}

export function createEditorLog(root: string): string {
  const path = join(root, "editor-log.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  return path;
}

export function editorRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
