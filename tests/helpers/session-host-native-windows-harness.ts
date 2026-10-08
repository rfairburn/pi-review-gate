/**
 * Test-only Windows ConPTY acceptance harness for the public Main session host.
 *
 * This deliberately uses the real public runSessionHost entry point and the
 * public @lydell/node-pty API. Native Pi lifecycle evidence comes from the
 * existing public-event observer fixture; exact-process exit evidence comes
 * from the retained Windows PowerShell/.NET Process handle fixture. It is not
 * a simulator and does not use Main's internal dependency-injection seam.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

import { TerminalSurface, stripGeneratedSgr } from "../../src/session-host/terminal-surface";
import {
  assertNativeEditorFieldEmpty,
  borderedEditorContentMatches,
  classifyFirstWorkspaceEnter,
  requireFolderCompletedObservation,
  windowsDirectoryCompletionCandidates,
  sameFileIdentity,
  validateWindowsExitWitness,
  type FileIdentity,
  type WindowsExitWitness,
  type WindowsWitnessExpectation,
} from "./session-host-native-windows-contracts";

export {
  assertNativeEditorFieldEmpty,
  borderedEditorContentMatches,
  classifyFirstWorkspaceEnter,
  requireFolderCompletedObservation,
  readBorderedEditorContent,
  windowsDirectoryCompletionCandidates,
  sameFileIdentity,
  validateWindowsExitWitness,
} from "./session-host-native-windows-contracts";
export type { FileIdentity, WindowsExitWitness, WindowsWitnessExpectation } from "./session-host-native-windows-contracts";

export const WINDOWS_TEST_TIMEOUT_MS = 6 * 60_000;
export const WINDOWS_EVENT_TIMEOUT_MS = 30_000;
export const WINDOWS_OBSERVER_TIMEOUT_SECONDS = 180;
export const WINDOWS_OUTER_COLS = 120;
export const WINDOWS_OUTER_ROWS = 50;
export const WINDOWS_REQUIRE_ENV = "PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST";
export const WINDOWS_OBSERVER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-windows-exit-watcher.ps1");
export const WINDOWS_RUNNER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-windows-main-runner.cjs");
export const NATIVE_OBSERVER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-observer.cjs");
export const NATIVE_PROVIDER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-native-provider.cjs");

const WINDOWS_BASELINE = "SESSION_HOST_NATIVE_WINDOWS_OUTER_RESTORATION_BASELINE";
const ROLE_ENV = "PI_REVIEW_GATE_RUNTIME_ROLE";
const TOOL_CATALOG_ENV = "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG";
const CREDENTIAL_NAME = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_WITNESS_BYTES = 1024;
const createdDirectoryIdentities = new Map<string, FileIdentity>();
const createdFileIdentities = new Map<string, FileIdentity>();

export const WINDOWS_KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  f8: "\x1b[19~",
  ctrlC: "\x03",
};

export interface NativePtyExit {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface NativePtyHandle {
  readonly pid: number | string;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: NativePtyExit) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Only used for failed-test cleanup, always with no signal argument. */
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

export interface WindowsRuntimePin {
  readonly agentDir: string;
  readonly piExecutable: string;
  readonly version: "1.0.4";
  readonly nodePath: string;
  readonly pty: NativePtyModule;
  readonly ptyModulePath: string;
  readonly candidateEntry: string;
  readonly packageRoot: string;
  readonly mainEntry: string;
  readonly powershell: string;
}

export interface NativeJournalRecord {
  readonly type?: string;
  readonly reason?: string;
  readonly pid?: number;
  readonly cwd?: string;
  readonly contextCwd?: string;
  readonly agentDir?: string;
  readonly sessionId?: string;
  readonly contextSessionId?: string;
  readonly sessionFile?: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly tty?: boolean;
  readonly credentialLikeEnvironmentNames?: string[];
  readonly [key: string]: unknown;
}

export interface PtyJournalRecord {
  readonly type?: string;
  readonly pid?: number;
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly signal?: number | string | null;
  readonly [key: string]: unknown;
}

export function identityOfRealDirectory(path: string): FileIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev <= 0n || stats.ino <= 0n) {
    throw new Error("required owned path is not a real directory with a usable BigInt identity");
  }
  return { dev: stats.dev, ino: stats.ino };
}

export function assertCurrentDirectoryIdentity(path: string, expected: FileIdentity): void {
  const observed = identityOfRealDirectory(path);
  if (!sameFileIdentity(observed, expected)) {
    throw new Error("owned Windows observer root identity changed");
  }
}

export function assertCreatedDirectoryIdentity(path: string): void {
  const observed = identityOfRealDirectory(path);
  const expected = createdDirectoryIdentities.get(realpathSync(path));
  if (!expected || !sameFileIdentity(expected, observed)) {
    throw new Error("task-created directory identity is absent or changed");
  }
}

export function assertCreatedFileIdentity(path: string): void {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.dev <= 0n || stats.ino <= 0n) {
    throw new Error("task-created file no longer has a positive BigInt regular-file identity");
  }
  const expected = createdFileIdentities.get(path);
  if (!expected || !sameFileIdentity(expected, { dev: stats.dev, ino: stats.ino })) {
    throw new Error("task-created file identity is absent or changed");
  }
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
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertRealDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Windows harness refused a symlinked or non-directory root");
  }
}

/** Creates one fresh ignored root; no pre-existing contents are inspected or deleted. */
export function createWindowsHarnessRoot(): string {
  const nodeModules = join(process.cwd(), "node_modules");
  assertRealDirectory(nodeModules);
  const privateParent = join(nodeModules, ".winmain");
  try {
    mkdirSync(privateParent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertRealDirectory(privateParent);
  const parentReal = realpathSync(privateParent);
  if (!isWithin(realpathSync(nodeModules), parentReal)) {
    throw new Error("Windows harness private parent escaped the owned node_modules tree");
  }
  const root = mkdtempSync(join(parentReal, "r-"));
  if (process.platform !== "win32") chmodSync(root, 0o700);
  const canonical = realpathSync(root);
  assertRealDirectory(canonical);
  if (!isWithin(parentReal, canonical)) throw new Error("Windows harness root escaped its private parent");
  createdDirectoryIdentities.set(canonical, identityOfRealDirectory(canonical));
  return canonical;
}

export function createOwnedDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  assertRealDirectory(path);
  if (process.platform !== "win32") chmodSync(path, 0o700);
  const canonical = realpathSync(path);
  if (!isWithin(realpathSync(parent), canonical)) throw new Error("owned fixture directory escaped its parent");
  createdDirectoryIdentities.set(canonical, identityOfRealDirectory(canonical));
  return canonical;
}

export function writeOwnedFile(path: string, contents: string | Buffer, mode = 0o600): void {
  writeFileSync(path, contents, { flag: "wx", mode });
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.dev <= 0n || stats.ino <= 0n) {
    throw new Error("owned fixture file has no positive BigInt regular-file identity");
  }
  createdFileIdentities.set(path, { dev: stats.dev, ino: stats.ino });
  if (process.platform !== "win32") chmodSync(path, mode);
}

