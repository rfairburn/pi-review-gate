/**
 * Test-only POSIX (macOS/Linux) source-launcher acceptance harness.
 *
 * Unlike the direct compiled-Main harness (which hosts a runner fixture in the
 * outer PTY and loads the staged candidate Main directly), this lane exercises
 * the REAL shipped POSIX source wrapper:
 *
 *   /bin/bash <fixture>/scripts/pi-review-sessions.sh --pi-executable <cli> ...
 *
 * The wrapper selects the supported Node already on the confined PATH and
 * execs the real shared CJS launcher, which performs its own bounded,
 * lockfile-exact, script-free source-stage install and build before loading the
 * compiled session host and spawning real native Pi children.
 *
 * Native PTY evidence comes from the shared exact observer fixture, loaded as a
 * NODE_OPTIONS preload into the actual launcher process and wrapped at the
 * production lazy-load anchor only. The native lifecycle witness remains the
 * public session_start extension; exact-process exit evidence comes from the
 * original public EVFILT_PROC/NOTE_EXIT (macOS) or pidfd/poll (Linux) kernel
 * watcher, reused through the shared native-Main harness.
 *
 * This module is test infrastructure only. It adds no production source, CI,
 * package, docs, or SDK surface, and it never uses a production
 * dependency-injection seam, a substitute PTY handle, or a guessed PID.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { TerminalSurface, stripGeneratedSgr } from "../../src/session-host/terminal-surface";
import {
  EVENT_TIMEOUT_MS,
  KEYS,
  OUTER_COLS,
  OUTER_ROWS,
  type NativePtyHandle,
  type NativePtyModule,
  type PtyExit,
} from "./session-host-native-main-harness";
import {
  frameHeader,
  frameHeaderMatches,
  isSidebarFocusedFrame,
  parseRosterFrame,
  selectedRosterEntry,
  sidebarPaneLines,
  sidebarRosterHidden,
} from "./session-host-native-roster-witness";
import { isCompleteMainFocusedRoster } from "./session-host-native-row-lifecycle";
import {
  assertNativeEditorFieldEmpty,
  borderedEditorContentMatches,
  sameFileIdentity,
  type FileIdentity,
} from "./session-host-native-windows-contracts";
import {
  ChangeSignal,
  NATIVE_OBSERVER_FIXTURE,
  NATIVE_PROVIDER_FIXTURE,
  assertCreatedDirectoryIdentity,
  assertCredentialFreeNativeRecords,
  assertNoRoleOrCatalogMarkers,
  assertNoSavedSessionOverrides,
  boundedJsonl,
  createNativeAgentRoot,
  createOwnedDirectory,
  identityOfRealDirectory,
  isSessionShutdownFor,
  randomDigits,
  resolveInstalledPiRuntime,
  writeOwnedFile,
  type NativeJournalRecord,
  type PtyJournalRecord,
} from "./session-host-native-windows-harness";
import { LegDeadline, frameWaitFailure } from "./session-host-native-windows-launcher";

export { LegDeadline, frameWaitFailure };
export {
  assertCreatedDirectoryIdentity,
  assertCredentialFreeNativeRecords,
  assertNoRoleOrCatalogMarkers,
  assertNoSavedSessionOverrides,
  createOwnedDirectory,
  identityOfRealDirectory,
  isSessionShutdownFor,
  randomDigits,
  sameFileIdentity,
  createNativeAgentRoot,
};
export type { FileIdentity, NativeJournalRecord, PtyJournalRecord, NativePtyHandle, NativePtyModule, PtyExit };

/** Same required-native flag as the shared `resolveRuntimePin`; opt-in is the proof gate. */
export const POSIX_LAUNCHER_REQUIRE_ENV = "PI_REVIEW_GATE_REQUIRE_PI_HOST";
export const POSIX_LAUNCHER_SOURCE_ROOT_ENV = "PI_REVIEW_GATE_LAUNCHER_SOURCE_ROOT";
export const POSIX_LAUNCHER_PYTHON_ENV = "PI_REVIEW_GATE_LAUNCHER_PYTHON";
export const POSIX_LAUNCHER_EXPECT_PI_VERSION = "1.1.0";
export const POSIX_LAUNCHER_PTY_VERSION = "1.2.0-beta.15";
export const POSIX_LAUNCHER_LEG_DEADLINE_MS = 9 * 60_000;
export const POSIX_LAUNCHER_TEST_TIMEOUT_MS = 20 * 60_000;
export const POSIX_LAUNCHER_STARTUP_TIMEOUT_MS = 7 * 60_000;
export const POSIX_LAUNCHER_EVENT_TIMEOUT_MS = EVENT_TIMEOUT_MS;
export const POSIX_LAUNCHER_OBSERVER_TIMEOUT_SECONDS = 180;
export const POSIX_LAUNCHER_OUTER_COLS = OUTER_COLS;
export const POSIX_LAUNCHER_OUTER_ROWS = OUTER_ROWS;
export const POSIX_LAUNCHER_CLEANUP_BUDGET_MS = 20_000;
// The cancelled body aborts this far before the node:test timeout so the bounded
// failure cleanup still completes inside the enforced per-leg deadline.
export const POSIX_LAUNCHER_BODY_DEADLINE_MS = POSIX_LAUNCHER_LEG_DEADLINE_MS - POSIX_LAUNCHER_CLEANUP_BUDGET_MS;
export const POSIX_LAUNCHER_PROVIDER_VALUE = "synthetic-provider-value";
export const POSIX_LAUNCHER_BASELINE = "SESSION_HOST_LAUNCHER_POSIX_OUTER_RESTORATION_BASELINE";

const EXPECT_NODE_OPTIONS_ENV = "PRG_SESSION_HOST_LAUNCHER_EXPECT_NODE_OPTIONS";
const EXPECT_PROVIDER_ENV = "PRG_SESSION_HOST_LAUNCHER_EXPECT_PROVIDER_VALUE";
const SOURCE_FIXTURE_FILES = ["package.json", "package-lock.json", "tsconfig.json"] as const;
const SOURCE_FIXTURE_TREES = ["src", "scripts", "skills"] as const;
const SOURCE_FIXTURE_REQUIRED = [
  join("src", "session-host", "main.ts"),
  join("scripts", "pi-review-sessions.cjs"),
  join("scripts", "pi-review-sessions.sh"),
] as const;
const SOURCE_FIXTURE_FORBIDDEN = ["dist", "node_modules", ".git", "tests"] as const;
const STAGE_REQUIRED = [
  join("dist", "src", "session-host", "main.js"),
  join("dist", "src", "index.js"),
  join("dist", "src", "session-host", "reporter.js"),
  join("dist", "src", "session-host", "bootstrap-preload.js"),
  join("scripts", "pi-review-sessions.cjs"),
] as const;
const BUILT_STAGE_DIRNAME = "pi-review-sessions-";
// The shared public kernel exit-watcher fixture (EVFILT_PROC/NOTE_EXIT on
// macOS, pidfd/poll on Linux). It is referenced here by path so the canonical
// pinned interpreter can run it under the confined environment; the fixture
// itself is never modified or copied.
const KERNEL_EXIT_WATCHER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-exit-watcher.py");
const PROVIDER_ENV_PATTERN = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PROVIDER)/i;
const PROVIDER_DIGEST_ENV = "PRG_SESSION_HOST_LAUNCHER_EXPECT_PROVIDER_DIGEST";

