/**
 * Test-only shared harness for the real public Main native integration tests
 * (tests/session-host-native-main.test.ts and
 * tests/session-host-native-main-lifecycle.test.ts).
 *
 * This module owns the owned-PTY driver around the real public Main API
 * (`runSessionHost` in a privately staged candidate package), the pinned real
 * Pi 1.0.4 runtime resolution, bounded scratch staging, and the exact-PID
 * kernel exit watchers. It is test infrastructure only: no production source,
 * CI, package, docs, or SDK surface changes; no `__test` dependency-injection
 * seam is added to production. The driver's optional `args`/`env` overrides
 * and explicit-profile session creation are the only configurability added so
 * the lifecycle regressions can drive different real Main configurations.
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
import { watch, type FSWatcher } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { TerminalSurface, stripGeneratedSgr } from "../../src/session-host/terminal-surface";

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
const BASELINE = "SESSION_HOST_NATIVE_MAIN_OUTER_RESTORATION_BASELINE";
export const OBSERVER_ENV = "PRG_SESSION_HOST_NATIVE_MAIN_OBSERVER_FILE";
export const OBSERVER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-observer.cjs");
export const RUNNER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-runner.cjs");
const EXIT_WATCHER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-exit-watcher.py");

export const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  f8: "\x1b[19~",
  ctrlC: "\x03",
  ctrlG: "\x07",
  ctrlU: "\x15",
  ctrlK: "\x0b",
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
  pid?: number;
  cwd?: string;
  contextCwd?: string;
  agentDir?: string;
  sessionId?: string;
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
  readonly label: string;
  readonly workspace: string;
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
  if (expectedVersion !== "1.0.4") {
    requiredOrSkip(t, "this native Main integration phase pins Pi 1.0.4");
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
    requiredOrSkip(t, "the explicit runtime pin is not the expected @earendil-works/pi-coding-agent 1.0.4 package");
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

function copyBoundedRegularFile(source: string, destination: string, budget: CopyBudget): void {
  const stats = lstatSync(source);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 8 * 1024 * 1024) {
    throw new Error("owned candidate staging rejected a linked, special, or oversized source file");
  }
  budget.files += 1;
  budget.bytes += stats.size;
  if (budget.files > 20_000 || budget.bytes > 128 * 1024 * 1024) {
    throw new Error("owned candidate staging exceeded its aggregate file bound");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, stats.mode & 0o777);
}

function copyBoundedTree(sourceRoot: string, destinationRoot: string, budget: CopyBudget): void {
  const visit = (source: string, destination: string, depth: number): void => {
    if (depth > 40) throw new Error("owned candidate staging exceeded its directory-depth bound");
    const rootStats = lstatSync(source);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("owned candidate staging requires a real source directory");
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source)) {
      // Exclude initialized Terraform data before inspecting or descending at
      // every depth, including inside the synthetic source roots.
      if (name === ".terraform") continue;
      const sourceEntry = join(source, name);
      const destinationEntry = join(destination, name);
      const stats = lstatSync(sourceEntry);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        visit(sourceEntry, destinationEntry, depth + 1);
      } else {
        copyBoundedRegularFile(sourceEntry, destinationEntry, budget);
      }
    }
  };
  visit(sourceRoot, destinationRoot, 0);
}

export function compileAndStageCandidate(root: string): CandidatePackage {
  const projectRoot = resolve(process.cwd());
  const requireFromProject = createRequire(join(projectRoot, "package.json"));
  const compiler = requireFromProject.resolve("typescript/bin/tsc");
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

  const candidateRoot = join(root, "candidate-package");
  mkdirSync(candidateRoot, { mode: 0o700 });
  const budget: CopyBudget = { files: 0, bytes: 0 };
  copyBoundedTree(join(compiledRoot, "src"), join(candidateRoot, "dist", "src"), budget);
  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { files?: unknown };
  if (!Array.isArray(manifest.files)) throw new Error("the real package manifest has no shipped-file list");
  for (const shippedEntry of manifest.files) {
    if (typeof shippedEntry !== "string") throw new Error("candidate staging rejected a non-string package file entry");
    if (shippedEntry === "dist/src") continue;
    const source = resolve(projectRoot, shippedEntry);
    const sourceRelative = relative(projectRoot, source);
    if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
      throw new Error("candidate staging rejected a package file entry outside the source root");
    }
    const destination = join(candidateRoot, sourceRelative);
    const stats = lstatSync(source);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      copyBoundedTree(source, destination, budget);
    } else {
      copyBoundedRegularFile(source, destination, budget);
    }
  }
  copyBoundedRegularFile(join(projectRoot, "package.json"), join(candidateRoot, "package.json"), budget);
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
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    NODE_PATH: runtime.nodePath,
    EDITOR: editor,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    [OBSERVER_ENV]: observerFile,
    PRG_SESSION_HOST_NATIVE_MAIN_EDITOR_LOG: editorLog,
    PRG_SESSION_HOST_NATIVE_MAIN_EDITOR_VALUE: editorValue,
  };
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

export function removeOwnedScratchTreePruningTerraform(root: string): boolean {
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || realpathSync(root) !== root) return false;
  let complete = true;
  const removeEntry = (path: string, name: string): void => {
    // Never descend into initialized Terraform data, including under the
    // test-owned synthetic root. Preserve it and its ancestors if encountered.
    if (name === ".terraform") {
      complete = false;
      return;
    }
    const stats = lstatSync(path);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const child of readdirSync(path)) {
        if (child === ".terraform") {
          complete = false;
          continue;
        }
        removeEntry(join(path, child), child);
      }
      if (complete) rmdirSync(path);
    } else {
      unlinkSync(path);
    }
  };
  for (const name of readdirSync(root)) {
    if (name === ".terraform") {
      complete = false;
      continue;
    }
    removeEntry(join(root, name), name);
  }
  if (complete) rmdirSync(root);
  return complete;
}

function frameText(surface: TerminalSurface): string {
  return surface.frame().lines.map(stripGeneratedSgr).join("\n");
}

function selectedLine(text: string, label: string): boolean {
  return text.split("\n").some((line) => (line.includes("→ ") || line.includes("> ")) && line.includes(label));
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
  readonly ownedLabels = new Map<string, { label: string; workspace: string }>();
  readonly nativeExitWatchers = new Map<number, OwnedPidExitWatcher>();
  readonly submittedWorkspaces = new Set<string>();
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
    const resultFile = join(options.scratchRoot, "main-result.json");
    const optionsFile = join(options.scratchRoot, "main-options.json");
    const ptyExitLog = join(options.scratchRoot, "pty-exits.jsonl");
    const observerDirectory = dirname(options.observerFile);
    mkdirSync(observerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(options.observerFile, "", { mode: 0o600 });
    writeFileSync(ptyExitLog, "", { mode: 0o600 });
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
      PRG_SESSION_HOST_NATIVE_MAIN_ENTRY: join(options.candidate.root, "dist", "src", "session-host", "main.js"),
      PRG_SESSION_HOST_NATIVE_MAIN_OPTIONS: optionsFile,
      PRG_SESSION_HOST_NATIVE_MAIN_RESULT: resultFile,
      PRG_SESSION_HOST_NATIVE_MAIN_BASELINE: BASELINE,
      PRG_SESSION_HOST_NATIVE_MAIN_PTY_EXIT_LOG: ptyExitLog,
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

  sessions(): OwnedSession[] {
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
        `the manager-owned ${session.label} native PTY exit was observed through the real @lydell/node-pty onExit API`);
      assert.equal(record!.exitCode, 0,
        `the manager-owned ${session.label} native PTY exited with code 0 through its real public onExit event`);
      assert.ok(!record!.signal,
        `the manager-owned ${session.label} native PTY exit was not signal termination or escalation`);
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
      const frame = this.currentText().split("\n").filter((line) => line.trim()).slice(-12).join(" | ").slice(0, 2_000);
      const exit = this.exitEvent ? `exit=${this.exitEvent.exitCode}/${this.exitEvent.signal ?? 0}` : "still-running";
      throw new Error(`${description}: ${error instanceof Error ? error.message : "bounded frame wait failed"}; ${exit}; frames=${this.frameRevision}; ${frame}`);
    });
  }

  async writeAndWait(data: string, predicate: (text: string) => boolean, description: string): Promise<void> {
    const after = this.frameRevision;
    this.pty.write(data);
    await this.waitFrame(predicate, description, after);
  }

  async writeKeys(keys: string, description: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    const after = this.frameRevision;
    this.pty.write(keys);
    await this.waitFrame(() => true, description, after, timeoutMs);
  }

  async waitForRecords(
    predicate: (records: SessionRecord[]) => boolean,
    description: string,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<SessionRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.records()), timeoutMs, description);
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
    return selectedLine(this.currentText(), label);
  }

  async moveRosterTo(label: string, maximumDowns = 5, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    if (this.selected(label)) return;
    const labels = this.sessions().map((session) => session.label)
      .concat(["New session", "Quit host"]);
    for (let count = 0; count < maximumDowns; count += 1) {
      const selectedIndex = labels.findIndex((candidate) => this.selected(candidate));
      assert.ok(selectedIndex >= 0, "the owned roster has an observed highlighted row before navigation");
      const nextLabel = labels[(selectedIndex + 1) % labels.length]!;
      const after = this.frameRevision;
      this.pty.write(KEYS.down);
      // Native output and status can repaint before this key changes the roster.
      // Wait for the actual next highlight, not merely any parsed frame.
      await this.waitFrame((text) => selectedLine(text, nextLabel),
        `sidebar advances to ${nextLabel} toward ${label}`, after, timeoutMs);
      if (this.selected(label)) return;
    }
    throw new Error(`the real Main sidebar did not select the expected ${label} row; ${this.currentText().slice(0, 2_000)}`);
  }

  private nativeSelectedMenuRow(text: string): string | undefined {
    // This flow is exercised after restoring the verified wide layout. Ignore
    // the independent roster's highlight when that pane is visible.
    assert.equal(this.surface.frame().cols, OUTER_COLS);
    const nativeLeft = this.sidebarVisible ? 33 : 0;
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

  async toggleSidebar(timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    const nextVisible = !this.sidebarVisible;
    const after = this.frameRevision;
    this.pty.write(KEYS.f8);
    this.sidebarVisible = nextVisible;
    this.focus = nextVisible ? "sidebar" : "main";
    await this.waitFrame((text) => nextVisible
      ? text.includes("New session") && text.includes("Quit host")
      : !text.includes("New session") && !text.includes("Quit host"),
    `real F8 sidebar toggle ${nextVisible ? "opens" : "hides"} the pane`, after, timeoutMs);
  }

  async ensureSidebarFocus(timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
    if (this.focus === "sidebar" && this.sidebarVisible) return;
    if (this.focus === "form") {
      await this.toggleSidebar(timeoutMs); // abandons only the form UI ownership
    }
    if (this.sidebarVisible && this.focus !== "sidebar") {
      await this.toggleSidebar(timeoutMs);
    }
    if (!this.sidebarVisible) {
      await this.toggleSidebar(timeoutMs);
    }
    assert.equal(this.focus, "sidebar");
  }

  async activateRoster(label: string, expectedDraft?: string): Promise<void> {
    await this.ensureSidebarFocus();
    await this.moveRosterTo(label);
    const after = this.frameRevision;
    this.pty.write(KEYS.enter);
    this.focus = "main";
    await this.waitFrame((text) => text.split("\n")[0]?.includes(`Session host · ${label} ·`) === true
      && (expectedDraft === undefined || text.includes(expectedDraft)),
    `Enter activates the highlighted native session ${label} with its own observed header and surface`, after);
  }

  /**
   * Create one real native session through the actual New session form. An
   * explicit existing profile directory (with its local review-gate.json) is
   * entered in the form's Profile field; omitted creates a fresh private
   * profile exactly as before.
   */
  async createNativeSession(label: string, workspace: string, profile?: string): Promise<OwnedSession> {
    const canonicalWorkspace = realpathSync(workspace);
    if (profile !== undefined) {
      assert.ok(existsSync(profile), `the explicit profile directory for ${label} exists before host creation`);
      assert.ok(existsSync(join(profile, "review-gate.json")),
        `the explicit profile for ${label} carries its local review-gate.json before host creation`);
    }
    this.ownedLabels.set(canonicalWorkspace, { label, workspace: canonicalWorkspace });
    await this.ensureSidebarFocus();
    await this.moveRosterTo("New session");
    const afterOpen = this.frameRevision;
    this.pty.write(KEYS.enter);
    this.focus = "form";
    await this.waitFrame((text) => text.includes("New session") && text.includes("Label:")
      && text.includes("Workspace:") && text.includes("Profile:") && text.includes("enter next/submit"),
    `new-session form opens for ${label}`, afterOpen);

    // Empty initial fields do not redraw when Ctrl+U/Ctrl+K are no-ops; write
    // the clear bindings without waiting, then observe the following text edit.
    this.pty.write(`${KEYS.ctrlU}${KEYS.ctrlK}`);
    await this.writeAndWait(label, (text) => text.includes(label), `new-session label ${label} is entered`);
    await this.writeKeys(KEYS.enter, `new-session label ${label} advances`);
    this.pty.write(`${KEYS.ctrlU}${KEYS.ctrlK}`);
    await this.writeAndWait(canonicalWorkspace, (text) => text.includes(canonicalWorkspace.slice(-18)),
      `explicit workspace for ${label} is entered`);
    await this.writeKeys(KEYS.enter, `new-session workspace ${label} advances`);
    this.pendingWorkspace = canonicalWorkspace;
    this.submittedWorkspaces.add(canonicalWorkspace);
    // completeCreate retains form field values across successful creations
    // (it resets only the field index and error), so explicitly clear the
    // retained Profile before entering or submitting it; an empty-field clear
    // is a no-op with no redraw, so no repaint wait follows.
    this.pty.write(`${KEYS.ctrlU}${KEYS.ctrlK}`);
    if (profile === undefined) {
      await this.writeKeys(KEYS.enter, `blank fresh profile for ${label} is submitted`);
    } else {
      const canonicalProfile = realpathSync(profile);
      await this.writeAndWait(canonicalProfile, (text) => text.includes(canonicalProfile.slice(-18)),
        `explicit profile for ${label} is entered`);
      await this.writeKeys(KEYS.enter, `explicit profile for ${label} is submitted`);
    }
    this.focus = "sidebar";

    const records = await this.waitForRecords(
      (entries) => entries.some((record) => record.type === "session_start" && record.cwd === canonicalWorkspace),
      `real native Pi ${label} session_start with its selected workspace`,
    );
    this.pendingWorkspace = undefined;
    const record = records.find((entry) => entry.type === "session_start" && entry.cwd === canonicalWorkspace);
    assert.ok(record, `native observer recorded ${label}`);
    assert.ok(Number.isSafeInteger(record.pid), `native observer recorded an owned PID for ${label}`);
    const exitWatcher = new OwnedPidExitWatcher(record.pid!);
    this.nativeExitWatchers.set(record.pid!, exitWatcher);
    await exitWatcher.waitUntilRegistered(EVENT_TIMEOUT_MS);
    await this.waitFrame((text) => selectedLine(text, label) && text.includes("Session host"),
      `new row ${label} is highlighted after completion without activation`);
    return { label, workspace: canonicalWorkspace, record, exitWatcher };
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
        `owned native ${session.label} receives a fresh ${expectedNativeCols}x${expectedNativeRows} pane after outer resize to ${cols}x${rows}`,
      );
    }
  }

  async closeNativeNormally(session: OwnedSession): Promise<void> {
    assert.equal(this.focus, "main", `native input is focused on ${session.label}`);
    assert.equal(processIsAlive(session.record.pid), true, `${session.label} is alive before its native Ctrl+C exit`);
    const before = this.frameRevision;
    this.pty.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
    await this.waitForRecords((records) => records.some((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid), `real ${session.label} session_shutdown lifecycle event`);
    // The exact active-owner header proves THIS session reached lifecycle
    // exited (set only after its real native onExit), and the same-owner row
    // carries the zero exit status; another owner's already-exited row can
    // never satisfy both.
    await this.waitFrame((text) => {
      const lines = text.split("\n");
      if (lines[0]?.includes(`Session host · ${session.label} · exited`) !== true) return false;
      return lines.some((line) => line.includes(session.label) && line.includes("[exited (code 0)]"));
    }, `Main observes the normal owned ${session.label} process exit with code 0`, before);
    await session.exitWatcher.waitForExit(EVENT_TIMEOUT_MS);
    assert.equal(session.exitWatcher.observedExit, true,
      `${session.label} received the kernel EVFILT_PROC/NOTE_EXIT event for its exact owned PID`);
    await this.assertGracefulPtyExits([session]);
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
    assert.ok(frameText(this.surface).includes(this.baseline), "the outer terminal emulator observes its pre-Main primary-screen baseline after restoration");
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
    assert.equal(this.sessions().length, this.submittedWorkspaces.size,
      "every submitted native session has a test-owned OS-exit watcher before host shutdown");
    assert.ok(starts.every((record) => this.nativeExitWatchers.get(record.pid!)?.observedExit === true),
      "the host is quit only after every owned native child OS exit is confirmed");
    await this.ensureSidebarFocus();
    await this.moveRosterTo("Quit host");
    this.pty.write(KEYS.enter);
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
          && this.sessions().length === this.submittedWorkspaces.size;
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
                await this.moveRosterTo(owned.label, 5, CLEANUP_UI_TIMEOUT_MS);
                this.pty.write(KEYS.enter);
                this.focus = "main";
                this.pty.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
                await this.waitForRecords((records) => records.some((entry) => entry.type === "session_shutdown"
                  && entry.pid === record.pid), `bounded normal cleanup lifecycle for ${owned.label}`, CLEANUP_LIFECYCLE_TIMEOUT_MS);
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
            && this.sessions().length === this.submittedWorkspaces.size;
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
        && this.sessions().length === this.submittedWorkspaces.size;
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