function safeWindowsPath(systemRoot: string): string {
  return [
    join(systemRoot, "System32"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    dirname(process.execPath),
  ].join(delimiter);
}

function resolvePiRuntime(agentDirValue: string, piBinValue: string, expectedVersion: string): {
  agentDir: string;
  piExecutable: string;
} {
  if (expectedVersion !== "1.0.4") throw new Error("Windows native Main acceptance requires public Pi 1.0.4");
  const agentDir = realpathSync(agentDirValue);
  const packageInfo = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (packageInfo.name !== "@earendil-works/pi-coding-agent" || packageInfo.version !== expectedVersion) {
    throw new Error("explicit Windows Pi runtime pin is not the supported public Pi package/version");
  }
  const declaredBin = typeof packageInfo.bin === "string" ? packageInfo.bin : packageInfo.bin?.pi;
  if (!declaredBin) throw new Error("pinned public Pi package has no declared Node CLI entry");
  const candidates = [join(agentDir, declaredBin), join(agentDir, "dist", "cli.js")];
  const supported = new Set<string>();
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (isWithin(agentDir, real) && lstatSync(real).isFile()) supported.add(real);
    } catch {
      // A missing package-declared alternative is not a reason to scan elsewhere.
    }
  }
  if (supported.size === 0) throw new Error("pinned Pi package has no contained public Node CLI entry");
  const requestedPin = realpathSync(piBinValue);
  const pinStats = lstatSync(requestedPin);
  let piExecutable: string;
  if (pinStats.isDirectory()) {
    const expectedBin = realpathSync(join(dirname(dirname(agentDir)), ".bin"));
    if (requestedPin !== expectedBin) throw new Error("Windows Pi bin-directory pin does not belong to the pinned package");
    piExecutable = [...supported][0]!;
  } else if (pinStats.isFile() && supported.has(requestedPin)) {
    piExecutable = requestedPin;
  } else {
    throw new Error("Windows Pi executable pin must name its supported public Node CLI entry or package bin directory");
  }
  return { agentDir, piExecutable };
}

function resolveCandidate(candidateValue: string): { candidateEntry: string; packageRoot: string; mainEntry: string } {
  const candidateEntry = realpathSync(candidateValue);
  if (!isAbsolute(candidateEntry)) throw new Error("staged candidate entry must be an absolute path");
  const packageRoot = dirname(dirname(dirname(candidateEntry)));
  if (realpathSync(join(packageRoot, "dist", "src", "index.js")) !== candidateEntry) {
    throw new Error("parent-provided candidate entry is not the conventional dist/src/index.js");
  }
  const mainEntry = realpathSync(join(packageRoot, "dist", "src", "session-host", "main.js"));
  for (const path of [
    join(packageRoot, "scripts", "session-host-startup-options.cjs"),
    join(packageRoot, "dist", "src", "session-host", "instances.js"),
  ]) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("staged candidate is missing a real public Main package file");
  }
  return { candidateEntry, packageRoot, mainEntry };
}

function requireModuleRoots(agentDir: string, packageRoot: string): { nodePath: string; pty: NativePtyModule; ptyModulePath: string } {
  const projectRoot = realpathSync(process.cwd());
  const roots = [
    join(projectRoot, "node_modules"),
    join(packageRoot, "node_modules"),
    join(agentDir, "node_modules"),
    dirname(dirname(agentDir)),
  ];
  const canonicalRoots: string[] = [];
  for (const candidate of [...new Set(roots)]) {
    try {
      const stats = lstatSync(candidate);
      if (stats.isDirectory() && !stats.isSymbolicLink()) canonicalRoots.push(realpathSync(candidate));
    } catch {
      // Optional resolution roots remain absent rather than being searched ambiently.
    }
  }
  const requireFromProject = createRequire(join(projectRoot, "package.json"));
  for (const request of ["@xterm/headless", "@xterm/addon-unicode11", "@lydell/node-pty"]) {
    requireFromProject.resolve(request);
  }
  const ptyModulePath = requireFromProject.resolve("@lydell/node-pty");
  const pty = requireFromProject("@lydell/node-pty") as NativePtyModule;
  if (!pty || typeof pty.spawn !== "function") throw new Error("public @lydell/node-pty spawn API is unavailable");
  return { nodePath: canonicalRoots.join(delimiter), pty, ptyModulePath };
}

function locateWindowsPowerShell(systemRoot: string): string {
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const stats = lstatSync(executable);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Windows PowerShell 5.1 executable is unavailable");
  return executable;
}

export function probeWindowsPowerShell(runtime: WindowsRuntimePin, home: string, temporary: string): void {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows SystemRoot is unavailable for the PowerShell readiness probe");
  const env: NodeJS.ProcessEnv = {
    PATH: safeWindowsPath(systemRoot),
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR ?? systemRoot,
    HOME: home,
    USERPROFILE: home,
    TEMP: temporary,
    TMP: temporary,
  };
  const result = spawnSync(runtime.powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    cwd: process.cwd(),
    env,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  if (result.error || result.status !== 0 || !/^5\.1\.[0-9.]+\s*$/.test(result.stdout ?? "")) {
    throw new Error("required Windows PowerShell 5.1 readiness probe failed");
  }
}

/** Fails closed after opt-in; no ambient runtime/candidate fallback is allowed. */
export function resolveWindowsRuntime(): WindowsRuntimePin {
  if (process.platform !== "win32") throw new Error("required real Windows Main acceptance was requested on a non-Windows host");
  const nodeVersion = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
  if (!nodeVersion) throw new Error("stable Node version could not be established for the Windows native host");
  const major = Number(nodeVersion[1]);
  const minor = Number(nodeVersion[2]);
  if (!(major > 22 || (major === 22 && minor >= 19))) throw new Error("Windows native Main acceptance requires stable Node >=22.19.0");

  // Refuse real executor capabilities before constructing the allowlisted test env.
  assertNoRoleOrCatalogMarkers(process.env);
  const agentPin = process.env.PI_REVIEW_GATE_INSTALLED_AGENT?.trim();
  const binPin = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN?.trim();
  const versionPin = process.env.PI_REVIEW_GATE_EXPECT_PI_VERSION?.trim();
  const candidatePin = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY?.trim();
  if (!agentPin || !binPin || !versionPin || !candidatePin) {
    throw new Error("Windows native Main acceptance requires explicit staged candidate and pinned public Pi runtime env");
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable for ConPTY/PowerShell");

  const { agentDir, piExecutable } = resolvePiRuntime(agentPin, binPin, versionPin);
  const candidate = resolveCandidate(candidatePin);
  const moduleRoots = requireModuleRoots(agentDir, candidate.packageRoot);
  const powershell = locateWindowsPowerShell(systemRoot);
  return {
    ...candidate,
    agentDir,
    piExecutable,
    version: "1.0.4",
    nodePath: moduleRoots.nodePath,
    pty: moduleRoots.pty,
    ptyModulePath: moduleRoots.ptyModulePath,
    powershell,
  };
}

export function assertNoRoleOrCatalogMarkers(env: NodeJS.ProcessEnv = process.env): void {
  assert.equal(Object.hasOwn(env, ROLE_ENV), false, "native Windows test cannot run with PI_REVIEW_GATE_RUNTIME_ROLE");
  assert.equal(Object.hasOwn(env, TOOL_CATALOG_ENV), false, "native Windows test cannot run with PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG");
}

export function createNativeAgentRoot(root: string): string {
  const agentDir = createOwnedDirectory(root, "native-agent");
  writeOwnedFile(join(agentDir, "review-gate.json"), JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {},
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  }, null, 2));
  return agentDir;
}