export interface PosixLauncherRuntimePin {
  readonly sourceRoot: string;
  readonly agentDir: string;
  readonly piExecutable: string;
  readonly version: "1.1.0";
  readonly python: string;
  readonly bash: string;
  readonly nodeBinDir: string;
  readonly pty: NativePtyModule;
  readonly ptyModulePath: string;
  readonly preloadFixture: string;
}

export interface PosixLauncherLegLayout {
  readonly root: string;
  readonly home: string;
  readonly temporary: string;
  readonly cache: string;
  readonly stateRoot: string;
  readonly fixtureState: string;
  readonly observerDirectory: string;
  readonly nativeAgentDir: string;
  readonly workspace: string;
}

export interface PosixOwnedSession {
  readonly displayName: string;
  readonly workspace: string;
  readonly record: NativeJournalRecord;
  readonly exitWatcher: PosixKernelExitWatcher;
}

function assertAbsoluteRealFile(value: string, label: string): string {
  const canonical = realpathSync(value);
  const stats = lstatSync(canonical);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`required POSIX launcher input is not a regular file: ${label}`);
  return canonical;
}

/**
 * Refuse exact or case-variant role/catalog markers before any fixture
 * mutation or child spawn. The environment is only inspected, never rewritten.
 */
export function assertAdmissibleOriginalEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper === "PI_REVIEW_GATE_RUNTIME_ROLE" || upper === "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG") {
      throw new Error(`POSIX source-launcher acceptance refuses a role/catalog marker (including case aliases): ${name}`);
    }
  }
}

/**
 * Bounded, value-free digest of the provider-relevant environment. Only the
 * hash crosses a comparison boundary; no value is ever copied or logged. The
 * test and the POSIX preload compute the same digest independently.
 */
export function providerEnvironmentDigest(env: NodeJS.ProcessEnv): string {
  const pairs = Object.keys(env)
    .filter((name) => PROVIDER_ENV_PATTERN.test(name) && !name.startsWith("PRG_"))
    .sort()
    .map((name) => `${name}=${env[name] === undefined ? "" : String(env[name])}`);
  return createHash("sha256").update(pairs.join("\u0000")).digest("hex");
}

/**
 * Original public kernel incarnation watcher for one exact owned PID, reusing
 * the shared POSIX exit-watcher fixture but executed through the canonical
 * pinned interpreter under a confined environment (never the caller's HOME,
 * cache, or state). The process handle is retained from registration to the
 * exact observed exit; a bounded stop is only ever a failure-release action.
 */
export class PosixKernelExitWatcher {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  private readonly signal = new ChangeSignal();
  private stdoutBuffer = "";
  private stderrTail = "";
  private registered = false;
  private watcherClosed = false;
  private failure?: Error;
  observedExit = false;

  constructor(pid: number, options: { readonly python: string; readonly env: NodeJS.ProcessEnv; readonly cwd: string }) {
    this.pid = pid;
    this.child = spawn(options.python, [KERNEL_EXIT_WATCHER_FIXTURE, String(pid)], {
      cwd: options.cwd,
      env: options.env,
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
      await this.signal.waitFor(() => this.watcherClosed, 3_000,
        `owned-PID exit observer ${this.pid} termination`);
    } catch {
      try { this.child.kill("SIGKILL"); } catch { /* bounded escalation to the same observer handle */ }
      await this.signal.waitFor(() => this.watcherClosed, 3_000,
        `owned-PID exit observer ${this.pid} forced termination`).catch(() => undefined);
    }
  }
}

/** Require the fresh complete production source fixture and its absences. */
export function assertCompleteSourceFixture(sourceRoot: string): void {
  for (const name of SOURCE_FIXTURE_FILES) {
    const stats = lstatSync(join(sourceRoot, name));
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`source fixture input missing: ${name}`);
  }
  for (const name of SOURCE_FIXTURE_TREES) {
    const stats = lstatSync(join(sourceRoot, name));
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`source fixture tree missing: ${name}`);
  }
  for (const name of SOURCE_FIXTURE_REQUIRED) {
    const stats = lstatSync(join(sourceRoot, name));
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`source fixture file missing: ${name}`);
  }
  for (const name of SOURCE_FIXTURE_FORBIDDEN) {
    assert.equal(existsSync(join(sourceRoot, name)), false,
      `fresh complete source fixture must never contain ${name}`);
  }
}

function assertPythonPrerequisite(python: string, confinedRoot: string): void {
  const probe = spawnSync(python, ["-I", "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"], {
    shell: false,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    // The probe runs directly under a confined env that never inherits the
    // caller's HOME/cache/state locations.
    env: { PATH: `${dirname(python)}${delimiter}/usr/bin${delimiter}/bin`, HOME: confinedRoot, TMPDIR: confinedRoot },
  });
  if (probe.error || probe.status !== 0) {
    throw new Error("the POSIX alpha launcher acceptance requires Python 3.9 or newer at the pinned interpreter");
  }
}

/**
 * Bounded read-only discovery of a public Python 3 interpreter on PATH (the
 * same discovery the real launcher performs): no directory scans, no unbounded
 * walks. `python3` is preferred, matching the launcher's own order.
 */
function discoverPython(): string {
  for (const command of ["python3", "python"]) {
    for (const rawEntry of `${process.env.PATH ?? ""}`.split(delimiter)) {
      if (!rawEntry) continue;
      const candidate = join(rawEntry, command);
      try {
        const canonical = realpathSync(candidate);
        const stats = lstatSync(canonical);
        if (stats.isFile() && !stats.isSymbolicLink()) return canonical;
      } catch {
        // Absent PATH candidate; continue to the next bounded entry.
      }
    }
  }
  throw new Error("the POSIX alpha launcher acceptance requires Python 3.9 or newer discoverable on PATH");
}

/**
 * Fresh, positive-owned source fixture built by the existing hardened
 * `copy-source` copier (exact six production build inputs; `.terraform` pruned
 * before descent; symlinks refused; no dist/node_modules/.git/tests). Retained
 * on success and failure alike: no recursive cleanup is attempted.
 */
function createFreshSourceFixture(root: string, layout: PosixLauncherLegLayout): string {
  const destination = createOwnedDirectory(root, "source-fixture");
  const copier = join(process.cwd(), "scripts", "ci", "session-host-windows-acceptance.cjs");
  // Confine the copier's filesystem destinations (HOME/TMP/cache) while
  // preserving the caller's authorized NODE_OPTIONS and provider configuration.
  const copyEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: layout.home,
    USERPROFILE: layout.home,
    TMPDIR: layout.temporary,
    TMP: layout.temporary,
    TEMP: layout.temporary,
    XDG_CACHE_HOME: layout.cache,
    XDG_CONFIG_HOME: join(layout.home, ".config"),
    XDG_DATA_HOME: layout.home,
    XDG_STATE_HOME: layout.stateRoot,
    XDG_RUNTIME_DIR: layout.temporary,
    npm_config_cache: join(layout.cache, "npm"),
  };
  const result = spawnSync(process.execPath, [copier, "copy-source", process.cwd(), destination], {
    cwd: process.cwd(),
    env: copyEnv,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("the fresh POSIX source fixture could not be copied by the hardened source copier");
  }
  assertCompleteSourceFixture(destination);
  return destination;
}

/**
 * Fails closed after opt-in; no ambient source/runtime fallback is allowed.
 * Role/catalog markers are refused (case-insensitively) BEFORE any fixture
 * mutation or child spawn.
 */