export function boundedJsonl<T extends object>(path: string, maximumBytes = MAX_JOURNAL_BYTES): T[] {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > BigInt(maximumBytes)) {
      throw new Error("bounded journal is not a regular file within its byte limit");
    }
    if (createdFileIdentities.has(path)) assertCreatedFileIdentity(path);
    const records: T[] = [];
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("journal line is not a JSON object");
        }
        records.push(parsed as T);
      } catch {
        if (index === lines.length - 1 && !text.endsWith("\n")) continue;
        throw new Error("bounded journal contains a malformed complete JSONL record");
      }
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function readNativeRecords(path: string): NativeJournalRecord[] {
  return boundedJsonl<NativeJournalRecord>(path);
}

export function readPtyRecords(path: string): PtyJournalRecord[] {
  return boundedJsonl<PtyJournalRecord>(path);
}

function frameText(surface: TerminalSurface): string {
  return surface.frame().lines.map(stripGeneratedSgr).join("\n");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function rowLabel(line: string): string | undefined {
  const match = /^\s*[>→] (.*)$/.exec(line);
  if (!match) return undefined;
  return match[1]!.replace(/\s+\[(?:AGENT:.*|starting\]|exited.*|error.*|input\]).*$/, "").trim();
}

function selectedRosterLabel(frame: string): string | undefined {
  // Main's settled wide layout gives the sidebar its leftmost 32 columns;
  // do not mistake the right-pane Editor prompt for a selected roster row.
  return frame.split("\n").slice(1).map((line) => rowLabel(line.slice(0, 32)))
    .find((label) => label !== undefined);
}

function workspaceFieldEmpty(frame: string): boolean {
  try {
    assertNativeEditorFieldEmpty(frame, "> Workspace:");
    return true;
  } catch {
    return false;
  }
}

function writeMetadata(path: string, record: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export interface WindowsOwnedSession {
  readonly label: string;
  readonly workspace: string;
  readonly record: NativeJournalRecord;
}

interface MainResult {
  readonly status: number;
  readonly threw: boolean;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly sameInputStream: boolean;
  readonly sameOutputStream: boolean;
  readonly rawBefore: unknown;
  readonly rawAfter: unknown;
}

export class WindowsMainPtyDriver {
  readonly pty: NativePtyHandle;
  readonly root: string;
  readonly optionsFile: string;
  readonly resultFile: string;
  readonly observerFile: string;
  readonly providerJournal: string;
  readonly ptyJournal: string;
  readonly forceJournal: string;
  readonly surface: TerminalSurface;
  readonly frameSignal = new ChangeSignal();
  readonly outputSignal = new ChangeSignal();
  readonly journalSignal = new ChangeSignal();
  readonly exitSignal = new ChangeSignal();
  readonly replyLog: string[] = [];
  readonly modeSnapshots: ReturnType<TerminalSurface["inputModes"]>[] = [];
  readonly logWatcher: FSWatcher;
  readonly nativeWatcher: FSWatcher;
  readonly providerWatcher: FSWatcher;
  exitEvent?: NativePtyExit;
  frameRevision = 0;
  outputRevision = 0;
  sidebarVisible = true;
  focus: "sidebar" | "form" | "main" = "sidebar";
  private outputTail = "";
  private currentFrame = "";
  private parserError?: Error;
  private sawAlternateEnter = false;
  private sawAlternateLeave = false;
  private readonly dataSubscription: { dispose(): void };
  private readonly exitSubscription: { dispose(): void };
  private readonly initialModes: ReturnType<TerminalSurface["inputModes"]>;
  private forced = false;

  private constructor(options: {
    pty: NativePtyHandle;
    root: string;
    optionsFile: string;
    resultFile: string;
    observerFile: string;
    providerJournal: string;
    ptyJournal: string;
    forceJournal: string;
    logWatcher: FSWatcher;
    nativeWatcher: FSWatcher;
    providerWatcher: FSWatcher;
  }) {
    this.pty = options.pty;
    this.root = options.root;
    this.optionsFile = options.optionsFile;
    this.resultFile = options.resultFile;
    this.observerFile = options.observerFile;
    this.providerJournal = options.providerJournal;
    this.ptyJournal = options.ptyJournal;
    this.forceJournal = options.forceJournal;
    this.logWatcher = options.logWatcher;
    this.nativeWatcher = options.nativeWatcher;
    this.providerWatcher = options.providerWatcher;
    this.surface = new TerminalSurface(WINDOWS_OUTER_COLS, WINDOWS_OUTER_ROWS, {
      onReply: (reply) => {
        this.replyLog.push(reply);
        try { this.pty.write(reply); } catch { /* exact outer PTY may have exited */ }
      },
      onChange: () => this.refreshFrame(),
    });
    this.initialModes = this.surface.inputModes();
    this.modeSnapshots.push(this.initialModes);
    this.refreshFrame();
    this.dataSubscription = this.pty.onData((data) => this.onData(data));
    this.exitSubscription = this.pty.onExit((event) => {
      this.exitEvent = event;
      this.exitSignal.notify();
      this.frameSignal.notify();
    });
    this.logWatcher.on("change", () => this.journalSignal.notify());
    this.nativeWatcher.on("change", () => this.journalSignal.notify());
    this.providerWatcher.on("change", () => this.journalSignal.notify());
  }

  static start(options: {
    readonly root: string;
    readonly runtime: WindowsRuntimePin;
    readonly nativeAgentDir: string;
    readonly home: string;
    readonly temporary: string;
    readonly stateRoot: string;
    readonly fixtureState: string;
    readonly workspaceA: string;
    readonly workspaceB: string;
  }): WindowsMainPtyDriver {
    const runnerFixture = realpathSync(WINDOWS_RUNNER_FIXTURE);
    const mainEntry = options.runtime.mainEntry;
    assertRealDirectory(options.root);
    assertRealDirectory(options.stateRoot);
    const optionsFile = join(options.root, "main-options.json");
    const resultFile = join(options.root, "main-result.json");
    const observerFile = join(options.root, "observer", "native-main.jsonl");
    const providerJournal = join(options.fixtureState, "provider-journal.jsonl");
    const ptyJournal = join(options.root, "pty-events.jsonl");
    const forceJournal = join(options.root, "force-events.jsonl");
    for (const path of [observerFile, providerJournal, ptyJournal, forceJournal]) writeOwnedFile(path, "");

    const args = [
      "--offline", "--no-context-files", "--no-themes", "--no-tools",
      "--extension", realpathSync(NATIVE_OBSERVER_FIXTURE),
      "--extension", realpathSync(NATIVE_PROVIDER_FIXTURE),
    ];
    const nativeEnv: NodeJS.ProcessEnv = {
      PATH: safeWindowsPath(process.env.SystemRoot ?? process.env.WINDIR!),
      SystemRoot: process.env.SystemRoot ?? process.env.WINDIR,
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
      HOME: options.home,
      USERPROFILE: options.home,
      TEMP: options.temporary,
      TMP: options.temporary,
      TMPDIR: options.temporary,
      NODE_PATH: options.runtime.nodePath,
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: options.nativeAgentDir,
      PI_REVIEW_GATE_CANDIDATE_ENTRY: options.runtime.candidateEntry,
      PI_REVIEW_GATE_INSTALLED_AGENT: options.runtime.agentDir,
      PI_REVIEW_GATE_INSTALLED_PI_BIN: process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN,
      PI_REVIEW_GATE_EXPECT_PI_VERSION: options.runtime.version,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PRG_SESSION_HOST_NATIVE_MAIN_OBSERVER_FILE: observerFile,
      PRG_FIXTURE_AGENT_DIR: options.runtime.agentDir,
      PRG_FIXTURE_STATE_DIR: options.fixtureState,
      PRG_FIXTURE_NO_AUTO_MODEL: "1",
      ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    };
    assertNoRoleOrCatalogMarkers(nativeEnv);
    assert.deepEqual(Object.keys(nativeEnv).filter((name) => CREDENTIAL_NAME.test(name)), [],
      "allowlisted native Windows child environment contains no credential-like variable names");
    writeOwnedFile(optionsFile, JSON.stringify({
      packageRoot: options.runtime.packageRoot,
      piExecutable: options.runtime.piExecutable,
      stateRoot: options.stateRoot,
      toggleKey: "f8",
      args,
      env: nativeEnv,
    }));

    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR!;
    const hostEnv: NodeJS.ProcessEnv = {
      PATH: safeWindowsPath(systemRoot),
      SystemRoot: systemRoot,
      WINDIR: process.env.WINDIR ?? systemRoot,
      HOME: options.home,
      USERPROFILE: options.home,
      TEMP: options.temporary,
      TMP: options.temporary,
      TMPDIR: options.temporary,
      NODE_PATH: options.runtime.nodePath,
      TERM: "xterm-256color",
      PRG_SESSION_HOST_WINDOWS_MAIN_ENTRY: mainEntry,
      PRG_SESSION_HOST_WINDOWS_OPTIONS: optionsFile,
      PRG_SESSION_HOST_WINDOWS_RESULT: resultFile,
      PRG_SESSION_HOST_WINDOWS_PTY_JOURNAL: ptyJournal,
      PRG_SESSION_HOST_WINDOWS_FORCE_JOURNAL: forceJournal,
      PRG_SESSION_HOST_WINDOWS_PTY_MODULE: options.runtime.ptyModulePath,
      PRG_SESSION_HOST_WINDOWS_BASELINE: WINDOWS_BASELINE,
      PI_REVIEW_GATE_CANDIDATE_ENTRY: options.runtime.candidateEntry,
      PI_REVIEW_GATE_INSTALLED_AGENT: options.runtime.agentDir,
      PI_REVIEW_GATE_INSTALLED_PI_BIN: process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN,
      PI_REVIEW_GATE_EXPECT_PI_VERSION: options.runtime.version,
      PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST: "1",
      ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    };
    assertNoRoleOrCatalogMarkers(hostEnv);
    const logWatcher = watch(options.root);
    const nativeWatcher = watch(dirname(observerFile));
    const providerWatcher = watch(options.fixtureState);
    let pty: NativePtyHandle;
    try {
      pty = options.runtime.pty.spawn(process.execPath, [runnerFixture], {
        name: "xterm-256color",
        cols: WINDOWS_OUTER_COLS,
        rows: WINDOWS_OUTER_ROWS,
        cwd: process.cwd(),
        env: hostEnv,
        encoding: "utf8",
      });
    } catch (error) {
      logWatcher.close();
      nativeWatcher.close();
      providerWatcher.close();
      throw new Error(`public Windows ConPTY spawn failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!Number.isSafeInteger(Number(pty.pid)) || Number(pty.pid) <= 1) {
      logWatcher.close();
      nativeWatcher.close();
      providerWatcher.close();
      throw new Error("public Windows ConPTY did not return an exact outer process PID");
    }
    try {
      return new WindowsMainPtyDriver({
        pty,
        root: options.root,
        optionsFile,
        resultFile,
        observerFile,
        providerJournal,
        ptyJournal,
        forceJournal,
        logWatcher,
        nativeWatcher,
        providerWatcher,
      });
    } catch (error) {
      writeMetadata(forceJournal, { type: "outer_pty_force_attempt", pid: Number(pty.pid) });
      try { pty.kill(); } catch { /* exact newly owned public outer PTY, no signal */ }
      logWatcher.close();
      nativeWatcher.close();
      providerWatcher.close();
      throw error;
    }
  }

  records(): NativeJournalRecord[] {
    return readNativeRecords(this.observerFile);
  }

  ptyRecords(): PtyJournalRecord[] {
    return readPtyRecords(this.ptyJournal);
  }

  providerRecords(): Record<string, unknown>[] {
    return boundedJsonl<Record<string, unknown>>(this.providerJournal);
  }

  private onData(data: string): void {
    this.outputRevision += 1;
    this.outputSignal.notify();
    this.outputTail = (this.outputTail + data).slice(-512 * 1024);
    this.sawAlternateEnter ||= this.outputTail.includes("\x1b[?1049h");
    this.sawAlternateLeave ||= this.outputTail.includes("\x1b[?1049l");
    try {
      this.surface.write(data);
      const snapshot = this.surface.inputModes();
      if (this.modeSnapshots.length < 2_000) this.modeSnapshots.push(snapshot);
      this.refreshFrame();
    } catch {
      this.parserError = new Error("actual ConPTY output could not be parsed by the public terminal surface");
    }
  }

  private refreshFrame(): void {
    try {
      this.currentFrame = frameText(this.surface);
      this.frameRevision += 1;
      this.frameSignal.notify();
    } catch {
      this.parserError = new Error("actual ConPTY frame could not be read");
    }
  }

  currentText(): string {
    if (this.parserError) throw this.parserError;
    return this.currentFrame;
  }

  async waitFrame(predicate: (frame: string) => boolean, description: string, after = -1, timeoutMs = WINDOWS_EVENT_TIMEOUT_MS): Promise<void> {
    await this.frameSignal.waitFor(() => {
      if (this.exitEvent && !(this.frameRevision > after && predicate(this.currentText()))) {
        throw new Error("outer Main ConPTY exited before the expected frame");
      }
      return this.frameRevision > after && predicate(this.currentText());
    }, timeoutMs, description).catch((error: unknown) => {
      const tail = this.currentText().split("\n").filter((line) => line.trim()).slice(-12).join(" | ").slice(0, 2_000);
      throw new Error(`${description}: ${error instanceof Error ? error.message : "bounded frame wait failed"}; frame=${tail}`);
    });
  }

  async waitForNative(predicate: (records: NativeJournalRecord[]) => boolean, description: string, timeoutMs = WINDOWS_EVENT_TIMEOUT_MS): Promise<NativeJournalRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.records()), timeoutMs, description);
    return this.records();
  }

  async waitForPty(predicate: (records: PtyJournalRecord[]) => boolean, description: string, timeoutMs = WINDOWS_EVENT_TIMEOUT_MS): Promise<PtyJournalRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.ptyRecords()), timeoutMs, description);
    return this.ptyRecords();
  }

  async waitForProvider(predicate: (records: Record<string, unknown>[]) => boolean, description: string, timeoutMs = WINDOWS_EVENT_TIMEOUT_MS): Promise<Record<string, unknown>[]> {
    await this.journalSignal.waitFor(() => predicate(this.providerRecords()), timeoutMs, description);
    return this.providerRecords();
  }

  async waitForExit(timeoutMs = WINDOWS_EVENT_TIMEOUT_MS): Promise<NativePtyExit> {
    if (!this.exitEvent) await this.exitSignal.waitFor(() => this.exitEvent !== undefined, timeoutMs, "outer public Main PTY exit");
    return this.exitEvent!;
  }

  private selectedLabel(): string | undefined {
    return selectedRosterLabel(this.currentText());
  }

  private async send(data: string, description: string, predicate?: (frame: string) => boolean): Promise<void> {
    const before = this.frameRevision;
    this.pty.write(data);
    await this.waitFrame(predicate ?? (() => true), description, before);
  }

  private async toggleSidebar(): Promise<void> {
    const nextVisible = !this.sidebarVisible;
    const before = this.frameRevision;
    this.pty.write(WINDOWS_KEYS.f8);
    this.sidebarVisible = nextVisible;
    this.focus = nextVisible ? "sidebar" : "main";
    await this.waitFrame((frame) => nextVisible
      ? frame.includes("New session") && frame.includes("Quit host")
      : !frame.includes("New session") && !frame.includes("Quit host"),
    `public F8 toggles the Main sidebar ${nextVisible ? "visible" : "hidden"}`, before);
  }

  async ensureSidebarFocus(): Promise<void> {
    if (this.focus === "sidebar" && this.sidebarVisible) return;
    if (this.focus === "form") {
      this.pty.write(WINDOWS_KEYS.escape);
      await this.waitFrame((frame) => !frame.includes("Workspace:") && !frame.includes("Edit native session name"),
        "public Escape cancels an incomplete sidebar form");
      this.focus = "main";
    }
    if (this.sidebarVisible && this.focus !== "sidebar") await this.toggleSidebar();
    if (!this.sidebarVisible) await this.toggleSidebar();
    assert.equal(this.focus, "sidebar");
  }

  async moveRosterTo(label: string): Promise<void> {
    await this.ensureSidebarFocus();
    for (let presses = 0; presses < 8; presses += 1) {
      if (this.selectedLabel() === label) return;
      const beforeLabel = this.selectedLabel();
      assert.ok(beforeLabel, "actual public Main sidebar exposes a selected row");
      const before = this.frameRevision;
      this.pty.write(WINDOWS_KEYS.down);
      await this.waitFrame((frame) => selectedRosterLabel(frame) !== beforeLabel,
        `sidebar selection advances from ${beforeLabel}`, before);
    }
    assert.equal(this.selectedLabel(), label, `actual Main sidebar selected ${label}`);
  }

  async createNativeSession(workspace: string, label: string, priorActiveHeader?: string): Promise<WindowsOwnedSession> {
    const canonicalWorkspace = realpathSync(workspace);
    await this.ensureSidebarFocus();
    await this.moveRosterTo("New session");
    await this.send(WINDOWS_KEYS.enter, "Workspace-only New form opens", (frame) => frame.includes("New session") && frame.includes("Workspace:")
      && !frame.includes("Label:") && !frame.includes("Profile:"));
    this.focus = "form";
    if (!workspaceFieldEmpty(this.currentText())) {
      const before = this.frameRevision;
      this.pty.write(WINDOWS_KEYS.ctrlC);
      await this.waitFrame(workspaceFieldEmpty, "public Workspace clear binding empties the bordered New Editor content row", before);
    }
    assertNativeEditorFieldEmpty(this.currentText(), "> Workspace:");
    await this.send(canonicalWorkspace, "the selected absolute workspace is visible in the public New form",
      (frame) => {
        try {
          return borderedEditorContentMatches(frame, "> Workspace:", canonicalWorkspace);
        } catch {
          return false;
        }
      });
    const expectedCompletions = windowsDirectoryCompletionCandidates(canonicalWorkspace);
    const beforeFirstEnter = this.frameRevision;
    // Explicitly force completion with Tab so the asynchronous provider is
    // triggered and awaited before submission. For the uniquely matching owned
    // directory, forced Tab accepts the single native result without risking
    // premature submission.
    this.pty.write("\t");
    await this.waitFrame((frame) => {
      try {
        requireFolderCompletedObservation(classifyFirstWorkspaceEnter(frame, expectedCompletions));
        return true;
      } catch {
        return false;
      }
    }, `${label} forced Tab accepts the exact owned native directory completion before submission`, beforeFirstEnter);
    let afterFirstEnter = this.currentText();
    const firstEnterObservation = classifyFirstWorkspaceEnter(afterFirstEnter, expectedCompletions);
    // Completion evidence is required before submission: a direct submission
    // (form closed without a verified folder completion) is not accepted as
    // proof that the workspace was completed through the native provider.
    const { acceptedPath } = requireFolderCompletedObservation(firstEnterObservation);
    assert.ok(expectedCompletions.includes(acceptedPath),
      `${label} first Enter accepted exactly its owned forward-slash directory completion`);
    assert.equal(this.records().some((record) => record.type === "session_start"
      && samePath(record.cwd ?? "", canonicalWorkspace)), false,
    `${label} completion acceptance is not mistaken for a New submission`);
    const beforeSubmit = this.frameRevision;
    assert.ok(this.currentText().includes("Workspace:"), `${label} form remains open after folder completion`);
    assert.ok(borderedEditorContentMatches(this.currentText(), "> Workspace:", acceptedPath),
      `${label} second Enter is authorized only while the accepted exact path remains in the visible Editor body`);
    this.pty.write(WINDOWS_KEYS.enter);
    await this.waitFrame((frame) => frame.includes("Starting (request ") || !frame.includes("Workspace:"),
      `${label} distinct second Enter submits the accepted directory`, beforeSubmit);
    afterFirstEnter = this.currentText();
    assert.ok(afterFirstEnter.includes("Starting (request ") || !afterFirstEnter.includes("Workspace:"),
      `${label} New request reached its submitted/closed state before lifecycle ownership is claimed`);
    const matchingRecords = await this.waitForNative((records) => records.some((record) => record.type === "session_start"
      && samePath(record.cwd ?? "", canonicalWorkspace)
      && typeof record.sessionId === "string" && record.sessionId.length > 0),
    `real public session_start for ${label}`);
    let record = matchingRecords.filter((candidate) => candidate.type === "session_start"
      && samePath(candidate.cwd ?? "", canonicalWorkspace)
      && typeof candidate.sessionId === "string").at(-1);
    assert.ok(record, `${label} has a native public session_start record`);
    assert.ok(Number.isSafeInteger(record.pid) && record.pid! > 1, `${label} has its exact native process PID`);
    assert.equal(record.tty, true, `${label} public session_start confirms native Pi TTY mode`);
    assert.equal(record.agentDir, this.records().find((entry) => entry.type === "session_start" && entry.pid === record!.pid)?.agentDir,
      `${label} retains its public native root identity in the lifecycle journal`);
    assert.ok(record.sessionFile && isAbsolute(record.sessionFile), `${label} has a public absolute planned session path; no disk file is required before a message`);
    const spawnRecords = await this.waitForPty((entries) => entries.some((entry) => entry.type === "pty_spawn"
      && entry.pid === record!.pid && samePath(entry.cwd ?? "", canonicalWorkspace)),
    `actual public node-pty spawn ownership for ${label}`);
    const matchingSpawns = spawnRecords.filter((entry) => entry.type === "pty_spawn"
      && entry.pid === record!.pid && samePath(entry.cwd ?? "", canonicalWorkspace));
    assert.equal(matchingSpawns.length, 1, `${label} journal PID/cwd cross-binds to exactly one actual PTY spawn`);
    assert.ok(this.ptyRecords().every((entry) => !(entry.type === "pty_exit" && entry.pid === record!.pid)),
      `${label} remains a live Main-owned PTY after session_start`);
    await this.waitFrame((frame) => selectedRosterLabel(frame) === "(no messages)" || frame.includes(label),
      `${label} New completion selects its row without activation`);
    this.focus = "sidebar";
    if (priorActiveHeader !== undefined) {
      assert.equal(this.currentText().split("\n")[0], priorActiveHeader,
        `${label} New completion does not auto-activate or replace the already active native session`);
    } else {
      assert.ok(this.currentText().includes("Welcome"), `${label} New completion leaves the empty Main surface active`);
    }
    await this.renameSelectedNativeSession(record, label);
    return { label, workspace: canonicalWorkspace, record };
  }

  private async renameSelectedNativeSession(record: NativeJournalRecord, label: string): Promise<void> {
    assert.equal(this.selectedLabel(), "(no messages)", "the freshly created native row is highlighted for public Edit");
    const beforeEdit = this.frameRevision;
    this.pty.write("e");
    this.focus = "form";
    await this.waitFrame((frame) => {
      if (!frame.includes("Edit native session name")
        || !frame.includes("Current name (display only; type a complete replacement):")
        || !frame.includes("> New name:")) return false;
      try {
        assertNativeEditorFieldEmpty(frame, "> New name:");
        return true;
      } catch {
        return false;
      }
    }, "public Edit form paints a complete, empty replacement body before input", beforeEdit);
    assertNativeEditorFieldEmpty(this.currentText(), "> New name:");
    await this.send(label, "public Edit replacement is entered", (frame) => frame.includes(label));
    this.pty.write(WINDOWS_KEYS.enter);
    await this.waitForNative((records) => records.some((entry) => entry.type === "native_session_name"
      && entry.pid === record.pid && entry.sessionId === record.sessionId && entry.storedName === label),
    `public native observer sees the live SessionManager display-name value ${label}`);
    await this.waitFrame((frame) => selectedRosterLabel(frame)?.includes(label) === true,
      `public Edit updates the selected sidebar row to ${label}`);
    this.focus = "sidebar";
  }

  async activate(label: string): Promise<void> {
    await this.ensureSidebarFocus();
    await this.moveRosterTo(label);
    const before = this.frameRevision;
    this.pty.write(WINDOWS_KEYS.enter);
    this.focus = "main";
    await this.waitFrame((frame) => frame.split("\n")[0]?.includes(`Session host · ${label} ·`) === true,
      `public Enter explicitly activates native row ${label}`, before);
  }

  async writeDraft(value: string): Promise<void> {
    const before = this.frameRevision;
    this.pty.write(value);
    await this.waitFrame((frame) => frame.includes(value), `native session displays its own draft ${value}`, before);
  }

  async assertBeforeQuitModes(): Promise<void> {
    await this.surface.flush();
    const modes = this.modeSnapshots;
    assert.ok(this.sawAlternateEnter, "actual Main output entered the outer VT alternate buffer");
    assert.ok(modes.some((mode) => mode.bracketedPaste), "actual outer VT observed Main bracketed-paste negotiation");
    assert.ok(modes.some((mode) => mode.mouseTracking !== "none" && mode.mouseEncoding === "sgr"),
      "actual outer VT observed Main mouse tracking and SGR encoding");
    assert.ok(modes.some((mode) => mode.kittyFlags > 0 || mode.applicationCursorKeys || mode.applicationKeypad || mode.modifyOtherKeys > 0),
      "actual outer VT observed a non-baseline keyboard mode during Main ownership");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?[\d;]*c$/.test(reply)),
      "actual outer ConPTY answered the real public device-attributes query");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?\d+u$/.test(reply)),
      "actual outer ConPTY answered the real public Kitty keyboard-state query");
  }

  async waitForNormalExit(): Promise<NativePtyExit> {
    const exit = await this.waitForExit();
    await this.surface.flush();
    assert.equal(exit.exitCode, 0, "public runSessionHost runner exited zero through its outer PTY");
    assert.ok(!exit.signal, "outer Main exited normally without signal termination");
    assert.ok(existsSync(this.resultFile), "public Main runner recorded its return/TTY restoration state");
    const resultIdentity = lstatSync(this.resultFile, { bigint: true });
    assert.ok(resultIdentity.isFile() && !resultIdentity.isSymbolicLink() && resultIdentity.dev > 0n && resultIdentity.ino > 0n
      && resultIdentity.size <= 16n * 1024n,
    "public Main result is the exact bounded task-created regular file with a BigInt identity");
    const result = JSON.parse(readFileSync(this.resultFile, "utf8")) as MainResult;
    assert.equal(result.threw, false, "public runSessionHost resolved instead of throwing");
    assert.equal(result.status, 0, "public runSessionHost returned zero");
    assert.equal(result.stdinIsTTY, true, "actual Main stdin was a TTY");
    assert.equal(result.stdoutIsTTY, true, "actual Main stdout was a TTY");
    assert.equal(result.sameInputStream, true, "Main restored raw mode on the same public stdin stream");
    assert.equal(result.sameOutputStream, true, "Main retained the same public stdout stream");
    assert.equal(typeof result.rawBefore, "boolean", "original public stdin raw-mode state was observable");
    assert.equal(result.rawAfter, result.rawBefore, "public stdin raw-mode state was restored on the same stream");
    assert.ok(this.sawAlternateLeave, "actual Main output left the outer VT alternate buffer");
    assert.ok(this.outputTail.lastIndexOf("\x1b[?1049l") > this.outputTail.lastIndexOf("\x1b[?1049h"),
      "last observed outer VT alternate-buffer transition restored the normal buffer");
    assert.ok(frameText(this.surface).includes(WINDOWS_BASELINE),
      "actual outer VT normal buffer contains its pre-Main restoration baseline");
    assert.deepEqual(this.surface.inputModes(), this.initialModes,
      "actual outer VT mouse, bracketed-paste, and keyboard negotiation returned to its exact baseline");
    return exit;
  }

  async confirmQuit(): Promise<void> {
    await this.ensureSidebarFocus();
    await this.moveRosterTo("Quit host");
    const before = this.frameRevision;
    this.pty.write(WINDOWS_KEYS.enter);
    await this.waitFrame((frame) => frame.includes("Quit host?")
      && frame.includes("2 session(s) starting, alive, or host-owned")
      && frame.includes("enter/y = quit host"),
    "Quit with both live native children requires the real public confirmation pane", before);
    assert.equal(this.ptyRecords().filter((entry) => entry.type === "pty_exit").length, 0,
      "confirmed Quit is requested while both actual native PTY handles are still live");
    this.pty.write(WINDOWS_KEYS.enter);
    this.focus = "main";
    // Input submission is not exit evidence; the caller must independently
    // await all native, retained-handle, Main, and outer-PTY witnesses.
  }

  async tryGracefulQuitAfterFailure(): Promise<void> {
    if (this.exitEvent) return;
    try {
      await this.ensureSidebarFocus();
      await this.moveRosterTo("Quit host");
      const before = this.frameRevision;
      this.pty.write(WINDOWS_KEYS.enter);
      await this.waitFrame((frame) => frame.includes("Quit host?") || this.exitEvent !== undefined,
        "failed-test cleanup reaches the public quit confirmation", before, 5_000);
      if (!this.exitEvent && this.currentText().includes("Quit host?")) this.pty.write(WINDOWS_KEYS.enter);
      await this.waitForExit(15_000);
    } catch {
      // A failed case remains failed; caller may use exact-handle cleanup below.
    }
  }

  forceKillOuterAfterFailure(): void {
    if (this.exitEvent || this.forced) return;
    this.forced = true;
    writeMetadata(this.forceJournal, { type: "outer_pty_force_attempt", pid: Number(this.pty.pid) });
    this.pty.kill(); // Exact public outer PTY handle, no signal argument.
  }

  async settleSubscriptions(): Promise<void> {
    try { this.dataSubscription.dispose(); } catch { /* exact outer PTY data subscription */ }
    try { this.exitSubscription.dispose(); } catch { /* exact outer PTY exit subscription */ }
    try { this.surface.dispose(); } catch { /* owned terminal model */ }
    try { this.logWatcher.close(); } catch { /* task-owned root watch */ }
    try { this.nativeWatcher.close(); } catch { /* task-owned journal watch */ }
    try { this.providerWatcher.close(); } catch { /* task-owned provider fixture watch */ }
  }

  get forcedCleanup(): boolean {
    return this.forced;
  }

  get terminalOutputTail(): string {
    return this.outputTail;
  }
}

export interface ObserverStartOptions {
  readonly runtime: WindowsRuntimePin;
  readonly root: string;
  readonly rootIdentity: FileIdentity;
  readonly home: string;
  readonly temporary: string;
  readonly nativePid: number;
}

export class WindowsOwnedExitObserver {
  readonly root: string;
  readonly rootIdentity: FileIdentity;
  readonly nativePid: number;
  readonly nonce: string;
  readonly child: ChildProcess;
  readonly readyPath: string;
  readonly resultPath: string;
  readonly watcher: FSWatcher;
  private readonly signal = new ChangeSignal();
  private closeEvent?: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  private spawnError?: Error;
  private stdoutTail = "";
  private stderrTail = "";
  private readyWitness?: WindowsExitWitness;
  private resultWitness?: WindowsExitWitness;
  private readonly witnessFileIdentities = new Map<string, FileIdentity>();

  constructor(options: ObserverStartOptions) {
    this.root = options.root;
    this.rootIdentity = options.rootIdentity;
    this.nativePid = options.nativePid;
    this.nonce = randomBytes(24).toString("hex");
    if (this.nonce.length < 16 || this.nonce.length > 128 || !/^[A-Za-z0-9_-]+$/.test(this.nonce)) {
      throw new Error("generated PowerShell observer nonce is outside its bounded ASCII contract");
    }
    assertCurrentDirectoryIdentity(this.root, this.rootIdentity);
    const script = realpathSync(WINDOWS_OBSERVER_FIXTURE);
    const env: NodeJS.ProcessEnv = {
      PATH: safeWindowsPath(process.env.SystemRoot ?? process.env.WINDIR!),
      SystemRoot: process.env.SystemRoot ?? process.env.WINDIR,
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
      HOME: options.home,
      USERPROFILE: options.home,
      TEMP: options.temporary,
      TMP: options.temporary,
    };
    this.watcher = watch(this.root);
    try {
      this.child = spawn(options.runtime.powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", script,
        "-Root", this.root,
        "-NativePid", String(options.nativePid),
        "-RequestNonce", this.nonce,
        "-TimeoutSeconds", String(WINDOWS_OBSERVER_TIMEOUT_SECONDS),
      ], {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      this.watcher.close();
      throw new Error(`public powershell.exe could not start exact-PID exit observation: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    this.child.on("error", (error) => {
      this.spawnError = error;
      this.signal.notify();
    });
    this.child.on("close", (code, signal) => {
      this.closeEvent = { code, signal };
      this.signal.notify();
    });
    this.watcher.on("change", () => this.signal.notify());
    this.watcher.on("error", (error) => {
      this.spawnError = error;
      this.signal.notify();
    });
    this.readyPath = join(this.root, `${this.nonce}.ready.json`);
    this.resultPath = join(this.root, `${this.nonce}.result.json`);
    this.child.stdout?.on("data", (chunk: Buffer | string) => { this.stdoutTail = (this.stdoutTail + chunk.toString()).slice(-512); });
    this.child.stderr?.on("data", (chunk: Buffer | string) => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-512); });
  }

  private readWitness(path: string, expectedState: "READY" | "exited"): WindowsExitWitness | undefined {
    assertCurrentDirectoryIdentity(this.root, this.rootIdentity);
    try {
      const stats = lstatSync(path, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > BigInt(MAX_WITNESS_BYTES)
        || stats.dev <= 0n || stats.ino <= 0n) {
        throw new Error("PowerShell witness is not a bounded regular file with a positive BigInt identity");
      }
      const observedIdentity = { dev: stats.dev, ino: stats.ino };
      const previousIdentity = this.witnessFileIdentities.get(path);
      if (previousIdentity && !sameFileIdentity(previousIdentity, observedIdentity)) {
        throw new Error("PowerShell CreateNew witness identity changed during retained observation");
      }
      this.witnessFileIdentities.set(path, observedIdentity);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return undefined; // one atomic-ish write may be observed before its final bytes
      }
      const witness = validateWindowsExitWitness(parsed, {
        requestNonce: this.nonce,
        observerPid: this.child.pid ?? -1,
        nativePid: this.nativePid,
        state: expectedState,
      });
      assertCurrentDirectoryIdentity(this.root, this.rootIdentity);
      return witness;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async waitUntilReady(timeoutMs = WINDOWS_EVENT_TIMEOUT_MS): Promise<WindowsExitWitness> {
    await this.signal.waitFor(() => {
      if (this.spawnError) throw this.spawnError;
      if (this.closeEvent) throw new Error(`PowerShell observer exited before READY (${this.closeEvent.code}/${this.closeEvent.signal ?? "none"})`);
      this.readyWitness = this.readWitness(this.readyPath, "READY");
      return this.readyWitness !== undefined;
    }, timeoutMs, `PowerShell exact-process READY for native PID ${this.nativePid}`);
    assert.ok(this.child.pid && this.child.pid > 1, "public powershell.exe spawn returned an observer PID");
    return this.readyWitness!;
  }

  async waitForExitedResult(timeoutMs = (WINDOWS_OBSERVER_TIMEOUT_SECONDS + 10) * 1000): Promise<WindowsExitWitness> {
    await this.signal.waitFor(() => {
      if (this.spawnError) throw this.spawnError;
      this.resultWitness = this.readWitness(this.resultPath, "exited");
      if (this.resultWitness) return true;
      if (this.closeEvent) {
        throw new Error(`retained PowerShell observer exited without an exited result (${this.closeEvent.code}/${this.closeEvent.signal ?? "none"})`);
      }
      return false;
    }, timeoutMs, `retained PowerShell Process handle exit result for native PID ${this.nativePid}`);
    const witness = this.resultWitness!;
    assertCurrentDirectoryIdentity(this.root, this.rootIdentity);
    return witness;
  }

  assertExitedSuccessfully(): void {
    assert.ok(this.closeEvent, "the same public PowerShell child handle reached process close");
    assert.equal(this.closeEvent!.code, 0, "PowerShell watcher exited successfully after publishing its retained-handle result");
    assert.equal(this.closeEvent!.signal, null, "PowerShell watcher was not externally signaled");
    assert.ok(this.readyWitness, "the retained observer had a validated READY witness before shutdown");
    assert.ok(this.resultWitness, "the retained observer published its result from the same prebound process handle");
    assertCurrentDirectoryIdentity(this.root, this.rootIdentity);
  }

  async waitForObserverProcessClose(timeoutMs = WINDOWS_EVENT_TIMEOUT_MS): Promise<void> {
    if (!this.closeEvent) {
      await this.signal.waitFor(() => this.closeEvent !== undefined || this.spawnError !== undefined,
        timeoutMs, "retained PowerShell process handle close");
    }
    if (this.spawnError) throw this.spawnError;
  }

  async retainUntilFailureTimeout(): Promise<void> {
    // Failure-only wait: the script's bounded timeout publishes a failed
    // result and exits without reacquiring or controlling the native PID.
    await this.waitForObserverProcessClose((WINDOWS_OBSERVER_TIMEOUT_SECONDS + 10) * 1000).catch(() => undefined);
    try { this.watcher.close(); } catch { /* retained witness files remain */ }
  }

  dispose(): void {
    try { this.watcher.close(); } catch { /* retained witness files remain */ }
  }

  get closeStatus(): { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined {
    return this.closeEvent;
  }

  get diagnosticTail(): string {
    return `${this.stdoutTail}${this.stderrTail}`.slice(-512);
  }
}

export function randomNonce(): string {
  return randomBytes(12).toString("hex");
}

export function randomDigits(length = 8): string {
  if (!Number.isSafeInteger(length) || length < 1 || length > 64) {
    throw new Error("test-only numeric guard length is outside its bounded contract");
  }
  return [...randomBytes(length)].map((value) => String(value % 10)).join("");
}

export function assertCredentialFreeNativeRecords(records: readonly NativeJournalRecord[]): void {
  for (const record of records) {
    if (Array.isArray(record.credentialLikeEnvironmentNames)) {
      assert.deepEqual(record.credentialLikeEnvironmentNames, [], "native session inherited no credential-like environment names");
    }
  }
}

export function assertNoUnownedNativeSessions(records: readonly NativeJournalRecord[], expected: readonly WindowsOwnedSession[]): void {
  const started = records.filter((record) => record.type === "session_start");
  assert.equal(started.length, expected.length, "only the two submitted Workspace-only New requests started native children");
  for (const session of expected) {
    assert.equal(started.filter((record) => record.pid === session.record.pid && record.sessionId === session.record.sessionId).length, 1,
      `${session.label} identifies exactly one native session_start identity`);
  }
}

export function isSessionShutdownFor(record: NativeJournalRecord, session: WindowsOwnedSession): boolean {
  return record.type === "session_shutdown" && record.pid === session.record.pid
    && record.contextSessionId === session.record.sessionId && record.reason === "quit";
}

export function assertNoSavedSessionOverrides(args: readonly string[]): void {
  const forbidden = new Set(["--session", "--session-id", "--sessionID", "--session-dir", "--no-session", "--continue", "--resume", "--fork"]);
  assert.equal(args.some((arg) => forbidden.has(arg)), false, "native children receive no forced, resumed, or saved-session override");
}

export function assertWindowsRuntimeFiles(runtime: WindowsRuntimePin): void {
  for (const path of [runtime.candidateEntry, runtime.mainEntry, runtime.piExecutable, runtime.powershell]) {
    assert.ok(existsSync(path), `required pinned Windows runtime path exists: ${path}`);
    const stats = lstatSync(path);
    assert.ok(stats.isFile() && !stats.isSymbolicLink(), `required runtime path is a regular file: ${path}`);
  }
}