export function resolveLauncherRuntime(layout: PosixLauncherLegLayout): PosixLauncherRuntimePin {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("required real POSIX source-launcher acceptance was requested on an unsupported platform");
  }
  const nodeVersion = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
  if (!nodeVersion) throw new Error("stable Node version could not be established for the POSIX launcher host");
  const major = Number(nodeVersion[1]);
  const minor = Number(nodeVersion[2]);
  if (!(major > 22 || (major === 22 && minor >= 19))) throw new Error("POSIX source-launcher acceptance requires stable Node >=22.19.0");

  assertAdmissibleOriginalEnvironment(process.env);
  const agentPin = process.env.PI_REVIEW_GATE_INSTALLED_AGENT?.trim();
  const binPin = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN?.trim();
  const versionPin = process.env.PI_REVIEW_GATE_EXPECT_PI_VERSION?.trim();
  const pythonPin = process.env[POSIX_LAUNCHER_PYTHON_ENV]?.trim();
  if (!agentPin || !binPin || !versionPin) {
    throw new Error("POSIX source-launcher acceptance requires the pinned public Pi runtime env");
  }
  if (versionPin !== POSIX_LAUNCHER_EXPECT_PI_VERSION) {
    throw new Error(`POSIX source-launcher acceptance requires exact public Pi ${POSIX_LAUNCHER_EXPECT_PI_VERSION}`);
  }

  const { agentDir, piExecutable } = resolveInstalledPiRuntime(agentPin, binPin, versionPin);

  const sourcePin = process.env[POSIX_LAUNCHER_SOURCE_ROOT_ENV]?.trim();
  const sourceRoot = sourcePin && sourcePin.length > 0 ? realpathSync(sourcePin) : createFreshSourceFixture(layout.root, layout);
  if (!isAbsolute(sourceRoot)) throw new Error("the launcher source fixture root must be absolute");
  assertCompleteSourceFixture(sourceRoot);

  const python = assertAbsoluteRealFile(pythonPin && pythonPin.length > 0 ? pythonPin : discoverPython(), "pinned Python interpreter");
  assertPythonPrerequisite(python, layout.temporary);

  const bash = assertAbsoluteRealFile("/bin/bash", "trusted POSIX bash");

  const projectRequire = createRequire(join(process.cwd(), "package.json"));
  const ptyModulePath = projectRequire.resolve("@lydell/node-pty");
  const pty = projectRequire("@lydell/node-pty") as NativePtyModule;
  if (!pty || typeof pty.spawn !== "function") throw new Error("public @lydell/node-pty spawn API is unavailable");

  const preloadFixture = assertAbsoluteRealFile(
    join(process.cwd(), "tests", "fixtures", "session-host-posix-launcher-preload.cjs"),
    "POSIX launcher preload fixture",
  );
  for (const fixture of [NATIVE_OBSERVER_FIXTURE, NATIVE_PROVIDER_FIXTURE]) assertAbsoluteRealFile(fixture, "native observer/provider fixture");

  return {
    sourceRoot,
    agentDir,
    piExecutable,
    version: POSIX_LAUNCHER_EXPECT_PI_VERSION,
    python,
    bash,
    nodeBinDir: dirname(process.execPath),
    pty,
    ptyModulePath,
    preloadFixture,
  };
}

/**
 * One fresh per-leg confined layout. The root is a short `/tmp` child so the
 * production Unix-socket path stays bounded; no production profile, auth,
 * cache, or credential material is copied.
 */
export function createLauncherLegLayout(): PosixLauncherLegLayout {
  // Refuse original role/catalog markers (including case aliases) before the
  // very first mkdir, then build the confined per-leg layout.
  assertAdmissibleOriginalEnvironment();
  const root = createOwnedDirectory(realpathSync("/tmp"), `prg-lx-${randomDigits(10)}`);
  const workspaces = createOwnedDirectory(root, "workspaces");
  const layout: PosixLauncherLegLayout = {
    root,
    home: createOwnedDirectory(root, "home"),
    temporary: createOwnedDirectory(root, "tmp"),
    cache: createOwnedDirectory(root, "cache"),
    stateRoot: createOwnedDirectory(root, "state"),
    fixtureState: createOwnedDirectory(root, "fixture-state"),
    observerDirectory: createOwnedDirectory(root, "observer"),
    nativeAgentDir: createNativeAgentRoot(root),
    workspace: createOwnedDirectory(workspaces, "workspace"),
  };
  for (const ownedDirectory of [layout.root, layout.home, layout.temporary, layout.cache, layout.stateRoot,
    layout.fixtureState, layout.observerDirectory, layout.nativeAgentDir, workspaces, layout.workspace]) {
    assertCreatedDirectoryIdentity(ownedDirectory);
  }
  return layout;
}

function launcherNodeOptions(preloadPath: string, original: string | undefined): string {
  const escaped = preloadPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const prefix = `--require="${escaped}"`;
  return original && original.length > 0 ? `${prefix} ${original}` : prefix;
}

function frameText(surface: TerminalSurface): string {
  return surface.frame().lines.map(stripGeneratedSgr).join("\n");
}

function samePath(left: string, right: string): boolean {
  return left === right;
}

function selectedRosterLabel(frame: string): string | undefined {
  return selectedRosterEntry(frame, 32)?.label;
}

/**
 * The complete, frozen public stop confirmation for one exact native title: the
 * header, the frozen target title, the full warning, and both confirm/cancel
 * hints must all be drawn. A partial repaint never authorizes a stop.
 */
export function hasPosixStopConfirmation(frame: string, title: string): boolean {
  const pane = sidebarPaneLines(frame, 32).slice(1);
  const warning = pane.slice(2, -1).join(" ").replace(/\s+/gu, " ").trim();
  return pane[0]?.trim() === "Stop session?"
    && pane[1]?.trim() === title
    && warning === "Stopping will stop its active turn, questions, background tasks, and shells"
    && pane.at(-1)?.trim() === "enter/y = stop | esc/n = cancel";
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

/** The exact source fixture remains a source fixture: the real launcher builds
 * only in its own retained stage, never in the fixture root. */
export function assertSourceFixtureUnchanged(runtime: PosixLauncherRuntimePin): void {
  assertCompleteSourceFixture(runtime.sourceRoot);
}

export interface LauncherStageEvidence {
  readonly stage: string;
  readonly ptyModulePath: string;
}

/** Assert the real launcher-owned retained build stage after graceful shutdown. */
export function assertLauncherStageEvidence(runtime: PosixLauncherRuntimePin, layout: PosixLauncherLegLayout): LauncherStageEvidence {
  const buildRoot = join(layout.nativeAgentDir, ".pi-review-gate", "build");
  const entries = readdirSync(buildRoot);
  const stages = entries.filter((entry) => entry.startsWith(BUILT_STAGE_DIRNAME));
  assert.equal(stages.length, 1, "exactly one retained launcher-owned source build stage exists for the fresh per-leg agent root");
  const stage = join(buildRoot, stages[0]!);
  const stageStats = lstatSync(stage);
  assert.ok(stageStats.isDirectory() && !stageStats.isSymbolicLink(), "the retained launcher stage is a real directory");
  for (const required of STAGE_REQUIRED) {
    const stats = lstatSync(join(stage, required));
    assert.ok(stats.isFile() && !stats.isSymbolicLink(), `retained launcher stage is missing a real build output: ${required}`);
  }
  const sourceLock = readFileSync(join(runtime.sourceRoot, "package-lock.json"));
  const stageLock = readFileSync(join(stage, "package-lock.json"));
  assert.ok(sourceLock.equals(stageLock), "the retained stage lockfile is byte-identical to the locked source fixture");
  const ptyPackage = JSON.parse(readFileSync(join(stage, "node_modules", "@lydell", "node-pty", "package.json"), "utf8")) as { version?: string };
  assert.equal(ptyPackage.version, POSIX_LAUNCHER_PTY_VERSION, "the retained stage installed the exact pinned public @lydell/node-pty");
  return { stage, ptyModulePath: join(stage, "node_modules", "@lydell", "node-pty") };
}

export function assertLauncherSummary(summary: Record<string, unknown>): void {
  assert.equal(summary.exitCode, 0, "the actual launcher process exited zero through its own return code");
  assert.equal(summary.forceAttempted, false, "no exact owned public PTY kill was attempted");
  assert.equal(summary.gracefulSignalAttempts, 0, "the graceful native exit required no PTY signal attempt at all");
  assert.equal(summary.journalFailed, false, "owned handle observation and metadata writes never failed");
  assert.equal(summary.unresolvedSpawns, 0, "every real owned native spawn obtained its exact public PID");
  assert.equal(summary.unexitedSpawns, 0, "every real owned native spawn delivered its actual public PTY exit");
}

/** The actual launcher process restored its original streams, raw mode, and env. */
export function assertLauncherRestoration(records: readonly PtyJournalRecord[]): void {
  const restoration = records.filter((record) => record.type === "launcher_restoration").at(-1);
  assert.ok(restoration, "the preload recorded the actual launcher restoration witness");
  assert.equal(restoration.sameStdin, true, "the original stdin reference survived the whole launcher flow");
  assert.equal(restoration.sameStdout, true, "the original stdout reference survived the whole launcher flow");
  assert.equal(restoration.rawRestored, true, "the original raw-mode state was restored on the same stdin");
  assert.equal(restoration.nodeOptionsExact, true, "the caller's exact NODE_OPTIONS was preserved");
  assert.equal(restoration.providerExact, true, "the synthetic provider value was preserved unchanged");
  assert.equal(restoration.providerDigestExact, true,
    "the caller's actual provider configuration survived the whole launcher flow unchanged");
}

/** The actual launcher process restored its physical controlling-TTY state. */
export function assertLauncherTtyRestoration(records: readonly PtyJournalRecord[]): void {
  const restoration = records.filter((record) => record.type === "launcher_restoration").at(-1);
  assert.ok(restoration, "the preload recorded the actual launcher restoration witness");
  const before = restoration.ttyBefore;
  const after = restoration.ttyAfter;
  assert.ok(typeof before === "string" && before.length > 0,
    "the actual launcher captured its controlling-terminal state before Main");
  assert.equal(after, before, "the real controlling-TTY termios state is restored exactly on the same PTY");
}

/** The real native child's production restore consumed its sidecar and kept exact env. */
export function assertNativeRestoration(records: readonly PtyJournalRecord[], nativePid: number): void {
  const marker = records.find((record) => record.type === "native_preload" && record.pid === nativePid);
  assert.ok(marker, "each owned native child recorded its bounded restoration witness");
  assert.equal(marker.bootstrapPresent, false, "no bootstrap token leaked into the native child");
  assert.equal(marker.restoreSidecarPresent, false, "the one-shot NODE_OPTIONS restore sidecar was consumed");
  assert.equal(marker.nodeOptionsExact, true, "the native child received the caller's exact NODE_OPTIONS");
  assert.equal(marker.providerExact, true, "the synthetic provider value reached the native child unchanged");
}

export function assertNoUnownedNativeSessions(
  records: readonly NativeJournalRecord[],
  expected: readonly PosixOwnedSession[],
): void {
  const started = records.filter((record) => record.type === "session_start");
  assert.equal(started.length, expected.length, "only the submitted Workspace-only New request started a native child");
  for (const session of expected) {
    assert.equal(started.filter((record) => record.pid === session.record.pid && record.sessionId === session.record.sessionId).length, 1,
      `${session.displayName} identifies exactly one native session_start identity`);
  }
}

export class PosixLauncherPtyDriver {
  readonly pty: NativePtyHandle;
  readonly root: string;
  readonly observerFile: string;
  readonly providerJournal: string;
  readonly ptyJournal: string;
  readonly forceJournal: string;
  readonly surface: TerminalSurface;
  readonly frameSignal = new ChangeSignal();
  readonly journalSignal = new ChangeSignal();
  readonly exitSignal = new ChangeSignal();
  readonly replyLog: string[] = [];
  readonly modeSnapshots: ReturnType<TerminalSurface["inputModes"]>[] = [];
  readonly logWatcher: FSWatcher;
  readonly nativeWatcher: FSWatcher;
  readonly providerWatcher: FSWatcher;
  /** Every positively owned native session and its retained kernel watcher. */
  readonly ownedSessions: PosixOwnedSession[] = [];
  /** Every kernel watcher, registered immediately on creation. */
  readonly kernelWatchers: PosixKernelExitWatcher[] = [];
  /** Bounded, explicit accounting of owned resources still unresolved right now. */
  get unresolvedOwnedResources(): { readonly outerExited: boolean; readonly unobservedWatchers: number } {
    return {
      outerExited: this.exitEvent !== undefined,
      unobservedWatchers: this.kernelWatchers.filter((watcher) => !watcher.observedExit).length,
    };
  }
  readonly runtime: PosixLauncherRuntimePin;
  readonly confiningEnvironment: NodeJS.ProcessEnv;
  deadline: LegDeadline;
  exitEvent?: PtyExit;
  frameRevision = 0;
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
    observerFile: string;
    providerJournal: string;
    ptyJournal: string;
    forceJournal: string;
    deadline: LegDeadline;
    logWatcher: FSWatcher;
    nativeWatcher: FSWatcher;
    providerWatcher: FSWatcher;
    runtime: PosixLauncherRuntimePin;
    confiningEnvironment: NodeJS.ProcessEnv;
  }) {
    this.pty = options.pty;
    this.root = options.root;
    this.observerFile = options.observerFile;
    this.providerJournal = options.providerJournal;
    this.ptyJournal = options.ptyJournal;
    this.forceJournal = options.forceJournal;
    this.deadline = options.deadline;
    this.logWatcher = options.logWatcher;
    this.nativeWatcher = options.nativeWatcher;
    this.providerWatcher = options.providerWatcher;
    this.runtime = options.runtime;
    this.confiningEnvironment = options.confiningEnvironment;
    this.surface = new TerminalSurface(POSIX_LAUNCHER_OUTER_COLS, POSIX_LAUNCHER_OUTER_ROWS, {
      onReply: (reply) => {
        this.replyLog.push(reply);
        // Terminal query replies stop with the leg: no post-cancellation output.
        if (this.deadline.signal.aborted) return;
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
    this.logWatcher.on("change", () => { this.journalSignal.notify(); this.frameSignal.notify(); });
    this.nativeWatcher.on("change", () => { this.journalSignal.notify(); this.frameSignal.notify(); });
    this.providerWatcher.on("change", () => { this.journalSignal.notify(); this.frameSignal.notify(); });
  }

  static start(options: {
    readonly runtime: PosixLauncherRuntimePin;
    readonly layout: PosixLauncherLegLayout;
    readonly nonce: string;
    readonly deadline: LegDeadline;
  }): PosixLauncherPtyDriver {
    const { runtime, layout } = options;
    assertNoRoleOrCatalogMarkers(process.env);
    const observerFile = join(layout.observerDirectory, "native-main.jsonl");
    const providerJournal = join(layout.fixtureState, "provider-journal.jsonl");
    const ptyJournal = join(layout.root, "pty-events.jsonl");
    const forceJournal = join(layout.root, "force-events.jsonl");
    for (const path of [observerFile, providerJournal, ptyJournal, forceJournal]) writeOwnedFile(path, "");

    const nativeArgs = [
      "--offline", "--no-context-files", "--no-themes", "--no-tools",
      "--extension", realpathSync(NATIVE_OBSERVER_FIXTURE),
      "--extension", realpathSync(NATIVE_PROVIDER_FIXTURE),
    ];
    assertNoSavedSessionOverrides(nativeArgs);
    const wrapperArgs = [
      "--pi-executable", runtime.piExecutable,
      "--state-root", layout.stateRoot,
      "--sidebar-key", "f8",
      "--",
      ...nativeArgs,
    ];

    // The wrapper selects the supported Node already on PATH and execs the CJS
    // launcher; the native child's `#!/usr/bin/env node` shebang resolves from
    // the same confined PATH. Python is needed by the real launcher's bounded
    // DDGS provisioning. `/bin/bash` is the trusted wrapper executor.
    const pathEntries = [...new Set([
      runtime.nodeBinDir,
      dirname(runtime.python),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ])];
    // A confined filesystem/process environment for the kernel watcher helper:
    // the canonical pinned interpreter, a bounded PATH, and no caller HOME,
    // cache, or state. NODE_OPTIONS is deliberately omitted so the watcher never
    // runs the launcher preload.
    const confiningEnvironment: NodeJS.ProcessEnv = {
      PATH: pathEntries.join(delimiter),
      HOME: layout.home,
      USERPROFILE: layout.home,
      TMPDIR: layout.temporary,
      TMP: layout.temporary,
      TEMP: layout.temporary,
      XDG_CACHE_HOME: layout.cache,
      XDG_CONFIG_HOME: join(layout.home, ".config"),
      XDG_DATA_HOME: layout.home,
      XDG_STATE_HOME: layout.stateRoot,
      XDG_RUNTIME_DIR: layout.temporary,
    };
    const expectedNodeOptions = launcherNodeOptions(runtime.preloadFixture, process.env.NODE_OPTIONS);
    // Preserve the caller's authorized native/provider environment (including
    // provider configuration and Pi Images) while overriding only filesystem
    // destinations for confinement and the test-owned observation variables.
    // Role/catalog markers are rejected, never laundered by deletion.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: pathEntries.join(delimiter),
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TERM: "xterm-256color",
      HOME: layout.home,
      USERPROFILE: layout.home,
      XDG_CACHE_HOME: layout.cache,
      XDG_CONFIG_HOME: join(layout.home, ".config"),
      XDG_DATA_HOME: layout.home,
      XDG_STATE_HOME: layout.stateRoot,
      XDG_RUNTIME_DIR: layout.temporary,
      TMPDIR: layout.temporary,
      TMP: layout.temporary,
      TEMP: layout.temporary,
      PI_CODING_AGENT_DIR: layout.nativeAgentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_PROVIDER_TEST_KEY: POSIX_LAUNCHER_PROVIDER_VALUE,
      NODE_OPTIONS: expectedNodeOptions,
      [EXPECT_NODE_OPTIONS_ENV]: expectedNodeOptions,
      [EXPECT_PROVIDER_ENV]: POSIX_LAUNCHER_PROVIDER_VALUE,
      PRG_SESSION_HOST_LAUNCHER_SOURCE_ROOT: runtime.sourceRoot,
      PRG_SESSION_HOST_LAUNCHER_NONCE: options.nonce,
      PRG_SESSION_HOST_LAUNCHER_PTY_JOURNAL: ptyJournal,
      PRG_SESSION_HOST_LAUNCHER_BASELINE: POSIX_LAUNCHER_BASELINE,
      PRG_SESSION_HOST_LAUNCHER_NATIVE_AGENT: runtime.agentDir,
      PRG_SESSION_HOST_NATIVE_MAIN_OBSERVER_FILE: observerFile,
      PRG_FIXTURE_AGENT_DIR: runtime.agentDir,
      PRG_FIXTURE_STATE_DIR: layout.fixtureState,
      PRG_FIXTURE_NO_AUTO_MODEL: "1",
    };
    env[PROVIDER_DIGEST_ENV] = providerEnvironmentDigest(env);
    assertAdmissibleOriginalEnvironment(env);
    // The lane must introduce no credential-like variable names beyond the
    // preserved caller environment; the native-side observer independently
    // reports what actually reached the child.
    const introducedCredentialNames = Object.keys(env).filter((name) =>
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name) && !Object.hasOwn(process.env, name));
    assert.deepEqual(introducedCredentialNames, [],
      "the launcher lane introduces no credential-like variable names of its own");

    const shEntry = join(runtime.sourceRoot, "scripts", "pi-review-sessions.sh");
    assert.ok(existsSync(shEntry), `source launcher POSIX entry exists: ${shEntry}`);

    const logWatcher = watch(layout.root);
    const nativeWatcher = watch(layout.observerDirectory);
    const providerWatcher = watch(layout.fixtureState);
    let pty: NativePtyHandle;
    try {
      pty = runtime.pty.spawn(runtime.bash, [shEntry, ...wrapperArgs], {
        name: "xterm-256color",
        cols: POSIX_LAUNCHER_OUTER_COLS,
        rows: POSIX_LAUNCHER_OUTER_ROWS,
        cwd: process.cwd(),
        env,
        encoding: "utf8",
      });
    } catch (error) {
      logWatcher.close();
      nativeWatcher.close();
      providerWatcher.close();
      throw new Error(`public POSIX source launcher PTY spawn failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    // Wire the exact returned handle immediately, including failure teardown.
    try {
      return new PosixLauncherPtyDriver({
        pty, root: layout.root, observerFile, providerJournal, ptyJournal, forceJournal,
        deadline: options.deadline, logWatcher, nativeWatcher, providerWatcher,
        runtime, confiningEnvironment,
      });
    } catch (error) {
      writeMetadata(forceJournal, { type: "outer_pty_force_attempt", pid: Number(pty.pid) });
      try { pty.kill("SIGTERM"); } catch { /* exact newly owned public outer PTY */ }
      logWatcher.close();
      nativeWatcher.close();
      providerWatcher.close();
      throw error;
    }
  }

  records(): NativeJournalRecord[] {
    return boundedJsonl<NativeJournalRecord>(this.observerFile);
  }

  ptyRecords(): PtyJournalRecord[] {
    return boundedJsonl<PtyJournalRecord>(this.ptyJournal);
  }

  providerRecords(): Record<string, unknown>[] {
    return boundedJsonl<Record<string, unknown>>(this.providerJournal);
  }

  private onData(data: string): void {
    this.outputTail = (this.outputTail + data).slice(-512 * 1024);
    this.sawAlternateEnter ||= this.outputTail.includes("\x1b[?1049h");
    this.sawAlternateLeave ||= this.outputTail.includes("\x1b[?1049l");
    try {
      this.surface.write(data);
      const snapshot = this.surface.inputModes();
      if (this.modeSnapshots.length < 2_000) this.modeSnapshots.push(snapshot);
      this.refreshFrame();
    } catch {
      this.parserError = new Error("actual launcher PTY output could not be parsed by the public terminal surface");
    }
  }

  private refreshFrame(): void {
    try {
      this.currentFrame = frameText(this.surface);
      this.frameRevision += 1;
      this.frameSignal.notify();
    } catch {
      this.parserError = new Error("actual launcher PTY frame could not be read");
    }
  }

  currentText(): string {
    if (this.parserError) throw this.parserError;
    return this.currentFrame;
  }

  /** Gate one input write on the enforced leg deadline; never writes after cancellation. */
  private write(data: string, stage: string): void {
    this.deadline.assertOpen(stage);
    this.pty.write(data);
  }

  async waitFrame(
    predicate: (frame: string) => boolean,
    stage: string,
    after = -1,
    timeoutMs = POSIX_LAUNCHER_EVENT_TIMEOUT_MS,
    signal: AbortSignal = this.deadline.signal,
  ): Promise<void> {
    await this.frameSignal.waitFor(() => {
      if (this.exitEvent && !(this.frameRevision > after && predicate(this.currentText()))) {
        throw new Error("launcher outer PTY exited before the expected frame");
      }
      return this.frameRevision > after && predicate(this.currentText());
    }, timeoutMs, stage, signal).catch((error: unknown) => {
      if (error instanceof Error && /leg deadline|cancelled before completion/.test(error.message)) throw error;
      throw frameWaitFailure(stage, {
        frameRevision: this.frameRevision,
        after,
        exitObserved: this.exitEvent !== undefined,
        aborted: signal.aborted,
      });
    });
  }

  async waitForNative(predicate: (records: NativeJournalRecord[]) => boolean, stage: string, timeoutMs = POSIX_LAUNCHER_EVENT_TIMEOUT_MS): Promise<NativeJournalRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.records()), timeoutMs, stage, this.deadline.signal);
    return this.records();
  }

  async waitForPty(predicate: (records: PtyJournalRecord[]) => boolean, stage: string, timeoutMs = POSIX_LAUNCHER_EVENT_TIMEOUT_MS): Promise<PtyJournalRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.ptyRecords()), timeoutMs, stage, this.deadline.signal);
    return this.ptyRecords();
  }

  async waitForProvider(predicate: (records: Record<string, unknown>[]) => boolean, stage: string, timeoutMs = POSIX_LAUNCHER_EVENT_TIMEOUT_MS): Promise<Record<string, unknown>[]> {
    await this.journalSignal.waitFor(() => predicate(this.providerRecords()), timeoutMs, stage, this.deadline.signal);
    return this.providerRecords();
  }

  async waitForExit(timeoutMs = POSIX_LAUNCHER_EVENT_TIMEOUT_MS, signal: AbortSignal = this.deadline.signal): Promise<PtyExit> {
    if (!this.exitEvent) await this.exitSignal.waitFor(() => this.exitEvent !== undefined, timeoutMs, "launcher outer public PTY exit", signal);
    return this.exitEvent!;
  }

  private async send(data: string, stage: string, predicate?: (frame: string) => boolean): Promise<void> {
    const before = this.frameRevision;
    this.write(data, stage);
    await this.waitFrame(predicate ?? (() => true), stage, before);
  }

  private async toggleSidebar(): Promise<void> {
    const wasVisible = this.sidebarVisible;
    const wasMainFocus = this.focus === "main";
    const before = this.frameRevision;
    this.write(KEYS.f8, "sidebar toggle");
    if (!wasVisible) {
      this.sidebarVisible = true;
      this.focus = "sidebar";
    } else if (wasMainFocus) {
      this.focus = "sidebar";
    } else {
      this.sidebarVisible = false;
      this.focus = "main";
    }
    const expectHidden = wasVisible && !wasMainFocus;
    await this.waitFrame((frame) => expectHidden
      ? sidebarRosterHidden(frame, 32)
      : isSidebarFocusedFrame(frame, 32),
    "public F8 sidebar toggle", before);
  }

  async ensureSidebarFocus(): Promise<void> {
    if (this.focus === "sidebar" && this.sidebarVisible) return;
    if (this.focus === "form") {
      this.write(KEYS.escape, "cancel incomplete sidebar form");
      await this.waitFrame((frame) => !frame.includes("Workspace:") && !frame.includes("Edit native session name"),
        "public Escape cancels an incomplete sidebar form");
      this.focus = "main";
    }
    if (!this.sidebarVisible || this.focus !== "sidebar") await this.toggleSidebar();
    assert.equal(this.focus, "sidebar");
    assert.equal(this.sidebarVisible, true, "establishing sidebar focus leaves the pane visible");
    assert.ok(isSidebarFocusedFrame(this.currentText(), 32), "the complete sidebar-only footer proves public sidebar focus");
  }

  async moveRosterTo(label: string): Promise<void> {
    await this.ensureSidebarFocus();
    for (let presses = 0; presses < 8; presses += 1) {
      if (selectedRosterLabel(this.currentText()) === label) return;
      const beforeLabel = selectedRosterLabel(this.currentText());
      assert.ok(beforeLabel, "actual public Main sidebar exposes a selected row");
      const before = this.frameRevision;
      this.write(KEYS.down, "sidebar selection advance");
      await this.waitFrame((frame) => selectedRosterLabel(frame) !== beforeLabel,
        "sidebar selection advances", before);
    }
    assert.equal(selectedRosterLabel(this.currentText()), label, "actual launcher Main sidebar selected the requested row");
  }

  async createNativeSession(workspace: string): Promise<PosixOwnedSession> {
    const canonicalWorkspace = realpathSync(workspace);
    await this.ensureSidebarFocus();
    await this.moveRosterTo("New session");
    await this.send(KEYS.enter, "Workspace-only New form opens", (frame) => frame.includes("New session") && frame.includes("Workspace:")
      && !frame.includes("Label:") && !frame.includes("Profile:") && frame.includes("tab complete"));
    this.focus = "form";
    if (!workspaceFieldEmpty(this.currentText())) {
      const beforeClear = this.frameRevision;
      this.write(KEYS.ctrlC, "clear workspace field");
      await this.waitFrame(workspaceFieldEmpty, "public Workspace clear binding empties the New Editor content row", beforeClear);
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
    const acceptedPath = `${canonicalWorkspace}/`;
    const beforeFirstEnter = this.frameRevision;
    this.write(KEYS.enter, "accept workspace completion or submit");
    await this.waitFrame((frame) => !frame.includes("> Workspace:") || frame.includes("Starting (request")
      || (() => { try { return borderedEditorContentMatches(frame, "> Workspace:", acceptedPath); } catch { return false; } })(),
    "first native Enter accepts the exact owned folder completion or actually submits New", beforeFirstEnter);
    const afterFirstEnter = this.currentText();
    if (afterFirstEnter.includes("> Workspace:") && !afterFirstEnter.includes("Starting (request")) {
      assert.ok(borderedEditorContentMatches(afterFirstEnter, "> Workspace:", acceptedPath),
        "first native Enter accepted exactly the owned directory completion, not another path or an error");
      this.write(KEYS.enter, "submit the accepted exact workspace");
      await this.waitFrame((frame) => frame.includes("Starting (request ") || !frame.includes("Workspace:"),
        "a separate native Enter submits the accepted Workspace path");
    }

    // Retain the kernel incarnation from the original public PTY spawn receipt,
    // before accepting native binding/readiness evidence from session_start.
    const spawnRecords = await this.waitForPty((entries) => entries.some((record) => record.type === "pty_spawn"
      && samePath(record.cwd ?? "", canonicalWorkspace) && Number.isSafeInteger(record.pid) && record.pid! > 1),
    "the original public native PTY exposes its positive PID for kernel ownership");
    const spawns = spawnRecords.filter((record) => record.type === "pty_spawn"
      && samePath(record.cwd ?? "", canonicalWorkspace));
    assert.equal(spawns.length, 1, "one deliberate New creates exactly one original native PTY spawn");
    const spawn = spawns[0]!;
    assert.ok(Number.isSafeInteger(spawn.pid) && spawn.pid! > 1);
    const exitWatcher = new PosixKernelExitWatcher(spawn.pid!, {
      python: this.runtime.python,
      env: this.confiningEnvironment,
      cwd: process.cwd(),
    });
    this.kernelWatchers.push(exitWatcher);
    await exitWatcher.waitUntilRegistered(POSIX_LAUNCHER_EVENT_TIMEOUT_MS);

    const records = await this.waitForNative((entries) => entries.some((record) => record.type === "session_start"
      && samePath(record.cwd ?? "", canonicalWorkspace)
      && typeof record.sessionId === "string" && record.sessionId.length > 0
      && typeof record.displayName === "string"),
    "real public session_start with observed metadata and selected workspace");
    const record = records.filter((entry) => entry.type === "session_start" && samePath(entry.cwd ?? "", canonicalWorkspace)
      && typeof entry.sessionId === "string" && typeof entry.displayName === "string").at(-1);
    assert.ok(record, "native observer recorded the new native session");
    assert.equal(record.pid, spawn.pid, "native session_start matches the original public PTY PID and retained kernel watcher");
    assert.ok(record.sessionId && record.sessionId.length > 0, "native SessionManager reported its conversation id");
    assert.ok(record.sessionFile && isAbsolute(record.sessionFile), "native SessionManager reported its session file");
    const rawDisplayName: unknown = record.displayName;
    if (typeof rawDisplayName !== "string" || rawDisplayName.length === 0) {
      throw new Error("native observer recorded no canonical display caption");
    }
    const displayName: string = rawDisplayName;
    // A successful New submission activates the created child as the Main
    // input owner without a second host-row Enter; the sidebar stays visible.
    await this.waitFrame((frame) => selectedRosterLabel(frame) === displayName
      && frameHeaderMatches(frame, displayName) && isCompleteMainFocusedRoster(frame),
    "the new native row is the active Main input owner with a complete Main-focused frame");
    this.focus = "main";
    const session: PosixOwnedSession = { displayName, workspace: canonicalWorkspace, record, exitWatcher };
    this.ownedSessions.push(session);
    return session;
  }

  async activate(label: string): Promise<void> {
    await this.ensureSidebarFocus();
    await this.moveRosterTo(label);
    const before = this.frameRevision;
    this.write(KEYS.enter, "activate native row");
    this.focus = "main";
    await this.waitFrame((frame) => frameHeader(frame) === label,
      "public Enter explicitly activates the selected native row", before);
  }

  async writeDraft(value: string): Promise<void> {
    const before = this.frameRevision;
    this.write(value, "type native draft");
    await this.waitFrame((frame) => frame.includes(value), "native session displays its own draft", before);
  }

  /**
   * Close one positively active native child through the public sidebar
   * stop/remove route. When complete idleness is positively observed, the
   * production action authorizes the stop directly; otherwise it must present
   * the complete frozen confirmation, which is confirmed only once fully
   * drawn. Either way the exact native lifecycle, original PTY exit, and kernel
   * exit are asserted; force or uncertainty never counts as success.
   */
  async closeNativeNormally(session: PosixOwnedSession): Promise<void> {
    assert.equal(this.focus, "main", "native input is focused before its native exit");
    assert.equal(frameHeader(this.currentText()), session.displayName,
      "the explicit native exit begins with the exact observed title as active owner");
    const shutdownBefore = this.shutdownCount(session);
    await this.ensureSidebarFocus();
    await this.moveRosterTo(session.displayName);
    const selected = selectedRosterEntry(this.currentText(), 32);
    if (selected === undefined || selected.kind !== "native" || selected.title !== session.displayName) {
      throw new Error("the exact selected native row is required before requesting a stop");
    }
    assert.ok(isSidebarFocusedFrame(this.currentText(), 32),
      "the complete sidebar-only footer proves the stop action belongs to the visible sidebar");
    const beforeStop = this.frameRevision;
    this.write("d", "request stop of the exact selected native child");
    await this.waitFrame((frame) => this.shutdownCount(session) > shutdownBefore
      || hasPosixStopConfirmation(frame, session.displayName),
    "the public stop either directly authorizes a positively idle child or opens the complete frozen confirmation",
    beforeStop);
    if (this.shutdownCount(session) <= shutdownBefore) {
      assert.ok(hasPosixStopConfirmation(this.currentText(), session.displayName),
        "the complete frozen confirmation is fully displayed before it is confirmed");
      this.write("y", "confirm the fully displayed frozen native stop target");
    }
    await this.assertShutdownReason(session, shutdownBefore);
    await this.assertNativeExitEvidence(session, true);
  }

  private shutdownCount(session: PosixOwnedSession): number {
    return this.records().filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).length;
  }

  private nativeCardExited(frame: string): boolean {
    const parsed = parseRosterFrame(frame, 32);
    return parsed.complete && parsed.cards.some((card) => card.status === "exited (code 0)");
  }

  private async assertShutdownReason(session: PosixOwnedSession, before: number): Promise<void> {
    const records = await this.waitForNative((entries) => entries.filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).length > before,
    "real native session_shutdown lifecycle event after the explicit native exit");
    const shutdown = records.filter((record) => record.type === "session_shutdown"
      && record.pid === session.record.pid).at(-1);
    assert.equal(shutdown?.reason, "quit",
      "the public native lifecycle reports its actual quit reason after the real native exit");
    assert.equal(shutdown?.sessionId, session.record.sessionId,
      "the fresh shutdown witness belongs to the exact observed conversation");
    assert.equal(shutdown?.contextSessionId, session.record.sessionId,
      "the public native shutdown context independently confirms the same conversation id");
  }

  private async assertNativeExitEvidence(session: PosixOwnedSession, rowRemoved = false): Promise<void> {
    await this.waitFrame((frame) => rowRemoved
      ? parseRosterFrame(frame, 32).complete && parseRosterFrame(frame, 32).count === 0
        && isSidebarFocusedFrame(frame, 32)
      : this.nativeCardExited(frame),
    rowRemoved
      ? "Main renders the complete empty roster after the exact native child is stopped and removed"
      : "Main observes one exited card for the exact owned native process");
    await session.exitWatcher.waitForExit(POSIX_LAUNCHER_EVENT_TIMEOUT_MS);
    assert.equal(session.exitWatcher.observedExit, true,
      "the owned PID received the original public kernel EVFILT_PROC/NOTE_EXIT or pidfd/poll event");
    await this.assertGracefulPtyExit(session);
  }

  private async assertGracefulPtyExit(session: PosixOwnedSession): Promise<void> {
    const entries = await this.waitForPty((records) => records.some((record) => record.type === "pty_exit"
      && record.pid === session.record.pid),
    "the actual manager-owned native public IPty handle reports onExit");
    const exit = entries.find((record) => record.type === "pty_exit" && record.pid === session.record.pid);
    assert.ok(exit, "the exact native PTY exit record exists");
    assert.equal(exit!.exitCode, 0, "the manager-owned native PTY exited with code zero");
    assert.ok(!exit!.signal, "the manager-owned native PTY exit was not signal termination or escalation");
  }

  async assertBeforeQuitModes(): Promise<void> {
    await this.surface.flush();
    assert.ok(this.sawAlternateEnter, "actual launcher Main output entered the outer VT alternate buffer");
    assert.ok(this.modeSnapshots.some((mode) => mode.bracketedPaste), "actual outer VT observed Main bracketed-paste negotiation");
    assert.ok(this.modeSnapshots.some((mode) => mode.mouseTracking !== "none" && mode.mouseEncoding === "sgr"),
      "actual outer VT observed Main mouse tracking and SGR encoding");
    assert.ok(this.modeSnapshots.some((mode) => mode.kittyFlags > 0 || mode.applicationCursorKeys || mode.applicationKeypad || mode.modifyOtherKeys > 0),
      "actual outer VT observed a non-baseline keyboard mode during Main ownership");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?[\d;]*c$/.test(reply)),
      "actual outer PTY answered the real public device-attributes query");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?\d+u$/.test(reply)),
      "actual outer PTY answered the real public Kitty keyboard-state query");
  }

  async waitForNormalExit(): Promise<PtyExit> {
    const exit = await this.waitForExit();
    await this.surface.flush();
    assert.equal(exit.exitCode, 0, "real source launcher outer PTY exited zero");
    assert.ok(!exit.signal, "outer launcher exited normally without signal termination");
    assert.ok(this.sawAlternateLeave, "actual launcher Main output left the outer VT alternate buffer");
    assert.ok(this.outputTail.lastIndexOf("\x1b[?1049l") > this.outputTail.lastIndexOf("\x1b[?1049h"),
      "last observed outer VT alternate-buffer transition restored the normal buffer");
    assert.ok(frameText(this.surface).includes(POSIX_LAUNCHER_BASELINE),
      "actual outer VT normal buffer contains its pre-launcher restoration baseline");
    assert.deepEqual(this.surface.inputModes(), this.initialModes,
      "actual outer VT mouse, bracketed-paste, and keyboard negotiation returned to its exact baseline");
    return exit;
  }

  async waitForLauncherSummary(): Promise<Record<string, unknown>> {
    const records = await this.waitForPty((entries) => entries.some((entry) => entry.type === "launcher_summary"),
      "actual launcher process exit summary");
    const summary = records.filter((entry) => entry.type === "launcher_summary").at(-1);
    assert.ok(summary, "the preload recorded the actual launcher process summary");
    return summary as Record<string, unknown>;
  }

  /** Quit the host through the real sidebar `q` action once every owned child
   * has already exited; no live-child confirmation pane is involved. */
  async finishHostNormally(): Promise<PtyExit> {
    await this.ensureSidebarFocus();
    assert.equal(this.focus, "sidebar", "the explicit host quit action belongs to the visible sidebar, not a native editor");
    await this.waitFrame((frame) => isSidebarFocusedFrame(frame, 32),
      "the complete sidebar-only footer exposes the host-only quit action");
    this.write("q", "quit host");
    this.focus = "main";
    return this.waitForNormalExit();
  }

  /**
   * Bounded failure cleanup only: a short-lived cleanup deadline replaces the
   * possibly exhausted leg deadline for one best-effort graceful attempt, then
   * the caller forces the exact owned outer handle. No input after the budget.
   */
  async tryGracefulQuitAfterFailure(budgetMs = POSIX_LAUNCHER_CLEANUP_BUDGET_MS): Promise<void> {
    if (this.exitEvent) return;
    if (this.deadline.signal.aborted) return;
    const previous = this.deadline;
    const cleanup = new LegDeadline(budgetMs);
    this.deadline = cleanup;
    try {
      if (this.currentText().trim().length === 0) return;
      await this.ensureSidebarFocus();
      await this.moveRosterTo("Quit host");
      const before = this.frameRevision;
      this.write(KEYS.enter, "cleanup request quit confirmation");
      await this.waitFrame((frame) => frame.includes("Quit host?") || this.exitEvent !== undefined,
        "failed-test cleanup reaches the public quit confirmation", before, 5_000);
      if (!this.exitEvent && this.currentText().includes("Quit host?")) this.write(KEYS.enter, "cleanup confirm quit host");
      await this.waitForExit(5_000);
    } catch {
      // A failed case remains failed; the caller uses exact-handle cleanup.
    } finally {
      this.deadline = previous;
      cleanup.dispose();
    }
  }

  /**
   * Bounded exact-handle force of the outer PTY. The actual outer exit is
   * awaited so a forced signal attempt is never reported as settlement.
   */
  async forceKillOuterAfterFailure(): Promise<void> {
    if (this.exitEvent || this.forced) return;
    this.forced = true;
    writeMetadata(this.forceJournal, { type: "outer_pty_force_attempt", pid: Number(this.pty.pid) });
    try { this.pty.kill("SIGTERM"); } catch { /* exact public outer PTY handle */ }
    try {
      await this.exitSignal.waitFor(() => this.exitEvent !== undefined, 5_000,
        "outer PTY exit after bounded SIGTERM");
      return;
    } catch {
      // Fall through to one bounded escalation on the same exact handle.
    }
    try { this.pty.kill("SIGKILL"); } catch { /* bounded escalation to the same outer PTY handle */ }
    await this.exitSignal.waitFor(() => this.exitEvent !== undefined, 5_000,
      "outer PTY exit after bounded SIGKILL").catch(() => undefined);
  }

  async settleSubscriptions(): Promise<void> {
    // Retain the original outer exit subscription and kernel watchers until the
    // exact exits are observed. A bounded force attempt is journaled through the
    // existing force path but is never treated as settlement, and unresolved
    // resources stay retained and accounted for.
    if (!this.exitEvent) await this.forceKillOuterAfterFailure();
    await Promise.all(this.kernelWatchers.filter((watcher) => !watcher.observedExit)
      .map((watcher) => watcher.waitForExit(5_000).catch(() => undefined)));
    await Promise.all(this.kernelWatchers.filter((watcher) => watcher.observedExit)
      .map((watcher) => watcher.stop().catch(() => undefined)));
    if (this.exitEvent) {
      try { this.dataSubscription.dispose(); } catch { /* settled outer PTY data subscription */ }
      try { this.exitSubscription.dispose(); } catch { /* settled outer PTY exit subscription */ }
      try { this.surface.dispose(); } catch { /* settled terminal model */ }
    }
    if (this.exitEvent && this.unresolvedOwnedResources.unobservedWatchers === 0) {
      this.logWatcher.close();
      this.nativeWatcher.close();
      this.providerWatcher.close();
    } else {
      // Preserve observations without letting filesystem watches hold the runner open.
      this.logWatcher.unref();
      this.nativeWatcher.unref();
      this.providerWatcher.unref();
    }
  }

  get forcedCleanup(): boolean {
    return this.forced;
  }

  get terminalOutputTail(): string {
    return this.outputTail;
  }
}

export function assertPosixLegArithmetic(): void {
  assert.ok(POSIX_LAUNCHER_LEG_DEADLINE_MS < POSIX_LAUNCHER_TEST_TIMEOUT_MS, "the leg deadline is bounded below the whole-file budget");
  assert.ok(POSIX_LAUNCHER_STARTUP_TIMEOUT_MS < POSIX_LAUNCHER_LEG_DEADLINE_MS, "the real staged build/startup wait is bounded below the leg deadline");
  assert.ok(POSIX_LAUNCHER_CLEANUP_BUDGET_MS > 0 && POSIX_LAUNCHER_BODY_DEADLINE_MS > POSIX_LAUNCHER_STARTUP_TIMEOUT_MS,
    "the cancelled body aborts early enough for bounded cleanup inside the leg deadline");
  assert.ok(POSIX_LAUNCHER_EVENT_TIMEOUT_MS < POSIX_LAUNCHER_OBSERVER_TIMEOUT_SECONDS * 1000,
    "event waits are bounded below the exact-process observer timeout");
  assert.equal(POSIX_LAUNCHER_OUTER_COLS, 120);
  assert.equal(POSIX_LAUNCHER_OUTER_ROWS, 50);
  assert.equal(POSIX_LAUNCHER_EXPECT_PI_VERSION, "1.1.0");
}
